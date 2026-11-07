"use strict";
// 策略留强去弱与「连板后缩量回调」（2026-11-05）。
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./strategy-signal-engine.cjs");
const customStrategy = require("./custom-strategy.cjs");

const dates = require("./trend-trading-calendar.cjs").createTradingCalendar().sessionsThrough("2026-10-20", 120);
const r2 = value => Math.round(value * 100) / 100;
const row = (date, [open, high, low, close, volume = 100000]) => ({ date, open, high, low, close, volume, amount: close * volume * 100 });
/** 横盘后两连板（倒数 after+2、after+1 根），之后 after 根小幅回落、成交萎缩到 volumeShare（相对第二板）。 */
function streak(after, { volumeShare = 0.4, breakLow = false } = {}) {
  const first = 120 - 2 - after;
  let close = 10;
  return dates.map((date, index) => {
    if (index < first) return row(date, [10, 10.1, 9.9, 10, 100000]);
    if (index === first || index === first + 1) { const prev = close; close = r2(prev * 1.1); return row(date, [r2(prev * 1.02), close, r2(prev * 1.01), close, 300000]); }
    const day = index - first - 1;
    const c = r2(close * (1 - 0.01 * day));
    const low = breakLow && day === after ? r2(close * 0.8) : r2(c * 0.99);
    return row(date, [r2(c * 1.005), r2(c * 1.01), low, c, Math.round(300000 * volumeShare)]);
  });
}
const picks = rows => engine.buildStrategySelectionReport([{ code: "600001", name: "样本" }], { 600001: rows }, [],
  { asOfDate: "2026-10-20", marketDates: dates, strategyIds: ["board_streak_quiet_pullback"] }).strategies[0].stocks;

test("the strategy library keeps the strong rules first and retires the weak ones from stock selection", () => {
  const live = engine.STRATEGY_DEFINITIONS, retired = engine.RETIRED_STRATEGY_DEFINITIONS;
  const featured = live.filter(item => item.featured);
  assert.ok(featured.length >= 6);
  assert.deepEqual(live.slice(0, featured.length).map(item => item.id), featured.map(item => item.id), "featured rules come first");
  assert.ok(featured.some(item => item.id === "board_streak_quiet_pullback"));
  for (const id of ["youzi_first_to_second_board", "trend_first_board", "platform_breakout", "n_relay_resonance"]) {
    assert.equal(live.some(item => item.id === id), false, `${id} no longer runs in 策略选股`);
    assert.ok(retired.some(item => item.id === id && item.retired === true), `${id} stays in the library as retired`);
  }
  assert.equal(engine.ALL_STRATEGY_DEFINITIONS.length, live.length + retired.length);
  // 默认选股只跑在用策略。
  const report = engine.buildStrategySelectionReport([], {}, [], { asOfDate: "2026-10-20", marketDates: dates });
  assert.deepEqual(report.strategies.map(item => item.id), live.map(item => item.id));
  assert.ok(report.strategies.filter(item => item.featured).length === featured.length, "the featured flag reaches the page");
});

test("a saved custom strategy that uses a retired rule as a condition keeps working", () => {
  const strategy = { id: "cs_retiredref1", name: "引用已下线规则", universe: "limit_pool", minMatchPercent: 100, conditions: [{ ref: "pattern:youzi_dragon_pullback", required: true }] };
  const compiled = engine.compileCustomDefinitions([strategy], "limit_pool");
  assert.equal(compiled.errors?.length || 0, 0);
  assert.equal(compiled.definitions.length, 1);
  const ids = new Set(engine.ALL_STRATEGY_DEFINITIONS.map(item => item.id));
  assert.doesNotThrow(() => customStrategy.normalizeCustomStrategy(strategy, { patternIds: ids }));
});

test("连板后缩量回调: two boards, then 3–10 quiet days that never lose the limit-up day's low", () => {
  const hit = picks(streak(5));
  assert.equal(hit.length, 1);
  assert.match(hit[0].reasons.join(" "), /2连板后第5天缩量回调/);
  assert.match(hit[0].reasons.join(" "), /日均量为涨停日的\d+%/);
  assert.equal(picks(streak(2)).length, 0, "too soon after the streak");
  assert.equal(picks(streak(11)).length, 0, "too long after the streak");
  assert.equal(picks(streak(5, { volumeShare: 0.8 })).length, 0, "volume has not dried up");
  assert.equal(picks(streak(5, { breakLow: true })).length, 0, "support broken");
});

test("连板后缩量回调 needs a streak of at least two boards", () => {
  const rows = streak(5);
  // 把第一板改成普通上涨日：只剩一板。
  const first = 120 - 2 - 5;
  rows[first] = row(rows[first].date, [10, 10.1, 9.9, 10, 100000]);
  rows[first + 1] = row(rows[first + 1].date, [10.2, 11, 10.1, 11, 300000]);
  assert.equal(picks(rows).length, 0);
  const definition = engine.STRATEGY_DEFINITIONS.find(item => item.id === "board_streak_quiet_pullback");
  assert.equal(definition.family, "pullback");
  assert.equal(definition.version, "1.0.0");
  assert.ok(definition.conditions.length >= 3 && definition.adaptationNote.includes("2024–2026"));
});
