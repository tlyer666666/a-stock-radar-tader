"use strict";

require("../qa/test-env.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const services = require("./services.cjs");
const securityAnalysis = require("./services/security-analysis.cjs");

test("security-analysis exposes non-empty pattern catalog and deterministic ATR/plan gating", () => {
  const ids = services.getStrategyPatternIds();
  assert.ok(ids instanceof Set && ids.size > 0);

  const history = Array.from({ length: 20 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    open: 10 + i * 0.1,
    high: 10.6 + i * 0.1,
    low: 9.6 + i * 0.1,
    close: 10.2 + i * 0.1,
    volume: 100000
  }));

  assert.equal(securityAnalysis.calculateAtr(history.slice(0, 10), 14), null);
  const atr = securityAnalysis.calculateAtr(history, 14);
  assert.ok(Number.isFinite(atr) && atr > 0);
  assert.equal(securityAnalysis.clampScore(150), 100);
  assert.equal(securityAnalysis.clampScore("bad", 5, 95), 5);
  assert.ok(securityAnalysis.movingAverage(history, 5) > 0);

  const analysis = {
    mrs: 84,
    exactNode: true,
    alertQualified: true,
    strategyQualified: true,
    riskPenalty: 5,
    qualification: { riskVetoPassed: true },
    historicalEdge: { passed: true }
  };
  const plan = securityAnalysis.buildTradePlan(
    analysis,
    { latest: 12.1, open: 12.0, preClose: 11.9 },
    history,
    { stopLossATRMultiple: 2, takeProfitATRMultiple: 4, maxRiskPerTradePercent: 1, maxPositionPercent: 30, maxHoldingBars: 20 }
  );
  assert.equal(plan.signal, "BUY_AGGRESSIVE");
  assert.ok(plan.stopLossPrice < plan.entryPrice);
  assert.ok(plan.takeProfitPrice > plan.entryPrice);
});

test("buildTradeExecutionReadiness enforces blockers vs warnings accurately", () => {
  const blocked = services.buildTradeExecutionReadiness(
    {
      mrs: 60,
      riskPenalty: 40,
      qualification: { riskVetoPassed: false },
      historicalEdge: { passed: false, passReason: "收益不足" }
    },
    { signal: "WAIT", positionSizePercent: 0, executionFillRatePercent: 50, killSwitchTriggered: true, riskReward: 1.0 },
    { minExecutionRatePercent: 85 }
  );
  assert.equal(blocked.level, "block");
  assert.equal(blocked.status, "BLOCK");
  assert.equal(blocked.canExecute, false);
  assert.ok(blocked.reasons.length >= 4);

  const passed = services.buildTradeExecutionReadiness(
    {
      mrs: 85,
      riskPenalty: 5,
      qualification: { riskVetoPassed: true },
      historicalEdge: { passed: true }
    },
    { signal: "BUY", positionSizePercent: 15, executionFillRatePercent: 98, killSwitchTriggered: false, riskReward: 2.0 },
    { minExecutionRatePercent: 85 }
  );
  assert.equal(passed.level, "pass");
  assert.equal(passed.status, "PASS");
  assert.equal(passed.canExecute, true);
});

test("edgeGateFromStats evaluates sample thresholds, win rate, average return, and strictGate", () => {
  const weak = services.edgeGateFromStats({
    stats: [{ id: "currentCombination", sampleCount: 15, winRate5: 40, average5: 0.1, worstMdd5: -25, confidence: "低" }]
  });
  assert.equal(weak.passed, false);
  assert.ok(weak.penalty > 0);
  assert.ok(weak.reasons.length >= 1);

  const poorStats = services.edgeGateFromStats(
    { stats: [{ id: "currentCombination", sampleCount: 40, winRate5: 40, average5: 0.1, worstMdd5: -25, confidence: "中" }] },
    { minimumSamples: 30, strictGate: true }
  );
  assert.equal(poorStats.passed, false);
  assert.ok(poorStats.reasons.length >= 4);

  const strong = services.edgeGateFromStats(
    { stats: [{ id: "currentCombination", sampleCount: 80, winRate5: 65, average5: 1.5, worstMdd5: -6, confidence: "高" }] },
    { minimumSamples: 30, strictGate: true }
  );
  assert.equal(strong.passed, true);
  assert.equal(strong.penalty, 0);
});
