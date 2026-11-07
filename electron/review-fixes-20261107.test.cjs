"use strict";
// 2026-11-07 多代理审核发现的问题的回归测试（数据层）。
const test = require("node:test");
const assert = require("node:assert/strict");
const { markMemberLimitUps } = require("./services.cjs");
const { tradingDateStatus } = require("./market-time-rules.cjs");
const calendar = require("./trend-trading-calendar.cjs").createTradingCalendar();
const bundled = require("../config/a-share-market-calendar.json");

test("cheap main-board stocks at the limit price are marked limit-up even below 9.88%", () => {
  const rows = markMemberLimitUps([
    { code: "600001", name: "低价甲", latest: 1.36, changePct: 9.68 },
    { code: "600002", name: "低价乙", latest: 2.46, changePct: 9.82 },
    { code: "600003", name: "没涨停", latest: 2.45, changePct: 9.38 },
    { code: "301001", name: "C新股", latest: 12, changePct: 20 }
  ], {});
  assert.deepEqual(rows.map(row => row.isLimitUp), [true, true, false, false]);
});

test("trading-date status follows the bundled exchange calendar for every covered day", () => {
  for (let d = bundled.coveredFrom; d <= bundled.coveredTo; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    assert.equal(tradingDateStatus(d), calendar.isSession(d), d);
  }
  assert.equal(tradingDateStatus("2099-03-02"), null, "outside coverage stays unknown");
  assert.equal(tradingDateStatus("2099-03-01"), false, "weekends are closed");
});
