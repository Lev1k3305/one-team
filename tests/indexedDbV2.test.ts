import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  IsolatedStorageEngine,
  V2_STORES,
  SCOPES,
  V2_DB_NAME,
} from '../src/services/indexedDbV2';
import {
  SessionGenerationManager,
  StaleContextError,
  InvalidContextError,
} from '../src/services/storageContext';

async function runTests() {
  console.log('🧪 Starting IsolatedStorageEngine (OneTeamDB_v2) Unit Tests...\n');

  SessionGenerationManager.resetForTesting();
  const manager = SessionGenerationManager.getInstance();
  const engine = new IsolatedStorageEngine(manager);

  // Setup contexts
  const user1Ctx = manager.login('usr_001', 'ws_alpha'); // gen 1

  // Test 1: Workspace-scoped CRUD
  console.log('Test 1: Workspace-scoped CRUD in ws_alpha');
  const task = { id: 'task-1', title: 'Task in Alpha', status: 'todo' };
  const putResult = await engine.put(V2_STORES.TASKS, task, user1Ctx);
  assert.strictEqual(putResult.id, 'task-1');

  const fetchedTask = await engine.get<typeof task>(V2_STORES.TASKS, 'task-1', user1Ctx);
  assert.ok(fetchedTask, 'Task must exist');
  assert.strictEqual(fetchedTask?.title, 'Task in Alpha');
  console.log('  ✅ Workspace task put & get verified');

  // Test 2: User-scoped CRUD
  console.log('\nTest 2: User-scoped CRUD for usr_001');
  const notif = { id: 'notif-1', text: 'Hello User 1', read: false };
  await engine.put(V2_STORES.NOTIFICATIONS, notif, user1Ctx);

  const fetchedNotif = await engine.get<typeof notif>(V2_STORES.NOTIFICATIONS, 'notif-1', user1Ctx);
  assert.ok(fetchedNotif);
  assert.strictEqual(fetchedNotif?.text, 'Hello User 1');
  console.log('  ✅ User notification put & get verified');

  // Test 3: Data Isolation between two different workspaces
  console.log('\nTest 3: Data Isolation between ws_alpha and ws_beta');
  const user1BetaCtx = manager.switchWorkspace('ws_beta'); // gen 2

  // In ws_beta, task-1 from ws_alpha must NOT exist
  const taskInBeta = await engine.get(V2_STORES.TASKS, 'task-1', user1BetaCtx);
  assert.strictEqual(taskInBeta, null, 'Task from ws_alpha must NOT leak to ws_beta');

  const allBetaTasks = await engine.getAll(V2_STORES.TASKS, user1BetaCtx);
  assert.strictEqual(allBetaTasks.length, 0, 'ws_beta tasks list must be empty');

  // Put a task into ws_beta with same id 'task-1'
  const taskBeta = { id: 'task-1', title: 'Task in Beta', status: 'done' };
  await engine.put(V2_STORES.TASKS, taskBeta, user1BetaCtx);

  const fetchedBetaTask = await engine.get<typeof taskBeta>(V2_STORES.TASKS, 'task-1', user1BetaCtx);
  assert.strictEqual(fetchedBetaTask?.title, 'Task in Beta');
  console.log('  ✅ Two workspaces with same entityId do not overwrite each other');

  // Test 4: Data Isolation between two different users
  console.log('\nTest 4: Data Isolation between usr_001 and usr_002');
  const user2Ctx = manager.login('usr_002', 'ws_beta'); // gen 3

  // usr_002 should NOT see usr_001 notifications
  const notifInUser2 = await engine.get(V2_STORES.NOTIFICATIONS, 'notif-1', user2Ctx);
  assert.strictEqual(notifInUser2, null, 'usr_001 notification must NOT be visible to usr_002');

  const allUser2Notifs = await engine.getAll(V2_STORES.NOTIFICATIONS, user2Ctx);
  assert.strictEqual(allUser2Notifs.length, 0);
  console.log('  ✅ User-scoped data is strictly isolated across users');

  // Test 5: Rejection of invalid/guest context on scoped stores
  console.log('\nTest 5: Rejection of invalid/guest context');
  const guestCtx = manager.logout(); // gen 4, guest mode
  await assert.rejects(
    async () => engine.put(V2_STORES.TASKS, { id: 'task-guest' }, guestCtx),
    InvalidContextError
  );
  await assert.rejects(
    async () => engine.put(V2_STORES.NOTIFICATIONS, { id: 'notif-guest' }, guestCtx),
    InvalidContextError
  );
  console.log('  ✅ Scoped operations rejected in guest mode with InvalidContextError');

  // Test 6: Rejection of stale sessionGeneration
  console.log('\nTest 6: Rejection of stale sessionGeneration');
  // user1BetaCtx was gen 2, current is gen 4
  await assert.rejects(
    async () => engine.get(V2_STORES.TASKS, 'task-1', user1BetaCtx),
    StaleContextError
  );
  console.log('  ✅ Operations with stale session generation rejected with StaleContextError');

  // Test 7: Atomic setAll without partial writes
  console.log('\nTest 7: Atomic setAll replace');
  const authCtx = manager.login('usr_003', 'ws_gamma'); // gen 5
  const initialItems = [
    { id: 'item-1', name: 'Alpha Item' },
    { id: 'item-2', name: 'Beta Item' },
  ];
  await engine.setAll(V2_STORES.PROJECTS, initialItems, authCtx);

  let projects = await engine.getAll<any>(V2_STORES.PROJECTS, authCtx);
  assert.strictEqual(projects.length, 2);

  // Replace completely
  const replacementItems = [
    { id: 'item-3', name: 'Gamma Item' },
  ];
  await engine.setAll(V2_STORES.PROJECTS, replacementItems, authCtx);

  projects = await engine.getAll<any>(V2_STORES.PROJECTS, authCtx);
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].id, 'item-3');
  console.log('  ✅ setAll atomically replaced collection for active scope');

  // Test 8: Safe v1 archive snapshot
  console.log('\nTest 8: Safe v1 archive snapshot');
  // Seed legacy v1 database
  const v1Db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('OneTeamDB_v1', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tasks')) {
        db.createObjectStore('tasks', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = v1Db.transaction('tasks', 'readwrite');
    const store = tx.objectStore('tasks');
    store.put({ id: 'legacy-task-99', title: 'Legacy v1 Task' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  v1Db.close();

  const archiveResult = await engine.archiveV1Snapshot();
  assert.strictEqual(archiveResult.archived, true);
  assert.ok(archiveResult.recordCount >= 1);
  console.log(`  ✅ Successfully archived ${archiveResult.recordCount} legacy v1 records into v2 archive store`);

  console.log('\n🎉 ALL 8 UNIT TESTS IN tests/indexedDbV2.test.ts PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
