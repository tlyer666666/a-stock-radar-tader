"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFuyaoQuoteSource, fuyaoQuoteSupports, inTradingSession } = require("./fuyao-quote.cjs");
const { createFuyaoClient } = require("./fuyao-client.cjs");

const at = text => Date.parse(`${text}+08:00`);
const snap = (code, extra = {}) => ({ thscode: code, latest: 11, open: 10.1, high: 11, low: 10, preClose: 10, change: 1, changePct: 10, volume: 2000, amount: 2.1e6, quoteAt: new Date(at("2026-10-29T10:00:00")).toISOString(), ...extra });

function setup({ now = at("2026-10-29T10:00:30"), snapshot } = {}) {
  const calls = [];
  const source = createFuyaoQuoteSource({
    fuyao: { snapshot: async (securities) => { calls.push(securities.map(s => s.code)); return snapshot ? snapshot(securities) : new Map(securities.map(s => [`${s.code}.${/^6/.test(s.code) ? "SH" : "SZ"}`, snap(`${s.code}`)])); } },
    loadProfile: async () => ({ name: "档案名", latest: 10, floatMarketCap: 1e9, totalMarketCap: 2e9 }),
    now: () => now, batchWindowMs: 5
  });
  return { source, calls };
}

test("concurrent quote requests are merged into one batched snapshot", async () => {
  const h = setup();
  const [a, b, c] = await Promise.all(["600001", "000002", "300003"].map(code => h.source.quote({ code, name: `样本${code}`, assetType: "stock" })));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].sort(), ["000002", "300003", "600001"]);
  assert.equal(a.source, "fuyao"); assert.equal(b.code, "000002"); assert.equal(c.name, "样本300003");
});

test("missing fields are derived from exchange rules and the share profile, never invented", async () => {
  const h = setup();
  const quote = await h.source.quote({ code: "600001", name: "样本", assetType: "stock" });
  assert.equal(quote.limitUp, 11); assert.equal(quote.limitDown, 9);
  assert.ok(Math.abs(quote.turnover - 0.2) < 1e-9, "2000 手 = 20 万股，流通股 1 亿 → 换手 0.2%");
  assert.equal(quote.floatMarketCap, 1e8 * 11);
  assert.ok(Math.abs(quote.amplitude - 10) < 1e-9);
  const cyb = await h.source.quote({ code: "300001", name: "创业", assetType: "stock" });
  assert.equal(cyb.limitUp, 12);
});

test("a snapshot older than three minutes during the session is stale; off-session old data is accepted", async () => {
  const stale = setup({ now: at("2026-10-29T10:05:00") });
  await assert.rejects(() => stale.source.quote({ code: "600001", name: "样本", assetType: "stock" }), error => error.code === "FUYAO_STALE");
  const evening = setup({ now: at("2026-10-29T20:00:00") });
  assert.equal((await evening.source.quote({ code: "600001", name: "样本", assetType: "stock" })).latest, 11);
});

test("only Shanghai/Shenzhen A shares use fuyao; a stock missing from the snapshot rejects without data", async () => {
  assert.equal(fuyaoQuoteSupports({ code: "430001", assetType: "stock" }), false);
  assert.equal(fuyaoQuoteSupports({ code: "113001", assetType: "convertibleBond" }), false);
  assert.equal(fuyaoQuoteSupports({ code: "510300", assetType: "etf" }), false);
  const h = setup({ snapshot: () => new Map() });
  await assert.rejects(() => h.source.quote({ code: "600001", name: "样本", assetType: "stock" }), error => error.code === "FUYAO_EMPTY");
});

test("trading session follows exchange hours and the 2026 holiday calendar", () => {
  assert.equal(inTradingSession(at("2026-10-29T09:45:00")), true);
  assert.equal(inTradingSession(at("2026-10-29T12:00:00")), false);
  assert.equal(inTradingSession(at("2026-10-31T10:00:00")), false);
  assert.equal(inTradingSession(at("2026-10-05T10:00:00")), false);
});

test("real client null fields keep unknown volume and amount while price changes are derived", async () => {
  const clock = at("2026-10-29T10:00:00");
  const security = { code: "600001", name: "样本", assetType: "stock" };
  const client = createFuyaoClient({ getApiKey: () => "sk-fuyao-quote_fixture_0000000000", now: () => clock,
    fetchJson: async () => ({ code: 0, data: { timestamp: clock, item: [{ thscode: "600001.SH", ticker: "600001",
      last_price: 11, prev_price: 10, open_price: 10, high_price: 11, low_price: 10 }] } }) });
  const normalized = (await client.snapshot([security])).get("600001.SH");
  assert.equal(normalized.change, null);
  assert.equal(normalized.changePct, null);
  assert.equal(normalized.volume, null);
  assert.equal(normalized.amount, null);
  const source = createFuyaoQuoteSource({ fuyao: client, now: () => clock, batchWindowMs: 1,
    loadProfile: async () => ({ latest: 10, floatMarketCap: 1e9, totalMarketCap: 2e9 }) });
  const quote = await source.quote(security);
  assert.equal(quote.change, 1);
  assert.ok(Math.abs(quote.changePct - 10) < 1e-9);
  assert.equal(quote.volume, null);
  assert.equal(quote.amount, null);
  assert.equal(quote.turnover, null);
  assert.deepEqual(quote.missingFields.sort(), ["amount", "turnover", "volume"]);
});

test("an amount rejected by the real client's unit guard stays missing in the quote", async () => {
  const clock = at("2026-10-29T10:00:00");
  const client = createFuyaoClient({ getApiKey: () => "sk-fuyao-quote_fixture_0000000000", now: () => clock,
    fetchJson: async () => ({ code: 0, data: { timestamp: clock, item: [{ thscode: "600001.SH", ticker: "600001",
      last_price: 11, prev_price: 10, volume: 200000, turnover: 1 }] } }) });
  const source = createFuyaoQuoteSource({ fuyao: client, now: () => clock, batchWindowMs: 1 });
  const quote = await source.quote({ code: "600001", assetType: "stock" });
  assert.equal(quote.volume, 2000);
  assert.equal(quote.amount, null);
  assert.ok(quote.missingFields.includes("amount"));
});

test("blank, absent and invalid quote fields stay unknown while explicit zero remains valid", async () => {
  for (const value of [null, undefined, "", "  ", NaN]) {
    const h = setup({ snapshot: () => new Map([["600001.SH", snap("600001", { change: value, changePct: value, volume: value, amount: value })]]) });
    const quote = await h.source.quote({ code: "600001", assetType: "stock" });
    assert.equal(quote.change, 1);
    assert.ok(Math.abs(quote.changePct - 10) < 1e-9);
    assert.equal(quote.volume, null);
    assert.equal(quote.amount, null);
    assert.equal(quote.turnover, null);
  }
  const h = setup({ snapshot: () => new Map([["600001.SH", snap("600001", { change: 0, changePct: 0, volume: 0, amount: 0 })]]) });
  const quote = await h.source.quote({ code: "600001", assetType: "stock" });
  assert.equal(quote.change, 0);
  assert.equal(quote.changePct, 0);
  assert.equal(quote.volume, 0);
  assert.equal(quote.amount, 0);
  assert.equal(quote.turnover, 0);
  assert.deepEqual(quote.missingFields, []);
});
