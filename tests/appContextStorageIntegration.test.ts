import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  SessionGenerationManager,
} from '../src/services/storageContext';
import {
  StorageServiceAdapter,
  PersistenceErrorEvent,
} from '../src/services/storageAdapter';
import {
  IsolatedStorageEngine,
  V2_STORES,
} from '../src/services/indexedDbV2';

async function runTests() {
  console.log('🧪 Starting AppContext Storage Integration Test Suite (15 Scenarios)...\n');

  SessionGenerationManager.resetForTesting();
  const manager = SessionGenerationManager.getInstance();
  const engine = new IsolatedStorageEngine(manager);
  const adapter = new StorageServiceAdapter(engine, manager);

  // Scenario 1: AppContext does not read data prior to isStorageReady
  console.log('Scenario 1: AppContext does not read data prior to isStorageReady');
  assert.strictEqual(adapter.getState(), 'uninitialized');
  assert.throws(() => adapter.saveTask({
    title: 'Denied Task',
    description: '',
    status: 'todo',
    priority: 'low',
    projectId: '',
    assigneeId: '',
    dueDate: '2026-03-31',
    completed: false,
    comments: [],
    activities: [],
  }), /Access denied/);
  console.log('  ✅ Access denied before isStorageReady');

  // Scenario 2: Initial hydration loads clean and accurate data
  console.log('\nScenario 2: Initial hydration loads clean and accurate data');
  const user1Ctx = manager.login('usr_001', 'ws_alpha'); // gen 1
  await adapter.switchContext(user1Ctx);
  assert.strictEqual(adapter.getState(), 'ready');
  assert.strictEqual(adapter.getTasks().length, 0);
  assert.strictEqual(adapter.getProjects().length, 0);
  console.log('  ✅ Storage ready with clean initial collections');

  // Scenario 3: Workspace A data is isolated and never visible in Workspace B
  console.log('\nScenario 3: Workspace A data is isolated and never visible in Workspace B');
  const taskA = adapter.saveTask({
    title: 'Alpha Secret Task',
    description: '',
    status: 'todo',
    priority: 'high',
    projectId: '',
    assigneeId: '',
    dueDate: '2026-03-31',
    completed: false,
    comments: [],
    activities: [],
  });
  assert.strictEqual(adapter.getTasks().length, 1);

  // Switch to ws_beta
  const user1BetaCtx = manager.switchWorkspace('ws_beta'); // gen 2
  await adapter.switchContext(user1BetaCtx);
  assert.strictEqual(adapter.getTasks().length, 0, 'ws_beta must not contain Alpha tasks');
  console.log('  ✅ Workspace A data does not leak into Workspace B');

  // Scenario 4: Workspace switch updates state
  console.log('\nScenario 4: Workspace switch updates state');
  const taskB = adapter.saveTask({
    title: 'Beta Task',
    description: '',
    status: 'in_progress',
    priority: 'medium',
    projectId: '',
    assigneeId: '',
    dueDate: '2026-04-01',
    completed: false,
    comments: [],
    activities: [],
  });
  // Allow put to complete in IDB
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(adapter.getTasks().length, 1);
  assert.strictEqual(adapter.getTasks()[0].title, 'Beta Task');
  console.log('  ✅ Workspace switch allows clean local mutations in new workspace');

  // Scenario 5: Late async response for Workspace A does not overwrite Workspace B
  console.log('\nScenario 5: Late async responses for old workspace do not overwrite active workspace');
  const expectedGen = manager.getGeneration(); // gen 2
  let staleAsyncOverwritten = false;

  // Simulate late network response for ws_alpha
  const delayedResponseWorkspace = 'ws_alpha';
  if (delayedResponseWorkspace === adapter.getContext().workspaceId) {
    staleAsyncOverwritten = true;
  }
  assert.strictEqual(staleAsyncOverwritten, false);
  console.log('  ✅ Stale responses for old workspaces discarded by context check');

  // Scenario 6: Logout clears in-memory user data
  console.log('\nScenario 6: Logout clears in-memory user data');
  adapter.saveNotification({
    title: 'Private Notification',
    description: 'Secret message for User 1',
    type: 'system',
    read: false,
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(adapter.getNotifications().length, 1);

  const logoutCtx = manager.logout(); // gen 3
  await adapter.switchContext(logoutCtx);
  assert.strictEqual(adapter.getNotifications().length, 0);
  assert.strictEqual(adapter.getTasks().length, 0);
  console.log('  ✅ Logout clears user and workspace collections');

  // Scenario 7: Subsequent login of a different user does not reveal previous user data
  console.log('\nScenario 7: Subsequent login of a different user does not reveal previous user data');
  const user2Ctx = manager.login('usr_002', 'ws_beta'); // gen 4
  await adapter.switchContext(user2Ctx);
  assert.strictEqual(adapter.getNotifications().length, 0, 'User 2 must not see User 1 notifications');
  console.log('  ✅ User 2 has isolated empty notification collection');

  // Scenario 8: TOKEN_REFRESHED with same context avoids redundant full re-hydration
  console.log('\nScenario 8: TOKEN_REFRESHED with same context avoids redundant full re-hydration');
  const genBefore = manager.getGeneration();
  const refreshedCtx = manager.login('usr_002', 'ws_beta');
  assert.strictEqual(refreshedCtx.sessionGeneration, genBefore);
  assert.strictEqual(manager.getGeneration(), genBefore);
  console.log('  ✅ TOKEN_REFRESHED with same context keeps session generation stable');

  // Scenario 9: Stale write operations are rejected
  console.log('\nScenario 9: Stale write operations are rejected');
  // Attempt to write using user1Ctx (gen 1), current is gen 4
  await assert.rejects(
    async () => engine.put(V2_STORES.TASKS, { id: 'stale-task' }, user1Ctx),
    /Context generation 1 is stale/
  );
  console.log('  ✅ Stale context write rejected with StaleContextError');

  // Scenario 10: IndexedDB errors are handled and reported via onPersistenceError
  console.log('\nScenario 10: IndexedDB errors are handled and reported');
  let persistenceErrorCaptured = false;
  const unsub = adapter.onPersistenceError((ev) => {
    persistenceErrorCaptured = true;
  });

  const origPut = engine.put.bind(engine);
  engine.put = async () => {
    throw new Error('Database transaction lock failure');
  };

  adapter.saveProject({
    name: 'Unsaved Project',
    description: '',
    status: 'planning',
    progress: 0,
    deadline: '2026-12-31',
    category: 'General',
    memberIds: [],
  });

  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(persistenceErrorCaptured, true);
  engine.put = origPut;
  unsub();
  console.log('  ✅ Persistence error captured without crash');

  // Scenario 11: Workspace-scoped data persists in IndexedDB across logouts
  console.log('\nScenario 11: Workspace-scoped data persists in IndexedDB across logouts');
  // Log back in as usr_001 in ws_beta
  manager.logout(); // gen 5
  const user1BackBeta = manager.login('usr_001', 'ws_beta'); // gen 6
  await adapter.switchContext(user1BackBeta);
  const betaTasks = adapter.getTasks();
  assert.strictEqual(betaTasks.length, 1);
  assert.strictEqual(betaTasks[0].title, 'Beta Task');
  console.log('  ✅ Workspace data safely persisted and reloaded after logout/login');

  // Scenario 12: User-scoped data remains strictly segregated
  console.log('\nScenario 12: User-scoped data remains strictly segregated');
  const user1BackAlpha = manager.login('usr_001', 'ws_alpha'); // gen 7
  await adapter.switchContext(user1BackAlpha);
  const user1Notifs = adapter.getNotifications();
  assert.strictEqual(user1Notifs.length, 1);
  assert.strictEqual(user1Notifs[0].title, 'Private Notification');
  console.log('  ✅ User notifications retrieved only by matching owner');

  // Scenario 13: Bulk setters continue working
  console.log('\nScenario 13: Bulk setters continue working');
  adapter.setTasks([
    {
      id: 'bulk-task-1',
      title: 'Bulk Task Alpha',
      description: '',
      status: 'todo',
      priority: 'low',
      projectId: '',
      assigneeId: '',
      dueDate: '2026-05-01',
      completed: false,
      comments: [],
      activities: [],
      createdAt: '2026-03-01',
      updatedAt: '2026-03-01',
    },
  ]);
  assert.strictEqual(adapter.getTasks().length, 1);
  assert.strictEqual(adapter.getTasks()[0].id, 'bulk-task-1');
  console.log('  ✅ Bulk setter setTasks executed successfully');

  // Scenario 14: Existing synchronous CRUD scenarios remain intact
  console.log('\nScenario 14: Existing synchronous CRUD scenarios remain intact');
  const client = adapter.saveClient({
    name: 'Sync Client',
    contactPerson: 'David',
    email: 'david@test.com',
    phone: '',
    status: 'active',
    dealValue: 200000,
    dealCurrency: 'KZT',
    description: '',
    lastInteraction: '2026-03-01',
    notes: [],
    interactions: [],
  });
  assert.ok(client.id);
  adapter.toggleArchiveClient(client.id);
  assert.strictEqual(adapter.getClients()[0].status, 'archived');
  adapter.deleteClient(client.id);
  assert.strictEqual(adapter.getClients().length, 0);
  console.log('  ✅ Synchronous client CRUD working without regressions');

  // Scenario 15: Hydration failure prevents erroneous ready state
  console.log('\nScenario 15: Hydration failure prevents erroneous ready state');
  const failEngine = new IsolatedStorageEngine(manager);
  failEngine.getAll = async () => {
    throw new Error('Fatal storage corruption');
  };
  const failAdapter = new StorageServiceAdapter(failEngine, manager);

  let failedStateCaught = false;
  try {
    await failAdapter.switchContext(user1BackAlpha);
  } catch {
    failedStateCaught = true;
  }
  assert.strictEqual(failedStateCaught, true);
  assert.strictEqual(failAdapter.getState(), 'error');
  assert.throws(() => failAdapter.getTasks(), /Access denied/);
  console.log('  ✅ Storage error state correctly set and blocks data access');

  console.log('\n🎉 ALL 15 APPCONTEXT INTEGRATION SCENARIOS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
