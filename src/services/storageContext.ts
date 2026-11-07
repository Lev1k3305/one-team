/**
 * Storage Context & Session Generation Manager for ONE TEAM
 *
 * Provides immutable typed context tracking for the active user, active workspace,
 * and monotonic session generation. Prevents cross-session and cross-workspace data leakage
 * or race conditions by coordinating AbortControllers and providing AsyncRequestGuard.
 */

export interface StorageContext {
  readonly userId: string | null;
  readonly workspaceId: string | null;
  readonly sessionGeneration: number;
  readonly isGuest: boolean;
}

export class StaleContextError extends Error {
  constructor(message = 'Operation rejected: context generation is stale') {
    super(message);
    this.name = 'StaleContextError';
    Object.setPrototypeOf(this, StaleContextError.prototype);
  }
}

export class InvalidContextError extends Error {
  constructor(message = 'Operation rejected: context is invalid or uninitialized') {
    super(message);
    this.name = 'InvalidContextError';
    Object.setPrototypeOf(this, InvalidContextError.prototype);
  }
}

export class SessionGenerationManager {
  private static instance: SessionGenerationManager | null = null;

  private currentGeneration = 0;
  private currentContext: StorageContext;
  private controllers: Map<number, AbortController> = new Map();

  private constructor() {
    this.currentContext = {
      userId: null,
      workspaceId: null,
      sessionGeneration: 0,
      isGuest: true,
    };
    this.controllers.set(0, new AbortController());
  }

  public static getInstance(): SessionGenerationManager {
    if (!SessionGenerationManager.instance) {
      SessionGenerationManager.instance = new SessionGenerationManager();
    }
    return SessionGenerationManager.instance;
  }

  /**
   * Resets the singleton state (primarily for isolated test environments).
   */
  public static resetForTesting(): void {
    if (SessionGenerationManager.instance) {
      for (const ctrl of SessionGenerationManager.instance.controllers.values()) {
        try {
          ctrl.abort();
        } catch {
          // Ignore
        }
      }
      SessionGenerationManager.instance.controllers.clear();
    }
    SessionGenerationManager.instance = new SessionGenerationManager();
  }

  public getContext(): StorageContext {
    return this.currentContext;
  }

  public getGeneration(): number {
    return this.currentGeneration;
  }

  public isValid(context: StorageContext | null | undefined): boolean {
    if (!context) return false;
    return (
      context.sessionGeneration === this.currentGeneration &&
      context.userId === this.currentContext.userId &&
      context.workspaceId === this.currentContext.workspaceId &&
      context.isGuest === this.currentContext.isGuest
    );
  }

  public getSignalForGeneration(generation: number): AbortSignal | null {
    const ctrl = this.controllers.get(generation);
    return ctrl ? ctrl.signal : null;
  }

  public getCurrentSignal(): AbortSignal {
    let ctrl = this.controllers.get(this.currentGeneration);
    if (!ctrl) {
      ctrl = new AbortController();
      this.controllers.set(this.currentGeneration, ctrl);
    }
    return ctrl.signal;
  }

  private advanceGeneration(nextContextState: {
    userId: string | null;
    workspaceId: string | null;
    isGuest: boolean;
  }): StorageContext {
    // Abort previous generation operations
    const prevCtrl = this.controllers.get(this.currentGeneration);
    if (prevCtrl && !prevCtrl.signal.aborted) {
      try {
        prevCtrl.abort();
      } catch {
        // AbortController errors ignored
      }
    }

    // Monotonically advance generation
    this.currentGeneration += 1;
    const newCtrl = new AbortController();
    this.controllers.set(this.currentGeneration, newCtrl);

    // Clean up old controllers keeping only latest 10
    if (this.controllers.size > 10) {
      const keys = Array.from(this.controllers.keys()).sort((a, b) => a - b);
      while (keys.length > 5) {
        const oldKey = keys.shift();
        if (oldKey !== undefined && oldKey < this.currentGeneration) {
          this.controllers.delete(oldKey);
        }
      }
    }

    this.currentContext = Object.freeze({
      userId: nextContextState.userId,
      workspaceId: nextContextState.workspaceId,
      sessionGeneration: this.currentGeneration,
      isGuest: nextContextState.isGuest,
    });

    return this.currentContext;
  }

  /**
   * Transition: User logs in.
   * If the user and workspace are identical to current context, avoid unnecessary increment.
   */
  public login(userId: string, workspaceId: string | null = null): StorageContext {
    if (!userId) {
      throw new InvalidContextError('User ID is required for LOGIN transition');
    }

    if (
      !this.currentContext.isGuest &&
      this.currentContext.userId === userId &&
      this.currentContext.workspaceId === workspaceId
    ) {
      return this.currentContext;
    }

    return this.advanceGeneration({
      userId,
      workspaceId,
      isGuest: false,
    });
  }

  /**
   * Transition: User logs out.
   * If already guest without user and workspace, avoid unnecessary increment.
   */
  public logout(): StorageContext {
    if (
      this.currentContext.isGuest &&
      this.currentContext.userId === null &&
      this.currentContext.workspaceId === null
    ) {
      return this.currentContext;
    }

    return this.advanceGeneration({
      userId: null,
      workspaceId: null,
      isGuest: true,
    });
  }

  /**
   * Transition: Switch active workspace.
   * Cannot switch workspace in guest mode without authenticated user.
   */
  public switchWorkspace(workspaceId: string | null): StorageContext {
    if (this.currentContext.isGuest) {
      throw new InvalidContextError('Cannot switch workspace in guest mode without active user');
    }

    if (this.currentContext.workspaceId === workspaceId) {
      return this.currentContext;
    }

    return this.advanceGeneration({
      userId: this.currentContext.userId,
      workspaceId,
      isGuest: false,
    });
  }
}

export const sessionGenerationManager = SessionGenerationManager.getInstance();

export class AsyncRequestGuard {
  /**
   * Executes an async operation with context validation before invocation and before returning results.
   * If the context becomes stale during execution, throws StaleContextError.
   *
   * @param context Expected context to guard against.
   * @param task Callback receiving the active AbortSignal.
   * @param manager Optional SessionGenerationManager instance (defaults to singleton).
   */
  public static async run<T>(
    context: StorageContext,
    task: (signal: AbortSignal) => Promise<T>,
    manager: SessionGenerationManager = sessionGenerationManager
  ): Promise<T> {
    if (!context || typeof context !== 'object') {
      throw new InvalidContextError('Pre-check failed: Context is null or undefined');
    }

    if (!manager.isValid(context)) {
      throw new StaleContextError(
        `Pre-check failed: Context generation ${context.sessionGeneration} is no longer current (active: ${manager.getGeneration()})`
      );
    }

    const signal = manager.getSignalForGeneration(context.sessionGeneration);
    if (!signal || signal.aborted) {
      throw new StaleContextError('Operation aborted: context generation signal already aborted');
    }

    const result = await task(signal);

    if (!manager.isValid(context)) {
      throw new StaleContextError(
        `Post-check failed: Context changed during async execution (expected gen ${context.sessionGeneration}, active: ${manager.getGeneration()})`
      );
    }

    return result;
  }
}
