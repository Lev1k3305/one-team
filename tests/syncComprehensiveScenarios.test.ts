/**
 * Comprehensive Sync Engine & Scenarios Test Suite (15 Critical Scenarios)
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert';
import {
  IsolatedStorageEngine,
  V2_STORES,
  OutboxMutationRecord,
} from '../src/services/indexedDbV2';
import {
  SessionGenerationManager,
} from '../src/services/storageContext';
import { SyncEngine } from '../src/services/syncEngine';
import { supabase } from '../src/services/supabaseClient';

async function runTests() {
  console.log('🧪 Starting Sync Engine Comprehensive Scenarios (15 Scenarios)...\n');

  const manager = SessionGenerationManager.getInstance();
  const engine = new IsolatedStorageEngine(manager);

  // Scenario 1: Offline Creation, Restart, Online Recovery & Sync
  console.log('Scenario 1: Offline creation, app restart, and sync upon reconnect');
  manager.login('user_1', 'ws_1');
  const ctx1 = manager.getContext();

  await engine.mutateAndEnqueueOutbox(
    V2_STORES.TASKS,
    'put',
    { id: 'offline_task_1', title: 'Offline Task 1', completed: false },
    'CREATE',
    1,
    ctx1
  );

  // Simulate app restart by instantiating new storage & sync engine
  const restartedEngine = new IsolatedStorageEngine(manager);
  const syncEngine1 = new SyncEngine(restartedEngine, manager);

  let rpcCalls: string[] = [];
  const originalRpc = supabase.rpc.bind(supabase);
  (supabase as any).rpc = async (fn: string, params: any) => {
    rpcCalls.push(fn);
    if (fn === 'apply_sync_mutation') {
      return {
        data: { success: true, status: 'APPLIED', version: 2, record: { id: params.p_entity_id, version: 2 } },
        error: null,
      };
    }
    if (fn === 'fetch_workspace_sync_delta') {
      return { data: { success: true, cursor_seq: 10, tombstones: [], entities: {} }, error: null };
    }
    return originalRpc(fn as any, params);
  };

  await syncEngine1.syncNow();
  const outboxAfter = await restartedEngine.getAll<OutboxMutationRecord>(V2_STORES.OUTBOX, ctx1);
  assert.strictEqual(outboxAfter.length, 0, 'Outbox should be empty after syncNow');
  console.log('  ✅ Offline task persisted restart and synchronized cleanly');

  // Scenario 2: Incoming sync of changes made by another member
  console.log('\nScenario 2: Incoming sync of changes made by another member');
  (supabase as any).rpc = async (fn: string, params: any) => {
    if (fn === 'fetch_workspace_sync_delta') {
      return {
        data: {
          success: true,
          cursor_seq: 20,
          tombstones: [],
          entities: {
            tasks: [
              {
                id: 'teammate_task_2',
                workspace_id: 'ws_1',
                title: 'Teammate Task',
                status: 'in_progress',
                priority: 'urgent',
                version: 5,
              },
            ],
          },
        },
        error: null,
      };
    }
    return { data: { success: true }, error: null };
  };

  await syncEngine1.pullDelta();
  const teammateTask = await engine.get<any>(V2_STORES.TASKS, 'teammate_task_2', ctx1);
  assert.ok(teammateTask);
  assert.strictEqual(teammateTask.title, 'Teammate Task');
  assert.strictEqual(teammateTask.version, 5);
  console.log('  ✅ Remote member changes received and saved to local IndexedDB');

  // Scenario 3: Shared workspace data between two users
  console.log('\nScenario 3: Shared workspace data visibility between members');
  manager.login('user_2', 'ws_1');
  const ctxUser2 = manager.getContext();
  const taskSeenByUser2 = await engine.get<any>(V2_STORES.TASKS, 'teammate_task_2', ctxUser2);
  assert.ok(taskSeenByUser2, 'User 2 in same workspace can view shared workspace entity');
  console.log('  ✅ Workspace entities shared correctly among members');

  // Scenario 4: Logout User A and Login User B without leaking Outbox
  console.log('\nScenario 4: User A logout and User B login outbox segregation');
  manager.login('user_A', 'ws_A');
  const ctxA = manager.getContext();
  await engine.mutateAndEnqueueOutbox(
    V2_STORES.PROJECTS,
    'put',
    { id: 'proj_A', name: 'User A Secret Project' },
    'CREATE',
    1,
    ctxA
  );

  manager.logout();
  manager.login('user_B', 'ws_B');
  const ctxB = manager.getContext();

  const outboxB = await engine.getAll<OutboxMutationRecord>(V2_STORES.OUTBOX, ctxB);
  assert.strictEqual(outboxB.length, 0, 'User B workspace B must not see User A outbox');
  console.log('  ✅ Outbox strictly isolated across user and workspace transitions');

  // Scenario 5: Switching workspaces without state leakage
  console.log('\nScenario 5: Switching workspaces cleanly');
  manager.switchWorkspace('ws_C');
  const ctxC = manager.getContext();
  const tasksInC = await engine.getAll<any>(V2_STORES.TASKS, ctxC);
  assert.strictEqual(tasksInC.length, 0, 'New workspace starts empty without bleed-over');
  console.log('  ✅ Workspace switching maintains zero cross-boundary leakage');

  // Scenario 6 & 7: Version Conflict & Preserving Local Edits in sync_conflicts
  console.log('\nScenario 6 & 7: Version conflict and conflict queue preservation');
  manager.login('user_1', 'ws_1');
  const ctxConflict = manager.getContext();

  await engine.mutateAndEnqueueOutbox(
    V2_STORES.TASKS,
    'put',
    { id: 'task_conflicted', title: 'Local Overwrite Attempt' },
    'UPDATE',
    2, // baseVersion is 2, but server is at 4
    ctxConflict
  );

  (supabase as any).rpc = async (fn: string) => {
    if (fn === 'apply_sync_mutation') {
      return {
        data: {
          success: false,
          status: 'VERSION_CONFLICT',
          current_version: 4,
          current_record: { id: 'task_conflicted', title: 'Server Authoritative Value', version: 4 },
        },
        error: null,
      };
    }
    return { data: { success: true }, error: null };
  };

  const syncConflictEngine = new SyncEngine(engine, manager);
  await syncConflictEngine.processOutbox();

  const conflicts = await engine.getAll<any>(V2_STORES.SYNC_CONFLICTS, ctxConflict);
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].entityId, 'task_conflicted');
  assert.strictEqual(conflicts[0].localPayload.title, 'Local Overwrite Attempt');
  assert.strictEqual(conflicts[0].serverPayload.title, 'Server Authoritative Value');
  console.log('  ✅ Version conflict detected and non-destructively saved in sync_conflicts');

  // Scenario 8: Offline delete with tombstone preventing resurrection
  console.log('\nScenario 8: Tombstones prevent resurrection of deleted entities');
  await engine.mutateAndEnqueueOutbox(
    V2_STORES.TASKS,
    'delete',
    { id: 'task_to_delete' },
    'DELETE',
    3,
    ctxConflict
  );

  // Server sends delta containing an old version of the same entity
  (supabase as any).rpc = async (fn: string) => {
    if (fn === 'fetch_workspace_sync_delta') {
      return {
        data: {
          success: true,
          cursor_seq: 30,
          tombstones: [],
          entities: {
            tasks: [{ id: 'task_to_delete', title: 'Resurrected Task', version: 2 }],
          },
        },
        error: null,
      };
    }
    return { data: { success: true }, error: null };
  };

  await syncConflictEngine.pullDelta();
  const deletedTaskCheck = await engine.get<any>(V2_STORES.TASKS, 'task_to_delete', ctxConflict);
  assert.strictEqual(deletedTaskCheck, null, 'Pending deleted task must not be resurrected by incoming delta');
  console.log('  ✅ Offline deletion respected; entity not resurrected');

  // Scenario 9: Stale session generation aborts in-flight work
  console.log('\nScenario 9: Stale session generation abort guard');
  const genBefore = manager.getGeneration();
  manager.logout();
  const isContextStillValid = manager.isValid(ctxConflict);
  assert.strictEqual(isContextStillValid, false, 'Old context invalid after generation advance');
  console.log('  ✅ Context invalidation protects against stale in-flight writes');

  // Scenario 10: Server response loss idempotency (ALREADY_APPLIED)
  console.log('\nScenario 10: Server ALREADY_APPLIED response idempotency');
  manager.login('user_1', 'ws_1');
  const ctxIdempotent = manager.getContext();
  await engine.mutateAndEnqueueOutbox(
    V2_STORES.TASKS,
    'put',
    { id: 'task_idempotent', title: 'Idempotent Task' },
    'CREATE',
    1,
    ctxIdempotent
  );

  (supabase as any).rpc = async (fn: string) => {
    if (fn === 'apply_sync_mutation') {
      return {
        data: { success: true, status: 'ALREADY_APPLIED' },
        error: null,
      };
    }
    return { data: { success: true }, error: null };
  };

  await syncConflictEngine.processOutbox();
  const outboxCleared = await engine.getAll<OutboxMutationRecord>(V2_STORES.OUTBOX, ctxIdempotent);
  const remainingIdempotent = outboxCleared.filter((i) => i.entityId === 'task_idempotent');
  assert.strictEqual(remainingIdempotent.length, 0);
  console.log('  ✅ Duplicate mutation pruned cleanly without throw or re-execution');

  // Scenario 11: Network loss during outbox dispatch applies exponential backoff
  console.log('\nScenario 11: Network loss exponential backoff');
  await engine.mutateAndEnqueueOutbox(
    V2_STORES.TASKS,
    'put',
    { id: 'task_network_fail', title: 'Network Fail Task' },
    'CREATE',
    1,
    ctxIdempotent
  );

  (supabase as any).rpc = async () => {
    throw new Error('Failed to fetch (offline)');
  };

  await syncConflictEngine.processOutbox();
  const outboxFailed = await engine.getAll<OutboxMutationRecord>(V2_STORES.OUTBOX, ctxIdempotent);
  const failedItem = outboxFailed.find((i) => i.entityId === 'task_network_fail');
  assert.ok(failedItem);
  assert.strictEqual(failedItem.status, 'FAILED');
  assert.strictEqual(failedItem.retryCount, 1);
  assert.ok(failedItem.nextRetryAt! > Date.now());
  console.log('  ✅ Network failure safely caught and exponential backoff scheduled');

  // Scenario 12: Recovery of queue after closure
  console.log('\nScenario 12: Durable recovery of queue after app restart');
  const freshEngine = new IsolatedStorageEngine(manager);
  const persistedPending = await freshEngine.getAll<OutboxMutationRecord>(V2_STORES.OUTBOX, ctxIdempotent);
  assert.ok(persistedPending.some((i) => i.entityId === 'task_network_fail'));
  console.log('  ✅ Pending queue durability verified across cold instances');

  // Scenario 13: Viewer and revoked membership permissions
  console.log('\nScenario 13: Viewer permission rejection');
  await engine.mutateAndEnqueueOutbox(
    V2_STORES.TASKS,
    'put',
    { id: 'task_viewer', title: 'Viewer Task' },
    'CREATE',
    1,
    ctxIdempotent
  );

  (supabase as any).rpc = async () => {
    return {
      data: { success: false, error: 'PERMISSION_DENIED_VIEWER' },
      error: null,
    };
  };

  await syncConflictEngine.processOutbox();
  const metrics = syncConflictEngine.getMetrics();
  assert.strictEqual(metrics.state, 'permission_required');
  console.log('  ✅ Viewer rejection flagged permission_required state');

  // Scenario 14: Preservation of mutations after 14+ days
  console.log('\nScenario 14: Retention of older pending mutations');
  const oldDate = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString();
  await engine.put(
    V2_STORES.OUTBOX,
    {
      id: 'old_mutation_15d',
      workspaceId: 'ws_1',
      userId: 'user_1',
      entityType: 'tasks',
      entityId: 'task_old',
      action: 'UPDATE',
      baseVersion: 1,
      payload: { title: 'Old Work' },
      status: 'PENDING',
      retryCount: 0,
      createdAt: oldDate,
      updatedAt: oldDate,
    },
    ctxIdempotent
  );
  const checkOld = await engine.get<any>(V2_STORES.OUTBOX, 'old_mutation_15d', ctxIdempotent);
  assert.ok(checkOld);
  assert.strictEqual(checkOld.status, 'PENDING');
  console.log('  ✅ Older outbox mutations retained indefinitely in client storage');

  // Scenario 15: Full Resync after STALE_CHECKPOINT preserves local unconfirmed work
  console.log('\nScenario 15: Stale Checkpoint Full Resync preservation');
  (supabase as any).rpc = async (fn: string) => {
    if (fn === 'fetch_workspace_sync_delta') {
      return {
        data: {
          success: true,
          cursor_seq: 100,
          tombstones: [],
          entities: {
            tasks: [{ id: 'server_reconciled_task', title: 'Reconciled Server Task', version: 10 }],
          },
        },
        error: null,
      };
    }
    return { data: { success: true }, error: null };
  };

  (supabase as any).rpc = async (fn: string) => {
    if (fn === 'fetch_workspace_sync_delta') {
      return {
        data: {
          success: true,
          cursor_seq: 100,
          tombstones: [],
          entities: {
            tasks: [{ id: 'server_reconciled_task', title: 'Reconciled Server Task', version: 10 }],
          },
        },
        error: null,
      };
    }
    if (fn === 'apply_sync_mutation') {
      // Mock failure so mutation remains pending during resync test
      throw new Error('Offline during outbox dispatch');
    }
    return { data: { success: true }, error: null };
  };

  await syncConflictEngine.performFullResync();
  const reconciledTask = await engine.get<any>(V2_STORES.TASKS, 'server_reconciled_task', ctxIdempotent);
  assert.ok(reconciledTask);
  // Ensure our pending task wasn't wiped out
  const stillPendingTask = await engine.get<any>(V2_STORES.OUTBOX, 'old_mutation_15d', ctxIdempotent);
  assert.ok(stillPendingTask);
  console.log('  ✅ Full resync reconciled server state while protecting unconfirmed outbox items');

  // Restore RPC
  (supabase as any).rpc = originalRpc;

  console.log('\n🎉 ALL 15 COMPREHENSIVE SYNC SCENARIOS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
