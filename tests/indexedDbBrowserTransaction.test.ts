import { chromium, Browser } from 'playwright';
import { spawn, ChildProcess } from 'child_process';
import assert from 'node:assert/strict';

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200 || res.status === 304) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

async function runBrowserTests() {
  console.log('🌐 Starting Chromium Browser Transaction Tests for OneTeamDB_v2...\n');

  // Launch Vite preview or dev server
  const serverProcess: ChildProcess = spawn('npx', ['vite', '--port', '3456', '--host', '127.0.0.1'], {
    stdio: 'ignore',
  });

  const url = 'http://127.0.0.1:3456';
  let browser: Browser | null = null;

  try {
    await waitForServer(url);
    console.log('✅ Vite server running at', url);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to actual HTTP origin to satisfy IndexedDB security restrictions
    await page.goto(url);

    // Scenario 1: Successful write and retrieval using real IndexedDB
    console.log('Scenario 1: Successful write and retrieval in Chromium');
    const scenario1Result = await page.evaluate(async () => {
      // @ts-ignore
      const { isolatedStorageEngine, V2_STORES } = await import('/src/services/indexedDbV2.ts');
      // @ts-ignore
      const { SessionGenerationManager } = await import('/src/services/storageContext.ts');

      SessionGenerationManager.resetForTesting();
      const manager = SessionGenerationManager.getInstance();
      const ctx = manager.login('u_browser_1', 'ws_browser_1'); // gen 1

      const task = { id: 'browser-task-1', title: 'Chromium Task 1' };
      await isolatedStorageEngine.put(V2_STORES.TASKS, task, ctx);

      const retrieved = await isolatedStorageEngine.get(V2_STORES.TASKS, 'browser-task-1', ctx);
      return { success: Boolean(retrieved && (retrieved as any).title === 'Chromium Task 1'), retrieved };
    });
    assert.strictEqual(scenario1Result.success, true);
    console.log('  ✅ Scenario 1 Passed: Put and get verified');

    // Scenario 2: Abort put before commit
    console.log('\nScenario 2: Abort put before commit in Chromium');
    const scenario2Result = await page.evaluate(async () => {
      // @ts-ignore
      const { isolatedStorageEngine, V2_STORES } = await import('/src/services/indexedDbV2.ts');
      // @ts-ignore
      const { SessionGenerationManager } = await import('/src/services/storageContext.ts');

      const manager = SessionGenerationManager.getInstance();
      const ctx = manager.getContext(); // gen 1

      let putRejectedWithStale = false;
      const putPromise = isolatedStorageEngine.put(
        V2_STORES.TASKS,
        { id: 'browser-task-aborted', title: 'Should Not Exist' },
        ctx
      ).catch((err: any) => {
        if (err.name === 'StaleContextError') {
          putRejectedWithStale = true;
        }
      });

      // Immediately switch workspace before commit can finish
      manager.switchWorkspace('ws_browser_2'); // advances to gen 2, aborting gen 1 signal
      await putPromise;

      // Verify that 'browser-task-aborted' was NOT written in ws_browser_1
      const gen2Ctx = manager.getContext();
      const gen1VerifyCtx = { ...ctx, sessionGeneration: manager.getGeneration() };
      // Switch back to verify ws_browser_1
      const backCtx = manager.switchWorkspace('ws_browser_1'); // gen 3
      const checkRecord = await isolatedStorageEngine.get(V2_STORES.TASKS, 'browser-task-aborted', backCtx);

      return {
        putRejectedWithStale,
        recordExists: checkRecord !== null,
      };
    });
    assert.strictEqual(scenario2Result.putRejectedWithStale, true);
    assert.strictEqual(scenario2Result.recordExists, false);
    console.log('  ✅ Scenario 2 Passed: Put transaction aborted before commit');

    // Scenario 3: Abort setAll without partial writes
    console.log('\nScenario 3: Abort setAll without partial writes in Chromium');
    const scenario3Result = await page.evaluate(async () => {
      // @ts-ignore
      const { isolatedStorageEngine, V2_STORES } = await import('/src/services/indexedDbV2.ts');
      // @ts-ignore
      const { SessionGenerationManager } = await import('/src/services/storageContext.ts');

      const manager = SessionGenerationManager.getInstance();
      const currentCtx = manager.getContext(); // gen 3 in ws_browser_1

      // First write initial items
      const initialProjects = [{ id: 'proj-1', name: 'Project 1' }, { id: 'proj-2', name: 'Project 2' }];
      await isolatedStorageEngine.setAll(V2_STORES.PROJECTS, initialProjects, currentCtx);

      let setAllRejected = false;
      const setAllPromise = isolatedStorageEngine.setAll(
        V2_STORES.PROJECTS,
        [{ id: 'proj-new-1', name: 'New 1' }, { id: 'proj-new-2', name: 'New 2' }],
        currentCtx
      ).catch((err: any) => {
        if (err.name === 'StaleContextError') setAllRejected = true;
      });

      // Invalidate context immediately
      manager.logout(); // advances to gen 4
      await setAllPromise;

      // Log back in to verify original records were preserved (atomic rollback on abort)
      const restoredCtx = manager.login('u_browser_1', 'ws_browser_1'); // gen 5
      const currentProjects = (await isolatedStorageEngine.getAll(V2_STORES.PROJECTS, restoredCtx)) as any[];

      return {
        setAllRejected,
        preservedOriginal: currentProjects.length === 2 && currentProjects.some((p: any) => p.id === 'proj-1'),
        newRecordsLeak: currentProjects.some((p: any) => p.id === 'proj-new-1'),
      };
    });
    assert.strictEqual(scenario3Result.setAllRejected, true);
    assert.strictEqual(scenario3Result.preservedOriginal, true);
    assert.strictEqual(scenario3Result.newRecordsLeak, false);
    console.log('  ✅ Scenario 3 Passed: setAll aborted atomically with zero partial writes');

    // Scenario 4: Abort delete with original record preserved
    console.log('\nScenario 4: Abort delete with original record preserved in Chromium');
    const scenario4Result = await page.evaluate(async () => {
      // @ts-ignore
      const { isolatedStorageEngine, V2_STORES } = await import('/src/services/indexedDbV2.ts');
      // @ts-ignore
      const { SessionGenerationManager } = await import('/src/services/storageContext.ts');

      const manager = SessionGenerationManager.getInstance();
      const ctx = manager.getContext(); // gen 5

      // Ensure record exists
      await isolatedStorageEngine.put(V2_STORES.CLIENTS, { id: 'client-keep', name: 'Original Client' }, ctx);

      let deleteRejected = false;
      const deletePromise = isolatedStorageEngine.delete(V2_STORES.CLIENTS, 'client-keep', ctx).catch((err: any) => {
        if (err.name === 'StaleContextError') deleteRejected = true;
      });

      // Invalidate session immediately
      manager.switchWorkspace('ws_other'); // gen 6
      await deletePromise;

      // Switch back to verify record remained intact
      const backCtx = manager.switchWorkspace('ws_browser_1'); // gen 7
      const client = (await isolatedStorageEngine.get(V2_STORES.CLIENTS, 'client-keep', backCtx)) as any;

      return {
        deleteRejected,
        recordStillExists: Boolean(client && client.name === 'Original Client'),
      };
    });
    assert.strictEqual(scenario4Result.deleteRejected, true);
    assert.strictEqual(scenario4Result.recordStillExists, true);
    console.log('  ✅ Scenario 4 Passed: Delete aborted and original record preserved');

    // Scenario 5: New session generation cannot access old context data
    console.log('\nScenario 5: New session generation cross-session data isolation in Chromium');
    const scenario5Result = await page.evaluate(async () => {
      // @ts-ignore
      const { isolatedStorageEngine, V2_STORES } = await import('/src/services/indexedDbV2.ts');
      // @ts-ignore
      const { SessionGenerationManager } = await import('/src/services/storageContext.ts');

      const manager = SessionGenerationManager.getInstance();

      // User A in Workspace A
      const userACtx = manager.login('user_A', 'ws_A'); // gen 8
      await isolatedStorageEngine.put(V2_STORES.TASKS, { id: 'task-A', title: 'Secret Task A' }, userACtx);
      await isolatedStorageEngine.put(V2_STORES.NOTIFICATIONS, { id: 'notif-A', text: 'Private A' }, userACtx);

      // User B logs in (new session generation)
      const userBCtx = manager.login('user_B', 'ws_B'); // gen 9

      const taskInB = await isolatedStorageEngine.get(V2_STORES.TASKS, 'task-A', userBCtx);
      const notifInB = await isolatedStorageEngine.get(V2_STORES.NOTIFICATIONS, 'notif-A', userBCtx);

      // Attempting to query with stale userACtx should reject
      let staleQueryRejected = false;
      try {
        await isolatedStorageEngine.get(V2_STORES.TASKS, 'task-A', userACtx);
      } catch (err: any) {
        if (err.name === 'StaleContextError') staleQueryRejected = true;
      }

      return {
        taskLeaked: taskInB !== null,
        notifLeaked: notifInB !== null,
        staleQueryRejected,
      };
    });
    assert.strictEqual(scenario5Result.taskLeaked, false);
    assert.strictEqual(scenario5Result.notifLeaked, false);
    assert.strictEqual(scenario5Result.staleQueryRejected, true);
    console.log('  ✅ Scenario 5 Passed: Strict cross-session context isolation confirmed in real browser');

    console.log('\n🎉 ALL 5 CHROMIUM BROWSER SCENARIOS PASSED SUCCESSFULLY!');
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

runBrowserTests().catch((err) => {
  console.error('❌ Browser tests failed:', err);
  process.exit(1);
});
