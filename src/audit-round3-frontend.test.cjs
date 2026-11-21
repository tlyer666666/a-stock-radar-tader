"use strict";

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
const restore = registerTypeScript();

const { isPaperState } = require("./researchStorage.ts");
const {
  getPaperAccountMetrics,
  evaluatePaperStrategyGovernance,
  openPaperPositionFromSignal,
  closePaperSimulationByCode,
  confirmPaperPositionSettlement
} = require("./features/paper-simulation/paperSimulationEngine.ts");
const { normalizePaperState, buildPaperStrategySignature } = require("./features/paper-simulation/paperSimulationState.ts");
const { paperQuoteEvidence, paperCorporateActionBlock } = require("./features/paper-simulation/paperTradingRules.ts");
const { normalizeSettings } = require("./domain/settings.ts");
const { settleTrades, analyzeT, normalizeTConfig } = require("./features/t-assistant/tEngine.ts");
const {
  normalizeTStore,
  withTrades,
  rolloverTStoreForDay,
  collectRolledTradeIdsThrough,
  inTradingSession,
  isFreshTQuote
} = require("./features/t-assistant/tStore.ts");
const { toolboxHistoryNote } = require("./features/t-assistant/tToolboxModel.ts");
const { saveQuickObservationPlan } = require("./trendWorkspace.ts");
const { calculateTrendPosition } = require("./trendPlan.ts");
const { resolveMarketSessionPhase } = require("./copilotBriefing.ts");
const { resolveDefaultCockpitMode } = require("./features/cockpit/cockpitModel.ts");
const { createPreviewApi } = require("./previewApi.ts");
const { isPreviewStockApi, initializeStockApi, DataBridgeFailure } = require("./runtimeBridge.tsx");

test("R3-01: isPaperState accepts STAR (688/689) and BSE (920/83) non-100-multiple odd-lot positions", () => {
  const base = { initialCapital: 100000, cash: 50000, closedPositions: [] };
  assert.equal(isPaperState({ ...base, openPositions: [{ code: "688001", shares: 257, entryPrice: 40 }] }), true);
  assert.equal(isPaperState({ ...base, openPositions: [{ code: "689009", shares: 201, entryPrice: 35 }] }), true);
  assert.equal(isPaperState({ ...base, openPositions: [{ code: "920001", shares: 135, entryPrice: 18 }] }), true);
  assert.equal(isPaperState({ ...base, openPositions: [{ code: "688001", shares: 199, entryPrice: 40 }] }), false, "STAR < 200 rejected");
  assert.equal(isPaperState({ ...base, openPositions: [{ code: "600519", shares: 150, entryPrice: 1500 }] }), false, "Main board non-100 rejected");
});

test("R3-04: getPaperAccountMetrics and evaluatePaperStrategyGovernance do not fabricate drawdown on winning open positions", () => {
  const settings = normalizeSettings({});
  const sig = buildPaperStrategySignature(settings);
  const state = normalizePaperState({
    initialCapital: 200000,
    cash: 101000,
    openPositions: [{
      id: "open-win",
      code: "600519",
      name: "贵州茅台",
      shares: 100,
      entryPrice: 1000,
      latestPrice: 1500,
      stopPrice: 950,
      takePrice: 1800,
      holdingBars: 3,
      highWaterMark: 1500,
      openedAt: "2026-11-16T02:00:00Z",
      entryFee: 30,
      feeRatePercent: 0.03,
      strategySignature: sig
    }],
    closedPositions: [{
      id: "closed-win",
      code: "000001",
      name: "平安银行",
      shares: 1000,
      entryPrice: 10,
      closePrice: 11.1,
      closeTime: new Date().toISOString(),
      closeReason: "TP",
      realizedPnl: 1000,
      realizedPnlPercent: 10,
      holdingBars: 2,
      strategySignature: sig,
      entryExecutionFillRatePercent: 95
    }]
  });
  const metrics = getPaperAccountMetrics(state);
  assert.equal(metrics.equity, 251000);
  assert.equal(metrics.maxDrawdownPercent, 0, "open unrealized gain must not retroactively turn prior lower closed equity into a drawdown");
  const gov = evaluatePaperStrategyGovernance({ ...state, maxDrawdownPercent: 0 }, settings);
  assert.notEqual(gov.stage, "suspended");
  assert.equal(gov.maxDrawdownPercent, 0);
});

test("R3-05 & R3-06: quoteAt date precedence, multi-day history gap bridge, manual settlement confirm, and sharesByRisk fee/stop cap", () => {
  // Friday 15:00 quoteAt fetched on Saturday must record quoteDate as Friday, not Saturday
  const weekendPayload = {
    security: { code: "600519", name: "贵州茅台", secid: "1.600519" },
    updatedAt: "2026-11-14T04:00:00Z", // Saturday
    quote: { name: "贵州茅台", latest: 1510, preClose: 1500, volume: 10000, quoteAt: "2026-11-13T07:00:00Z" }, // Friday 15:00+08:00
    history: []
  };
  const ev = paperQuoteEvidence(weekendPayload);
  assert.equal(ev.quoteDate, "2026-11-13");
  const posFriday = { code: "600519", name: "贵州茅台", openedAt: "2026-11-10", lastObservedClose: 1510, lastObservedCloseDate: "2026-11-13" };
  assert.equal(paperCorporateActionBlock(posFriday, weekendPayload), "");

  // Multi-day continuous history bridges missed Tuesday close on Wednesday
  const missedDayPos = { code: "600519", name: "贵州茅台", openedAt: "2026-11-10", lastObservedClose: 100, lastObservedCloseDate: "2026-11-16" };
  const wedPayload = {
    security: { code: "600519", name: "贵州茅台", secid: "1.600519" },
    updatedAt: "2026-11-18T02:00:00Z",
    quote: { name: "贵州茅台", latest: 103, preClose: 102, volume: 20000 },
    history: [
      { date: "2026-11-16", open: 99, high: 101, low: 99, close: 100 },
      { date: "2026-11-17", open: 100, high: 102.5, low: 100, close: 102, preClose: 100 }
    ]
  };
  assert.equal(paperCorporateActionBlock(missedDayPos, wedPayload), "");

  // Cleared corporateBlock unblocks closePaperSimulationByCode, and manual confirm clears blocked state
  // 撮合只在交易时段放行：冻结到北京 2026-11-18（周三）10:00，任何日子跑都走同一条路径。
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-18T02:00:00Z") });
  try {
  const today = "2026-11-18";
  const blockedState = normalizePaperState({
    initialCapital: 100000,
    cash: 90000,
    openPositions: [{
      id: "p1",
      code: "600000",
      name: "浦发银行",
      shares: 1000,
      entryPrice: 10,
      latestPrice: 10,
      stopPrice: 9,
      takePrice: 12,
      holdingBars: 2,
      highWaterMark: 10,
      openedAt: "2026-11-10T02:00:00Z",
      entryFee: 5,
      feeRatePercent: 0.03,
      settlementBlockedReason: "前收盘参考价与已记录收盘价不一致（除权或缺失交易日待核实），暂停撮合",
      lastObservedClose: 10,
      lastObservedCloseDate: "2026-11-16"
    }]
  });
  const closeRes = closePaperSimulationByCode(blockedState, {
    security: { code: "600000", name: "浦发银行", secid: "1.600000" },
    updatedAt: new Date().toISOString(),
    quote: { name: "浦发银行", latest: 10.1, preClose: 10, volume: 50000, quoteAt: `${today}T02:00:00Z` },
    history: []
  }, normalizeSettings({ slippageBps: 0 }));
  assert.equal(closeRes.state.closedPositions.length, 1);

  const manualConfirmed = confirmPaperPositionSettlement(blockedState, "600000");
  assert.equal(manualConfirmed.changed, true);
  assert.ok(!manualConfirmed.state.openPositions[0].settlementBlockedReason);

  // Wide explicit stopLossPrice + fees respected by sharesByRisk
  const wideStopRes = openPaperPositionFromSignal(
    normalizePaperState({ initialCapital: 100000, cash: 100000 }),
    {
      security: { code: "600000", name: "浦发银行", secid: "1.600000", assetType: "stock" },
      updatedAt: new Date().toISOString(),
      quote: { name: "浦发银行", latest: 20, preClose: 20, high: 20.1, low: 19.9, volume: 500000, amount: 5e8, turnover: 2 },
      analysis: {
        tradePlan: { signal: "BUY", positionSizePercent: 80, stopLossDistancePercent: 1, stopLossPrice: 16, takeProfitPrice: 26 },
        qualityIndex: 85,
        historicalEdge: 12
      },
      history: []
    },
    normalizeSettings({ maxRiskPerTradePercent: 1, maxPositionPercent: 80, minExecutionRatePercent: 40, slippageBps: 0 })
  );
  // maxRiskMoney = 1000; stopLossPrice = 16 -> 4 RMB/share loss -> at most 200 shares (800 + fees <= 1000), not 5000 shares!
  assert.equal(wideStopRes.changed, true);
  assert.ok(wideStopRes.state.openPositions[0].shares <= 200);
  } finally {
    mock.timers.reset();
  }
});

test("R3-08, R3-09 & R3-10: T-Assistant partial-fill round counting, STAR lot rules, rollover idempotence & lunch-break freshness", () => {
  const cfg = normalizeTConfig({ baseShares: 1000, sellableShares: 1000, costPrice: 20, tShares: 600, style: "balanced" }, "688001");
  const settled = settleTrades([
    { id: "s1", side: "sell", price: 21, shares: 600, time: "10:00" },
    { id: "b1", side: "buy", price: 20.4, shares: 200, time: "10:20" },
    { id: "b2", side: "buy", price: 20.3, shares: 200, time: "10:35" },
    { id: "b3", side: "buy", price: 20.2, shares: 200, time: "10:50" }
  ], cfg);
  assert.equal(settled.open, null);
  assert.equal(settled.stats.rounds, 1, "3 partial buybacks closing 1 reverse-T must count as 1 round, not 3");
  assert.equal(settled.stats.wins, 1);

  // STAR reverse-T with 100-share open leg recommends >= 200 minimum buyback lot
  const points = Array.from({ length: 230 }, (_, slot) => {
    const m = slot <= 120 ? 570 + slot : 780 + (slot - 120);
    const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return { slot, time, price: 20, average: 20, volume: 100, amount: null, changePercent: 0, rising: true };
  });
  const starShare = { date: "2026-11-18", preClose: 20, preCloseSource: "source", points, high: 20.2, low: 19.8, scale: { min: 19, max: 21, maxPercent: 5 }, totalVolume: 23000, totalAmount: null };
  const starAnalysis = analyzeT(starShare, { code: "688001", name: "华兴源创" }, cfg, [{ id: "odd", side: "sell", price: 20.2, shares: 100, time: "10:00" }]);
  assert.equal(starAnalysis.signal.action, "closeBuyBack");
  assert.equal(starAnalysis.signal.shares, 200);

  // Manual baseShares sync marks existing trades rolled so next day does not double-count
  let st = normalizeTStore({ items: [{ code: "600000", name: "浦发银行", config: { baseShares: 1000, sellableShares: 1000 } }] });
  st = withTrades(st, "2026-11-17", "600000", (list) => [...list, { id: "t1", side: "buy", price: 10, shares: 500, time: "10:30" }]);
  const syncedIds = collectRolledTradeIdsThrough(st, "600000", "2026-11-17");
  st = normalizeTStore({
    ...st,
    lastRolloverDay: "2026-11-17",
    items: st.items.map((it) => ({ ...it, config: { ...it.config, baseShares: 1500, sellableShares: 1000 }, rolledTradeIds: syncedIds }))
  });
  const nextDay = rolloverTStoreForDay(st, "2026-11-18");
  assert.equal(nextDay.store.items[0].config.baseShares, 1500, "already-synced baseShares must not double-add +500");
  assert.equal(nextDay.store.items[0].config.sellableShares, 1500);

  // Lunch break & call auction quote freshness + holiday check
  assert.equal(inTradingSession(new Date("2026-10-01T10:00:00+08:00")), false, "National Day holiday is closed");
  assert.equal(isFreshTQuote("2026-11-18", "09:30", new Date("2026-11-18T09:27:00+08:00")), true);
  assert.equal(isFreshTQuote("2026-11-18", "11:30", new Date("2026-11-18T13:01:00+08:00")), true);
  assert.equal(
    toolboxHistoryNote({ rows: [{ date: "2026-11-18 11:30", open: 10, high: 10, low: 10, close: 10, volume: 100, volumeUnit: "lots" }] }, "30", new Date("2026-11-18T13:15:00+08:00")),
    ""
  );
});

test("R3-11, R3-12, Holiday & Preview Brand: quick observation plan sizing, statutory holiday session & preview brand", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const saved = saveQuickObservationPlan(storage, {
    code: "689009",
    name: "九号公司",
    referencePrice: 40,
    stopPercent: 12,
    asOf: "2026-11-18"
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.plan.candidate.board, "star");
  const sized = calculateTrendPosition({
    netAssetValue: 200000,
    entryPrice: saved.plan.candidate.plan.maxEntry,
    stopPrice: saved.plan.candidate.plan.stop,
    maxEntryPrice: saved.plan.candidate.plan.maxEntry,
    minEntryPrice: saved.plan.candidate.plan.minEntry,
    industryExposureRatio: 0,
    portfolioExposureRatio: 0,
    openPositions: 0,
    cashAvailable: 200000,
    feeReserve: 0,
    minimumBuyQuantity: 200,
    quantityStep: 1,
    commissionRate: 0.0003,
    minimumCommission: 5,
    sellTaxRate: 0.0005,
    transferFeeRate: 0.00001,
    alreadyHeld: false,
    permissionVerified: true,
    announcementVerified: true,
    corporateActionAligned: true,
    marketGate: "open"
  });
  assert.equal(sized.eligible, true);
  assert.ok(sized.shares >= 200);

  // Statutory holiday (2026-10-01 Thursday) resolves as closed in Copilot & afterclose in Cockpit
  const holidayMs = Date.parse("2026-10-01T08:45:00+08:00");
  const phase = resolveMarketSessionPhase(holidayMs);
  assert.equal(phase.id, "closed");
  assert.equal(resolveDefaultCockpitMode(phase, holidayMs), "afterclose");

  // Direct harness mocks stay formal unless installed via initializeStockApi(true, factory)
  const prevWin = global.window;
  try {
    const api = { ...createPreviewApi() };
    global.window = { stockApi: api };
    assert.equal(isPreviewStockApi(), false);
    assert.equal(initializeStockApi(false), true);
    global.window = {};
    assert.equal(initializeStockApi(false), false);
    assert.equal(initializeStockApi(true, createPreviewApi), true);
    assert.equal(isPreviewStockApi(), true);
  } finally {
    global.window = prevWin;
  }
  const fallbackEl = DataBridgeFailure();
  assert.equal(fallbackEl.props.role, "alert");
});

test("R3-Preview: previewApi AI, news and workspace methods return structured preview payloads", async () => {
  const api = createPreviewApi();
  const feed = await api.getNewsFeed({ scope: "all" });
  assert.ok(feed.items.length > 0);
  await api.refreshNewsFeed({ scope: "stock", currentStock: { code: "600519" } });
  const mr = await api.ai.marketReview();
  assert.ok(mr.headline);
  const lb = await api.ai.lookback();
  assert.equal(lb.judged, 3);
  const cachedMr = await api.ai.cachedMarketReview();
  assert.ok(cachedMr.review);
  const interp = await api.ai.interpret({ kind: "sectors" });
  assert.equal(interp.title, "板块强度");
  assert.ok(await api.ai.cachedInterpret({ kind: "sectors" }));
  const fw = await api.ai.frameworks();
  assert.ok(fw.frameworks.length >= 5);
  await api.ai.saveFramework({ active: "technical" });
  await api.ai.saveCustomList([{ code: "600519", name: "贵州茅台" }]);
  await api.ai.mutateCustomList({ kind: "add", items: [{ code: "000001", name: "平安银行" }], source: "搜索" });
  assert.equal((await api.ai.customList()).length, 2);
  const rc = await api.ai.rankCustom({ force: true });
  assert.equal(rc.items.length, 2);
  assert.ok(await api.ai.cachedCustom());
  const rev = await api.ai.review({ security: { code: "600519", name: "贵州茅台" } });
  assert.equal(rev.evaluated, 1);
  assert.ok(await api.ai.cachedReview("600519"));
  assert.equal((await api.ai.status()).configured, true);
  const selInput = { asOfDate: "2026-11-18", picks: [{ code: "600519", name: "贵州茅台", strategies: [] }], strategyCounts: [] };
  await api.ai.rank(selInput);
  await api.ai.summary(selInput);
  assert.ok((await api.ai.cached(selInput)).rank);
  assert.equal((await api.ai.history()).length, 1);
  assert.ok((await api.ai.historyDay("2026-11-18")).summary);
  assert.equal((await api.ai.profiles()).profiles.length, 2);
  await api.ai.activateProfile("demo-b");
  await api.ai.setRankModels(["demo-a"]);
  assert.ok(Array.isArray(await api.getWatchlist()));
  assert.ok(Array.isArray(await api.getHoldings()));
  assert.ok((await api.getSettings()).provider);
  assert.ok(await api.getVersion());
});

test.after(() => restore?.());
