"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

async function run() {
  const executablePath = process.argv[2];
  if (!executablePath) throw new Error("Pass the packaged application executable path");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "trend-desktop-qa-"));
  const app = await electron.launch({ executablePath, args: [], env: {
    ...process.env, A_STOCK_E2E_USER_DATA: userData, A_STOCK_E2E_HIDDEN: "1"
  } });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("heading", { name: "趋势筛选", exact: true }).waitFor();
    await page.getByRole("button", {name:"黑夜",exact:true}).click();
    assert.equal(await page.locator(".trend-library-choice").count(), 14);
    assert.equal(await page.locator(".brand").count(), 0);
    assert.doesNotMatch(await page.locator("body").innerText(), /2–6 周 · A股波段工作台|近期涨停 · 上涨趋势/);
    const metadata = await page.evaluate(async () => ({ version: await window.stockApi.getVersion(), definitions: await window.stockApi.getStrategyDefinitions() }));
    assert.equal(metadata.version, require("../package.json").version);
    assert.equal(metadata.definitions.length, 32);
    assert.equal(metadata.definitions.filter(item => item.type === "composite").length, 18);
    assert.ok(metadata.definitions.find(item => item.id === "limit_macd_pullback_resonance").sources.length > 0);
    const sectorContract = await page.evaluate(async () => {
      const methods = ['getSectorCatalog', 'getSectorClassifications', 'getSectorDetail', 'cancelSectorRequest'];
      let invalidRejected = false;
      try { await window.stockApi.getSectorClassifications({code:'900901',requestId:'native-invalid-sector'}); } catch { invalidRejected = true; }
      return {methods:methods.every(key=>typeof window.stockApi[key]==='function'),invalidRejected,cancelled:await window.stockApi.cancelSectorRequest('native-unknown-sector')};
    });
    assert.equal(sectorContract.methods,true);
    assert.equal(sectorContract.invalidRejected,true);
    assert.deepEqual(sectorContract.cancelled,{cancelled:false});
    const initial = await page.evaluate(() => window.stockApi.getTrendScan());
    assert.equal(initial.phase, "idle");
    assert.equal(await page.locator(".trend-strategy-coverage").count(), 0, "idle defaults are not displayed as actual completed strategy results");
    assert.equal(initial.isPreview, undefined);
    assert.equal(await page.locator(".trend-candidate").count(), 0, "native app never substitutes fake market candidates");
    const output = path.resolve(process.argv[3] || "artifacts/v14-qa/native");
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "native-workspace.png"), fullPage: true });
    await page.getByRole("button", { name: "方案算例", exact: true }).click();
    const example = page.getByRole("region", { name: "虚构方案算例", exact: true });
    for (const checkbox of await example.getByRole("checkbox").all()) {
      if (!(await checkbox.locator("..").innerText()).includes("当前账户已持有")) await checkbox.check();
    }
    await example.getByRole("button", { name: "计算参考股数", exact: true }).click();
    assert.match(await example.locator(".trend-sizing-values").innerText(), /1,000 股/);
    assert.match(await example.locator(".trend-sizing-values").innerText(), /500.00 \/ 0.50%/);
    await example.screenshot({ path: path.join(output, "native-plan-example.png") });
    await page.getByRole("button", { name: "方案算例", exact: true }).click();
    const result = await page.evaluate(async () => {
      const started = await window.stockApi.startTrendScan({ strategyId: "quality-v2", config: { maxExtensionAtr: 2.5, minCloseLocation: .65, maxVolumeRatio: 3.5 }, forceRefresh: true });
      const cancelled = await window.stockApi.cancelTrendScan();
      return { started, cancelled };
    });
    assert.equal(result.started.phase, "loading-universe");
    assert.equal(result.started.strategy.id, "quality-v2");
    assert.equal(result.started.strategy.config.maxExtensionAtr, 2.5);
    assert.equal(result.cancelled.strategy.configHash, result.started.strategy.configHash);
    assert.ok(result.cancelled.performance.peakHistoryConcurrency <= 6);
    const compatibility = await page.evaluate(async () => { const classic = await window.stockApi.startTrendScan(); await window.stockApi.cancelTrendScan(); let invalidRejected = false; try { await window.stockApi.startTrendScan({ strategyId: "quality-v2", config: {maxExtensionAtr: 99} }); } catch {invalidRejected = true;} return {classic,invalidRejected}; });
    assert.equal(compatibility.classic.strategy.id,"classic-v1");
    assert.equal(compatibility.invalidRejected,true);
    const batch = await page.evaluate(async () => {
      const strategies = ['classic-v1', 'quality-v2', 'macd-zero-cross-v1', 'boll-squeeze-breakout-v1', 'dmi-trend-strength-v1', 'obv-volume-breakout-v1', 'kdj-trend-cross-v1', 'ma-pullback-resume-v1', 'rsi-midline-recovery-v1', 'cci-strength-breakout-v1', 'roc-zero-recovery-v1', 'emv-zero-recovery-v1', 'mfi-midline-recovery-v1', 'donchian-55-breakout-v1'].map(strategyId => ({ strategyId }));
      const started = await window.stockApi.startTrendScan({ strategies, forceRefresh: true });
      const cancelled = await window.stockApi.cancelTrendScan();
      return { started, cancelled };
    });
    assert.equal(batch.started.strategies.length, 14);
    assert.equal(batch.started.strategy, undefined);
    assert.equal(batch.started.strategyStats.length, 14);
    assert.match(batch.started.strategySetHash, /^[a-f0-9]{64}$/);
    assert.equal(batch.cancelled.phase, 'cancelled');
    assert.equal(batch.cancelled.strategySetHash, batch.started.strategySetHash);
    assert.equal(batch.cancelled.strategyStats.every(stat => stat.coverageComplete === false), true);
    assert.equal(await page.locator('[data-information-center-nav]').count(), 1);
    assert.equal(await page.locator('nav').getByRole('button', { name: 'A股公告', exact: true }).count(), 0);
    await page.getByRole('button', { name: '资讯中心', exact: true }).click();
    await page.getByRole('tab', { name: '全部', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '全部', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: '公司公告', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: '公司公告', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: '涨停趋势', exact: true }).click();
    assert.equal(result.cancelled.phase, "cancelled");
    assert.equal(result.cancelled.coverageComplete, false);
    assert.equal(result.cancelled.validation, "unvalidated");
    await page.getByRole("button", { name: "刷新扫描状态", exact: true }).click();
    await page.getByRole("heading", { name: "扫描已取消", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "native-smoke.json"), JSON.stringify({ passed:true, appVersion:metadata.version, isolatedUserData:true, liveFullMarketVerified:false, checks:["no branding or fake native candidates","32 definitions and 18 composites with source metadata","four sector native IPC methods and invalid A-share rejection","single and batch native IPC","cancel isolation","sizing example","information center default all"] }, null, 2));
    console.log("Packaged Electron app: default workspace, no fake live results, Word sizing example, native single/batch IPC, merged information center and cancellation passed.");
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
