import { usePaperTrading } from "./features/paper-simulation/usePaperTrading";
import { useBacktestWorkspace } from "./features/backtest/useBacktestWorkspace";
import { LoadingState } from "./components/terminal/TerminalPrimitives";
import { computeExecutionProjection } from "./domain/executionProjection";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { ConfirmDialog, type ConfirmDialogRequest } from "./components/terminal/ConfirmDialog";
import { informationTabs, resolveInformationCenterRoute, type InformationTab } from "./features/information/informationModel";
import type { AnalysisPayload } from "./features/market/analysisTypes";
import { useMarketWorkspaceFeed } from "./features/market/useMarketWorkspaceFeed";
import { useWorkspaceCopilot } from "./features/copilot/useWorkspaceCopilot";
import { renderAppHeaderBar } from "./components/AppHeaderBar";
import { renderAppWorkspaceRoutes, type AnalysisOrigin } from "./components/AppWorkspaceRoutes";
import type { WorkspaceView as View } from "./workspaceView";
import { simpleAnalysisOrigin } from "./workspaceExperience";
import type { PaperClosedPosition } from "./domain/paperSimulationTypes";
import type {
  ExecutionDecisionLog, ExecutionDecisionResult, ExecutionDecisionSource,
  PaperSimulationState, PaperStrategyGovernance, PaperStrategyStage, PaperTradeAction
} from "./features/paper-simulation/paperSimulationTypes";
import { buildBacktestHistoryRecord, loadBacktestHistory } from "./features/backtest/backtestStorage";
import { buildExecutionDecisionLogEntry, loadExecutionDecisionLog, loadPaperState } from "./features/paper-simulation/paperSimulationPersistence";
import { normalizePaperState, settlePaperPosition } from "./features/paper-simulation/paperSimulationState";
import {
  advancePaperSimulationByQuote, closePaperAllSimulationByCode, closePaperSimulationByCode,
  evaluatePaperExecutionReadiness, evaluatePaperKillSwitch, evaluatePaperStrategyGovernance,
  getPaperDailyTradeSignal, getPaperLossStreakState, getPaperSectorExposurePercent,
  getPaperSectorExposureValue, mergeReasonArrays, openPaperPositionFromSignal
} from "./features/paper-simulation/paperSimulationEngine";
export { resolveInformationCenterRoute };
import {
  Activity,
  BarChart3,
  BookOpenCheck,
  Bookmark,
  CircleAlert,
  Layers3,
  LayoutDashboard,
  Landmark,
  Coins,
  ArrowLeftRight,
  ArrowDownUp,
  NotebookPen,
  Bot,
  LineChart,
  MessagesSquare,
  Newspaper,
  Radar,
  ShieldCheck,
  Star,
  TrendingUp,
  WalletCards,
  X
} from "lucide-react";
import { type ComponentProps, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerAgentOpener } from "./features/ai-agent/agentModel";
import { useWorkspaceCollections } from "./features/collections/useWorkspaceCollections";
import { useAutoBackup } from "./features/backup/backupClient";
import { NoteReminderStack } from "./features/notes/NoteReminderStack";
import { WorkspaceErrorBoundary } from "./components/AppErrorBoundary";
import WorkspaceNavigation from "./components/WorkspaceNavigation";
import { QuickMonitorModal } from "./components/QuickMonitorModal";
import { MasterPasswordUnlockModal } from "./components/MasterPasswordUnlockModal";
import { useReportHsgtOverlay } from "./features/hsgt/overlayContext";
import { applySavedVisualPreferences, applyUiScale, normalizeSettingsCategory, normalizeUiScale, stepUiScale, UI_SCALE_STORAGE_KEY } from "./domain/visualPreferences";
import { initialSettings, normalizeSettings } from "./domain/settings";
import { saveSafeLocalJson } from "./safeStorage";
import { isUsableSecurityCollection, uniqueSecurities } from "./securitySelection";

export {
  advancePaperSimulationByQuote, buildBacktestHistoryRecord, buildExecutionDecisionLogEntry,
  closePaperSimulationByCode, evaluatePaperExecutionReadiness, evaluatePaperKillSwitch,
  evaluatePaperStrategyGovernance, getPaperDailyTradeSignal, getPaperLossStreakState,
  getPaperSectorExposurePercent, getPaperSectorExposureValue, loadBacktestHistory,
  loadExecutionDecisionLog, loadPaperState, mergeReasonArrays, normalizePaperState,
  openPaperPositionFromSignal, settlePaperPosition
};
export type {
  ExecutionDecisionLog, ExecutionDecisionResult, ExecutionDecisionSource,
  PaperSimulationState, PaperStrategyGovernance, PaperStrategyStage, PaperTradeAction
};

/**
 * B2-01：「一键平掉所有当前标的」的真实入口。
 *
 * 组件内的 closeAllPaperTrades 只负责 commit + toast，平仓逻辑收敛到这里，
 * 这样在没有 DOM 的 node 测试里也能直接断言“多只持仓全部进入已平仓”（本仓库测试用
 * react-dom/server + 纯函数断言，没有 jsdom/testing-library，无法派发真实点击）。
 * 使用的是引擎里既有的全平实现，含 T+1 / 跌停等卖出阻断保护。
 */
export const closeAllPaperTradesAction = (
  state: PaperSimulationState,
  reason: PaperClosedPosition["closeReason"] = "MANUAL",
  settings: Settings = initialSettings
) => closePaperAllSimulationByCode(state, reason, normalizeSettings(settings));

const LazyNewsView = lazy(() => import("./features/information/NewsView").then(module => ({ default: module.NewsView })));
const QuickPaletteModal = lazy(() => import("./components/terminal/QuickPaletteModal"));
const LazyFavoritesView = lazy(() => import("./features/collections/CollectionViews").then(module => ({ default: module.FavoritesView })));
const LazyWatchlistView = lazy(() => import("./features/collections/CollectionViews").then(module => ({ default: module.WatchlistView })));

export function FavoritesView(props: ComponentProps<typeof LazyFavoritesView>) {
  return <Suspense fallback={<LoadingState />}><LazyFavoritesView {...props} /></Suspense>;
}

export function WatchlistView(props: ComponentProps<typeof LazyWatchlistView>) {
  return <Suspense fallback={<LoadingState />}><LazyWatchlistView {...props} /></Suspense>;
}

export function NewsView(props: ComponentProps<typeof LazyNewsView>) {
  return <Suspense fallback={<LoadingState />}><LazyNewsView {...props} /></Suspense>;
}

const observationReturnLabel = (node: string) =>
  node === "all" ? "返回全部十日观察池" : `返回 ${node} 观察池`;

export { computeExecutionProjection };

const DEFAULT_VIEW_STORAGE_KEY = "a-stock-radar:default-view";
const PRIVACY_MASK_STORAGE_KEY = "a-stock-radar:privacy-mask:v1";
const SIDEBAR_CORE_ONLY_KEY = "a-stock-radar:sidebar-core-only:v1";

function App() {
  const [defaultCockpit, setDefaultCockpit] = useState<boolean>(() => {
    try {
      return typeof window === "undefined" || window.localStorage?.getItem(DEFAULT_VIEW_STORAGE_KEY) !== "signals";
    } catch {
      return true;
    }
  });
  const [view, setView] = useState<View>(() => (
    typeof window !== "undefined" && window.localStorage?.getItem(DEFAULT_VIEW_STORAGE_KEY) === "signals"
      ? "signals"
      : "cockpit"
  ));
  const [privacyMask, setPrivacyMask] = useState<boolean>(() => {
    try {
      return typeof window !== "undefined" && window.localStorage?.getItem(PRIVACY_MASK_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const privacyMaskRef = useRef(privacyMask);
  privacyMaskRef.current = privacyMask;
  const [sidebarCoreOnly, setSidebarCoreOnly] = useState<boolean>(() => {
    try {
      return typeof window === "undefined" || window.localStorage?.getItem(SIDEBAR_CORE_ONLY_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const sidebarCoreOnlyRef = useRef(sidebarCoreOnly);
  sidebarCoreOnlyRef.current = sidebarCoreOnly;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [masterLocked, setMasterLocked] = useState(false);
  const [quickMonitorTarget, setQuickMonitorTarget] = useState<Security | null>(null);
  const [settingsCategory, setSettingsCategory] = useState("sources");
  const [settingsRequestSeq, setSettingsRequestSeq] = useState(0);
  const [isOffline, setIsOffline] = useState<boolean>(() => typeof navigator !== "undefined" && navigator.onLine === false);
  const reconnectRefreshRef = useRef<() => void>(() => {});

  type ToastEntry = { id: number; text: string; tone: "info" | "warn" | "error"; durationMs: number; expiresAt: number };
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const toastHoverAtRef = useRef<number | null>(null);
  const toastTimersRef = useRef<Map<number, number>>(new Map());
  const toastSeqRef = useRef(0);
  const dismissToast = useCallback((id: number) => {
    const timer = toastTimersRef.current.get(id);
    if (timer !== undefined && typeof window !== "undefined") window.clearTimeout(timer);
    toastTimersRef.current.delete(id);
    setToasts(current => current.filter(item => item.id !== id));
  }, []);
  const showToast = useCallback((message: string) => {
    const text = String(message || "").trim();
    if (!text) return;
    const tone: ToastEntry["tone"] = /失败|错误|异常|无效|不能|拒绝|受限|不可用|超限/.test(text)
      ? "error"
      : /注意|提示|警告|暂停|脱敏|已关闭/.test(text)
        ? "warn"
        : "info";
    const durationMs = tone === "error" ? 5600 : tone === "warn" ? 3800 : 2600;
    const id = ++toastSeqRef.current;
    const now = Date.now();
    setToasts(current => [
      ...current.filter(item => item.text !== text).slice(-2),
      { id, text, tone, durationMs, expiresAt: now + durationMs }
    ]);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!toasts.length) {
      toastHoverAtRef.current = null;
      toastTimersRef.current.forEach(t => window.clearTimeout(t));
      toastTimersRef.current.clear();
      return undefined;
    }
    const activeIds = new Set(toasts.map(item => item.id));
    for (const [id, timer] of toastTimersRef.current.entries()) {
      if (!activeIds.has(id)) {
        window.clearTimeout(timer);
        toastTimersRef.current.delete(id);
      }
    }
    if (toastHoverAtRef.current !== null) return undefined;
    const now = Date.now();
    for (const item of toasts) {
      if (toastTimersRef.current.has(item.id)) continue;
      const delay = Math.max(400, item.expiresAt - now);
      const timer = window.setTimeout(() => {
        toastTimersRef.current.delete(item.id);
        setToasts(current => current.filter(entry => entry.id !== item.id));
      }, delay);
      toastTimersRef.current.set(item.id, timer);
    }
    return undefined;
  }, [toasts]);
  useEffect(() => () => {
    if (typeof window !== "undefined") {
      toastTimersRef.current.forEach(t => window.clearTimeout(t));
      toastTimersRef.current.clear();
    }
  }, []);

  const openSettings = useCallback((category = "sources") => {
    setSettingsCategory(normalizeSettingsCategory(category));
    setSettingsRequestSeq(seq => seq + 1);
    setView("settings");
  }, []);
  if (typeof window !== "undefined") {
    window.__aStockOpenSettings = openSettings;
  }

  useEffect(() => {
    applySavedVisualPreferences();
    if (typeof window !== "undefined" && typeof window.stockApi?.getMasterPasswordStatus === "function") {
      void window.stockApi.getMasterPasswordStatus().then(status => {
        if (status?.enabled && status.locked) setMasterLocked(true);
      }).catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    window.__aStockOpenSettings = openSettings;
    const onOffline = () => setIsOffline(true);
    const onOnline = () => {
      setIsOffline(false);
      void window.stockApi?.resetMarketSourceHealth?.().catch(() => undefined);
      reconnectRefreshRef.current();
    };
    if (typeof window.addEventListener === "function") {
      window.addEventListener("offline", onOffline);
      window.addEventListener("online", onOnline);
    }
    const disposeNotificationClick = typeof window.stockApi?.onNotificationClick === "function"
      ? window.stockApi.onNotificationClick((clicked) => {
          if (clicked?.code && /^\d{6}$/.test(clicked.code)) {
            openAnalysisRef.current(
              {
                code: clicked.code,
                name: clicked.name || clicked.code,
                secid: clicked.secid || ""
              },
              { view: "cockpit", label: "返回今日驾驶舱" }
            );
            return;
          }
          if (clicked?.targetView) setView(clicked.targetView as View);
        })
      : undefined;
    return () => {
      delete window.__aStockOpenSettings;
      disposeNotificationClick?.();
      if (typeof window.removeEventListener === "function") {
        window.removeEventListener("offline", onOffline);
        window.removeEventListener("online", onOnline);
      }
    };
  }, [openSettings]);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const onGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setPaletteOpen(current => !current);
        return;
      }
      if (key === "=" || key === "+") {
        event.preventDefault();
        const currentScale = normalizeUiScale(window.localStorage?.getItem(UI_SCALE_STORAGE_KEY));
        const nextScale = applyUiScale(stepUiScale(currentScale, 1));
        try { window.localStorage?.setItem(UI_SCALE_STORAGE_KEY, String(nextScale)); } catch { /* ignore */ }
        showToast(`界面缩放已调整至 ${nextScale}%`);
        return;
      }
      if (key === "-" || key === "_") {
        event.preventDefault();
        const currentScale = normalizeUiScale(window.localStorage?.getItem(UI_SCALE_STORAGE_KEY));
        const nextScale = applyUiScale(stepUiScale(currentScale, -1));
        try { window.localStorage?.setItem(UI_SCALE_STORAGE_KEY, String(nextScale)); } catch { /* ignore */ }
        showToast(`界面缩放已调整至 ${nextScale}%`);
        return;
      }
      if (key === "0") {
        event.preventDefault();
        applyUiScale(100);
        try { window.localStorage?.setItem(UI_SCALE_STORAGE_KEY, "100"); } catch { /* ignore */ }
        showToast("界面缩放已恢复 100%");
      }
    };
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => {
      if (typeof window.removeEventListener === "function") {
        window.removeEventListener("keydown", onGlobalKeyDown);
      }
    };
  }, [showToast]);

  const togglePrivacyMask = useCallback(() => {
    const next = !privacyMaskRef.current;
    privacyMaskRef.current = next;
    setPrivacyMask(next);
    try {
      window.localStorage?.setItem(PRIVACY_MASK_STORAGE_KEY, next ? "true" : "false");
    } catch {
      // ignore localStorage restrictions
    }
    showToast(next ? "已开启金额隐私脱敏（持仓数与盈亏金额显示为 ***）" : "已关闭隐私脱敏，恢复完整金额显示");
  }, [showToast]);

  const toggleSidebarCoreOnly = useCallback(() => {
    const next = !sidebarCoreOnlyRef.current;
    sidebarCoreOnlyRef.current = next;
    setSidebarCoreOnly(next);
    try {
      window.localStorage?.setItem(SIDEBAR_CORE_ONLY_KEY, next ? "true" : "false");
    } catch {
      // ignore localStorage restrictions
    }
    showToast(next ? "侧边栏已精简为核心高频模块（可随时点★恢复全部）" : "侧边栏已恢复显示全部工作区");
  }, [showToast]);

  const toggleDefaultCockpit = useCallback((enabled: boolean) => {
    setDefaultCockpit(enabled);
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        if (enabled) window.localStorage.setItem(DEFAULT_VIEW_STORAGE_KEY, "cockpit");
        else window.localStorage.setItem(DEFAULT_VIEW_STORAGE_KEY, "signals");
      }
    } catch {
      // ignore localStorage restrictions
    }
    showToast(enabled ? "已将「今日驾驶舱」设为默认启动页" : "已切换默认启动页为「策略选股」");
  }, [showToast]);

  // 策略选股（含旧「涨停趋势」路由）是研究页：不启动行情轮询与旧版市场工具。
  const researchView = view === "signals" || view === "trend-screener";
  const [informationTab, setInformationTab] = useState<InformationTab>("all");
  const [dashboardMode, setDashboardMode] = useState<"pool" | "analysis">("pool");
  const [watchlistNode, setWatchlistNode] = useState("all");
  const [analysisOrigin, setAnalysisOrigin] = useState<AnalysisOrigin | null>(null);
  // 个股页「AI 问股深入分析」：带上股票打开 AI 问股（只在主窗口注册，复盘独立窗口里不显示这个按钮）。
  useEffect(() => {
    registerAgentOpener(() => { setAnalysisOrigin(null); setView("ai-agent"); });
    return () => registerAgentOpener(null);
  }, []);

  const [payload, setPayload] = useState<AnalysisPayload | null>(null);
  const latestAnalysis = useRef(payload);
  latestAnalysis.current = payload;
  const analysisRequestId = useRef(0);

  const [confirmRequest, setConfirmRequest] = useState<ConfirmDialogRequest | null>(null);
  // 关闭的是「某一次故障」的提示：记录被关闭的故障 key，新故障出现时会重新提示。
  const [providerBannerDismissed, setProviderBannerDismissed] = useState("");
  const confirmResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const askConfirm = useCallback((request: ConfirmDialogRequest): Promise<boolean> => {
    // 同时只保留一个挂起确认：旧请求以「取消」结束，避免 Promise 永久悬空。
    confirmResolver.current?.(false);
    return new Promise<boolean>(resolve => {
      confirmResolver.current = resolve;
      setConfirmRequest(request);
    });
  }, []);
  const resolveConfirm = useCallback((confirmed: boolean) => {
    setConfirmRequest(null);
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    resolve?.(confirmed);
  }, []);

  const [live, setLive] = useState(true);
  const effectiveLive = live && !isOffline;
  // matchMedia is absent in some embedded/test renderers; default to an expanded navigation there.
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1280px)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 1280px)");
    const onWidthChange = () => setNavigationCollapsed(media.matches);
    media.addEventListener("change", onWidthChange);
    return () => media.removeEventListener("change", onWidthChange);
  }, []);
  const [reviewMounted, setReviewMounted] = useState(false);

  const {
    watchlist,
    holdings,
    settings,
    settingsRef,
    settingsLoadState,
    version,
    persistSettings,
    setThemeMode,
    mergeWatchlistObservations,
    observationItems,
    favoriteItems,
    favoriteCodes,
    isFavorite,
    toggleFavorite,
    removeObservation,
    saveHoldings,
    addFavoriteSecurity,
    addFavoriteSecurities,
    handleQuickHoldingTrade
  } = useWorkspaceCollections({
    payload,
    showToast
  });

  const originForView = (sourceView: View = view): AnalysisOrigin => {
    if (sourceView === "watchlist") {
      return {
        view: "watchlist",
        node: watchlistNode,
        label: observationReturnLabel(watchlistNode)
      };
    }
    if (sourceView === "news" || sourceView === "announcements") {
      const route = resolveInformationCenterRoute(sourceView, informationTab);
      return { ...route, label: `返回资讯中心 · ${informationTabs.find(tab => tab.id === route.informationTab)?.label}` };
    }
    const simple = simpleAnalysisOrigin(sourceView);
    if (simple) return simple;
    return { view: "dashboard", label: "返回涨停池" };
  };

  const {
    paperActionSaveError,
    paperSnapshotSaveError,
    retryPaperSave,
    executionDecisionLog,
    appendExecutionDecisionLog,
    clearExecutionDecisionLog,
    syncPaperQuote,
    paperSummary,
    paperCurrentPositions,
    paperExecutionReadiness,
    latestExecutionDecision,
    canPaperTrade,
    executePaperTrade,
    closePaperTradeForCode,
    closePaperTradeForCurrent,
    closeAllPaperTrades,
    confirmPaperSettlementForCode,
    refreshPaperPositions
  } = usePaperTrading({
    payload,
    latestAnalysis,
    settings,
    settingsRef,
    settingsLoadState,
    live: effectiveLive,
    view,
    dashboardMode,
    askConfirm,
    showToast
  });

  const openAnalysisRef = useRef<(security: Security | string, origin?: AnalysisOrigin | null, queue?: Security[]) => void>(() => {});
  const marketFeed = useMarketWorkspaceFeed({
    view,
    dashboardMode,
    researchView,
    live: effectiveLive,
    payload,
    setPayload,
    latestAnalysis,
    analysisRequestId,
    settings,
    settingsRef,
    settingsLoadState,
    onPaperQuoteSync: syncPaperQuote,
    onMergeWatchlistObservations: mergeWatchlistObservations,
    onOpenSecurity: security => openAnalysisRef.current(security),
    showToast
  });

  const {
    query,
    setQuery,
    suggestions,
    setSuggestions,
    searchBoxRef,
    searchComposing,
    setSearchComposing,
    searchComposingRef,
    searchEditVersion,
    searchTimer,
    searchRequestId,
    analysisTarget,
    loading,
    searching,
    setSearching,
    searchError,
    setSearchError,
    searchComplete,
    setSearchComplete,
    error,
    sourceHealth,
    limitUps,
    limitPoolMeta,
    failedBoardCache,
    failedBoardViewState,
    rememberFailedBoardCache,
    rememberFailedBoardViewState,
    discovering,
    sectorLegacyOpen,
    setSectorLegacyOpen,
    sectorBoard,
    sectorBoardLoading,
    sectorBoardError,
    setSectorBoardError,
    sectorExtra,
    loadSecurity,
    fetchSecuritySuggestions,
    loadSectorBoard,
    handleSearch,
    discover
  } = marketFeed;

  const [analysisQueue, setAnalysisQueue] = useState<Security[]>([]);
  const scrollPositionsRef = useRef<Partial<Record<View, number>>>({});
  const pendingRestoreScrollRef = useRef<{ view: View; top: number } | null>(null);

  const openAnalysis = (security: Security | string, origin?: AnalysisOrigin | null, queue?: Security[]) => {
    if (typeof document !== "undefined" && view !== "dashboard") {
      const pageEl = document.querySelector<HTMLElement>(".page");
      if (pageEl) scrollPositionsRef.current[view] = pageEl.scrollTop;
    }
    if (Array.isArray(queue) && queue.length > 0) setAnalysisQueue(queue);
    else if (view !== "dashboard" || dashboardMode !== "analysis") setAnalysisQueue([]);
    setAnalysisOrigin(origin || (view === "dashboard" && dashboardMode === "analysis" ? analysisOrigin : null) || originForView());
    setDashboardMode("analysis");
    setView("dashboard");
    void loadSecurity(security);
  };
  openAnalysisRef.current = openAnalysis;
  reconnectRefreshRef.current = () => {
    void discover();
    if (latestAnalysis.current?.security) void loadSecurity(latestAnalysis.current.security, true, true);
  };

  const navigateTo = (next: View) => {
    if (next === "sectors" && view !== "sectors") setSectorBoardError("");
    if (next === "settings") {
      setSettingsCategory("sources");
      setSettingsRequestSeq(seq => seq + 1);
    }
    if (next === "news" || next === "announcements") {
      const route = resolveInformationCenterRoute(next, informationTab);
      setInformationTab(route.informationTab);
      setView(route.view);
    } else setView(next);
    setAnalysisOrigin(null);
    setAnalysisQueue([]);
    if (next === "dashboard") setDashboardMode("pool");
  };

  const returnFromAnalysis = () => {
    const targetView = analysisOrigin?.view || "dashboard";
    const savedScroll = scrollPositionsRef.current[targetView];
    if (typeof savedScroll === "number" && savedScroll > 0) {
      pendingRestoreScrollRef.current = { view: targetView, top: savedScroll };
    }
    if (analysisOrigin) {
      if (analysisOrigin.node) setWatchlistNode(analysisOrigin.node);
      if (analysisOrigin.view === "news" || analysisOrigin.view === "announcements") {
        const route = resolveInformationCenterRoute(analysisOrigin.view, analysisOrigin.informationTab);
        setInformationTab(route.informationTab);
        setView(route.view);
      } else setView(analysisOrigin.view);
      if (analysisOrigin.view === "dashboard") {
        setDashboardMode(analysisOrigin.dashboardMode || backtestReturnMode);
      }
    } else {
      setDashboardMode("pool");
      setView("dashboard");
    }
    setAnalysisOrigin(null);
    setAnalysisQueue([]);
  };

  const {
    backtestReturnMode,
    backtestCenterMode,
    setBacktestCenterMode,
    portfolioMounted,
    portfolioActive,
    backtestDraft,
    setBacktestDraft,
    backtestLoading,
    backtestError,
    backtestResult,
    backtestRunRecord,
    backtestHistory,
    backtestProfileComparisons,
    backtestEntryContext,
    portfolioInitialSecurities,
    invalidateBacktests,
    runBacktest,
    runBacktestProfileComparisons,
    exportBacktestPayload,
    applyBacktestProfileWithGovernance,
    clearBacktestHistory,
    applyCurrentBacktestToPaper,
    exportCurrentBacktest,
    applyHistoryToSettings,
    loadBacktestRecord,
    openBacktest,
    updateBacktestTargetContext
  } = useBacktestWorkspace({
    view,
    dashboardMode,
    payload,
    settings,
    persistSettings,
    askConfirm,
    showToast,
    appendExecutionDecisionLog,
    originForView,
    onEnterBacktest: (origin) => {
      setAnalysisOrigin(origin);
      setView("backtest");
    }
  });

  const copilot = useWorkspaceCopilot({
    view,
    live: effectiveLive,
    payload,
    holdings,
    favoriteItems,
    favoriteCodes,
    paperSummary,
    settings,
    settingsRef,
    settingsLoadState,
    persistSettings,
    sourceHealth,
    addFavoriteSecurity,
    showToast,
    onOpenStock: (security, originView, label) => openAnalysis(
      security,
      originView ? (label ? { view: originView, label } : originForView(originView)) : originForView(view)
    ),
    onNavigateView: next => next === "backtest" ? openBacktest() : navigateTo(next)
  });
  const {
    stockMonitors,
    tAssistant,
    notes,
    toggleNewsVoice,
    launchStripDismissed,
    setLaunchStripDismissed,
    launchArchive,
    sourceNotice,
    copilotOpen,
    setCopilotOpen,
    copilotRef,
    copilotPhase,
    copilotAlerts,
    clearAllCopilotAlerts,
    newsLiveQuotes,
    addNoteToT,
    addNoteToMonitor,
    handleCopilotSelect
  } = copilot;

  useReportHsgtOverlay(paletteOpen || copilotOpen || Boolean(confirmRequest) || Boolean(quickMonitorTarget) || masterLocked);

  useAutoBackup(message => showToast(message));

  useEffect(() => {
    const mode = settings.theme || "system";
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = mode;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    if (mode === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);

  useEffect(() => {
    if (view === "review") setReviewMounted(true);
  }, [view]);

  useEffect(() => {
    const pageEl = document.querySelector<HTMLElement>(".page");
    if (!pageEl) return;
    const pending = pendingRestoreScrollRef.current;
    if (pending && pending.view === view) {
      pendingRestoreScrollRef.current = null;
      pageEl.scrollTo({ top: pending.top, behavior: "auto" });
      return;
    }
    pendingRestoreScrollRef.current = null;
    pageEl.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

  const compareCandidates = useMemo(() => {
    const merged = new Map<string, Security>();
    const add = (item: Record<string, unknown>) => {
      const code = String(item?.code || "");
      if (!/^\d{6}$/.test(code) || merged.has(code)) return;
      merged.set(code, {
        code,
        name: String(item?.name || code),
        secid: String(item?.secid || ""),
        ...(typeof item?.thscode === "string" ? { thscode: item.thscode } : {}),
        ...(typeof item?.marketName === "string" ? { marketName: item.marketName } : {}),
        ...(item?.assetType === "convertibleBond" || item?.assetType === "etf" || item?.assetType === "stock"
          ? { assetType: item.assetType }
          : {})
      });
    };
    if (payload?.security) add(payload.security);
    limitUps.forEach(add);
    holdings.forEach(add);
    favoriteItems.forEach(add);
    observationItems.forEach(add);
    return [...merged.values()];
  }, [payload?.security, limitUps, holdings, favoriteItems, observationItems]);

  const navItems = [
    { id: "cockpit" as View, label: "今日驾驶舱", icon: Radar },
    { id: "dashboard" as View, label: "涨停监控", icon: LayoutDashboard },
    { id: "t-assistant" as View, label: "做T助手", icon: ArrowDownUp },
    { id: "previous-limit-up-failed" as View, label: "炸板观察", icon: Activity },
    { id: "favorites" as View, label: "自选监控", icon: Star },
    { id: "holdings" as View, label: "持仓股", icon: WalletCards },
    { id: "watchlist" as View, label: "观察池", icon: Bookmark },
    { id: "sectors" as View, label: "板块强度", icon: Layers3 },
    { id: "beijing" as View, label: "北交所", icon: Landmark },
    { id: "bonds" as View, label: "可转债", icon: Coins },
    { id: "hsgt" as View, label: "沪深港通", icon: ArrowLeftRight },
    { id: "news" as View, label: "资讯中心", icon: Newspaper },
    { id: "notes" as View, label: "随心记", icon: NotebookPen },
    { id: "signals" as View, label: "策略选股", icon: TrendingUp },
    { id: "ai-picks" as View, label: "AI 选股", icon: Bot },
    { id: "ai-agent" as View, label: "AI 问股", icon: MessagesSquare },
    { id: "compare" as View, label: "多股同列", icon: BarChart3 },
    { id: "review" as View, label: "专业复盘", icon: BookOpenCheck },
    { id: "backtest" as View, label: "回测中心", icon: LineChart }
  ];

  const providerLabel = (provider: unknown) => {
    if (provider === "ths") return "同花顺";
    if (provider === "fuyao") return "同花顺扶摇行情";
    if (provider === "ths_free") return "同花顺免费行情";
    if (provider === "eastmoney") return "东方财富";
    if (provider === "tencent") return "腾讯行情";
    if (provider === "sina") return "新浪行情";
    return "公开行情接力";
  };
  const requestedProviderLabel = providerLabel(settings.provider);
  const actualProviderLabel = payload?.actualProvider
    ? providerLabel(payload.actualProvider)
    : requestedProviderLabel;
  const marketDegraded = Boolean(error && !payload && !limitUps.length);
  const marketStatus = !live
    ? "实时刷新已暂停"
    : marketDegraded
      ? "行情连接待恢复"
      : researchView
        ? "收盘快照选股就绪"
        : "行情监控运行中";
  const marketStatusDetail = payload?.updatedAt
    ? `当前 ${actualProviderLabel} · ${new Date(payload.updatedAt).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`
    : `主线 ${requestedProviderLabel} · 涨停池 ${limitUps.length} 只`;

  // 组合回测视图的回调与入参保持引用稳定，配合 memo 避免轮询时整页重渲染。
  const navigationRef = useRef({ openAnalysis, returnFromAnalysis });
  navigationRef.current = { openAnalysis, returnFromAnalysis };
  const portfolioBack = useCallback(() => navigationRef.current.returnFromAnalysis(), []);
  const portfolioOpenSingle = useCallback(() => setBacktestCenterMode("single"), []);
  const portfolioOpenSecurity = useCallback((security: Security) =>
    navigationRef.current.openAnalysis(security, { view: "backtest", label: "返回组合回测" }), []);

  const handleBatchCompare = useCallback((securities: Security[]) => {
    const next = uniqueSecurities(securities).slice(0, 6);
    if (!next.length) return;
    saveSafeLocalJson("a-stock-radar:compare-selection", next, isUsableSecurityCollection);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("a-stock-radar:compare-selection-updated", { detail: next }));
    }
    navigateTo("compare");
    showToast(`已将 ${next.length} 只股票送入多股同列`);
  }, [showToast]);

  return (
    <div className="app-shell terminal-shell" data-workspace={view} data-view={view} data-nav-collapsed={navigationCollapsed}>
      <WindowTitleBar />
      <WorkspaceNavigation
        items={navItems}
        active={view}
        counts={{ favorites: favoriteItems.length, holdings: holdings.length, watchlist: observationItems.length, notes: notes.awaitingCount }}
        collapsed={navigationCollapsed}
        coreOnly={sidebarCoreOnly}
        onToggleCoreOnly={toggleSidebarCoreOnly}
        onCollapse={() => setNavigationCollapsed(value => !value)}
        onNavigate={id => id === "backtest" ? openBacktest() : navigateTo(id as View)}
      />

      <main className="main">
        {renderAppHeaderBar({
          workspaceLabel: navItems.find(item => item.id === view)?.label || (view === "settings" ? "数据源设置" : "工作台"),
          view,
          dashboardMode,
          researchView,
          live,
          onToggleLive: () => setLive(!live),
          loading,
          payload,
          onRefreshAnalysis: () => { if (payload) void loadSecurity(payload.security, false, true); },
          settings,
          onSetTheme: setThemeMode,
          onToggleNewsVoice: toggleNewsVoice,
          onOpenPalette: () => setPaletteOpen(true),
          privacyMask,
          onTogglePrivacyMask: togglePrivacyMask,
          query,
          setQuery,
          suggestions,
          setSuggestions,
          searching,
          setSearching,
          searchError,
          setSearchError,
          searchComplete,
          setSearchComplete,
          searchComposing,
          setSearchComposing,
          searchComposingRef,
          searchEditVersion,
          searchRequestId,
          searchTimer,
          searchBoxRef,
          onSearchSubmit: handleSearch,
          onFetchSuggestions: fetchSecuritySuggestions,
          onSelectSuggestion: openAnalysis,
          copilotRef,
          copilotOpen,
          setCopilotOpen,
          copilotPhase,
          copilotAlerts,
          onCopilotSelect: handleCopilotSelect,
          holdingsCount: holdings.length,
          favoritesCount: favoriteItems.length,
          awaitingNotesCount: notes.awaitingCount,
          tItemsCount: tAssistant.store.items.length,
          onNavigateView: navigateTo,
          hasMonitorAlerts: copilotAlerts.length > 0,
          onClearMonitorAlerts: clearAllCopilotAlerts
        })}

        {isOffline && (
          <div className="offline-status-banner" role="alert">
            <CircleAlert size={15} />
            <span>本机网络已断开，实时轮询已自动暂停并保留上次有效快照；网络恢复后将自动重连。</span>
          </div>
        )}

        {sourceNotice && !isOffline && sourceNotice.key !== providerBannerDismissed && (
          <div className={`provider-setup-banner ${sourceNotice.tone}`} role={sourceNotice.tone === "down" ? "alert" : "status"}>
            <CircleAlert size={16} />
            <span>{sourceNotice.message}</span>
            <button className="secondary-btn" onClick={() => openSettings("sources")}>查看数据源</button>
            <button className="icon-button" aria-label="关闭数据源提示" title="关闭提示" onClick={() => setProviderBannerDismissed(sourceNotice.key)}><X size={15} /></button>
          </div>
        )}
        {(paperActionSaveError || paperSnapshotSaveError) && (
          <div className="paper-save-error" role="alert">
            {paperActionSaveError && <p>纸面账户保存失败，本次操作未生效。请检查存储空间后重新操作。</p>}
            {paperSnapshotSaveError && <p>纸面账户存在未保存的行情更新，请保存后再关闭软件。</p>}
            {paperSnapshotSaveError && <button className="secondary-btn" onClick={retryPaperSave}>重试保存纸面账户</button>}
          </div>
        )}

        {view === "signals" && !launchStripDismissed && (
          <section className="copilot-launch-strip" aria-label="交易时段与AI副驾驶速览">
            <div className="copilot-launch-meta">
              <span className="copilot-launch-pill phase" title={copilotPhase.tip}>
                <Radar size={13} />
                <b>{copilotPhase.label}</b>
              </span>
              <span className="copilot-launch-pill regime" title={launchArchive?.regimeAdvice?.summary || "进入市场研判/专业复盘会自动沉淀每日外生情绪快照"}>
                {launchArchive?.days
                  ? `周期：${launchArchive.regimeAdvice.regimeLabel}（已归档 ${launchArchive.days} 日）`
                  : "周期：待同步外生快照"}
              </span>
              <span className="copilot-launch-stats">
                持仓 {holdings.length} · 随心记待办 {notes.awaitingCount} · 做T {tAssistant.store.items.length} · 预警 {copilotAlerts.length}
              </span>
            </div>
            <div className="copilot-launch-actions">
              <button type="button" className="secondary-btn" onClick={() => navigateTo("cockpit")}>今日驾驶舱</button>
              {!defaultCockpit && <button type="button" className="secondary-btn" onClick={() => { toggleDefaultCockpit(true); navigateTo("cockpit"); }} title="下次打开软件直接进入今日驾驶舱">设为默认首页</button>}
              <button type="button" className="secondary-btn" onClick={() => navigateTo("ai-picks")}>AI 选股</button>
              <button type="button" className="secondary-btn" onClick={() => navigateTo("ai-agent")}>AI 问股</button>
              <button type="button" className="icon-button" aria-label="收起速览条" title="收起" onClick={() => setLaunchStripDismissed(true)}><X size={14} /></button>
            </div>
          </section>
        )}

        {renderAppWorkspaceRoutes({
          view,
          setView,
          researchView,
          dashboardMode,
          informationTab,
          setInformationTab,
          watchlistNode,
          setWatchlistNode,
          analysisOrigin,
          observationReturnLabel,
          originForView,
          navigateTo,
          openAnalysis,
          analysisQueue,
          returnFromAnalysis,
          loadSecurity,
          latestAnalysis,
          analysisRequestId,
          payload,
          analysisTarget,
          loading,
          error,
          live: effectiveLive,
          privacyMask,
          defaultCockpit,
          toggleDefaultCockpit,
          settings,
          settingsLoadState,
          persistSettings,
          watchlist,
          holdings,
          favoriteItems,
          favoriteCodes,
          observationItems,
          isFavorite,
          toggleFavorite,
          removeObservation,
          saveHoldings,
          addFavoriteSecurity,
          addFavoriteSecurities,
          onOpenMonitor: setQuickMonitorTarget,
          onBatchCompare: handleBatchCompare,
          handleQuickHoldingTrade,
          showToast,
          notes,
          tAssistant,
          stockMonitors,
          copilotPhase,
          copilotAlerts,
          newsLiveQuotes,
          addNoteToT,
          addNoteToMonitor,
          discover,
          discovering,
          limitUps,
          limitPoolMeta,
          failedBoardCache,
          failedBoardViewState,
          rememberFailedBoardCache,
          rememberFailedBoardViewState,
          sectorBoard,
          sectorExtra,
          sectorBoardLoading,
          sectorBoardError,
          sectorLegacyOpen,
          setSectorLegacyOpen,
          loadSectorBoard,
          compareCandidates,
          reviewMounted,
          portfolioActive,
          portfolioMounted,
          portfolioInitialSecurities,
          portfolioBack,
          portfolioOpenSingle,
          portfolioOpenSecurity,
          openBacktest,
          backtestCenterMode,
          setBacktestCenterMode,
          backtestDraft,
          setBacktestDraft,
          backtestLoading,
          backtestError,
          backtestResult,
          backtestRunRecord,
          backtestHistory,
          backtestProfileComparisons,
          backtestEntryContext,
          invalidateBacktests,
          runBacktest,
          runBacktestProfileComparisons,
          applyBacktestProfileWithGovernance,
          loadBacktestRecord,
          exportBacktestPayload,
          exportCurrentBacktest,
          applyCurrentBacktestToPaper,
          applyHistoryToSettings,
          clearBacktestHistory,
          updateBacktestTargetContext,
          executionDecisionLog,
          clearExecutionDecisionLog,
          paperSummary,
          paperExecutionReadiness,
          paperCurrentPositions,
          canPaperTrade,
          latestExecutionDecision,
          executePaperTrade,
          closePaperTradeForCurrent,
          closePaperTradeForCode,
          closeAllPaperTrades,
          confirmPaperSettlementForCode,
          refreshPaperPositions,
          settingsCategory,
          settingsRequestSeq,
          openSettings
        })}

        <footer className="terminal-statusbar">
          <div className="sidebar-status">
            <div className="status-row">
              <span className={`live-dot ${isOffline || !live ? "paused" : marketDegraded ? "degraded" : ""}`} />
              <div><strong>{isOffline ? "本机离线" : marketStatus}</strong><small>{marketStatusDetail}</small></div>
            </div>
            <div className="quota-text"><span>请求主源 {requestedProviderLabel}</span><b>实际 {actualProviderLabel}</b></div>
          </div>
          <div className="version">趋势定制版 v{version} · 仅供研究，不构成投资建议</div>
        </footer>
      </main>
      {toasts.length > 0 && (
        <div
          className="toast-stack"
          onMouseEnter={() => {
            toastHoverAtRef.current = Date.now();
            toastTimersRef.current.forEach(t => window.clearTimeout(t));
            toastTimersRef.current.clear();
          }}
          onMouseLeave={() => {
            const pausedAt = toastHoverAtRef.current;
            toastHoverAtRef.current = null;
            const now = Date.now();
            setToasts(current =>
              current.map(item => ({
                ...item,
                expiresAt: now + Math.max(900, pausedAt !== null ? item.expiresAt - pausedAt : 1200)
              }))
            );
          }}
        >
          {toasts.map(item => (
            <div
              key={item.id}
              className={`toast is-${item.tone}`}
              role={item.tone === "error" || item.tone === "warn" ? "alert" : "status"}
              aria-live={item.tone === "error" ? "assertive" : "polite"}
            >
              {item.tone === "error" || item.tone === "warn" ? <CircleAlert size={17} /> : <ShieldCheck size={17} />}
              <span>{item.text}</span>
              <button type="button" className="toast-close-btn" aria-label="关闭提示" onClick={() => dismissToast(item.id)}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <WorkspaceErrorBoundary label="随心记提醒" compact>
        <NoteReminderStack
          api={notes}
          favoriteCodes={favoriteCodes}
          onAddMonitor={(stock, condition) => { void addNoteToMonitor(stock, condition); }}
          onAddToT={addNoteToT}
          onAddFavorite={(stock) => { void addFavoriteSecurity(stock); }}
          onOpenNotes={() => navigateTo("notes")}
          onOpenStock={(stock: Security) => openAnalysis(stock, originForView(view))}
        />
      </WorkspaceErrorBoundary>
      <ConfirmDialog request={confirmRequest} onResolve={resolveConfirm} />
      <QuickMonitorModal
        stock={quickMonitorTarget}
        config={quickMonitorTarget ? stockMonitors.configs[quickMonitorTarget.code] : undefined}
        onSave={async (security, next) => {
          const ok = stockMonitors.save(security.code, next);
          if (ok && !favoriteCodes.has(security.code) && !holdings.some(h => h.code === security.code)) {
            await addFavoriteSecurity(security);
          }
          if (ok) showToast(`已更新 ${security.name} 盯盘条件`);
          return ok;
        }}
        onClose={() => setQuickMonitorTarget(null)}
      />
      <MasterPasswordUnlockModal
        open={masterLocked}
        onUnlocked={() => {
          setMasterLocked(false);
          showToast("密钥库已解锁");
        }}
      />
      {paletteOpen && (
        <Suspense fallback={null}>
          <QuickPaletteModal
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            views={[
              ...navItems.map(item => ({ id: item.id, label: item.label, group: "工作区" })),
              { id: "settings", label: "数据源与 AI 设置", group: "系统配置", keywords: "ai token settings" }
            ]}
            commands={[
              { id: "toggle-privacy", label: privacyMask ? "恢复显示持仓金额" : "开启隐私脱敏模式（隐藏金额）", group: "快捷控制", keywords: "privacy mask yinsi" },
              { id: "toggle-live", label: live ? "暂停实时行情轮询" : "开启实时行情轮询", group: "快捷控制", keywords: "live refresh" },
              { id: "toggle-sidebar", label: sidebarCoreOnly ? "侧边栏显示全部模块" : "侧边栏精简为核心高频模块", group: "快捷控制", keywords: "sidebar nav core" }
            ]}
            holdings={holdings}
            favorites={favoriteItems}
            watchlist={observationItems}
            privacyMask={privacyMask}
            onNavigateView={id => (id === "backtest" ? openBacktest() : navigateTo(id as View))}
            onOpenStock={sec => openAnalysis(sec, originForView(view))}
            onRunCommand={cmdId => {
              if (cmdId === "toggle-privacy") togglePrivacyMask();
              else if (cmdId === "toggle-live") setLive(v => !v);
              else if (cmdId === "toggle-sidebar") toggleSidebarCoreOnly();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
