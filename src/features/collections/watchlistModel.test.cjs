"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

const restoreTypeScript = registerTypeScript();
const { nextWatchSort, sortWatchItems, watchQuoteStats, toWatchQuotes } = require("./watchlistModel.ts");
restoreTypeScript();

test("nextWatchSort cycles desc -> asc -> off per column", () => {
  assert.deepEqual(nextWatchSort(null, "latest"), { key: "latest", dir: "desc" });
  assert.deepEqual(nextWatchSort({ key: "changePct", dir: "asc" }, "latest"), { key: "latest", dir: "desc" });
  assert.deepEqual(nextWatchSort({ key: "latest", dir: "desc" }, "latest"), { key: "latest", dir: "asc" });
  assert.equal(nextWatchSort({ key: "latest", dir: "asc" }, "latest"), null);
});

test("sortWatchItems keeps the same array reference without a sort and puts missing values last", () => {
  const items = [{ code: "1" }, { code: "2" }, { code: "3" }, { code: "4" }];
  const quotes = { 1: { latest: 10, changePct: 2 }, 2: { latest: 20, changePct: -1 }, 4: { latest: null, changePct: 5 } };
  assert.equal(sortWatchItems(items, quotes, null), items);
  assert.deepEqual(sortWatchItems(items, quotes, { key: "latest", dir: "desc" }).map(i => i.code), ["2", "1", "3", "4"]);
  assert.deepEqual(sortWatchItems(items, quotes, { key: "latest", dir: "asc" }).map(i => i.code), ["1", "2", "3", "4"]);
  assert.deepEqual(sortWatchItems(items, quotes, { key: "changePct", dir: "desc" }).map(i => i.code), ["4", "1", "2", "3"]);
});

test("sortWatchItems keeps the original order on ties", () => {
  const items = [{ code: "1" }, { code: "2" }, { code: "3" }];
  const quotes = { 1: { changePct: 1 }, 2: { changePct: 1 }, 3: { changePct: 0 } };
  assert.deepEqual(sortWatchItems(items, quotes, { key: "changePct", dir: "desc" }).map(i => i.code), ["1", "2", "3"]);
});

test("watchQuoteStats counts up, down, flat, limit-up and treats suspended as quoted flat", () => {
  const items = [{ code: "1" }, { code: "2" }, { code: "3" }, { code: "4" }, { code: "5" }, { code: "6" }];
  const quotes = {
    1: { latest: 10, changePct: 3 },
    2: { latest: 20, changePct: -2 },
    3: { latest: 15, changePct: 0 },
    4: { latest: 11, changePct: 0, tradeStatus: "suspended" },
    5: { latest: 13, changePct: 9.9, limitUp: 13 },
    6: { latest: null, changePct: null }
  };
  assert.deepEqual(watchQuoteStats(items, quotes), { quoted: 5, up: 2, down: 1, flat: 2, limitUp: 1 });
});

test("toWatchQuotes maps a batch result to the watch quote shape", () => {
  const result = { source: "腾讯行情", fetchedAt: "", missing: [],
    quotes: { "300059": { code: "300059", latest: 22.5, changePct: 3.21, limitUp: 24, tradeStatus: "trading" },
      "110079": { code: "110079", latest: 152, changePct: 0, limitUp: null, tradeStatus: "delisted" } } };
  assert.deepEqual(toWatchQuotes(result), {
    "300059": { latest: 22.5, changePct: 3.21, limitUp: 24, tradeStatus: "trading" },
    "110079": { latest: 152, changePct: 0, limitUp: null, tradeStatus: "delisted" }
  });
  assert.deepEqual(toWatchQuotes(null), {});
  assert.deepEqual(toWatchQuotes({ quotes: new Map([["1", { latest: 1, changePct: 1, limitUp: null }]]) }), { "1": { latest: 1, changePct: 1, limitUp: null, tradeStatus: undefined } });
});
