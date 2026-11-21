"use strict";
// 2026-11-20 未提交改动审核（审计报告/A股雷达_1.6.71_未提交改动审核_20261120.md）P2 整改回归。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after, mock } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let restore;
let rules, engine, settingsModel, stateModel, quickPlan, agentModel;
// 2026-11-19（周四，交易日）10:00 上海时间
const NOW = "2026-11-19T02:00:00.000Z";
before(() => {
  restore = registerTypeScript();
  mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  rules = require("./features/paper-simulation/paperTradingRules.ts");
  engine = require("./features/paper-simulation/paperSimulationEngine.ts");
  settingsModel = require("./domain/settings.ts");
  stateModel = require("./features/paper-simulation/paperSimulationState.ts");
  quickPlan = require("./components/QuickPlanModal.tsx");
  agentModel = require("./features/ai-agent/agentModel.ts");
});
after(() => { mock.timers.reset(); restore?.(); });

const read = rel => fs.readFileSync(path.join(__dirname, rel), "utf8");

test("P2-1 持仓已保存后流水写失败只提示，不走外层 catch，避免用户重复提交造成重复记账", () => {
  const ledger = read("features/collections/holdingsLedger.ts");
  assert.doesNotMatch(ledger, /请清理存储后补记/);
  assert.match(ledger, /请勿重复提交本笔交易/);
  for (const rel of ["features/collections/CollectionViews.tsx", "features/collections/useWorkspaceCollections.ts"]) {
    const source = read(rel);
    assert.match(source, /try \{\s*(?:setTradeRecords\()?appendHoldingTradeRecord\(/, `${rel} 必须单独包住流水写入`);
    assert.match(source, /catch \(ledgerError\)/, `${rel} 流水失败要单独处理`);
  }
  const hook = read("features/collections/useWorkspaceCollections.ts");
  const branch = hook.slice(hook.indexOf("if (saved && feedback)"), hook.indexOf("return false;", hook.indexOf("if (saved && feedback)")));
  assert.match(branch, /return true;/, "持仓已保存时必须返回 true 关闭快捷交易弹窗");
});

const position = (overrides = {}) => ({
  id: "p", code: "600001", name: "样本", shares: 100, entryPrice: 10, latestPrice: 10, stopPrice: 8, takePrice: 20,
  holdingBars: 1, highWaterMark: 10, openedAt: "2026-11-17T02:00:00Z", entryFee: 5, feeRatePercent: 0.03,
  quoteName: "样本", quotePreClose: 10, quoteVolume: 5000, ...overrides
});

test("P2-2 前一晚存下的 quoteAt 不会把次日盘中撮合判成非交易时段", () => {
  const stale = position({ quoteDate: "2026-11-19", quoteAt: "2026-11-18T20:00:00+08:00" });
  assert.equal(rules.paperMatchBlock(stale, "sell", 10), "", "过期的报价时间应被忽略");
  // 今天收盘后的报价时间仍然拦截
  assert.match(rules.paperMatchBlock(position({ quoteDate: "2026-11-19", quoteAt: "2026-11-19T15:05:00+08:00" }), "sell", 10), /非交易时段/);
});

test("P2-2 熔断/一键平仓在盘中按当前时间判定时段，旧 quoteAt 不再挡住强平", () => {
  const settings = { ...settingsModel.initialSettings, slippageBps: 0, maxDailyRiskPercent: 100, maxPortfolioRiskPercent: 100 };
  const state = stateModel.normalizePaperState({
    initialCapital: 100000, cash: 99000, closedPositions: [], lastTradeDate: "2026-11-19",
    openPositions: [position({ quoteDate: "2026-11-18", quoteAt: "2026-11-18T20:00:00+08:00", latestPrice: 9.8 })]
  });
  const result = engine.closePaperAllSimulationByCode(state, "KILL_SWITCH", settings);
  assert.equal(result.state.openPositions.length, 0, result.message);
  assert.equal(result.state.closedPositions.length, 1);

  const premarket = stateModel.normalizePaperState({
    initialCapital: 100000, cash: 99000, closedPositions: [], lastTradeDate: "2026-11-19",
    openPositions: [position({ quoteDate: "2026-11-19", quoteAt: "2026-11-19T09:20:00+08:00", latestPrice: 9.8 })]
  });
  assert.equal(engine.closePaperAllSimulationByCode(premarket, "KILL_SWITCH", settings).state.closedPositions.length, 1, "盘前快照不能挡住盘中强平");
});

test("P2-2 新报价不带 quoteAt 时清掉持仓上的旧值", () => {
  const evidence = rules.paperQuoteEvidence({ security: { code: "600001", name: "样本" }, quote: { latest: 10, preClose: 10, volume: 1000 }, updatedAt: NOW });
  assert.ok("quoteAt" in evidence);
  assert.equal(evidence.quoteAt, undefined);
  assert.equal({ ...position({ quoteAt: "2026-11-18T20:00:00+08:00" }), ...evidence }.quoteAt, undefined);
});

test("P2-4 弹窗兜底默认止损与一键加入一致：-6%", () => {
  const defaults = quickPlan.computeDefaults(10, null);
  assert.equal(defaults.stopPrice, "9.40");
  assert.equal(defaults.buyLow, "9.90");
  assert.equal(defaults.buyHigh, "10.20");
  assert.doesNotMatch(read("components/QuickPlanModal.tsx"), /默认 -5% 止损/);
});

test("P2-5 ETF 详情页进入 AI 问股保留 etf 类型，个股仍按 stock", () => {
  agentModel.registerAgentOpener(() => undefined);
  try {
    assert.equal(agentModel.openAgentFor({ code: "510300", name: "沪深300ETF", assetType: "etf" }), true);
    assert.equal(agentModel.takeAgentHandoff().focus.kind, "etf");
    assert.equal(agentModel.openAgentFor({ code: "600519", name: "贵州茅台" }), true);
    assert.notEqual(agentModel.takeAgentHandoff().focus.kind, "etf");
    assert.equal(agentModel.openAgentFor({ code: "113001", name: "某转债", assetType: "bond" }), true, "非 ETF 类型按个股处理，不让按钮失效");
    agentModel.takeAgentHandoff();
  } finally {
    agentModel.registerAgentOpener(null);
  }
  const market = read("features/market/MarketWorkspace.tsx");
  assert.equal((market.match(/openAgentFor\(\{ code: activeCode, name: activeName, assetType: security\.assetType \}/g) || []).length, 2);
});

test("P2-5b 驾驶舱「问 AI 怎么看大盘」带大盘对象进入 AI 问股", () => {
  assert.equal(agentModel.openAgentForMarket(), false, "没有注册打开方法时直接返回 false");
  agentModel.registerAgentOpener(() => undefined);
  try {
    assert.equal(agentModel.openAgentForMarket(), true);
    const handoff = agentModel.takeAgentHandoff();
    assert.equal(handoff.focus.kind, "market");
    assert.equal(handoff.task, "market_regime");
  } finally {
    agentModel.registerAgentOpener(null);
  }
});

test("P2-6 资讯列表整页共用一份驾驶舱状态和一个弹窗", () => {
  const news = read("features/information/NewsView.tsx");
  assert.doesNotMatch(news, /<CockpitAddButton\b/);
  assert.equal((news.match(/useCockpitAdd\(/g) || []).length, 1);
  assert.equal((news.match(/\{cockpit\.modal\}/g) || []).length, 1);
  assert.match(news, /<CockpitAddTrigger [^>]*planned=\{cockpit\.plannedCodes\.has\(stock\.code\)\}/);
});
