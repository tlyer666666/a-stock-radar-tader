"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./strategy-signal-engine.cjs");
const indicators = require("./trend-indicators.cjs");
const combinations = require("./strategy-signal-combinations.cjs");
const { trendMath } = require("./trend-screener-engine.cjs");
const { simulateStrategyPortfolio } = require("./portfolio-backtest.cjs");
const dates = Array.from({ length: 100 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
const history = () => dates.map(date => ({ date, open: 10, high: 10.2, low: 9.8, close: 10, volume: 10000, amount: 100000 }));
function replay(rows, indices = [25], extra = {}) {
  return engine.__test.replayStrategy({ id: "audit", matches: feature => feature.hit === true }, "600001", "审计样本", rows,
    new Map(rows.map(row => [row.date, row])), engine.__test.resolvedOptions({ horizonDays: 3, cooldownDays: 5, ...extra }),
    { featureTimeline: rows.map((_, i) => ({ hit: indices.includes(i) })) });
}
const sample = (code, netReturn = 0) => ({ code, signalDate: dates[0], entryDate: dates[1], exitDate: dates[3], netReturn });
const benchmark = () => dates.map(date => ({ date, open: 100, close: 100 }));

test("opening auction at upper limit remains untradeable when the price falls later", () => {
  const rows = history(); Object.assign(rows[26], { open: 11, high: 11, low: 9, close: 10 });
  const result = replay(rows);
  assert.equal(result.samples.length, 0);
  assert.equal(result.rejectedSignals[0].reason, "nextDayOnePriceLimitUp");
});
test("a rejected entry does not consume the signal cooldown", () => {
  const rows = history(); Object.assign(rows[26], { open: 11, high: 11, low: 11, close: 11 });
  const result = replay(rows, [25, 27]);
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].signalDate, dates[27]);
});
test("no volume blocks an entry even when the OHLC prices are not flat", () => {
  const rows = history(); rows[26].volume = 0;
  assert.equal(replay(rows).rejectedSignals[0]?.reason, "suspendedOrNoLiquidity");
});
test("a closing limit-down or suspension delays settlement to the next tradable close", () => {
  const rows = history(); Object.assign(rows[28], { open: 9, high: 9, low: 9, close: 9 });
  Object.assign(rows[29], { open: 9, high: 9, low: 9, close: 9, volume: 0 });
  Object.assign(rows[30], { open: 9.5, high: 9.6, low: 9.4, close: 9.5 });
  assert.equal(replay(rows).samples[0].exitDate, dates[30]);
});
test("an exit beyond the requested right boundary remains pending", () => {
  const result = replay(history(), [25], { signalTo: dates[27] });
  assert.equal(result.samples.length, 0);
  assert.equal(result.pendingSignals[0]?.reason, "pending_exit_horizon");
});
test("a reported return inconsistent with raw closes cannot settle a fictitious corporate-action loss", () => {
  const rows = history();
  for (let i = 27; i < rows.length; i++) Object.assign(rows[i], { open: 5, high: 5.1, low: 4.9, close: 5 });
  rows[27].changePct = 0;
  const result = replay(rows);
  assert.equal(result.samples.length, 0);
  assert.equal(result.pendingSignals[0]?.reason, "corporate_action_unresolved");
});
test("unresolved corporate-action history does not feed raw cross-period signal indicators", () => {
  const rows = history();
  for (let i = 65; i < rows.length; i++) Object.assign(rows[i], { open: 5, high: 5.1, low: 4.9, close: 5 });
  rows[65].changePct = 0;
  assert.equal(engine.__test.buildFeatureTimeline(rows, "600001", "审计样本", rows).at(-1), null);
});
test("overlapping five-day cohorts cannot compound five full account returns in one week", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ code: "600001", signalDate: dates[i], entryDate: dates[i + 1], exitDate: dates[i + 5], netReturn: -10, grossReturn: -10 }));
  const summary = engine.summarizeSamples(rows);
  assert.ok(summary.maxDrawdown >= -10.001, String(summary.maxDrawdown));
});
test("flat samples remain flat and an all-winning profit factor has an explicit JSON-safe status", () => {
  const summary = engine.summarizeSamples([{ signalDate: dates[0], netReturn: 0 }, { signalDate: dates[1], netReturn: 2 }]);
  assert.equal(summary.lossCount, 0);
  assert.equal(summary.flatCount, 1);
  assert.equal(summary.profitFactor, null);
  assert.equal(summary.profitFactorStatus, "no_losses");
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
});
test("MACD missing observations remain missing rather than null subtraction becoming zero", () => {
  const result = indicators.macd([null, 10, null, 11]);
  assert.equal(result.dif[0], null); assert.equal(result.dea[0], null); assert.equal(result.histogram[2], null);
});
test("a valid one-price session contributes zero EOM instead of poisoning fourteen later sessions", () => {
  const rows = history().slice(0, 30); Object.assign(rows[20], { open: 10, high: 10, low: 10, close: 10 });
  assert.equal(indicators.emv(rows, 14).at(-1), 0);
});
test("ATR fails closed for histories shorter than fifteen observations", () => {
  assert.equal(trendMath.atr14(history().slice(0, 14)), null);
});
test("indicator confirmation cannot rise against an unavailable prior RSI", () => {
  const rows = history().slice(0, 15);
  for (let i = 0; i < rows.length; i++) rows[i].close = 10 + (i % 2 ? .1 : 0);
  rows.at(-1).close = 10.15;
  const prepared = combinations.prepareCombinationTimeline(rows, "600001", "审计样本", rows);
  assert.equal(prepared.at(-1).confirmations.limit_rsi_pullback_resonance, false);
});
test("STAR orders require 200 shares while permitting single-share increments above that", () => {
  const small = simulateStrategyPortfolio([{ ...sample("688001"), roundTripCostBps: 0 }], { "688001": history() }, benchmark(), { startingCapital: 1500, maxPositions: 1 });
  assert.equal(small.trades.length, 0);
  const large = simulateStrategyPortfolio([{ ...sample("688001"), roundTripCostBps: 0 }], { "688001": history() }, benchmark(), { startingCapital: 2010, maxPositions: 1 });
  assert.equal(large.trades[0]?.shares, 201);
  const withFees = simulateStrategyPortfolio([sample("688001")], { "688001": history() }, benchmark(), { startingCapital: 2010, maxPositions: 1 });
  assert.equal(withFees.trades[0]?.shares, 200, "cash must cover both shares and buy costs");
});
test("entry mark-to-market includes the buy side of sample transaction costs", () => {
  const result = simulateStrategyPortfolio([{ ...sample("600001", -2), roundTripCostBps: 200, grossReturn: 0 }], { "600001": history() }, benchmark(), { startingCapital: 20000, maxPositions: 1 });
  assert.ok(result.equityCurve[1].equity < 20000);
  assert.equal(result.metrics.endingCapital, 19620);
});
test("shared account freezes unresolved held price basis without erasing the prior entry", () => {
  const rows = history(); Object.assign(rows[2], { open: 5, close: 5, high: 5.1, low: 4.9, changePct: 0 });
  const result = simulateStrategyPortfolio([{ ...sample("600001", -50), roundTripCostBps: 0 }], { "600001": rows }, benchmark(), { startingCapital: 20000, maxPositions: 1 });
  assert.equal(result.trades.length, 0);
  assert.equal(result.rejections.length, 0);
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0].reason, "corporate_action_unresolved");
  assert.equal(result.holdings[0].lastMarkPrice, 10);
  assert.equal(result.metrics.valuationComplete, false);
  assert.equal(result.metrics.endingCash, 0);
});

test("combination configuration controls technical thresholds rather than merely appearing in metadata", () => {
  const catalog = require("../config/strategy-signal-combinations.json");
  const entry = catalog.find(row => row.id === "limit_rsi_pullback_resonance");
  const previous = entry.parameters.rsiThreshold;
  const rows = history();
  rows.forEach((row, i) => { row.close = 10 + i * .01 + (i % 2 ? .05 : 0); });
  try {
    entry.parameters.rsiThreshold = 101;
    assert.equal(combinations.prepareCombinationTimeline(rows, "600001", "审计样本", rows).at(-1).confirmations.limit_rsi_pullback_resonance, false);
  } finally { entry.parameters.rsiThreshold = previous; }
});

test("walk-forward aggregate training purges trades whose exits cross into the first test date", () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({ code: "600001", signalDate: dates[i], entryDate: dates[i + 1], exitDate: dates[i + 5], netReturn: 2, excessReturn: 1, holdingTradingDays: 5 }));
  const result = engine.__test.buildWalkForward(samples, engine.__test.resolvedOptions({ minSamples: 30, outOfSampleRatio: .5, minOutOfSampleSamples: 9 }));
  assert.equal(result.available, true);
  assert.equal(result.initialTraining.sampleCount, 15);
  assert.equal(result.purgedInitialTrainingSamples, 5);
});
test("confidence lower bound uses the same sample weighting as its displayed mean", () => {
  const samples = Array.from({ length: 30 }, (_, i) => ({ signalDate: dates[i], entryDate: dates[i + 1], exitDate: dates[i + 2], holdingTradingDays: 2, code: "600001", netReturn: 1 }));
  samples.push(...Array.from({ length: 20 }, (_, i) => ({ signalDate: dates[0], code: String(i), holdingTradingDays: 2, netReturn: 10 })));
  const summary = engine.summarizeSamples(samples);
  assert.equal(summary.averageReturn, 4.6);
  assert.equal(summary.effectiveIndependentSamples, 15);
  // C-06：原断言 -0.935 编码了错误行为——持有期重叠被惩罚了两次：
  // 标准误里乘 √H（H=2），自由度又按 floor(30/2)=15 折减。
  // 与 confidenceMethod「信号日聚类标准误，按平均持有期折减自由度」对齐后只剩自由度折减：
  // 聚类稳健 SE = 2.16，均值 4.6，t(14)=1.812 → 4.6 - 1.812×2.16 = 0.686。
  assert.equal(summary.averageReturnLowerBound95, 0.686);
});
test("quality strategy presets load the shipped balanced configuration", () => {
  const { normalizeTrendStrategy } = require("./trend-strategy.cjs");
  const got = normalizeTrendStrategy({ strategyId: "quality-v2", preset: "balanced" });
  assert.deepEqual(got.config, { maxExtensionAtr: 2.5, minCloseLocation: .65, maxVolumeRatio: 3.5 });
});

test("single-stock replay bundle reuses normalized prices and features across its selected strategies", () => {
  const ids = engine.STRATEGY_DEFINITIONS.filter(row => row.type !== "composite").slice(0, 4).map(row => row.id);
  let reads = 0;
  const rows = history().map(row => ({ ...row, get close() { reads++; return row.close; } }));
  const security = { code: "600001", name: "复用样本" };
  const expected = { replay: engine.buildSelectedStrategyReplay(ids, security, rows, history()), replaysById: {} };
  for (const id of ids) expected.replaysById[id] = engine.buildSelectedStrategyReplay([id], security, rows, history());
  const naiveReads = reads; reads = 0;
  const result = engine.buildSelectedStrategyReplayBundle(ids, security, rows, history());
  assert.deepEqual(result, expected);
  assert.ok(reads <= naiveReads / 3, `${reads}/${naiveReads}`);
});
