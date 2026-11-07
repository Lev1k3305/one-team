/**
 * Storage Service Adapter for ONE TEAM
 *
 * Bridges the synchronous API expected by AppContext/UI components with the
 * underlying asynchronous, isolated IndexedDB v2 engine (IsolatedStorageEngine).
 *
 * Implements a strict hydration lifecycle:
 *   uninitialized -> hydrating -> ready -> error
 *
 * Partitions in-memory cache by workspaceId and userId, ensuring zero data leakage
 * across workspace switches and user sign-out/sign-in cycles.
 */

import {
  Task,
  Project,
  TeamMember,
  WorkspaceSettings,
  NotificationItem,
  TaskStatus,
  TaskComment,
  Client,
  Transaction,
  ClientNote,
  ClientInteraction,
  TeamMission,
  TeamVision,
  StrategicGoal,
  StrategicPriority,
  DevelopmentPlanItem,
} from '../types';
import {
  INITIAL_MEMBERS,
  INITIAL_SETTINGS,
  INITIAL_MISSION,
  INITIAL_VISION,
} from './mockData';
import {
  StorageContext,
  SessionGenerationManager,
  sessionGenerationManager,
  StaleContextError,
  InvalidContextError,
} from './storageContext';
import {
  IsolatedStorageEngine,
  isolatedStorageEngine,
  V2_STORES,
  V2StoreName,
} from './indexedDbV2';

export type HydrationState = 'uninitialized' | 'hydrating' | 'ready' | 'error';

export interface PersistenceErrorEvent {
  storeName: V2StoreName;
  operation: 'put' | 'delete' | 'setAll' | 'clear';
  error: unknown;
  context: StorageContext;
}

export type PersistenceErrorHandler = (event: PersistenceErrorEvent) => void;

interface WorkspaceCache {
  tasks: Task[];
  projects: Project[];
  members: TeamMember[];
  clients: Client[];
  transactions: Transaction[];
  settings: WorkspaceSettings;
  mission: TeamMission;
  vision: TeamVision;
  goals: StrategicGoal[];
  priorities: StrategicPriority[];
  plan: DevelopmentPlanItem[];
}

interface UserCache {
  notifications: NotificationItem[];
  preferences: Record<string, unknown>;
}

export class StorageServiceAdapter {
  private engine: IsolatedStorageEngine;
  private manager: SessionGenerationManager;

  private currentContext: StorageContext;
  private state: HydrationState = 'uninitialized';
  private hydrationError: Error | null = null;

  // Distinct in-memory caches partitioned by scope ID
  private workspaceCaches: Map<string, WorkspaceCache> = new Map();
  private userCaches: Map<string, UserCache> = new Map();

  private errorHandlers: Set<PersistenceErrorHandler> = new Set();

  constructor(
    engine: IsolatedStorageEngine = isolatedStorageEngine,
    manager: SessionGenerationManager = sessionGenerationManager
  ) {
    this.engine = engine;
    this.manager = manager;
    this.currentContext = manager.getContext();
  }

  public getState(): HydrationState {
    return this.state;
  }

  public getHydrationError(): Error | null {
    return this.hydrationError;
  }

  public getContext(): StorageContext {
    return this.currentContext;
  }

  public onPersistenceError(handler: PersistenceErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  private emitPersistenceError(
    storeName: V2StoreName,
    operation: 'put' | 'delete' | 'setAll' | 'clear',
    error: unknown,
    context: StorageContext
  ): void {
    const event: PersistenceErrorEvent = { storeName, operation, error, context };
    for (const handler of this.errorHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[StorageServiceAdapter] Error in persistence error handler:', err);
      }
    }
  }

  private initEmptyWorkspaceCache(): WorkspaceCache {
    return {
      tasks: [],
      projects: [],
      members: [...INITIAL_MEMBERS],
      clients: [],
      transactions: [],
      settings: { ...INITIAL_SETTINGS },
      mission: { ...INITIAL_MISSION },
      vision: { ...INITIAL_VISION },
      goals: [],
      priorities: [],
      plan: [],
    };
  }

  private initEmptyUserCache(): UserCache {
    return {
      notifications: [],
      preferences: {},
    };
  }

  private getActiveWorkspaceCache(): WorkspaceCache {
    if (this.state !== 'ready') {
      throw new Error(`[StorageServiceAdapter] Access denied: storage is not ready (current state: ${this.state})`);
    }
    const wsId = this.currentContext.workspaceId;
    if (!wsId) {
      throw new InvalidContextError('[StorageServiceAdapter] No active workspace context');
    }
    let cache = this.workspaceCaches.get(wsId);
    if (!cache) {
      cache = this.initEmptyWorkspaceCache();
      this.workspaceCaches.set(wsId, cache);
    }
    return cache;
  }

  private getActiveUserCache(): UserCache {
    if (this.state !== 'ready') {
      throw new Error(`[StorageServiceAdapter] Access denied: storage is not ready (current state: ${this.state})`);
    }
    const uId = this.currentContext.userId;
    if (!uId) {
      throw new InvalidContextError('[StorageServiceAdapter] No active user context');
    }
    let cache = this.userCaches.get(uId);
    if (!cache) {
      cache = this.initEmptyUserCache();
      this.userCaches.set(uId, cache);
    }
    return cache;
  }

  /**
   * Switches context and hydrates in-memory cache from IndexedDB v2.
   * If the context changes during hydration, the stale hydration result is discarded.
   */
  public async switchContext(newContext: StorageContext): Promise<void> {
    this.currentContext = newContext;
    this.state = 'hydrating';
    this.hydrationError = null;

    if (newContext.isGuest) {
      this.state = 'ready';
      return;
    }

    try {
      const targetGeneration = newContext.sessionGeneration;
      const wsId = newContext.workspaceId;
      const uId = newContext.userId;

      // 1. Hydrate workspace if present
      let loadedWsCache: WorkspaceCache | null = null;
      if (wsId) {
        const [
          tasks,
          projects,
          members,
          clients,
          transactions,
          settings,
          mission,
          vision,
          goals,
          priorities,
          plan,
        ] = await Promise.all([
          this.engine.getAll<Task>(V2_STORES.TASKS, newContext),
          this.engine.getAll<Project>(V2_STORES.PROJECTS, newContext),
          this.engine.getAll<TeamMember>(V2_STORES.MEMBERS, newContext),
          this.engine.getAll<Client>(V2_STORES.CLIENTS, newContext),
          this.engine.getAll<Transaction>(V2_STORES.TRANSACTIONS, newContext),
          this.engine.get<WorkspaceSettings>(V2_STORES.SETTINGS, 'current', newContext),
          this.engine.get<TeamMission>(V2_STORES.MISSION, 'current', newContext),
          this.engine.get<TeamVision>(V2_STORES.VISION, 'current', newContext),
          this.engine.getAll<StrategicGoal>(V2_STORES.GOALS, newContext),
          this.engine.getAll<StrategicPriority>(V2_STORES.PRIORITIES, newContext),
          this.engine.getAll<DevelopmentPlanItem>(V2_STORES.PLANS, newContext),
        ]);

        loadedWsCache = {
          tasks,
          projects,
          members: members.length > 0 ? members : [...INITIAL_MEMBERS],
          clients,
          transactions,
          settings: settings || { ...INITIAL_SETTINGS },
          mission: mission || { ...INITIAL_MISSION },
          vision: vision || { ...INITIAL_VISION },
          goals,
          priorities,
          plan,
        };
      }

      // 2. Hydrate user if present
      let loadedUserCache: UserCache | null = null;
      if (uId) {
        const notifications = await this.engine.getAll<NotificationItem>(
          V2_STORES.NOTIFICATIONS,
          newContext
        );
        loadedUserCache = {
          notifications,
          preferences: {},
        };
      }

      // 3. Stale check: discard if context transitioned while awaiting IDB
      if (
        this.manager.getGeneration() !== targetGeneration ||
        !this.manager.isValid(newContext)
      ) {
        return; // Discard stale hydration result
      }

      if (wsId && loadedWsCache) {
        // IndexedDB is the authoritative source of truth upon clean hydration
        this.workspaceCaches.set(wsId, loadedWsCache);
      }
      if (uId && loadedUserCache) {
        this.userCaches.set(uId, loadedUserCache);
      }

      this.state = 'ready';
    } catch (err) {
      if (err instanceof StaleContextError) {
        return; // Stale hydration attempt aborted normally
      }
      this.state = 'error';
      this.hydrationError = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  }

  /**
   * Rehydrates the active context from scratch (useful after resolving offline/persistence errors).
   */
  public async rehydrate(): Promise<void> {
    await this.switchContext(this.currentContext);
  }

  // =========================================================================
  // Synchronous Public API (Preserves StorageService signatures)
  // =========================================================================

  public isDemoCleaned(): boolean {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('oneteam_demo_cleaned_v1') === 'true';
  }

  // --- Tasks ---

  public getTasks(): Task[] {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return [];
    return this.getActiveWorkspaceCache().tasks;
  }

  public setTasks(tasks: Task[]): void {
    const cache = this.getActiveWorkspaceCache();
    cache.tasks = [...tasks];

    const captureContext = this.currentContext;
    this.engine.setAll(V2_STORES.TASKS, tasks, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.TASKS, 'setAll', err, captureContext);
    });
  }

  public saveTask(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Task {
    const cache = this.getActiveWorkspaceCache();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 16);

    let savedTask: Task;
    if (task.id) {
      const idx = cache.tasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) {
        savedTask = {
          ...cache.tasks[idx],
          ...task,
          updatedAt: now,
        };
        cache.tasks[idx] = savedTask;
      } else {
        savedTask = {
          ...task,
          id: task.id,
          comments: task.comments || [],
          activities: task.activities || [],
          completed: task.completed ?? task.status === 'done',
          createdAt: now,
          updatedAt: now,
        } as Task;
        cache.tasks.unshift(savedTask);
      }
    } else {
      const id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      savedTask = {
        ...task,
        id,
        comments: task.comments || [],
        activities: task.activities || [
          {
            id: `a-${Date.now()}`,
            action: 'Задача создана',
            authorName: cache.settings.currentUser.name || 'Пользователь',
            timestamp: now,
          },
        ],
        completed: task.completed ?? task.status === 'done',
        createdAt: now,
        updatedAt: now,
      };
      cache.tasks.unshift(savedTask);
    }

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.TASKS, savedTask, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.TASKS, 'put', err, captureContext);
    });

    return savedTask;
  }

  public deleteTask(taskId: string): void {
    const cache = this.getActiveWorkspaceCache();
    cache.tasks = cache.tasks.filter((t) => t.id !== taskId);

    const captureContext = this.currentContext;
    this.engine.delete(V2_STORES.TASKS, taskId, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.TASKS, 'delete', err, captureContext);
    });
  }

  public updateTaskStatus(taskId: string, status: TaskStatus): Task | null {
    const cache = this.getActiveWorkspaceCache();
    const idx = cache.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return null;

    const now = new Date().toISOString().replace('T', ' ').substring(0, 16);
    const statusLabels: Record<TaskStatus, string> = {
      todo: 'К выполнению',
      in_progress: 'В работе',
      review: 'На проверке',
      done: 'Готово',
    };

    const updated: Task = {
      ...cache.tasks[idx],
      status,
      completed: status === 'done',
      updatedAt: now,
      activities: [
        {
          id: `a-${Date.now()}`,
          action: `Статус изменён на "${statusLabels[status]}"`,
          authorName: cache.settings.currentUser.name || 'Пользователь',
          timestamp: now,
        },
        ...cache.tasks[idx].activities,
      ],
    };

    cache.tasks[idx] = updated;

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.TASKS, updated, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.TASKS, 'put', err, captureContext);
    });

    return updated;
  }

  public toggleTaskCompletion(taskId: string): Task | null {
    const cache = this.getActiveWorkspaceCache();
    const idx = cache.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return null;

    const task = cache.tasks[idx];
    const newCompleted = !task.completed;
    const newStatus: TaskStatus = newCompleted ? 'done' : 'in_progress';
    const now = new Date().toISOString().replace('T', ' ').substring(0, 16);

    const updated: Task = {
      ...task,
      completed: newCompleted,
      status: newStatus,
      updatedAt: now,
      activities: [
        {
          id: `a-${Date.now()}`,
          action: newCompleted ? 'Задача отмечена как выполненная' : 'Задача возвращена в работу',
          authorName: cache.settings.currentUser.name || 'Пользователь',
          timestamp: now,
        },
        ...task.activities,
      ],
    };

    cache.tasks[idx] = updated;

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.TASKS, updated, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.TASKS, 'put', err, captureContext);
    });

    return updated;
  }

  public addTaskComment(
    taskId: string,
    text: string,
    author: { name: string; avatar: string }
  ): TaskComment | null {
    const cache = this.getActiveWorkspaceCache();
    const idx = cache.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return null;

    const now = new Date().toISOString().replace('T', ' ').substring(0, 16);
    const comment: TaskComment = {
      id: `c-${Date.now()}`,
      authorId: this.currentContext.userId || 'unknown',
      authorName: author.name,
      authorAvatar: author.avatar,
      text,
      createdAt: now,
    };

    cache.tasks[idx].comments.push(comment);
    cache.tasks[idx].updatedAt = now;

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.TASKS, cache.tasks[idx], captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.TASKS, 'put', err, captureContext);
    });

    return comment;
  }

  // --- Projects ---

  public getProjects(): Project[] {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return [];
    return this.getActiveWorkspaceCache().projects;
  }

  public setProjects(projects: Project[]): void {
    const cache = this.getActiveWorkspaceCache();
    cache.projects = [...projects];

    const captureContext = this.currentContext;
    this.engine.setAll(V2_STORES.PROJECTS, projects, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.PROJECTS, 'setAll', err, captureContext);
    });
  }

  public saveProject(project: Omit<Project, 'id' | 'createdAt'> & { id?: string }): Project {
    const cache = this.getActiveWorkspaceCache();
    const now = new Date().toISOString().split('T')[0];

    let savedProj: Project;
    if (project.id) {
      const idx = cache.projects.findIndex((p) => p.id === project.id);
      if (idx !== -1) {
        savedProj = {
          ...cache.projects[idx],
          ...project,
        };
        cache.projects[idx] = savedProj;
      } else {
        savedProj = {
          ...project,
          id: project.id,
          createdAt: now,
        } as Project;
        cache.projects.unshift(savedProj);
      }
    } else {
      const id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      savedProj = {
        ...project,
        id,
        createdAt: now,
      };
      cache.projects.unshift(savedProj);
    }

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.PROJECTS, savedProj, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.PROJECTS, 'put', err, captureContext);
    });

    return savedProj;
  }

  public deleteProject(projectId: string): void {
    const cache = this.getActiveWorkspaceCache();
    cache.projects = cache.projects.filter((p) => p.id !== projectId);

    const captureContext = this.currentContext;
    this.engine.delete(V2_STORES.PROJECTS, projectId, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.PROJECTS, 'delete', err, captureContext);
    });
  }

  public toggleArchiveProject(projectId: string): Project | null {
    const cache = this.getActiveWorkspaceCache();
    const idx = cache.projects.findIndex((p) => p.id === projectId);
    if (idx === -1) return null;

    cache.projects[idx].isArchived = !cache.projects[idx].isArchived;

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.PROJECTS, cache.projects[idx], captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.PROJECTS, 'put', err, captureContext);
    });

    return cache.projects[idx];
  }

  // --- Members ---

  public getMembers(): TeamMember[] {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return [...INITIAL_MEMBERS];
    return this.getActiveWorkspaceCache().members;
  }

  public saveMember(member: Omit<TeamMember, 'id'> & { id?: string }): TeamMember {
    const cache = this.getActiveWorkspaceCache();
    let saved: TeamMember;

    if (member.id) {
      const idx = cache.members.findIndex((m) => m.id === member.id);
      if (idx !== -1) {
        saved = { ...cache.members[idx], ...member };
        cache.members[idx] = saved;
      } else {
        saved = { ...member, id: member.id } as TeamMember;
        cache.members.push(saved);
      }
    } else {
      saved = { ...member, id: `user-${Date.now()}` };
      cache.members.push(saved);
    }

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.MEMBERS, saved, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.MEMBERS, 'put', err, captureContext);
    });

    return saved;
  }

  public deleteMember(memberId: string): void {
    const cache = this.getActiveWorkspaceCache();
    cache.members = cache.members.filter((m) => m.id !== memberId);

    const captureContext = this.currentContext;
    this.engine.delete(V2_STORES.MEMBERS, memberId, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.MEMBERS, 'delete', err, captureContext);
    });
  }

  // --- Clients ---

  public getClients(): Client[] {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return [];
    return this.getActiveWorkspaceCache().clients;
  }

  public setClients(clients: Client[]): void {
    const cache = this.getActiveWorkspaceCache();
    cache.clients = [...clients];

    const captureContext = this.currentContext;
    this.engine.setAll(V2_STORES.CLIENTS, clients, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.CLIENTS, 'setAll', err, captureContext);
    });
  }

  public saveClient(client: Omit<Client, 'id' | 'createdAt'> & { id?: string }): Client {
    const cache = this.getActiveWorkspaceCache();
    const now = new Date().toISOString().split('T')[0];

    let saved: Client;
    if (client.id) {
      const idx = cache.clients.findIndex((c) => c.id === client.id);
      if (idx !== -1) {
        saved = { ...cache.clients[idx], ...client };
        cache.clients[idx] = saved;
      } else {
        saved = { ...client, id: client.id, notes: client.notes || [], interactions: client.interactions || [], createdAt: now } as Client;
        cache.clients.unshift(saved);
      }
    } else {
      const id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      saved = {
        ...client,
        id,
        notes: client.notes || [],
        interactions: client.interactions || [],
        createdAt: now,
      };
      cache.clients.unshift(saved);
    }

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.CLIENTS, saved, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.CLIENTS, 'put', err, captureContext);
    });

    return saved;
  }

  public deleteClient(clientId: string): void {
    const cache = this.getActiveWorkspaceCache();
    cache.clients = cache.clients.filter((c) => c.id !== clientId);

    const captureContext = this.currentContext;
    this.engine.delete(V2_STORES.CLIENTS, clientId, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.CLIENTS, 'delete', err, captureContext);
    });
  }

  public toggleArchiveClient(clientId: string): Client | null {
    const cache = this.getActiveWorkspaceCache();
    const idx = cache.clients.findIndex((c) => c.id === clientId);
    if (idx === -1) return null;

    const cur = cache.clients[idx].status;
    cache.clients[idx].status = cur === 'archived' ? 'active' : 'archived';

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.CLIENTS, cache.clients[idx], captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.CLIENTS, 'put', err, captureContext);
    });

    return cache.clients[idx];
  }

  public addClientNote(clientId: string, text: string, authorName: string): ClientNote | null {
    const cache = this.getActiveWorkspaceCache();
    const idx = cache.clients.findIndex((c) => c.id === clientId);
    if (idx === -1) return null;

    const now = new Date().toISOString().replace('T', ' ').substring(0, 16);
    const note: ClientNote = {
      id: `cn-${Date.now()}`,
      text,
      authorName,
      createdAt: now,
    };

    cache.clients[idx].notes.unshift(note);

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.CLIENTS, cache.clients[idx], captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.CLIENTS, 'put', err, captureContext);
    });

    return note;
  }

  public addClientInteraction(
    clientId: string,
    interaction: Omit<ClientInteraction, 'id'>
  ): ClientInteraction | null {
    const cache = this.getActiveWorkspaceCache();
    const idx = cache.clients.findIndex((c) => c.id === clientId);
    if (idx === -1) return null;

    const newInteraction: ClientInteraction = {
      ...interaction,
      id: `ci-${Date.now()}`,
    };

    cache.clients[idx].interactions.unshift(newInteraction);
    cache.clients[idx].lastInteraction = interaction.date;

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.CLIENTS, cache.clients[idx], captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.CLIENTS, 'put', err, captureContext);
    });

    return newInteraction;
  }

  // --- Transactions ---

  public getTransactions(): Transaction[] {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return [];
    return this.getActiveWorkspaceCache().transactions;
  }

  public setTransactions(transactions: Transaction[]): void {
    const cache = this.getActiveWorkspaceCache();
    cache.transactions = [...transactions];

    const captureContext = this.currentContext;
    this.engine.setAll(V2_STORES.TRANSACTIONS, transactions, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.TRANSACTIONS, 'setAll', err, captureContext);
    });
  }

  public saveTransaction(tx: Omit<Transaction, 'id' | 'createdAt'> & { id?: string }): Transaction {
    const cache = this.getActiveWorkspaceCache();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 16);

    let saved: Transaction;
    if (tx.id) {
      const idx = cache.transactions.findIndex((t) => t.id === tx.id);
      if (idx !== -1) {
        saved = { ...cache.transactions[idx], ...tx };
        cache.transactions[idx] = saved;
      } else {
        saved = { ...tx, id: tx.id, createdAt: now } as Transaction;
        cache.transactions.unshift(saved);
      }
    } else {
      const id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      saved = {
        ...tx,
        id,
        createdAt: now,
      };
      cache.transactions.unshift(saved);
    }

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.TRANSACTIONS, saved, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.TRANSACTIONS, 'put', err, captureContext);
    });

    return saved;
  }

  public deleteTransaction(txId: string): void {
    const cache = this.getActiveWorkspaceCache();
    cache.transactions = cache.transactions.filter((t) => t.id !== txId);

    const captureContext = this.currentContext;
    this.engine.delete(V2_STORES.TRANSACTIONS, txId, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.TRANSACTIONS, 'delete', err, captureContext);
    });
  }

  // --- Strategy Module ---

  public getStrategyMission(): TeamMission {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return { ...INITIAL_MISSION };
    return this.getActiveWorkspaceCache().mission;
  }

  public saveStrategyMission(mission: TeamMission): TeamMission {
    const cache = this.getActiveWorkspaceCache();
    cache.mission = mission;

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.MISSION, { ...mission, id: 'current' }, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.MISSION, 'put', err, captureContext);
    });

    return mission;
  }

  public getStrategyVision(): TeamVision {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return { ...INITIAL_VISION };
    return this.getActiveWorkspaceCache().vision;
  }

  public saveStrategyVision(vision: TeamVision): TeamVision {
    const cache = this.getActiveWorkspaceCache();
    cache.vision = vision;

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.VISION, { ...vision, id: 'current' }, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.VISION, 'put', err, captureContext);
    });

    return vision;
  }

  public getStrategicGoals(): StrategicGoal[] {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return [];
    return this.getActiveWorkspaceCache().goals;
  }

  public saveStrategicGoal(
    goal: Omit<StrategicGoal, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ): StrategicGoal {
    const cache = this.getActiveWorkspaceCache();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 16);

    let saved: StrategicGoal;
    if (goal.id) {
      const idx = cache.goals.findIndex((g) => g.id === goal.id);
      if (idx !== -1) {
        saved = { ...cache.goals[idx], ...goal, updatedAt: now };
        cache.goals[idx] = saved;
      } else {
        saved = { ...goal, id: goal.id, createdAt: now, updatedAt: now } as StrategicGoal;
        cache.goals.unshift(saved);
      }
    } else {
      const id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      saved = {
        ...goal,
        id,
        createdAt: now,
        updatedAt: now,
      };
      cache.goals.unshift(saved);
    }

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.GOALS, saved, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.GOALS, 'put', err, captureContext);
    });

    return saved;
  }

  public deleteStrategicGoal(goalId: string): void {
    const cache = this.getActiveWorkspaceCache();
    cache.goals = cache.goals.filter((g) => g.id !== goalId);

    const captureContext = this.currentContext;
    this.engine.delete(V2_STORES.GOALS, goalId, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.GOALS, 'delete', err, captureContext);
    });
  }

  public getStrategicPriorities(): StrategicPriority[] {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return [];
    return this.getActiveWorkspaceCache().priorities;
  }

  public saveStrategicPriority(
    priority: Omit<StrategicPriority, 'id'> & { id?: string }
  ): StrategicPriority {
    const cache = this.getActiveWorkspaceCache();
    let saved: StrategicPriority;

    if (priority.id) {
      const idx = cache.priorities.findIndex((p) => p.id === priority.id);
      if (idx !== -1) {
        saved = { ...cache.priorities[idx], ...priority };
        cache.priorities[idx] = saved;
      } else {
        saved = { ...priority, id: priority.id, order: cache.priorities.length + 1 } as StrategicPriority;
        cache.priorities.push(saved);
      }
    } else {
      const id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      saved = {
        ...priority,
        id,
        order: cache.priorities.length + 1,
      };
      cache.priorities.push(saved);
    }

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.PRIORITIES, saved, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.PRIORITIES, 'put', err, captureContext);
    });

    return saved;
  }

  public deleteStrategicPriority(priorityId: string): void {
    const cache = this.getActiveWorkspaceCache();
    cache.priorities = cache.priorities.filter((p) => p.id !== priorityId);

    const captureContext = this.currentContext;
    this.engine.delete(V2_STORES.PRIORITIES, priorityId, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.PRIORITIES, 'delete', err, captureContext);
    });
  }

  public getDevelopmentPlan(): DevelopmentPlanItem[] {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return [];
    return this.getActiveWorkspaceCache().plan;
  }

  public saveDevelopmentPlanItem(
    item: Omit<DevelopmentPlanItem, 'id'> & { id?: string }
  ): DevelopmentPlanItem {
    const cache = this.getActiveWorkspaceCache();
    let saved: DevelopmentPlanItem;

    if (item.id) {
      const idx = cache.plan.findIndex((p) => p.id === item.id);
      if (idx !== -1) {
        saved = { ...cache.plan[idx], ...item };
        cache.plan[idx] = saved;
      } else {
        saved = { ...item, id: item.id, order: cache.plan.length + 1 } as DevelopmentPlanItem;
        cache.plan.push(saved);
      }
    } else {
      const id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      saved = {
        ...item,
        id,
        order: cache.plan.length + 1,
      };
      cache.plan.push(saved);
    }

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.PLANS, saved, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.PLANS, 'put', err, captureContext);
    });

    return saved;
  }

  public deleteDevelopmentPlanItem(itemId: string): void {
    const cache = this.getActiveWorkspaceCache();
    cache.plan = cache.plan.filter((p) => p.id !== itemId);

    const captureContext = this.currentContext;
    this.engine.delete(V2_STORES.PLANS, itemId, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.PLANS, 'delete', err, captureContext);
    });
  }

  // --- Settings ---

  public getSettings(): WorkspaceSettings {
    if (this.currentContext.isGuest || !this.currentContext.workspaceId) return { ...INITIAL_SETTINGS };
    return this.getActiveWorkspaceCache().settings;
  }

  public updateSettings(settings: Partial<WorkspaceSettings>): WorkspaceSettings {
    const cache = this.getActiveWorkspaceCache();
    const updated: WorkspaceSettings = {
      ...cache.settings,
      ...settings,
    };
    cache.settings = updated;

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.SETTINGS, { id: 'current', ...updated }, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.SETTINGS, 'put', err, captureContext);
    });

    return updated;
  }

  // --- Notifications (User-scoped) ---

  public getNotifications(): NotificationItem[] {
    if (this.currentContext.isGuest || !this.currentContext.userId) return [];
    return this.getActiveUserCache().notifications;
  }

  public saveNotification(
    notification: Omit<NotificationItem, 'id' | 'timestamp'> & { id?: string }
  ): NotificationItem {
    const cache = this.getActiveUserCache();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 16);

    if (notification.fingerprint) {
      const existing = cache.notifications.find((n) => n.fingerprint === notification.fingerprint);
      if (existing) return existing;
    }

    const newNotif: NotificationItem = {
      ...notification,
      id: notification.id || `notif-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      timestamp: now,
    };

    cache.notifications.unshift(newNotif);
    cache.notifications = cache.notifications.slice(0, 100);

    const captureContext = this.currentContext;
    this.engine.put(V2_STORES.NOTIFICATIONS, newNotif, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.NOTIFICATIONS, 'put', err, captureContext);
    });

    return newNotif;
  }

  public deleteNotification(id: string): void {
    const cache = this.getActiveUserCache();
    cache.notifications = cache.notifications.filter((n) => n.id !== id);

    const captureContext = this.currentContext;
    this.engine.delete(V2_STORES.NOTIFICATIONS, id, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.NOTIFICATIONS, 'delete', err, captureContext);
    });
  }

  public markNotificationRead(id: string): void {
    const cache = this.getActiveUserCache();
    cache.notifications = cache.notifications.map((n) => (n.id === id ? { ...n, read: true } : n));

    const item = cache.notifications.find((n) => n.id === id);
    if (item) {
      const captureContext = this.currentContext;
      this.engine.put(V2_STORES.NOTIFICATIONS, item, captureContext).catch((err) => {
        this.emitPersistenceError(V2_STORES.NOTIFICATIONS, 'put', err, captureContext);
      });
    }
  }

  public markAllNotificationsRead(): void {
    const cache = this.getActiveUserCache();
    cache.notifications = cache.notifications.map((n) => ({ ...n, read: true }));

    const captureContext = this.currentContext;
    this.engine.setAll(V2_STORES.NOTIFICATIONS, cache.notifications, captureContext).catch((err) => {
      this.emitPersistenceError(V2_STORES.NOTIFICATIONS, 'setAll', err, captureContext);
    });
  }

  // --- Reset & Bulk Operations ---

  public async resetDemoData(): Promise<void> {
    if (this.currentContext.workspaceId) {
      const cache = this.getActiveWorkspaceCache();
      cache.tasks = [];
      cache.projects = [];
      cache.clients = [];
      cache.transactions = [];
      cache.goals = [];
      cache.priorities = [];
      cache.plan = [];
      cache.members = [...INITIAL_MEMBERS];
      cache.settings = { ...INITIAL_SETTINGS };

      const captureContext = this.currentContext;
      await Promise.all([
        this.engine.clear(V2_STORES.TASKS, captureContext),
        this.engine.clear(V2_STORES.PROJECTS, captureContext),
        this.engine.clear(V2_STORES.CLIENTS, captureContext),
        this.engine.clear(V2_STORES.TRANSACTIONS, captureContext),
        this.engine.clear(V2_STORES.GOALS, captureContext),
        this.engine.clear(V2_STORES.PRIORITIES, captureContext),
        this.engine.clear(V2_STORES.PLANS, captureContext),
      ]).catch((err) => {
        this.emitPersistenceError(V2_STORES.TASKS, 'clear', err, captureContext);
      });
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('oneteam_demo_cleaned_v1');
    }
  }
}

export const storageServiceAdapter = new StorageServiceAdapter();
