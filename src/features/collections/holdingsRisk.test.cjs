"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let restoreTypeScript;
let risk;
let board;
before(() => { restoreTypeScript = registerTypeScript(); risk = require("./holdingsRisk.ts"); board = require("./HoldingsRiskBoard.tsx"); });
after(() => restoreTypeScript?.());

const holdings = [
  { code: "600519", name: "贵州茅台", shares: 100, costPrice: 1500 },
  { code: "000858", name: "五粮液", shares: 200, costPrice: 150 },
  { code: "300750", name: "宁德时代", shares: 100, costPrice: 300 }
];
const quotes = { "600519": { latest: 1400, industry: "白酒", failed: false }, "000858": { latest: 135, industry: "白酒", failed: false }, "300750": { latest: 310, industry: "电池", failed: false } };
const flag = (report, id) => report.flags.find(item => item.id === id);

test("a complete portfolio gets concentration, stop, drawdown, AI and price flags with numbers", () => {
  const key = risk.holdingsKey(holdings);
  const history = [{ date: "2026-11-24", ratio: 1.08, key }, { date: "2026-11-25", ratio: 1.02, key }];
  const report = risk.buildRiskReport(holdings, quotes, history, [{ code: "600519", name: "贵州茅台", action: "reduce", actionLabel: "减仓" }, { code: "688001", name: "别的", action: "sell", actionLabel: "卖出" }]);
  assert.equal(report.totalValue, 140000 + 27000 + 31000);
  assert.equal(flag(report, "single").state, "alert");
  assert.match(flag(report, "single").detail, /贵州茅台 占 70\.7%/);
  assert.equal(flag(report, "sector").state, "alert");
  assert.match(flag(report, "sector").detail, /「白酒」占 84\.3%/);
  assert.equal(flag(report, "stop").state, "alert");
  assert.equal(flag(report, "stop").value, "1 只破位");
  assert.match(flag(report, "stop").detail, /五粮液 -10\.0%（已亏超 8%）；贵州茅台 -6\.7%/);
  assert.equal(flag(report, "drawdown").state, "alert");
  assert.equal(flag(report, "ai").value, "1 条防御");
  assert.equal(flag(report, "price").state, "ok");
  assert.deepEqual(report.sectors.map(item => item.name), ["白酒", "电池"]);
});

test("missing prices, missing industries and thin history say unavailable instead of pretending to be fine", () => {
  const partial = risk.buildRiskReport(holdings, { ...quotes, "300750": { latest: null, industry: "电池", failed: true } }, [], null);
  for (const id of ["single", "sector", "stop", "drawdown", "ai"]) assert.equal(flag(partial, id).state, "unavailable", id);
  assert.match(flag(partial, "single").detail, /1 只没有有效行情/);
  assert.equal(flag(partial, "price").state, "alert");
  assert.equal(partial.totalValue, null, "a partial total is not reported");
  assert.equal(partial.positions.length, 0);
  const noIndustry = risk.buildRiskReport(holdings, { ...quotes, "300750": { latest: 310, industry: "", failed: false } }, [{ date: "2026-11-25", ratio: 1, key: risk.holdingsKey(holdings) }], []);
  assert.equal(flag(noIndustry, "sector").state, "unavailable");
  assert.match(flag(noIndustry, "sector").detail, /1 只没有行业分类（宁德时代）/);
  assert.equal(flag(noIndustry, "single").state, "alert");
  assert.equal(flag(noIndustry, "drawdown").state, "unavailable");
  assert.match(flag(noIndustry, "drawdown").detail, /不到两天/);
  const one = risk.buildRiskReport([holdings[0]], quotes, [], []);
  assert.equal(flag(one, "single").state, "ok", "a single holding is stated, not flagged as concentration");
  assert.equal(risk.buildRiskReport([], {}, [], []).flags.every(item => item.state === "unavailable" || item.id === "ai"), true);
});

test("daily equity points overwrite the same day, ignore bad values and keep order", () => {
  let history = risk.recordEquity([], "2026-11-25", 1.02, "k1");
  history = risk.recordEquity(history, "2026-11-26", 1.05, "k1");
  history = risk.recordEquity(history, "2026-11-26", 1.01, "k1");
  assert.deepEqual(history, [{ date: "2026-11-25", ratio: 1.02, key: "k1" }, { date: "2026-11-26", ratio: 1.01, key: "k1" }]);
  assert.deepEqual(risk.recordEquity(history, "2026-11-27", 0.7, "k2"), [{ date: "2026-11-27", ratio: 0.7, key: "k2" }], "after a trade the old points are not comparable and are dropped");
  // 买入新仓把「市值 ÷ 成本」从 1.5 拉到 1.05 不是回撤：旧指纹的记录不参与计算。
  const traded = risk.buildRiskReport(holdings, quotes, [{ date: "2026-11-24", ratio: 1.5, key: "other" }, { date: "2026-11-25", ratio: 1.5, key: "other" }], []);
  assert.equal(traded.flags.find(item => item.id === "drawdown").state, "unavailable");
  assert.equal(risk.recordEquity(history, "2026-11-27", null), history);
  assert.equal(risk.recordEquity(history, "bad", 1), history);
});

test("the board renders flags, bars and an honest headline", () => {
  const key = risk.holdingsKey(holdings);
  const report = risk.buildRiskReport(holdings, quotes, [{ date: "2026-11-24", ratio: 1.08, key }, { date: "2026-11-25", ratio: 1.02, key }], []);
  const html = renderToStaticMarkup(React.createElement(board.RiskBoardView, { report }));
  for (const text of ["风险与暴露", "4 项要留意", "个股集中", "70.7%", "行业集中", "84.3%", "1 只破位", "个股占比", "行业占比", "白酒"]) assert.ok(html.includes(text), text);
  const blank = renderToStaticMarkup(React.createElement(board.RiskBoardView, { report: risk.buildRiskReport(holdings, {}, [], null) }));
  assert.match(blank, /不可用/);
  assert.doesNotMatch(blank, /暂无风险提示/);
  const partialReady = renderToStaticMarkup(React.createElement(board.RiskBoardView, { report: risk.buildRiskReport([holdings[2]], quotes, [], null) }));
  assert.match(partialReady, /部分数据未就绪/);
  assert.doesNotMatch(partialReady, /暂无风险提示/);
  const allUnavailable = renderToStaticMarkup(React.createElement(board.RiskBoardView, { report: risk.buildRiskReport([], {}, [], null) }));
  assert.match(allUnavailable, /数据不全/);
});

test("corrupted history, costPrice adjustment, non-finite shares/cost and null aiSignals are handled safely", () => {
  const corrupted = [null, "bad", 42, { date: "2026-11-24", ratio: 1.08, key: risk.holdingsKey(holdings) }, { date: "2026-11-25", ratio: Number.NaN, key: "k" }];
  assert.deepEqual(risk.sanitizeEquityHistory(corrupted), [{ date: "2026-11-24", ratio: 1.08, key: risk.holdingsKey(holdings) }]);
  assert.doesNotThrow(() => risk.buildRiskReport(holdings, quotes, corrupted, null));
  const recorded = risk.recordEquity(corrupted, "2026-11-26", 1.05, risk.holdingsKey(holdings));
  assert.equal(recorded.length, 2);

  // Adjusting costPrice changes holdingsKey so prior equity points do not cause a fake drawdown alert
  const oldKey = risk.holdingsKey(holdings);
  const adjustedHoldings = [{ ...holdings[0], costPrice: 1200 }, holdings[1], holdings[2]];
  const newKey = risk.holdingsKey(adjustedHoldings);
  assert.notEqual(oldKey, newKey);
  const adjustedReport = risk.buildRiskReport(adjustedHoldings, quotes, [{ date: "2026-11-24", ratio: 1.5, key: oldKey }, { date: "2026-11-25", ratio: 1.5, key: oldKey }], []);
  assert.equal(flag(adjustedReport, "drawdown").state, "unavailable");

  // Non-finite shares are ignored; invalid costPrice marks stop & drawdown unavailable instead of NaN% or fake 0%
  const badShares = risk.buildRiskReport([{ code: "600519", name: "贵州茅台", shares: Infinity, costPrice: 1500 }], quotes, [], null);
  assert.equal(badShares.totalValue, null);
  assert.equal(flag(badShares, "single").state, "unavailable");
  assert.equal(flag(badShares, "ai").state, "unavailable");

  const badCost = risk.buildRiskReport([{ code: "600519", name: "贵州茅台", shares: 100, costPrice: 0 }], quotes, [], null);
  assert.equal(flag(badCost, "stop").state, "unavailable");
  assert.match(flag(badCost, "stop").detail, /成本价无效/);
  assert.equal(flag(badCost, "drawdown").state, "unavailable");
  assert.equal(badCost.ratio, null);
});
