"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildStockProfile, trendText, summarizeAnnouncements } = require("./stock-profile.cjs");

// 构造 70 根日线：前 60 根从 10 元缓慢上涨，倒数第 3 根涨停、倒数第 2 根炸板、最后一根放量收涨。
function bars() {
  const rows = [];
  let close = 10;
  const day = index => new Date(Date.UTC(2026, 6, 1) + index * 86400000).toISOString().slice(0, 10);
  for (let index = 0; index < 67; index += 1) {
    const next = Number((close * 1.003).toFixed(2));
    rows.push({ date: day(index), open: close, close: next, high: next + 0.05, low: close - 0.05, volume: 1000, amount: 2e8, turnover: 2 });
    close = next;
  }
  const limit = Number((close * 1.1).toFixed(2));
  rows.push({ date: day(67), open: close, close: limit, high: limit, low: close, volume: 3000, amount: 6e8, turnover: 6 });
  const touched = Number((limit * 1.1).toFixed(2));
  rows.push({ date: day(68), open: limit, close: Number((limit * 1.04).toFixed(2)), high: touched, low: limit * 0.99, volume: 5000, amount: 9e8, turnover: 9 });
  const last = Number((limit * 1.06).toFixed(2));
  rows.push({ date: day(69), open: limit * 1.04, close: last, high: last + 0.1, low: limit * 1.03, volume: 4000, amount: 8e8, turnover: 8 });
  return rows;
}

test("the stock profile summarises returns, moving averages, volume and limit-up history from daily bars", () => {
  const profile = buildStockProfile({ code: "600001", name: "甲股份", industry: "电子", rows: bars() });
  assert.equal(profile.asOfDate, "2026-09-08");
  assert.equal(profile.bars, 70);
  assert.ok(profile.return5 > 10, "the limit-up shows in the 5-day return");
  assert.equal(profile.limitUps20, 1);
  assert.equal(profile.broken20, 1, "a touch of the limit without closing there counts as a broken board");
  assert.equal(profile.consecutiveBoards, 0);
  assert.equal(profile.daysSinceLimit, 2);
  assert.equal(profile.volumeRatio, 1.82, "today volume over the previous five days average");
  assert.equal(profile.above.ma5, true);
  assert.equal(trendText(profile), "站上全部均线");
  assert.ok(profile.support.length > 0 && profile.support.every(level => level.price < profile.latest));
  assert.ok(profile.support.some(level => level.label === "最近涨停日最低"));
  assert.ok(profile.resistance.every(level => level.price > profile.latest));
  assert.ok(profile.support[0].price >= profile.support.at(-1).price, "nearest support first");
});

test("the stock profile rejects bad input and tolerates short or messy histories", () => {
  assert.equal(buildStockProfile({ code: "12345", rows: bars() }), null);
  assert.equal(buildStockProfile({ code: "600001", rows: [bars()[0]] }), null);
  const messy = [{ date: "bad", close: 1 }, ...bars().slice(-3), { date: "2026-09-01", close: 5, high: 5, low: 5 }];
  const profile = buildStockProfile({ code: "300001", name: "乙", rows: messy });
  assert.equal(profile.bars, 3, "invalid and out-of-order rows are dropped");
  assert.equal(profile.ma.ma20, null);
  assert.equal(profile.return20, null);
  assert.equal(trendText({ above: { ma5: true, ma10: false, ma20: null, ma60: null } }), "站上5日线，10日线下方");
});

test("the profile carries MACD, RSI, 5-day bias, moving-average alignment and unfilled gaps", () => {
  const rows = bars();
  rows[67] = { ...rows[67], low: rows[66].high + 0.1, open: rows[66].high + 0.1 };
  const profile = buildStockProfile({ code: "600001", rows });
  assert.equal(profile.alignment, "多头排列");
  assert.ok(profile.rsi14 > 50 && profile.rsi14 <= 100);
  assert.ok(profile.bias5 > 0);
  assert.ok(profile.macd.dif > profile.macd.dea, "the late rally lifts DIF above DEA");
  assert.equal(profile.gaps.length >= 1, true, "the limit-up day left an unfilled up gap");
  assert.equal(profile.gaps.at(-1).type, "向上缺口");
});

test("announcements are limited to the 30 days before the data day, risky ones first", () => {
  const list = [
    { title: "关于签订重大合同的公告", notice_date: "2026-10-28 00:00:00", direction: "positive", riskSeverity: 0 },
    { title: "关于收到立案告知书的公告", notice_date: "2026-10-10 00:00:00", direction: "negative", riskSeverity: 3 },
    { title: "很久以前的公告", notice_date: "2026-08-01 00:00:00", direction: "neutral", riskSeverity: 0 },
    { title: "", notice_date: "2026-10-29 00:00:00" },
    { title: "未来日期的公告", notice_date: "2026-12-30 00:00:00" }
  ];
  const rows = summarizeAnnouncements(list, "2026-10-30");
  assert.deepEqual(rows.map(row => [row.date, row.direction, row.risk]), [["2026-10-10", "利空", 3], ["2026-10-28", "利好", 0]]);
  assert.equal(summarizeAnnouncements(null, "2026-10-30").length, 0);
});

test("1.6.52: date-only announcement dates are kept (they used to parse as NaN and drop risk notices)", () => {
  const rows = summarizeAnnouncements([
    { notice_date: "2026-10-20", title: "关于收到立案告知书的公告", riskSeverity: 3, direction: "negative" },
    { display_time: "2026-10-25 18:30:12", notice_date: "2026-10-26", title: "关于签订重大合同的公告", riskSeverity: 0 }
  ], "2026-10-30");
  assert.deepEqual(rows.map(row => [row.date, row.risk]), [["2026-10-20", 3], ["2026-10-25", 0]]);
});
