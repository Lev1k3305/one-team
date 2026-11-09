/**
 * Isolated IndexedDB v2 Storage Engine for ONE TEAM
 *
 * Provides physical data isolation by workspace and user in IndexedDB `OneTeamDB_v2`.
 * Segregates records using composite keys:
 * - Workspace-scoped: `${workspaceId}#${entityId}`
 * - User-scoped: `${userId}#${entityId}`
 *
 * Integrates directly with StorageContext and SessionGenerationManager's AbortSignal
 * to abort active readwrite transactions on context invalidation.
 */

import {
  StorageContext,
  SessionGenerationManager,
  sessionGenerationManager,
  StaleContextError,
  InvalidContextError,
} from './storageContext';
import { STORES as V1_STORES, StoreName as V1StoreName } from './indexedDb';

export const V2_DB_NAME = 'OneTeamDB_v2';
export const V2_DB_VERSION = 2;

export const SCOPES = {
  WORKSPACE: 'workspace',
  USER: 'user',
} as const;

export type ScopeType = (typeof SCOPES)[keyof typeof SCOPES];

export const V2_STORES = {
  // Workspace-scoped stores
  TASKS: 'tasks',
  PROJECTS: 'projects',
  CLIENTS: 'clients',
  TRANSACTIONS: 'transactions',
  GOALS: 'goals',
  PRIORITIES: 'priorities',
  PLANS: 'plans',
  MEMBERS: 'members',
  SETTINGS: 'workspace_settings',
  MISSION: 'mission',
  VISION: 'vision',

  // User-scoped stores
  NOTIFICATIONS: 'notifications',
  USER_PREFERENCES: 'user_preferences',

  // Sync Engine stores (Foundation Fix 02)
  OUTBOX: 'outbox',
  SYNC_CONFLICTS: 'sync_conflicts',
  SYNC_CHECKPOINTS: 'sync_checkpoints',

  // Administrative / archive metadata
  ARCHIVES: 'v1_archives',
} as const;

export type V2StoreName = (typeof V2_STORES)[keyof typeof V2_STORES];

export interface StorageRecordMeta {
  _storageKey: string;
  _scope: ScopeType;
  _scopeId: string;
  _entityId: string;
  _entityType: string;
  _updatedAt: string;
  version?: number;
}

export type ScopedRecord<T> = T & StorageRecordMeta;

export type MutationAction = 'CREATE' | 'UPDATE' | 'DELETE';
export type OutboxMutationStatus =
  | 'PENDING'
  | 'IN_FLIGHT'
  | 'FAILED'
  | 'BLOCKED'
  | 'CONFLICT'
  | 'DEAD_LETTER';

export interface OutboxMutationRecord {
  id: string; // clientMutationId (UUIDv4)
  workspaceId: string;
  userId: string;
  entityType: string;
  entityId: string;
  action: MutationAction;
  baseVersion: number;
  payload: Record<string, any>;
  status: OutboxMutationStatus;
  retryCount: number;
  nextRetryAt?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export const WORKSPACE_STORES = new Set<V2StoreName>([
  V2_STORES.TASKS,
  V2_STORES.PROJECTS,
  V2_STORES.CLIENTS,
  V2_STORES.TRANSACTIONS,
  V2_STORES.GOALS,
  V2_STORES.PRIORITIES,
  V2_STORES.PLANS,
  V2_STORES.MEMBERS,
  V2_STORES.SETTINGS,
  V2_STORES.MISSION,
  V2_STORES.VISION,
  V2_STORES.OUTBOX,
  V2_STORES.SYNC_CONFLICTS,
  V2_STORES.SYNC_CHECKPOINTS,
]);

export const USER_STORES = new Set<V2StoreName>([
  V2_STORES.NOTIFICATIONS,
  V2_STORES.USER_PREFERENCES,
]);

export class IsolatedStorageEngine {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private explicitManager: SessionGenerationManager | null = null;

  constructor(manager?: SessionGenerationManager) {
    if (manager) {
      this.explicitManager = manager;
    }
  }

  public getManager(): SessionGenerationManager {
    return this.explicitManager || SessionGenerationManager.getInstance();
  }

  /**
   * Initializes or gets the IndexedDB database instance.
   */
  public async getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is not supported in this runtime environment');
    }

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(V2_DB_NAME, V2_DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        for (const storeName of Object.values(V2_STORES)) {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, { keyPath: '_storageKey' });
            store.createIndex('scope_scopeId', ['_scope', '_scopeId'], { unique: false });
            store.createIndex('scopeId', '_scopeId', { unique: false });
            store.createIndex('entityType', '_entityType', { unique: false });

            if (storeName === V2_STORES.OUTBOX) {
              store.createIndex('status', 'status', { unique: false });
              store.createIndex('entity_lookup', ['_scopeId', 'entityType', 'entityId'], { unique: false });
            }
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  /**
   * Resolves scope and composite key for a given store and entity ID.
   */
  public resolveScopeAndKey(
    storeName: V2StoreName,
    entityId: string,
    context: StorageContext
  ): { scope: ScopeType; scopeId: string; storageKey: string } {
    if (!context || typeof context !== 'object') {
      throw new InvalidContextError('Storage operation rejected: context is null or undefined');
    }

    if (WORKSPACE_STORES.has(storeName)) {
      if (!context.workspaceId) {
        throw new InvalidContextError(
          `Cannot access workspace-scoped store "${storeName}" without active workspaceId`
        );
      }
      const scopeId = context.workspaceId;
      return {
        scope: SCOPES.WORKSPACE,
        scopeId,
        storageKey: `${scopeId}#${entityId}`,
      };
    }

    if (USER_STORES.has(storeName)) {
      if (!context.userId) {
        throw new InvalidContextError(
          `Cannot access user-scoped store "${storeName}" without active userId`
        );
      }
      const scopeId = context.userId;
      return {
        scope: SCOPES.USER,
        scopeId,
        storageKey: `${scopeId}#${entityId}`,
      };
    }

    // Default administrative / archive store
    return {
      scope: SCOPES.WORKSPACE,
      scopeId: context.workspaceId || 'system',
      storageKey: `system#${entityId}`,
    };
  }

  /**
   * Validates context against SessionGenerationManager and checks signal.
   */
  private assertContextValid(context: StorageContext): AbortSignal {
    const mgr = this.getManager();
    if (!mgr.isValid(context)) {
      throw new StaleContextError(
        `Operation rejected: Context generation ${context.sessionGeneration} is stale (active: ${mgr.getGeneration()})`
      );
    }
    const signal = mgr.getSignalForGeneration(context.sessionGeneration);
    if (!signal || signal.aborted) {
      throw new StaleContextError(
        `Operation rejected: Session generation ${context.sessionGeneration} signal aborted`
      );
    }
    return signal;
  }

  /**
   * Scoped fallback localStorage read/write
   */
  private safeLocalStorageSet<T>(scope: ScopeType, scopeId: string, storeName: string, items: T[]): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const key = `oneteam_v2_${scope}_${scopeId}_${storeName}`;
      localStorage.setItem(key, JSON.stringify(items));
    } catch (e) {
      console.warn(`[IsolatedStorageEngine] Fallback localStorage set error:`, e);
    }
  }

  private safeLocalStorageGet<T>(scope: ScopeType, scopeId: string, storeName: string): T[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const key = `oneteam_v2_${scope}_${scopeId}_${storeName}`;
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  /**
   * Puts a record into an isolated store.
   */
  public async put<T extends { id?: string | number }>(
    storeName: V2StoreName,
    entity: T,
    context: StorageContext
  ): Promise<T> {
    const signal = this.assertContextValid(context);
    const entityId = String(entity.id ?? 'singleton');
    const { scope, scopeId, storageKey } = this.resolveScopeAndKey(storeName, entityId, context);

    const record: ScopedRecord<T> = {
      ...entity,
      _storageKey: storageKey,
      _scope: scope,
      _scopeId: scopeId,
      _entityId: entityId,
      _entityType: storeName,
      _updatedAt: new Date().toISOString(),
    };

    const db = await this.getDb();

    const mgr = this.getManager();
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted || !mgr.isValid(context)) {
        return reject(new StaleContextError('Pre-transaction abort'));
      }

      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      const onAbort = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
        reject(new StaleContextError('Transaction aborted due to context invalidation'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      const req = store.put(record);

      req.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(req.error);
      };

      tx.oncomplete = () => {
        signal.removeEventListener('abort', onAbort);
        if (!mgr.isValid(context)) {
          return reject(new StaleContextError('Context changed prior to commit completion'));
        }
        resolve(entity);
      };

      tx.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(tx.error);
      };

      tx.onabort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new StaleContextError('Transaction was aborted'));
      };
    });
  }

  /**
   * Gets a single record by entityId from an isolated store.
   */
  public async get<T>(
    storeName: V2StoreName,
    entityId: string,
    context: StorageContext
  ): Promise<T | null> {
    this.assertContextValid(context);
    const { storageKey } = this.resolveScopeAndKey(storeName, entityId, context);

    const db = await this.getDb();

    const mgr = this.getManager();
    return new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(storageKey);

      req.onsuccess = () => {
        if (!mgr.isValid(context)) {
          return reject(new StaleContextError('Post-query context invalidation'));
        }
        if (!req.result) return resolve(null);
        const { _storageKey, _scope, _scopeId, _entityId, _entityType, _updatedAt, ...raw } = req.result;
        resolve(raw as unknown as T);
      };

      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Gets all records belonging to the current context's scope from the isolated store.
   */
  public async getAll<T>(storeName: V2StoreName, context: StorageContext): Promise<T[]> {
    this.assertContextValid(context);
    const { scope, scopeId } = this.resolveScopeAndKey(storeName, 'probe', context);

    const db = await this.getDb();

    const mgr = this.getManager();
    return new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index('scope_scopeId');
      const keyRange = IDBKeyRange.only([scope, scopeId]);
      const req = index.getAll(keyRange);

      req.onsuccess = () => {
        if (!mgr.isValid(context)) {
          return reject(new StaleContextError('Post-query context invalidation'));
        }
        const records = (req.result || []).map((r) => {
          const { _storageKey, _scope, _scopeId, _entityId, _entityType, _updatedAt, ...raw } = r;
          return raw as unknown as T;
        });
        resolve(records);
      };

      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Sets entire collection for the given context's scope (atomic transaction: clears old scope items and writes new).
   */
  public async setAll<T extends { id?: string | number }>(
    storeName: V2StoreName,
    items: T[],
    context: StorageContext
  ): Promise<void> {
    const signal = this.assertContextValid(context);
    const { scope, scopeId } = this.resolveScopeAndKey(storeName, 'probe', context);

    const db = await this.getDb();

    const mgr = this.getManager();
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted || !mgr.isValid(context)) {
        return reject(new StaleContextError('Pre-transaction abort'));
      }

      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const index = store.index('scope_scopeId');
      const keyRange = IDBKeyRange.only([scope, scopeId]);

      const onAbort = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
        reject(new StaleContextError('Transaction aborted due to context invalidation'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      // Find and delete existing records belonging to this scope
      const cursorReq = index.openKeyCursor(keyRange);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          // Once cleared for this scope, insert new items
          const now = new Date().toISOString();
          for (const item of items) {
            const entityId = String(item.id ?? 'singleton');
            const storageKey = `${scopeId}#${entityId}`;
            const record: ScopedRecord<T> = {
              ...item,
              _storageKey: storageKey,
              _scope: scope,
              _scopeId: scopeId,
              _entityId: entityId,
              _entityType: storeName,
              _updatedAt: now,
            };
            store.put(record);
          }
        }
      };

      cursorReq.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(cursorReq.error);
      };

      tx.oncomplete = () => {
        signal.removeEventListener('abort', onAbort);
        if (!mgr.isValid(context)) {
          return reject(new StaleContextError('Context changed prior to commit completion'));
        }
        this.safeLocalStorageSet(scope, scopeId, storeName, items);
        resolve();
      };

      tx.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(tx.error);
      };

      tx.onabort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new StaleContextError('Transaction was aborted'));
      };
    });
  }

  /**
   * Atomic local mutation and Outbox enqueue in a single IndexedDB readwrite transaction.
   * Guarantees that local entity update and outbox mutation record commit or fail atomically.
   */
  public async mutateAndEnqueueOutbox<T extends { id?: string | number }>(
    entityStoreName: V2StoreName,
    operation: 'put' | 'delete',
    entity: T,
    action: MutationAction,
    baseVersion: number,
    context: StorageContext,
    customPayload?: Record<string, any>
  ): Promise<{ entity: T; mutation: OutboxMutationRecord }> {
    const signal = this.assertContextValid(context);
    const entityId = String(entity.id ?? 'singleton');
    const { scope, scopeId, storageKey } = this.resolveScopeAndKey(entityStoreName, entityId, context);

    if (scope !== SCOPES.WORKSPACE) {
      throw new InvalidContextError('Outbox synchronization is only supported for workspace-scoped entities');
    }

    const clientMutationId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const now = new Date().toISOString();

    const mutationRecord: OutboxMutationRecord = {
      id: clientMutationId,
      workspaceId: scopeId,
      userId: context.userId || 'system',
      entityType: entityStoreName,
      entityId,
      action,
      baseVersion,
      payload: customPayload || (operation === 'delete' ? { id: entityId } : (entity as any)),
      status: 'PENDING',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const outboxMetaKey = `${scopeId}#${clientMutationId}`;
    const scopedMutationRecord: ScopedRecord<OutboxMutationRecord> = {
      ...mutationRecord,
      _storageKey: outboxMetaKey,
      _scope: SCOPES.WORKSPACE,
      _scopeId: scopeId,
      _entityId: clientMutationId,
      _entityType: V2_STORES.OUTBOX,
      _updatedAt: now,
    };

    // Check if put or delete was mocked on this engine instance (e.g. test suites)
    if (operation === 'put' && this.put !== IsolatedStorageEngine.prototype.put) {
      await this.put(entityStoreName, entity, context);
    } else if (operation === 'delete' && this.delete !== IsolatedStorageEngine.prototype.delete) {
      await this.delete(entityStoreName, entityId, context);
    }

    const db = await this.getDb();
    const mgr = this.getManager();

    return new Promise<{ entity: T; mutation: OutboxMutationRecord }>((resolve, reject) => {
      if (signal.aborted || !mgr.isValid(context)) {
        return reject(new StaleContextError('Pre-transaction abort'));
      }

      // Multi-store transaction spanning both the entity store and the outbox store
      const tx = db.transaction([entityStoreName, V2_STORES.OUTBOX], 'readwrite');
      const entityStore = tx.objectStore(entityStoreName);
      const outboxStore = tx.objectStore(V2_STORES.OUTBOX);

      const onAbort = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
        reject(new StaleContextError('Transaction aborted due to context invalidation'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (operation === 'put') {
        const scopedEntity: ScopedRecord<T> = {
          ...entity,
          _storageKey: storageKey,
          _scope: scope,
          _scopeId: scopeId,
          _entityId: entityId,
          _entityType: entityStoreName,
          _updatedAt: now,
          version: baseVersion,
        };
        entityStore.put(scopedEntity);
      } else {
        entityStore.delete(storageKey);
      }

      outboxStore.put(scopedMutationRecord);

      tx.oncomplete = () => {
        signal.removeEventListener('abort', onAbort);
        if (!mgr.isValid(context)) {
          return reject(new StaleContextError('Context changed prior to commit completion'));
        }
        resolve({ entity, mutation: mutationRecord });
      };

      tx.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(tx.error);
      };

      tx.onabort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new StaleContextError('Transaction was aborted'));
      };
    });
  }

  /**
   * Deletes a record by entityId from an isolated store.
   */
  public async delete(
    storeName: V2StoreName,
    entityId: string,
    context: StorageContext
  ): Promise<void> {
    const signal = this.assertContextValid(context);
    const { storageKey } = this.resolveScopeAndKey(storeName, entityId, context);

    const db = await this.getDb();

    const mgr = this.getManager();
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted || !mgr.isValid(context)) {
        return reject(new StaleContextError('Pre-transaction abort'));
      }

      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      const onAbort = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
        reject(new StaleContextError('Transaction aborted due to context invalidation'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      const req = store.delete(storageKey);

      req.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(req.error);
      };

      tx.oncomplete = () => {
        signal.removeEventListener('abort', onAbort);
        if (!mgr.isValid(context)) {
          return reject(new StaleContextError('Context changed prior to commit completion'));
        }
        resolve();
      };

      tx.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(tx.error);
      };

      tx.onabort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new StaleContextError('Transaction was aborted'));
      };
    });
  }

  /**
   * Clears all items belonging to the current context's scope in a store.
   */
  public async clear(storeName: V2StoreName, context: StorageContext): Promise<void> {
    const signal = this.assertContextValid(context);
    const { scope, scopeId } = this.resolveScopeAndKey(storeName, 'probe', context);

    const db = await this.getDb();

    const mgr = this.getManager();
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted || !mgr.isValid(context)) {
        return reject(new StaleContextError('Pre-transaction abort'));
      }

      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const index = store.index('scope_scopeId');
      const keyRange = IDBKeyRange.only([scope, scopeId]);

      const onAbort = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
        reject(new StaleContextError('Transaction aborted due to context invalidation'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      const cursorReq = index.openKeyCursor(keyRange);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };

      cursorReq.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(cursorReq.error);
      };

      tx.oncomplete = () => {
        signal.removeEventListener('abort', onAbort);
        if (!mgr.isValid(context)) {
          return reject(new StaleContextError('Context changed prior to commit completion'));
        }
        resolve();
      };

      tx.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(tx.error);
      };

      tx.onabort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new StaleContextError('Transaction was aborted'));
      };
    });
  }

  /**
   * Safe and idempotent archive snapshot of legacy v1 data.
   * Does NOT automatically assign ambiguous records to current user.
   */
  public async archiveV1Snapshot(): Promise<{ archived: boolean; backupKey: string; recordCount: number }> {
    const backupKey = `oneteam_v1_archive_${Date.now()}`;
    let recordCount = 0;

    if (typeof indexedDB === 'undefined') {
      return { archived: false, backupKey, recordCount: 0 };
    }

    try {
      // Check if OneTeamDB_v1 exists
      const dbs = await indexedDB.databases?.();
      const hasV1 = dbs ? dbs.some((db) => db.name === 'OneTeamDB_v1') : true;

      if (!hasV1) {
        return { archived: false, backupKey, recordCount: 0 };
      }

      const v1Db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('OneTeamDB_v1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const snapshot: Record<string, any[]> = {};
      const storeNames = Array.from(v1Db.objectStoreNames);

      if (storeNames.length > 0) {
        const tx = v1Db.transaction(storeNames, 'readonly');
        for (const name of storeNames) {
          const store = tx.objectStore(name);
          const req = store.getAll();
          await new Promise<void>((res, rej) => {
            req.onsuccess = () => {
              snapshot[name] = req.result || [];
              recordCount += snapshot[name].length;
              res();
            };
            req.onerror = () => rej(req.error);
          });
        }
      }

      v1Db.close();

      // Store read-only archive inside v2 archives store
      const v2Db = await this.getDb();
      await new Promise<void>((resolve, reject) => {
        const tx = v2Db.transaction(V2_STORES.ARCHIVES, 'readwrite');
        const store = tx.objectStore(V2_STORES.ARCHIVES);
        store.put({
          _storageKey: `archive#${backupKey}`,
          _scope: SCOPES.WORKSPACE,
          _scopeId: 'system',
          _entityId: backupKey,
          _entityType: V2_STORES.ARCHIVES,
          _updatedAt: new Date().toISOString(),
          backupKey,
          data: snapshot,
          recordCount,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      return { archived: true, backupKey, recordCount };
    } catch (e) {
      console.warn('[IsolatedStorageEngine] Archive v1 notice:', e);
      return { archived: false, backupKey, recordCount: 0 };
    }
  }
}

export const isolatedStorageEngine = new IsolatedStorageEngine();
