"use strict";

// Always launches a separate profile: never attach fault injection to a user's session.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const executablePath = process.argv[2];
  const output = path.resolve(process.argv[3] || "artifacts/stability-v141/monitor");
  if (!executablePath) throw new Error("Pass a packaged executable, then an optional evidence directory");
  fs.mkdirSync(output, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "astock-stability-"));
  const result = { startedAt: new Date().toISOString(), isolatedProfile: true, samples: [], recoveries: [], rendererErrors: [], networkScope: "Idle workspace only; no full-market scans or account data" };
  const app = await electron.launch({ executablePath, env: { ...process.env, A_STOCK_E2E_USER_DATA: userData, A_STOCK_E2E_HIDDEN: "1" } });
  let closed = false;
  try {
    const identity = await app.evaluate(({ app }) => ({ userData: app.getPath("userData"), version: app.getVersion(), pid: process.pid }));
    assert.equal(path.resolve(identity.userData), path.resolve(userData));
    result.version = identity.version;
    result.pid = identity.pid;
    const page = await app.firstWindow();
    page.on("pageerror", (error) => result.rendererErrors.push(error.message));
    await page.getByRole("heading", { name: "趋势筛选", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.webContents.setBackgroundThrottling(false);
      globalThis.__stabilityMonitor = { loads: 0, crashes: [], delays: [], last: performance.now() };
      w.webContents.on("did-finish-load", () => globalThis.__stabilityMonitor.loads++);
      w.webContents.on("render-process-gone", (_, details) => globalThis.__stabilityMonitor.crashes.push(details.reason));
      globalThis.__stabilityTimer = setInterval(() => {
        const m = globalThis.__stabilityMonitor;
        const now = performance.now();
        m.delays.push(Math.max(0, now - m.last - 20));
        if (m.delays.length > 5000) m.delays.shift();
        m.last = now;
      }, 20);
      globalThis.__stabilityTimer.unref();
    });
    for (let cycle = 0; cycle < 12; cycle++) {
      // Use local-only actions, exercising effect cleanup across repeated mounts.
      await page.getByRole("button", { name: cycle % 2 ? "白天" : "黑夜", exact: true }).click();
      await page.getByRole("button", { name: "方案算例", exact: true }).click();
      await page.getByRole("region", { name: "虚构方案算例", exact: true }).waitFor();
      await page.getByRole("button", { name: "方案算例", exact: true }).click();
      await page.reload();
      await page.getByRole("heading", { name: "趋势筛选", exact: true }).waitFor();
      await delay(60);
      const sample = await app.evaluate(({ app, BrowserWindow }) => ({
        memory: process.memoryUsage(),
        resources: process.getActiveResourcesInfo(),
        windows: BrowserWindow.getAllWindows().length,
        listeners: { rejection: process.listenerCount("unhandledRejection"), exception: process.listenerCount("uncaughtExceptionMonitor") },
        metrics: app.getAppMetrics().map(({ pid, type, memory, cpu }) => ({ pid, type, memory, cpu }))
      }));
      assert.equal(sample.windows, 1);
      assert.equal(sample.listeners.rejection, 1);
      assert.equal(sample.listeners.exception, 1);
      result.samples.push({ cycle, ...sample });
    }
    await page.screenshot({ path: path.join(output, "workspace-before-fault.png") });
    // Three recoveries are allowed per minute; the fourth must not loop forever.
    for (let attempt = 1; attempt <= 4; attempt++) {
      const before = await app.evaluate(() => globalThis.__stabilityMonitor.loads);
      const start = Date.now();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
      let loads = before;
      const deadline = Date.now() + (attempt <= 3 ? 8000 : 2000);
      while (Date.now() < deadline) {
        await delay(100);
        loads = await app.evaluate(() => globalThis.__stabilityMonitor.loads);
        if (loads > before) break;
      }
      if (attempt <= 3) assert.equal(loads, before + 1, `Crash ${attempt} should recover once`);
      else assert.equal(loads, before, "Fourth crash should be suppressed by recovery budget");
      result.recoveries.push({ attempt, recovered: loads > before, durationMs: Date.now() - start });
    }
    const monitor = await app.evaluate(() => {
      clearInterval(globalThis.__stabilityTimer);
      return globalThis.__stabilityMonitor;
    });
    const sorted = [...monitor.delays].sort((a, b) => a - b);
    result.eventLoop = { samples: sorted.length, p95DelayMs: sorted[Math.floor(sorted.length * .95)], maxDelayMs: sorted.at(-1) };
    result.crashReasons = monitor.crashes;
    assert.equal(monitor.crashes.length, 4);
    const logPath = path.join(userData, "runtime-errors.log");
    const log = fs.readFileSync(logPath, "utf8");
    assert.match(log, /renderer-recovery-suppressed/);
    result.runtimeLogBytes = Buffer.byteLength(log);
    result.unhandledRejections = (log.match(/unhandledRejection/g) || []).length;
    assert.equal(result.unhandledRejections, 0);
    assert.deepEqual(result.rendererErrors, []);
    fs.writeFileSync(path.join(output, "isolated-runtime-errors.log"), log);
    const quitAt = Date.now();
    await app.close();
    closed = true;
    result.quitDurationMs = Date.now() - quitAt;
    // Include errors emitted during cleanup, not only the pre-quit snapshot.
    const finalLog = fs.readFileSync(logPath, "utf8");
    fs.writeFileSync(path.join(output, "isolated-runtime-errors.log"), finalLog);
    result.runtimeLogBytes = Buffer.byteLength(finalLog);
    result.unhandledRejections = (finalLog.match(/unhandledRejection/g) || []).length;
    result.shutdownWarnings = (finalLog.match(/shutdown-cleanup/g) || []).length;
    assert.equal(result.unhandledRejections, 0);
    assert.equal(result.shutdownWarnings, 0, "Idle native shutdown should drain without hitting its deadline");
    result.passed = true;
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, "monitor-results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ version: result.version, passed: true, reloadCycles: result.samples.length, recoveries: result.recoveries, eventLoop: result.eventLoop, quitDurationMs: result.quitDurationMs }, null, 2));
  } catch (error) {
    result.passed = false;
    result.error = error.stack || String(error);
    fs.writeFileSync(path.join(output, "monitor-results.json"), JSON.stringify(result, null, 2));
    throw error;
  } finally {
    if (!closed) await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
