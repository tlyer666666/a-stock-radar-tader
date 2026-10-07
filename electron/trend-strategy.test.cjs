"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateTrendStock, rankTrendCandidates, prefilterTrendStock } = require("./trend-screener-engine.cjs");
const strategy = require("./trend-strategy.cjs");

function fixture() {
  const dates = [];
  const day = new Date("2025-01-01T00:00:00Z");
  while (dates.length < 270) {
    if (![0, 6].includes(day.getUTCDay())) dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  const rawRows = dates.map((date, i) => {
    const close = Number((10 + i * 0.02).toFixed(2));
    return { date, open: close - 0.06, high: close + 0.12, low: close - 0.12, close,
      volume: 8_000_000, amount: 240_000_000 };
  });
  rawRows[263] = { ...rawRows[263], close: 15, high: 15.2, low: 14.9 };
  rawRows[264] = { ...rawRows[264], open: 15.9, high: 16.5, low: 15.8, close: 16.5,
    volume: 10_000_000, amount: 300_000_000 };
  for (let i = 265; i <= 268; i++) {
    rawRows[i] = { ...rawRows[i], open: 16, high: 16.3, low: 15.5, close: 16.1,
      volume: 5_000_000, amount: 220_000_000 };
  }
  rawRows[269] = { ...rawRows[269], open: 16.2, high: 16.5, low: 16.1, close: 16.45,
    volume: 8_000_000, amount: 260_000_000 };
  const benchmarkRows = dates.map((date, i) => {
    const close = 100 + i * 0.05;
    return { date, open: close - 0.02, high: close + 0.1, low: close - 0.1,
      close, volume: 1, amount: 1 };
  });
  return { security: { code: "600001", name: "质量样本", secid: "1.600001", assetType: "stock" },
    rawRows, adjustedRows: structuredClone(rawRows), benchmarkRows, asOf: dates.at(-1) };
}
const quality = (input, config) => strategy.evaluateTrendStrategy(input, { strategyId: "quality-v2", ...(config ? { config } : {}) });
const change = (input, index, values) => {
  Object.assign(input.rawRows[index], values);
  Object.assign(input.adjustedRows[index], values);
};

test("price-only benchmark preserves classic and quality output without weakening stock amount", () => {
  const input = fixture();
  const expected = ["classic-v1", "quality-v2"].map(strategyId => strategy.evaluateTrendStrategy(input, { strategyId }));
  input.benchmarkRows = input.benchmarkRows.map(row => ({ ...row, volume: null, amount: null }));
  for (const [i, strategyId] of ["classic-v1", "quality-v2"].entries()) {
    assert.deepEqual(strategy.evaluateTrendStrategy(input, { strategyId }), expected[i]);
  }
  input.rawRows.at(-1).amount = null;
  assert.equal(strategy.evaluateTrendStrategy(input).kind, "unavailable");
});

test("versioned strategy facade and shared prefilter are available", () => {
  assert.equal(typeof strategy.normalizeTrendStrategy, "function");
  assert.equal(typeof strategy.evaluateTrendStrategy, "function");
  assert.equal(typeof strategy.rankTrendStrategyCandidates, "function");
  assert.equal(typeof prefilterTrendStock, "function");
});

test("configuration is canonical, versioned, detached and strictly validated", () => {
  const defaultConfig = strategy.normalizeTrendStrategy({ strategyId: "quality-v2" });
  assert.equal(defaultConfig.id, "quality-v2");
  assert.equal(defaultConfig.version, "2.0.0");
  assert.deepEqual(defaultConfig.config, { maxExtensionAtr: 2, minCloseLocation: 0.7, maxVolumeRatio: 3 });
  assert.match(defaultConfig.configHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(strategy.normalizeTrendStrategy({ strategyId: "quality-v2", config: {
    maxVolumeRatio: 3, minCloseLocation: 0.7, maxExtensionAtr: 2
  } }), defaultConfig);
  assert.notEqual(strategy.normalizeTrendStrategy({ strategyId: "quality-v2", config: { maxExtensionAtr: 2.5 } }).configHash, defaultConfig.configHash);
  assert.deepEqual(strategy.normalizeTrendStrategy().config, {});
  assert.equal(strategy.normalizeTrendStrategy().version, "1.0.0");
  for (const options of [null, [], "quality-v2", { strategyId: "unknown" }, { forceRefresh: true },
    { strategyId: "classic-v1", config: { maxExtensionAtr: 2 } },
    ...[NaN, Infinity, "2", 0.49, 5.01].map(maxExtensionAtr => ({ strategyId: "quality-v2", config: { maxExtensionAtr } })),
    { strategyId: "quality-v2", config: { unknown: 1 } }, { strategyId: "quality-v2", config: null },
    { strategyId: "quality-v2", config: { minCloseLocation: 0.49 } },
    { strategyId: "quality-v2", config: { minCloseLocation: 0.96 } },
    { strategyId: "quality-v2", config: { maxVolumeRatio: 1.19 } },
    { strategyId: "quality-v2", config: { maxVolumeRatio: 6.01 } }]) {
    assert.throws(() => strategy.normalizeTrendStrategy(options), /策略|参数|配置/);
  }
});

test("classic facade preserves all existing output and ranking except its strategy snapshot", () => {
  for (const input of [fixture(), { ...fixture(), benchmarkRows: [] }, { ...fixture(), security: { ...fixture().security, name: "ST样本" } }]) {
    const actual = strategy.evaluateTrendStrategy(input);
    const expected = evaluateTrendStock(input);
    if (actual.candidate) {
      assert.equal(actual.candidate.strategy.id, "classic-v1");
      delete actual.candidate.strategy;
    }
    assert.deepEqual(actual, expected);
  }
  const rows = [
    { stage: "watch", security: { code: "600002" }, metrics: { relativeStrength20: 8, avgAmount20: 1 } },
    { stage: "signal", security: { code: "600001" }, metrics: { relativeStrength20: 4, avgAmount20: 1 } }
  ];
  assert.deepEqual(strategy.rankTrendStrategyCandidates(rows), rankTrendCandidates(rows));
});

test("quality signal exposes its exact primary pattern, risk interval and finite evidence", () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = quality(input);
  assert.equal(result.kind, "candidate");
  const candidate = result.candidate;
  assert.equal(candidate.stage, "signal");
  assert.deepEqual(candidate.patterns, ["A", "B"]);
  assert.equal(candidate.primaryPattern, "A");
  assert.equal(candidate.strategy.id, "quality-v2");
  assert.equal(candidate.plan.stop, 15.8);
  assert.equal(candidate.plan.minEntry, 16.31);
  assert.equal(candidate.plan.maxEntry, 16.7);
  assert.ok(candidate.plan.stop < candidate.plan.minEntry && candidate.plan.minEntry <= candidate.plan.maxEntry);
  assert.ok(candidate.plan.maxRiskPercent <= 8);
  assert.ok(candidate.quality.atr14Previous > 0);
  assert.ok(candidate.quality.extensionAtr <= 2);
  assert.ok(candidate.quality.closeLocation >= 0.7);
  assert.equal(candidate.quality.holdingMa20Count, 3);
  assert.ok(candidate.evidence.some(row => row.label === "质量版入场区间" && row.passed));
  assert.deepEqual(input, before);
});

test("quality vetoes never keep a plan or borrow B when primary A fails", () => {
  const cases = [
    ["ATR偏离", input => change(input, 269, { close: 16.6, high: 16.7 })],
    ["收盘位置", input => change(input, 269, { high: 17.1 })],
    ["信号量比", input => change(input, 269, { volume: 30_000_000 })],
    ["A三日突破", input => change(input, 267, { high: 16.48 })],
    ["21日复权口径", input => { for (const key of ["open", "high", "low", "close"]) input.adjustedRows[249][key] *= 0.95; }]
  ];
  for (const [label, edit] of cases) {
    const input = fixture(); edit(input);
    assert.equal(evaluateTrendStock(input).candidate.stage, "signal", label);
    const candidate = quality(input).candidate;
    assert.equal(candidate.stage, "watch", label);
    assert.equal(candidate.plan, null, label);
    assert.ok(candidate.evidence.some(row => row.label === label && !row.passed), label);
  }
});

test("B-only signals use the consolidation breakout and retain B risk basis", () => {
  const input = fixture();
  for (let i = 266; i <= 268; i++) change(input, i, { volume: 7_500_000 });
  change(input, 269, { volume: 10_000_000 });
  const result = quality(input);
  assert.equal(result.candidate.stage, "signal");
  assert.deepEqual(result.candidate.patterns, ["B"]);
  assert.equal(result.candidate.primaryPattern, "B");
  assert.equal(result.candidate.plan.minEntry, 16.31);
});

test("today's wider range cannot increase previous ATR or the extension allowance", () => {
  const input = fixture();
  const normal = quality(input).candidate;
  change(input, 269, { high: 19, low: 14.9 });
  const wide = quality(input).candidate;
  assert.equal(wide.quality.atr14Previous, normal.quality.atr14Previous);
  assert.equal(wide.quality.extensionAtr, normal.quality.extensionAtr);
  assert.equal(wide.stage, "watch");
  assert.equal(wide.plan, null);
});

test("trend, relative strength, MA support, noise-stop and empty-entry gates all veto plans", () => {
  const cases = [
    ["MA60方向", input => {
      for (let i = 205; i < 210; i++) change(input, i, { open: 19.5, close: 19.5, high: 19.6, low: 19.4 });
    }],
    ["相对强度", input => Object.assign(input.benchmarkRows.at(-1), { open: 125, close: 125, high: 125.1, low: 124.9 })],
    ["三日均线承接", input => {
      change(input, 264, { low: 15 });
      for (const i of [266, 267]) change(input, i, { open: 15.2, close: 15.2, low: 15.1 });
    }],
    ["止损波动距离", input => {
      change(input, 264, { low: 16.1, open: 16.2 });
      change(input, 269, { close: 16.31, high: 16.32 });
    }],
    ["质量版入场区间", input => {
      change(input, 264, { low: 15 });
      for (let i = 266; i < 269; i++) change(input, i, { low: 15.1 });
    }]
  ];
  for (const [label, edit] of cases) {
    const input = fixture(); edit(input);
    assert.equal(evaluateTrendStock(input).candidate.stage, "signal", label);
    const candidate = quality(input).candidate;
    assert.equal(candidate.stage, "watch", label);
    assert.equal(candidate.plan, null, label);
    assert.ok(candidate.evidence.some(row => row.label === label && !row.passed), label);
  }
});

test("dual-pattern A-first stop cannot bypass a failed A median-volume check using B", () => {
  const input = fixture();
  for (let i = 249; i < 264; i++) change(input, i, { volume: 6_000_000 });
  change(input, 265, { volume: 1_000_000 });
  for (let i = 266; i < 269; i++) change(input, i, { volume: 6_500_000 });
  const base = evaluateTrendStock(input).candidate;
  assert.deepEqual(base.patterns, ["A", "B"]);
  assert.equal(base.stage, "signal");
  const candidate = quality(input).candidate;
  assert.equal(candidate.primaryPattern, "A");
  assert.equal(candidate.evidence.find(row => row.label === "A常态缩量").passed, false);
  assert.equal(candidate.evidence.find(row => row.label === "B常态缩量").passed, true);
  assert.equal(candidate.stage, "watch");
  assert.equal(candidate.plan, null);
});

test("B requires both a normal-volume consolidation and bounded prior-ATR width", () => {
  for (const gate of ["B常态缩量", "B波动宽度"]) {
    const input = fixture();
    for (let i = 266; i <= 268; i++) change(input, i, { volume: 7_500_000 });
    change(input, 269, { volume: 10_000_000 });
    if (gate === "B常态缩量") {
      for (let i = 249; i < 264; i++) change(input, i, { volume: 6_000_000 });
    } else {
      for (let i = 249; i < 264; i++) {
        const close = input.rawRows[i].close;
        change(input, i, { open: close, high: close + 0.01, low: close - 0.01 });
      }
      change(input, 265, { low: 14.9 });
      for (let i = 266; i <= 268; i++) change(input, i, { low: 16.05, high: 16.15, open: 16.1 });
    }
    const base = evaluateTrendStock(input).candidate;
    assert.equal(base.stage, "signal", gate);
    assert.deepEqual(base.patterns, ["B"], gate);
    const candidate = quality(input).candidate;
    assert.equal(candidate.evidence.find(row => row.label === gate).passed, false, gate);
    assert.equal(candidate.stage, "watch", gate);
    assert.equal(candidate.plan, null, gate);
  }
});

test("zero previous ATR and zero signal range fail closed with finite quality metrics", () => {
  const zeroAtr = fixture();
  for (let i = 254; i <= 268; i++) change(zeroAtr, i, { open: 16, close: 16, high: 16, low: 16 });
  zeroAtr.rawRows[255].upperLimit = 16;
  change(zeroAtr, 269, { open: 16, close: 16.05, high: 16.05, low: 16 });
  const zeroRange = fixture();
  change(zeroRange, 269, { open: 16.45, high: 16.45, low: 16.45 });
  for (const input of [zeroAtr, zeroRange]) {
    const candidate = quality(input).candidate;
    assert.equal(candidate.stage, "watch");
    assert.equal(candidate.plan, null);
    assert.ok(Object.values(candidate.quality).every(value => typeof value !== "number" || Number.isFinite(value)));
  }
  assert.equal(quality(zeroAtr).candidate.quality.atr14Previous, 0);
});

test("strictly positive unrounded relative strength is not lost to display rounding", () => {
  const input = fixture();
  const stockReturn = input.rawRows.at(-1).close / input.rawRows.at(-21).close - 1;
  const close = input.benchmarkRows.at(-21).close * (1 + stockReturn - 0.00003);
  Object.assign(input.benchmarkRows.at(-1), { open: close, close, high: close + 0.1, low: close - 0.1 });
  assert.equal(evaluateTrendStock(input).candidate.metrics.relativeStrength20, 0);
  assert.equal(quality(input).candidate.quality.relativeStrengthPositive, true);
});

test("future rows, input ordering and unknown benchmark cannot improve historical signals", () => {
  const input = fixture();
  const expected = quality(input);
  const future = { ...input.rawRows.at(-1), date: "2027-01-04", close: 20, high: 20, low: 1 };
  input.rawRows.push(future); input.adjustedRows.push({ ...future }); input.benchmarkRows.push({ ...future });
  input.rawRows.reverse(); input.adjustedRows.reverse(); input.benchmarkRows.reverse();
  assert.deepEqual(quality(input), expected);
  const unknown = quality({ ...fixture(), benchmarkRows: [] }).candidate;
  assert.equal(unknown.stage, "watch"); assert.equal(unknown.plan, null);
});

test("quality ranking prioritizes signal then strength then extension, deterministically", () => {
  const row = (code, stage, rs, extension, amount = 1) => ({ security: { code }, stage,
    metrics: { relativeStrength20: rs, avgAmount20: amount }, quality: { extensionAtr: extension } });
  const rows = [row("600005", "watch", 99, 0), row("600004", "signal", null, 0),
    row("600003", "signal", 5, 2), row("600002", "signal", 5, 1), row("600001", "signal", 5, 1)];
  const order = strategy.rankTrendStrategyCandidates(rows, { strategyId: "quality-v2" });
  assert.deepEqual(order.map(row => row.security.code), ["600001", "600002", "600003", "600004", "600005"]);
  assert.equal(rows[0].security.code, "600005");
});

test("raw prefilter keeps all valid classic candidates and rejects only necessary raw conditions", () => {
  assert.equal(prefilterTrendStock(fixture()), null);
  const noLimit = fixture();
  noLimit.rawRows[264].noPriceLimit = true;
  assert.equal(evaluateTrendStock(noLimit).kind, "excluded");
  assert.equal(prefilterTrendStock(noLimit).kind, "excluded");
  const illiquid = fixture();
  for (const row of illiquid.rawRows.slice(-20)) row.amount = 150_000_000;
  assert.equal(prefilterTrendStock(illiquid).kind, "excluded");
  const invalid = fixture(); invalid.rawRows[264].changePct = 2;
  assert.equal(prefilterTrendStock(invalid).kind, "unavailable");
  const missing = fixture(); missing.rawRows.splice(266, 1);
  assert.equal(prefilterTrendStock(missing).kind, "unavailable");
  const malformed = fixture(); malformed.rawRows[100].amount = NaN;
  assert.equal(prefilterTrendStock(malformed).kind, "unavailable");
});
