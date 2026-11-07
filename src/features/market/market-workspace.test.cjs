"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

const previousCssLoader = require.extensions[".css"];
require.extensions[".css"] = () => {};
const restoreTypeScript = registerTypeScript();
const { Dashboard, resolvePaperCloseAllHandler } = require("./MarketWorkspace.tsx");
const { initialSettings } = require("../../domain/settings.ts");
const { limitPoolProviderLabel, tradeSignalLabel } = require("./marketLabels.ts");
const { paperCloseReasonLabel } = require("../../domain/paperSimulationTypes.ts");

test("market workspace keeps the analysis route title, return action, and loading state", () => {
  const markup = renderToStaticMarkup(React.createElement(Dashboard, {
    mode: "analysis",
    payload: null,
    loading: true,
    analysisTarget: { name: "示例股票", code: "600001" },
    backLabel: "返回炸板列表",
    onBack() {}
  }));

  for (const marker of ["个股复盘 · 示例股票", "返回炸板列表", "正在构建主线画像"]) {
    assert.ok(markup.includes(marker), `missing market workspace marker: ${marker}`);
  }
});

test("limit-up monitor shows the consecutive-board ladder beside the pool from the same snapshot", () => {
  const limitUps = [
    { code: "600001", name: "三板股", consecutiveBoards: 3, limitDate: "2026-11-04", firstSealTime: "09:31:00" },
    { code: "600002", name: "首板股", consecutiveBoards: 1, limitDate: "2026-11-04" }
  ];
  const markup = renderToStaticMarkup(React.createElement(Dashboard, { mode: "pool", payload: null, limitUps, limitPoolMeta: null, onOpen() {}, onAdd() {}, onDiscover() {} }));
  assert.match(markup, /class="limit-pool-columns"/);
  assert.match(markup, /class="limit-ladder-sidebar"[\s\S]*连板梯队/);
  assert.match(markup, /data-board-height="3"[\s\S]*三板股/);
});

test("before the open the limit-up monitor shows one empty note instead of a stretched empty ladder", () => {
  const markup = renderToStaticMarkup(React.createElement(Dashboard, { mode: "pool", payload: null, limitUps: [], limitPoolMeta: null, onOpen() {}, onAdd() {}, onDiscover() {} }));
  assert.doesNotMatch(markup, /limit-pool-columns|limit-ladder-sidebar/);
  assert.match(markup, /class="limit-pool-empty"[^>]*>当日涨停池还没有数据/);
  assert.doesNotMatch(markup, /请选择涨停池股票查看详细分析/, "no empty detail box when there is nothing to pick");
});

test("market and paper labels preserve the existing provider, signal, and close-reason wording", () => {
  assert.equal(limitPoolProviderLabel(["ths", "eastmoney"]), "同花顺主源 · 东方财富补全校验");
  assert.equal(tradeSignalLabel("BUY_AGGRESSIVE"), "强势买入条件满足");
  assert.equal(paperCloseReasonLabel("KILL_SWITCH"), "风控熔断");
});

// E-01：为「个股复盘」构造一个最小但结构完整的分析 payload。
// 只用于断言展示层，数值本身不参与断言。
const analysisPayload = (quoteOverrides = {}) => {
  const day = "2026-10-21";
  const bar = (offset) => ({
    date: day,
    open: 10 + offset * 0.01,
    high: 10.4 + offset * 0.01,
    low: 9.9 + offset * 0.01,
    close: 10.2 + offset * 0.01,
    volume: 1_000_000 + offset,
    amount: 100_000_000 + offset
  });
  return {
    security: { code: "600001", name: "示例股票", secid: "1.600001", assetType: "stock" },
    quote: {
      code: "600001", name: "示例股票", latest: 10.2, change: 0.2, changePct: 2,
      open: 10, high: 10.4, low: 9.9, preClose: 10, turnover: 2.1, amount: 123_456_789,
      totalMarketCap: 12_000_000_000, industry: "示例行业",
      ...quoteOverrides
    },
    history: [0, 1, 2, 3, 4, 5, 6, 7].map(bar),
    analysis: {
      mrs: 66, grade: "B", structureScore: 62, sectorScore: 58, infoScore: 55,
      trendLabel: "均线多头", volumeRatio: 1.1, relativeTurnover: 1.0, divergence: 0.4,
      maBull: true, slopesUp: true, rsSector: 1.2, stockReturn3: 3.1,
      tradePlan: {}, tradeProjection: {}, executionPolicy: {},
      risks: [], strategyResults: [], qualification: {},
      daysSince: 3, limitEvent: null, alertQualified: false,
      strategyMatched: 4, strategyTotal: 7, strategyMatchRate: 57,
      historicalEdge: 2.4, historicalEdgePassed: true, qualityIndex: 66,
      marketCap: 12_000_000_000, marketCapPassed: true
    },
    sector: null,
    announcements: [],
    actualProvider: "ths",
    updatedAt: "2026-10-21T07:30:00.000Z"
  };
};

const paperSummaryFixture = {
  normalized: { initialCapital: 200000, cash: 200000, openPositions: [], closedPositions: [], dailyRealizedPnl: 0, totalTradeCount: 0, lastTradeDate: "2026-10-21", lastOpenAt: "" },
  strategyGovernance: {
    stage: "candidate", status: "观察中", positionMultiplier: 1, canPromoteToLive: false,
    tradeCount: 0, minimumPromotionTrades: 20, score: 50, winRate: 0, profitFactor: 0,
    maxDrawdownPercent: 0, averageExecutionFillRatePercent: 0, recentTenPnl: 0,
    reasons: ["样本不足"], suspendedUntil: null
  },
  dailyTradeSignal: { blockedByDailyLimit: false, todayTradeCount: 0, maxDailyTrades: 12, todayClosedCount: 0, todayWinRate: 0 },
  equity: 200000, openValue: 0, openCost: 0, openPnl: 0, openPnlPercent: 0,
  closedCount: 0, winCount: 0, cumulativeRealizedPnl: 0, realizedReturnPercent: 0,
  cumulativeNetPnl: 0, cumulativeReturnPercent: 0, profitFactor: 0, maxDrawdownPercent: 0,
  avgHoldingBars: 0, grossProfit: 0, grossLoss: 0,
  portfolioRiskPercent: 0, maxPortfolioRiskPercent: 70, portfolioKill: false, portfolioKillWarning: false,
  portfolioKillReasons: [], lossPressureRatio: 0, portfolioUnrealizedLoss: 0,
  currentSectorName: "", currentSectorExposurePercent: 0, maxSectorExposurePercent: 45,
  lossStreakState: {}, lossStreakConsecutive: 0, lossStreakMultiplier: 1, lossStreakBlocked: false,
  lossStreakStepPercent: 18, lossStreakFloorPercent: 30, lossStreakLimit: 4,
  dailyLossLimit: 6400, dailyStopped: false, winRate: 0
};

const paperPosition = (code) => ({
  id: `sim-${code}`, code, name: `示例${code}`, shares: 1000, entryPrice: 10, latestPrice: 10.5,
  stopPrice: 9, takePrice: 12, holdingBars: 2, entryFee: 5, settlementBlockedReason: ""
});

const paperSummaryWith = (openPositions) => ({
  ...paperSummaryFixture,
  normalized: { ...paperSummaryFixture.normalized, openPositions }
});

const renderAnalysis = (quoteOverrides = {}, extraProps = {}) => renderToStaticMarkup(React.createElement(Dashboard, {
  mode: "analysis",
  payload: analysisPayload(quoteOverrides),
  loading: false,
  error: "",
  settings: initialSettings,
  isWatched: false,
  onToggleWatch() {},
  onOpenBacktest() {},
  onOpen() {},
  onBack() {},
  backLabel: "返回涨停池",
  executionDecisionLog: [],
  onClearExecutionDecisionLog() {},
  paperSummary: paperSummaryFixture,
  paperExecutionReadiness: { level: "block", status: "BLOCK", score: 0, summary: "不可执行", recommendation: "不建议执行", reasons: [], canExecute: false },
  paperCurrentPositions: [],
  canPaperTrade: false,
  latestExecutionDecision: null,
  executePaperTrade() {},
  closePaperTradeForCurrent() {},
  closePaperTradeForCode() {},
  onRetry() {},
  ...extraProps
}));

test("missing or zero latest price renders as -- with no rise colour", () => {
  const zero = renderAnalysis({ latest: 0, change: 0, changePct: 0 });
  const priceBlock = zero.slice(zero.indexOf("最新价"));
  const strong = priceBlock.slice(0, priceBlock.indexOf("</strong>") + "</strong>".length);
  assert.ok(strong.includes("--"), `zero latest price must render as --, got: ${strong}`);
  assert.doesNotMatch(strong, />0\.00</, "zero latest price must not render as 0.00");
  assert.doesNotMatch(strong, /class="red"/, "zero latest price must not use the rise colour");
  assert.doesNotMatch(zero.slice(zero.indexOf("最新价")).slice(0, 400), /暂无有效行情[sS]*\+0\.00%/, "no fabricated +0.00%");

  const missing = renderAnalysis({ latest: null, change: null, changePct: null });
  const missingBlock = missing.slice(missing.indexOf("最新价"));
  assert.ok(missingBlock.slice(0, 200).includes("--"), "missing latest price must render as --");
});

test("the paper panel wires the one-click button to the all-position handler", () => {
  const positions = [paperPosition("600001"), paperPosition("600002")];
  const wired = renderAnalysis({}, {
    paperSummary: paperSummaryWith(positions),
    closeAllPaperTrades() {}
  });
  assert.match(wired, /一键平掉所有当前标的/, "the close-all button must render when positions exist");
  assert.match(wired, /title="平掉全部持仓"/, "the button must be wired to the close-all handler");
  assert.doesNotMatch(wired, /未接入全平回调/);

  // 向后兼容：没有全平回调时按钮仍在，但明确降级为“只平当前标的”。
  const legacy = renderAnalysis({}, { paperSummary: paperSummaryWith(positions) });
  assert.match(legacy, /一键平掉所有当前标的/);
  assert.match(legacy, /title="未接入全平回调，将只平掉当前标的"/);
});

test("one-click close-all is bound to the all-position handler, with a single-position fallback", () => {
  const all = () => {};
  const single = () => {};
  assert.equal(resolvePaperCloseAllHandler(all, single), all, "must prefer the close-all callback");
  assert.equal(resolvePaperCloseAllHandler(undefined, single), single, "falls back for older callers");
  assert.equal(resolvePaperCloseAllHandler(null, single), single);
});

after(() => {
  restoreTypeScript?.();
  if (previousCssLoader) require.extensions[".css"] = previousCssLoader;
  else delete require.extensions[".css"];
});
