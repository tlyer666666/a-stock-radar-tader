"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./strategy-signal-engine.cjs");
const { featureSnapshot } = engine.__test;
const def = id => engine.ALL_STRATEGY_DEFINITIONS.find(item => item.id === id);
const dateAt = i => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

/** 30 根平盘 10 元后接自定义行；bar = [open, high, low, close, volume]。 */
function path(bars) {
  const rows = Array.from({ length: 30 }, (_, i) => ({ date: dateAt(i), open: 10, high: 10.1, low: 9.9, close: 10, volume: 100000, amount: 1e8 }));
  bars.forEach(([open, high, low, close, volume = 150000], k) => rows.push({ date: dateAt(30 + k), open, high, low, close, volume, amount: close * volume * 100 }));
  return rows;
}
const last = rows => featureSnapshot(rows, rows.length - 1, "600001", "游资样本");
const board = (close, previous) => [previous * 1.02, close, previous * 1.01, close, 200000];

test("首阴反包: two boards, a first bearish candle, then a reclaim above its open", () => {
  const rows = path([board(11, 10), board(12.1, 11), [12.5, 12.6, 11.9, 12.0], [12.0, 12.8, 11.95, 12.7]]);
  const feature = last(rows);
  assert.equal(feature.firstNegativeReclaim, true);
  assert.equal(def("youzi_first_negative_reclaim").matches(feature), true);
  assert.match(def("youzi_first_negative_reclaim").reasons(feature).join(" "), /2连板/);
  const weak = path([board(11, 10), board(12.1, 11), [12.5, 12.6, 11.9, 12.0], [12.0, 12.4, 11.95, 12.3]]);
  assert.equal(last(weak).firstNegativeReclaim, false, "closing below the bearish candle's open is not a reclaim");
});

test("断板弱转强: after two boards a broken day, then a gap up that closes above the broken day's high", () => {
  const rows = path([board(11, 10), board(12.1, 11), [12.3, 12.6, 12.0, 12.4], [12.6, 12.95, 12.5, 12.9]]);
  assert.equal(last(rows).brokenBoardWeakToStrong, true);
  assert.equal(def("youzi_broken_board_weak_to_strong").matches(last(rows)), true);
  const noGap = path([board(11, 10), board(12.1, 11), [12.3, 12.6, 12.0, 12.4], [12.3, 12.95, 12.2, 12.9]]);
  assert.equal(last(noGap).brokenBoardWeakToStrong, false, "a low or flat open is not 弱转强");
});

test("一进二: a first board followed by a second turnover board; one-price boards are excluded", () => {
  const rows = path([board(11, 10), board(12.1, 11)]);
  assert.equal(last(rows).firstToSecondBoard, true);
  assert.equal(def("youzi_first_to_second_board").matches(last(rows)), true);
  const onePrice = path([board(11, 10), [12.1, 12.1, 12.1, 12.1, 50000]]);
  assert.equal(last(onePrice).firstToSecondBoard, false);
  const third = path([board(11, 10), board(12.1, 11), board(13.31, 12.1)]);
  assert.equal(last(third).firstToSecondBoard, false, "a third board is no longer 一进二");
});

test("龙回头: a three-board leader pulls back 15–40% without losing its launch price, then a shrinking-volume up day", () => {
  const decline = [[13.2, 13.3, 12.9, 13.0, 120000], [12.9, 13.0, 12.3, 12.4, 120000], [12.4, 12.5, 11.7, 11.8, 120000], [11.8, 11.9, 11.2, 11.3, 120000], [11.3, 11.4, 10.9, 11.0, 120000]];
  const rows = path([board(11, 10), board(12.1, 11), board(13.31, 12.1), ...decline, [11.0, 11.35, 10.95, 11.3, 90000]]);
  const feature = last(rows);
  assert.equal(feature.dragonPullback, true, JSON.stringify(feature.youziDetail));
  assert.ok(feature.youziDetail.dragonPullback.pullbackPercent >= 15 && feature.youziDetail.dragonPullback.pullbackPercent <= 40);
  assert.equal(def("youzi_dragon_pullback").matches(feature), true);
  const heavy = path([board(11, 10), board(12.1, 11), board(13.31, 12.1), ...decline, [11.0, 11.35, 10.95, 11.3, 400000]]);
  assert.equal(last(heavy).dragonPullback, false, "a heavy-volume day is not the shrinking-volume stabilisation");
  const broken = path([board(11, 10), board(12.1, 11), board(13.31, 12.1), ...decline.slice(0, 4), [11.3, 11.4, 10.3, 10.4, 120000], [10.4, 10.45, 9.5, 9.6, 120000], [9.6, 9.95, 9.55, 9.9, 90000]]);
  assert.equal(last(broken).dragonPullback, false, "falling below the launch price breaks the pattern");
});

test("游资 strategies are their own family, keep their own version and are not subject to the overheat veto", () => {
  for (const id of ["youzi_first_negative_reclaim", "youzi_broken_board_weak_to_strong", "youzi_first_to_second_board", "youzi_dragon_pullback"]) {
    const definition = def(id);
    assert.equal(definition.family, "youzi"); assert.equal(definition.version, "1.0.0"); assert.equal(definition.overheatGate, false);
  }
});
