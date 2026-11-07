import assert from 'node:assert/strict';
import {
  StorageContext,
  SessionGenerationManager,
  AsyncRequestGuard,
  StaleContextError,
  InvalidContextError,
} from '../src/services/storageContext';

async function runTests() {
  console.log('🧪 Starting StorageContext & SessionGenerationManager Test Suite...\n');

  // Test 1: Initial guest context
  console.log('Test 1: Initial guest context');
  SessionGenerationManager.resetForTesting();
  const manager = SessionGenerationManager.getInstance();
  const initialContext = manager.getContext();

  assert.strictEqual(initialContext.userId, null);
  assert.strictEqual(initialContext.workspaceId, null);
  assert.strictEqual(initialContext.sessionGeneration, 0);
  assert.strictEqual(initialContext.isGuest, true);
  assert.strictEqual(manager.isValid(initialContext), true);
  console.log('  ✅ Initial context is guest with generation 0');

  // Test 2: LOGIN transition
  console.log('\nTest 2: LOGIN transition');
  const user1Ctx = manager.login('usr_001', 'ws_alpha');
  assert.strictEqual(user1Ctx.userId, 'usr_001');
  assert.strictEqual(user1Ctx.workspaceId, 'ws_alpha');
  assert.strictEqual(user1Ctx.sessionGeneration, 1);
  assert.strictEqual(user1Ctx.isGuest, false);
  assert.strictEqual(manager.getGeneration(), 1);
  assert.strictEqual(manager.isValid(user1Ctx), true);
  console.log('  ✅ Login transition advanced generation to 1');

  // Test 3: Idempotent LOGIN transition
  console.log('\nTest 3: Idempotent LOGIN transition (same user & workspace)');
  const sameUserCtx = manager.login('usr_001', 'ws_alpha');
  assert.strictEqual(sameUserCtx.sessionGeneration, 1);
  assert.strictEqual(manager.getGeneration(), 1);
  console.log('  ✅ Generation did NOT increment for identical login state');

  // Test 4: SWITCH_WORKSPACE transition
  console.log('\nTest 4: SWITCH_WORKSPACE transition');
  const wsBetaCtx = manager.switchWorkspace('ws_beta');
  assert.strictEqual(wsBetaCtx.userId, 'usr_001');
  assert.strictEqual(wsBetaCtx.workspaceId, 'ws_beta');
  assert.strictEqual(wsBetaCtx.sessionGeneration, 2);
  assert.strictEqual(manager.getGeneration(), 2);
  assert.strictEqual(manager.isValid(wsBetaCtx), true);
  assert.strictEqual(manager.isValid(user1Ctx), false); // Old workspace context is now invalid
  console.log('  ✅ Switch workspace advanced generation to 2 and invalidated old context');

  // Test 5: Idempotent SWITCH_WORKSPACE transition
  console.log('\nTest 5: Idempotent SWITCH_WORKSPACE transition');
  const sameWsCtx = manager.switchWorkspace('ws_beta');
  assert.strictEqual(sameWsCtx.sessionGeneration, 2);
  assert.strictEqual(manager.getGeneration(), 2);
  console.log('  ✅ Generation did NOT increment when switching to same workspace');

  // Test 6: AbortSignal of previous generation is aborted
  console.log('\nTest 6: Previous generation AbortSignal is aborted');
  const gen1Signal = manager.getSignalForGeneration(1);
  const gen2Signal = manager.getSignalForGeneration(2);
  assert.ok(gen1Signal, 'gen 1 signal must exist');
  assert.strictEqual(gen1Signal.aborted, true, 'gen 1 signal must be aborted after advancing to gen 2');
  assert.ok(gen2Signal, 'gen 2 signal must exist');
  assert.strictEqual(gen2Signal.aborted, false, 'gen 2 signal must be active');
  console.log('  ✅ Previous generation signal is aborted, active signal is not aborted');

  // Test 7: LOGOUT transition
  console.log('\nTest 7: LOGOUT transition');
  const logoutCtx = manager.logout();
  assert.strictEqual(logoutCtx.userId, null);
  assert.strictEqual(logoutCtx.workspaceId, null);
  assert.strictEqual(logoutCtx.isGuest, true);
  assert.strictEqual(logoutCtx.sessionGeneration, 3);
  assert.strictEqual(manager.getGeneration(), 3);
  assert.strictEqual(manager.isValid(logoutCtx), true);
  assert.strictEqual(gen2Signal.aborted, true, 'gen 2 signal must be aborted on logout');
  console.log('  ✅ Logout advanced generation to 3, restored guest state, and aborted gen 2 signal');

  // Test 8: Idempotent LOGOUT transition
  console.log('\nTest 8: Idempotent LOGOUT transition');
  const sameLogoutCtx = manager.logout();
  assert.strictEqual(sameLogoutCtx.sessionGeneration, 3);
  assert.strictEqual(manager.getGeneration(), 3);
  console.log('  ✅ Generation did NOT increment on repeated logout');

  // Test 9: Disallow switch workspace in guest mode
  console.log('\nTest 9: Disallow switch workspace in guest mode');
  assert.throws(
    () => manager.switchWorkspace('some_ws'),
    InvalidContextError,
    'Should throw InvalidContextError when switching workspace in guest mode'
  );
  console.log('  ✅ Disallowed workspace switch in guest mode');

  // Test 10: AsyncRequestGuard pre-check rejection
  console.log('\nTest 10: AsyncRequestGuard pre-check rejection with stale context');
  let taskExecuted = false;
  await assert.rejects(
    async () => {
      await AsyncRequestGuard.run(user1Ctx, async (signal) => {
        taskExecuted = true;
        return 'data';
      }, manager);
    },
    StaleContextError
  );
  assert.strictEqual(taskExecuted, false, 'Async task should not execute if pre-check fails');
  console.log('  ✅ AsyncRequestGuard rejected stale context before task execution');

  // Test 10b: AsyncRequestGuard pre-check rejection with null/invalid context
  console.log('\nTest 10b: AsyncRequestGuard pre-check rejection with null/invalid context');
  await assert.rejects(
    async () => {
      await AsyncRequestGuard.run(null as any, async () => 'data', manager);
    },
    InvalidContextError
  );
  console.log('  ✅ AsyncRequestGuard rejected invalid/null context with InvalidContextError');

  // Test 11: AsyncRequestGuard post-check rejection when context changes during execution
  console.log('\nTest 11: AsyncRequestGuard post-check rejection when context changes during async execution');
  const activeUserCtx = manager.login('usr_002', 'ws_gamma'); // gen 4
  let postCheckRejected = false;

  try {
    await AsyncRequestGuard.run(activeUserCtx, async (signal) => {
      // Simulate slow async task during which user switches workspace or logs out
      manager.switchWorkspace('ws_delta'); // advances to gen 5
      assert.strictEqual(signal.aborted, true, 'Signal must be aborted by generation transition');
      return { payload: 'sensitive_ws_gamma_data' };
    }, manager);
  } catch (err) {
    if (err instanceof StaleContextError) {
      postCheckRejected = true;
    } else {
      throw err;
    }
  }

  assert.strictEqual(postCheckRejected, true, 'Post-check must reject result when context changed during call');
  console.log('  ✅ AsyncRequestGuard rejected result because context became stale during execution');

  // Test 12: AsyncRequestGuard success when context remains stable
  console.log('\nTest 12: AsyncRequestGuard success on stable context');
  const stableCtx = manager.getContext(); // gen 5
  const result = await AsyncRequestGuard.run(stableCtx, async (signal) => {
    assert.strictEqual(signal.aborted, false);
    return 'valid_payload';
  }, manager);
  assert.strictEqual(result, 'valid_payload');
  console.log('  ✅ AsyncRequestGuard completed successfully on stable context');

  console.log('\n🎉 ALL 12 TESTS IN tests/storageContext.test.ts PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
