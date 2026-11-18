"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../qa/register-typescript.cjs");

let restore;
let holdingsLedger;
let paperEngine;
let cockpitModel;
let TodayCockpitView;
let trendWorkspace;
let selectionChartData;
let AiAgentView;

before(() => {
  restore = registerTypeScript();
  holdingsLedger = require("./collections/holdingsLedger.ts");
  paperEngine = require("./paper-simulation/paperSimulationEngine.ts");
  cockpitModel = require("./cockpit/cockpitModel.ts");
  TodayCockpitView = require("./cockpit/TodayCockpitView.tsx").default;
  trendWorkspace = require("../trendWorkspace.ts");
  selectionChartData = require("./strategy-selection/selectionChartData.ts");
  AiAgentView = require("./ai-agent/AiAgentView.tsx").default;
});

after(() => restore?.());

test("applyHoldingTrade rejects fractional shares and oversells, and parseHoldingsPaste handles CSV spaces & row index", () => {
  const holdings = [{
    code: "600519",
    name: "贵州茅台",
    secid: "1.600519",
    shares: 200,
    costPrice: 1500,
    note: "",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z"
  }];

  const frac = holdingsLedger.applyHoldingTrade({
    items: holdings,
    code: "600519",
    side: "buy",
    shares: 100.5,
    price: 1505
  });
  assert.equal(frac.ok, false);
  assert.match(frac.error, /整数/);

  const oversell = holdingsLedger.applyHoldingTrade({
    items: holdings,
    code: "600519",
    side: "sell",
    shares: 300,
    price: 1520
  });
  assert.equal(oversell.ok, false);
  assert.match(oversell.error, /超过当前持仓/);

  const exactSell = holdingsLedger.applyHoldingTrade({
    items: holdings,
    code: "600519",
    side: "sell",
    shares: 200,
    price: 1520
  });
  assert.equal(exactSell.ok, true);
  assert.equal(exactSell.action, "closed");
  assert.equal(exactSell.nextItems.length, 0);

  const parsed = holdingsLedger.parseHoldingsPaste([
    "600519,东方 财富,200,21.8",
    "1\t000001\t平安银行\t300\t10.5",
    "1.\t中际旭创\t300308\t100\t120.5"
  ].join("\n"));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.entries[0], { line: 2, code: "000001", name: "平安银行", shares: 300, costPrice: 10.5, note: "" });
  assert.deepEqual(parsed.entries[1], { line: 3, code: "300308", name: "中际旭创", shares: 100, costPrice: 120.5, note: "" });
  assert.deepEqual(parsed.entries[2], { line: 1, code: "600519", name: "东方 财富", shares: 200, costPrice: 21.8, note: "" });
});

test("paperSimulationEngine unblocks after XR close records shifted preClose and keeps unexplained jumps locked", () => {
  const { normalizePaperState } = require("./paper-simulation/paperSimulationState.ts");
  const { shanghaiDateTag } = require("../dateUtils");
  const today = shanghaiDateTag();
  const basePos = {
    code: "600519",
    name: "贵州茅台",
    secid: "1.600519",
    shares: 100,
    entryPrice: 100,
    latestPrice: 100,
    highWaterMark: 100,
    stopLossPrice: 80,
    takeProfitPrice: 120,
    stopPrice: 80,
    takePrice: 120,
    holdingBars: 1,
    entryFee: 5,
    openedAt: "2026-10-10T02:00:00Z",
    lastObservedClose: 100,
    lastObservedCloseDate: "2026-10-15",
    settlementBlockedReason: ""
  };
  const settings = {
    initialCash: 100_000,
    riskPercent: 1,
    maxPositionPercent: 25,
    maxTotalPositionPercent: 80,
    stopLossPercent: 20,
    takeProfitPercent: 20,
    maxHoldingBars: 20,
    trailingStopPercent: 0,
    commissionBps: 2.5,
    slippageBps: 0,
    timeDecayPerBarPercent: 0,
    maxOpenPositions: 5,
    enabledPaperSim: true,
    selectedStrategies: ["riskVeto"],
    theme: "system"
  };

  // Explicit XR quote after 15:00 stays blocked on XR day but captures post-XR close (90).
  const initialState = normalizePaperState({
    cash: 90_000,
    dailyRealizedPnl: 0,
    openPositions: [basePos],
    closedPositions: [],
    equityCurve: []
  });
  const day1 = paperEngine.advancePaperSimulationByQuote(initialState, {
    security: { code: "600519", name: "XR贵州茅台", secid: "1.600519" },
    updatedAt: `${today}T15:05:00+08:00`,
    quote: { name: "XR贵州茅台", preClose: 90, latest: 90, high: 91, low: 89, volume: 10000 },
    history: []
  }, settings);
  assert.match(day1.state.openPositions[0].settlementBlockedReason, /除权除息/);
  assert.equal(day1.state.openPositions[0].lastObservedClose, 90);
  assert.equal(day1.state.openPositions[0].lastObservedCloseDate, today);

  // When name returns to normal and preClose matches recorded post-XR close (90), block clears!
  const day2 = paperEngine.advancePaperSimulationByQuote(day1.state, {
    security: { code: "600519", name: "贵州茅台", secid: "1.600519" },
    updatedAt: `${today}T10:30:00+08:00`,
    quote: { name: "贵州茅台", preClose: 90, latest: 92, high: 93, low: 90, volume: 20000 },
    history: []
  }, settings);
  assert.ok(!day2.state.openPositions[0].settlementBlockedReason);
  assert.equal(day2.state.openPositions[0].latestPrice, 92);

  // Unexplained gap without XR marker must NOT overwrite lastObservedClose even after 15:00.
  const unexplainedState = normalizePaperState({
    cash: 90_000,
    dailyRealizedPnl: 0,
    openPositions: [{ ...basePos, lastObservedClose: 100, lastObservedCloseDate: "2020-01-01" }],
    closedPositions: [],
    equityCurve: []
  });
  const gapRes = paperEngine.advancePaperSimulationByQuote(unexplainedState, {
    security: { code: "600519", name: "贵州茅台", secid: "1.600519" },
    updatedAt: `${today}T15:05:00+08:00`,
    quote: { name: "贵州茅台", preClose: 85, latest: 86, high: 86, low: 84, volume: 10000 },
    history: []
  }, settings);
  assert.match(gapRes.state.openPositions[0].settlementBlockedReason, /前收盘/);
  assert.equal(gapRes.state.openPositions[0].lastObservedClose, 100);
});

test("cockpitModel matches relatedStocks announcements and TodayCockpitView unwraps wrapped monitor snapshots", () => {
  const priorities = cockpitModel.buildMorningPriorities({
    holdings: [{ code: "600519", name: "贵州茅台", secid: "1.600519", shares: 100, costPrice: 1500, createdAt: "", updatedAt: "" }],
    monitorConfigs: { "600519": { enabled: true, mode: "any", cooldownMinutes: 5, conditions: [] } },
    copilotAlerts: [],
    planReconciliation: [],
    tItems: [],
    urgentNotesCount: 0,
    newsItems: [{ title: "贵州茅台年度分红预案", relatedStocks: [{ code: "600519", name: "贵州茅台" }], importanceScore: 82 }]
  });
  assert.ok(priorities.some(item => item.id === "prio-holding-news" && /贵州茅台年度分红预案/.test(item.title)));

  const html = renderToStaticMarkup(React.createElement(TodayCockpitView, {
    phase: { id: "intraday", label: "盘中", tip: "" },
    holdings: [{ code: "600519", name: "贵州茅台", secid: "1.600519", shares: 100, costPrice: 1400, createdAt: "", updatedAt: "" }],
    favorites: [],
    watchlist: [],
    limitUps: [],
    notesApi: { store: { notes: [] } },
    tAssistant: { store: { items: [], trades: {} }, runtimes: {} },
    stockMonitors: {
      configs: {},
      runtimes: {},
      latestQuotes: { "600519": { quote: { latest: 1540, changePct: 2.5 }, updatedAt: "2026-11-15T10:00:00+08:00" } },
      alerts: []
    },
    paperSummary: { normalized: { openPositions: [] }, account: { equity: 100000, availableCash: 100000, openMarketValue: 0, totalPnlPercent: 0 } },
    copilotAlerts: [],
    live: false,
    isDefaultView: false
  }));
  assert.match(html, /1540\.00/);
});

test("saveQuickObservationPlan rejects invalid referencePrice instead of silently defaulting to 10", () => {
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, val) => memory.set(key, String(val)) };
  const badZero = trendWorkspace.saveQuickObservationPlan(storage, { code: "600519", name: "贵州茅台", referencePrice: 0 });
  const badNull = trendWorkspace.saveQuickObservationPlan(storage, { code: "600519", name: "贵州茅台", referencePrice: null });
  assert.equal(badZero.ok, false);
  assert.equal(badNull.ok, false);
  assert.match(badZero.error, /参考价格/);
});

test("selectionChartData evicts timed-out job immediately so immediate retry creates a new job", async () => {
  const prevWindow = global.window;
  const prevDocument = global.document;
  let calls = 0;
  let cancelled = false;
  const originalSetTimeout = global.setTimeout;
  const scheduledCallbacks = [];
  global.document = { hidden: false, addEventListener: () => {} };
  global.window = {
    stockApi: {
      getChart: () => {
        calls += 1;
        return new Promise(() => {});
      },
      cancelServiceJob: () => {
        cancelled = true;
        return Promise.resolve({ cancelled: true });
      }
    }
  };
  global.setTimeout = (fn, ms) => {
    if (ms === 45_000) {
      scheduledCallbacks.push(fn);
      return { id: scheduledCallbacks.length };
    }
    return originalSetTimeout(fn, ms);
  };
  try {
    const errors1 = [];
    const unsub1 = selectionChartData.subscribeSelectionChart({ code: "600519", name: "贵州茅台", secid: "1.600519" }, (_d, err) => {
      if (err) errors1.push(err);
    });
    assert.equal(calls, 1);
    assert.equal(scheduledCallbacks.length, 1);
    scheduledCallbacks[0]();
    assert.match(errors1[0], /超时/);
    assert.equal(cancelled, true);

    const errors2 = [];
    const unsub2 = selectionChartData.subscribeSelectionChart({ code: "600519", name: "贵州茅台", secid: "1.600519" }, (_d, err) => {
      if (err) errors2.push(err);
    });
    assert.equal(calls, 2, 'retry after timeout must start a new chart request instead of reusing dead job');
    unsub1();
    unsub2();
  } finally {
    global.setTimeout = originalSetTimeout;
    global.window = prevWindow;
    global.document = prevDocument;
  }
});

test("AiAgentView stock-drawer mode displays AI问股 header and does not contain auto-send T analysis for drawer", () => {
  const prevWindow = global.window;
  global.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    stockApi: { ai: { agent: { state: async () => ({ configured: true, conversations: [] }) } } }
  };
  try {
    const html = renderToStaticMarkup(React.createElement(AiAgentView, {
      embeddedFocus: { code: "600519", name: "贵州茅台" },
      embeddedMode: "stock-drawer"
    }));
    assert.match(html, /贵州茅台 · AI问股/);
    assert.doesNotMatch(html, /AI做T分析/);
  } finally {
    global.window = prevWindow;
  }
  const hookSource = fs.readFileSync(path.join(__dirname, "ai-agent/useAgentConversation.ts"), "utf8");
  assert.match(hookSource, /if \(embeddedMode === "stock-drawer"\)/);
  const wsSource = fs.readFileSync(path.join(__dirname, "market/MarketWorkspace.tsx"), "utf8");
  assert.match(wsSource, /embeddedMode="stock-drawer"/);
  assert.match(wsSource, /key=\{activeCode\}/);
});
