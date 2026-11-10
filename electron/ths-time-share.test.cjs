"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseThsTimeShare } = require("./ths-free-market.cjs");

const wrap = (data, extra = {}) => ({ hs_600519: { name: "样本", pre: "10.00", date: "20261029", data, ...extra } });

test("THS time-share parses price, average, previous close and per-minute amount/volume (volume in shares)", () => {
  const parsed = parseThsTimeShare(wrap("0930,10.10,101000,10.10,10000;0931,10.20,204000,10.15,20000;1301,10.05,100500,10.12,10000"));
  assert.equal(parsed.date, "2026-10-29");
  assert.equal(parsed.preClose, 10);
  assert.deepEqual(parsed.rows.map(row => row.date), ["2026-10-29 09:30", "2026-10-29 09:31", "2026-10-29 13:01"]);
  assert.equal(parsed.rows[1].close, 10.2);
  assert.equal(parsed.rows[1].average, 10.15);
  assert.equal(parsed.rows[1].amount, 204000);
  assert.equal(parsed.rows[1].volume, 200, "20000 shares = 200 lots");
});

test("THS time-share recognises swapped amount/volume columns and volume already in lots", () => {
  const parsed = parseThsTimeShare(wrap("0931,10.00,100,10.00,100000;0932,10.00,300,10.00,300000"));
  assert.equal(parsed.rows[0].amount, 100000);
  assert.equal(parsed.rows[0].volume, 100, "100 lots × 100 shares × 10 元 = 100000 元");
});

test("THS time-share accepts an unkeyed body and rejects empty payloads", () => {
  assert.equal(parseThsTimeShare({ pre: "5", date: "20261029", data: "0931,5.1,5100,5.1,1000" }).rows.length, 1);
  assert.equal(parseThsTimeShare(wrap("")), null);
  assert.equal(parseThsTimeShare(null), null);
});

test("开盘前源端日期已换成当天但分时仍是上一交易日：日期改回上一交易日；盘中不改", () => {
  const { rebaseStaleTimeShare } = require("./ths-free-market.cjs");
  const share = { date: "2026-11-10", preClose: 11.81, rows: [{ date: "2026-11-10 09:30", close: 11.8 }, { date: "2026-11-10 15:00", close: 11.89 }] };
  const before = rebaseStaleTimeShare(share, { date: "2026-11-10", minute: 9 * 60 + 26 }, "2026-11-09");
  assert.equal(before.date, "2026-11-09");
  assert.deepEqual(before.rows.map(row => row.date), ["2026-11-09 09:30", "2026-11-09 15:00"]);
  const live = { ...share, rows: [{ date: "2026-11-10 09:30", close: 11.8 }, { date: "2026-11-10 09:41", close: 11.9 }] };
  assert.equal(rebaseStaleTimeShare(live, { date: "2026-11-10", minute: 9 * 60 + 41 }, "2026-11-09"), live);
  assert.equal(rebaseStaleTimeShare(share, { date: "2026-11-10", minute: 15 * 60 + 30 }, "2026-11-09"), share, "收盘后是当天数据");
  assert.equal(rebaseStaleTimeShare(share, { date: "2026-11-10", minute: 9 * 60 + 26 }, null), share, "上一交易日未知时不改");
});
