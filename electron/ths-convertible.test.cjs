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

function source({ active = ["113052", "128136"], stale = ["113001"], store, feed, failAll = false, readBatch, feedReads } = {}) {
  const calls = [];
  const s = bonds.createConvertibleSource({
    now: () => NOW,
    store,
    probeConcurrency: 6,
    concurrency: 4,
    readFeed: async () => { if (feedReads) feedReads.count += 1; if (feed instanceof Error) throw feed; return feed || { list: [feedRow()] }; },
    readQuote: async (market, code) => {
      calls.push(`${market}_${code}`);
      if (failAll) throw Object.assign(new Error("HTTP 403"), { status: 403 });
      if (code === "123288" || active.includes(code)) return bonds.normalizeBondQuote(code, quotePayload(code));
      if (stale.includes(code)) return bonds.normalizeBondQuote(code, quotePayload(code, { updateTime: "2025-06-30 15:00" }));
      throw Object.assign(new Error("HTTP 404"), { status: 404 });
    },
    ...(readBatch === undefined ? {} : { readBatch })
  });
  return { s, calls };
}

// 与腾讯批量接口一致的行情形状（volumeLots 为手，转债 1 手 = 10 张）。
const batchQuote = (code, patch = {}) => ({ code, name: `转债${code}`, latest: 131.551, preClose: 130.9, open: 130.2,
  high: 132.663, low: 130.1, change: 0.651, changePct: 0.5, volumeLots: 96593.3, amount: 126835806,
  turnover: 10.062, amplitude: 1.95, floatMarketCap: null, totalMarketCap: null, limitUp: 157.08, limitDown: 104.72,
  quoteAt: "2026-10-22T07:00:00.000Z", quoteDate: "2026-10-22", tradeStatus: "trading", source: "腾讯行情", ...patch });
const freshStore = (bonds = [{ code: "113052", name: "旧券", market: 19, stockCode: "", stockName: "", listingDate: "", expireDate: "", source: "discovered" }]) => (
  { schema: 1, discoveredAt: new Date(NOW).toISOString(), bonds });

test("a batch that answers every bond skips per-bond THS reads and reports 腾讯行情 source", async () => {
  const { s, calls } = source({
    store: { read: () => freshStore(), write: () => {} },
    readBatch: async (targets) => new Map(targets.map((bond) => [bond.code, batchQuote(bond.code)]))
  });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.deepEqual(calls, [], "批量行情覆盖全部在市债时不再逐只读同花顺");
  assert.equal(snapshot.quoteCoverage.complete, true);
  assert.equal(snapshot.quoteCoverage.source, "腾讯行情");
  assert.equal(snapshot.source, "腾讯批量行情；名单来自同花顺");
  const member = snapshot.members.find((bond) => bond.code === "123288");
  assert.equal(member.volume, 965933, "手 × 10 = 张");
  assert.equal(member.tradeStatus, "trading");
});

test("delisted batch quotes exclude the bond, persist the code and are never re-quoted", async () => {
  let saved = null;
  const store = { read: () => saved ?? freshStore(), write: (value) => { saved = value; } };
  const { s, calls } = source({
    store,
    readBatch: async (targets) => new Map(targets.map((bond) => [bond.code,
      bond.code === "123288" ? batchQuote(bond.code, { tradeStatus: "delisted", latest: 135.998 }) : batchQuote(bond.code)]))
  });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.deepEqual(snapshot.members.map((bond) => bond.code), ["113052"]);
  assert.equal(snapshot.summary.count, 1);
  assert.equal(snapshot.roster.delistedCount, 1);
  assert.deepEqual(saved.delisted, ["123288"]);
  assert.ok(!calls.some((call) => call.endsWith("_123288")), "已摘牌券不再逐只读同花顺");
  let batchTargets = [];
  const second = source({ store, readBatch: async (targets) => { batchTargets = targets.map((bond) => bond.code); return new Map(); } });
  const again = await second.s.load({ waitForQuotes: true });
  assert.ok(batchTargets.includes("123288"), "已存摘牌码也会再向批量接口核对一次");
  assert.deepEqual(again.members.map((bond) => bond.code), ["113052"], "批量没答到的摘牌码仍按摘牌保留");
  assert.ok(!second.calls.some((call) => call.endsWith("_123288")));
});

test("a stored delisted code that trades again is re-listed and dropped from the store", async () => {
  let saved = null;
  const stored = { ...freshStore(), delisted: ["113052"] };
  const store = { read: () => stored, write: (value) => { saved = value; } };
  const { s } = source({ store, readBatch: async (targets) => new Map(targets.map((bond) => [bond.code, batchQuote(bond.code)])) });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.equal(snapshot.members.find((bond) => bond.code === "113052")?.tradeStatus, "trading");
  assert.equal(snapshot.roster.delistedCount, 0);
  assert.deepEqual(saved.delisted, []);
});

test("a suspended bond stays listed with a 停牌 tag status", async () => {
  const { s } = source({
    store: { read: () => freshStore(), write: () => {} },
    readBatch: async (targets) => new Map(targets.map((bond) => [bond.code,
      bond.code === "123288" ? batchQuote(bond.code, { tradeStatus: "suspended", volumeLots: 0, amount: 0, changePct: 0 }) : batchQuote(bond.code)]))
  });
  const snapshot = await s.load({ waitForQuotes: true });
  const member = snapshot.members.find((bond) => bond.code === "123288");
  assert.equal(member.tradeStatus, "suspended");
  assert.equal(member.quoteStatus, "ready");
});

test("a bond missing from the batch falls back to the per-bond THS read", async () => {
  const { s, calls } = source({
    store: { read: () => freshStore(), write: () => {} },
    readBatch: async (targets) => new Map(targets.filter((bond) => bond.code !== "123288").map((bond) => [bond.code, batchQuote(bond.code)]))
  });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.equal(snapshot.members.find((bond) => bond.code === "123288").quoteStatus, "ready");
  assert.ok(calls.includes("35_123288"), "批量缺口的券走同花顺逐只快照");
  assert.equal(snapshot.quoteCoverage.source, "腾讯行情、同花顺");
  assert.equal(snapshot.source, "腾讯批量行情，个别用同花顺逐券快照补齐；名单来自同花顺");
});

test("a rejected batch falls back to per-bond reads and stored delisted codes still apply", async () => {
  const stored = { ...freshStore(), delisted: ["123288"] };
  const { s, calls } = source({
    store: { read: () => stored, write: () => {} },
    readBatch: async () => { throw new Error("批量接口限流"); }
  });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.deepEqual(snapshot.members.map((bond) => bond.code), ["113052"]);
  assert.equal(snapshot.quoteCoverage.source, "同花顺");
  assert.ok(!calls.some((call) => call.endsWith("_123288")), "已存摘牌码在批量失败时仍被跳过");
  assert.ok(calls.includes("19_113052"), "其余券回落到逐只读取");
});

test("a feed whose earliest listing is beyond the max bond term skips range probing entirely", async () => {
  let saved = null;
  const store = { read: () => null, write: (value) => { saved = value; } };
  const { s, calls } = source({ store, feed: { list: [feedRow({ listing_date: "2019-01-01" })] } });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.deepEqual(snapshot.members.map((bond) => bond.code), ["123288"]);
  assert.ok(calls.length <= 2, `完整历史名单下不再探测代码段，实际 ${calls.length} 次读取`);
  assert.ok(Date.parse(saved.discoveredAt) === NOW);
});

test("the roster file is only rewritten when the bond or delisted sets change", async () => {
  const writes = [];
  const store = { read: () => writes.at(-1) ?? null, write: (value) => { writes.push(value); } };
  const { s } = source({ store, feed: { list: [feedRow({ listing_date: "2019-01-01" })] } });
  await s.load({ waitForQuotes: true });
  await s.load({ forceRefresh: true, waitForQuotes: true });
  assert.equal(writes.length, 1, "名单与摘牌集合都没变时第二次刷新不再写盘");
});

test("a feed outage falls back to the stored roster's feed bonds and still applies batch quotes", async () => {
  const stored = { schema: 1, discoveredAt: new Date(NOW).toISOString(), bonds: [
    { code: "113052", name: "在市旧券", market: 19, stockCode: "", stockName: "", listingDate: "2023-01-01", expireDate: "2029-01-01", source: "feed" },
    { code: "128136", name: "到期旧券", market: 35, stockCode: "", stockName: "", listingDate: "2020-01-01", expireDate: "2026-01-01", source: "feed" }
  ], delisted: [] };
  const { s, calls } = source({ store: { read: () => stored, write: () => {} }, feed: new Error("HTTP 502"),
    readBatch: async (targets) => new Map(targets.map((bond) => [bond.code, batchQuote(bond.code)])) });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.deepEqual(snapshot.members.map((bond) => bond.code), ["113052"]);
  assert.match(snapshot.warnings.join(), /同花顺发行名单暂不可用，先用上次保存的名单/);
  assert.equal(snapshot.quoteCoverage.source, "腾讯行情");
  assert.deepEqual(calls, []);
});

test("the feed payload is cached for 30 minutes and read again after it expires", async () => {
  let time = NOW;
  const feedReads = { count: 0 };
  const s = bonds.createConvertibleSource({
    now: () => time,
    store: { read: () => freshStore(), write: () => {} },
    concurrency: 4,
    readFeed: async () => { feedReads.count += 1; return { list: [feedRow()] }; },
    readQuote: async (market, code) => bonds.normalizeBondQuote(code, quotePayload(code))
  });
  await s.load({ waitForQuotes: true });
  time = NOW + 61 * 1000;
  await s.load({ waitForQuotes: true });
  assert.equal(feedReads.count, 1, "30 分钟内新券名单只读一次");
  time = NOW + 31 * 60 * 1000;
  await s.load({ waitForQuotes: true });
  assert.equal(feedReads.count, 2);
  const fresh = await s.load({ forceRefresh: true, waitForQuotes: true });
  assert.equal(feedReads.count, 3, "手动强制刷新不受 30 分钟名单缓存影响");
  assert.ok(fresh.members.length > 0);
});

test("parseFeed reports the earliest listing date across all convertible rows", () => {
  const feed = bonds.parseFeed({ list: [feedRow(), feedRow({ bond_code: "113001", listing_date: "2019-05-06", expire_date: "2026-01-01" }),
    feedRow({ bond_code: "127120", listing_date: "0" })] }, "2026-10-23");
  assert.equal(feed.earliestListingDate, "2019-05-06");
  assert.equal(bonds.parseFeed({ list: [] }, "2026-10-23").earliestListingDate, "");
});

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

test("polling again while quotes are still loading returns the latest progress instead of throwing", async () => {
  const { s } = source({});
  const first = await s.load({ waitForQuotes: false });
  assert.equal(first.quoteCoverage.pending, true);
  const again = await s.load({ waitForQuotes: false, signal: new AbortController().signal });
  assert.ok(Array.isArray(again.members));
  const unsignalled = await s.load({ waitForQuotes: false });
  assert.ok(Array.isArray(unsignalled.members));
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

test("a snapshot with no ready quote reports an empty coverage source", async () => {
  const { s } = source({ failAll: true });
  const snapshot = await s.load({ waitForQuotes: true });
  assert.equal(snapshot.quoteCoverage.loaded, 0);
  assert.equal(snapshot.quoteCoverage.source, "");
});
