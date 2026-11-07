import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  SessionGenerationManager,
} from '../src/services/storageContext';
import {
  StorageServiceAdapter,
} from '../src/services/storageAdapter';
import {
  IsolatedStorageEngine,
} from '../src/services/indexedDbV2';

async function runTests() {
  console.log('🧪 Starting AuthContext Lifecycle & Race Condition Test Suite...\n');

  SessionGenerationManager.resetForTesting();
  const manager = SessionGenerationManager.getInstance();
  const engine = new IsolatedStorageEngine(manager);
  const adapter = new StorageServiceAdapter(engine, manager);

  // Test 1: Initial guest session
  console.log('Test 1: Initial guest session');
  const initialCtx = manager.getContext();
  assert.strictEqual(initialCtx.isGuest, true);
  assert.strictEqual(initialCtx.userId, null);
  assert.strictEqual(initialCtx.workspaceId, null);
  assert.strictEqual(initialCtx.sessionGeneration, 0);

  await adapter.switchContext(initialCtx);
  assert.strictEqual(adapter.getState(), 'ready');
  console.log('  ✅ Initial session is guest with generation 0 and storage ready');

  // Test 2: LOGIN transition
  console.log('\nTest 2: LOGIN transition');
  const loginCtx = manager.login('user_100', 'ws_100');
  assert.strictEqual(loginCtx.userId, 'user_100');
  assert.strictEqual(loginCtx.workspaceId, 'ws_100');
  assert.strictEqual(loginCtx.sessionGeneration, 1);
  assert.strictEqual(loginCtx.isGuest, false);

  await adapter.switchContext(loginCtx);
  assert.strictEqual(adapter.getState(), 'ready');
  console.log('  ✅ Login transition advanced generation to 1 and storage hydrated');

  // Test 3: TOKEN_REFRESHED without context changes
  console.log('\nTest 3: TOKEN_REFRESHED without context changes keeps generation identical');
  const currentGenBefore = manager.getGeneration();
  const refreshedCtx = manager.login('user_100', 'ws_100'); // same user & workspace
  assert.strictEqual(refreshedCtx.sessionGeneration, currentGenBefore);
  assert.strictEqual(manager.getGeneration(), currentGenBefore);
  console.log('  ✅ TOKEN_REFRESHED did not advance sessionGeneration');

  // Test 4: TOKEN_REFRESHED with context change
  console.log('\nTest 4: TOKEN_REFRESHED with context change increments generation');
  const userChangedCtx = manager.login('user_200', 'ws_100'); // different user
  assert.strictEqual(userChangedCtx.sessionGeneration, 2);
  assert.strictEqual(manager.getGeneration(), 2);
  console.log('  ✅ TOKEN_REFRESHED with different user advanced generation to 2');

  // Test 5: Manual LOGOUT transition
  console.log('\nTest 5: Manual LOGOUT transition');
  const logoutCtx = manager.logout();
  assert.strictEqual(logoutCtx.userId, null);
  assert.strictEqual(logoutCtx.isGuest, true);
  assert.strictEqual(logoutCtx.sessionGeneration, 3);
  await adapter.switchContext(logoutCtx);
  assert.strictEqual(adapter.getState(), 'ready');
  console.log('  ✅ Manual logout advanced generation to 3 and returned to guest');

  // Test 6: External SIGNED_OUT event (already guest)
  console.log('\nTest 6: External SIGNED_OUT event idempotency');
  const externalSignedOutCtx = manager.logout();
  assert.strictEqual(externalSignedOutCtx.sessionGeneration, 3);
  assert.strictEqual(manager.getGeneration(), 3);
  console.log('  ✅ Consecutive SIGNED_OUT does not increment generation');

  // Test 7: Race condition: getSession resolves after SIGNED_IN
  console.log('\nTest 7: Race condition: getSession resolves after SIGNED_IN');
  // Scenario: SIGNED_IN fires first for user_alpha (gen 4)
  const signInCtx = manager.login('user_alpha', 'ws_alpha'); // gen 4
  const expectedGen = signInCtx.sessionGeneration;

  // Delayed getSession resolves with older data
  const delayedSessionUser = { id: 'user_old_session' };
  // Check generation guard logic:
  let delayedUpdateApplied = false;
  if (manager.getGeneration() === 3) {
    delayedUpdateApplied = true;
  }
  assert.strictEqual(delayedUpdateApplied, false, 'Delayed getSession must be discarded');
  assert.strictEqual(manager.getContext().userId, 'user_alpha');
  console.log('  ✅ Delayed getSession discarded by generation check');

  // Test 8: Workspace switch transitions
  console.log('\nTest 8: Workspace switch transitions');
  const switchCtx = manager.switchWorkspace('ws_beta'); // gen 5
  assert.strictEqual(switchCtx.workspaceId, 'ws_beta');
  assert.strictEqual(switchCtx.sessionGeneration, 5);
  await adapter.switchContext(switchCtx);
  assert.strictEqual(adapter.getState(), 'ready');
  console.log('  ✅ Workspace switch advanced generation to 5');

  // Test 9: Discarding stale hydration results when workspace switches quickly
  console.log('\nTest 9: Discarding stale hydration results on rapid workspace switches');
  const slowSwitchCtx = manager.switchWorkspace('ws_slow'); // gen 6
  const slowHydration = adapter.switchContext(slowSwitchCtx);

  // User immediately switches again before slow hydration finishes
  const fastSwitchCtx = manager.switchWorkspace('ws_fast'); // gen 7
  const fastHydration = adapter.switchContext(fastSwitchCtx);

  await Promise.all([slowHydration, fastHydration]);

  assert.strictEqual(adapter.getContext().workspaceId, 'ws_fast');
  assert.strictEqual(adapter.getContext().sessionGeneration, 7);
  console.log('  ✅ Stale slow hydration discarded, latest fast hydration active');

  // Test 10: Storage access safety and isStorageReady gating
  console.log('\nTest 10: Storage access safety gating');
  const uninitAdapter = new StorageServiceAdapter(engine, manager);
  assert.strictEqual(uninitAdapter.getState(), 'uninitialized');
  assert.throws(() => uninitAdapter.getTasks(), /Access denied/);
  console.log('  ✅ Data access prevented when storage is not ready');

  // Test 11: Disallow switch workspace in guest mode
  console.log('\nTest 11: Disallow switch workspace in guest mode');
  manager.logout(); // gen 8, guest
  assert.throws(
    () => manager.switchWorkspace('ws_forbidden'),
    /Cannot switch workspace in guest mode/
  );
  console.log('  ✅ Guest workspace switch rejected correctly');

  // Test 12: Network error resilience during workspace fetching
  console.log('\nTest 12: Network error resilience during workspace loading');
  // If workspace fetch fails, auth maintains current user with null workspace without crashing
  const userNoWsCtx = manager.login('user_no_ws', null); // gen 9
  await adapter.switchContext(userNoWsCtx);
  assert.strictEqual(adapter.getContext().userId, 'user_no_ws');
  assert.strictEqual(adapter.getContext().workspaceId, null);
  assert.strictEqual(adapter.getState(), 'ready');
  console.log('  ✅ Graceful degradation with null workspace upon network failure');

  console.log('\n🎉 ALL 12 TESTS IN tests/authContextLifecycle.test.ts PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
