"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let model;
let TodayCockpitView;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  model = require("./cockpitModel.ts");
  TodayCockpitView = require("./TodayCockpitView.tsx").default;
});

after(() => restoreTypeScript?.());

test("cockpitModel builds unified sentinels across holdings, paper, plans, T-items, favorites and monitors", () => {
  const sentinels = model.buildUnifiedSentinels({
    holdings: [{ code: "600519", name: "贵州茅台", secid: "1.600519", costPrice: 1450 }],
    favorites: [{ code: "000001", name: "平安银行", secid: "0.000001" }],
    openPaperPositions: [{ code: "300750", name: "宁德时代", secid: "0.300750", entryPrice: 200, latestPrice: 196, shares: 100, stopLossPrice: 195 }],
    plans: [{
      id: "plan-1",
      savedAt: "2026-11-13",
      isPreview: false,
      coverageComplete: true,
      marketGate: "open",
      candidate: {
        security: { code: "600519", name: "贵州茅台", secid: "1.600519" },
        metrics: { close: 1500 },
        plan: { entryType: "close-confirmation", stop: 1440, minEntry: 1470, maxEntry: 1510, maxRiskPercent: 2, holdingDays: "5日" }
      }
    }],
    tItems: [{
      code: "600519",
      name: "贵州茅台",
      secid: "1.600519",
      config: { sellableShares: 200, costPrice: 1450 }
    }],
    tRuntimes: {
      "600519": { analysis: { deviationPct: -1.4, signal: { action: "buy", title: "分批低吸", shares: 100, price: 1490 } } }
    },
    monitorConfigs: {
      "600519": { enabled: true, mode: "any", cooldownMinutes: 5, conditions: [{ id: "c1", field: "latest", operator: "lte", value: 1500 }] }
    },
    monitorRuntimes: {
      "600519": { status: "triggered", detail: "跌破 1500 关注位" }
    },
    monitorQuotes: {},
    liveQuotes: {
      "600519": { code: "600519", price: 1495, changePct: -0.8 },
      "300750": { code: "300750", price: 196, changePct: -2.0 }
    }
  });

  assert.equal(sentinels.length, 3);
  assert.equal(sentinels[0].code, "600519");
  assert.deepEqual(sentinels[0].roles.sort(), ["做T", "持仓", "盯盘", "计划"]);
  assert.equal(sentinels[0].monitorTone, "alert");
  assert.equal(sentinels[0].tTone, "buy");
  assert.equal(sentinels[1].code, "300750");
  assert.match(sentinels[1].paperSummary, /止损 195.00/);
});

test("cockpitModel reconciles frozen plans accurately against close prices", () => {
  const makePlan = (code, stop, minEntry, maxEntry) => ({
    id: `p-${code}`,
    savedAt: "2026-11-13",
    isPreview: false,
    coverageComplete: true,
    marketGate: "open",
    candidate: { security: { code, name: code, secid: `0.${code}` }, metrics: { close: maxEntry }, plan: { stop, minEntry, maxEntry, maxRiskPercent: 2, holdingDays: "5日" } }
  });
  const rows = model.reconcilePlansAfterClose(
    [makePlan("000001", 10, 10.5, 11.2), makePlan("000002", 10, 10.5, 11.2), makePlan("000003", 10, 10.5, 11.2)],
    {
      "000001": { code: "000001", price: 9.8, changePct: -4.2 },
      "000002": { code: "000002", price: 10.9, changePct: 1.5 },
      "000003": { code: "000003", price: 11.8, changePct: 5.4 }
    }
  );
  assert.equal(rows[0].status, "stop-hit");
  assert.equal(rows[1].status, "in-band");
  assert.equal(rows[2].status, "above-band");
});

test("TodayCockpitView renders cleanly in SSR across session phases", () => {
  const html = renderToStaticMarkup(
    React.createElement(TodayCockpitView, {
      phase: { id: "intraday", label: "盘中盯盘", tip: "测试时段" },
      holdings: [{ code: "600519", name: "贵州茅台", secid: "1.600519", costPrice: 1450 }],
      favorites: [],
      watchlist: [],
      limitUps: [],
      notesApi: { store: { notes: [] } },
      tAssistant: { store: { items: [], trades: {} }, runtimes: {} },
      stockMonitors: { configs: {}, runtimes: {}, latestQuotes: {}, alerts: [] },
      paperSummary: { equity: 102000, openPnl: 2000, closedCount: 1, winCount: 1, cumulativeReturnPercent: 2.0, normalized: { openPositions: [] } },
      copilotAlerts: [],
      live: true,
      isDefaultView: false,
      onToggleDefaultView: () => {},
      onOpenStock: () => {},
      onNavigate: () => {}
    })
  );
  assert.match(html, /今日驾驶舱/);
  assert.match(html, /贵州茅台/);
  assert.match(html, /全账户融合实时哨兵/);
});

test("cockpitModel ranks preopen gaps and builds morning priority actions cleanly", () => {
  const preopen = model.buildPreopenAuctionRows({
    holdings: [
      { code: "600519", name: "贵州茅台", secid: "1.600519", costPrice: 1450 },
      { code: "000858", name: "五粮液", secid: "0.000858", costPrice: 140 }
    ],
    plans: [
      {
        id: "p-1",
        savedAt: "2026-11-14",
        isPreview: false,
        coverageComplete: true,
        marketGate: "open",
        candidate: {
          security: { code: "300059", name: "东方财富", secid: "0.300059" },
          metrics: { close: 22 },
          plan: { stop: 20.5, minEntry: 21.5, maxEntry: 22.8, maxRiskPercent: 5, holdingDays: "5日" }
        }
      }
    ],
    monitorConfigs: { "600519": { enabled: true, mode: "any", cooldownMinutes: 5, conditions: [] } },
    quotes: {
      "600519": { code: "600519", price: 1510, changePct: 4.1 },
      "000858": { code: "000858", price: 134, changePct: -3.5 },
      "300059": { code: "300059", price: 20.2, changePct: -2.0 }
    }
  });
  assert.equal(preopen[0].code, "300059");
  assert.equal(preopen[0].gapTone, "stop-hit");
  assert.equal(preopen[1].code, "000858");
  assert.equal(preopen[1].gapTone, "weak-alert");
  assert.equal(preopen[2].gapTone, "chase-warn");

  const priorities = model.buildMorningPriorities({
    holdings: [{ code: "000858", name: "五粮液", secid: "0.000858", costPrice: 140 }],
    monitorConfigs: {},
    copilotAlerts: [],
    planReconciliation: [],
    tItems: [{ code: "000858", name: "五粮液", secid: "0.000858", config: { sellableShares: 500, costPrice: 140 } }],
    urgentNotesCount: 2,
    newsItems: []
  });
  assert.equal(priorities.length, 3);
  assert.equal(priorities[0].actionKind, "enable-batch-stop");

  const maskedHtml = renderToStaticMarkup(
    React.createElement(TodayCockpitView, {
      phase: { id: "preopen", label: "盘前竞价", tip: "测试盘前" },
      holdings: [{ code: "600519", name: "贵州茅台", secid: "1.600519", costPrice: 1450 }],
      favorites: [],
      watchlist: [],
      limitUps: [],
      notesApi: { store: { notes: [] } },
      tAssistant: { store: { items: [], trades: {} }, runtimes: {} },
      stockMonitors: { configs: {}, runtimes: {}, latestQuotes: {}, alerts: [] },
      paperSummary: { equity: 102000, openPnl: 2000, closedCount: 1, winCount: 1, cumulativeReturnPercent: 2.0, normalized: { openPositions: [] } },
      copilotAlerts: [],
      live: true,
      isDefaultView: false,
      privacyMask: true,
      onToggleDefaultView: () => {},
      onOpenStock: () => {},
      onNavigate: () => {}
    })
  );
  assert.match(maskedHtml, /\*\*\*/);
  assert.match(maskedHtml, /今日先盯这/);
});

test("P1-2: buildUnifiedSentinels recognizes canonical PaperPosition stopPrice and takePrice fields", () => {
  const sentinels = model.buildUnifiedSentinels({
    holdings: [],
    favorites: [],
    openPaperPositions: [
      {
        code: "601899",
        name: "紫金矿业",
        secid: "1.601899",
        entryPrice: 16.0,
        latestPrice: 15.1,
        shares: 500,
        stopPrice: 15.0,
        takePrice: 18.5
      }
    ],
    plans: [],
    tItems: [],
    tRuntimes: {},
    monitorConfigs: {},
    monitorRuntimes: {},
    monitorQuotes: {},
    liveQuotes: {}
  });
  assert.equal(sentinels.length, 1);
  assert.match(sentinels[0].paperSummary, /止损 15\.00/);
  assert.match(sentinels[0].paperSummary, /止盈 18\.50/);
  // Near stopPrice (15.1 <= 15.0 * 1.015 = 15.225) boosts priority by +45 instead of +25
  assert.equal(sentinels[0].priority, 45);
});
