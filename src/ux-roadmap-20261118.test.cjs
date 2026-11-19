"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
const { createHookHarness, find, walk, text } = require("../qa/research-hook-harness.cjs");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const restore = registerTypeScript();
const previousCss = require.extensions[".css"];
require.extensions[".css"] = () => {};
after(() => {
  restore();
  if (previousCss) require.extensions[".css"] = previousCss;
  else delete require.extensions[".css"];
});

const {
  parseHoldingsPaste,
  applyHoldingTrade,
  appendHoldingTradeRecord,
  loadHoldingTrades,
  summarizeHoldingTrades,
  clearHoldingTrades
} = require("./features/collections/holdingsLedger.ts");
const { humanizeMarketSourceError } = require("./features/market/marketSourceHealth.ts");
const { saveQuickObservationPlan, saveQuickObservationPlansBatch, readTrendPlans } = require("./trendWorkspace.ts");
const { buildCopilotAlerts } = require("./copilotBriefing.ts");
const { normalizeSettingsCategory } = require("./domain/visualPreferences.ts");
const { isAppLocalKey } = require("./features/backup/backupClient.ts");
const { tightenUserDataPermissions, writeJsonAtomic } = require("../electron/persistence.cjs");
const { createDailyBarStore } = require("../electron/daily-bar-store.cjs");
const { humanizeSourceError } = require("../electron/market-source-health.cjs");
const { getStrategyScanProgress } = require("../electron/strategy-selection-service.cjs");

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => { map.set(key, String(val)); },
    removeItem: key => { map.delete(key); }
  };
}

test("parseHoldingsPaste supports 3+ numeric broker columns, T+0 zero available shares, and 2-column compat", () => {
  const res = parseHoldingsPaste([
    "证券代码 证券名称 股票余额 可用余额 成本价 市价",
    "000001 平安银行 1,000 1,000 14.85 15.20",
    "600519 贵州茅台 200 0 1480.50 1510.00",
    "300059 东方财富 500 21.80 底仓"
  ].join("\n"));

  assert.equal(res.errors.length, 0);
  assert.equal(res.entries.length, 3);
  assert.equal(res.entries[0].code, "000001");
  assert.equal(res.entries[0].shares, 1000);
  assert.equal(res.entries[0].availableShares, 1000);
  assert.equal(res.entries[0].costPrice, 14.85);
  const moutai = res.entries.find(item => item.code === "600519");
  const eastmoney = res.entries.find(item => item.code === "300059");
  assert.equal(moutai.shares, 200);
  assert.equal(moutai.availableShares, 0);
  assert.equal(moutai.costPrice, 1480.5);
  assert.equal(eastmoney.shares, 500);
  assert.equal(eastmoney.costPrice, 21.8);
});

test("applyHoldingTrade diluteCost & real trade ledger persistence summarize realized PnL", () => {
  const items = [{
    code: "600519",
    name: "贵州茅台",
    secid: "1.600519",
    shares: 200,
    costPrice: 1500,
    note: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }];
  const sellDiluted = applyHoldingTrade({
    items,
    code: "600519",
    side: "sell",
    shares: 100,
    price: 1600,
    diluteCost: true
  });
  assert.equal(sellDiluted.ok, true);
  // 摊薄成本时不重复计入该笔已实现盈亏，等剩余仓位清仓时一次性兑现全额 20000 利润
  assert.equal(sellDiluted.realizedPnl, 0);
  assert.equal(sellDiluted.nextItems[0].shares, 100);
  assert.equal(sellDiluted.nextItems[0].costPrice, 1400);

  const sellFinal = applyHoldingTrade({
    items: sellDiluted.nextItems,
    code: "600519",
    side: "sell",
    shares: 100,
    price: 1600
  });
  assert.equal(sellFinal.ok, true);
  assert.equal(sellFinal.realizedPnl, 20000);

  const rejectTiny = applyHoldingTrade({
    items,
    code: "600519",
    side: "buy",
    shares: 100,
    price: 0.0004
  });
  assert.equal(rejectTiny.ok, false);

  const storage = createMemoryStorage();
  appendHoldingTradeRecord({
    code: "600519",
    name: "贵州茅台",
    side: "sell",
    shares: 100,
    price: 1600,
    realizedPnl: 20000
  }, storage);
  const records = loadHoldingTrades(storage);
  assert.equal(records.length, 1);
  const summary = summarizeHoldingTrades(records);
  assert.equal(summary.sellCount, 1);
  assert.equal(summary.winCount, 1);
  assert.equal(summary.cumulativeRealizedPnl, 20000);
  clearHoldingTrades(storage);
  assert.equal(loadHoldingTrades(storage).length, 0);

  const brokerEdgePaste = parseHoldingsPaste([
    "000001\t平安银行\t1000\t1000\t-700.00\t12.50",
    "688981 中芯国际 250 50 82.45 85.10",
    "贵州茅台 200 1480.50 600519"
  ].join("\n"));
  assert.equal(brokerEdgePaste.errors.length, 0);
  assert.equal(brokerEdgePaste.entries.find(e => e.code === "000001").costPrice, 12.5);
  assert.equal(brokerEdgePaste.entries.find(e => e.code === "688981").costPrice, 82.45);
  assert.equal(brokerEdgePaste.entries.find(e => e.code === "600519").costPrice, 1480.5);
});

test("humanizeMarketSourceError and backend humanizeSourceError translate technical errors to actionable Chinese", () => {
  assert.match(humanizeMarketSourceError("HTTP 429 Too Many Requests"), /频繁|冷却/);
  assert.match(humanizeMarketSourceError("fetch failed: ETIMEDOUT"), /超时/);
  assert.match(humanizeSourceError("getaddrinfo ENOTFOUND push2.eastmoney.com"), /网络|离线|解析/);
});

test("saveQuickObservationPlan enforces 200-plan cap while preserving active plans", () => {
  const storage = createMemoryStorage();
  for (let i = 0; i < 205; i += 1) {
    const code = String(600000 + i).padStart(6, "0");
    saveQuickObservationPlan(storage, { code, name: `测试${i}`, secid: `1.${code}`, referencePrice: 10 + (i % 5) });
  }
  const { plans } = readTrendPlans(storage);
  assert.equal(plans.length, 200);
  assert.equal(plans[0].candidate.security.code, "600204");
});

test("buildCopilotAlerts routes stock monitor alerts directly to dashboard stock analysis", () => {
  const alerts = buildCopilotAlerts({
    monitorAlerts: [{
      id: "m1",
      code: "000001",
      name: "平安银行",
      kind: "stopPrice",
      detail: "跌破止损 11.20",
      triggeredAt: new Date().toISOString()
    }],
    tSignals: [],
    triggeredNotes: [],
    holdings: []
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].targetView, "dashboard");
});

test("persistence and daily-bar-store tighten permissions, sweep tmp files, and expose scan progress", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "astock-ux-roadmap-"));
  try {
    const file = path.join(tmpRoot, "holdings.json");
    writeJsonAtomic(file, `${file}.bak`, [{ code: "600519" }]);
    fs.chmodSync(file, 0o644);
    tightenUserDataPermissions(tmpRoot);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(tmpRoot).mode & 0o777, 0o700);
    }

    const barDir = path.join(tmpRoot, "daily-bars-v2");
    fs.mkdirSync(barDir, { recursive: true });
    fs.writeFileSync(path.join(barDir, "600519.json.12345.1.tmp"), "{}");
    fs.writeFileSync(path.join(barDir, "selection-universe.json.tmp"), "{}");
    const store = createDailyBarStore({ directory: barDir, previousSession: () => "2026-01-01" });
    const cleaned = await store.cleanupStaleBars({ activeCodes: new Set(), maxAgeDays: 180 });
    assert.equal(cleaned.removedTmp, 1);
    assert.equal(fs.existsSync(path.join(barDir, "selection-universe.json.tmp")), true);
    assert.deepEqual(store.getStorageStats(), { fileCount: 0, totalBytes: 0 });

    const progress = getStrategyScanProgress();
    assert.equal(typeof progress.active, "boolean");
    assert.equal(typeof progress.processed, "number");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("QuickPaletteModal, ErrorBoundaries, SettingsView, and CollectionViews render new UX controls cleanly", () => {
  const QuickPaletteModal = require("./components/terminal/QuickPaletteModal.tsx").default;
  const AppErrorBoundaryMod = require("./components/AppErrorBoundary.tsx");
  const AppErrorBoundary = AppErrorBoundaryMod.default || AppErrorBoundaryMod.AppErrorBoundary;
  const { WorkspaceErrorBoundary } = AppErrorBoundaryMod;
  const { SettingsView } = require("./features/settings/SettingsView.tsx");
  const { HoldingsView, WatchlistView } = require("./features/collections/CollectionViews.tsx");
  const { initialSettings } = require("./domain/settings.ts");

  const prevWindow = global.window;
  const prevDocument = global.document;
  global.window = {
    localStorage: createMemoryStorage(),
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {}
  };
  global.document = {
    documentElement: { style: {}, dataset: {} },
    activeElement: null
  };
  try {
    const navigated = [];
    const paletteHarness = createHookHarness(() => QuickPaletteModal({
      open: true,
      onClose() {},
      views: [{ id: "cockpit", label: "今日驾驶舱", hint: "主控台", group: "view" }],
      commands: [{ id: "backup", label: "数据备份", hint: "设置", group: "command" }],
      holdings: [],
      favorites: [],
      watchlist: [],
      onNavigateView: id => navigated.push(id),
      onOpenStock() {},
      onRunCommand() {}
    }), { runEffects: false });
    paletteHarness.render();
    assert.match(text(paletteHarness.tree), /今日驾驶舱/);
    const searchInput = find(paletteHarness.tree, n => n.type === "input");
    searchInput.props.onKeyDown({ key: "ArrowDown", nativeEvent: { isComposing: false }, preventDefault() {} });
    searchInput.props.onKeyDown({ key: "ArrowUp", nativeEvent: { isComposing: false }, preventDefault() {} });
    searchInput.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} });
    assert.deepEqual(navigated, ["cockpit"]);
    paletteHarness.dispose();

    const wsBoundary = new WorkspaceErrorBoundary({ label: "异动面板", compact: true, children: null });
    wsBoundary.state = { error: new Error("boom"), attempt: 0 };
    wsBoundary.setState = patch => {
      wsBoundary.state = typeof patch === "function" ? { ...wsBoundary.state, ...patch(wsBoundary.state) } : { ...wsBoundary.state, ...patch };
    };
    const compactTree = wsBoundary.render();
    assert.match(renderToStaticMarkup(compactTree), /异动面板加载遇到异常/);

    const appBoundary = new AppErrorBoundary({ children: null });
    appBoundary.state = { error: new Error("fatal") };
    assert.match(renderToStaticMarkup(appBoundary.render()), /重置视图布局并重载/);

    const settingsHarness = createHookHarness(() => SettingsView({
      value: initialSettings,
      loadState: "ready",
      initialCategory: "appearance",
      onSave: async next => next
    }), { runEffects: false });
    settingsHarness.render();
    assert.match(text(settingsHarness.tree), /界面字号缩放/);
    assert.match(text(settingsHarness.tree), /色觉友好色板/);
    const scaleButtons = walk(settingsHarness.tree).filter(n => n.type === "button" && typeof text(n) === "string" && /110%|红涨蓝跌/.test(text(n)));
    for (const btn of scaleButtons) btn.props.onClick?.();
    settingsHarness.dispose();

    const holdingsHarness = createHookHarness(() => HoldingsView({
      items: [{
        code: "600519",
        name: "贵州茅台",
        secid: "1.600519",
        shares: 100,
        costPrice: 1500,
        note: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }],
      settings: initialSettings,
      live: false,
      paperPositions: [{
        id: "p1",
        code: "000001",
        name: "平安银行",
        shares: 500,
        entryPrice: 12,
        latestPrice: 12.6,
        stopPrice: 11.4,
        takePrice: 13.8,
        entryFee: 5,
        openedAt: "2026-01-02T00:00:00.000Z",
        entryDate: "2026-01-02",
        holdingBars: 2
      }],
      paperMetrics: { equity: 100300, cash: 94000, openValue: 6300, openPnl: 295, openPnlPercent: 4.9, cumulativeRealizedPnl: 0 },
      initialLedgerTab: "paper",
      onClosePaperPosition() {},
      onOpenPaperStock() {},
      onSave: async () => true,
      onOpen() {}
    }), { runEffects: false });
    holdingsHarness.render();
    assert.match(text(holdingsHarness.tree), /模拟盘持仓 \(1\)/);
    const realTab = find(holdingsHarness.tree, n => n.type === "button" && /实盘持仓/.test(text(n)));
    realTab.props.onClick();
    holdingsHarness.render();
    const sortBtns = walk(holdingsHarness.tree).filter(n => n.type === "button" && n.props?.className?.includes("column-sort-button"));
    for (const btn of sortBtns) btn.props.onClick();
    holdingsHarness.render();
    holdingsHarness.dispose();

    const watchHtml = renderToStaticMarkup(React.createElement(WatchlistView, {
      items: [{
        code: "300059",
        name: "东方财富",
        secid: "0.300059",
        createdAt: "2026-01-01T00:00:00.000Z",
        poolNode: "focus"
      }],
      activeNode: "all",
      quotes: { "300059": { latest: 22.5, changePct: 3.21 } },
      favoriteCodes: new Set(),
      onAddFavorite() {},
      onNodeChange() {},
      onOpen() {},
      onRemove() {}
    }));
    assert.match(watchHtml, /22\.50/);
    assert.match(watchHtml, /\+加入自选/);

    const StockMonitorEditor = require("./components/StockMonitorEditor.tsx").default;
    const DisplayDensityControl = require("./components/terminal/DisplayDensityControl.tsx").default;
    const { ConfirmDialog } = require("./components/terminal/ConfirmDialog.tsx");

    let savedCfg = null;
    const monitorHarness = createHookHarness(() => StockMonitorEditor({
      stock: { code: "600519", name: "贵州茅台" },
      onSave: cfg => { savedCfg = cfg; return true; },
      onCancel() {}
    }), { runEffects: false });
    monitorHarness.render();
    const addBtn = find(monitorHarness.tree, n => n.type === "button" && /添加条件/.test(text(n)));
    addBtn.props.onClick();
    monitorHarness.render();
    const delBtn = find(monitorHarness.tree, n => n.type === "button" && n.props["aria-label"] === "删除条件 2");
    delBtn.props.onClick();
    monitorHarness.render();
    const threshInput = find(monitorHarness.tree, n => n.type === "input" && String(n.props["aria-label"] || "").includes("条件 1 阈值"));
    threshInput.props.onChange({ target: { value: "1520" } });
    monitorHarness.render();
    const formNode = find(monitorHarness.tree, n => n.type === "form");
    formNode.props.onSubmit({ preventDefault() {} });
    assert.ok(savedCfg && savedCfg.conditions[0].value === 1520);
    monitorHarness.dispose();

    const densityHarness = createHookHarness(DisplayDensityControl, { runEffects: false });
    densityHarness.render();
    find(densityHarness.tree, n => n.type === "button").props.onClick();
    densityHarness.render();
    densityHarness.dispose();

    let resolvedVal = null;
    const dialogHarness = createHookHarness(() => ConfirmDialog({
      request: { title: "确认操作", message: "请确认", details: ["明细1"], tone: "danger" },
      onResolve: v => { resolvedVal = v; }
    }), { runEffects: false });
    dialogHarness.render();
    find(dialogHarness.tree, n => n.type === "dialog").props.onCancel({ preventDefault() {} });
    assert.equal(resolvedVal, false);
    dialogHarness.dispose();

    const retryBtn = find(compactTree, n => n.type === "button");
    retryBtn.props.onClick();

    // Exercise HoldingsView trade/paste tabs and AppHeaderBar/WorkspaceNavigation callbacks
    const holdingsFull = createHookHarness(() => HoldingsView({
      items: [{
        code: "600519",
        name: "贵州茅台",
        secid: "1.600519",
        shares: 200,
        costPrice: 1500,
        note: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }],
      settings: initialSettings,
      live: false,
      onSave: async () => true,
      onOpen() {}
    }), { runEffects: false });
    holdingsFull.render();
    const tradeTab = find(holdingsFull.tree, n => n.type === "button" && /加减仓记账/.test(text(n)));
    tradeTab.props.onClick();
    holdingsFull.render();
    const sellBtn = find(holdingsFull.tree, n => n.type === "button" && /卖出\/减仓/.test(text(n)));
    sellBtn.props.onClick();
    holdingsFull.render();
    const diluteBox = find(holdingsFull.tree, n => n.type === "input" && n.props.type === "checkbox");
    diluteBox.props.onChange({ target: { checked: true } });
    holdingsFull.render();
    const pasteTab = find(holdingsFull.tree, n => n.type === "button" && /粘贴批量导入/.test(text(n)));
    pasteTab.props.onClick();
    holdingsFull.render();
    const pasteArea = find(holdingsFull.tree, n => n.type === "textarea");
    pasteArea.props.onChange({ target: { value: "000001 平安银行 1000 1000 14.85" } });
    holdingsFull.render();
    holdingsFull.dispose();

    const { renderAppHeaderBar } = require("./components/AppHeaderBar.tsx");
    const { resolveMarketSessionPhase } = require("./copilotBriefing.ts");
    const headerTree = renderAppHeaderBar({
      workspaceLabel: "今日驾驶舱",
      view: "cockpit",
      dashboardMode: "pool",
      researchView: false,
      live: true,
      onToggleLive() {},
      loading: false,
      payload: null,
      onRefreshAnalysis() {},
      settings: initialSettings,
      onSetTheme() {},
      onToggleNewsVoice() {},
      onOpenPalette() {},
      privacyMask: false,
      onTogglePrivacyMask() {},
      query: "600",
      setQuery() {},
      suggestions: [{ code: "600519", name: "贵州茅台", secid: "1.600519" }],
      setSuggestions() {},
      searching: false,
      setSearching() {},
      searchError: "",
      setSearchError() {},
      searchComplete: true,
      setSearchComplete() {},
      searchComposing: false,
      setSearchComposing() {},
      searchComposingRef: { current: false },
      searchEditVersion: { current: 0 },
      searchRequestId: { current: 0 },
      searchTimer: { current: undefined },
      searchBoxRef: { current: null },
      onSearchSubmit(e) { e.preventDefault?.(); },
      onFetchSuggestions: async () => [],
      onSelectSuggestion() {},
      copilotRef: { current: null },
      copilotOpen: true,
      setCopilotOpen() {},
      copilotPhase: resolveMarketSessionPhase(),
      copilotAlerts: [{
        id: "a1",
        source: "monitor",
        tone: "danger",
        code: "600519",
        name: "贵州茅台",
        title: "贵州茅台 触发监控",
        detail: "跌破 1480",
        at: new Date().toISOString(),
        targetView: "dashboard"
      }],
      onCopilotSelect() {},
      holdingsCount: 1,
      favoritesCount: 2,
      awaitingNotesCount: 1,
      tItemsCount: 1,
      onNavigateView() {},
      hasMonitorAlerts: true,
      onClearMonitorAlerts() {}
    });
    for (const btn of walk(headerTree).filter(n => n.type === "button")) {
      btn.props.onClick?.({ preventDefault() {}, stopPropagation() {} });
    }
    const headerInput = find(headerTree, n => n.type === "input");
    headerInput.props.onCompositionStart?.();
    headerInput.props.onCompositionEnd?.({ currentTarget: { value: "600519" } });
    headerInput.props.onChange?.({ target: { value: "" } });

    const WorkspaceNavigation = require("./components/WorkspaceNavigation.tsx").default;
    const { renderAppWorkspaceRoutes } = require("./components/AppWorkspaceRoutes.tsx");
    const { Star } = require("lucide-react");
    const navTree = WorkspaceNavigation({
      items: [
        { id: "cockpit", label: "今日驾驶舱", icon: Star },
        { id: "bonds", label: "可转债", icon: Star }
      ],
      active: "cockpit",
      counts: { cockpit: 2 },
      collapsed: false,
      coreOnly: true,
      onToggleCoreOnly() {},
      onCollapse() {},
      onNavigate() {}
    });
    for (const btn of walk(navTree).filter(n => n.type === "button")) {
      btn.props.onClick?.();
    }

    const baseRouteProps = {
      view: "cockpit",
      setView() {},
      researchView: false,
      dashboardMode: "analysis",
      informationTab: "all",
      setInformationTab() {},
      watchlistNode: "all",
      setWatchlistNode() {},
      analysisOrigin: null,
      observationReturnLabel: () => "返回",
      originForView: () => ({ view: "signals", label: "返回" }),
      navigateTo() {},
      openAnalysis() {},
      returnFromAnalysis() {},
      loadSecurity: async () => {},
      latestAnalysis: { current: null },
      analysisRequestId: { current: 0 },
      payload: null,
      analysisTarget: { code: "600519", name: "贵州茅台", secid: "1.600519" },
      loading: false,
      error: "",
      live: false,
      privacyMask: false,
      defaultCockpit: false,
      toggleDefaultCockpit() {},
      settings: initialSettings,
      settingsLoadState: "ready",
      persistSettings: async s => ({ ...initialSettings, ...s }),
      watchlist: [],
      holdings: [],
      favoriteItems: [],
      favoriteCodes: new Set(),
      observationItems: [],
      isFavorite: false,
      toggleFavorite: async () => {},
      removeObservation: async () => true,
      saveHoldings: async () => true,
      addFavoriteSecurity: async () => {},
      handleQuickHoldingTrade: async () => true,
      showToast() {},
      notes: { notes: [], awaitingCount: 0, addNote() {}, updateNote() {}, removeNote() {}, markDone() {} },
      tAssistant: { items: [], activeCode: null, setActiveCode() {}, addStock() {}, removeStock() {}, updateParams() {}, logTrade() {} },
      stockMonitors: { configs: {}, alerts: [], save: () => true, remove() {}, clearAlerts() {}, ackAlert() {} },
      copilotPhase: resolveMarketSessionPhase(),
      copilotAlerts: [],
      newsLiveQuotes: { "600519": { code: "600519", changePct: 1.5, price: 1500 } },
      addNoteToT() {},
      addNoteToMonitor: async () => {},
      discover: async () => {},
      discovering: false,
      limitUps: [],
      limitPoolMeta: { date: "", source: "", updatedAt: "" },
      failedBoardCache: { current: null },
      failedBoardViewState: { current: undefined },
      rememberFailedBoardCache() {},
      rememberFailedBoardViewState() {},
      sectorBoard: [],
      sectorExtra: null,
      sectorBoardLoading: false,
      sectorBoardError: "",
      sectorLegacyOpen: true,
      setSectorLegacyOpen() {},
      loadSectorBoard: async () => true,
      compareCandidates: [
        { code: "000001", name: "平安银行", secid: "0.000001" },
        { code: "600519", name: "贵州茅台", secid: "1.600519" },
        { code: "300059", name: "东方财富", secid: "0.300059" }
      ],
      reviewMounted: true,
      portfolioActive: true,
      portfolioMounted: true,
      portfolioInitialSecurities: [],
      portfolioBack() {},
      portfolioOpenSingle() {},
      portfolioOpenSecurity() {},
      openBacktest() {},
      backtestCenterMode: "single",
      setBacktestCenterMode() {},
      backtestDraft: { code: "600519", strategyContext: null },
      setBacktestDraft() {},
      backtestLoading: false,
      backtestError: "",
      backtestResult: null,
      backtestRunRecord: null,
      backtestHistory: [],
      backtestProfileComparisons: [],
      backtestEntryContext: null,
      invalidateBacktests() {},
      runBacktest: async () => {},
      runBacktestProfileComparisons: async () => {},
      applyBacktestProfileWithGovernance: async () => {},
      loadBacktestRecord() {},
      exportBacktestPayload() {},
      exportCurrentBacktest() {},
      applyCurrentBacktestToPaper() {},
      applyHistoryToSettings: async () => {},
      clearBacktestHistory() {},
      updateBacktestTargetContext() {},
      executionDecisionLog: [],
      clearExecutionDecisionLog() {},
      paperSummary: {
        normalized: { cash: 100000, openPositions: [] },
        equity: 100000,
        openValue: 0,
        openPnl: 0,
        openPnlPercent: 0,
        cumulativeRealizedPnl: 0,
        closedCount: 0,
        winCount: 0
      },
      paperExecutionReadiness: { level: "ready", score: 80, summary: "", recommendation: "", reasons: [] },
      paperCurrentPositions: [],
      canPaperTrade: true,
      latestExecutionDecision: null,
      executePaperTrade() {},
      closePaperTradeForCurrent() {},
      closePaperTradeForCode() {},
      closeAllPaperTrades() {},
      confirmPaperSettlementForCode() {},
      settingsCategory: "appearance",
      openSettings() {}
    };

    const routeViews = [
      "cockpit", "dashboard", "previous-limit-up-failed", "favorites", "holdings",
      "watchlist", "beijing", "hsgt", "bonds", "sectors", "news", "signals",
      "ai-picks", "ai-agent", "notes", "t-assistant", "compare", "review", "backtest", "settings"
    ];
    for (const v of routeViews) {
      const routeTree = renderAppWorkspaceRoutes({
        ...baseRouteProps,
        view: v,
        researchView: v === "signals"
      });
      for (const node of walk(routeTree)) {
        if (!node.props) continue;
        node.props.onReturnHome?.();
        node.props.onOpenStock?.({ code: "600519", name: "贵州茅台", secid: "1.600519" });
        node.props.onOpen?.({ code: "600519", name: "贵州茅台", secid: "1.600519" });
        node.props.onOpenSecurity?.({ code: "600519", name: "贵州茅台", secid: "1.600519" });
        node.props.onOpenPaperStock?.({ code: "600519", name: "贵州茅台", secid: "1.600519" });
        node.props.onClosePaperPosition?.("600519");
        node.props.onConfirmPaperSettlement?.("600519");
        node.props.onAddFavorite?.({ code: "600519", name: "贵州茅台", secid: "1.600519" });
        node.props.onSyncCostToHolding?.("600519", 100, 1490, "贵州茅台");
        node.props.onPrevStock?.();
        node.props.onNextStock?.();
        node.props.onOpenSettings?.();
        node.props.onOpenStrategies?.();
        node.props.onOpenAiPicks?.();
        node.props.onOpenPortfolio?.();
        node.props.onNavigate?.("signals");
      }
    }

    assert.equal(normalizeSettingsCategory("appearance"), "monitoring");
    assert.equal(normalizeSettingsCategory("nonexistent"), "sources");
    assert.equal(isAppLocalKey("astock:display-density:v1"), true);

    const batchStorage = createMemoryStorage();
    const batchRes = saveQuickObservationPlansBatch(batchStorage, [
      { code: "600519", name: "贵州茅台", referencePrice: 1500 },
      { code: "000001", name: "平安银行", referencePrice: null }
    ]);
    assert.deepEqual(batchRes.created, ["600519"]);
    assert.deepEqual(batchRes.missingPrice, ["000001"]);
    assert.equal(batchRes.storageError, "");
  } finally {
    global.window = prevWindow;
    global.document = prevDocument;
  }
});

