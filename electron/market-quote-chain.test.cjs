"use strict";

// E-02 / D-01：本文件用 global.fetch 替身模拟三路行情。services.cjs 在东方财富失败时
// 会走 execFile curl 逃生通道，那条路径绕开 fetch 替身直连真实网络（曾让本文件两条
// 用例长期红灯）。这里显式关闭 curl 兜底，使测试完全密闭、不再依赖外网。
process.env.ASTOCK_DISABLE_CURL = "1";

const test = require("node:test");
const assert = require("node:assert/strict");
const services = require("./services.cjs");

const thsItems = (code = "600519", patch = {}) => ({
  5: code, 10: "1257.12", 6: "1266.98", 7: "1262.99", 8: "1265.88", 9: "1256.10", 13: "2489087.00", 19: "3135849100.00",
  199112: "-0.78", 264648: "-9.860", 1968584: "0.199", 526792: "0.772", 1771976: "1.143", 69: "1393.68", 70: "1140.28",
  3475914: "1571502600000.000", 3541450: "1571502600000.000", name: "贵州茅台", stockStatus: "闭市",
  time: "2026-10-21 23:00:00 北京时间", updateTime: "2026-10-21 15:00", ...patch
});

const eastData = {
  f43: 125700, f44: 126588, f45: 125610, f46: 126299, f47: 24890, f48: 3135849100, f50: 114, f51: 139368, f52: 114028,
  f57: "600519", f58: "贵州茅台", f59: 2, f60: 126698, f116: 1571502600000, f117: 1571502600000, f127: "白酒",
  f168: 20, f169: -986, f170: -78, f171: 77
};

function routeFetch(t, { ths = "ok", east = "ok", tencent = "ok" } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.includes("d.10jqka.com.cn/v6/realhead/")) {
      const code = text.match(/hs_(\d{6})/)?.[1] || "600519";
      if (ths === "ok") return new Response(`quotebridge_v6_realhead_hs_${code}_last(${JSON.stringify({ items: thsItems(code) })})`, { status: 200 });
      return new Response("busy", { status: 503 });
    }
    if (text.includes("/stock/get?")) {
      if (east === "ok") return new Response(JSON.stringify({ data: eastData }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("busy", { status: 502 });
    }
    if (text.includes("qt.gtimg.cn")) {
      if (tencent === "ok") return new Response('v_sh600519="1~贵州茅台~600519~1257.20~1266.98~1262.99~24890~0~0~~~~~~~~~~~~~~~~~~~~~~~~~~20261021150000~-9.78~-0.77~1265.88~1256.10~1257.20/24890/3135849100~24890~313585~0.20~17.65~~1265.88~1256.10~0.77~15715.03~15715.03~8.20~1393.68~1140.28~1.14";', { status: 200 });
      return new Response("busy", { status: 500 });
    }
    throw new Error(`unexpected test request: ${text}`);
  };
  t.after(() => { global.fetch = original; services.resetMarketSourceHealth(); });
  services.resetMarketSourceHealth();
  return calls;
}

const settings = { provider: "ths", refreshToken: "", multiSourceEnabled: true, fallbackEnabled: true };

test("without a QuantAPI token the THS free gateway is the primary realtime source", async (t) => {
  const calls = routeFetch(t);
  const snapshot = await services.getQuoteSnapshot("600519", settings);
  assert.equal(snapshot.actualProvider, "ths_free");
  assert.equal(snapshot.requestedPrimary, "ths");
  assert.equal(snapshot.primaryStatus, "free_active");
  assert.equal(snapshot.warning, "", "no 'token missing' warning while the free gateway works");
  assert.equal(snapshot.quote.latest, 1257.12);
  assert.equal(snapshot.quote.quoteAt, "2026-10-21T07:00:00.000Z");
  assert.ok(calls.every((url) => !url.includes("/stock/get?")), "Eastmoney is not needed while THS answers");
  assert.ok(calls.every((url) => !url.includes("/defer/")));
  const health = services.getMarketSourceHealth();
  assert.equal(health.quotes.find((entry) => entry.id === "ths_free").status, "ok");
});

test("a failing THS gateway is relayed by Eastmoney, then paused so polling stops waiting on it", async (t) => {
  const calls = routeFetch(t, { ths: "down" });
  const first = await services.getQuoteSnapshot("600519", settings);
  assert.equal(first.actualProvider, "eastmoney");
  assert.equal(first.primaryStatus, "fallback");
  assert.match(first.warning, /同花顺免费行情暂不可用.*东方财富接力/);
  assert.equal(first.quote.industry, "白酒");
  await services.getQuoteSnapshot("600519", settings);
  const thsCallsBefore = calls.filter((url) => url.includes("d.10jqka.com.cn")).length;
  const third = await services.getQuoteSnapshot("600519", settings);
  const thsCallsAfter = calls.filter((url) => url.includes("d.10jqka.com.cn")).length;
  assert.equal(thsCallsAfter, thsCallsBefore, "the paused THS line is skipped");
  assert.match(third.warning, /等待自动重试/);
  const ths = services.getMarketSourceHealth().quotes.find((entry) => entry.id === "ths_free");
  assert.equal(ths.status, "open");
  assert.ok(ths.retryAt);
});

test("an industry learnt from Eastmoney is reused on later THS quotes", async (t) => {
  routeFetch(t, { ths: "down" });
  await services.getQuoteSnapshot("600519", settings);
  services.resetMarketSourceHealth();
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("d.10jqka.com.cn")) return new Response(`cb(${JSON.stringify({ items: thsItems() })})`, { status: 200 });
    return original(url);
  };
  const snapshot = await services.getQuoteSnapshot("600519", settings);
  assert.equal(snapshot.actualProvider, "ths_free");
  assert.equal(snapshot.quote.industry, "白酒");
});

test("the connection test reports every line separately", async (t) => {
  routeFetch(t, { ths: "ok", east: "down" });
  const result = await services.testProvider(settings);
  assert.equal(result.ok, true);
  const byId = Object.fromEntries(result.lanes.map((lane) => [lane.id, lane]));
  assert.equal(byId.ths_free.ok, true);
  assert.equal(byId.eastmoney.ok, false);
  assert.match(result.message, /同花顺免费行情可用/);
  assert.equal(result.lanes.some((lane) => lane.id === "quantapi"), false, "QuantAPI is optional and not tested without a token");
});

test("an explicit Eastmoney choice keeps Eastmoney first and THS as the last relay", async (t) => {
  const calls = routeFetch(t, { east: "down", tencent: "down" });
  const snapshot = await services.getQuoteSnapshot("600519", { ...settings, provider: "eastmoney" });
  assert.equal(snapshot.actualProvider, "ths_free");
  const order = calls.map((url) => url.includes("/stock/get?") ? "east" : url.includes("gtimg") ? "tencent" : "ths");
  assert.deepEqual([...new Set(order)], ["east", "tencent", "ths"]);
});
