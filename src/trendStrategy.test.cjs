"use strict";
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
let restore, workspace, preview, plan;
before(() => { restore = registerTypeScript(); workspace = require("./trendWorkspace.ts"); preview = require("./trendScreenerPreview.ts"); plan = require("./trendPlan.ts"); });
after(() => restore?.());
const strategy = (hash = "a".repeat(64)) => ({ id: "quality-v2", version: "2.0.0", configHash: hash, config: { maxExtensionAtr: 2, minCloseLocation: 0.7, maxVolumeRatio: 3 } });
function candidate() {
  const c = structuredClone(preview.createTrendPreviewStatus().candidates[0]);
  c.strategy = strategy(); c.primaryPattern = "A";
  c.quality = { atr14Previous: 0.4, extensionAtr: 1.4, closeLocation: 0.8, volumeRatio: 1.5, volumeMedian20: 10000, ma60Rising: true, relativeStrengthPositive: true, holdingMa20Count: 3, stopDistanceAtr: 2.65 };
  c.plan.minEntry = 12.3;
  return c;
}
test("v2 plan identity isolates configs while classic metadata preserves legacy identity", () => {
  const legacy = structuredClone(preview.createTrendPreviewStatus().candidates[0]);
  const oldId = workspace.trendPlanId(legacy, true);
  legacy.strategy = { id: "classic-v1", version: "1.0.0", configHash: "b".repeat(64), config: {} };
  assert.equal(workspace.trendPlanId(legacy, true), oldId);
  const v2 = candidate();
  assert.notEqual(workspace.trendPlanId(v2, true), oldId);
  const first = workspace.trendPlanId(v2, true); v2.strategy.configHash = "c".repeat(64);
  assert.notEqual(workspace.trendPlanId(v2, true), first);
});
test("new and old snapshots round-trip together; invalid v2 metadata cannot overwrite storage", () => {
  const status = preview.createTrendPreviewStatus();
  let raw = null; const store = { getItem: () => raw, setItem: (_, value) => { raw = value; } };
  const a = workspace.createSavedTrendPlan(status.candidates[0], status);
  const b = workspace.createSavedTrendPlan(candidate(), status);
  assert.equal(workspace.writeTrendPlans(store, [a,b]), true);
  assert.equal(workspace.readTrendPlans(store).plans.length, 2);
  const before = raw;
  for (const mutate of [c => c.strategy.version = "999", c => c.strategy.config.maxExtensionAtr = 99, c => delete c.plan.minEntry, c => c.plan.minEntry = c.plan.stop, c => c.strategy.id = "unknown", c => c.quality.atr14Previous = -1]) {
    const invalid = structuredClone(b); mutate(invalid.candidate);
    assert.equal(workspace.writeTrendPlans(store, [invalid]), false);
    assert.equal(raw, before);
  }
});
test("v2 CSV carries the frozen strategy, configuration and entry floor", () => {
  const status = preview.createTrendPreviewStatus();
  const csv = workspace.trendCandidatesCsv([workspace.createSavedTrendPlan(candidate(), status)]);
  for (const value of ["策略版本", "参数快照", "最低参考入场", "quality-v2", "2.0.0", "maxExtensionAtr", "12.3"]) assert.ok(csv.includes(value), value);
});
test("sizing refuses a failed breakout floor without changing classic position rules", () => {
  const input = { netAssetValue:100000, entryPrice:10, stopPrice:9.5, maxEntryPrice:10.3, industryExposureRatio:0, portfolioExposureRatio:0, openPositions:0, cashAvailable:100000, feeReserve:0, minimumBuyQuantity:100, quantityStep:100, alreadyHeld:false,permissionVerified:true,announcementVerified:true,corporateActionAligned:true,marketGate:"open" };
  assert.equal(plan.calculateTrendPosition(input).shares, 1000);
  const blocked = plan.calculateTrendPosition({...input,minEntryPrice:10.01});
  assert.equal(blocked.eligible,false); assert.match(blocked.reasons.join(" "), /突破|最低/);
  assert.equal(plan.calculateTrendPosition({...input,minEntryPrice:10}).shares,1000);
  for (const minEntryPrice of [NaN, Infinity, 9.4, 10.4]) assert.equal(plan.calculateTrendPosition({...input,minEntryPrice}).eligible,false);
});
test("browser presets and preview strategy fingerprint match backend normalization", async () => {
  const { normalizeTrendStrategy } = require("../electron/trend-strategy.cjs");
  const { TREND_QUALITY_PRESETS } = require("./trendStrategyConfig.ts");
  for (const config of Object.values(TREND_QUALITY_PRESETS)) {
    const options = { strategyId: "quality-v2", config };
    const state = await preview.createConfiguredTrendPreviewStatus(options);
    assert.deepEqual(state.strategy, normalizeTrendStrategy(options));
    assert.ok(state.candidates.every(c => c.strategy.configHash === state.strategy.configHash));
    assert.equal(state.isPreview, true);
    const snap = workspace.createSavedTrendPlan(state.candidates[0], state);
    assert.equal(workspace.writeTrendPlans({setItem(){}}, [snap]), true);
  }
  await assert.rejects(() => preview.createConfiguredTrendPreviewStatus({strategyId:"quality-v2", config:{maxExtensionAtr:999}}));
  const first = preview.createTrendPreviewStatus(); first.candidates[0].security.name = "changed";
  assert.notEqual(preview.createTrendPreviewStatus().candidates[0].security.name, "changed");
});
