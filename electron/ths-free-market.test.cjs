"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const market = require("./ths-free-market.cjs");

const security = { code: "000001", name: "平安银行", secid: "0.000001", thscode: "000001.SZ", assetType: "stock", marketName: "A股" };

// 字段取自 2026-10-21 收盘后 d.10jqka.com.cn/v6/realhead/hs_000001/last.js 的真实响应。
function realheadItems(patch = {}) {
  return {
    5: "000001", 10: "11.41", 6: "11.44", 7: "11.44", 8: "11.51", 9: "11.39",
    13: "81354137.00", 19: "930546790.00", 199112: "-0.26", 264648: "-0.030",
    1968584: "0.419", 526792: "1.049", 1771976: "0.666", 69: "12.58", 70: "10.30",
    3475914: "221418870000.000", 3541450: "221421530000.000",
    time: "2026-10-21 23:13:51 北京时间", updateTime: "2026-10-21 15:00", stockStatus: "闭市", name: "平安银行",
    ...patch
  };
}

function jsonp(callback, payload) {
  return `${callback}(${JSON.stringify(payload)})`;
}

function mockFetch(t, routes) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const text = String(url);
    calls.push(text);
    for (const [pattern, body] of routes) {
      if (pattern.test(text)) {
        const value = typeof body === "function" ? body(text) : body;
        if (value instanceof Error) throw value;
        if (typeof value === "number") return new Response("missing", { status: value });
        return new Response(value, { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };
  t.after(() => { global.fetch = original; });
  return calls;
}

test("a realhead snapshot becomes the app quote shape with lots, percentages and the quote time", () => {
  const quote = market.normalizeThsFreeQuote(security, realheadItems());
  assert.equal(quote.source, "ths_free");
  assert.equal(quote.latest, 11.41);
  assert.equal(quote.preClose, 11.44);
  assert.equal(quote.changePct, -0.26);
  assert.equal(quote.volume, 813541.37, "shares are converted to lots like the other providers");
  assert.equal(quote.volumeUnit, "lots");
  assert.equal(quote.amount, 930546790);
  assert.equal(quote.turnover, 0.419);
  assert.equal(quote.amplitude, 1.049);
  assert.equal(quote.limitUp, 12.58);
  assert.equal(quote.limitDown, 10.3);
  assert.equal(quote.quoteAt, "2026-10-21T07:00:00.000Z", "updateTime is Beijing time");
  assert.equal(quote.marketStatus, "闭市");
  assert.equal(quote.industry, "", "the free gateway never invents an industry");
  assert.deepEqual(quote.missingFields, []);
});

test("a quote that lags the server clock during continuous trading is rejected as stale", () => {
  const items = realheadItems({ stockStatus: "连续竞价", time: "2026-10-22 10:30:00 北京时间", updateTime: "2026-10-22 10:20" });
  assert.throws(() => market.normalizeThsFreeQuote(security, items), (error) => error.code === "THS_FREE_STALE" && error.lagSeconds === 600);
  const fresh = market.normalizeThsFreeQuote(security, realheadItems({ stockStatus: "连续竞价", time: "2026-10-22 10:30:20 北京时间", updateTime: "2026-10-22 10:30" }));
  assert.equal(fresh.lagSeconds, 20);
  const closed = market.normalizeThsFreeQuote(security, realheadItems({ time: "2026-10-22 23:00:00 北京时间", updateTime: "2026-10-22 15:00" }));
  assert.equal(closed.latest, 11.41, "after the close the last trade is not stale");
});

test("mismatched codes, missing prices and missing times are rejected", () => {
  assert.throws(() => market.normalizeThsFreeQuote(security, realheadItems({ 5: "600000" })), /代码不匹配/);
  assert.throws(() => market.normalizeThsFreeQuote(security, realheadItems({ 10: "" })), /有效现价/);
  assert.throws(() => market.normalizeThsFreeQuote(security, realheadItems({ updateTime: "" })), /行情时间/);
  assert.equal(market.thsFreeSupports({ code: "510300", assetType: "etf" }), false, "ETFs stay with Eastmoney/Tencent");
  assert.equal(market.thsFreeSupports({ code: "830799", assetType: "stock" }), true);
});

test("K-line placeholder rows without a full bar are discarded and volume is converted to lots", () => {
  const rows = market.parseThsLineData("20260930,11.36,11.65,11.33,11.57,104535745,1205814860.00,0.539,,88700.00,1026259;20261021,,,,1338.88,0,,0.000,,,0");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { date: "2026-09-30", open: 11.36, high: 11.65, low: 11.33, close: 11.57, volume: 1045357.45, volumeUnit: "lots", amount: 1205814860, turnover: 0.539 });
});

test("today's bar is merged from the snapshot and replaces an earlier partial bar", () => {
  const rows = [{ date: "2026-10-20", open: 11, high: 11.5, low: 10.9, close: 11.44, volume: 1, volumeUnit: "lots" }];
  const quote = market.normalizeThsFreeQuote(security, realheadItems());
  const merged = market.mergeQuoteIntoDailyRows(rows, quote);
  assert.equal(merged.length, 2);
  assert.deepEqual({ ...merged[1] }, { date: "2026-10-21", open: 11.44, high: 11.51, low: 11.39, close: 11.41, volume: 813541.37, volumeUnit: "lots", amount: 930546790, turnover: 0.419,
    preClose: 11.44, change: -.03, changePct: -.26, amplitude: 1.049, upperLimit: 12.58, lowerLimit: 10.3 });
  assert.equal(market.mergeQuoteIntoDailyRows(merged, quote).length, 2, "the same day is replaced, not duplicated");
});

test("daily history walks back year files and derives change fields", async (t) => {
  const year = (y, rows) => jsonp(`quotebridge_v6_line_hs_000001_01_${y}`, { data: rows.join(";") });
  const calls = mockFetch(t, [
    [/realhead\/hs_000001\/last\.js/, jsonp("quotebridge_v6_realhead_hs_000001_last", { items: realheadItems() })],
    [/01\/2026\.js/, year(2026, ["20261019,11.2,11.5,11.1,11.4,1000000,11400000,0.5", "20261020,11.4,11.6,11.3,11.44,1200000,13700000,0.6"])],
    [/01\/2025\.js/, year(2025, ["20251230,10.0,10.2,9.9,10.1,900000,9000000,0.4", "20251231,10.1,10.3,10.0,10.2,950000,9600000,0.45"])],
    [/01\/2024\.js/, year(2024, ["20241231,9.0,9.2,8.9,9.1,800000,7200000,0.3"])]
  ]);
  const rows = await market.thsFreeDailyHistory(security, { limit: 5, fqt: 1, now: Date.parse("2026-10-21T12:00:00Z") });
  assert.deepEqual(rows.map((row) => row.date), ["2025-12-30", "2025-12-31", "2026-10-19", "2026-10-20", "2026-10-21"]);
  assert.equal(rows.dataSource, "ths_free_qfq");
  assert.equal(rows.actualAdjustment, 1);
  assert.equal(rows.at(-1).close, 11.41, "today's bar comes from the live snapshot");
  assert.equal(rows.at(-1).preClose, 11.44);
  assert.equal(rows.at(-1).changePct, -0.26, "the quote's reported percentage takes precedence over a derived percentage");
  assert.ok(calls.every((url) => !/\/defer\//.test(url)), "the stale defer endpoint is never used");
});

test("a failed current-year file falls back to last.js and never bridges the gap with older years", async (t) => {
  const recent = ["20261016,11.0,11.2,10.9,11.1,1000000,11100000,0.5", "20261019,11.2,11.5,11.1,11.4,1000000,11400000,0.5", "20261020,11.4,11.6,11.3,11.44,1200000,13700000,0.6"];
  const calls = mockFetch(t, [
    [/realhead\/hs_000001\/last\.js/, jsonp("cb", { items: realheadItems() })],
    [/01\/2026\.js/, 404],
    [/01\/last\.js/, jsonp("cb", { data: recent.join(";") })],
    [/01\/2025\.js/, jsonp("cb", { data: "20251231,10.1,10.3,10.0,10.2,950000,9600000,0.45" })]
  ]);
  const rows = await market.thsFreeDailyHistory(security, { limit: 3, fqt: 1, now: Date.parse("2026-10-21T12:00:00Z") });
  assert.deepEqual(rows.map((row) => row.date), ["2026-10-19", "2026-10-20", "2026-10-21"], "last.js alone covers the request");
  assert.ok(calls.every((url) => !/2025\.js/.test(url)), "older years are not read after a failed year");
  await assert.rejects(market.thsFreeDailyHistory(security, { limit: 10, fqt: 1, now: Date.parse("2026-10-21T12:00:00Z") }),
    (error) => error.code === "THS_FREE_INCOMPLETE_HISTORY", "a request last.js cannot cover goes to another source instead of mixing years");
});

test("unadjusted history uses the 00 path and still merges today's bar", async (t) => {
  const calls = mockFetch(t, [
    [/realhead\/hs_000001\/last\.js/, jsonp("cb", { items: realheadItems() })],
    [/00\/2026\.js/, jsonp("cb", { data: "20261020,11.4,11.6,11.3,11.44,1200000,13700000,0.6" })],
    [/00\/2025\.js/, jsonp("cb", { data: "20251231,10.1,10.3,10.0,10.2,950000,9600000,0.45" })],
    [/00\/2024\.js/, jsonp("cb", { data: "" })]
  ]);
  const rows = await market.thsFreeDailyHistory(security, { limit: 3, fqt: 0, now: Date.parse("2026-10-21T12:00:00Z") });
  assert.equal(rows.dataSource, "ths_free_unadjusted");
  assert.equal(rows.length, 3);
  assert.ok(calls.some((url) => /\/00\/2026\.js/.test(url)));
});

test("an exchange reference in the closing quote survives daily derivation and blocks unresolved settlement", () => {
  const { simulateStrategyPortfolio } = require("./portfolio-backtest.cjs");
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21"];
  const rows = dates.slice(0, 2).map(date => ({ date, open: 10, high: 10, low: 10, close: 10, volume: 100, amount: 100000 }));
  const quote = market.normalizeThsFreeQuote(security, realheadItems({
    6: "9.50", 7: "9.50", 8: "9.50", 9: "9.50", 10: "9.50", 199112: "0", 264648: "0", 526792: "0", 69: "10.45", 70: "8.55"
  }));
  const history = market.withDerivedFields(market.mergeQuoteIntoDailyRows(rows, quote));
  assert.equal(history.at(-1).preClose, 9.5);
  assert.equal(history.at(-1).changePct, 0);
  assert.equal(history.at(-1).upperLimit, 10.45);
  assert.equal(history.at(-1).lowerLimit, 8.55);
  const result = simulateStrategyPortfolio([{ code: "000001", signalDate: dates[0], entryDate: dates[1], exitDate: dates[2], netReturn: -5, roundTripCostBps: 0 }],
    { "000001": history }, dates.map(date => ({ date, open: 100, close: 100 })), { startingCapital: 20000, maxPositions: 1 });
  assert.equal(result.trades.length, 0);
  assert.equal(result.holdings.length, 1);
  assert.equal(result.metrics.valuationComplete, false);
  assert.equal(result.metrics.endingCapital, 20000);
});

const minuteBars = (times) => times.map((time, i) => ({ date: `2026-10-21 ${time}`, open: 10 + i, high: 10 + i, low: 10 + i,
  close: 10 + i, volume: 100, amount: 100000, turnover: 1 }));

test("15-minute synthesis aligns a truncated tail with exchange clock boundaries", () => {
  const rows = market.groupMinuteRows(minuteBars(["09:40", "09:45", "09:50", "09:55", "10:00"]), 3, 5);
  assert.deepEqual(rows.map(row => ({ date: row.date, open: row.open, close: row.close, volume: row.volume })),
    [{ date: "2026-10-21 10:00", open: 12, close: 14, volume: 300 }]);
});

test("minute synthesis never joins observations across the midday break or a missing source bar", () => {
  const rows = market.groupMinuteRows(minuteBars(["11:20", "11:25", "13:05", "13:10", "13:15", "13:20", "13:30", "13:35"]), 3, 5,
    Date.parse("2026-10-21T13:36:00+08:00"));
  assert.deepEqual(rows.map(row => ({ date: row.date, open: row.open, close: row.close, volume: row.volume })),
    [{ date: "2026-10-21 13:15", open: 12, close: 14, volume: 300 }, { date: "2026-10-21 13:45", open: 17, close: 17, volume: 100 }]);
  const hours = market.groupMinuteRows(minuteBars(["11:30", "14:00", "15:00"]), 2, 60);
  assert.deepEqual(hours.map(row => ({ date: row.date, open: row.open, close: row.close })),
    [{ date: "2026-10-21 15:00", open: 11, close: 12 }]);
});

for (const [label, now] of [
  ["historical day", "2026-10-25T10:00:00+08:00"],
  ["exact bucket end", "2026-10-21T15:00:00+08:00"],
  ["after market close", "2026-10-21T15:01:00+08:00"],
  ["before the bucket starts", "2026-10-21T14:44:00+08:00"]
]) test(`an incomplete final minute bucket is discarded on ${label}`, () => {
  const rows = market.groupMinuteRows(minuteBars(["14:50", "14:55"]), 3, 5, Date.parse(now));
  assert.deepEqual(rows, []);
});

test("an incomplete final minute bucket is retained only while its own interval is forming", () => {
  const rows = market.groupMinuteRows(minuteBars(["14:50", "14:55"]), 3, 5, Date.parse("2026-10-21T14:56:00+08:00"));
  assert.deepEqual(rows.map(row => ({ date: row.date, open: row.open, close: row.close, volume: row.volume })),
    [{ date: "2026-10-21 15:00", open: 10, close: 11, volume: 200 }]);
});

test("an incomplete morning bucket is not retained during the midday break", () => {
  const rows = market.groupMinuteRows(minuteBars(["11:20", "11:25"]), 3, 5, Date.parse("2026-10-21T11:45:00+08:00"));
  assert.deepEqual(rows, []);
});

test("a complete historical minute bucket remains available after its closing boundary", () => {
  const rows = market.groupMinuteRows(minuteBars(["14:50", "14:55", "15:00"]), 3, 5, Date.parse("2026-10-25T10:00:00+08:00"));
  assert.deepEqual(rows.map(row => ({ date: row.date, open: row.open, close: row.close, volume: row.volume })),
    [{ date: "2026-10-21 15:00", open: 10, close: 12, volume: 300 }]);
});

test("THS K-line synthesis uses the supplied observation time for incomplete source tails", async t => {
  mockFetch(t, [[/30\/last\.js/, jsonp("cb", { data: "202610211450,10,10,10,10,10000,100000,1;202610211455,11,11,11,11,10000,110000,1" })]]);
  const historical = await market.thsFreeKline(security, { interval: "15", now: Date.parse("2026-10-25T10:00:00+08:00") });
  assert.deepEqual(historical, []);
  const forming = await market.thsFreeKline(security, { interval: "15", now: Date.parse("2026-10-21T14:56:00+08:00") });
  assert.equal(forming.length, 1);
  assert.equal(forming[0].date, "2026-10-21 15:00");
  assert.equal(forming[0].volume, 200);
});
