"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createIndexBoard, parseTrends, marketTotals, downsample, INDEX_BOARD } = require("./index-board.cjs");

const NOW = Date.parse("2026-11-25T03:20:00.000Z"); // 北京时间 11:20
const STAMP = Date.parse("2026-11-25T03:15:00.000Z") / 1000;

const row = (secid, extra) => {
  const [market, code] = secid.split(".");
  return { f12: code, f13: Number(market), f2: 1000, f3: 0.5, f4: 5, f6: 1e10, f15: 1010, f16: 990, f17: 995, f18: 995, f104: 10, f105: 5, f106: 1, f124: STAMP, ...extra };
};
const trendsJson = (date, count, start = 1000) => ({ data: { preClose: 995, trends: Array.from({ length: count }, (_, i) => `${date} 09:${String(30 + (i % 30)).padStart(2, "0")},${(start + i).toFixed(2)}`) } });

test("the board covers the indices on the THS mobile home page in a fixed order", () => {
  assert.deepEqual(INDEX_BOARD.map(item => item.name), ["上证指数", "深证成指", "创业板指", "科创50", "北证50", "沪深300", "上证50", "中证500", "中证1000", "中证2000"]);
  assert.deepEqual(INDEX_BOARD.filter(item => item.major).map(item => item.code), ["000001", "399001", "399006", "000688"]);
});

test("quotes, two-market totals and same-day sparklines come back; missing numbers stay null", async () => {
  const urls = [];
  const fetchJson = async url => {
    urls.push(url);
    if (url.includes("ulist")) {
      return { data: { diff: [
        row("1.000001", { f2: 3513.26, f3: -0.99, f4: -35.11, f6: 3.318e11, f104: 1226, f105: 1071, f106: 58 }),
        row("0.399001", { f2: 10312.64, f3: -1.06, f6: 3.92e11, f104: 1675, f105: 1202, f106: 61 }),
        row("1.000688", { f2: "-", f3: "-", f4: "-" })
      ] } };
    }
    if (url.includes("secid=1.000001")) return trendsJson("2026-11-25", 107);
    if (url.includes("secid=0.399001")) return trendsJson("2026-11-24", 241);
    throw new Error("offline");
  };
  const board = createIndexBoard({ fetchJson, now: () => NOW });
  const value = await board.load();
  assert.equal(value.indices.length, INDEX_BOARD.length);
  assert.equal(value.tradingDate, "2026-11-25");
  const sh = value.indices[0];
  assert.equal(sh.latest, 3513.26);
  assert.equal(sh.changePct, -0.99);
  assert.equal(sh.time, "11:15");
  assert.equal(sh.trend.length, 54, "107 one-minute points sampled every 2 minutes, last kept");
  assert.equal(sh.trend.at(-1), 1106);
  assert.deepEqual(value.indices[1].trend, [], "yesterday's intraday line is not drawn as today's");
  const star = value.indices.find(item => item.code === "000688");
  assert.equal(star.latest, null);
  assert.equal(star.changePct, null);
  assert.ok(value.missing.includes("科创50"));
  assert.ok(value.missing.includes("北证50"));
  assert.deepEqual(value.totals, { amount: 3.318e11 + 3.92e11, up: 2901, down: 2273, flat: 119, scope: "沪深两市（不含北交所）" });
  // 1 秒内复用行情，60 秒内复用分时
  const before = urls.length;
  await board.load();
  assert.equal(urls.filter(url => url.includes("ulist")).length, 1);
  assert.ok(urls.length - before <= 8, "only failed trends are retried");
});

test("the board fails loudly when no index quote came back, and a trends failure never blocks quotes", async () => {
  const empty = createIndexBoard({ fetchJson: async () => ({ data: { diff: [] } }), now: () => NOW });
  await assert.rejects(empty.load(), /指数行情暂时没取到/);
  const quotesOnly = createIndexBoard({ fetchJson: async url => { if (url.includes("trends2")) throw new Error("x"); return { data: { diff: [row("1.000001")] } }; }, now: () => NOW });
  const value = await quotesOnly.load();
  assert.equal(value.indices[0].latest, 1000);
  assert.deepEqual(value.indices[0].trend, []);
  const noTrends = await quotesOnly.load({ withTrends: false, forceRefresh: true });
  assert.deepEqual(noTrends.indices[0].trend, []);
});

test("helpers: totals need both markets, sampling keeps a whole day at 121 points", () => {
  assert.equal(marketTotals([{ code: "000001", amount: 1, up: 1, down: 1, flat: 0 }]), null);
  assert.equal(downsample(Array.from({ length: 241 }, (_, i) => i)).length, 121);
  assert.deepEqual(downsample([1, 2, 3, 4]), [1, 3, 4]);
  const parsed = parseTrends({ data: { preClose: 10, trends: ["2026-11-25 09:30,10.1", "bad", "2026-11-25 09:31,-", "2026-11-25 09:32,10.3"] } });
  assert.deepEqual(parsed, { date: "2026-11-25", points: [10.1, 10.3], preClose: 10 });
});

test("M3 & L3: caller 1 aborting load() never poisons caller 2's quotes or trends, pre-aborted load skips fetch, and latest <= 0 is rejected", async () => {
  const { normalizeIndexQuote, ulistToStockFields } = require("./index-board.cjs");

  // L3: latest <= 0 is rejected in normalizeIndexQuote, load(), and ulistToStockFields()
  assert.equal(normalizeIndexQuote({ f2: 0, f3: 0 }, INDEX_BOARD[0]).latest, null);
  assert.equal(normalizeIndexQuote({ f2: -3, f3: 0 }, INDEX_BOARD[0]).latest, null);
  assert.equal(ulistToStockFields({ f2: 0, f3: 0 }).f43, undefined);
  const allZero = createIndexBoard({
    fetchJson: async () => ({ data: { diff: [row("1.000001", { f2: 0 }), row("0.399001", { f2: -1 })] } }),
    now: () => NOW
  });
  await assert.rejects(allZero.load({ withTrends: false }), /指数行情暂时没取到/);

  // M3: pre-aborted signal rejects immediately without calling fetchJson
  let calls = 0;
  const preAborted = new AbortController();
  preAborted.abort(new Error("already cancelled"));
  const guarded = createIndexBoard({ fetchJson: async () => { calls += 1; return {}; }, now: () => NOW });
  await assert.rejects(guarded.load({ signal: preAborted.signal }), /already cancelled/);
  assert.equal(calls, 0, "pre-aborted load must not initiate any upstream requests");

  // M3: caller 1 aborts mid-flight while sharing quotes() and trendOf() with caller 2
  let releaseUlist;
  let releaseTrends;
  const ulistGate = new Promise(resolve => { releaseUlist = resolve; });
  const trendsGate = new Promise(resolve => { releaseTrends = resolve; });
  let ulistCalls = 0;
  let shTrendCalls = 0;
  const board = createIndexBoard({
    now: () => NOW,
    fetchJson: async (url, options) => {
      assert.equal(options?.signal, undefined, "shared upstream fetchJson must not bind caller 1's signal");
      if (url.includes("ulist")) {
        ulistCalls += 1;
        await ulistGate;
        return { data: { diff: [row("1.000001", { f2: 3520 }), row("0.399001", { f2: 0 })] } };
      }
      if (url.includes("secid=1.000001")) {
        shTrendCalls += 1;
        await trendsGate;
        return trendsJson("2026-11-25", 5, 3510);
      }
      throw new Error("no trend");
    }
  });
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = board.load({ signal: c1.signal });
  const p2 = board.load({ signal: c2.signal });
  c1.abort(new Error("caller-1-cancelled"));
  await assert.rejects(p1, /caller-1-cancelled/);
  releaseUlist();
  releaseTrends();
  const result2 = await p2;
  assert.equal(ulistCalls, 1, "quotes request shared once");
  assert.equal(shTrendCalls, 1, "trend request shared once");
  assert.equal(result2.indices[0].latest, 3520);
  assert.deepEqual(result2.indices[0].trend, [3510, 3512, 3514], "caller 2 receives intact trend points");
  assert.equal(result2.indices[1].latest, null, "zero latest is treated as missing");
  assert.ok(result2.missing.includes("深证成指"));
});
