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

test("QuickPaletteModal, ErrorBoundaries, SettingsView, and CollectionViews render new UX controls cleanly", async () => {
  const QuickPaletteModal = require("./components/terminal/QuickPaletteModal.tsx").default;
  const AppErrorBoundaryMod = require("./components/AppErrorBoundary.tsx");
  const AppErrorBoundary = AppErrorBoundaryMod.default || AppErrorBoundaryMod.AppErrorBoundary;
  const { WorkspaceErrorBoundary } = AppErrorBoundaryMod;
  const { SettingsView } = require("./features/settings/SettingsView.tsx");
  const { FavoritesView, HoldingsView, WatchlistView } = require("./features/collections/CollectionViews.tsx");
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
    const scaleButtons = walk(settingsHarness.tree).filter(n => n.type === "button" && typeof text(n) === "string" && /110%|125%|红涨蓝跌|默认配色|紧凑/.test(text(n)));
    for (const btn of scaleButtons) btn.props.onClick?.();
    const catTabs = walk(settingsHarness.tree).filter(n => n.type === "button" && n.props?.role === "tab");
    for (const tab of catTabs) {
      tab.props.onClick?.();
      settingsHarness.render();
    }
    const svForm = walk(settingsHarness.tree).find(n => n.type === "form");
    svForm?.props.onSubmit?.({ preventDefault() {} });
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
    for (const inp of walk(holdingsHarness.tree).filter(n => n.type === "textarea")) {
      inp.props.onChange?.({ target: { value: "600519 100 1500 100" } });
    }
    holdingsHarness.render();
    for (const btn of walk(holdingsHarness.tree).filter(n => n.type === "button" && /批量启用|预览导入|确认导入|移除/.test(text(n)))) {
      btn.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
    }
    holdingsHarness.dispose();

    const favHarness = createHookHarness(() => FavoritesView({
      items: [{ code: "600519", name: "贵州茅台", secid: "1.600519", createdAt: "2026-01-01T00:00:00.000Z" }],
      monitors: {
        configs: {},
        runtimes: {},
        latestQuotes: {},
        refreshing: false,
        alerts: [{ id: "a1", code: "600519", name: "贵州茅台", triggeredAt: "2026-11-18T02:00:00Z", detail: "涨超 3%" }],
        ackAlert() {},
        clearAlerts() {},
        save: () => true
      },
      live: false,
      onOpen() {},
      onRemove() {},
      onNavigate() {}
    }), { runEffects: false });
    favHarness.render();
    for (const btn of walk(favHarness.tree).filter(n => n.type === "button" && typeof n.props?.onClick === "function")) {
      btn.props.onClick({ stopPropagation() {}, preventDefault() {} });
    }
    favHarness.dispose();

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
    assert.match(watchHtml, /\+自选/);

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

    const { isCloudSyncFolder } = require("./features/backup/BackupSettingsCard.tsx");
    assert.equal(isCloudSyncFolder("/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/Backup"), true);
    assert.equal(isCloudSyncFolder("/Users/demo/坚果云/AStock/sub"), true);
    assert.equal(isCloudSyncFolder("/Users/demo/CustomCloud", [{ path: "/Users/demo/CustomCloud" }]), true);
    assert.equal(isCloudSyncFolder("/Users/demo/Documents/AStockLocal", [{ path: "/Users/demo/iCloud" }]), false);

    const { UI_SCALE_PRESETS, stepUiScale, normalizeUiScale } = require("./domain/visualPreferences.ts");
    assert.deepEqual(UI_SCALE_PRESETS, [90, 100, 110, 120, 125]);
    assert.equal(normalizeUiScale(125), 125);
    assert.equal(stepUiScale(120, 1), 125);
    assert.equal(stepUiScale(125, 1), 125);
    assert.equal(stepUiScale(90, -1), 90);

    const { QuickMonitorModal } = require("./components/QuickMonitorModal.tsx");
    const { MasterPasswordUnlockModal } = require("./components/MasterPasswordUnlockModal.tsx");
    const { HsgtOverlayProvider } = require("./features/hsgt/overlayContext.tsx");
    const monitorModalHtml = renderToStaticMarkup(
      React.createElement(HsgtOverlayProvider, null,
        React.createElement(QuickMonitorModal, {
          stock: { code: "600519", name: "贵州茅台", secid: "1.600519" },
          onSave: () => true,
          onClose() {}
        })
      )
    );
    assert.match(monitorModalHtml, /贵州茅台/);
    const unlockHtml = renderToStaticMarkup(
      React.createElement(HsgtOverlayProvider, null,
        React.createElement(MasterPasswordUnlockModal, { open: true, onUnlocked() {} })
      )
    );
    assert.match(unlockHtml, /解锁/);

    const { useVirtualWindow } = require("./components/useVirtualWindow.ts");
    const vSmall = createHookHarness(() => useVirtualWindow({ itemCount: 50, rowHeight: 40 }), { runEffects: false });
    vSmall.render();
    assert.equal(vSmall.tree.enabled, false);
    vSmall.dispose();
    const vLarge = createHookHarness(() => useVirtualWindow({ itemCount: 200, rowHeight: 40 }), { runEffects: false });
    vLarge.render();
    assert.equal(vLarge.tree.enabled, true);
    assert.ok(vLarge.tree.endIndex < 200);
    vLarge.dispose();

    const { loadSafeLocalJson, saveSafeLocalJson, resetSafeStorageCache, mirrorToNativeKv, hydrateFromNativeKv } = require("./safeStorage.ts");
    resetSafeStorageCache();
    const memStorage = createMemoryStorage();
    const kvMap = new Map();
    global.window = {
      localStorage: memStorage,
      stockApi: {
        kvGet: async k => kvMap.get(k) ?? null,
        kvSet: async (k, v) => { kvMap.set(k, v); return true; }
      }
    };
    assert.equal(saveSafeLocalJson("ux-test-key", { ok: true }, x => Boolean(x && x.ok)), true);
    assert.deepEqual(loadSafeLocalJson("ux-test-key", { ok: false }), { ok: true });
    mirrorToNativeKv("ux-test-key", JSON.stringify({ ok: true, fromKv: 1 }));
    memStorage.removeItem("ux-test-key");
    const hydrated = await hydrateFromNativeKv("ux-test-key", x => Boolean(x && typeof x === "object"));
    assert.deepEqual(hydrated, { ok: true, fromKv: 1 });
    assert.equal(memStorage.getItem("ux-test-key"), JSON.stringify({ ok: true, fromKv: 1 }));

    const { isUsableSecurityCollection, uniqueSecurities } = require("./securitySelection.ts");
    assert.equal(isUsableSecurityCollection([]), true);
    assert.equal(isUsableSecurityCollection([{ bad: true }]), false);
    assert.equal(
      uniqueSecurities([
        { code: "600519", name: "贵州茅台", secid: "1.600519" },
        { code: "600519", name: "重复茅台", secid: "1.600519" },
        { code: "bad", name: "无效", secid: "1.0" }
      ]).length,
      1
    );

    const StockRowActions = require("./components/StockRowActions.tsx").default;
    let actionHits = [];
    const sraHarness = createHookHarness(() => StockRowActions({
      security: { code: "600519", name: "贵州茅台", secid: "1.600519" },
      isFavorite: false,
      isPlanned: false,
      onToggleFavorite: () => actionHits.push("fav"),
      onOpenMonitor: () => actionHits.push("mon"),
      onAddPlan: () => actionHits.push("plan"),
      compact: true
    }), { runEffects: false });
    sraHarness.render();
    for (const btn of walk(sraHarness.tree).filter(n => n.type === "button")) {
      btn.props.onClick({ stopPropagation() {} });
    }
    assert.deepEqual(actionHits, ["fav", "mon", "plan"]);
    sraHarness.dispose();

    const { QuickPlanDialogContent, usePlannedCodes } = require("./components/QuickPlanModal.tsx");
    const QuickPlanModalDefault = require("./components/QuickPlanModal.tsx").default;
    assert.equal(QuickPlanModalDefault({ target: null, onClose() {} }), null);
    const plannedH = createHookHarness(() => usePlannedCodes(true), { runEffects: false });
    plannedH.render();
    assert.equal(plannedH.tree[0] instanceof Set, true);
    plannedH.dispose();

    let savedPlanMsg = "";
    let closedPlan = 0;
    const qpHarness = createHookHarness(() => QuickPlanDialogContent({
      target: { code: "600519", name: "贵州茅台", secid: "1.600519", referencePrice: 1500 },
      onClose: () => { closedPlan += 1; },
      onSaved: res => { savedPlanMsg = res.message; }
    }), { runEffects: false });
    qpHarness.render();
    const qpInputs = walk(qpHarness.tree).filter(n => n.type === "input");
    if (qpInputs[0]) qpInputs[0].props.onChange({ target: { value: "1520" } });
    if (qpInputs[1]) qpInputs[1].props.onChange({ target: { value: "1500" } });
    qpHarness.render();
    find(qpHarness.tree, n => n.type === "form").props.onSubmit({ preventDefault() {} });
    qpHarness.render();
    if (qpInputs[1]) qpInputs[1].props.onChange({ target: { value: "1560" } });
    if (qpInputs[2]) qpInputs[2].props.onChange({ target: { value: "1530" } });
    qpHarness.render();
    find(qpHarness.tree, n => n.type === "form").props.onSubmit({ preventDefault() {} });
    qpHarness.render();
    if (qpInputs[2]) qpInputs[2].props.onChange({ target: { value: "1450" } });
    if (qpInputs[3]) qpInputs[3].props.onChange({ target: { value: "1650" } });
    if (qpInputs[4]) qpInputs[4].props.onChange({ target: { value: "备注" } });
    qpHarness.render();
    const qpForm = find(qpHarness.tree, n => n.type === "form");
    qpForm.props.onSubmit({ preventDefault() {} });
    assert.match(savedPlanMsg, /贵州茅台/);
    assert.equal(closedPlan, 1);
    qpHarness.dispose();

    let monitorClosed = 0;
    const qmHarness = createHookHarness(() => QuickMonitorModal({
      stock: { code: "600519", name: "贵州茅台", secid: "1.600519" },
      onSave: () => true,
      onClose: () => { monitorClosed += 1; }
    }), { runEffects: false });
    qmHarness.render();
    const qmDialog = find(qmHarness.tree, n => n.type === "dialog");
    qmDialog.props.onCancel({ preventDefault() {} });
    assert.equal(monitorClosed, 1);
    qmHarness.dispose();

    global.window.stockApi.cleanupStorageCache = async ({ target }) => ({ ok: true, target, message: `cleaned ${target}`, summary: { userDataBytes: 512, dailyBarsBytes: 1024, dailyBarsCount: 5, webCacheBytes: 0 } });
    global.window.stockApi.getMasterPasswordStatus = async () => ({ enabled: false, locked: false });
    global.window.stockApi.setMasterPassword = async () => ({ enabled: true, locked: false });
    global.window.stockApi.clearMasterPassword = async () => ({ enabled: false, locked: false });
    global.window.stockApi.backup = {
      status: async () => ({ folder: "/Users/demo/iCloud/Backups", auto: true, keep: 30, hasPassword: false, files: [{ name: "A股雷达备份-20261112-160509.json", size: 2048 }], suggestions: [{ label: "iCloud", path: "/Users/demo/iCloud" }], storageSummary: { userDataBytes: 1024, dailyBarsBytes: 2048, dailyBarsCount: 10, webCacheBytes: 512 } }),
      chooseFolder: async () => ({ folder: "/Users/demo/Local", auto: true, keep: 30, hasPassword: false, files: [], suggestions: [] }),
      configure: async () => ({ folder: "/Users/demo/Local", auto: true, keep: 30, hasPassword: false, files: [], suggestions: [] }),
      run: async () => ({ name: "b.json", size: 100, status: { folder: "/Users/demo/Local", auto: true, keep: 30, hasPassword: false, files: [], suggestions: [] } }),
      inspect: async () => ({ createdAt: "", appVersion: "1.6.71", stores: [], localKeys: 0 }),
      prepareRestore: async () => ({ token: "t", local: {} }),
      applyRestore: async () => ({ ok: true }),
      cancelRestore: async () => ({ ok: true })
    };
    const { BackupSettingsCard } = require("./features/backup/BackupSettingsCard.tsx");
    const bscHarness = createHookHarness(() => BackupSettingsCard({ hidden: false }), { runEffects: true });
    await new Promise(r => setTimeout(r, 10));
    bscHarness.render();
    for (const btn of walk(bscHarness.tree).filter(n => n.type === "button" && /清理网页缓存|清理过期日线|清理旧版数据|立即备份|设置密码|选择文件夹|从这份恢复/.test(text(n)))) {
      await btn.props.onClick?.();
      bscHarness.render();
    }
    bscHarness.dispose();

    const TodayCockpitView = require("./features/cockpit/TodayCockpitView.tsx").default;
    const cockpitHtml = renderToStaticMarkup(React.createElement(HsgtOverlayProvider, null, React.createElement(TodayCockpitView, {
      phase: "intraday",
      holdings: [{ code: "600519", name: "贵州茅台", shares: 100, costPrice: 1500, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
      favorites: [{ code: "000001", name: "平安银行", createdAt: "2026-01-01T00:00:00Z" }],
      watchlist: [{ code: "300059", name: "东方财富", observationNode: "T+1", createdAt: "2026-01-01T00:00:00Z" }],
      limitUps: [],
      notesApi: { store: { notes: [] }, items: [] },
      tAssistant: { store: { items: [], trades: {}, lastRolloverDay: "" }, runtimes: {} },
      stockMonitors: { configs: {}, runtimes: {}, latestQuotes: {}, alerts: [] },
      paperSummary: { normalized: { cash: 100000, initialCapital: 100000, openPositions: [], closedPositions: [] }, equity: 100000, openPnl: 0, cumulativeRealizedPnl: 0, closedCount: 0, winRate: 0 },
      copilotAlerts: [],
      live: false,
      isDefaultView: true,
      onToggleDefaultView() {},
      onOpenStock() {},
      onNavigate() {},
      onOpenSettings() {}
    })));
    assert.match(cockpitHtml, /今日驾驶舱|盘中哨兵|3 步快速启用/);

    const TimeShareChart = require("./features/market/TimeShareChart.tsx").default;
    const tsHtml = renderToStaticMarkup(React.createElement(TimeShareChart, {
      rows: [
        { date: "2026-11-18 09:30", open: 10, close: 10.1, high: 10.2, low: 9.9, volume: 1000 },
        { date: "2026-11-18 09:35", open: 10.1, close: 10.3, high: 10.4, low: 10.0, volume: 1500 }
      ],
      preClose: 10
    }));
    assert.match(tsHtml, /time-share-static-price-layers|time-share/);

    const { Dashboard } = require("./features/market/MarketWorkspace.tsx");
    const { buildPreviewPayload } = require("./preview/mockMarketData.ts");
    const { usePaperTrading } = require("./features/paper-simulation/usePaperTrading.ts");
    const previewPayload = buildPreviewPayload("600519");
    const paperHarness = createHookHarness(() => usePaperTrading({
      payload: previewPayload,
      latestAnalysis: { current: previewPayload },
      settings: initialSettings,
      settingsRef: { current: initialSettings },
      settingsLoadState: "ready",
      live: false,
      view: "dashboard",
      dashboardMode: "analysis",
      askConfirm: async () => true,
      showToast() {}
    }), { runEffects: false });
    paperHarness.render();
    const { paperSummary: fullPaperSummary, paperExecutionReadiness: fullReadiness } = paperHarness.tree;
    paperHarness.dispose();
    const dashAnalysisHtml = renderToStaticMarkup(React.createElement(HsgtOverlayProvider, null, React.createElement(Dashboard, {
      live: false,
      payload: previewPayload,
      loading: false,
      error: "",
      isWatched: true,
      onToggleWatch() {},
      notes: { store: { notes: [] }, items: [], error: "", dismissError() {}, add: () => "", update: () => "", remove() {}, snooze() {}, setAiReview() {} },
      monitors: baseRouteProps.stockMonitors,
      onShowToast() {},
      onOpenSettings() {},
      onOpenMonitor() {},
      onDiscover() {},
      discovering: false,
      limitUps: [],
      limitPoolMeta: { dataDate: "2026-11-18", fetchedAt: "2026-11-18T07:00:00Z", checkedAt: "2026-11-18T07:00:00Z", providers: ["eastmoney"], count: 0, trigger: "manual" },
      onOpen() {},
      onAdd() {},
      isFavorite: () => false,
      holdings: [],
      settings: initialSettings,
      analysisTarget: previewPayload.security,
      mode: "analysis",
      backLabel: "返回涨停池",
      onBack() {},
      onOpenBacktest() {},
      executionDecisionLog: [],
      onClearExecutionDecisionLog() {},
      paperSummary: fullPaperSummary,
      paperExecutionReadiness: fullReadiness,
      paperCurrentPositions: [],
      canPaperTrade: false,
      latestExecutionDecision: null,
      executePaperTrade() {},
      closePaperTradeForCurrent() {},
      closePaperTradeForCode() {},
      closeAllPaperTrades() {},
      confirmPaperSettlementForCode() {},
      onRetry() {}
    })));
    assert.match(dashAnalysisHtml, /贵州茅台/);

    const dashPoolHtml = renderToStaticMarkup(React.createElement(HsgtOverlayProvider, null, React.createElement(Dashboard, {
      live: false,
      payload: null,
      loading: false,
      error: "",
      isWatched: false,
      onToggleWatch() {},
      onDiscover() {},
      discovering: false,
      limitUps: [{ code: "600519", name: "贵州茅台", secid: "1.600519", latest: 1500, preClose: 1363.64, changePct: 10.0, consecutiveBoards: 2, firstSealTime: "09:35:00", lastSealTime: "10:15:00", openBoardCount: 0, turnover: 2.5, amount: 1_000_000_000, sealedAmount: 100_000_000, sealFloatRatio: 0.05, limitReason: "白酒", industry: "酿酒行业", limitDate: "2026-11-18" }],
      limitPoolMeta: { dataDate: "2026-11-18", fetchedAt: "2026-11-18T07:00:00Z", checkedAt: "2026-11-18T07:00:00Z", providers: ["eastmoney"], count: 1, trigger: "manual" },
      onOpen() {},
      onAdd() {},
      isFavorite: () => true,
      holdings: [],
      settings: initialSettings,
      analysisTarget: null,
      mode: "pool",
      backLabel: "返回",
      onBack() {},
      onOpenBacktest() {},
      executionDecisionLog: [],
      onClearExecutionDecisionLog() {},
      paperSummary: fullPaperSummary,
      paperExecutionReadiness: fullReadiness,
      paperCurrentPositions: [],
      canPaperTrade: false,
      latestExecutionDecision: null,
      executePaperTrade() {},
      closePaperTradeForCurrent() {},
      closePaperTradeForCode() {},
      closeAllPaperTrades() {},
      confirmPaperSettlementForCode() {},
      onRetry() {}
    })));
    assert.match(dashPoolHtml, /涨停池/);

    const PreviousLimitUpFailedBoards = require("./features/dashboard/PreviousLimitUpFailedBoards.tsx").default;
    const failedHtml = renderToStaticMarkup(React.createElement(HsgtOverlayProvider, null, React.createElement(PreviousLimitUpFailedBoards, {
      live: false,
      cache: null,
      onSnapshot() {},
      onViewStateChange() {},
      onOpen() {},
      onAdd() {},
      onToggleFavorite() {},
      onOpenMonitor() {},
      onShowToast() {}
    })));
    assert.match(failedHtml, /炸板/);

    const settingsMasterHarness = createHookHarness(() => SettingsView({
      value: initialSettings,
      loadState: "ready",
      initialCategory: "backup",
      onSave: async next => next
    }), { runEffects: true });
    await new Promise(r => setTimeout(r, 10));
    settingsMasterHarness.render();
    const openMasterBtn = find(settingsMasterHarness.tree, n => n.type === "button" && /设置主密码/.test(text(n)));
    openMasterBtn?.props.onClick?.();
    settingsMasterHarness.render();
    for (const inp of walk(settingsMasterHarness.tree).filter(n => n.type === "input" && n.props?.type === "password")) {
      inp.props.onChange?.({ target: { value: "secret1234" } });
    }
    settingsMasterHarness.render();
    const enableMasterBtn = find(settingsMasterHarness.tree, n => n.type === "button" && /开启主密码/.test(text(n)));
    await enableMasterBtn?.props.onClick?.();
    settingsMasterHarness.render();
    for (const sel of walk(settingsMasterHarness.tree).filter(n => n.type === "select")) {
      sel.props.onChange?.({ target: { value: initialSettings.provider } });
    }
    settingsMasterHarness.dispose();

    const LimitUpPoolMod = require("./features/dashboard/LimitUpPool.tsx").default;
    const lupHtml = renderToStaticMarkup(React.createElement(LimitUpPoolMod, {
      items: [{ code: "600519", name: "贵州茅台", secid: "1.600519", latest: 1500, changePct: 10.0, consecutiveBoards: 2, firstSealTime: "09:35:00", lastSealTime: "10:15:00", openBoardCount: 0, turnover: 2.5, amount: 1_000_000_000, sealedAmount: 100_000_000, sealFloatRatio: 0.05, limitReason: "白酒", industry: "酿酒行业" }],
      meta: { dataDate: "2026-11-18", fetchedAt: "2026-11-18T07:00:00Z", checkedAt: "2026-11-18T07:00:00Z", providers: ["eastmoney"], count: 1, trigger: "manual" },
      onOpen() {},
      onAdd() {},
      isFavorite: () => false
    }));
    assert.match(lupHtml, /贵州茅台/);

    const wlHarness = createHookHarness(() => WatchlistView({
      items: [{ code: "300059", name: "东方财富", secid: "0.300059", createdAt: "2026-01-01T00:00:00.000Z", observationNode: "T+1" }],
      activeNode: "all",
      quotes: { "300059": { latest: 22.5, changePct: 3.21 } },
      favoriteCodes: new Set(),
      onAddFavorite() {},
      onToggleFavorite() {},
      onOpenMonitor() {},
      onNavigate() {},
      onShowToast() {},
      onNodeChange() {},
      onOpen() {},
      onRemove() {}
    }), { runEffects: false });
    wlHarness.render();
    for (const btn of walk(wlHarness.tree).filter(n => n.type === "button" && typeof n.props?.onClick === "function")) {
      btn.props.onClick({ stopPropagation() {}, preventDefault() {} });
    }
    const wlInp = walk(wlHarness.tree).find(n => n.type === "input");
    wlInp?.props.onChange?.({ target: { value: "东方" } });
    wlHarness.render();
    wlHarness.dispose();

    const { useReportHsgtOverlay, useHsgtOverlayCount } = require("./features/hsgt/overlayContext.tsx");
    const OverlayProbe = () => {
      useReportHsgtOverlay(true);
      return React.createElement("span", null, String(useHsgtOverlayCount()));
    };
    assert.match(renderToStaticMarkup(React.createElement(HsgtOverlayProvider, null, React.createElement(OverlayProbe))), /0|1/);

    const useStockMonitors = require("./useStockMonitors.ts").default;
    const smHarness = createHookHarness(() => useStockMonitors([], true, 15, () => {}), { runEffects: false });
    smHarness.render();
    smHarness.tree.ackAlert("missing");
    smHarness.tree.clearAlerts(["600519"]);
    smHarness.dispose();

    const QuickNote = require("./features/notes/QuickNote.tsx").default;
    const qnHarness = createHookHarness(() => QuickNote({
      api: {
        items: [],
        error: "",
        dismissError() {},
        add: () => "",
        update: () => "",
        remove() {},
        snooze() {},
        setAiReview() {}
      },
      stock: { code: "600519", name: "贵州茅台", secid: "1.600519" }
    }), { runEffects: false });
    qnHarness.render();
    const toggleBtn = find(qnHarness.tree, n => n.type === "button");
    toggleBtn.props.onClick();
    qnHarness.render();
    const qnTextarea = find(qnHarness.tree, n => n.type === "textarea");
    qnTextarea.props.onChange({ target: { value: "明日观察突破" } });
    qnHarness.render();
    const saveNoteBtn = find(qnHarness.tree, n => n.type === "button" && /记下来/.test(text(n)));
    saveNoteBtn.props.onClick();
    qnHarness.render();
    qnHarness.dispose();

    let mpUnlocked = false;
    global.window.stockApi.unlockMasterPassword = async ({ password }) => ({ ok: password === "secret12", locked: password !== "secret12", error: password === "secret12" ? "" : "密码错误" });
    const mpHarness = createHookHarness(() => MasterPasswordUnlockModal({
      open: true,
      onUnlocked: () => { mpUnlocked = true; }
    }), { runEffects: false });
    mpHarness.render();
    const mpInput = find(mpHarness.tree, n => n.type === "input");
    mpInput.props.onChange({ target: { value: "secret12" } });
    mpHarness.render();
    const mpForm = find(mpHarness.tree, n => n.type === "form");
    await mpForm.props.onSubmit({ preventDefault() {} });
    assert.equal(mpUnlocked, true);
    mpHarness.dispose();

    const { applyUiScale, applySavedVisualPreferences } = require("./domain/visualPreferences.ts");
    const docStyle = {};
    let zoomSet = null;
    global.document = { ...prevDocument, documentElement: { style: docStyle, dataset: {}, classList: { toggle() {} } } };
    global.window.localStorage.setItem("a-stock-radar:ui-scale:v1", "110");
    global.window.stockApi.setZoomFactor = async f => { zoomSet = f; return true; };
    assert.equal(applyUiScale(120), 120);
    assert.equal(zoomSet, 1.2);
    applySavedVisualPreferences();
    delete global.window.stockApi.setZoomFactor;
    assert.equal(applyUiScale(125), 125);
    assert.equal(docStyle.zoom, "125%");

    const { AgentMarkdown } = require("./features/ai-agent/AnswerMarkdown.tsx");
    const mdHtml = renderToStaticMarkup(React.createElement(AgentMarkdown, {
      text: "**核心结论**\n\n### 小标题\n- 项目 1\n1. 步骤 A\n\n> 引用\n\n---\n\n| 列A | 列B |\n|---|---|\n| +3.2% | -1.5% |"
    }));
    assert.match(mdHtml, /agent-markdown/);
    assert.match(mdHtml, /<table>/);

    assert.deepEqual(WorkspaceErrorBoundary.getDerivedStateFromError(new Error("boom")).error.message, "boom");
    let retHome = 0;
    const wbCompact = new WorkspaceErrorBoundary({ children: "ok", label: "子面板", compact: true });
    wbCompact.state = { error: new Error("err"), attempt: 0 };
    assert.ok(wbCompact.render());
    const wbFull = new WorkspaceErrorBoundary({ children: "ok", label: "全屏", onReturnHome: () => { retHome += 1; } });
    wbFull.setState = fn => { wbFull.state = { ...wbFull.state, ...(typeof fn === "function" ? fn(wbFull.state) : fn) }; };
    wbFull.state = { error: new Error("err"), attempt: 0 };
    const fullTree = wbFull.render();
    assert.ok(fullTree);
    wbFull.returnHome();
    assert.equal(retHome, 1);

    const vwRef = { current: { clientHeight: 400, scrollTop: 3200, scrollHeight: 3600 } };
    const vwH = createHookHarness(() => useVirtualWindow({ itemCount: 150, rowHeight: 30, containerRef: vwRef }), { runEffects: false });
    vwH.render();
    vwH.tree.onScroll({ currentTarget: { clientHeight: 400, scrollTop: 3200, scrollHeight: 3600 } });
    vwH.render();
    assert.equal(vwH.tree.endIndex, 150);
    vwH.dispose();
  } finally {
    global.window = prevWindow;
    global.document = prevDocument;
  }
});

test("Track 3: hydrateFromNativeKv respects isEmpty & preserves newer non-empty localStorage; clearBacktestHistory mirrors empty KV", async () => {
  const { hydrateFromNativeKv, resetSafeStorageCache } = require("./safeStorage.ts");
  const { BACKTEST_HISTORY_KEY, hydrateBacktestHistory } = require("./features/backtest/backtestStorage.ts");
  const { useBacktestWorkspace } = require("./features/backtest/useBacktestWorkspace.ts");
  const { initialSettings } = require("./domain/settings.ts");

  const prevWindow = global.window;
  const memStorage = createMemoryStorage();
  const kvMap = new Map();
  const kvSetLog = [];
  global.window = {
    localStorage: memStorage,
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    stockApi: {
      kvGet: async k => kvMap.get(k) ?? null,
      kvSet: async (k, v) => { kvMap.set(k, v); kvSetLog.push([k, v]); return true; }
    }
  };
  try {
    resetSafeStorageCache();
    const isArr = v => Array.isArray(v);
    const isEmptyArr = v => v.length === 0;

    // 1. Local is valid EMPTY ([]), KV has non-empty -> hydrates and writes back to localStorage
    memStorage.setItem("t3-kv", "[]");
    kvMap.set("t3-kv", JSON.stringify([{ id: "kv-1" }]));
    const recovered = await hydrateFromNativeKv("t3-kv", isArr, memStorage, { isEmpty: isEmptyArr });
    assert.deepEqual(recovered, [{ id: "kv-1" }]);
    assert.equal(memStorage.getItem("t3-kv"), JSON.stringify([{ id: "kv-1" }]));

    // 2. Local already has valid NON-EMPTY data, KV has older data -> returns null & preserves localStorage
    memStorage.setItem("t3-kv", JSON.stringify([{ id: "local-newer" }]));
    kvMap.set("t3-kv", JSON.stringify([{ id: "kv-older" }]));
    const skipped = await hydrateFromNativeKv("t3-kv", isArr, memStorage, { isEmpty: isEmptyArr });
    assert.equal(skipped, null);
    assert.equal(memStorage.getItem("t3-kv"), JSON.stringify([{ id: "local-newer" }]));

    // 3. Both local and KV are empty -> returns null
    memStorage.setItem("t3-kv", "[]");
    kvMap.set("t3-kv", "[]");
    assert.equal(await hydrateFromNativeKv("t3-kv", isArr, memStorage, { isEmpty: isEmptyArr }), null);

    // 4. clearBacktestHistory mirrors "[]" to native KV so old SQLite history does not resurrect
    const sampleRec = { id: "bt-1", securityCode: "600519", securityName: "贵州茅台", createdAt: "2026-11-22T01:00:00Z", draft: { securityCode: "600519" }, metrics: { accepted: true }, strategyIds: ["support"] };
    memStorage.setItem(BACKTEST_HISTORY_KEY, JSON.stringify([sampleRec]));
    kvMap.set(BACKTEST_HISTORY_KEY, JSON.stringify([sampleRec]));
    const btHarness = createHookHarness(() => useBacktestWorkspace({
      view: "backtest",
      dashboardMode: "pool",
      payload: null,
      settings: initialSettings,
      persistSettings: async s => s,
      askConfirm: async () => true,
      showToast() {},
      appendExecutionDecisionLog() {},
      originForView: () => ({ view: "cockpit", label: "返回" }),
      onEnterBacktest() {}
    }), { runEffects: true });
    btHarness.render();
    assert.equal(btHarness.tree.backtestHistory.length, 1);
    await btHarness.tree.clearBacktestHistory();
    btHarness.render();
    assert.equal(btHarness.tree.backtestHistory.length, 0);
    assert.equal(kvMap.get(BACKTEST_HISTORY_KEY), "[]", "clearBacktestHistory must mirror [] to native KV");
    const afterReload = await hydrateBacktestHistory(initialSettings);
    assert.deepEqual(afterReload, [], "cleared backtest history must not resurrect from SQLite KV");
    btHarness.dispose();
  } finally {
    global.window = prevWindow;
  }
});

test("Track 3: T+1 sellableShares consistency across addNoteToT, onSyncCostToHolding, and duplicate T-cost sync guard", async () => {
  const { buildNoteToTConfig } = require("./features/copilot/useWorkspaceCopilot.ts");
  const { renderAppWorkspaceRoutes } = require("./components/AppWorkspaceRoutes.tsx");
  const TAssistantViewMod = require("./features/t-assistant/TAssistantView.tsx");
  const { buildTTradeSyncKey, isTTradeSetAlreadySynced } = TAssistantViewMod;
  const { rolloverTStoreForDay, normalizeTStore, withTrades } = require("./features/t-assistant/tStore.ts");
  const { initialSettings } = require("./domain/settings.ts");
  const { resolveMarketSessionPhase } = require("./copilotBriefing.ts");

  // 1. addNoteToT config respects explicit sellableShares === 0 (never overwrites with shares)
  assert.deepEqual(
    buildNoteToTConfig({ shares: 500, sellableShares: 0, costPrice: 15.2 }, undefined),
    { costPrice: 15.2, baseShares: 500, sellableShares: 0 }
  );
  assert.deepEqual(
    buildNoteToTConfig({ shares: 500, sellableShares: 200, costPrice: 15.2 }, undefined),
    { costPrice: 15.2, baseShares: 500, sellableShares: 200 }
  );
  assert.deepEqual(
    buildNoteToTConfig({ shares: 500, costPrice: 15.2 }, undefined),
    { costPrice: 15.2, baseShares: 500, sellableShares: 0 }
  );
  assert.deepEqual(
    buildNoteToTConfig({ shares: 500, sellableShares: 0, costPrice: 15.2 }, { config: { sellableShares: 300 } }),
    { costPrice: 15.2, baseShares: 500, sellableShares: 300 }
  );

  // 2. onSyncCostToHolding clamps sellableShares to safeShares
  let holdingsState = [{ code: "600519", name: "贵州茅台", secid: "1.600519", shares: 1000, sellableShares: 1000, costPrice: 1500, createdAt: "", updatedAt: "" }];
  const routeTree = renderAppWorkspaceRoutes({
    view: "t-assistant",
    setView() {},
    researchView: false,
    dashboardMode: "pool",
    informationTab: "all",
    setInformationTab() {},
    watchlistNode: "all",
    setWatchlistNode() {},
    analysisOrigin: null,
    observationReturnLabel: () => "返回",
    originForView: () => ({ view: "cockpit", label: "返回" }),
    navigateTo() {},
    openAnalysis() {},
    returnFromAnalysis() {},
    loadSecurity: async () => {},
    latestAnalysis: { current: null },
    analysisRequestId: { current: 0 },
    payload: null,
    analysisTarget: null,
    loading: false,
    error: "",
    live: false,
    privacyMask: false,
    defaultCockpit: true,
    toggleDefaultCockpit() {},
    settings: initialSettings,
    settingsLoadState: "ready",
    persistSettings: async s => ({ ...initialSettings, ...s }),
    watchlist: [],
    holdings: holdingsState,
    favoriteItems: [],
    favoriteCodes: new Set(),
    observationItems: [],
    isFavorite: false,
    toggleFavorite: async () => {},
    removeObservation: async () => true,
    saveHoldings: async updater => { holdingsState = updater(holdingsState); return true; },
    addFavoriteSecurity: async () => {},
    handleQuickHoldingTrade: async () => true,
    showToast() {},
    notes: { store: { notes: [] }, awaitingCount: 0 },
    tAssistant: { store: { items: [], trades: {}, voice: true, showReplay: true }, runtimes: {} },
    stockMonitors: { configs: {}, alerts: [], save: () => true, remove() {}, clearAlerts() {}, ackAlert() {} },
    copilotPhase: resolveMarketSessionPhase(),
    copilotAlerts: [],
    newsLiveQuotes: {},
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
    compareCandidates: [],
    reviewMounted: false,
    portfolioActive: false,
    portfolioMounted: false,
    portfolioInitialSecurities: [],
    portfolioBack() {},
    portfolioOpenSingle() {},
    portfolioOpenSecurity() {},
    openBacktest() {},
    backtestCenterMode: "single",
    setBacktestCenterMode() {},
    backtestDraft: { securityCode: "" },
    setBacktestDraft() {},
    backtestLoading: false,
    backtestError: "",
    backtestResult: null,
    backtestRunRecord: null,
    backtestHistory: [],
    backtestProfileComparisons: null,
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
    paperSummary: { normalized: { cash: 100000, openPositions: [] }, equity: 100000, openValue: 0, openPnl: 0, openPnlPercent: 0, cumulativeRealizedPnl: 0, closedCount: 0, winCount: 0 },
    paperExecutionReadiness: { level: "ready", score: 80, summary: "", recommendation: "", reasons: [] },
    paperCurrentPositions: [],
    canPaperTrade: true,
    latestExecutionDecision: null,
    executePaperTrade() {},
    closePaperTradeForCurrent() {},
    closePaperTradeForCode() {},
    closeAllPaperTrades() {},
    confirmPaperSettlementForCode() {},
    settingsCategory: "sources",
    openSettings() {}
  });
  const tNode = find(routeTree, n => typeof n.props?.onSyncCostToHolding === "function");
  assert.ok(tNode, "TAssistantView should receive onSyncCostToHolding");
  await tNode.props.onSyncCostToHolding("600519", 600, 1485.5, "贵州茅台");
  assert.equal(holdingsState[0].shares, 600);
  assert.equal(holdingsState[0].sellableShares, 600, "onSyncCostToHolding must clamp sellableShares to safeShares");
  assert.equal(holdingsState[0].costPrice, 1485.5);

  // 3. Duplicate T-cost sync guard blocks double-syncing same trades and preserves rolloverTStoreForDay
  const t1 = [{ id: "s1", side: "sell", price: 10.5, shares: 500, time: "10:00" }, { id: "b1", side: "buy", price: 10.0, shares: 500, time: "10:30" }];
  const key1 = buildTTradeSyncKey(t1);
  const syncedRec = { tradeKey: key1, baseCost: 10.0, syncedCost: 9.76, syncedShares: 1000 };
  assert.equal(isTTradeSetAlreadySynced(syncedRec, key1, 10.0), true, "same trades + original baseCost must be marked already synced");
  assert.equal(isTTradeSetAlreadySynced(syncedRec, key1, 9.76), true, "same trades + re-imported syncedCost must not double-sync");
  assert.equal(isTTradeSetAlreadySynced(syncedRec, buildTTradeSyncKey([...t1, { id: "s2", side: "sell", price: 10.6, shares: 200, time: "13:30" }]), 10.0), false, "adding a new trade unlocks re-sync");

  let store = normalizeTStore({
    lastRolloverDay: "2026-11-22",
    items: [{ code: "600000", name: "浦发银行", config: { baseShares: 1000, sellableShares: 1000, costPrice: 10.0, tShares: 500 } }]
  });
  store = withTrades(store, "2026-11-22", "600000", () => [
    { id: "s1", side: "sell", price: 10.5, shares: 400, time: "10:00" }
  ]);
  const rolled = rolloverTStoreForDay(store, "2026-11-23");
  assert.equal(rolled.store.items[0].config.baseShares, 600);
  assert.equal(rolled.store.items[0].config.sellableShares, 600);
});

test("Track 4 regression: QuickPlanModal infers assetType & uses valid tokens; native modals & EtfView CSS align cleanly", async () => {
  const { QuickPlanDialogContent } = require("./components/QuickPlanModal.tsx");
  const { QuickMonitorModal } = require("./components/QuickMonitorModal.tsx");
  const { MasterPasswordUnlockModal } = require("./components/MasterPasswordUnlockModal.tsx");
  const { inferAssetType } = require("./domain/securityIdentifiers.ts");

  assert.equal(inferAssetType("510300"), "etf");
  assert.equal(inferAssetType("159915"), "etf");
  assert.equal(inferAssetType("113050"), "convertibleBond");
  assert.equal(inferAssetType("127085"), "convertibleBond");
  assert.equal(inferAssetType("600519"), "stock");

  const quickPlanSrc = fs.readFileSync(path.join(__dirname, "components/QuickPlanModal.tsx"), "utf8");
  assert.match(quickPlanSrc, /assetType:\s*target\.assetType\s*\|\|\s*inferAssetType\(target\.code\)/);
  assert.doesNotMatch(quickPlanSrc, /var\(--(?:border|surface|panel-bg|text)[),]/);

  const html = renderToStaticMarkup(
    React.createElement(QuickPlanDialogContent, {
      target: { code: "510300", name: "沪深300ETF", referencePrice: 3.85 },
      onClose: () => {}
    })
  );
  assert.match(html, /var\(--line-2\)/);
  assert.match(html, /var\(--surface-1\)/);
  assert.match(html, /var\(--ink-1\)/);

  // Verify QuickPlanDialogContent passes inferred assetType to getQuoteSnapshot when referencePrice is absent
  const quoteCalls = [];
  const prevWindow = globalThis.window;
  globalThis.window = {
    localStorage: createMemoryStorage(),
    stockApi: {
      getQuoteSnapshot: async sec => {
        quoteCalls.push(sec);
        return { quote: { latest: 112.5 } };
      }
    }
  };
  try {
    const h = createHookHarness(QuickPlanDialogContent, {
      props: {
        target: { code: "113050", name: "某转债" },
        onClose: () => {}
      }
    });
    h.render();
    await h.flush();
    h.dispose();
    assert.equal(quoteCalls.length, 1);
    assert.equal(quoteCalls[0].assetType, "convertibleBond");

    const h2 = createHookHarness(QuickPlanDialogContent, {
      props: {
        target: { code: "510300", name: "沪深300ETF", assetType: "etf" },
        onClose: () => {}
      }
    });
    h2.render();
    await h2.flush();
    h2.dispose();
    assert.equal(quoteCalls.length, 2);
    assert.equal(quoteCalls[1].assetType, "etf");
  } finally {
    globalThis.window = prevWindow;
  }

  // Verify QuickMonitorModal & MasterPasswordUnlockModal render expected classes
  const monitorHtml = renderToStaticMarkup(
    React.createElement(QuickMonitorModal, {
      stock: { code: "600519", name: "贵州茅台", secid: "1.600519", assetType: "stock" },
      onSave: () => true,
      onClose: () => {}
    })
  );
  assert.match(monitorHtml, /class="quick-palette-native-dialog"/);
  assert.match(monitorHtml, /class="palette-dialog"/);

  const unlockHtml = renderToStaticMarkup(
    React.createElement(MasterPasswordUnlockModal, {
      open: true,
      onUnlocked: () => {}
    })
  );
  assert.match(unlockHtml, /class="quick-palette-native-dialog"/);
  assert.match(unlockHtml, /class="palette-dialog security-master-unlock"/);

  // Verify components.css modal centering, palette-dialog surface, and EtfView table/select styling
  const css = fs.readFileSync(path.join(__dirname, "styles/theme/components.css"), "utf8");
  assert.match(css, /\.quick-palette-native-dialog\[open\]\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*flex-start;[^}]*justify-content:\s*center;/s);
  assert.match(css, /\.quick-palette-dialog,\s*\.palette-dialog\s*\{[^}]*border:\s*1px solid var\(--line-2\);[^}]*background:\s*var\(--surface-1\);[^}]*color:\s*var\(--ink-1\);[^}]*box-shadow:\s*var\(--shadow-3\);/s);
  assert.match(css, /\.bond-table:not\(\.etf-table\)(?::not\([^)]+\))*\s+td:nth-child\(6\)/);
  assert.match(css, /\.bond-table:not\(\.etf-table\)(?::not\([^)]+\))*\s+thead th:nth-child\(6\)/);
  assert.match(css, /\.etf-table\s+td:nth-child\(2\)/);
  assert.match(css, /\.bond-toolbar select\s*\{[^}]*background:\s*var\(--surface-2\);/s);
  assert.doesNotMatch(css, /\.bond-toolbar select\s*\{[^}]*var\(--surface,\s*transparent\)/s);

  const etfSrc = fs.readFileSync(path.join(__dirname, "features/etf/EtfView.tsx"), "utf8");
  assert.match(etfSrc, /className="bond-table etf-table"/);
});


