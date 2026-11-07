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
  const keys = { changePct: "f170", turnover: "f168", amount: "f48" };
  for (const [field, rawKey] of Object.entries(keys)) for (const value of absent) {
    services.fixture.setResponse({ data: { f43: 1000, f170: 100, f168: 200, f48: 30000, [rawKey]: value } });
    const quote = await services.fixture.eastQuote(security);
    assert.deepEqual(sortedMissing(quote), [field], `${field}: ${String(value)}`);
  }
});

test("Eastmoney refuses to present a missing or non-positive latest price as a quote", async () => {
  for (const value of [...absent, 0, "0", -1, "-5", -0.01]) {
    services.fixture.setResponse({ data: { f43: value, f170: 0, f168: 0, f48: 0 } });
    await assert.rejects(
      services.fixture.eastQuote(security),
      error => error && error.code === "EAST_NO_PRICE" && /无有效最新价/.test(String(error.message)),
      `f43=${String(value)} must not become latest=0`
    );
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
// 完整字段样本（E-03 修复后的口径）。
// 修复前这个夹具把 high/low/open/preClose/limitUp/limitDown 等留成空串，
// 靠「空串被 Number() 折成 0」才让 missingFields 只报三项 —— 那正是 E-03 要消除的缺陷。
// 现在空白一律解析为 null，所以夹具必须给出真实值，再由每个用例显式清空要测的字段。
const tencentFixture = () => {
  const fields = Array(50).fill("");
  Object.assign(fields, {
    1: "fixture", 2: "600000", 3: "10.25", 30: "20260930103000",
    4: "10.05", 5: "10.12", 31: "0.25", 32: "1", 33: "10.30", 34: "10.10", 35: "10.25/300/50000",
    36: "3000", 37: "5", 38: "2", 43: "2.1", 44: "100", 45: "80",
    47: "11.28", 48: "9.23", 49: "1.2"
  });
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

test("Tencent parser keeps every absent optional field null instead of zero and reports it missing", async () => {
  // E-03 残留覆盖：不再只看 4 个监控字段，而是逐类覆盖价格（preClose/open/high/low/limitUp/limitDown）、
  // 量能（volume/amount/turnover/volumeRatio）、估值（totalMarketCap/floatMarketCap）与
  // 涨跌（change/changePct/amplitude）。空串 / 空白 / "-" / 非数字都必须解析成 null 且进入缺失清单。
  const cases = {
    4: "preClose", 5: "open", 31: "change", 32: "changePct", 33: "high", 34: "low", 36: "volume",
    37: "amount", 38: "turnover", 43: "amplitude", 44: "totalMarketCap", 45: "floatMarketCap",
    47: "limitUp", 48: "limitDown", 49: "volumeRatio"
  };
  for (const [index, field] of Object.entries(cases)) {
    for (const value of ["", " ", "-", "invalid"]) {
      tencentFields = tencentFixture();
      tencentFields[35] = ""; // amount 的原数（元）缺失，只能落到被清空的回退字段
      tencentFields[Number(index)] = value;
      const quote = await federation.tencentQuote(security);
      assert.equal(quote[field], null, field + " (field " + index + ") must stay null for " + JSON.stringify(value));
      assert.ok(sortedMissing(quote).includes(field), field + " must be reported missing");
      const normalized = services.normalizeTencentQuote(security, quote);
      assert.equal(normalized[field], null, field + " must survive normalization as null");
    }
  }
  tencentFields = tencentFixture();
  const complete = await federation.tencentQuote(security);
  assert.deepEqual(sortedMissing(complete), [], "a complete response reports no missing fields");
  assert.equal(complete.preClose, 10.05);
  assert.equal(complete.open, 10.12);
  assert.equal(complete.high, 10.3);
  assert.equal(complete.low, 10.1);
  assert.equal(complete.volume, 300000);
  assert.equal(complete.amount, 50000, "tradeSummary amount keeps priority over the 10k fallback");
  assert.equal(complete.totalMarketCap, 1e10);
  assert.equal(complete.floatMarketCap, 8e9);
  assert.equal(complete.limitUp, 11.28);
  assert.equal(complete.limitDown, 9.23);
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

test("Tencent normalization unions raw missing fields with upstream flags and emits null instead of a fake zero", () => {
  const quote = services.normalizeTencentQuote(security, { latest: 10, changePct: NaN, turnover: null, amount: undefined, missingFields: ["latest", "changePct", "ignored"] });
  // 覆盖全部价格/量能字段（13 项）。上游声明缺失优先于数值：数据源自称没有的字段
  // 即使被上游折成数字也还原为 null（fail-closed），未知上游键不透传。
  assert.deepEqual(sortedMissing(quote), ["amount", "amplitude", "change", "changePct", "high", "latest", "limitDown", "limitUp", "low", "open", "preClose", "turnover", "volume"]);
  assert.equal(quote.latest, null, "an upstream-declared missing field must not survive as a number");
  assert.ok(!sortedMissing(quote).includes("ignored"), "unknown upstream keys are not forwarded to the renderer");
  assert.equal(quote.changePct, null, "absent change must stay null, never 0");
  assert.equal(quote.turnover, null);
  assert.equal(quote.amount, null);
});

test("Tencent normalization restores upstream-declared zeros to null and covers every tracked price field", () => {
  const quote = services.normalizeTencentQuote(security, {
    latest: 10, high: 0, low: 0, open: 0, preClose: 0, limitUp: 0, limitDown: 0,
    volume: 0, amount: 0, change: 0, changePct: 0, turnover: 0, amplitude: 0,
    missingFields: ["limitUp", "limitDown", "preClose"]
  });
  assert.equal(quote.limitUp, null, "an upstream-flagged field must not survive as 0");
  assert.equal(quote.limitDown, null);
  assert.equal(quote.preClose, null);
  assert.deepEqual(sortedMissing(quote), ["limitDown", "limitUp", "preClose"]);
  assert.equal(quote.high, 0, "fields the provider really reported keep their value");
  const blank = services.normalizeTencentQuote(security, { latest: 10, high: "", open: "  ", amplitude: undefined });
  for (const field of ["high", "open", "amplitude"]) {
    assert.ok(sortedMissing(blank).includes(field), `${field} must be reported missing`);
    assert.equal(blank[field], null, `${field} must not become 0`);
  }
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
      assert.equal(quote.changePct, quote.source === "ths" ? 0 : null, "absent provider changes stay null for Eastmoney and Tencent");
      const missing = evaluateStockMonitor(config, snapshot(quote), baseline.runtime, now);
      assert.equal(missing.status, "unavailable", quote.source);
      assert.equal(missing.shouldAlert, false, quote.source);
      assert.equal(missing.runtime.matched, false, "invalid sample must not change the baseline");
      const validZero = evaluateStockMonitor(config, snapshot({ ...quote, changePct: 0, missingFields: [], updatedAt: new Date(now + 1000).toISOString() }, 1000), missing.runtime, now + 1000);
      assert.equal(validZero.shouldAlert, true, "an explicitly available zero must remain actionable");
    }
  } finally { restore(); }
});
