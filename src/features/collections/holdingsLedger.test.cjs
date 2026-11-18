"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

const restoreTypeScript = registerTypeScript();
const {
  applyHoldingTrade,
  buildStopLossMonitorConfig,
  computeMonitorStopPrice,
  inferSecurityMeta,
  maskSensitiveText,
  mergeImportedHoldings,
  parseHoldingsPaste
} = require("./holdingsLedger.ts");

const sampleHolding = {
  code: "600519",
  name: "贵州茅台",
  secid: "1.600519",
  shares: 200,
  costPrice: 1500,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  note: "底仓"
};

test("applyHoldingTrade dilutes cost on buy and tracks partial/full sell", () => {
  const buyRes = applyHoldingTrade({
    items: [sampleHolding],
    code: "600519",
    side: "buy",
    shares: 100,
    price: 1350,
    now: "2026-11-15T02:00:00.000Z"
  });
  assert.equal(buyRes.ok, true);
  assert.equal(buyRes.action, "added");
  assert.equal(buyRes.remainingShares, 300);
  assert.equal(buyRes.costPrice, 1450);

  const partialSell = applyHoldingTrade({
    items: buyRes.nextItems,
    code: "600519",
    side: "sell",
    shares: 100,
    price: 1550
  });
  assert.equal(partialSell.ok, true);
  assert.equal(partialSell.action, "reduced");
  assert.equal(partialSell.remainingShares, 200);
  assert.equal(partialSell.realizedPnl, 10000);

  const fullClose = applyHoldingTrade({
    items: partialSell.nextItems,
    code: "600519",
    side: "sell",
    shares: 200,
    price: 1560
  });
  assert.equal(fullClose.ok, true);
  assert.equal(fullClose.action, "closed");
  assert.equal(fullClose.nextItems.length, 0);
});

test("applyHoldingTrade rejects sell without holding or invalid inputs", () => {
  const missing = applyHoldingTrade({ items: [], code: "000001", side: "sell", shares: 100, price: 10 });
  assert.equal(missing.ok, false);
  const badCode = applyHoldingTrade({ items: [], code: "123", side: "buy", shares: 100, price: 10 });
  assert.equal(badCode.ok, false);
});

test("parseHoldingsPaste supports multi-format rows and reports invalid lines", () => {
  const parsed = parseHoldingsPaste([
    "证券代码 股票名称 数量 成本价",
    "600519.SH 贵州茅台 200 1480.5 底仓观察",
    "000858,500,145.2",
    "东方财富\t300059\t1,200股\t21.8元",
    "bad-line-here"
  ].join("\n"));

  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.errors.length, 1);
  assert.deepEqual(
    parsed.entries.map(item => [item.code, item.name, item.shares, item.costPrice]),
    [
      ["000858", "000858", 500, 145.2],
      ["300059", "东方财富", 1200, 21.8],
      ["600519", "贵州茅台", 200, 1480.5]
    ]
  );

  const merged = mergeImportedHoldings([sampleHolding], parsed.entries);
  assert.equal(merged.length, 3);
  assert.equal(merged.find(i => i.code === "600519")?.costPrice, 1480.5);
  assert.equal(merged.find(i => i.code === "300059")?.marketName, "创业板");
  assert.equal(inferSecurityMeta("920001").secid, "0.920001");
});

test("buildStopLossMonitorConfig generates valid stop rules and preserves custom conditions", () => {
  const cfg = buildStopLossMonitorConfig(100, -5, {
    enabled: true,
    mode: "any",
    cooldownMinutes: 10,
    conditions: [
      { id: "custom-up", field: "changePct", operator: "gte", value: 7 },
      { id: "quick-stop-price-5", field: "latest", operator: "lte", value: 88 }
    ]
  });
  assert.ok(cfg);
  assert.equal(computeMonitorStopPrice(cfg), 95);
  assert.equal(cfg.conditions.length, 2);

  const fallbackCfg = buildStopLossMonitorConfig(null, -7);
  assert.ok(fallbackCfg);
  assert.equal(fallbackCfg.conditions[0].field, "changePct");
  assert.equal(fallbackCfg.conditions[0].value, -7);

  assert.equal(maskSensitiveText("¥12,345.00", true), "***");
  assert.equal(maskSensitiveText("¥12,345.00", false), "¥12,345.00");
});

after(() => {
  restoreTypeScript();
});
