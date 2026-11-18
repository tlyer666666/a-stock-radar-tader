"use strict";

require("../../../qa/test-env.cjs");
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

const restoreTypeScript = registerTypeScript();
after(() => {
  restoreTypeScript?.();
});

const { initialSettings } = require("../../domain/settings.ts");
const {
  toSafeBacktestSettings,
  toBacktestStrategyProfile,
  buildBacktestProfileDiff,
  buildBacktestDeRiskProfile,
  evaluateBacktestExecutionReadiness,
  buildBacktestExecutionPlan
} = require("./executionGovernance.ts");

test("toSafeBacktestSettings and toBacktestStrategyProfile normalize strategy and risk constraints", () => {
  const settings = {
    ...initialSettings,
    selectedStrategies: ["trend", "firstBoard", "firstBoard"],
    riskProfile: "balanced",
    maxPositionPercent: 25
  };
  const safe = toSafeBacktestSettings(settings);
  assert.equal(safe.riskProfile, "balanced");
  assert.equal(safe.maxPositionPercent, 25);
  assert.ok(Array.isArray(safe.selectedStrategies) && safe.selectedStrategies.length >= 2);

  const profile = toBacktestStrategyProfile(settings);
  assert.equal(profile.lossStepPercent, safe.lossStreakStepPercent);
  assert.equal(profile.lossFloorPercent, safe.lossStreakFloorPercent);
  assert.equal(new Set(profile.selectedStrategies).size, profile.selectedStrategies.length);
});

test("buildBacktestProfileDiff detects strategy set, risk profile, and numeric parameter changes", () => {
  const base = {
    ...toBacktestStrategyProfile(initialSettings),
    selectedStrategies: ["trend", "firstBoard", "lowFirstBoard", "maBreakout", "gapUp", "shrinkPullback"]
  };
  const target = {
    ...base,
    riskProfile: "aggressive",
    selectedStrategies: ["trend"],
    maxPositionPercent: base.maxPositionPercent + 10,
    stopLossATRMultiple: base.stopLossATRMultiple + 0.5,
    maxHoldingBars: base.maxHoldingBars + 5
  };
  assert.deepEqual(buildBacktestProfileDiff(base, base), []);

  const diffs = buildBacktestProfileDiff(base, target);
  const labels = diffs.map((item) => item.label);
  assert.ok(labels.includes("风险档位"));
  assert.ok(labels.includes("策略组合"));
  assert.ok(diffs.some((item) => item.label === "策略组合" && item.sourceValue.includes("等6项")));
  assert.ok(labels.includes("最大仓位"));
  assert.ok(labels.includes("止损ATR"));
  assert.ok(labels.includes("最大持仓Bars"));
});

test("buildBacktestDeRiskProfile scales exposure down across readiness score bands", () => {
  const base = toBacktestStrategyProfile({ ...initialSettings, maxPositionPercent: 40, maxOpenPositions: 5 });
  const highWait = buildBacktestDeRiskProfile(base, {
    score: 72,
    level: "wait",
    status: "WAIT",
    recommendation: "wait",
    reasons: [],
    canRunLive: false
  });
  const lowWait = buildBacktestDeRiskProfile(base, {
    score: 50,
    level: "wait",
    status: "WAIT",
    recommendation: "wait",
    reasons: [],
    canRunLive: false
  });
  assert.ok(highWait.profile.maxPositionPercent < base.maxPositionPercent);
  assert.ok(lowWait.profile.maxPositionPercent < highWait.profile.maxPositionPercent);
  assert.ok(lowWait.profile.takeProfitATRMultiple >= lowWait.profile.stopLossATRMultiple * 1.2);
  assert.ok(lowWait.adjustments.length > 0);
});

test("evaluateBacktestExecutionReadiness enforces block, wait, pass, and remote intersection gates", () => {
  assert.equal(evaluateBacktestExecutionReadiness(null, []).status, "BLOCK");

  const remoteFallback = evaluateBacktestExecutionReadiness(null, [], {
    score: 80,
    level: "pass",
    status: "PASS",
    recommendation: "remote-ok",
    reasons: ["remote check"],
    canRunLive: true
  });
  assert.equal(remoteFallback.status, "PASS");

  const strongMetrics = {
    accepted: true,
    replayableSignals: 120,
    projectedNetEdge: 3.0,
    expectancy5: 2.0,
    winRate5: 72,
    worstMdd5: -3.0,
    avgExcess5: 1.8
  };
  const passLocal = evaluateBacktestExecutionReadiness(strongMetrics, []);
  assert.equal(passLocal.status, "PASS");
  assert.equal(passLocal.canRunLive, true);

  const weakMetrics = {
    accepted: false,
    passReason: "样本不足",
    replayableSignals: 8,
    projectedNetEdge: -1.0,
    expectancy5: -1.0,
    winRate5: 38,
    worstMdd5: -12.0,
    avgExcess5: -0.5
  };
  const blocked = evaluateBacktestExecutionReadiness(weakMetrics, [
    { label: "最大仓位", sourceValue: "20%", targetValue: "40%" }
  ]);
  assert.equal(blocked.status, "BLOCK");
  assert.equal(blocked.canRunLive, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes("预检未通过")));

  const remoteWaitMerge = evaluateBacktestExecutionReadiness(strongMetrics, [], {
    score: 64,
    level: "wait",
    status: "WAIT",
    recommendation: "等待远程复核",
    reasons: ["样本待补充"],
    canRunLive: false
  });
  assert.equal(remoteWaitMerge.status, "WAIT");
  assert.equal(remoteWaitMerge.canRunLive, false);

  const remotePassMerge = evaluateBacktestExecutionReadiness(strongMetrics, [], {
    score: 84,
    level: "pass",
    status: "PASS",
    recommendation: "双端通过",
    reasons: ["一致性校验通过"],
    canRunLive: true
  });
  assert.equal(remotePassMerge.status, "PASS");
  assert.equal(remotePassMerge.score, Math.min(84, passLocal.score));
});

test("buildBacktestExecutionPlan outputs blocked WAIT fallback without metrics and sized BUY plan when passing", () => {
  const profile = toBacktestStrategyProfile(initialSettings);
  const emptyPlan = buildBacktestExecutionPlan(
    null,
    { score: 0, level: "block", status: "BLOCK", recommendation: "", reasons: [], canRunLive: false },
    profile
  );
  assert.equal(emptyPlan.canExecute, false);
  assert.equal(emptyPlan.signal, "WAIT");
  assert.equal(emptyPlan.positionSizePercent, 0);

  const goodPlan = buildBacktestExecutionPlan(
    {
      accepted: true,
      replayableSignals: 48,
      projectedNetEdge: 2.2,
      expectancy5: 1.4,
      winRate5: 62,
      worstMdd5: -4.2
    },
    { score: 86, level: "pass", status: "PASS", recommendation: "通过", reasons: [], canRunLive: true },
    profile
  );
  assert.equal(goodPlan.canExecute, true);
  assert.equal(goodPlan.signal, "BUY");
  assert.ok(goodPlan.positionSizePercent >= 1 && goodPlan.positionSizePercent <= profile.maxPositionPercent);
  assert.ok(goodPlan.riskRewardRatio > 0);
});

test("P1-4: normalizeSettings preserves [-2, 8] minExpectancyPoints & [0, 25] trailingStopPercent and de-risk reports all changed fields", () => {
  const { normalizeSettings } = require("../../domain/settings.ts");
  const normalized = normalizeSettings({
    ...initialSettings,
    minExpectancyPoints: -1.75,
    trailingStopPercent: 24
  });
  assert.equal(normalized.minExpectancyPoints, -1.75);
  assert.equal(normalized.trailingStopPercent, 24);

  const upperClamped = normalizeSettings({
    ...initialSettings,
    minExpectancyPoints: 7.5,
    trailingStopPercent: 30
  });
  assert.equal(upperClamped.minExpectancyPoints, 7.5);
  assert.equal(upperClamped.trailingStopPercent, 25);

  const base = toBacktestStrategyProfile({
    ...initialSettings,
    minExecutionRatePercent: 80,
    trailingStopPercent: 5,
    timeDecayPerBarPercent: 0.5
  });
  const deRisked = buildBacktestDeRiskProfile(base, {
    score: 60,
    level: "wait",
    status: "WAIT",
    recommendation: "wait",
    reasons: [],
    canRunLive: false
  });
  assert.ok(deRisked.adjustments.some((line) => line.startsWith("最小成交率：")));
  assert.ok(deRisked.adjustments.some((line) => line.startsWith("追踪止损：")));
  assert.ok(deRisked.adjustments.some((line) => line.startsWith("时间衰减：")));
});
