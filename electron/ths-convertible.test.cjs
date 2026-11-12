"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bonds = require("./ths-convertible.cjs");

const NOW = Date.parse("2026-10-23T02:00:00Z"); // 北京时间 10:00
const feedRow = (patch) => ({ bond_code: "123288", bond_name: "隆新转债", code: "301149", name: "隆华新材料", market_id: 35, stock_market_id: 33,
  sub_date: "2026-09-29", listing_date: "2026-10-19", expire_date: "2032-09-29", ...patch });
// 字段格式取自 2026-10-23 同花顺 d.10jqka.com.cn/v6/realhead/35_123288/last.js 的真实响应。
const quotePayload = (code, patch = {}) => ({ items: { 5: code, 10: "131.551", 6: "130.900", 7: "130.200", 8: "132.663", 9: "130.100", 13: "965933.000",
  19: "126835806.000", 199112: "0.50", 264648: "0.651", 1968584: "10.062", 526792: "1.95", 69: "157.080", 70: "104.720", name: `转债${code}`,
  updateTime: "2026-10-22 15:00", time: "2026-10-23 08:20:39 北京时间", ...patch } });

test("bond codes map to the THS bond markets", () => {
  assert.equal(bonds.bondMarket("113052"), 19);
  assert.equal(bonds.bondMarket("118077"), 19);
  assert.equal(bonds.bondMarket("123288"), 35);
  assert.equal(bonds.bondMarket("128136"), 35);
  assert.equal(bonds.bondMarket("600519"), null);
  assert.equal(bonds.bondMarket("110"), null);
});

test("the THS new-issue feed keeps listed, unexpired bonds and lists upcoming ones separately", () => {
  const feed = bonds.parseFeed({ list: [feedRow(), feedRow({ bond_code: "127120", bond_name: "千红转债", listing_date: "0" }),
    feedRow({ bond_code: "113001", expire_date: "2026-01-01" }), feedRow({ bond_code: "999999" })] }, "2026-10-23");
  assert.deepEqual(feed.listed.map((bond) => bond.code), ["123288"]);
  assert.deepEqual(feed.listed[0], { code: "123288", name: "隆新转债", market: 35, stockCode: "301149", stockName: "隆华新材料", listingDate: "2026-10-19", expireDate: "2032-09-29", source: "feed" });
  assert.deepEqual(feed.upcoming.map((bond) => bond.code), ["127120"]);
});

test("a bond snapshot keeps price, change, volume in 张, amount and the quote date", () => {
  const quote = bonds.normalizeBondQuote("123288", quotePayload("123288"));
  assert.equal(quote.latest, 131.551);
  assert.equal(quote.changePct, 0.5);
  assert.equal(quote.volume, 965933);
  assert.equal(quote.amount, 126835806);
  assert.equal(quote.turnover, 10.062);
  assert.equal(quote.quoteDate, "2026-10-22");
  assert.throws(() => bonds.normalizeBondQuote("123288", quotePayload("123287")), /代码不匹配/);
  assert.throws(() => bonds.normalizeBondQuote("123288", quotePayload("123288", { 10: "" })), /有效价格/);
});

function source({ active = ["113052", "128136"], stale = ["113001"], store, feed, failAll = false } = {}) {
  const calls = [];
  const s = bonds.createConvertibleSource({
    now: () => NOW,
    store,
    probeConcurrency: 6,
    concurrency: 4,
    readFeed: async () => { if (feed instanceof Error) throw feed; return feed || { list: [feedRow()] }; },
    readQuote: async (market, code) => {
      calls.push(`${market}_${code}`);
      if (failAll) throw Object.assign(new Error("HTTP 403"), { status: 403 });
      if (code === "123288" || active.includes(code)) return bonds.normalizeBondQuote(code, quotePayload(code));
      if (stale.includes(code)) return bonds.normalizeBondQuote(code, quotePayload(code, { updateTime: "2025-06-30 15:00" }));
      throw Object.assign(new Error("HTTP 404"), { status: 404 });
    }
  });
  return { s, calls };
}

test("first use discovers listed older bonds by code, drops stale codes, and caches the roster", async () => {
  let saved = null;
  const store = { read: () => saved, write: (value) => { saved = value; } };
  const { s, calls } = source({ store });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.deepEqual(snapshot.members.map((bond) => bond.code), ["113052", "123288", "128136"]);
  assert.ok(!snapshot.members.some((bond) => bond.code === "113001"), "a code without recent quotes is not listed");
  assert.equal(snapshot.members.find((bond) => bond.code === "123288").stockName, "隆华新材料", "feed bonds keep the underlying stock");
  assert.equal(snapshot.members.find((bond) => bond.code === "113052").secid, "1.113052");
  assert.equal(snapshot.quoteCoverage.complete, true);
  assert.equal(snapshot.summary.count, 3);
  assert.equal(snapshot.summary.rising, 3);
  assert.ok(calls.includes("19_113052") && calls.includes("35_128136"), "probes use the THS bond market prefix");
  assert.ok(calls.every((call) => /^(19|35)_\d{6}$/.test(call)));
  assert.equal(saved.schema, 1);
  assert.deepEqual(saved.bonds.map((bond) => bond.code), ["113052", "123288", "128136"]);

  const second = source({ store });
  await second.s.load({ waitForQuotes: true });
  assert.ok(second.calls.length <= 4, "a fresh cached roster is not re-probed; only its bonds are quoted");
});

test("an all-failing discovery keeps the previous roster instead of wiping it", async () => {
  const previous = { schema: 1, discoveredAt: new Date(NOW - 8 * 86400000).toISOString(), bonds: [{ code: "113052", name: "旧券", market: 19, stockCode: "", stockName: "", listingDate: "", expireDate: "", source: "discovered" }] };
  const { s } = source({ store: { read: () => previous, write: () => { throw new Error("must not overwrite"); } }, failAll: true, feed: new Error("HTTP 500") });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.deepEqual(snapshot.members.map((bond) => bond.code), ["113052"]);
  assert.match(snapshot.warnings.join(), /新券名单暂不可用/);
  assert.match(snapshot.warnings.join(), /核对未完成.*沿用上次名单/);
});

test("progress is published before all quotes are read", async () => {
  const { s } = source({});
  const first = await s.load({ waitForQuotes: false });
  assert.ok(first.quoteCoverage.pending || first.quoteCoverage.complete);
  const done = await s.load({ waitForQuotes: true });
  assert.equal(done.quoteCoverage.pending, false);
});

test("remaining years are measured from today", () => {
  assert.equal(bonds.remainingYears("2027-10-23", "2026-10-23"), 1);
  assert.equal(bonds.remainingYears("", "2026-10-23"), null);
});

test("a stale roster is quoted first; the weekly re-check of codes runs after the quotes are in", async () => {
  const previous = { schema: 1, discoveredAt: new Date(NOW - 8 * 86400000).toISOString(), bonds: [{ code: "113052", name: "旧券", market: 19, stockCode: "", stockName: "", listingDate: "", expireDate: "", source: "discovered" }] };
  let saved = null;
  const { s, calls } = source({ store: { read: () => previous, write: (value) => { saved = value; } } });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.deepEqual(calls.slice(0, 2).sort(), ["19_113052", "35_123288"], "known bonds are quoted before any code probing");
  assert.ok(calls.length > 100, "the re-check still runs afterwards");
  assert.deepEqual(snapshot.members.map((bond) => bond.code), ["113052", "123288", "128136"]);
  assert.equal(snapshot.quoteCoverage.complete, true);
  assert.ok(saved && Date.parse(saved.discoveredAt) === NOW);
});

test("no older bonds beyond the feed is a finished check, not a failure: it is cached and not repeated", async () => {
  let saved = null;
  const store = { read: () => saved, write: (value) => { saved = value; } };
  const first = source({ store, active: [], stale: [] });
  const snapshot = await first.s.load({ waitForQuotes: true });
  assert.deepEqual(snapshot.members.map((bond) => bond.code), ["123288"]);
  assert.doesNotMatch(snapshot.warnings.join(), /核对未完成/);
  assert.ok(saved?.discoveredAt, "the finished check is remembered");
  const second = source({ store, active: [], stale: [] });
  await second.s.load({ waitForQuotes: true });
  assert.ok(second.calls.length <= 2, "codes are not probed again within 7 days");
});
