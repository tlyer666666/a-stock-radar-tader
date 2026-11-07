"use strict";
// 下跌后放量大阳·次日平量（volume_rebound_hold v1.0.0）
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./strategy-signal-engine.cjs");
const { volumeReboundHoldAt } = engine.__test;

/** 30 根：前 15 根在 20 元附近，随后跌到 17 元（回落 15%），T-1 放量大阳 +7%，T 平量微跌。 */
function bars({ yangChange = 7, yangVolume = 3e6, todayVolume = 3e6, todayChange = -0.8, decline = true } = {}) {
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const close = decline ? (i < 15 ? 20 : 20 - (i - 14) * 0.25) : 20 + i * 0.02;
    rows.push({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, open: close, high: close + 0.1, low: close - 0.1, close, volume: 1e6, amount: close * 1e6 });
  }
  const before = rows.at(-1).close;
  const yangClose = Number((before * (1 + yangChange / 100)).toFixed(2));
  rows.push({ date: "2026-09-29", open: before * 1.005, high: yangClose + 0.05, low: before, close: yangClose, volume: yangVolume, amount: yangClose * yangVolume });
  const todayClose = Number((yangClose * (1 + todayChange / 100)).toFixed(2));
  rows.push({ date: "2026-09-30", open: yangClose, high: yangClose + 0.2, low: todayClose - 0.1, close: todayClose, volume: todayVolume, amount: todayClose * todayVolume });
  return rows;
}

test("matches a decline, a high-volume big up day, then a similar-volume flat day", () => {
  const rows = bars();
  const result = volumeReboundHoldAt(rows, rows.length - 1);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.bigYangDate, "2026-09-29");
  assert.ok(result.declinePercent >= 10);
  assert.ok(result.bigYangVolumeRatio >= 1.8);
  assert.ok(Math.abs(result.holdVolumeRatio - 1) < 1e-9);
  const definition = engine.STRATEGY_DEFINITIONS.find((item) => item.id === "volume_rebound_hold");
  assert.equal(definition.matches({ volumeReboundHold: true, volumeReboundHoldDetail: result, riskVeto: true }), true);
  assert.equal(definition.matches({ volumeReboundHold: true, riskVeto: false }), true, "the limit-day support veto does not apply: the prior decline always breaks older limit-day lows");
  assert.equal(definition.matches({ volumeReboundHold: false, riskVeto: true }), false);
  assert.match(definition.reasons({ volumeReboundHoldDetail: result }).join(), /放量大阳/);
});

test("each condition is required", () => {
  const fails = (options, why) => assert.equal(volumeReboundHoldAt(bars(options), 29).passed, false, why);
  fails({ decline: false }, "no prior decline");
  fails({ yangChange: 3 }, "up day is not big enough");
  fails({ yangVolume: 1.5e6, todayVolume: 1.5e6 }, "big up day without volume");
  fails({ todayVolume: 1.5e6 }, "next day volume shrinks too much");
  fails({ todayVolume: 4.5e6 }, "next day volume expands too much");
  fails({ todayChange: 4 }, "next day rises too much");
  fails({ todayChange: -3.5 }, "next day falls too much");
  assert.equal(volumeReboundHoldAt(bars({ todayChange: 1.9 }), 29).passed, true, "a small rise is fine");
  const broken = bars(); broken[29] = { ...broken[29], low: broken[28].low - 0.01 };
  assert.equal(volumeReboundHoldAt(broken, 29).passed, false, "breaking the big up day's low fails the hold");
});

test("the rule only looks at bars up to the signal day", () => {
  const rows = bars();
  const before = volumeReboundHoldAt(rows, 29);
  rows.push({ ...rows.at(-1), date: "2026-10-08", close: 1, open: 1, high: 1, low: 1, volume: 1 });
  assert.deepEqual(volumeReboundHoldAt(rows, 29), before);
});
