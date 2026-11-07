"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./strategy-signal-engine.cjs");
const { createTradingCalendar } = require("./trend-trading-calendar.cjs");

function priceBasisFixture(count, actionIndex, limitIndex = count - 1) {
  const dates = createTradingCalendar().sessionsThrough("2026-10-20", count);
  const rows = dates.map((date, i) => {
    const close = i < actionIndex ? 20 : i < limitIndex ? 10 : 11;
    return { date, open: close, high: close + .1, low: close - .1, close, volume: 10000, amount: 2e8 };
  });
  Object.assign(rows[actionIndex], { preClose: 10, changePct: 0 });
  Object.assign(rows[limitIndex], { open: 10, high: 11, low: 10, close: 11 });
  return rows;
}

test("a price-basis break inside the 100-session pre-limit range cannot create a false low first board", () => {
  const rows = priceBasisFixture(120, 25);
  const report = engine.buildStrategySelectionReport([{ code: "600001", name: "基准样本" }], { "600001": rows }, rows,
    { strategyIds: ["low_first_board"], asOfDate: rows.at(-1).date, marketDates: rows.map(row => row.date), minCurrentHistoryBars: 120 });
  assert.equal(report.strategies[0].stocks.length, 0);
  assert.equal(report.dataQuality.invalid, 1);
  assert.equal(report.dataQuality.reasons.unresolved_price_basis, 1);
});

test("an older basis break outside the consumed range does not invalidate a 240-session snapshot", () => {
  const rows = priceBasisFixture(240, 25);
  const feature = engine.__test.buildFeatureTimeline(rows, "600001", "基准样本", rows).at(-1);
  assert.ok(feature);
  assert.equal(feature.isCurrentLimit, true);
});

test("recursive combination indicators restart after an old basis break without vetoing unrelated current patterns", () => {
  const rows = priceBasisFixture(240, 90);
  const full = engine.__test.buildFeatureTimeline(rows, "600001", "基准样本", rows).at(-1);
  const suffix = engine.__test.buildFeatureTimeline(rows.slice(90), "600001", "基准样本", rows).at(-1);
  assert.ok(full);
  assert.deepEqual(full.signalCombinations.indicators, suffix.signalCombinations.indicators);
});

test("lazy legacy factors check the older event's own 100-session range without vetoing the base snapshot", () => {
  const rows = priceBasisFixture(240, 100, 189);
  const feature = engine.__test.buildFeatureTimeline(rows, "600001", "基准样本", rows).at(-1);
  assert.ok(feature);
  assert.equal(feature.legacyFactors, null);
});

// Fixed fictional path, with dates supplied independently of price values.
function fixture(seed = 127) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const cents = value => Math.round(value * 100) / 100;
  const dates = createTradingCalendar().sessionsThrough("2026-10-20", 300);
  const history = [], wave = .1 + random() * .9;
  for (let i = 0; i < 300; i++) {
    let close = cents(10 + i * .012 + Math.sin(i / 5) * wave);
    if (i >= 260) close = cents(12.6 + (i - 260) * .016 + (random() - .5) * wave * 2);
    if (i === 291) close = cents(history[i - 1].close * 1.1);
    if (i > 291) close = cents(history[291].close - .15 + (random() - .35) * wave * 1.4);
    let open = cents(close - .02), high = cents(close + .08 + random() * .2), low = cents(close - .15 - random() * .2);
    if (i === 291) { open = cents(history[i - 1].close * 1.025); low = cents(open - .02); high = close; }
    let volume = 8000000 + Math.floor(random() * 1000000);
    if (i === 291) volume = 16000000;
    if (i === 299) volume = 9000000;
    history.push({ date: dates[i], open, high, low, close, volume, amount: 300000000 });
  }
  return { history, benchmark: dates.map(date => ({ date, open: 100, close: 100, high: 101, low: 99 })),
    candidate: { code: "600001", secid: "1.600001", name: "明确虚构样本" },
    options: { asOfDate: "2026-10-20", marketDates: dates.slice(-120) } };
}
// 这些用例检查完整策略库的选股规则（含 2026-11-05 下线的策略），因此按 id 明确指定全部策略。
const ALL_IDS = engine.ALL_STRATEGY_DEFINITIONS.map(definition => definition.id);
const select = input => engine.buildStrategySelectionReport([input.candidate], { [input.candidate.code]: input.history }, input.benchmark, { strategyIds: ALL_IDS, ...input.options });
const ids = report => report.strategies.filter(group => group.stocks.length).map(group => group.id);

test("current selection rejects a whole necessary window when volume, amount or OHLC is invalid", () => {
  assert.ok(ids(select(fixture())).includes("limit_ma10_pullback"));
  for (const [field, value] of [["volume", null], ["volume", 0], ["amount", null], ["amount", -1], ["low", 99], ["open", -1]]) {
    const input = fixture(); input.history.at(-1)[field] = value;
    const report = select(input);
    assert.deepEqual(ids(report), [], `${field}=${value} must not match a base strategy`);
    assert.equal(report.dataQuality.invalid, 1);
  }
});

test("raw duplicate, illegal or missing dates cannot be silently compressed into a usable history", () => {
  for (const mutate of [input => input.history.push({ ...input.history.at(-1) }), input => { input.history.at(-2).date = "2026-02-30"; }, input => input.history.splice(220, 1)]) {
    const input = fixture(); mutate(input);
    const report = select(input);
    assert.deepEqual(ids(report), []);
    assert.equal(report.dataQuality.invalid, 1);
  }
});

test("current selection cuts future and intraday rows at explicit completed asOfDate", () => {
  const input = fixture(), before = select(input);
  input.history.push({ ...input.history.at(-1), date: "2026-10-21", open: 99, close: 99, high: 100, low: 98 });
  input.benchmark.push({ ...input.benchmark.at(-1), date: "2026-10-21", close: 999, high: 1000 });
  const after = select(input);
  assert.deepEqual(ids(after), ids(before));
  assert.equal(after.asOfDate, "2026-10-20");
  assert.ok(after.strategies.flatMap(group => group.stocks).every(stock => stock.signalDate === "2026-10-20"));
});

test("generation time does not make stale stock or a stale benchmark current", () => {
  const input = fixture(); input.history.pop(); input.benchmark.pop(); input.options.generatedAt = "2026-10-21T12:00:00Z";
  const report = select(input);
  assert.deepEqual(ids(report), []);
  assert.equal(report.dataQuality.stale, 1);
  assert.equal(report.dataQuality.benchmarkReady, false);
});

test("independent complete stock dates preserve base rules when benchmark is unavailable", () => {
  const input = fixture(); input.benchmark = [];
  const report = select(input);
  assert.ok(ids(report).includes("limit_ma10_pullback"));
  assert.ok(!ids(report).some(id => id.endsWith("_resonance") || id === "relative_strength_pullback"));
  assert.equal(report.dataQuality.benchmarkReady, false);
  assert.equal(report.dataQuality.processed, 1);
});

test("omitting asOfDate cannot relabel an offline snapshot using generatedAt", () => {
  const input = fixture(); input.options = { generatedAt: "2030-01-01T15:00:00+08:00" };
  input.history = input.history.map(row => ({ ...row, date: row.date.replace(/^2026/, "2020").replace(/^2025/, "2019") }));
  assert.deepEqual(ids(select(input)), []);
});

test("platform first-board rule refuses the second consecutive limit", () => {
  const input = fixture(); input.history = input.history.map(row => ({ ...row, open: 10, high: 10.2, low: 9.8, close: 10, volume: 100000 }));
  input.history[298] = { ...input.history[298], open: 10.1, high: 11, low: 10.1, close: 11, volume: 200000 };
  input.history[299] = { ...input.history[299], open: 11.2, high: 12.1, low: 11.2, close: 12.1, volume: 200000 };
  assert.ok(!ids(select(input)).includes("platform_breakout"));
});

test("N relay rejects an interim break of the first limit support", () => {
  const input = fixture(); input.history = input.history.map(row => ({ ...row, open: 10, high: 10.2, low: 9.8, close: 10, volume: 100000 }));
  input.history[280] = { ...input.history[280], open: 10.1, high: 11, low: 10.1, close: 11, volume: 200000 };
  for (let i = 281; i < 299; i++) input.history[i] = { ...input.history[i], open: 10.3, close: 10.3, high: 10.5, low: i === 281 ? 9.5 : 10.15 };
  input.history[299] = { ...input.history[299], open: 10.6, high: 11.33, low: 10.3, close: 11.33, volume: 200000 };
  assert.ok(!ids(select(input)).includes("double_limit_relay"));
});

test("relative strength pullback requires outperformance, trend, capacity and a non-one-price day", () => {
  const positive = fixture();
  assert.ok(ids(select(positive)).includes("relative_strength_pullback"));
  for (const mutate of [input => { input.history.slice(-20).forEach(row => { row.amount = 199999999; }); },
    input => { input.history.at(-1).open = input.history.at(-1).high = input.history.at(-1).low = input.history.at(-1).close; },
    input => { input.benchmark = input.benchmark.map((row, i) => ({ ...row, open: 100 + i, close: 100 + i, high: 101 + i, low: 99 + i })); },
    input => { input.benchmark.at(-1).close = 90; input.benchmark.at(-1).low = 89; input.benchmark.at(-1).open = 90; }]) {
    const input = fixture(); mutate(input);
    assert.ok(!ids(select(input)).includes("relative_strength_pullback"));
  }
});

test("relative 20-session and 60-session outperformance are independently necessary", () => {
  for (const offset of [20, 60]) {
    const input = fixture(), row = input.benchmark.at(-offset - 1);
    // Only this reference changes: the other comparison still sees zero index return.
    Object.assign(row, { open: 70, close: 70, high: 71, low: 69 });
    assert.ok(!ids(select(input)).includes("relative_strength_pullback"), `relative ${offset}-session return`);
  }
});

test("relative pullback includes T plus 15 and expires on T plus 16", () => {
  const input = fixture(27), original = input.history[291], earlier = input.history[284];
  input.history[284] = { ...original, date: earlier.date,
    open: Math.round(input.history[283].close * 1.01 * 100) / 100,
    low: Math.round(input.history[283].close * 1.005 * 100) / 100,
    close: Math.round(input.history[283].close * 1.1 * 100) / 100 };
  input.history[284].high = input.history[284].close;
  input.history[291] = { ...input.history[290], date: original.date };
  assert.ok(ids(select(input)).includes("relative_strength_pullback"), "T+15 remains inside this strategy's explicit age window");
  input.history[284].isST = true;
  assert.ok(!ids(select(input)).includes("relative_strength_pullback"), "the T+15 anchor also needs non-ST event evidence");
  delete input.history[284].isST;
  input.history.push({ ...input.history.at(-1), date: "2026-10-21" });
  input.benchmark.push({ ...input.benchmark.at(-1), date: "2026-10-21" });
  input.options = { asOfDate: "2026-10-21", marketDates: createTradingCalendar().sessionsThrough("2026-10-21", 120) };
  assert.ok(!ids(select(input)).includes("relative_strength_pullback"));
});

test("relative selection accepts its capacity boundary and rejects a benchmark date hole", () => {
  const input = fixture(); input.history.slice(-20).forEach(row => { row.amount = 200000000; });
  assert.ok(ids(select(input)).includes("relative_strength_pullback"));
  input.benchmark.splice(250, 1);
  const report = select(input);
  assert.ok(ids(report).includes("limit_ma10_pullback"));
  assert.ok(!ids(report).includes("relative_strength_pullback"));
  assert.equal(report.dataQuality.benchmarkReady, false);
});

test("old data outside the necessary window cannot change the current signal snapshot", () => {
  const input = fixture(), original = ids(select(input));
  input.history[10].low = -1; input.history[10].volume = null;
  assert.deepEqual(ids(select(input)), original);
});

test("unknown or inconsistent independent calendars cannot publish current picks", () => {
  for (const options of [{ asOfDate: "2026-02-30", marketDates: [] },
    { asOfDate: "2026-10-20", marketDates: ["2026-10-20"] },
    { asOfDate: "2026-10-20", marketDates: Array(120).fill("2026-10-20") }]) {
    const input = fixture(); input.options = options;
    const report = select(input);
    assert.deepEqual(ids(report), []);
    assert.equal(report.dataQuality.calendarState, "unknown");
  }
});

test("every live selection definition provides versioned family and exact data requirements", () => {
  const report = select(fixture());
  assert.equal(report.strategies.length, engine.ALL_STRATEGY_DEFINITIONS.length);
  for (const group of report.strategies) {
    assert.match(group.version, /^\d+\.\d+\.\d+$/);
    assert.ok(group.family);
    assert.ok(Array.isArray(group.dataRequirements) && group.dataRequirements.length);
    assert.ok(group.scope && group.evidenceLevel);
  }
  const roc = report.strategies.find(group => group.id === "limit_roc_reclaim_resonance");
  assert.match(roc.detail, /MA10/);
  assert.doesNotMatch(roc.detail, /MA20/);
});

module.exports = { fixture };
