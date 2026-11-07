"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BEIJING_BOARD, isBeijingSector, createBeijingSectorSource, summarize } = require("./ths-beijing.cjs");
const { loadBeijingUniverse, listingUrl, COUNT_URL } = require("./beijing-universe.cjs");
const seed = require("./beijing-roster.cjs");
const member = n => ({ code: `920${String(n).padStart(3, "0")}`, symbol: `bj920${String(n).padStart(3, "0")}`, name: `北交股${n}` });
const roster = (count = 3) => ({ members: Array.from({ length: count }, (_, i) => member(i)), total: count, complete: true,
  source: "新浪财经北交所股票名录", sourceUrl: COUNT_URL, fetchedAt: "2026-10-20T06:00:00.000Z" });
const quote = code => ({ code, latest: 10, changePct: 2, amount: 1000, turnover: 1, quoteAsOf: "2026-10-20 14:20:00 北京时间" });

function listingReader({ count = 251, corruptPage = 0, changedTotal = false, extraTail = false } = {}) {
  let counts = 0;
  const calls = [];
  return { calls, readJson: async url => {
    calls.push(url);
    if (url === COUNT_URL) return String(changedTotal && counts++ ? count + 1 : count);
    const page = Number(new URL(url).searchParams.get("page"));
    if (extraTail && page === Math.ceil(count / 100) + 1) return [member(900)];
    const rows = Array.from({ length: Math.max(0, Math.min(100, count - (page - 1) * 100)) }, (_, i) => member((page - 1) * 100 + i));
    if (page === corruptPage && rows.length) rows[0] = member(0);
    return rows;
  } };
}

test("Beijing identity excludes concept and fifty-stock index", () => {
  for (const input of ["北交所", "京证A股", "北证A股", "北京证券交易所", BEIJING_BOARD]) assert.equal(isBeijingSector(input), true);
  for (const input of ["北交所概念", "北证50", "899050", "899001"]) assert.equal(isBeijingSector(input), false);
});
test("full roster verifies exact total, ordered nonduplicate pages, empty tail and count after loading", async () => {
  const reader = listingReader();
  const result = await loadBeijingUniverse(reader);
  assert.equal(result.total, 251); assert.equal(result.members.length, 251); assert.equal(result.complete, true);
  assert.deepEqual(reader.calls, [COUNT_URL, listingUrl(1), listingUrl(2), listingUrl(3), listingUrl(4), COUNT_URL]);
  assert.equal(result.members.at(-1).code, "920250");
  assert.equal(result.members[0].latest, undefined, "roster prices must never be relabelled as THS quotes");
});
test("duplicate pagination, moving totals, nonempty tail and malformed identity never count as a full roster", async () => {
  for (const options of [{ corruptPage: 2 }, { changedTotal: true }, { extraTail: true }]) await assert.rejects(loadBeijingUniverse(listingReader(options)));
  await assert.rejects(loadBeijingUniverse({ readJson: async url => url === COUNT_URL ? "1" : [{ code: "600519", symbol: "sh600519", name: "沪股" }] }));
  await assert.rejects(loadBeijingUniverse({ readJson: async () => "999999999" }));
});
test("all listed stocks remain visible when THS has missing, mismatched or invalid quotes", async () => {
  const source = createBeijingSectorSource({ readUniverse: async () => roster(5), readQuote: async code => {
    if (code === "920001") throw new Error("HTTP 502");
    if (code === "920002") return quote("600519");
    if (code === "920003") return { ...quote(code), latest: 0 };
    return quote(code);
  } });
  const result = await source.load();
  assert.equal(result.members.length, 5); assert.equal(result.memberCoverage.complete, true); assert.equal(result.memberCount, 5);
  assert.deepEqual(result.quoteCoverage, { loaded: 2, total: 5, complete: false, stale: 0, source: "同花顺", asOf: "2026-10-20", pending: false });
  assert.equal(result.members.find(row => row.code === "920001").latest, null);
  assert.equal(result.changePct, null); assert.match(result.warning, /3 只暂缺行情/);
});
test("complete THS prices permit only explicitly labelled equal-weight return; mixed dates remain incomplete", async () => {
  const all = await createBeijingSectorSource({ readUniverse: async () => roster(), readQuote: async code => quote(code) }).load();
  assert.equal(all.quoteCoverage.complete, true); assert.equal(all.changePct, 2); assert.match(all.quoteBasis, /非官方指数/);
  const mixed = await createBeijingSectorSource({ readUniverse: async () => roster(), readQuote: async code => ({ ...quote(code), quoteAsOf: code === "920000" ? "2026-10-19 15:00" : "2026-10-20 14:20" }) }).load();
  assert.equal(mixed.quoteCoverage.stale, 1); assert.equal(mixed.changePct, null);
  assert.equal(summarize([{ changePct: null }], true).changePct, null);
});
test("offline roster recovery retains all known codes but never claims current full-market membership", async () => {
  const backup = roster();
  const source = createBeijingSectorSource({ readUniverse: async () => { throw new Error("network unavailable"); }, readQuote: async code => quote(code), fallbackRoster: backup });
  const result = await source.load();
  assert.equal(result.members.length, 3); assert.equal(result.memberCoverage.complete, false); assert.equal(result.memberCoverage.total, null);
  assert.equal(result.changePct, null); assert.match(result.warning, /最新总数待核验/);
  assert.equal(seed.total, seed.members.length); assert.equal(new Set(seed.members.map(row => row.code)).size, seed.total);
  assert.ok(seed.members.length > 300); assert.ok(seed.evidenceSha256.length === 64);
});
test("quote requests stay within configured concurrency; successful cache, forced refresh and cancellation preserve ownership", async () => {
  let active = 0, maximum = 0, requests = 0, time = 0;
  const source = createBeijingSectorSource({ now: () => time, readUniverse: async () => roster(12), concurrency: 3,
    readQuote: async code => { requests++; maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return quote(code); } });
  const [left, right] = await Promise.all([source.load(), source.load()]); assert.equal(left, right); assert.equal(requests, 12); assert.equal(maximum, 3);
  await source.load(); assert.equal(requests, 12);
  await source.load({ forceRefresh: true }); assert.equal(requests, 24);
  time = 61000; await source.load(); assert.equal(requests, 36);
  const controller = new AbortController(); controller.abort(new Error("user cancelled"));
  await assert.rejects(source.load({ signal: controller.signal }), /user cancelled/);
});

test("the entire roster is returned before background quotes finish, with monotonic progress", async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const source = createBeijingSectorSource({ readUniverse: async () => roster(351), readQuote: async code => { await barrier; return quote(code); } });
  const initial = await source.load({ waitForQuotes: false });
  assert.equal(initial.members.length, 351); assert.equal(initial.quoteCoverage.pending, true); assert.equal(initial.quoteCoverage.loaded, 0);
  release();
  const final = await source.load();
  assert.equal(final.members.length, 351); assert.equal(final.quoteCoverage.loaded, 351); assert.equal(final.quoteCoverage.pending, false);
});
