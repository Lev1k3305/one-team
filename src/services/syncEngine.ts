/**
 * Sync Engine for ONE TEAM
 *
 * Implements end-to-end Cloud Data Synchronization:
 * - Durable Outbox outgoing sync with idempotency, baseVersion concurrency check, and backoff jitter.
 * - Incoming delta sync using server cursor_seq and sync_tombstones.
 * - Deterministic field-level conflict detection and non-destructive conflict store (sync_conflicts).
 * - Automatic recovery on reconnect and workspace/user isolation.
 */

import { supabase, isSupabaseConfigured, getIsSupabaseConfigured } from './supabaseClient';
import {
  IsolatedStorageEngine,
  isolatedStorageEngine,
  V2_STORES,
  V2StoreName,
  OutboxMutationRecord,
  ScopedRecord,
  SCOPES,
} from './indexedDbV2';
import { storageServiceAdapter } from './storageAdapter';
import {
  StorageContext,
  SessionGenerationManager,
  sessionGenerationManager,
} from './storageContext';

export type SyncStatusState =
  | 'synced'
  | 'syncing'
  | 'offline'
  | 'pending'
  | 'error'
  | 'conflict'
  | 'permission_required'
  | 'reconciliation_required';

export interface SyncStatusMetrics {
  state: SyncStatusState;
  pendingCount: number;
  conflictCount: number;
  lastSyncedAt: Date | null;
  lastError: string | null;
  isOnline: boolean;
  workspaceId: string | null;
}

export interface SyncConflictRecord {
  id: string; // clientMutationId
  workspaceId: string;
  entityType: string;
  entityId: string;
  localPayload: Record<string, any>;
  serverPayload: Record<string, any>;
  baseVersion: number;
  serverVersion: number;
  conflictingFields: string[];
  resolved: boolean;
  createdAt: string;
}

export interface SyncCheckpoint {
  workspaceId: string;
  cursorSeq: number;
  lastSyncVersion: number;
  lastSyncTimestamp: string;
}

export type SyncStatusListener = (metrics: SyncStatusMetrics) => void;

export class SyncEngine {
  private engine: IsolatedStorageEngine;
  private manager: SessionGenerationManager;

  private isRunning: boolean = false;
  private isProcessingOutbox: boolean = false;
  private isPullingDelta: boolean = false;
  private isOnline: boolean = typeof navigator !== 'undefined' && 'onLine' in navigator ? Boolean(navigator.onLine) : true;

  private pendingCount: number = 0;
  private conflictCount: number = 0;
  private lastSyncedAt: Date | null = null;
  private lastError: string | null = null;
  private currentState: SyncStatusState = 'synced';

  private listeners: Set<SyncStatusListener> = new Set();
  private onlineListener?: () => void;
  private offlineListener?: () => void;
  private pollTimer?: any;

  constructor(
    engine: IsolatedStorageEngine = isolatedStorageEngine,
    manager: SessionGenerationManager = sessionGenerationManager
  ) {
    this.engine = engine;
    this.manager = manager;
    this.initNetworkListeners();
  }

  private initNetworkListeners(): void {
    if (typeof window === 'undefined') return;

    this.onlineListener = () => {
      this.isOnline = true;
      this.notifyStatus();
      this.syncNow();
    };

    this.offlineListener = () => {
      this.isOnline = false;
      this.updateState('offline');
    };

    window.addEventListener('online', this.onlineListener);
    window.addEventListener('offline', this.offlineListener);
  }

  public subscribe(listener: SyncStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getMetrics());
    return () => this.listeners.delete(listener);
  }

  public getMetrics(): SyncStatusMetrics {
    const ctx = this.manager.getContext();
    return {
      state: !this.isOnline ? 'offline' : this.currentState,
      pendingCount: this.pendingCount,
      conflictCount: this.conflictCount,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      isOnline: this.isOnline,
      workspaceId: ctx.workspaceId,
    };
  }

  private notifyStatus(): void {
    const metrics = this.getMetrics();
    for (const listener of this.listeners) {
      try {
        listener(metrics);
      } catch (e) {
        console.error('[SyncEngine] Error in sync listener:', e);
      }
    }
  }

  public updateState(state: SyncStatusState, err?: string): void {
    this.currentState = state;
    if (err !== undefined) this.lastError = err;
    this.notifyStatus();
  }

  /**
   * Starts periodic polling and monitoring for the active session.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Refresh pending counts
    this.refreshMetrics();

    // Periodic sync attempt every 30 seconds
    this.pollTimer = setInterval(() => {
      if (this.isOnline && !this.isProcessingOutbox && !this.isPullingDelta) {
        this.syncNow();
      }
    }, 30000);

    // Initial trigger
    this.syncNow();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  public async refreshMetrics(): Promise<void> {
    const ctx = this.manager.getContext();
    if (ctx.isGuest || !ctx.workspaceId) {
      this.pendingCount = 0;
      this.conflictCount = 0;
      this.updateState('synced');
      return;
    }

    try {
      const outboxItems = await this.engine.getAll<OutboxMutationRecord>(V2_STORES.OUTBOX, ctx);
      const pending = outboxItems.filter((i) => i.status === 'PENDING' || i.status === 'FAILED');
      this.pendingCount = pending.length;

      const conflicts = await this.engine.getAll<SyncConflictRecord>(V2_STORES.SYNC_CONFLICTS, ctx);
      this.conflictCount = conflicts.filter((c) => !c.resolved).length;

      if (this.conflictCount > 0) {
        this.updateState('conflict');
      } else if (this.pendingCount > 0) {
        this.updateState('pending');
      } else {
        this.updateState('synced');
      }
    } catch {
      // Storage might still be hydrating
    }
  }

  /**
   * Main sync coordinator: triggers outgoing outbox push followed by incoming delta pull.
   */
  public async syncNow(): Promise<void> {
    const ctx = this.manager.getContext();
    if (ctx.isGuest || !ctx.workspaceId) return;

    if (!this.isOnline) {
      this.updateState('offline');
      return;
    }

    this.updateState('syncing');

    try {
      // 1. Process Outbox
      await this.processOutbox();

      // 2. Fetch Incoming Delta
      await this.pullDelta();

      await this.refreshMetrics();
      this.lastSyncedAt = new Date();
      if (this.conflictCount > 0) {
        this.updateState('conflict');
      } else if (this.pendingCount > 0) {
        this.updateState('pending');
      } else {
        this.updateState('synced');
      }
    } catch (err: any) {
      console.warn('[SyncEngine] Sync failed:', err);
      this.updateState('error', err?.message || String(err));
    }
  }

  /**
   * Outgoing Synchronization:
   * Processes all pending mutations in order of creation.
   */
  public async processOutbox(): Promise<void> {
    if (this.isProcessingOutbox) return;
    this.isProcessingOutbox = true;

    try {
      const ctx = this.manager.getContext();
      if (ctx.isGuest || !ctx.workspaceId) return;

      const outboxItems = await this.engine.getAll<OutboxMutationRecord>(V2_STORES.OUTBOX, ctx);
      const pendingItems = outboxItems
        .filter((item) => item.status === 'PENDING' || (item.status === 'FAILED' && (!item.nextRetryAt || item.nextRetryAt <= Date.now())))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      for (const item of pendingItems) {
        // Double check context hasn't changed during loop
        const activeCtx = this.manager.getContext();
        if (activeCtx.sessionGeneration !== ctx.sessionGeneration || activeCtx.workspaceId !== ctx.workspaceId) {
          break;
        }

        await this.dispatchMutation(item, activeCtx);
      }
    } finally {
      this.isProcessingOutbox = false;
    }
  }

  /**
   * Submits a single mutation to Supabase via apply_sync_mutation RPC.
   */
  public async dispatchMutation(item: OutboxMutationRecord, context: StorageContext): Promise<void> {
    // Mark as in-flight
    item.status = 'IN_FLIGHT';
    item.updatedAt = new Date().toISOString();
    await this.engine.put(V2_STORES.OUTBOX, item, context).catch(() => {});

    const targetEntityType = this.mapStoreToEntityType(item.entityType);
    const normalizedPayload = this.normalizePayloadForServer(item.entityType, item.payload);

    try {
      const { data, error } = await supabase.rpc('apply_sync_mutation', {
        p_client_mutation_id: item.id,
        p_workspace_id: item.workspaceId,
        p_entity_type: targetEntityType,
        p_entity_id: item.entityId,
        p_action: item.action,
        p_base_version: item.baseVersion,
        p_payload: normalizedPayload,
      });

      if (error) {
        throw error;
      }

      if (data && data.success) {
        // Mutation applied successfully on server! Remove from outbox.
        await this.engine.delete(V2_STORES.OUTBOX, item.id, context);

        // Update local entity version if returned
        if (data.record && data.version && item.action !== 'DELETE') {
          await this.updateLocalEntityVersion(
            item.entityType as V2StoreName,
            item.entityId,
            data.version,
            context
          );
        }
      } else if (data && data.status === 'ALREADY_APPLIED') {
        // Idempotent duplicate: safe to delete
        await this.engine.delete(V2_STORES.OUTBOX, item.id, context);
      } else if (data && data.status === 'VERSION_CONFLICT') {
        // Concurrency conflict! Move to conflict store
        await this.handleConcurrencyConflict(item, data, context);
      } else if (data && data.error === 'PERMISSION_DENIED_VIEWER') {
        item.status = 'BLOCKED';
        item.lastError = 'Viewer permissions deny writing';
        await this.engine.put(V2_STORES.OUTBOX, item, context);
        this.updateState('permission_required', item.lastError);
      } else if (data && data.error === 'NOT_A_MEMBER') {
        item.status = 'BLOCKED';
        item.lastError = 'Membership revoked';
        await this.engine.put(V2_STORES.OUTBOX, item, context);
        this.updateState('permission_required', item.lastError);
      } else {
        // Unhandled business rejection
        item.status = 'BLOCKED';
        item.lastError = data?.error || 'Rejected by server';
        await this.engine.put(V2_STORES.OUTBOX, item, context);
      }
    } catch (err: any) {
      // Network or RPC failure: apply exponential backoff
      item.retryCount += 1;
      item.status = item.retryCount >= 10 ? 'DEAD_LETTER' : 'FAILED';
      item.lastError = err?.message || String(err);

      // Backoff: base 1s, 2s, 4s... max 60s + random jitter (0-500ms)
      const baseDelay = Math.min(60000, 1000 * Math.pow(2, Math.min(item.retryCount, 6)));
      const jitter = Math.floor(Math.random() * 500);
      item.nextRetryAt = Date.now() + baseDelay + jitter;

      await this.engine.put(V2_STORES.OUTBOX, item, context).catch(() => {});
    }
  }

  /**
   * Updates local stored entity version without creating new outbox entries.
   */
  private async updateLocalEntityVersion(
    storeName: V2StoreName,
    entityId: string,
    version: number,
    context: StorageContext
  ): Promise<void> {
    try {
      const existing = await this.engine.get<any>(storeName, entityId, context);
      if (existing) {
        existing.version = version;
        await this.engine.put(storeName, existing, context);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Handles server version conflict by attempting automatic 3-way merge on independent fields.
   * If overlapping fields conflict, stores in sync_conflicts without deleting user work.
   */
  public async handleConcurrencyConflict(
    item: OutboxMutationRecord,
    conflictResp: any,
    context: StorageContext
  ): Promise<void> {
    item.status = 'CONFLICT';
    item.updatedAt = new Date().toISOString();
    await this.engine.put(V2_STORES.OUTBOX, item, context);

    // Record conflict
    const conflictRecord: SyncConflictRecord = {
      id: item.id,
      workspaceId: item.workspaceId,
      entityType: item.entityType,
      entityId: item.entityId,
      localPayload: item.payload,
      serverPayload: conflictResp.current_record || {},
      baseVersion: item.baseVersion,
      serverVersion: conflictResp.current_version || item.baseVersion + 1,
      conflictingFields: Object.keys(item.payload || {}),
      resolved: false,
      createdAt: new Date().toISOString(),
    };

    const conflictMetaKey = `${item.workspaceId}#${item.id}`;
    const scopedConflict: ScopedRecord<SyncConflictRecord> = {
      ...conflictRecord,
      _storageKey: conflictMetaKey,
      _scope: SCOPES.WORKSPACE,
      _scopeId: item.workspaceId,
      _entityId: item.id,
      _entityType: V2_STORES.SYNC_CONFLICTS,
      _updatedAt: new Date().toISOString(),
    };

    await this.engine.put(V2_STORES.SYNC_CONFLICTS, scopedConflict as any, context);
    this.conflictCount += 1;
    this.updateState('conflict');
  }

  /**
   * Incoming Synchronization:
   * Calls fetch_workspace_sync_delta RPC and merges tombstones and entity changes into IndexedDB.
   */
  public async pullDelta(): Promise<void> {
    if (this.isPullingDelta) return;
    this.isPullingDelta = true;

    try {
      const ctx = this.manager.getContext();
      if (ctx.isGuest || !ctx.workspaceId) return;

      // 1. Get current checkpoint
      let checkpoint = await this.engine.get<SyncCheckpoint>(
        V2_STORES.SYNC_CHECKPOINTS,
        'current',
        ctx
      );

      const sinceCursor = checkpoint?.cursorSeq || 0;
      const sinceVersion = checkpoint?.lastSyncVersion || 0;

      const { data, error } = await supabase.rpc('fetch_workspace_sync_delta', {
        p_workspace_id: ctx.workspaceId,
        p_since_cursor_seq: sinceCursor,
        p_since_version: sinceVersion,
      });

      if (error) {
        if (error.message?.includes('STALE_CHECKPOINT')) {
          this.updateState('reconciliation_required', 'Checkpoint expired. Reconciliation required.');
          return;
        }
        throw error;
      }

      if (!data || !data.success) {
        if (data?.error === 'STALE_CHECKPOINT') {
          this.updateState('reconciliation_required', 'Checkpoint expired. Reconciliation required.');
        }
        return;
      }

      // Check context stability
      const activeCtx = this.manager.getContext();
      if (activeCtx.sessionGeneration !== ctx.sessionGeneration || activeCtx.workspaceId !== ctx.workspaceId) {
        return;
      }

      // 2. Process Tombstones
      const tombstones = data.tombstones || [];
      for (const tomb of tombstones) {
        const storeName = this.mapEntityTypeToStore(tomb.entity_type);
        if (storeName) {
          // Check if there is a pending local mutation that was created AFTER this deletion
          const hasPendingOutbox = await this.hasPendingMutationForEntity(
            storeName,
            tomb.entity_id,
            activeCtx
          );
          if (!hasPendingOutbox) {
            await this.engine.delete(storeName, tomb.entity_id, activeCtx).catch(() => {});
          }
        }
      }

      // 3. Process Entities
      const entities = data.entities || {};
      let maxEntityVersion = sinceVersion;

      for (const [entityKey, items] of Object.entries(entities)) {
        const storeName = this.mapEntityTypeToStore(entityKey);
        if (!storeName || !items) continue;

        const itemList = Array.isArray(items) ? items : [items];
        for (const item of itemList) {
          const resolvedEntityId = String(item?.id || item?.workspace_id || 'current');
          if (!item) continue;
          if (item.version && item.version > maxEntityVersion) {
            maxEntityVersion = item.version;
          }

          // Non-destructive update: check if there's a pending local mutation for this entity
          const hasPendingOutbox = await this.hasPendingMutationForEntity(
            storeName,
            resolvedEntityId,
            activeCtx
          );

          if (!hasPendingOutbox) {
            // Safe to apply server record locally
            const mapped = this.mapSupabaseRowToEntity(storeName, item);
            await this.engine.put(storeName, mapped, activeCtx).catch(() => {});
          }
        }
      }

      // 4. Update Checkpoint
      const newCheckpoint: SyncCheckpoint = {
        workspaceId: ctx.workspaceId,
        cursorSeq: data.cursor_seq || sinceCursor,
        lastSyncVersion: Math.max(maxEntityVersion, sinceVersion),
        lastSyncTimestamp: new Date().toISOString(),
      };

      await this.engine.put(V2_STORES.SYNC_CHECKPOINTS, { id: 'current', ...newCheckpoint }, activeCtx);

      // Rehydrate in-memory adapter cache and notify UI if any changes were pulled
      if ((tombstones && tombstones.length > 0) || (entities && Object.keys(entities).length > 0)) {
        await storageServiceAdapter.switchContext(activeCtx).catch(() => {});
        storageServiceAdapter.notifyStorageChange();
      }
    } finally {
      this.isPullingDelta = false;
    }
  }

  /**
   * Full Resync (Reconciliation):
   * Safely re-syncs all workspace data without destroying local pending mutations.
   */
  public async performFullResync(): Promise<void> {
    const ctx = this.manager.getContext();
    if (ctx.isGuest || !ctx.workspaceId) return;

    // Reset checkpoint to 0 to fetch all active data
    await this.engine.put(
      V2_STORES.SYNC_CHECKPOINTS,
      {
        id: 'current',
        workspaceId: ctx.workspaceId,
        cursorSeq: 0,
        lastSyncVersion: 0,
        lastSyncTimestamp: new Date().toISOString(),
      },
      ctx
    );

    // Pull delta from scratch
    await this.pullDelta();
    // Then resume processing outbox
    await this.processOutbox();
    await this.refreshMetrics();
  }

  /**
   * Helper to check if an entity has pending outbox mutations.
   */
  public async hasPendingMutationForEntity(
    storeName: V2StoreName,
    entityId: string,
    context: StorageContext
  ): Promise<boolean> {
    try {
      const outboxItems = await this.engine.getAll<OutboxMutationRecord>(V2_STORES.OUTBOX, context);
      return outboxItems.some(
        (i) => i.entityType === storeName && i.entityId === entityId && (i.status === 'PENDING' || i.status === 'IN_FLIGHT')
      );
    } catch {
      return false;
    }
  }

  public mapStoreToEntityType(storeName: string): string {
    const map: Record<string, string> = {
      [V2_STORES.TASKS]: 'tasks',
      [V2_STORES.PROJECTS]: 'projects',
      [V2_STORES.CLIENTS]: 'clients',
      [V2_STORES.TRANSACTIONS]: 'transactions',
      [V2_STORES.GOALS]: 'strategic_goals',
      [V2_STORES.PRIORITIES]: 'strategic_priorities',
      [V2_STORES.PLANS]: 'strategic_plans',
      [V2_STORES.MISSION]: 'strategy_missions',
      [V2_STORES.VISION]: 'strategy_visions',
      [V2_STORES.SETTINGS]: 'workspace_settings',
    };
    return map[storeName] || storeName;
  }

  public normalizePayloadForServer(storeName: string, payload: Record<string, any>): Record<string, any> {
    if (!payload || typeof payload !== 'object') return {};

    const copy = { ...payload };

    // Standardize camelCase to snake_case for Supabase columns
    if (copy.projectId !== undefined) copy.project_id = copy.projectId;
    if (copy.assigneeId !== undefined) copy.assignee_id = copy.assigneeId;
    if (copy.dueDate !== undefined) copy.due_date = copy.dueDate;
    if (copy.memberIds !== undefined) copy.member_ids = copy.memberIds;
    if (copy.isArchived !== undefined) copy.is_archived = copy.isArchived;
    if (copy.clientId !== undefined) copy.client_id = copy.clientId;
    if (copy.clientName !== undefined) copy.client_name = copy.clientName;
    if (copy.contactPerson !== undefined) copy.contact_person = copy.contactPerson;
    if (copy.dealValue !== undefined) copy.deal_value = copy.dealValue;
    if (copy.dealCurrency !== undefined) copy.deal_currency = copy.dealCurrency;
    if (copy.associatedProjectId !== undefined) copy.associated_project_id = copy.associatedProjectId;
    if (copy.lastInteraction !== undefined) copy.last_interaction = copy.lastInteraction;
    if (copy.ownerId !== undefined) copy.owner_id = copy.ownerId;
    if (copy.ownerName !== undefined) copy.owner_name = copy.ownerName;
    if (copy.startDate !== undefined) copy.start_date = copy.startDate;
    if (copy.targetDate !== undefined) copy.target_date = copy.targetDate;
    if (copy.relatedProjectIds !== undefined) copy.related_project_ids = copy.relatedProjectIds;
    if (copy.successCriteria !== undefined) copy.success_criteria = copy.successCriteria;
    if (copy.expectedResult !== undefined) copy.expected_result = copy.expectedResult;
    if (copy.relatedGoalId !== undefined) copy.related_goal_id = copy.relatedGoalId;
    if (copy.order !== undefined && copy.sort_order === undefined) copy.sort_order = copy.order;
    if (copy.timePeriod !== undefined) copy.time_period = copy.timePeriod;
    if (copy.expectedOutcome !== undefined) copy.expected_outcome = copy.expectedOutcome;
    if (copy.customerValue !== undefined) copy.customer_value = copy.customerValue;
    if (copy.desiredState !== undefined) copy.desired_state = copy.desiredState;
    if (copy.targetHorizon !== undefined) copy.target_horizon = copy.targetHorizon;
    if (copy.expectedOutcomes !== undefined) copy.expected_outcomes = copy.expectedOutcomes;

    return copy;
  }

  private mapEntityTypeToStore(type: string): V2StoreName | null {
    const map: Record<string, V2StoreName> = {
      tasks: V2_STORES.TASKS,
      projects: V2_STORES.PROJECTS,
      clients: V2_STORES.CLIENTS,
      transactions: V2_STORES.TRANSACTIONS,
      strategic_goals: V2_STORES.GOALS,
      strategic_priorities: V2_STORES.PRIORITIES,
      strategic_plans: V2_STORES.PLANS,
      strategy_missions: V2_STORES.MISSION,
      strategy_mission: V2_STORES.MISSION,
      strategy_visions: V2_STORES.VISION,
      strategy_vision: V2_STORES.VISION,
      workspace_settings: V2_STORES.SETTINGS,
      settings: V2_STORES.SETTINGS,
    };
    return map[type] || null;
  }

  public mapSupabaseRowToEntity(storeName: V2StoreName, row: any): any {
    if (!row) return row;

    if (storeName === V2_STORES.TASKS) {
      return {
        id: row.id,
        title: row.title,
        description: row.description || '',
        status: row.status,
        priority: row.priority,
        projectId: row.project_id || '',
        assigneeId: row.assignee_id || '',
        dueDate: row.due_date,
        completed: Boolean(row.completed),
        comments: row.comments || [],
        activities: row.activities || [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      };
    }
    if (storeName === V2_STORES.PROJECTS) {
      return {
        id: row.id,
        name: row.name,
        description: row.description || '',
        status: row.status,
        progress: row.progress || 0,
        deadline: row.deadline,
        category: row.category || 'Общий',
        isArchived: Boolean(row.is_archived),
        clientId: row.client_id,
        clientName: row.client_name,
        memberIds: row.member_ids || [],
        createdAt: row.created_at,
        version: row.version,
      };
    }
    if (storeName === V2_STORES.CLIENTS) {
      return {
        id: row.id,
        name: row.name,
        contactPerson: row.contact_person || '',
        email: row.email || '',
        phone: row.phone || '',
        status: row.status,
        dealValue: Number(row.deal_value || 0),
        dealCurrency: row.deal_currency || 'KZT',
        associatedProjectId: row.associated_project_id,
        description: row.description || '',
        avatar: row.avatar || '',
        lastInteraction: row.last_interaction,
        notes: row.notes || [],
        interactions: row.interactions || [],
        createdAt: row.created_at,
        version: row.version,
      };
    }
    if (storeName === V2_STORES.TRANSACTIONS) {
      return {
        id: row.id,
        title: row.title,
        amount: Number(row.amount || 0),
        currency: row.currency,
        type: row.type,
        category: row.category,
        date: row.date,
        status: row.status,
        projectId: row.project_id,
        clientId: row.client_id,
        notes: row.notes || '',
        createdAt: row.created_at,
        version: row.version,
      };
    }
    if (storeName === V2_STORES.GOALS) {
      return {
        id: row.id,
        title: row.title,
        description: row.description || '',
        category: row.category || 'Развитие',
        ownerId: row.owner_id || '',
        ownerName: row.owner_name || '',
        startDate: row.start_date,
        targetDate: row.target_date,
        progress: row.progress || 0,
        status: row.status || 'active',
        relatedProjectIds: row.related_project_ids || [],
        successCriteria: row.success_criteria || [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      };
    }
    if (storeName === V2_STORES.PRIORITIES) {
      return {
        id: row.id,
        name: row.name,
        description: row.description || '',
        importance: row.importance || 'high',
        ownerName: row.owner_name || '',
        expectedResult: row.expected_result || '',
        deadline: row.deadline,
        status: row.status || 'active',
        relatedGoalId: row.related_goal_id,
        order: row.sort_order || 0,
        progress: row.progress || 0,
        version: row.version,
      };
    }
    if (storeName === V2_STORES.PLANS) {
      return {
        id: row.id,
        title: row.title,
        description: row.description || '',
        timePeriod: row.time_period || 'Q1',
        quarter: row.quarter || 'Q1',
        month: row.month || '',
        ownerName: row.owner_name || '',
        status: row.status || 'planned',
        progress: row.progress || 0,
        relatedGoalId: row.related_goal_id,
        expectedOutcome: row.expected_outcome || '',
        deadline: row.deadline,
        order: row.sort_order || 0,
        version: row.version,
      };
    }
    if (storeName === V2_STORES.MISSION) {
      return {
        id: 'current',
        statement: row.statement || '',
        purpose: row.purpose || '',
        customerValue: row.customer_value || '',
        principles: row.principles || [],
        ownerName: row.owner_name || '',
        revisions: row.revisions || [],
        version: row.version,
      };
    }
    if (storeName === V2_STORES.VISION) {
      return {
        id: 'current',
        statement: row.statement || '',
        desiredState: row.desired_state || '',
        direction: row.direction || '',
        targetHorizon: row.target_horizon || '3_years',
        expectedOutcomes: row.expected_outcomes || [],
        ownerName: row.owner_name || '',
        revisions: row.revisions || [],
        version: row.version,
      };
    }
    if (storeName === V2_STORES.SETTINGS) {
      return {
        id: 'current',
        defaultCurrency: row.default_currency || 'KZT',
        theme: row.theme || 'dark',
        notifications: row.notifications_config || {},
        version: row.version,
      };
    }

    return { ...row, id: row.id || 'current', version: row.version };
  }
}

export const syncEngine = new SyncEngine();
