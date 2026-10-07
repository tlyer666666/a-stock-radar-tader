"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { evaluateTrendStrategies } = require("./trend-strategy-evaluator.cjs");

function fixture(count = 310) {
  const calendar = [];
  const day = new Date("2025-01-01T00:00:00Z");
  while (calendar.length < count) {
    if (![0, 6].includes(day.getUTCDay())) calendar.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  const rawRows = calendar.map((date, i) => {
    const close = Number((i < 270 ? 10 + i * 0.02 : 16.5 + (i - 270) * 0.04).toFixed(2));
    return { date, open: close, high: close + 0.12, low: close - 0.12, close,
      volume: 8e6, amount: 24e7, isST: false };
  });
  rawRows[263] = { ...rawRows[263], open: 15, close: 15, high: 15.2, low: 14.9 };
  rawRows[264] = { ...rawRows[264], open: 15.9, high: 16.5, low: 15.8, close: 16.5, volume: 1e7, amount: 3e8 };
  for (let i = 265; i <= 268; i++) rawRows[i] = { ...rawRows[i], open: 16, high: 16.3, low: 15.5, close: 16.1, volume: 5e6, amount: 22e7 };
  rawRows[269] = { ...rawRows[269], open: 16.2, high: 16.5, low: 16.1, close: 16.45, volume: 8e6, amount: 26e7 };
  for (let i = 1; i < rawRows.length; i++) {
    rawRows[i].upperLimit = Math.round(rawRows[i - 1].close * 110) / 100;
    rawRows[i].lowerLimit = Math.round(rawRows[i - 1].close * 90) / 100;
  }
  const benchmarkRows = calendar.map((date, i) => ({ date, open: 100 + i * .05, close: 100 + i * .05,
    high: 100.1 + i * .05, low: 99.9 + i * .05, volume: 1, amount: 1 }));
  return { schemaVersion: 1, sourceClass: "synthetic", source: "test-only fictional weekday bars",
    universeMode: "selected", historicalStatusComplete: true, calendar, benchmarkRows,
    securities: [{ security: { code: "600001", secid: "1.600001", name: "虚构样本", assetType: "stock" },
      statusHistory: [{ date: calendar[0], name: "虚构样本", isST: false, listed: true, minimumBuyQuantity: 100, quantityStep: 100 }],
      rawRows, adjustedRows: structuredClone(rawRows) }] };
}
function setBar(data, index, fields) {
  Object.assign(data.securities[0].rawRows[index], fields);
  Object.assign(data.securities[0].adjustedRows[index], fields);
}
function run(data = fixture(), options = {}) {
  return evaluateTrendStrategies({ dataset: data, from: data.calendar[269], splitDate: data.calendar[269],
    to: data.calendar.at(-1), execution: { slippageBps: 0 }, ...options });
}
function first(report, mode = "baseline") { return report[mode].samples.find(x => x.signalDate === report.range.from); }

test("signals enter at next open and remain censored without inventing a future exit", () => {
  const data = fixture(); const report = run(data, { to: data.calendar[270] });
  for (const mode of ["baseline", "advanced"]) {
    const sample = first(report, mode);
    assert.equal(sample.entryDate, data.calendar[270]);
    assert.equal(sample.entryPrice, 16.5);
    assert.equal(sample.status, "censored");
    assert.equal(sample.netReturnPercent, null);
    assert.ok(report[mode].metrics.censored >= 1);
  }
  assert.equal(report.qualification.returnSuperiorityVerified, false);
  assert.equal(report.qualification.status, "SYNTHETIC_MECHANICS_ONLY");
  assert.equal("sharpe" in report.baseline.metrics, false);
});

test("future stock benchmark and status data cannot change past samples or fills", () => {
  const data = fixture(); const to = data.calendar[271]; const original = run(data, { to });
  for (let i = 272; i < data.calendar.length; i++) {
    setBar(data, i, { open: 500, high: 600, low: 1, close: 300 });
    data.benchmarkRows[i].close = -99;
  }
  data.securities[0].statusHistory.push({ date: data.calendar[272], name: "*ST未来", isST: true, listed: false });
  const changed = run(data, { to });
  assert.deepEqual(changed.baseline, original.baseline);
  assert.deepEqual(changed.advanced, original.advanced);
});

test("a buy at the opening upper limit is rejected even if trading opens later", () => {
  const data = fixture(); setBar(data, 270, { open: 18.1, high: 18.1, low: 16, close: 17 });
  const sample = first(run(data));
  assert.equal(sample.status, "rejected");
  assert.equal(sample.reason, "opening_upper_limit");
  assert.equal(sample.entryPrice, null);
});

test("frozen minEntry and maxEntry reject opening prices outside the plan", () => {
  const low = fixture(); setBar(low, 270, { open: 16.2, low: 16.1 });
  assert.equal(first(run(low), "advanced").reason, "outside_entry_range");
  const high = fixture(); setBar(high, 270, { open: 17, high: 17.1 });
  assert.equal(first(run(high)).reason, "outside_entry_range");
});

test("close stop exits next open with actual fees and no same-day sale", () => {
  const data = fixture(); setBar(data, 270, { open: 16.5, low: 15.6, close: 15.7 });
  setBar(data, 271, { open: 15.5, high: 16, low: 15.4, close: 15.7, upperLimit: 17.27, lowerLimit: 14.13 });
  const sample = first(run(data, { execution: { notional: 1650, slippageBps: 0, commissionBps: 0, minCommission: 5, sellTaxBps: 10, transferFeeBps: 0 } }));
  assert.equal(sample.status, "closed"); assert.equal(sample.entryDate, data.calendar[270]);
  assert.equal(sample.exitDate, data.calendar[271]); assert.equal(sample.exitPrice, 15.5);
  assert.equal(sample.shares, 100); assert.equal(sample.entryCost, 1655); assert.equal(sample.exitProceeds, 1543.45);
  assert.ok(Math.abs(sample.netReturnPercent - (-6.740181)) < .00001);
  assert.ok(Math.abs(sample.maxAdverseExcursionPercent - (-6.060606)) < .00001);
});

test("lower-limit exits wait without consuming the later day's intraday low", () => {
  const data = fixture(); setBar(data, 270, { low: 15.6, close: 15.7 });
  setBar(data, 271, { open: 14.13, high: 14.13, low: 14.13, close: 14.13, upperLimit: 17.27, lowerLimit: 14.13 });
  setBar(data, 272, { open: 14.5, high: 15, low: 13, close: 14, upperLimit: 15.54, lowerLimit: 12.72 });
  const sample = first(run(data));
  assert.equal(sample.exitDate, data.calendar[272]); assert.equal(sample.delayedExitSessions, 1);
  assert.ok(Math.abs(sample.maxAdverseExcursionPercent - (-14.363636)) < .00001);
});

test("day 29 close schedules an exit at holding day 30 open", () => {
  const data = fixture(); const sample = first(run(data));
  assert.equal(sample.exitReason, "maximum_holding_period");
  assert.equal(sample.exitDate, data.calendar[299]); assert.equal(sample.holdingTradingDays, 30);
});

test("two closes below their contemporaneous MA20 exit next open even above the stop", () => {
  const data = fixture();
  setBar(data, 284, { open: 16.1, low: 15.95, close: 16, high: 16.2 });
  setBar(data, 285, { open: 16.1, low: 15.95, close: 16, high: 16.2, lowerLimit: 14.4, upperLimit: 17.6 });
  setBar(data, 286, { open: 16.1, low: 15.95, close: 16, high: 16.2, lowerLimit: 14.4, upperLimit: 17.6 });
  const sample = first(run(data));
  assert.equal(sample.exitReason, "two_closes_below_ma20");
  assert.equal(sample.exitDate, data.calendar[286]);
});

test("slippage is adverse on both fills and entry cost includes commission", () => {
  const data = fixture(); setBar(data, 270, { low: 15.6, close: 15.7 });
  setBar(data, 271, { open: 15.5, high: 16, low: 15.4, close: 15.7, upperLimit: 17.27, lowerLimit: 14.13 });
  const sample = first(run(data, { execution: { notional: 2000, slippageBps: 10, commissionBps: 0, minCommission: 5, sellTaxBps: 0, transferFeeBps: 0 } }));
  assert.equal(sample.entryPrice, 16.52); assert.equal(sample.exitPrice, 15.48);
  assert.equal(sample.entryCost, 1657); assert.equal(sample.exitProceeds, 1543);
});

test("missing next-day bars do not defer buying to a later stock bar", () => {
  const data = fixture(); data.securities[0].rawRows.splice(270, 1); data.securities[0].adjustedRows.splice(270, 1);
  const sample = first(run(data)); assert.equal(sample.status, "unresolved");
  assert.equal(sample.reason, "missing_entry_bar"); assert.equal(sample.entryDate, null);
});

test("explicit suspension delays an exit but unknown missing held bars stay unresolved", () => {
  const data = fixture(); setBar(data, 270, { low: 15.6, close: 15.7 });
  setBar(data, 271, { volume: 0, amount: 0, suspended: true });
  assert.equal(first(run(data)).exitDate, data.calendar[272]);
  data.securities[0].rawRows.splice(271, 1); data.securities[0].adjustedRows.splice(271, 1);
  assert.equal(first(run(data)).status, "unresolved");
});

test("unknown official limits and corporate-action changes cannot produce completed returns", () => {
  const limits = fixture(); delete limits.securities[0].rawRows[270].upperLimit;
  assert.equal(first(run(limits)).reason, "unknown_price_limits");
  const action = fixture(); action.securities[0].adjustedRows[271].close /= 2;
  action.securities[0].adjustedRows[271].low /= 2;
  action.securities[0].adjustedRows[271].high /= 2;
  action.securities[0].adjustedRows[271].open /= 2;
  const sample = first(run(action)); assert.equal(sample.status, "unresolved");
  assert.equal(sample.reason, "corporate_action_unresolved"); assert.equal(sample.netReturnPercent, null);
});

test("raw OHLC crossing a provided price limit rejects the input unless limits are explicitly disabled", () => {
  for (const [fields, bound] of [
    [{ low: 1, close: 1 }, "lowerLimit"],
    [{ high: 20, close: 20 }, "upperLimit"],
    [{ open: 20, high: 20 }, "upperLimit"]
  ]) {
    const data = fixture(); setBar(data, 270, fields);
    assert.throws(() => run(data, { to: data.calendar[270] }), new RegExp(bound));
    setBar(data, 270, { noPriceLimit: true });
    assert.doesNotThrow(() => run(data, { to: data.calendar[270] }));
  }
});

test("two-decimal adjusted OHLC rounding remains unresolved and identifies precision uncertainty", () => {
  const data = fixture();
  for (const row of data.securities[0].adjustedRows) {
    for (const key of ["open", "high", "low", "close"]) row[key] = Math.round(row[key] / 1.234 * 100) / 100;
  }
  const report = run(data, { to: data.calendar[270] });
  const sample = first(report);
  assert.equal(sample.status, "unresolved");
  assert.equal(sample.reason, "corporate_action_unresolved");
  assert.match(sample.reasonText, /精度|舍入/);
  assert.equal(sample.netReturnPercent, null);
});

test("development exits never borrow test-period prices and states are selected as of signal day", () => {
  const data = fixture(); data.securities[0].security.name = "*ST未来名称";
  const report = run(data, { splitDate: data.calendar[271] });
  assert.equal(report.baseline.development.samples[0].status, "censored");
  assert.equal(report.baseline.development.samples[0].exitDate, null);
  assert.ok(report.baseline.samples.every(sample => sample.signalDate >= data.calendar[271]));
  const unchanged = structuredClone(report.baseline.development);
  setBar(data, 271, { open: 40, low: 30, high: 50, close: 45, upperLimit: 60, lowerLimit: 20 });
  assert.deepEqual(run(data, { splitDate: data.calendar[271] }).baseline.development, unchanged);
});

test("a last-day signal remains pending and no-trade metrics are null", () => {
  const data = fixture(); const report = run(data, { to: data.calendar[269] });
  assert.equal(first(report).status, "pending"); assert.equal(report.baseline.metrics.closed, 0);
  assert.equal(report.baseline.metrics.meanNetReturnPercent, null);
  assert.equal(report.baseline.metrics.winRatePercent, null);
});

test("malformed calendars ambiguous status and invalid execution settings are rejected", () => {
  const data = fixture(); data.calendar.push(data.calendar.at(-1));
  assert.throws(() => run(data), /calendar/);
  assert.throws(() => run(fixture(), { execution: { slippageBps: -1 } }), /slippageBps/);
  assert.throws(() => run(fixture(), { splitDate: "2020-01-01" }), /splitDate/);
});

test("real current-survivor input remains diagnostic instead of claiming verified superiority", () => {
  const data = fixture(); data.sourceClass = "real"; data.universeMode = "current-survivors";
  const report = run(data); assert.equal(report.qualification.status, "REAL_DIAGNOSTIC");
  assert.equal(report.qualification.returnSuperiorityVerified, false);
  assert.ok(report.qualification.limitations.some(x => /幸存|时点/.test(x)));
});

test("a historical ST event cannot establish a signal after the name returns to normal", () => {
  const data = fixture();
  data.securities[0].statusHistory.push(
    { date: data.calendar[264], name: "*ST虚构", isST: true, listed: true },
    { date: data.calendar[265], name: "虚构恢复", isST: false, listed: true }
  );
  const report = run(data, { to: data.calendar[269] });
  assert.equal(report.baseline.metrics.signals, 0);
  assert.equal(report.advanced.metrics.signals, 0);
});

test("real input with calculated limit prices cannot silently become an executable trade", () => {
  const data = fixture(); data.sourceClass = "real"; data.priceLimitEvidence = "calculated";
  const sample = first(run(data));
  assert.equal(sample.status, "unresolved");
  assert.equal(sample.reason, "unverified_price_limit_source");
});

test("shared gaps in stock and benchmark histories cannot shorten the market-day limit window", () => {
  const data = fixture(320);
  setBar(data, 280, { volume: 10000000 });
  const options = { from: data.calendar[280], splitDate: data.calendar[280] };
  assert.equal(run(data, options).baseline.metrics.signals, 0);
  const missing = new Set(data.calendar.slice(272, 280));
  data.benchmarkRows = data.benchmarkRows.filter(row => !missing.has(row.date));
  for (const key of ["rawRows", "adjustedRows"]) data.securities[0][key] = data.securities[0][key].filter(row => !missing.has(row.date));
  const report = run(data, options);
  for (const mode of ["baseline", "advanced"]) {
    assert.equal(report[mode].metrics.signals, 0);
    assert.equal(report[mode].metrics.closed, 0);
    assert.ok(report[mode].coverage.unavailable > 0);
    assert.ok(report[mode].coverage.reasons.market_calendar_gap > 0);
  }
});

test("shared missing signal-day bars cannot reuse the previous day's signal", () => {
  const data = fixture(); const missingDate = data.calendar[270];
  data.benchmarkRows = data.benchmarkRows.filter(row => row.date !== missingDate);
  for (const key of ["rawRows", "adjustedRows"]) data.securities[0][key] = data.securities[0][key].filter(row => row.date !== missingDate);
  const report = run(data, { from: missingDate, splitDate: missingDate, to: missingDate });
  for (const mode of ["baseline", "advanced"]) {
    assert.equal(report[mode].metrics.signals, 0);
    assert.equal(report[mode].coverage.unavailable, 1);
    assert.equal(report[mode].coverage.reasons.market_calendar_gap, 1);
  }
});

test("offline CLI generates labeled fixture and report without a network source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trend-evaluation-test-"));
  try {
    const fixturePath = path.join(dir, "synthetic.json"); const output = path.join(dir, "report.json");
    const generated = spawnSync(process.execPath, ["qa/create-trend-evaluation-fixture.cjs", "--output", fixturePath], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const evaluated = spawnSync(process.execPath, ["qa/evaluate-trend-strategies.cjs", "--input", fixturePath, "--from", data.calendar[269], "--to", data.calendar.at(-1), "--split-date", data.calendar[269], "--output", output], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    assert.equal(evaluated.status, 0, evaluated.stderr);
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.qualification.status, "SYNTHETIC_MECHANICS_ONLY");
    assert.ok(report.baseline.metrics.signals > 0); assert.ok(report.advanced.metrics.signals > 0);
    assert.equal(report.qualification.returnSuperiorityVerified, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

module.exports = { fixture };

test("offline comparison accepts all six library IDs and freezes their catalog configurations", () => {
  const catalog = require("../config/trend-strategy-library.json");
  const data = fixture();
  for (const entry of catalog) {
    const report = run(data, { advancedStrategyId: entry.id, to: data.calendar[269] });
    assert.equal(report.advanced.strategy.id, entry.id);
    assert.equal(report.advanced.strategy.version, entry.version);
    assert.deepEqual(report.advanced.strategy.config, entry.parameters);
    assert.match(report.advanced.strategy.configHash, /^[a-f0-9]{64}$/);
    assert.equal(report.baseline.strategy.id, "classic-v1");
    assert.equal(report.qualification.returnSuperiorityVerified, false);
    assert.ok(report.advanced.samples.every(sample => sample.strategy.id === entry.id));
  }
});

test("offline advanced strategy defaults to quality and rejects unknown IDs or edited fixed configurations", () => {
  const data = fixture();
  assert.equal(run(data, { to: data.calendar[269] }).advanced.strategy.id, "quality-v2");
  assert.throws(() => run(data, { advancedStrategyId: "missing-strategy" }), /策略|ID/);
  assert.throws(() => run(data, { advancedStrategyId: "macd-zero-cross-v1", advancedConfig: { fastPeriod: 11 } }), /配置|参数|固定/);
});

test("library offline lookback independently requires all 80 supplied market sessions", () => {
  const data = fixture();
  const missing = data.calendar[195]; // 75 sessions back: outside old 65-day guard.
  data.benchmarkRows = data.benchmarkRows.filter(row => row.date !== missing);
  for (const key of ["rawRows", "adjustedRows"]) data.securities[0][key] = data.securities[0][key].filter(row => row.date !== missing);
  const report = run(data, { advancedStrategyId: "obv-volume-breakout-v1", to: data.calendar[269] });
  assert.equal(report.baseline.coverage.reasons.market_calendar_gap, undefined);
  assert.equal(report.advanced.coverage.unavailable, 1);
  assert.equal(report.advanced.coverage.reasons.market_calendar_gap, 1);
  assert.equal(report.advanced.metrics.signals, 0);
});

test("new library comparisons do not consume future histories or historical status changes", () => {
  const data = fixture();
  const options = { advancedStrategyId: "obv-volume-breakout-v1", to: data.calendar[271] };
  const original = run(data, options);
  for (let index = 272; index < data.calendar.length; index++) {
    setBar(data, index, { open: -1, close: -1, high: -1, low: -1 });
    data.benchmarkRows[index].close = -1;
  }
  data.securities[0].statusHistory.push({ date: data.calendar[272], name: "*ST未来", isST: true, listed: false });
  const changed = run(data, options);
  assert.deepEqual(changed.advanced, original.advanced);
});

test("offline CLI accepts an explicit advanced strategy and rejects an unknown strategy without a report", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trend-library-evaluation-test-"));
  try {
    const data = fixture(); const input = path.join(dir, "input.json"); const output = path.join(dir, "report.json");
    fs.writeFileSync(input, JSON.stringify(data));
    const args = ["qa/evaluate-trend-strategies.cjs", "--input", input, "--from", data.calendar[269],
      "--to", data.calendar[270], "--split-date", data.calendar[269], "--output", output, "--advanced-strategy"];
    const evaluated = spawnSync(process.execPath, [...args, "obv-volume-breakout-v1"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    assert.equal(evaluated.status, 0, evaluated.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).advanced.strategy.id, "obv-volume-breakout-v1");
    fs.unlinkSync(output);
    const invalid = spawnSync(process.execPath, [...args, "unknown-strategy"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
