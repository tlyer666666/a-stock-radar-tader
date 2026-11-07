"use strict";
// 底部趋势策略（1.6.43）：深跌底部首板、首板后缩量回踩、温和首板后承接、首板后收复10日线。
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./strategy-signal-engine.cjs");

const dates = require("./trend-trading-calendar.cjs").createTradingCalendar().sessionsThrough("2026-10-20", 120);
const row = (date, [open, high, low, close, volume = 100000]) => ({ date, open, high, low, close, volume, amount: close * volume * 100 });
const r2 = value => Math.round(value * 100) / 100;
/** 120 根日线：前段每天跌 slope（深跌），倒数第 after+1 根是底部首板，之后接 after 根。 */
function build(after, makeAfter, { slope = 0.17, boardVolume = 105000 } = {}) {
  const boardIndex = 120 - 1 - after;
  const prev = r2(30 - (boardIndex - 1) * slope), board = r2(prev * 1.1);
  return dates.map((date, index) => {
    if (index < boardIndex) { const close = r2(30 - index * slope); return row(date, [r2(close + 0.05), r2(close + 0.1), r2(close - 0.12), close, 100000]); }
    if (index === boardIndex) return row(date, [r2(prev * 1.01), board, r2(prev * 0.995), board, boardVolume]);
    return row(date, makeAfter(board, index - boardIndex));
  });
}
const picks = (rows, id) => engine.buildStrategySelectionReport([{ code: "600001", name: "样本" }], { 600001: rows }, [],
  { asOfDate: "2026-10-20", marketDates: dates, strategyIds: [id] }).strategies[0].stocks;
const pullback = (board, day) => day === 1 ? [board, r2(board * 1.01), r2(board * 0.96), r2(board * 0.97), 90000] : [r2(board * 0.97), r2(board * 0.975), r2(board * 0.93), r2(board * 0.935), 80000];

test("the four bottom-trend strategies form their own family", () => {
  const ids = engine.STRATEGY_DEFINITIONS.filter(item => item.family === "bottom_trend").map(item => item.id);
  assert.deepEqual(ids, ["bottom_deep_first_board", "bottom_board_pullback", "bottom_quiet_board_follow", "bottom_ma10_reclaim"]);
  assert.equal(engine.STRATEGY_DEFINITIONS.find(item => item.id === "bottom_deep_first_board").overheatGate, false, "a limit-up day is never vetoed as overheated");
});

test("a first board after a deep fall is picked on the board day; a shallow one is not", () => {
  const deep = picks(build(0), "bottom_deep_first_board");
  assert.equal(deep.length, 1);
  assert.match(deep[0].reasons.join(" "), /收盘低于MA60 2\d\.\d%/);
  assert.ok(deep[0].invalidationPrice > 0, "the board low is the failure line");
  const shallow = build(0, null, { slope: 0.02 });
  assert.equal(picks(shallow, "bottom_deep_first_board").length, 0, "a board less than 15% under the 60-day line is not deep");
});

test("a quiet pullback below the 10-day line after the bottom board is picked, with the board as the origin", () => {
  const rows = build(2, pullback);
  const [stock] = picks(rows, "bottom_board_pullback");
  assert.ok(stock);
  assert.match(stock.reasons.join(" "), /底部首板 \d{4}-\d{2}-\d{2}（2 个交易日前）/);
  assert.equal(picks(rows, "bottom_quiet_board_follow").length, 1, "the board itself was not on heavy volume");
  assert.equal(picks(build(2, pullback, { boardVolume: 260000 }), "bottom_quiet_board_follow").length, 0, "a heavy-volume board is not quiet");
});

test("a second limit-up after the bottom board stops the follow-up strategies (second waves lag in the field test)", () => {
  const rows = build(2, (board, day) => day === 1 ? [board, r2(board * 1.1), board, r2(board * 1.1), 150000] : pullback(r2(board * 1.1), 2));
  assert.equal(picks(rows, "bottom_board_pullback").length, 0);
  assert.equal(picks(rows, "bottom_quiet_board_follow").length, 0);
});

test("reclaiming the 10-day line 3–15 days after the bottom board is picked", () => {
  const rows = build(5, (board, day) => day < 5
    ? [r2(board * (1 - 0.02 * day)), r2(board * (1.005 - 0.02 * day)), r2(board * (0.97 - 0.02 * day)), r2(board * (0.98 - 0.02 * day)), 80000]
    : [r2(board * 0.905), r2(board * 0.99), r2(board * 0.9), r2(board * 0.945), 85000]);
  assert.equal(picks(rows, "bottom_ma10_reclaim").length, 1);
  assert.equal(picks(rows, "bottom_board_pullback").length, 0, "the close is back above the 10-day line");
});
