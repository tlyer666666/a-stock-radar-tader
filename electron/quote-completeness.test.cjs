"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// Real provider parsers, with only transport/token boundaries replaced. No
// market requests, credentials or user configuration are used by these tests.
function load(name, append = "", requires = {}) {
  const filename = path.join(__dirname, name);
  const actualRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\n" + append, {
    module, exports: module.exports,
    require: id => requires[id] || actualRequire(id),
    __dirname, __filename: filename, process, console, URL, DOMException,
    AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout,
    setImmediate, queueMicrotask, Buffer,
    fetch: async () => { throw new Error("Unexpected network"); }
  }, { filename });
  return module.exports;
}

const services = load("services.cjs", `
  module.exports.fixture = {
    eastQuote, thsQuote,
    setResponse(value) { fetchJson = async () => value; },
  };
  withThsToken = (_token, request) => request("offline-token");
`);
const security = { code: "600000", name: "离线样本", secid: "1.600000", thscode: "600000.SH" };
const sortedMissing = quote => Array.from(quote.missingFields || []).sort();
const absent = [undefined, null, "", "  ", "-", "invalid", NaN, Infinity];

test("Eastmoney marks absent raw monitor fields instead of presenting coerced zero as valid", async () => {
  const keys = { latest: "f43", changePct: "f170", turnover: "f168", amount: "f48" };
  for (const [field, rawKey] of Object.entries(keys)) for (const value of absent) {
    services.fixture.setResponse({ data: { f43: 1000, f170: 100, f168: 200, f48: 30000, [rawKey]: value } });
    const quote = await services.fixture.eastQuote(security);
    assert.deepEqual(sortedMissing(quote), [field], `${field}: ${String(value)}`);
  }
});

test("valid provider zeros and numeric strings stay available without changing Eastmoney units", async () => {
  services.fixture.setResponse({ data: { f43: "1025", f59: 2, f170: "0", f168: 0, f48: "0" } });
  const quote = await services.fixture.eastQuote(security);
  assert.deepEqual(sortedMissing(quote), []);
  assert.equal(quote.latest, 10.25);
  assert.equal(quote.changePct, 0);
  assert.equal(quote.turnover, 0);
  assert.equal(quote.amount, 0);
});

test("THS table arrays preserve missing monitor fields including null and blank cells", async () => {
  const keys = { changePct: "changeRatio", turnover: "turnoverRatio", amount: "latestAmount" };
  for (const [field, rawKey] of Object.entries(keys)) for (const value of absent) {
    services.fixture.setResponse({ errorcode: 0, tables: [{ table: { latest: [10], changeRatio: [1], turnoverRatio: [2], latestAmount: [30000], [rawKey]: [value] } }] });
    const quote = await services.fixture.thsQuote(security, { refreshToken: "offline" });
    assert.deepEqual(sortedMissing(quote), [field], `${field}: ${String(value)}`);
  }
});

test("THS valid zero/alias fields retain source units and an invalid latest price remains rejected", async () => {
  services.fixture.setResponse({ tables: [{ close: [10.25], changePct: [0], turnover: ["0"], amount: ["50000"] }] });
  const quote = await services.fixture.thsQuote(security, { refreshToken: "offline" });
  assert.deepEqual(sortedMissing(quote), []);
  assert.equal(quote.latest, 10.25);
  assert.equal(quote.changePct, 0);
  assert.equal(quote.turnover, 0);
  assert.equal(quote.amount, 50000);
  services.fixture.setResponse({ tables: [{ table: { latest: [null] } }] });
  await assert.rejects(services.fixture.thsQuote(security, { refreshToken: "offline" }), /有效最新价/);
});

let tencentFields;
const federation = load("data-federation.cjs", "", {
  "./http-client.cjs": {
    fetchArrayBufferWithPolicy: async () => Buffer.from(`v_sh600000="${tencentFields.join("~")}";`),
    fetchJsonWithPolicy: async () => { throw new Error("Unexpected network"); }
  }
});
const tencentFixture = () => {
  const fields = Array(50).fill("");
  Object.assign(fields, { 1: "fixture", 2: "600000", 3: "10.25", 30: "20260930103000", 32: "1", 35: "10.25/300/50000", 37: "5", 38: "2" });
  return fields;
};

test("Tencent parser marks missing raw cells before Number converts blanks into zero", async () => {
  for (const value of ["", " ", "-", "invalid"]) {
    tencentFields = tencentFixture();
    Object.assign(tencentFields, { 32: value, 35: "", 37: value, 38: value });
    const quote = await federation.tencentQuote(security);
    assert.deepEqual(sortedMissing(quote), ["amount", "changePct", "turnover"]);
    const normalized = services.normalizeTencentQuote(security, quote);
    assert.deepEqual(sortedMissing(normalized), ["amount", "changePct", "turnover"]);
    assert.equal(normalized.latest, 10.25);
  }
});

test("Tencent keeps valid zero values and chosen amount fallback units", async () => {
  tencentFields = tencentFixture();
  Object.assign(tencentFields, { 32: "0", 35: "", 37: "0", 38: "0" });
  const zero = await federation.tencentQuote(security);
  assert.deepEqual(sortedMissing(zero), []);
  assert.equal(zero.amount, 0);
  tencentFields[37] = "12.5";
  const fallback = await federation.tencentQuote(security);
  assert.equal(fallback.amount, 125000);
  assert.deepEqual(sortedMissing(fallback), []);
  tencentFields[35] = "10.25/300/765432";
  tencentFields[37] = "-";
  const summary = await federation.tencentQuote(security);
  assert.equal(summary.amount, 765432);
  assert.deepEqual(sortedMissing(summary), []);
});

test("Tencent normalization unions raw missing fields with upstream flags without changing legacy values", () => {
  const quote = services.normalizeTencentQuote(security, { latest: 10, changePct: NaN, turnover: null, amount: undefined, missingFields: ["latest", "changePct", "ignored"] });
  assert.deepEqual(sortedMissing(quote), ["amount", "changePct", "latest", "turnover"]);
  assert.equal(quote.latest, 10);
  assert.equal(quote.changePct, 0);
  assert.equal(quote.turnover, 0);
  assert.equal(quote.amount, 0);
});

test("real provider parsing through monitor evaluation rejects missing zero placeholders and still alerts on a real zero", async () => {
  const restore = require("../qa/register-typescript.cjs").registerTypeScript();
  try {
    const { evaluateStockMonitor } = require("../src/stockMonitorRules.ts");
    const now = Date.parse("2026-09-30T02:30:00Z");
    const config = { enabled: true, mode: "all", cooldownMinutes: 5, conditions: [{ id: "pct", field: "changePct", operator: "lte", value: 0 }] };
    const snapshot = (quote, offset = 0) => ({ quote, updatedAt: new Date(now + offset).toISOString() });
    const baseline = evaluateStockMonitor(config, snapshot({ latest: 10, changePct: 1 }, -1000), undefined, now - 1000);
    services.fixture.setResponse({ data: { f43: 1000, f170: null, f168: 100, f48: 50000 } });
    const east = await services.fixture.eastQuote(security);
    services.fixture.setResponse({ tables: [{ table: { latest: [10], changeRatio: [null], turnoverRatio: [1], latestAmount: [50000] } }] });
    const ths = await services.fixture.thsQuote(security, { refreshToken: "offline" });
    tencentFields = tencentFixture();
    tencentFields[32] = "";
    const tencent = services.normalizeTencentQuote(security, await federation.tencentQuote(security));
    for (const quote of [east, ths, tencent]) {
      assert.equal(quote.changePct, 0, "legacy value remains compatible");
      const missing = evaluateStockMonitor(config, snapshot(quote), baseline.runtime, now);
      assert.equal(missing.status, "unavailable", quote.source);
      assert.equal(missing.shouldAlert, false, quote.source);
      assert.equal(missing.runtime.matched, false, "invalid sample must not change the baseline");
      const validZero = evaluateStockMonitor(config, snapshot({ ...quote, missingFields: [], updatedAt: new Date(now + 1000).toISOString() }, 1000), missing.runtime, now + 1000);
      assert.equal(validZero.shouldAlert, true, "an explicitly available zero must remain actionable");
    }
  } finally { restore(); }
});
