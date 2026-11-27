"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createThsSealSource } = require("./ths-seal-source.cjs");
const { computeSeal } = require("./limit-seal-stream.cjs");
const { parseThsFiveRange } = require("./ths-free-market.cjs");

const NOW = Date.parse("2026-11-26T02:50:00.000Z");
const limitRow = { code: "002565", name: "顺灏股份", latest: 8.43, change_rate: 10.05, order_volume: 7.75525e7, currency_value: 8.935e9 };
const openRow = { code: "002713", name: "东易日盛", latest: 7.31, change_rate: 5.8, currency_value: 3.98e9 };
const poolJson = rows => ({ status_code: 0, data: { date: "20261126", page: { total: rows.length }, info: rows } });

test("THS five-level book is parsed from field numbers and shares become lots", () => {
  const book = parseThsFiveRange({ 24: "8.43", 25: "77533800.00", 26: "8.42", 27: "228300.00", 28: "8.41", 29: "54700.00", 150: "8.40", 151: "74200.00", 154: "8.39", 155: "6900.00", 30: "", 31: "0.00", 6: "7.66" });
  assert.deepEqual(book.bids, [{ price: 8.43, volumeLots: 775338 }, { price: 8.42, volumeLots: 2283 }, { price: 8.41, volumeLots: 547 }, { price: 8.4, volumeLots: 742 }, { price: 8.39, volumeLots: 69 }]);
  assert.deepEqual(book.asks, []);
  assert.equal(book.preClose, 7.66);
  assert.throws(() => parseThsFiveRange(null), /五档未返回/);
});

test("seal numbers come from the THS limit-up pool; the detail stock adds Tencent's live book; THS-missing codes fall back to Tencent", async () => {
  const urls = [];
  const tencentAsked = [];
  let gatewayCalls = 0;
  const source = createThsSealSource({
    now: () => NOW,
    fetchJson: async url => { urls.push(url); return url.includes("open_limit_pool") ? poolJson([openRow]) : poolJson([limitRow, { ...limitRow, code: "002149", name: "西部材料", latest: 27.86, order_volume: 6.37e6 }]); },
    thsQuote: async () => { gatewayCalls += 1; return {}; },
    thsFiveRange: async () => ({ bids: [], asks: [] }),
    tencentBatch: async securities => {
      tencentAsked.push(...securities.map(item => item.code));
      return { quotes: new Map([
        ["002149", { code: "002149", name: "西部材料", latest: 27.86, high: 27.86, limitUp: 27.86, limitDown: 22.8, floatMarketCap: 1.36e10, bids: [{ price: 27.86, volumeLots: 63230 }, { price: 27.85, volumeLots: 124 }], asks: [] }],
        ["920001", { code: "920001", latest: 13.2, limitUp: 13.2, high: 13.2, bids: [{ price: 13.2, volumeLots: 900 }], asks: [] }]
      ]) };
    }
  });
  const { quotes } = await source.read({ codes: ["002565", "002713", "002149", "920001"], detailCodes: ["002149"] });
  assert.equal(urls.filter(url => url.includes("limit_up_pool")).length, 1);
  assert.equal(urls.filter(url => url.includes("open_limit_pool")).length, 1);
  assert.match(urls[0], /date=20261126/);
  const pool = quotes.get("002565");
  assert.equal(pool.source, "同花顺涨停池");
  const poolSeal = computeSeal(pool);
  assert.equal(poolSeal.status, "sealed");
  assert.equal(poolSeal.sealLots, 775525);
  const broken = computeSeal(quotes.get("002713"));
  assert.equal(broken.status, "broken");
  assert.equal(broken.sealAmount, null);
  const detail = quotes.get("002149");
  assert.equal(detail.source, "同花顺涨停池（封单）+ 腾讯实时五档");
  assert.equal(detail.bids.length, 2, "the live five-level book is kept");
  assert.equal(computeSeal(detail).sealLots, 63700, "the seal size follows THS, not the Tencent bid1");
  assert.deepEqual(tencentAsked.sort(), ["002149", "920001"]);
  assert.equal(quotes.get("920001").source, "腾讯（同花顺涨停池里没有）");
  assert.equal(gatewayCalls, 0, "the delayed THS gateway is not used while Tencent answers");
  await source.read({ codes: ["002565"] });
  assert.equal(urls.filter(url => url.includes("limit_up_pool")).length, 1, "within the same second the pools are reused");
});

test("when Tencent has no book the detail stock uses the THS gateway (marked as delayed) and cools down after a THS failure", async () => {
  let thsCalls = 0;
  let fail = false;
  const source = createThsSealSource({
    now: () => NOW,
    fetchJson: async () => poolJson([]),
    thsQuote: async () => { thsCalls += 1; if (fail) throw new Error("HTTP 502"); return { name: "珠免集团", latest: 4.71, high: 4.71, limitUp: 4.71, limitDown: 3.85, quoteAt: "2026-11-26T02:50:00.000Z" }; },
    thsFiveRange: async () => ({ bids: [{ price: 4.71, volumeLots: 478024 }], asks: [] }),
    tencentBatch: async () => { throw new Error("tencent down"); }
  });
  const first = await source.read({ codes: ["600185"], detailCodes: ["600185"] });
  assert.equal(first.quotes.get("600185").source, "同花顺网关（约延迟 1 分钟）");
  assert.equal(computeSeal(first.quotes.get("600185")).sealLots, 478024);
  fail = true;
  const other = createThsSealSource({ now: () => NOW, fetchJson: async () => poolJson([]), thsQuote: async () => { thsCalls += 1; throw new Error("HTTP 502"); }, thsFiveRange: async () => ({ bids: [], asks: [] }), tencentBatch: async () => ({ quotes: new Map() }) });
  const before = thsCalls;
  await other.read({ codes: ["600185"], detailCodes: ["600185"] });
  await other.read({ codes: ["600185"], detailCodes: ["600185"] });
  assert.equal(thsCalls - before, 1, "after a THS failure the stock cools down for 5 seconds instead of hammering THS");
});

test("pre-open stale THS pool date never leaks yesterday's brokenHint or sealLots onto today's live Tencent quote", async () => {
  const stalePool = rows => ({ status_code: 0, data: { date: "20261125", page: { total: rows.length }, info: rows } });
  const source = createThsSealSource({
    now: () => NOW,
    fetchJson: async url => url.includes("open_limit_pool") ? stalePool([openRow]) : stalePool([limitRow]),
    thsQuote: async () => ({}),
    thsFiveRange: async () => ({ bids: [], asks: [] }),
    tencentBatch: async () => ({
      quotes: new Map([
        ["002713", { code: "002713", name: "东易日盛", latest: 7.4, high: 7.45, limitUp: 8.04, limitDown: 6.58, quoteDate: "2026-11-26", quoteAt: "2026-11-26T01:31:00.000Z", bids: [{ price: 7.39, volumeLots: 100 }], asks: [{ price: 7.4, volumeLots: 200 }] }],
        ["002565", { code: "002565", name: "顺灏股份", latest: 9.27, high: 9.27, limitUp: 9.27, limitDown: 7.59, quoteDate: "2026-11-26", quoteAt: "2026-11-26T01:31:00.000Z", bids: [{ price: 9.27, volumeLots: 50000 }], asks: [] }]
      ])
    })
  });
  const { quotes } = await source.read({ codes: ["002713", "002565"], detailCodes: ["002713", "002565"] });
  assert.equal(computeSeal(quotes.get("002713")).status, "open", "yesterday's open_limit_pool must not mark today's normal stock as broken");
  assert.equal(computeSeal(quotes.get("002565")).sealLots, 50000, "yesterday's limit_up_pool order_volume must not override today's live bid1");
});

test("same-day broken pool detail reports open-pool source label and gateway fallback computes Beijing quoteDate", async () => {
  const source = createThsSealSource({
    now: () => Date.parse("2026-11-26T16:30:00.000Z"), // 2026-11-27 00:30 Beijing
    fetchJson: async url => url.includes("open_limit_pool") ? poolJson([openRow]) : poolJson([]),
    thsQuote: async () => ({ name: "珠免集团", latest: 4.71, high: 4.71, limitUp: 4.71, limitDown: 3.85, quoteAt: "" }),
    thsFiveRange: async () => ({ bids: [{ price: 4.71, volumeLots: 1000 }], asks: [] }),
    tencentBatch: async () => ({
      quotes: new Map([
        ["002713", { code: "002713", name: "东易日盛", latest: 7.31, high: 7.9, limitUp: 8.0, limitDown: 6.5, quoteDate: "2026-11-26", bids: [], asks: [{ price: 7.31, volumeLots: 50 }] }]
      ])
    })
  });
  const { quotes } = await source.read({ codes: ["002713", "600185"], detailCodes: ["002713", "600185"] });
  assert.equal(quotes.get("002713").source, "同花顺炸板池 + 腾讯实时五档");
  assert.equal(quotes.get("600185").quoteDate, "2026-11-27", "fallback quoteDate uses Beijing date instead of empty string");
});

test("viewing an ordinary stock, a limit-down stock, or a null-latest quote never downloads the THS limit-up pools; a stock that touched limit-up does", async () => {
  const urls = [];
  const quoteOf = {
    "600519": { code: "600519", latest: 1466, high: 1470, limitUp: 1622, limitDown: 1327, bids: [{ price: 1465.9, volumeLots: 3 }], asks: [{ price: 1466.1, volumeLots: 2 }] },
    "000001": { code: "000001", latest: 9.0, high: 9.5, limitUp: 11.0, limitDown: 9.0, bids: [], asks: [{ price: 9.0, volumeLots: 4000 }] },
    "000002": { code: "000002", latest: null, high: null, limitUp: 11.0, limitDown: 9.0, bids: [], asks: [] },
    "002149": { code: "002149", latest: 27.5, high: 27.86, limitUp: 27.86, limitDown: 22.8, bids: [{ price: 27.49, volumeLots: 30 }], asks: [{ price: 27.5, volumeLots: 20 }] }
  };
  const source = createThsSealSource({
    now: () => NOW, fetchJson: async url => { urls.push(url); return poolJson([]); },
    thsQuote: async () => ({}), thsFiveRange: async () => ({ bids: [], asks: [] }),
    tencentBatch: async securities => ({ quotes: new Map(securities.map(item => [item.code, quoteOf[item.code]])) })
  });
  const plain = await source.read({ codes: ["600519"], detailCodes: ["600519"] });
  assert.equal(urls.length, 0, "no pool request for a stock nowhere near its limit");
  assert.equal(computeSeal(plain.quotes.get("600519")).status, "open");
  const limitDown = await source.read({ codes: ["000001"], detailCodes: ["000001"] });
  assert.equal(urls.length, 0, "limit-down stock must not trigger THS limit-up pool download");
  assert.equal(computeSeal(limitDown.quotes.get("000001")).status, "downSealed");
  await source.read({ codes: ["000002"], detailCodes: ["000002"] });
  assert.equal(urls.length, 0, "null latest/high must not coerce to 0 and trigger THS pool download");
  await source.read({ codes: ["002149"], detailCodes: ["002149"] });
  assert.ok(urls.some(url => url.includes("limit_up_pool")), "a stock that touched limit-up today gets the THS pool for its seal size");
});
