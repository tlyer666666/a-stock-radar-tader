"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEtfMarket, classifyEtf, premiumPercent } = require("./etf-market.cjs");

const row = (code, name, patch = {}) => ({ f12: code, f13: code.startsWith("1") ? 0 : 1, f14: name, f2: 1.2, f3: 0.5, f5: 1000, f6: 2e8, f8: 1.2, f10: 0.9, f17: 1.19, f18: 1.194, f20: 5e9, f441: 1.2, ...patch });
const BUCKETS = {
  MK0021: [row("510300", "沪深300ETF华泰柏瑞", { f3: 1.1 }), row("588170", "科创半导体ETF华夏", { f3: 3.2, f6: 4.5e9 }), row("159915", "创业板ETF易方达", { f3: -2.56 }), row("159388", "创业板人工智能ETF", { f3: 2.1, f6: 3e8 }), row("512880", "证券ETF国泰", { f3: 4.4, f6: 1.2e9 }), row("516000", "冷门主题ETF", { f3: 9.9, f6: 2e6 })],
  MK0022: [row("511880", "银华日利ETF", { f2: 100.992, f3: 0, f441: "-" })],
  MK0023: [row("513310", "中韩半导体ETF华泰柏瑞", { f2: 3.513, f3: -2.69, f441: 3.2108 })],
  MK0024: [row("518880", "黄金ETF华安", { f3: -0.4 })],
  MK0827: [row("518880", "黄金ETF华安", { f3: -0.4 }), row("159934", "黄金ETF易方达", { f3: -0.3 })],
  MK0828: [row("511260", "十年国债ETF国泰", { f2: "-", f3: "-", f441: "-" })]
};

function fakeFetch({ pageSize = 100, failBucket = "", bucketRows = BUCKETS } = {}) {
  const calls = [];
  const fetchJson = async url => {
    const parsed = new URL(url);
    const bucket = parsed.searchParams.get("fs").replace("b:", "");
    const page = Number(parsed.searchParams.get("pn"));
    calls.push(`${bucket}#${page}`);
    if (bucket === failBucket) throw new Error("HTTP 502");
    const all = bucketRows[bucket] || [];
    return { rc: 0, data: { total: all.length, diff: all.slice((page - 1) * pageSize, page * pageSize) } };
  };
  return { fetchJson, calls };
}

test("ETFs are grouped into broad, theme, cross-border, commodity, bond and money categories", async () => {
  const { fetchJson } = fakeFetch();
  const snapshot = await createEtfMarket({ fetchJson, now: () => Date.parse("2026-11-20T02:00:00Z") }).load();
  const byCode = Object.fromEntries(snapshot.items.map(item => [item.code, item.category]));
  assert.deepEqual(byCode, {
    "510300": "宽基", "588170": "行业主题", "159915": "宽基", "159388": "行业主题", "512880": "行业主题", "516000": "行业主题",
    "511880": "货币", "513310": "跨境", "518880": "商品", "159934": "商品", "511260": "债券"
  });
  assert.equal(snapshot.items.filter(item => item.code === "518880").length, 1, "an ETF listed in two commodity groups appears once");
  assert.equal(classifyEtf("MK0021", "中证A500ETF"), "宽基");
  assert.equal(classifyEtf("MK0021", "科创50ETF华夏"), "宽基");
});

test("premium is computed from price against the real-time NAV estimate, never from the provider's signed field", async () => {
  assert.equal(premiumPercent(3.513, 3.2108), 9.41);
  assert.equal(premiumPercent(1.2, null), null);
  assert.equal(premiumPercent(null, 1.2), null);
  const { fetchJson } = fakeFetch();
  const snapshot = await createEtfMarket({ fetchJson }).load();
  const kr = snapshot.items.find(item => item.code === "513310");
  assert.equal(kr.premiumPct, 9.41);
  assert.equal(kr.iopv, 3.2108);
  assert.equal(snapshot.items.find(item => item.code === "511880").premiumPct, null);
  assert.equal(snapshot.summary.highPremium, 1);
});

test("missing numbers stay empty and the summary ignores money funds and unpriced rows", async () => {
  const { fetchJson } = fakeFetch();
  const snapshot = await createEtfMarket({ fetchJson }).load();
  const bond = snapshot.items.find(item => item.code === "511260");
  assert.deepEqual([bond.latest, bond.changePct, bond.iopv], [null, null, null]);
  assert.equal(snapshot.summary.count, 11);
  assert.equal(snapshot.summary.rising, 5);
  assert.equal(snapshot.summary.falling, 4);
  assert.equal(snapshot.summary.flat, 0);
  assert.ok(snapshot.summary.totalAmount > 0);
});

test("the strongest themes need real turnover so a thin fund cannot top the list", async () => {
  const { fetchJson } = fakeFetch();
  const snapshot = await createEtfMarket({ fetchJson }).load();
  assert.deepEqual(snapshot.topThemes.map(item => item.code), ["512880", "588170", "159388"]);
});

test("every page of a large group is read, and a failed group is reported instead of hiding the rest", async () => {
  const many = { ...BUCKETS, MK0021: Array.from({ length: 250 }, (_, i) => row(String(560000 + i), `主题${i}ETF`)) };
  const first = fakeFetch({ bucketRows: many });
  const snapshot = await createEtfMarket({ fetchJson: first.fetchJson }).load();
  assert.equal(snapshot.items.filter(item => item.category === "行业主题").length, 250);
  assert.deepEqual(first.calls.filter(call => call.startsWith("MK0021")).sort(), ["MK0021#1", "MK0021#2", "MK0021#3"]);

  const failing = fakeFetch({ failBucket: "MK0023" });
  const partial = await createEtfMarket({ fetchJson: failing.fetchJson }).load();
  assert.ok(!partial.items.some(item => item.category === "跨境"));
  assert.match(partial.warnings.join(), /跨境/);
  assert.equal(partial.complete, false);
});

test("results are cached briefly and a manual refresh always reads again", async () => {
  let clock = Date.parse("2026-11-20T02:00:00Z");
  const { fetchJson, calls } = fakeFetch();
  const market = createEtfMarket({ fetchJson, now: () => clock });
  await market.load();
  const firstCount = calls.length;
  clock += 10_000;
  await market.load();
  assert.equal(calls.length, firstCount);
  await market.load({ forceRefresh: true });
  assert.equal(calls.length, firstCount * 2);
  clock += 60_000;
  await market.load();
  assert.equal(calls.length, firstCount * 3);
});

test("strategy and theme funds built on a broad index are not mistaken for broad-index ETFs", () => {
  for (const name of ["沪深300ETF华泰柏瑞", "中证A500ETF国泰", "A500ETF南方", "中证500ETF中银证券", "上证指数ETF富国", "科创综指ETF东财", "创业板50ETF华安", "中证1000ETF南方"]) assert.equal(classifyEtf("MK0021", name), "宽基", name);
  for (const name of ["A500红利低波ETF易方达", "300现金流ETF华宝", "创业板人工智能ETF", "科创半导体ETF华夏", "证券ETF国泰", "500增强ETF博时"]) assert.equal(classifyEtf("MK0021", name), "行业主题", name);
});

test("T+0 flag follows the exchange rule: cross-border, commodity, bond and money ETFs; A-share equity ETFs stay T+1", async () => {
  const { fetchJson } = fakeFetch();
  const snapshot = await createEtfMarket({ fetchJson }).load();
  const t0 = Object.fromEntries(snapshot.items.map(item => [item.code, item.t0]));
  assert.deepEqual(t0, {
    "510300": false, "588170": false, "159915": false, "159388": false, "512880": false, "516000": false,
    "511880": true, "513310": true, "518880": true, "159934": true, "511260": true
  });
  assert.equal(snapshot.summary.t0Count, 5);
  assert.equal(snapshot.items.find(item => item.code === "510300").amplitude, null, "missing amplitude stays null, not 0");
});

test("Hong Kong / overseas ETFs mis-filed under the A-share bucket are treated as cross-border (T+0); A+H mixes are not", () => {
  const { normalizeRow, isT0Category } = require("./etf-market.cjs");
  assert.equal(classifyEtf("MK0021", "XD港股低波红利ETF摩根"), "跨境");
  assert.equal(classifyEtf("MK0021", "恒生科技ETF某某"), "跨境");
  assert.equal(classifyEtf("MK0021", "纳指ETF某某"), "跨境");
  assert.equal(classifyEtf("MK0021", "沪港深500ETF某某"), "行业主题");
  assert.equal(classifyEtf("MK0021", "黄金股ETF永赢"), "行业主题", "gold-miner equity ETF is A-share, T+1");
  const kr = normalizeRow(row("513630", "XD港股低波红利ETF摩根", { f7: 1.86 }), "MK0021");
  assert.equal(kr.category, "跨境");
  assert.equal(kr.t0, true);
  assert.equal(kr.amplitude, 1.86);
  assert.equal(isT0Category("宽基"), false);
});
