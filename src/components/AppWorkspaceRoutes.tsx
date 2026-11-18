import { lazy, memo, Suspense, type MutableRefObject } from "react";
import { LoadingState } from "./terminal/TerminalPrimitives";
import { WorkspaceErrorBoundary } from "./AppErrorBoundary";
import type { FailedBoardCache, FailedBoardViewState } from "../features/dashboard/PreviousLimitUpFailedBoards";
import { resolveInformationCenterRoute, type InformationTab } from "../features/information/informationModel";
import { sectorsForAi, type LimitPoolMeta, type LimitPoolRowRecord, type SectorStrengthExtra } from "../features/market/useMarketWorkspaceFeed";
import type { AnalysisPayload } from "../features/market/analysisTypes";
import type { BacktestStrategyProfile, BacktestViewProps } from "../features/backtest/backtestTypes";
import { buildBacktestExecutionPlan, buildBacktestProfileDiff, evaluateBacktestExecutionReadiness, toBacktestStrategyProfile } from "../features/backtest/executionGovernance";
import type { NotesApi } from "../features/notes/useNotes";
import type { NoteCondition } from "../features/notes/notesModel";
import type { TAssistantApi } from "../features/t-assistant/useTAssistant";
import type useStockMonitors from "../useStockMonitors";
import type { CopilotAlertItem, resolveMarketSessionPhase } from "../copilotBriefing";
import type { WorkspaceView as View } from "../workspaceView";
import type { ExecutionDecisionLog, PaperSimulationState } from "../features/paper-simulation/paperSimulationTypes";
import type { PaperClosedPosition } from "../domain/paperSimulationTypes";
import type { useWorkspaceCollections } from "../features/collections/useWorkspaceCollections";
import type { usePaperTrading } from "../features/paper-simulation/usePaperTrading";
import type { BacktestHistoryRecord } from "../features/backtest/backtestTypes";

const MultiStockCompareView = lazy(() => import("../features/market/MultiStockCompareView"));
// 两个常驻（hidden keep-alive）的大视图用 memo：根组件每次行情轮询更新时，props 未变就不重渲染。
const PortfolioBacktestView = lazy(() => import("../features/backtest/PortfolioBacktestView").then((module) => ({ default: memo(module.default) })));
const BacktestView = lazy(() =>
  import("../features/backtest/BacktestView").then((module) => ({ default: module.BacktestView }))
);
const ProfessionalReview = lazy(() => import("../ProfessionalReview").then((module) => ({ default: memo(module.default) })));
const StrategySignalsView = lazy(() => import("../features/strategy-selection/StrategySignalsView"));
const SectorExplorerPanel = lazy(() => import("../SectorExplorerPanel"));
const LazyNewsView = lazy(() => import("../features/information/NewsView").then(module => ({ default: module.NewsView })));
const SettingsView = lazy(() => import("../features/settings/SettingsView").then(module => ({ default: module.SettingsView })));
const Dashboard = lazy(() => import("../features/market/MarketWorkspace").then(module => ({ default: module.Dashboard })));
const SectorView = lazy(() => import("../features/sectors/SectorView").then(module => ({ default: module.SectorView })));
const ConvertibleBondView = lazy(() => import("../features/bonds/ConvertibleBondView"));
const HsgtWebView = lazy(() => import("../features/hsgt/HsgtWebView"));
const AiPicksView = lazy(() => import("../features/ai-picks/AiPicksView"));
const AiAgentView = lazy(() => import("../features/ai-agent/AiAgentView"));
const TAssistantView = lazy(() => import("../features/t-assistant/TAssistantView"));
const NotesView = lazy(() => import("../features/notes/NotesView"));
const TodayCockpitView = lazy(() => import("../features/cockpit/TodayCockpitView"));
const LazyFavoritesView = lazy(() => import("../features/collections/CollectionViews").then(module => ({ default: module.FavoritesView })));
const LazyHoldingsView = lazy(() => import("../features/collections/CollectionViews").then(module => ({ default: module.HoldingsView })));
const LazyWatchlistView = lazy(() => import("../features/collections/CollectionViews").then(module => ({ default: module.WatchlistView })));
const PreviousLimitUpFailedBoards = lazy(() => import("../features/dashboard/PreviousLimitUpFailedBoards"));
const AiInterpretPanel = lazy(() => import("../features/ai-review/AiInterpretPanel").then(module => ({ default: module.AiInterpretPanel })));

export type AnalysisOrigin = {
  view: View;
  label: string;
  node?: string;
  dashboardMode?: "pool" | "analysis";
  informationTab?: InformationTab;
};

type AppWorkspaceRoutesProps = {
  view: View;
  setView: (next: View) => void;
  researchView: boolean;
  dashboardMode: "pool" | "analysis";
  informationTab: InformationTab;
  setInformationTab: (next: InformationTab) => void;
  watchlistNode: string;
  setWatchlistNode: (next: string) => void;
  analysisOrigin: AnalysisOrigin | null;
  observationReturnLabel: (node: string) => string;
  originForView: (sourceView?: View) => AnalysisOrigin;
  navigateTo: (next: View) => void;
  openAnalysis: (security: Security | string, origin?: AnalysisOrigin | null) => void;
  returnFromAnalysis: () => void;
  loadSecurity: (security: Security | string, silent?: boolean, forceRefresh?: boolean) => Promise<void>;
  latestAnalysis: MutableRefObject<AnalysisPayload | null>;
  analysisRequestId: MutableRefObject<number>;
  payload: AnalysisPayload | null;
  analysisTarget: Security | string | null;
  loading: boolean;
  error: string;
  live: boolean;
  privacyMask: boolean;
  defaultCockpit: boolean;
  toggleDefaultCockpit: (enabled: boolean) => void;
  settings: Settings;
  settingsLoadState: "loading" | "ready" | "failed";
  persistSettings: (patch: Partial<Settings>) => Promise<Settings>;
  watchlist: WatchItem[];
  holdings: HoldingItem[];
  favoriteItems: WatchItem[];
  favoriteCodes: Set<string>;
  observationItems: WatchItem[];
  isFavorite: boolean;
  toggleFavorite: (stock?: Security | WatchItem) => Promise<void>;
  removeObservation: ReturnType<typeof useWorkspaceCollections>["removeObservation"];
  saveHoldings: ReturnType<typeof useWorkspaceCollections>["saveHoldings"];
  addFavoriteSecurity: (security: Security) => Promise<void>;
  handleQuickHoldingTrade: ReturnType<typeof useWorkspaceCollections>["handleQuickHoldingTrade"];
  showToast: (message: string) => void;
  notes: NotesApi;
  tAssistant: TAssistantApi;
  stockMonitors: ReturnType<typeof useStockMonitors>;
  copilotPhase: ReturnType<typeof resolveMarketSessionPhase>;
  copilotAlerts: CopilotAlertItem[];
  newsLiveQuotes: Record<string, { code: string; name?: string | undefined; changePct: number; price?: number | undefined }>;
  addNoteToT: (security: Security) => void;
  addNoteToMonitor: (security: Security, condition?: NoteCondition | null) => Promise<void>;
  discover: () => Promise<void>;
  discovering: boolean;
  limitUps: LimitPoolRowRecord[];
  limitPoolMeta: LimitPoolMeta;
  failedBoardCache: MutableRefObject<FailedBoardCache | null>;
  failedBoardViewState: MutableRefObject<FailedBoardViewState | undefined>;
  rememberFailedBoardCache: (value: FailedBoardCache) => void;
  rememberFailedBoardViewState: (value: FailedBoardViewState) => void;
  sectorBoard: Array<Record<string, unknown>>;
  sectorExtra: SectorStrengthExtra | null;
  sectorBoardLoading: boolean;
  sectorBoardError: string;
  sectorLegacyOpen: boolean;
  setSectorLegacyOpen: React.Dispatch<React.SetStateAction<boolean>>;
  loadSectorBoard: (forceRefresh?: boolean) => Promise<boolean>;
  compareCandidates: Security[];
  reviewMounted: boolean;
  portfolioActive: boolean;
  portfolioMounted: boolean;
  portfolioInitialSecurities: Security[];
  portfolioBack: () => void;
  portfolioOpenSingle: () => void;
  portfolioOpenSecurity: (security: Security) => void;
  openBacktest: (security?: Security | null) => void;
  backtestCenterMode: "single" | "portfolio";
  setBacktestCenterMode: React.Dispatch<React.SetStateAction<"single" | "portfolio">>;
  backtestDraft: BacktestViewProps["draft"];
  setBacktestDraft: React.Dispatch<React.SetStateAction<BacktestViewProps["draft"]>>;
  backtestLoading: boolean;
  backtestError: string;
  backtestResult: BacktestViewProps["result"];
  backtestRunRecord: BacktestHistoryRecord | null;
  backtestHistory: BacktestViewProps["history"];
  backtestProfileComparisons: BacktestViewProps["profileComparisons"];
  backtestEntryContext: BacktestViewProps["entryContext"];
  invalidateBacktests: () => void;
  runBacktest: BacktestViewProps["onRun"];
  runBacktestProfileComparisons: BacktestViewProps["onRunProfileComparisons"];
  applyBacktestProfileWithGovernance: (
    record: BacktestViewProps["history"][number],
    source: ExecutionDecisionLog["source"],
    label: string
  ) => Promise<void>;
  loadBacktestRecord: BacktestViewProps["onLoadHistory"];
  exportBacktestPayload: BacktestViewProps["onExportHistory"];
  exportCurrentBacktest: BacktestViewProps["onExportCurrent"];
  applyCurrentBacktestToPaper: BacktestViewProps["onApplyCurrent"];
  applyHistoryToSettings: BacktestViewProps["onApplyHistory"];
  clearBacktestHistory: BacktestViewProps["onClearHistory"];
  updateBacktestTargetContext: BacktestViewProps["onTargetChange"];
  executionDecisionLog: ExecutionDecisionLog[];
  clearExecutionDecisionLog: () => void;
  paperSummary: ReturnType<typeof usePaperTrading>["paperSummary"];
  paperExecutionReadiness: ReturnType<typeof import("../features/paper-simulation/paperSimulationEngine").evaluatePaperExecutionReadiness>;
  paperCurrentPositions: PaperSimulationState["openPositions"];
  canPaperTrade: boolean;
  latestExecutionDecision: ExecutionDecisionLog | null;
  executePaperTrade: () => void;
  closePaperTradeForCurrent: (reason?: PaperClosedPosition["closeReason"]) => void;
  closePaperTradeForCode: (code: string, reason?: PaperClosedPosition["closeReason"]) => void;
  closeAllPaperTrades: (reason?: PaperClosedPosition["closeReason"]) => void;
  confirmPaperSettlementForCode?: ((code: string) => void) | undefined;
  settingsCategory?: string | undefined;
  openSettings?: ((category?: string) => void) | undefined;
};

export function renderAppWorkspaceRoutes(props: AppWorkspaceRoutesProps) {
  const {
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
    returnFromAnalysis,
    loadSecurity,
    latestAnalysis,
    analysisRequestId,
    payload,
    analysisTarget,
    loading,
    error,
    live,
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
    settingsCategory,
    openSettings
  } = props;

  const currentAnalysisCode = payload?.security?.code || (typeof analysisTarget === "string" ? analysisTarget : analysisTarget?.code) || "";
  const seqIndex = currentAnalysisCode ? compareCandidates.findIndex(item => item.code === currentAnalysisCode) : -1;
  const prevStock = seqIndex > 0 ? compareCandidates[seqIndex - 1] : undefined;
  const nextStock = seqIndex >= 0 && seqIndex + 1 < compareCandidates.length ? compareCandidates[seqIndex + 1] : undefined;
  const handleToggleFavoriteSecurity = (stock: Security) => { void toggleFavorite(stock); };
  const handleOpenAiSettings = () => (openSettings ? openSettings("ai") : navigateTo("settings"));
  const returnToSignals = () => navigateTo("signals");

  return (
    <div className={`page ${view === "review" ? "review-page-host" : ""}`}>
      {view === "cockpit" && (
        <WorkspaceErrorBoundary key={view} label="今日驾驶舱" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <TodayCockpitView
              phase={copilotPhase}
              holdings={holdings}
              favorites={favoriteItems}
              watchlist={observationItems}
              limitUps={limitUps}
              notesApi={notes}
              tAssistant={tAssistant}
              stockMonitors={stockMonitors}
              paperSummary={paperSummary}
              copilotAlerts={copilotAlerts}
              live={live}
              isDefaultView={defaultCockpit}
              privacyMask={privacyMask}
              onShowToast={showToast}
              onToggleDefaultView={toggleDefaultCockpit}
              onOpenStock={(stock: Security, label = "返回今日驾驶舱") => openAnalysis(stock, { view: "cockpit", label })}
              onNavigate={(next: View) => next === "backtest" ? openBacktest() : navigateTo(next)}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "dashboard" && (
        <WorkspaceErrorBoundary key={view} label={dashboardMode === "analysis" ? "个股分析" : "涨停池"} onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <Dashboard
              live={live}
              payload={payload}
              loading={loading}
              error={error}
              isWatched={isFavorite}
              onToggleWatch={() => toggleFavorite()}
              notes={notes}
              monitors={stockMonitors}
              privacyMask={privacyMask}
              onQuickHoldingTrade={handleQuickHoldingTrade}
              onTransferToT={addNoteToT}
              onShowToast={showToast}
              onOpenSettings={openSettings}
              onPrevStock={prevStock ? () => openAnalysis(prevStock, analysisOrigin) : undefined}
              onNextStock={nextStock ? () => openAnalysis(nextStock, analysisOrigin) : undefined}
              onDiscover={discover}
              discovering={discovering}
              limitUps={limitUps}
              limitPoolMeta={limitPoolMeta}
              onOpen={(security: Security) => openAnalysis(security, { view: "dashboard", label: "返回涨停池" })}
              onAdd={(stock: Security) => {
                // 涨停池里的「监控」只加入自选，已在自选的不会被取消。
                if (!favoriteItems.some((item) => item.code === stock.code)) void toggleFavorite(stock);
              }}
              isFavorite={(code: string) => favoriteItems.some((item) => item.code === code)}
              holdings={holdings}
              settings={settings}
              analysisTarget={analysisTarget}
              mode={dashboardMode}
              backLabel={analysisOrigin?.label || "返回涨停池"}
              onBack={returnFromAnalysis}
              onOpenBacktest={openBacktest}
              executionDecisionLog={executionDecisionLog}
              onClearExecutionDecisionLog={clearExecutionDecisionLog}
              paperSummary={paperSummary}
              paperExecutionReadiness={paperExecutionReadiness}
              paperCurrentPositions={paperCurrentPositions}
              canPaperTrade={canPaperTrade}
              latestExecutionDecision={latestExecutionDecision}
              executePaperTrade={executePaperTrade}
              closePaperTradeForCurrent={closePaperTradeForCurrent}
              closePaperTradeForCode={closePaperTradeForCode}
              closeAllPaperTrades={closeAllPaperTrades}
              confirmPaperSettlementForCode={confirmPaperSettlementForCode}
              onRetry={() => analysisTarget && loadSecurity(analysisTarget, false, true)}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "previous-limit-up-failed" && (
        <WorkspaceErrorBoundary key={view} label="炸板观察" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <PreviousLimitUpFailedBoards
              live={live}
              cache={failedBoardCache.current}
              onSnapshot={rememberFailedBoardCache}
              viewState={failedBoardViewState.current}
              onViewStateChange={rememberFailedBoardViewState}
              onOpen={(stock) => openAnalysis(stock, {
                view: "previous-limit-up-failed",
                label: "返回炸板观察"
              })}
              onAdd={(stock) => {
                if (!favoriteItems.some((item) => item.code === stock.code)) void toggleFavorite(stock);
              }}
              isFavorite={(code) => favoriteItems.some((item) => item.code === code)}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "favorites" && (
        <WorkspaceErrorBoundary key={view} label="自选板块" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <LazyFavoritesView
              items={favoriteItems}
              monitors={stockMonitors}
              live={live}
              onOpen={(item: WatchItem) => openAnalysis(item, { view: "favorites", label: "返回自选板块" })}
              onRemove={toggleFavorite}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "holdings" && (
        <WorkspaceErrorBoundary key={view} label="持仓股" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <LazyHoldingsView
              items={holdings}
              settings={settings}
              live={live}
              monitors={stockMonitors}
              privacyMask={privacyMask}
              onTransferToT={addNoteToT}
              paperPositions={paperSummary.normalized.openPositions}
              paperMetrics={{
                equity: paperSummary.equity,
                cash: paperSummary.normalized.cash,
                openValue: paperSummary.openValue,
                openPnl: paperSummary.openPnl,
                openPnlPercent: paperSummary.openPnlPercent,
                cumulativeRealizedPnl: paperSummary.cumulativeRealizedPnl,
                closedCount: paperSummary.closedCount,
                winCount: paperSummary.winCount
              }}
              onClosePaperPosition={(code) => closePaperTradeForCode(code, "MANUAL")}
              onOpenPaperStock={(security: Security) =>
                openAnalysis(security, { view: "holdings", label: "返回持仓股" })
              }
              onSave={saveHoldings}
              onOpen={(item: HoldingItem) =>
                openAnalysis(item, { view: "holdings", label: "返回持仓股" })
              }
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "watchlist" && (
        <WorkspaceErrorBoundary key={view} label="股票池" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <LazyWatchlistView
              items={observationItems}
              activeNode={watchlistNode}
              onNodeChange={setWatchlistNode}
              quotes={Object.fromEntries(
                Object.entries(newsLiveQuotes).map(([code, q]) => [code, { latest: q.price, changePct: q.changePct }])
              )}
              favoriteCodes={favoriteCodes}
              onAddFavorite={(item) => { void addFavoriteSecurity(item); }}
              onOpen={(item: WatchItem) => openAnalysis(item, {
                view: "watchlist",
                node: watchlistNode,
                label: observationReturnLabel(watchlistNode)
              })}
              onRemove={removeObservation}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "beijing" && (
        <WorkspaceErrorBoundary key={view} label="北交所" onReturnHome={returnToSignals}>
          <Suspense fallback={<LoadingState />}>
            <SectorView
              dedicatedSector="北交所"
              rows={[]}
              loading={false}
              loadError=""
              favoriteCodes={favoriteCodes}
              onToggleFavorite={handleToggleFavoriteSecurity}
              onRefresh={() => true}
              onOpenStock={(stock: Security) => openAnalysis(stock, { view: "beijing", label: "返回北交所" })}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "hsgt" && (
        <WorkspaceErrorBoundary key={view} label="沪深港通" onReturnHome={returnToSignals}>
          <Suspense fallback={<LoadingState />}>
            <HsgtWebView onOpenStock={(code) => openAnalysis(code, { view: "hsgt", label: "返回沪深港通" })} />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "bonds" && (
        <WorkspaceErrorBoundary key={view} label="可转债" onReturnHome={returnToSignals}>
          <Suspense fallback={<LoadingState />}>
            <ConvertibleBondView
              onOpenSecurity={(security: Security) => openAnalysis(security, { view: "bonds", label: "返回可转债" })}
              favoriteCodes={favoriteCodes}
              onToggleFavorite={handleToggleFavoriteSecurity}
              onShowToast={showToast}
              live={live}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "sectors" && <>
        {/* 板块强度：榜单（按涨幅排名）是主视图。
            原来这里放的是板块目录浏览，榜单被藏在默认收起的折叠块里，
            用户进入「板块强度」根本看不到排行 —— 现已对调。 */}
        <WorkspaceErrorBoundary key={`${view}-board`} label="板块强度" onReturnHome={returnToSignals}>
          <Suspense fallback={<LoadingState />}>
            <SectorView
              rows={sectorBoard}
              extra={sectorExtra}
              loading={sectorBoardLoading}
              loadError={sectorBoardError}
              favoriteCodes={favoriteCodes}
              onToggleFavorite={handleToggleFavoriteSecurity}
              aiPanel={<AiInterpretPanel kind="sectors" disabled={!sectorBoard.length && !sectorExtra?.concepts.length} getData={() => sectorsForAi(sectorBoard, sectorExtra)} />}
              onRefresh={() => loadSectorBoard(true)}
              onOpenStock={(stock: Security) => openAnalysis(stock, { view: "sectors", label: "返回板块强度" })}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
        <details className="sector-legacy-details" open={sectorLegacyOpen}>
          <summary onClick={event => { event.preventDefault(); setSectorLegacyOpen(current => !current); }}>板块目录 · 按行业分类浏览、股票查所属行业</summary>
          {/* 目录默认展开：它提供「按目录找板块 → 看成分股」的入口，
              与上方榜单（按涨幅排名）互补。折叠时保持挂载，避免每次展开都重新拉取目录。 */}
          <div hidden={!sectorLegacyOpen}>
            <WorkspaceErrorBoundary key={`${view}-explorer`} label="板块目录" onReturnHome={() => navigateTo("signals")}>
              <Suspense fallback={<LoadingState />}>
                <SectorExplorerPanel active={sectorLegacyOpen} onOpenStock={(stock: Security) => openAnalysis(stock, { view: "sectors", label: "返回板块强度" })} />
              </Suspense>
            </WorkspaceErrorBoundary>
          </div>
        </details>
      </>}
      {(view === "news" || view === "announcements") && (
        <WorkspaceErrorBoundary key={view} label="资讯中心" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <LazyNewsView
              payload={payload}
              watchlist={observationItems}
              holdings={holdings}
              favorites={favoriteItems}
              limitUps={limitUps}
              liveQuotes={newsLiveQuotes}
              settings={settings}
              contentType={resolveInformationCenterRoute(view, informationTab).informationTab}
              onContentTypeChange={(tab) => { setInformationTab(tab); setView("news"); }}
              onOpenStock={(stock: Security) => openAnalysis(stock, originForView(view))}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {researchView && (
        <WorkspaceErrorBoundary key={view} label="策略选股" onReturnHome={returnToSignals}>
          <Suspense fallback={<LoadingState />}>
            <StrategySignalsView
              live={live}
              quoteRefreshSeconds={settings.quoteRefreshSeconds}
              initialFocus={view === "trend-screener" ? "trend" : undefined}
              favoriteCodes={favoriteCodes}
              onToggleFavorite={handleToggleFavoriteSecurity}
              onShowToast={showToast}
              onOpen={(stock: Security) => openAnalysis(stock, { view: "signals", label: "返回策略选股" })}
              onOpenAiPicks={() => navigateTo("ai-picks")}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "ai-picks" && (
        <WorkspaceErrorBoundary key={view} label="AI 选股" onReturnHome={returnToSignals}>
          <Suspense fallback={<LoadingState />}>
            <AiPicksView
              live={live}
              quoteRefreshSeconds={settings.quoteRefreshSeconds}
              favoriteCodes={favoriteCodes}
              onToggleFavorite={handleToggleFavoriteSecurity}
              onShowToast={showToast}
              onOpenSettings={handleOpenAiSettings}
              onOpen={(stock: Security) => openAnalysis(stock, { view: "ai-picks", label: "返回 AI 选股" })}
              onOpenStrategies={() => navigateTo("signals")}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "ai-agent" && (
        <WorkspaceErrorBoundary key={view} label="AI 问股" onReturnHome={returnToSignals}>
          <Suspense fallback={<LoadingState />}>
            <AiAgentView
              holdings={holdings}
              onOpenStock={(stock: Security) => openAnalysis(stock, { view: "ai-agent", label: "返回 AI 问股" })}
              onOpenSettings={handleOpenAiSettings}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "notes" && (
        <WorkspaceErrorBoundary key={view} label="随心记" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <NotesView
              api={notes}
              holdings={holdings}
              watchlist={watchlist}
              favoriteCodes={favoriteCodes}
              onAddMonitor={(stock, condition) => { void addNoteToMonitor(stock, condition); }}
              onAddToT={addNoteToT}
              onAddFavorite={(stock) => { void addFavoriteSecurity(stock); }}
              onOpenStock={(stock: Security) => openAnalysis(stock, { view: "notes", label: "返回随心记" })}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "t-assistant" && (
        <WorkspaceErrorBoundary key={view} label="做T助手" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <TAssistantView
              api={tAssistant}
              holdings={holdings}
              live={live}
              onSyncCostToHolding={(code, shares, newCost) => {
                void saveHoldings(items =>
                  items.map(item =>
                    item.code === code
                      ? { ...item, shares, costPrice: Number(Math.max(0.001, newCost).toFixed(3)) }
                      : item
                  )
                ).then(ok => {
                  if (ok) showToast(`已同步 ${code} 做T后成本 ¥${newCost.toFixed(3)} 到持仓`);
                });
              }}
              onOpenStock={(stock: Security) => openAnalysis(stock, { view: "t-assistant", label: "返回做T助手" })}
              onToast={showToast}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {view === "compare" && (
        <WorkspaceErrorBoundary key={view} label="多股同列" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <MultiStockCompareView
              candidates={compareCandidates}
              live={live}
              onOpen={(stock: Security) =>
                openAnalysis(stock, { view: "compare", label: "返回多股同列" })
              }
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
      {(view === "review" || reviewMounted) && (
        <div hidden={view !== "review"}>
          <WorkspaceErrorBoundary key="review" label="专业复盘" onReturnHome={() => navigateTo("signals")}>
            <Suspense fallback={<LoadingState />}>
              <ProfessionalReview
                onOpenStock={(stock: Security) => openAnalysis(stock, { view: "review", label: "返回专业复盘" })}
                onAddToT={addNoteToT}
                onOpenBacktest={(stock?: Security) => openBacktest(stock)}
                onNavigate={(next: string) => next === "backtest" ? openBacktest() : navigateTo(next as View)}
                holdings={holdings}
              />
            </Suspense>
          </WorkspaceErrorBoundary>
        </div>
      )}
      {(portfolioActive || portfolioMounted) && (
        <div hidden={!portfolioActive}>
          <WorkspaceErrorBoundary key="portfolio" label="组合回测" onReturnHome={() => navigateTo("signals")}>
            <Suspense fallback={<LoadingState />}>
              <PortfolioBacktestView
                active={portfolioActive}
                initialStrategyContext={backtestDraft.strategyContext || null}
                initialSecurities={portfolioInitialSecurities}
                onBack={portfolioBack}
                backLabel={analysisOrigin?.label || "返回涨停监控"}
                onOpenSingle={portfolioOpenSingle}
                onOpenSecurity={portfolioOpenSecurity}
              />
            </Suspense>
          </WorkspaceErrorBoundary>
        </div>
      )}
      {view === "backtest" && (
        <div hidden={backtestCenterMode !== "single"}>
          <WorkspaceErrorBoundary key={view} label="策略回测" onReturnHome={() => navigateTo("signals")}>
            <Suspense fallback={<LoadingState />}>
              <BacktestView
                draft={backtestDraft}
                loading={backtestLoading}
                error={backtestError}
                result={backtestResult}
                runRecord={backtestRunRecord}
                history={backtestHistory}
                profileComparisons={backtestProfileComparisons}
                onDraftChange={(next) => { invalidateBacktests(); setBacktestDraft(next); }}
                onInvalidateRun={invalidateBacktests}
                onRun={runBacktest}
                onRunProfileComparisons={runBacktestProfileComparisons}
                onApplyProfileComparison={(record) =>
                  applyBacktestProfileWithGovernance(record, "BACKTEST_CURRENT", "风险档位对比")
                }
                onLoadHistory={loadBacktestRecord}
                onExportHistory={exportBacktestPayload}
                onExportCurrent={exportCurrentBacktest}
                onApplyCurrent={applyCurrentBacktestToPaper}
                onApplyHistory={applyHistoryToSettings}
                onClearHistory={clearBacktestHistory}
                onBack={returnFromAnalysis}
                backLabel={analysisOrigin?.label || "返回涨停监控"}
                entryContext={backtestEntryContext}
                onTargetChange={updateBacktestTargetContext}
                currentSettings={settings}
                executionProfile={toBacktestStrategyProfile(settings)}
                profileDiff={(source: BacktestStrategyProfile) => buildBacktestProfileDiff(source, toBacktestStrategyProfile(settings))}
                evaluateBacktestExecutionReadiness={evaluateBacktestExecutionReadiness}
                buildBacktestExecutionPlan={buildBacktestExecutionPlan}
                onOpenPortfolio={() => setBacktestCenterMode("portfolio")}
              />
            </Suspense>
          </WorkspaceErrorBoundary>
        </div>
      )}
      {view === "settings" && (
        <WorkspaceErrorBoundary key={view} label="系统设置" onReturnHome={() => navigateTo("signals")}>
          <Suspense fallback={<LoadingState />}>
            <SettingsView
              value={settings}
              loadState={settingsLoadState}
              initialCategory={settingsCategory}
              onSave={async (next) => {
                const analysisGeneration = analysisRequestId.current;
                const refreshTarget = latestAnalysis.current?.security;
                const saved = await persistSettings(next);
                if (refreshTarget && analysisGeneration === analysisRequestId.current &&
                    latestAnalysis.current?.security.code === refreshTarget.code) {
                  await loadSecurity(refreshTarget, true);
                }
                showToast("设置已保存");
                return saved;
              }}
            />
          </Suspense>
        </WorkspaceErrorBoundary>
      )}
    </div>
  );
}

export function AppWorkspaceRoutes(props: AppWorkspaceRoutesProps) {
  return renderAppWorkspaceRoutes(props);
}
