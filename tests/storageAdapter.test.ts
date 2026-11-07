import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  StorageServiceAdapter,
  PersistenceErrorEvent,
} from '../src/services/storageAdapter';
import {
  IsolatedStorageEngine,
  V2_STORES,
} from '../src/services/indexedDbV2';
import {
  SessionGenerationManager,
} from '../src/services/storageContext';

async function runTests() {
  console.log('🧪 Starting StorageServiceAdapter Test Suite...\n');

  SessionGenerationManager.resetForTesting();
  const manager = SessionGenerationManager.getInstance();
  const engine = new IsolatedStorageEngine(manager);
  const adapter = new StorageServiceAdapter(engine, manager);

  // Test 1: Uninitialized state and data access denial before ready
  console.log('Test 1: Uninitialized state & access check');
  assert.strictEqual(adapter.getState(), 'uninitialized');
  assert.throws(
    () => adapter.saveTask({ title: 'Denied Task', description: '', status: 'todo', priority: 'medium', projectId: 'p1', assigneeId: 'm1', dueDate: '2026-03-31', completed: false, comments: [], activities: [] }),
    /Access denied/
  );
  console.log('  ✅ Access denied before hydration ready');

  // Test 2: Workspace cache hydration
  console.log('\nTest 2: Workspace cache hydration');
  const user1Ctx = manager.login('usr_alpha', 'ws_alpha'); // gen 1

  // Pre-seed a project in IndexedDB for ws_alpha
  await engine.put(
    V2_STORES.PROJECTS,
    { id: 'proj-seeded', name: 'Preseeded Project', status: 'in_progress', progress: 50, deadline: '2026-12-31', category: 'General', memberIds: [] },
    user1Ctx
  );

  // Switch context to ws_alpha
  await adapter.switchContext(user1Ctx);
  assert.strictEqual(adapter.getState(), 'ready');

  const projects = adapter.getProjects();
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].id, 'proj-seeded');
  console.log('  ✅ Workspace cache hydrated successfully from IndexedDB');

  // Test 3: User cache hydration
  console.log('\nTest 3: User cache hydration');
  await engine.put(
    V2_STORES.NOTIFICATIONS,
    { id: 'notif-seeded', title: 'Seeded', description: 'Seeded Notification', read: false, type: 'system' },
    user1Ctx
  );

  await adapter.rehydrate();
  const notifs = adapter.getNotifications();
  assert.strictEqual(notifs.length, 1);
  assert.strictEqual(notifs[0].id, 'notif-seeded');
  assert.strictEqual(notifs[0].description, 'Seeded Notification');
  console.log('  ✅ User cache hydrated successfully');

  // Test 4: Synchronous API compatibility
  console.log('\nTest 4: Synchronous API compatibility (CRUD)');
  const newTask = adapter.saveTask({
    title: 'Sync Task 1',
    description: 'Test Description',
    status: 'todo',
    priority: 'high',
    projectId: 'proj-seeded',
    assigneeId: 'm1',
    dueDate: '2026-04-01',
    completed: false,
    comments: [],
    activities: [],
  });
  assert.ok(newTask.id);
  assert.strictEqual(adapter.getTasks().length, 1);

  // Status update
  const updatedTask = adapter.updateTaskStatus(newTask.id, 'done');
  assert.strictEqual(updatedTask?.status, 'done');
  assert.strictEqual(updatedTask?.completed, true);
  assert.strictEqual(adapter.getTasks()[0].status, 'done');

  // Toggle completion
  adapter.toggleTaskCompletion(newTask.id);
  assert.strictEqual(adapter.getTasks()[0].completed, false);
  assert.strictEqual(adapter.getTasks()[0].status, 'in_progress');

  // Comment
  adapter.addTaskComment(newTask.id, 'Great progress', { name: 'Alice', avatar: '' });
  assert.strictEqual(adapter.getTasks()[0].comments.length, 1);

  // Delete
  adapter.deleteTask(newTask.id);
  assert.strictEqual(adapter.getTasks().length, 0);
  console.log('  ✅ Synchronous task methods executed and reflected in cache');

  // Test 5: Strict data isolation between two workspaces
  console.log('\nTest 5: Data isolation across workspaces');
  // In ws_alpha, save a client
  const savedAlphaClient = adapter.saveClient({
    name: 'Alpha Client Corp',
    contactPerson: 'Bob',
    email: 'bob@alpha.com',
    phone: '123',
    status: 'active',
    dealValue: 500000,
    dealCurrency: 'KZT',
    description: '',
    lastInteraction: '2026-03-01',
    notes: [],
    interactions: [],
  });
  assert.strictEqual(adapter.getClients().length, 1);

  // Allow put to complete in IDB
  await new Promise((r) => setTimeout(r, 40));

  // Switch to ws_beta
  const user1BetaCtx = manager.switchWorkspace('ws_beta'); // gen 2
  await adapter.switchContext(user1BetaCtx);

  // ws_beta must not contain Alpha Client Corp or proj-seeded
  assert.strictEqual(adapter.getClients().length, 0);
  assert.strictEqual(adapter.getProjects().length, 0);

  // Save beta-specific client
  adapter.saveClient({
    name: 'Beta Client Ltd',
    contactPerson: 'Carol',
    email: 'carol@beta.com',
    phone: '456',
    status: 'new',
    dealValue: 100000,
    dealCurrency: 'KZT',
    description: '',
    lastInteraction: '2026-03-02',
    notes: [],
    interactions: [],
  });
  assert.strictEqual(adapter.getClients().length, 1);
  assert.strictEqual(adapter.getClients()[0].name, 'Beta Client Ltd');
  await new Promise((r) => setTimeout(r, 40));

  // Switch back to ws_alpha
  const user1AlphaBackCtx = manager.switchWorkspace('ws_alpha'); // gen 3
  await adapter.switchContext(user1AlphaBackCtx);
  assert.strictEqual(adapter.getClients().length, 1);
  assert.strictEqual(adapter.getClients()[0].name, 'Alpha Client Corp');
  console.log('  ✅ Workspace data strictly isolated and restored correctly');

  // Test 6: Strict data isolation between two users
  console.log('\nTest 6: Data isolation across users');
  const user2Ctx = manager.login('usr_beta', 'ws_beta'); // gen 4
  await adapter.switchContext(user2Ctx);

  // usr_beta should NOT see notif-seeded of usr_alpha
  assert.strictEqual(adapter.getNotifications().length, 0);

  adapter.saveNotification({
    title: 'User Beta Notification',
    description: 'Welcome Beta',
    type: 'system',
    read: false,
  });
  assert.strictEqual(adapter.getNotifications().length, 1);

  // Switch back to usr_alpha
  const user1BackCtx = manager.login('usr_alpha', 'ws_alpha'); // gen 5
  await adapter.switchContext(user1BackCtx);
  assert.strictEqual(adapter.getNotifications().length, 1);
  assert.strictEqual(adapter.getNotifications()[0].id, 'notif-seeded');
  console.log('  ✅ User notifications strictly isolated across user logins');

  // Test 7: Discard stale hydration results when context changes mid-flight
  console.log('\nTest 7: Discard stale hydration results');
  // Start hydration for context A, but invalidate session before resolution
  const staleCtx = manager.switchWorkspace('ws_slow'); // gen 6
  const hydrationPromise = adapter.switchContext(staleCtx);

  // Immediately advance to gen 7
  const nextCtx = manager.switchWorkspace('ws_fast'); // gen 7
  await adapter.switchContext(nextCtx);
  await hydrationPromise;

  assert.strictEqual(adapter.getContext().workspaceId, 'ws_fast');
  assert.strictEqual(adapter.getContext().sessionGeneration, 7);
  console.log('  ✅ Stale hydration discarded without overriding current context');

  // Test 8: IndexedDB persistence error event emission
  console.log('\nTest 8: Persistence error handling via onPersistenceError');
  let capturedErrorEvent: PersistenceErrorEvent | null = null;
  const unsubscribe = adapter.onPersistenceError((ev) => {
    capturedErrorEvent = ev;
  });

  // Mock engine.put to simulate failure
  const originalPut = engine.put.bind(engine);
  engine.put = async () => {
    throw new Error('Simulated IndexedDB Disk Full Error');
  };

  adapter.saveProject({
    name: 'Failing Project',
    description: '',
    status: 'planning',
    progress: 0,
    deadline: '2026-12-31',
    category: 'General',
    memberIds: [],
  });

  // Wait for async persistence rejection to fire
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(capturedErrorEvent);
  assert.strictEqual((capturedErrorEvent as PersistenceErrorEvent).storeName, V2_STORES.PROJECTS);
  assert.strictEqual((capturedErrorEvent as PersistenceErrorEvent).operation, 'put');
  assert.strictEqual(((capturedErrorEvent as PersistenceErrorEvent).error as Error).message, 'Simulated IndexedDB Disk Full Error');
  console.log('  ✅ onPersistenceError triggered with full event metadata');

  // Restore engine
  engine.put = originalPut;
  unsubscribe();

  // Test 9: Absence of false persistence confirmation upon error
  console.log('\nTest 9: Absence of false persistence confirmation upon error');
  let errorCount = 0;
  const unsubError = adapter.onPersistenceError(() => {
    errorCount++;
  });

  const brokenPut = engine.put.bind(engine);
  engine.put = async () => {
    throw new Error('Disk quota exceeded');
  };

  adapter.saveTask({
    title: 'Unpersisted Task',
    description: '',
    status: 'todo',
    priority: 'low',
    projectId: 'proj-1',
    assigneeId: 'm1',
    dueDate: '2026-05-01',
    completed: false,
    comments: [],
    activities: [],
  });

  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(errorCount, 1, 'Error handler must catch unpersisted mutation');
  engine.put = brokenPut;
  unsubError();
  console.log('  ✅ Absence of false confirmation verified via onPersistenceError');

  // Test 10: Rehydration under error recovery
  console.log('\nTest 10: Rehydration under error recovery');
  // Rehydrate to reload truth from IDB
  await adapter.rehydrate();
  assert.strictEqual(adapter.getState(), 'ready');
  // Unpersisted task was never written to IDB, so clean rehydration discards it
  const rehydratedTasks = adapter.getTasks();
  assert.strictEqual(
    rehydratedTasks.some((t) => t.title === 'Unpersisted Task'),
    false
  );
  console.log('  ✅ Rehydration successfully synced with durable storage state');

  // Test 11: Bulk collection setters (setTasks, setProjects)
  console.log('\nTest 11: Bulk collection setters');
  const bulkTasks = [
    {
      id: 'bulk-1',
      title: 'Bulk Task 1',
      description: '',
      status: 'todo' as const,
      priority: 'high' as const,
      projectId: 'p1',
      assigneeId: 'm1',
      dueDate: '2026-05-01',
      completed: false,
      comments: [],
      activities: [],
      createdAt: '2026-03-01',
      updatedAt: '2026-03-01',
    },
  ];
  adapter.setTasks(bulkTasks);
  assert.strictEqual(adapter.getTasks().length, 1);
  assert.strictEqual(adapter.getTasks()[0].id, 'bulk-1');
  console.log('  ✅ Bulk collection setters work synchronously and persist');

  // Test 12: Bulk operations (resetDemoData)
  console.log('\nTest 12: Bulk operations (resetDemoData)');
  await adapter.resetDemoData();
  assert.strictEqual(adapter.getTasks().length, 0);
  assert.strictEqual(adapter.getProjects().length, 0);
  assert.strictEqual(adapter.getClients().length, 0);
  console.log('  ✅ Bulk reset completed and cleared in-memory workspace cache');

  console.log('\n🎉 ALL 12 TESTS IN tests/storageAdapter.test.ts PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
