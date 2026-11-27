/**
 * Canonical renderer/preview IPC contract, typed channel constants, and boundary decoders.
 * Channel literals mirror `electron/ipc/contract.cjs` and are verified in lockstep by
 * `electron/ipc-contract.test.cjs`.
 */
import type { SectorExplorerApi } from "../sectorExplorerTypes";
import type { ConvertibleBondSnapshot } from "../features/bonds/bondTypes";
import type { EtfMarketSnapshot } from "../features/etf/etfTypes";
import type { EtfRotationConfig, EtfRotationReport } from "../features/etf/etfRotationModel";
import type { FactorScreenResult } from "../features/strategy-selection/factorScreenModel";
import type { IndexBoardSnapshot, IndexStreamStatus, IndexTick } from "../features/cockpit/indexBoardModel";
import type { LimitSealRecord, LimitSealTick } from "../features/dashboard/limitSealModel";
import type { DecisionSignalList } from "../features/ai-agent/decisionSignalModel";
import type { AlertRulesRequest, AlertRulesState } from "../features/collections/alertRulesModel";
import type { BatchQuoteRequest, BatchQuoteResult } from "../domain/batchQuoteTypes";
import type { AnalysisPayload } from "../features/market/analysisTypes";
import type { CustomStrategy } from "../features/strategy-selection/customStrategyModel";
import type {
  TrendExecutionCheck,
  TrendScanCursor,
  TrendScanRequest,
  TrendScanSnapshot,
  TrendScanStatus
} from "../trendScreenerTypes";
import type { BackupApi } from "../features/backup/backupClient";

export const MAIN_IPC_CHANNELS = [
  "agent:cancel",
  "agent:conversation",
  "agent:delete",
  "agent:feeds",
  "agent:poll",
  "agent:settings",
  "agent:signal-update",
  "agent:signals",
  "agent:skill-delete",
  "agent:skill-save",
  "agent:start",
  "agent:state",
  "agent:sync-workspace",
  "ai:cached",
  "ai:custom-cached",
  "ai:custom-list",
  "ai:custom-mutate",
  "ai:custom-rank",
  "ai:custom-save",
  "ai:framework-save",
  "ai:frameworks",
  "ai:history",
  "ai:history-day",
  "ai:interpret",
  "ai:interpret-cached",
  "ai:lookback",
  "ai:market-review",
  "ai:market-review-cached",
  "ai:note-parse",
  "ai:outcomes-leaderboard",
  "ai:profile-activate",
  "ai:profile-delete",
  "ai:profile-save",
  "ai:profiles",
  "ai:rank",
  "ai:rank-models",
  "ai:review",
  "ai:review-cached",
  "ai:status",
  "ai:strategy-draft",
  "ai:summary",
  "ai:test",
  "alerts:rules",
  "app:notify",
  "app:set-theme",
  "app:set-zoom",
  "app:version",
  "app:window-control",
  "backtest:run",
  "backtest:run-portfolio",
  "backup:cancel-restore",
  "backup:choose-folder",
  "backup:configure",
  "backup:inspect",
  "backup:prepare-restore",
  "backup:restore",
  "backup:run",
  "backup:status",
  "bond:list",
  "diagnostics:corrupted-on-load",
  "etf:list",
  "etf:rotation",
  "holdings:get",
  "holdings:save",
  "market:analyze",
  "market:analyze-sector",
  "market:batch-quotes",
  "market:index-board",
  "market:index-stream",
  "market:industries",
  "market:seal-stream",
  "market:chart",
  "market:concept-chain",
  "market:federation",
  "market:limit-ecology",
  "market:limit-up-sectors",
  "market:limit-ups",
  "market:previous-limit-up-failed-boards",
  "market:quote",
  "market:recent-limit-ups",
  "market:search",
  "market:search-sectors",
  "market:sector-limit-count",
  "market:sector-strength",
  "market:source-health",
  "market:source-reset",
  "news:analyze-impact",
  "news:get-feed",
  "news:refresh",
  "notes:interval-sync",
  "notes:watch-sync",
  "review:get-market",
  "review:open-window",
  "screen:factors",
  "sector:cancel",
  "sector:catalog",
  "sector:classifications",
  "sector:detail",
  "sector:quotes",
  "security:master-clear",
  "security:master-set",
  "security:master-status",
  "security:master-unlock",
  "service:cancel",
  "settings:get",
  "settings:save",
  "settings:test-provider",
  "shell:open-external",
  "storage:cleanup",
  "storage:kv-get",
  "storage:kv-set",
  "strategy:custom:delete",
  "strategy:custom:import-settings",
  "strategy:custom:list",
  "strategy:custom:save",
  "strategy:definitions",
  "strategy:external-archive",
  "strategy:leaderboard",
  "strategy:scan",
  "ths-web:bounds",
  "ths-web:command",
  "ths-web:hide",
  "ths-web:show",
  "ths-web:state",
  "trend-screener:cancel",
  "trend-screener:execution-check",
  "trend-screener:research",
  "trend-screener:start",
  "trend-screener:status",
  "watchlist:get",
  "watchlist:save"
] as const;

export const REVIEW_IPC_CHANNELS = [
  "review-window:analyze",
  "review-window:market",
  "review-window:search",
  "review-window:theme"
] as const;

export const IPC_EVENT_CHANNELS = [
  "ai:stream",
  "app:notification-clicked",
  "market:index-tick",
  "market:seal-tick",
  "review-window:theme-changed"
] as const;

export type MainIpcChannel = (typeof MAIN_IPC_CHANNELS)[number];
export type ReviewIpcChannel = (typeof REVIEW_IPC_CHANNELS)[number];
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number];

export type RuntimeInfo = {
  versions: {
    electron?: string;
    node?: string;
    chrome?: string;
    undici?: string;
  };
  platform: string;
  arch: string;
};

export type ThsWebBridgeState = {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  error: string;
};

export type QuoteSnapshotPayload = {
  security: Security;
  quote: {
    code?: string;
    name?: string;
    secid?: string;
    industry?: string;
    latest?: number | null;
    price?: number | null;
    preClose?: number | null;
    changePct?: number | null;
    changePercent?: number | null;
    turnover?: number | null;
    amount?: number | null;
    volume?: number | null;
    marketStatus?: string;
    source?: string;
    quoteAt?: string;
    updatedAt?: string;
    quoteAtIsTradeTime?: boolean;
    missingFields?: string[];
    [key: string]: unknown;
  };
  updatedAt: string;
  provider?: string;
  actualProvider?: string;
  [key: string]: unknown;
};

export type ChartCandleRow = {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number | null;
  volumeUnit?: string;
  amount?: number;
  [key: string]: unknown;
};

export type StrategyDefinitionItem = {
  id: string;
  name: string;
  type?: string | undefined;
  family?: string | undefined;
  detail?: string | undefined;
  description?: string | undefined;
  retired?: boolean | undefined;
  [key: string]: unknown;
};

export type StrategyLeaderboardStrategyRow = {
  id: string;
  name: string;
  featured?: boolean | undefined;
  family?: string | undefined;
  detail?: string | undefined;
  rank?: number | undefined;
  horizons: Record<string, {
    sampleCount: number;
    independentSignalDays?: number;
    winRate: number | null;
    winRateInterval95?: [number, number] | null | undefined;
    averageReturn: number | null;
    medianReturn: number | null;
    averageExcessReturn?: number | null;
    edgeVsBaseline: number | null;
    medianEdgeVsBaseline?: number | null;
    /** 按信号日等权的优势（策略当日平均 − 基线当日平均，再对信号日取平均），百分点。 */
    dayWeightedEdge: number | null;
    comparedSignalDays?: number | undefined;
    nextDayUnbuyableRate?: number | null;
    entryGapSkippedRate?: number | null;
  }>;
  halves?: Array<{ label: string; from: string; to: string; sampleCount: number; winRate?: number | null | undefined; averageReturn?: number | null | undefined; dayWeightedEdge: number | null; comparedSignalDays?: number | undefined }>;
  verdict: { level: string; text: string };
};

export type StrategyLeaderboardReport = {
  statusOnly?: boolean | undefined;
  progress?: { active?: boolean; processed?: number; total?: number; startedAt?: string | null; etaSeconds?: number | null } | undefined;
  v?: number;
  generatedAt?: string;
  signalTo?: string;
  /** 本机日线库里最新一根日线的日期；早于 signalTo 说明库落后，结果里会提示。 */
  dataThrough?: string | undefined;
  libraryStale?: boolean | undefined;
  stockCount?: number;
  window?: { from: string; to: string };
  horizons?: number[];
  primaryHorizon?: number;
  minSamples?: number;
  minSignalDays?: number;
  edgeTolerance?: number;
  benchmarkReady?: boolean;
  universe?: { localStocks?: number; readable?: number; replayed?: number; excludedRisk?: number; namesAvailable?: boolean };
  elapsedSeconds?: number;
  method?: string;
  baselineDefinition?: string;
  edgeDefinition?: string;
  caveat?: string;
  baseline?: Record<string, { sampleCount?: number; winRate?: number | null; averageReturn?: number | null; medianReturn?: number | null }>;
  strategies?: StrategyLeaderboardStrategyRow[];
  dataQuality?: Record<string, number>;
};

export type StrategySignalScanResult = Record<string, unknown> & {
  strategies?: Array<Record<string, unknown>>;
  optimizedPortfolio?: {
    selectedStrategies?: Array<Record<string, unknown>>;
    publicationAccepted?: boolean;
    minimumVotes?: number;
    stocks?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  } | null;
};

export type StockApi = SectorExplorerApi & {
  search(query: string): Promise<Security[]>;
  analyze(security: Security | string, options?: { forceRefresh?: boolean }): Promise<AnalysisPayload>;
  getQuoteSnapshot(security: Security | string): Promise<QuoteSnapshotPayload>;
  getDataFederation(security: Security | string): Promise<Record<string, unknown>>;
  getMarketSourceHealth?(): Promise<MarketSourceHealth>;
  resetMarketSourceHealth?(): Promise<{ ok: boolean }>;
  getConvertibleBonds?(options?: { forceRefresh?: boolean; waitForQuotes?: boolean }): Promise<ConvertibleBondSnapshot>;
  getEtfMarket?(options?: { forceRefresh?: boolean }): Promise<EtfMarketSnapshot>;
  getEtfRotation?(config?: Partial<EtfRotationConfig>): Promise<EtfRotationReport>;
  screenFactors?(input?: { strategyId?: string; top?: number }): Promise<FactorScreenResult>;
  getIndexBoard?(options?: { forceRefresh?: boolean; withTrends?: boolean }): Promise<IndexBoardSnapshot>;
  alertRules?(input?: AlertRulesRequest): Promise<AlertRulesState>;
  /** 代码 → 同花顺行业；查不到的代码不出现在结果里。 */
  getStockIndustries?(codes: string[]): Promise<Record<string, string>>;
  subscribeIndexStream?(options?: { active?: boolean }): Promise<IndexStreamStatus>;
  subscribeLimitSeals?(input: { owner: string; codes?: string[]; active?: boolean; withHistory?: boolean }): Promise<{ active: boolean; items: LimitSealRecord[] }>;
  onLimitSealTick?(listener: (tick: LimitSealTick) => void): () => void;
  onIndexTick?(listener: (tick: IndexTick) => void): () => void;
  /** 策略实测榜（回测中心）：全市场日线按批回放后的排行榜；statusOnly 只取进度。 */
  getStrategyLeaderboard?(options?: { refresh?: boolean; statusOnly?: boolean }): Promise<StrategyLeaderboardReport>;
  getBatchQuotes?(securities: BatchQuoteRequest[]): Promise<BatchQuoteResult>;
  getLimitEcology?(options?: { forceRefresh?: boolean }): Promise<Record<string, unknown>>;
  ai?: {
    status(): Promise<{ configured: boolean; model: string; profile?: string; rankModels?: string[]; framework?: string }>;
    rank(input: AiSelectionInput): Promise<AiRanking>;
    summary(input: AiSelectionInput): Promise<AiSummary>;
    cached(input: AiSelectionInput): Promise<{ rank: AiRanking | null; summary: AiSummary | null }>;
    draftStrategy(input: { text: string; patterns: { id: string; name: string; detail?: string | undefined }[] }): Promise<{
      strategy: CustomStrategy | Record<string, unknown> | null;
      notes: string;
      model: string;
      needsClarification?: boolean;
      clarification?: string;
      unsupportedTerms?: string[];
      alternatives?: { label: string; prompt: string }[];
    }>;
    parseNote?(input: { text: string; now: string; tradingDays: string[] }): Promise<{
      text: string;
      when: string | null;
      repeat: "none" | "tradingDays" | "daily" | "weekly";
      code: string | null;
      condition: { field: "latest" | "changePct"; op: "lte" | "gte"; value: number } | null;
      note: string;
      /** 这件事是否只在盘中才有意义（做T、盯盘等）；模型没给时为 undefined，界面按关键词判断。 */
      sessionOnly?: boolean;
      model: string;
    }>;
    test(input: { id?: string | null; baseUrl: string; model: string; apiKey?: string }): Promise<{ ok: boolean; latency: number; model: string }>;
    profiles(): Promise<AiProfileList>;
    saveProfile(input: { id?: string | null; name: string; baseUrl: string; model: string; apiKey?: string; activate?: boolean }): Promise<AiProfileList & { saved: AiProfile }>;
    deleteProfile(id: string): Promise<AiProfileList>;
    activateProfile(id: string): Promise<AiProfileList>;
    setRankModels(ids: string[]): Promise<AiProfileList>;
    history(): Promise<{ asOfDate: string; rankModels: string[]; customModels?: string[] | undefined; hasSummary: boolean; savedAt: string }[]>;
    historyDay(asOfDate: string): Promise<{ asOfDate: string; rank: AiRanking | null; custom?: AiRanking | null | undefined; summary: AiSummary | null }>;
    review?(input: { security: { code: string; name: string }; force?: boolean; context?: string[] }): Promise<AiRanking>;
    cachedReview?(code: string): Promise<AiRanking | null>;
    customList?(): Promise<AiCustomStock[]>;
    saveCustomList?(items: AiCustomStock[]): Promise<AiCustomStock[]>;
    mutateCustomList?(input: AiCustomListMutation): Promise<AiCustomListMutationResult>;
    rankCustom?(input?: { force?: boolean; codes?: string[] | undefined }): Promise<AiRanking & { failed?: string[] | undefined }>;
    cachedCustom?(): Promise<AiRanking | null>;
    frameworks?(): Promise<AiFrameworkCatalog>;
    saveFramework?(input: { active?: AiFrameworkInfo["id"]; custom?: AiCustomFramework }): Promise<AiFrameworkCatalog>;
    marketReview?(input?: { force?: boolean }): Promise<AiMarketReview>;
    lookback?(input?: { force?: boolean }): Promise<AiLookback>;
    cachedMarketReview?(asOfDate: string): Promise<{ review: AiMarketReview | null; lookback: AiLookback | null; previousDate: string }>;
    interpret?(input: { kind: AiInterpretKind; data: unknown; asOfDate?: string; force?: boolean }): Promise<AiInterpretation>;
    cachedInterpret?(input: { kind: AiInterpretKind; asOfDate?: string }): Promise<AiInterpretation | null>;
    outcomesLeaderboard?(input?: { days?: number }): Promise<AiOutcomesLeaderboard>;
    onStream?(listener: (event: AiStreamEvent) => void): () => void;
    agent?: {
      feeds?(input?: { op?: "list" | "save" | "remove" | "test"; id?: string; name?: string; url?: string; enabled?: boolean }): Promise<{ feeds: Array<{ id: string; name: string; url: string; enabled: boolean }>; maxFeeds: number; test?: { count: number; sample: string[] } }>;
      signals?(input?: { status?: string; code?: string; evaluate?: boolean }): Promise<DecisionSignalList>;
      updateSignal?(input: { id: string; status?: "closed" | "invalidated"; feedback?: "useful" | "not_useful" | null; remove?: boolean }): Promise<DecisionSignalList>;
      state(): Promise<AgentState>;
      conversation(id: string): Promise<AgentConversation | null>;
      start(input: {
        message: string;
        conversationId?: string | undefined;
        focus?: AgentFocus | null | undefined;
        title?: string | undefined;
        skillIds?: string[] | undefined;
        userContext?: Record<string, unknown> | undefined;
        allowPersonalContext?: boolean | undefined;
      }): Promise<{ runId: string; conversationId: string }>;
      poll(runId: string): Promise<AgentRun>;
      cancel(runId: string): Promise<AgentRun | null>;
      remove(id: string): Promise<AgentState>;
      settings(input: { memory?: string; profileId?: string; skillIds?: string[] }): Promise<AgentState>;
      saveSkill?(input: { id?: string | undefined; name: string; method: string; tools: string[] }): Promise<AgentState>;
      removeSkill?(id: string): Promise<AgentState>;
      syncWorkspace?(input: { tItems?: unknown[]; plans?: unknown[]; paperPositions?: unknown[]; notes?: unknown[] }): Promise<{ ok: boolean; updatedAt: string }>;
    };
  };
  thsWeb?: {
    show(options: { bounds: { x: number; y: number; width: number; height: number }; page?: "hsgt" | "login" }): Promise<ThsWebBridgeState>;
    setBounds(options: { bounds: { x: number; y: number; width: number; height: number } }): Promise<ThsWebBridgeState>;
    hide(): Promise<ThsWebBridgeState>;
    command(options: { action: "home" | "login" | "reload" | "back" | "external" | "logout" }): Promise<ThsWebBridgeState>;
    state(): Promise<ThsWebBridgeState>;
  };
  getChart(
    security: Security | string,
    interval: string,
    options?: { range?: string; limit?: number; adjustment?: string; forceRefresh?: boolean; requestId?: string; timeoutMs?: number }
  ): Promise<{
    rows: ChartCandleRow[];
    interval: string;
    range: string;
    visibleLimit: number;
    source: string;
    sourceClass: string;
    dataSource: string;
    adjustment: string;
    updatedAt: string;
    availableFrom: string;
    availableTo: string;
    isPartial: boolean;
    note: string;
    preClose?: number | null;
    unitsPerLot?: number;
    volumeUnit?: string;
    [key: string]: unknown;
  }>;
  discoverLimitUps(options?: { forceRefresh?: boolean }): Promise<{
    rows: Array<Record<string, unknown>>;
    meta: { dataDate: string; fetchedAt: string; providers: string[]; [key: string]: unknown };
  }>;
  getLimitUpPoolSnapshot(options?: { forceRefresh?: boolean }): Promise<{
    rows: Array<Record<string, unknown>>;
    meta: { dataDate: string; fetchedAt: string; providers: string[]; [key: string]: unknown };
  }>;
  getPreviousLimitUpFailedBoardSnapshot(options?: { forceRefresh?: boolean; refreshDate?: string }): Promise<PreviousLimitUpFailedBoardSnapshot>;
  discoverRecentLimitUps(days?: number, options?: { forceRefresh?: boolean }): Promise<WatchItem[]>;
  getLimitUpSectorBoard(options?: { forceRefresh?: boolean }): Promise<Array<Record<string, unknown> & { name: string }>>;
  getSectorStrengthBoard?(options?: { forceRefresh?: boolean }): Promise<SectorStrengthBoard>;
  getSectorLimitUpCount?(
    input: { boardType: "industry" | "concept"; name: string; code?: string; indexCode?: string; conceptCid?: string; memberCount?: number | null },
    options?: { forceRefresh?: boolean }
  ): Promise<SectorLimitCount>;
  searchSectors(query: string): Promise<Array<Record<string, unknown> & { name: string }>>;
  getConceptChain(query: string | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  analyzeSector(sector: string | Record<string, unknown>): Promise<Record<string, unknown> & {
    name?: string | undefined;
    constituents?: Array<Record<string, unknown>> | undefined;
    limitCount?: SectorLimitCount | null | undefined;
  }>;
  getProfessionalReview(options?: { refresh?: boolean }): Promise<Record<string, unknown>>;
  getExternalFactorArchive?(): Promise<ExternalFactorArchiveSummary>;
  openProfessionalReviewWindow?(): Promise<{ ok: boolean }>;
  getReviewTheme?(): Promise<{ theme: string }>;
  onThemeChange?(handler: (theme: string) => void): () => void;
  getNewsFeed(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  refreshNewsFeed(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  analyzeNewsImpact?(input: Record<string, unknown>): Promise<NewsAiImpact>;
  getStrategyDefinitions(): Promise<StrategyDefinitionItem[] | { strategies?: StrategyDefinitionItem[]; definitions?: StrategyDefinitionItem[] }>;
  listCustomStrategies?(): Promise<CustomStrategy[]>;
  saveCustomStrategy?(strategy: CustomStrategy): Promise<{ strategy: CustomStrategy; strategies: CustomStrategy[] }>;
  deleteCustomStrategy?(id: string): Promise<{ strategies: CustomStrategy[] }>;
  importSettingsStrategy?(): Promise<{ strategy: CustomStrategy; strategies: CustomStrategy[] }>;
  cancelServiceJob(requestId: string): Promise<boolean>;
  runPortfolioBacktest(options: {
    requestId?: string;
    securities: Security[];
    universe: string[];
    strategyIds: string[];
    minimumVotes: number;
    strategyContext: {
      source: string;
      strategyEngine: string;
      strategyId: string;
      strategyName: string;
      strategyVersion?: string;
      strategyIds: string[];
      minimumVotes: number;
    };
    universeSource?: "strategy_current_matches" | "manual";
    startingCapital: number;
    maxPositions: number;
    lookbackBars: number;
    commissionBps: number;
    slippageBps: number;
    benchmark: string;
    accountMode: "shared_cash";
    lotSize: number;
  }): Promise<PortfolioBacktestResult>;
  runBacktest(
    security: Security | string,
    options?: {
      requestId?: string;
      startDate?: string;
      customEntryPrice?: number | null;
      lookbackBars?: number;
      benchmarks?: number;
      benchmark?: "all" | "szzs" | "hs300";
      minSamples?: number;
      minProjectedNetEdgePercent?: number;
      minExpectancyPoints?: number;
      commissionBps?: number;
      slippageBps?: number;
      signalStrategyIds?: string[];
      strategyContext?: {
        source?: "single_strategy" | "optimized_portfolio";
        strategyEngine?: "verified-signal-v2";
        strategyId: string;
        strategyName: string;
        strategyVersion?: string;
        strategyIds: string[];
        minimumVotes: number;
      };
      settings?: Partial<Settings>;
    }
  ): Promise<Record<string, unknown>>;
  scanStrategySignals(options?: {
    requestId?: string;
    strategyIds?: string[];
    lookbackDays?: number;
    historyBars?: number;
    maxUniverse?: number;
    maxStocksPerStrategy?: number;
    minSamples?: number;
    minOutOfSampleSamples?: number;
    minIndependentSignalDays?: number;
    minWalkForwardFoldSamples?: number;
    walkForwardFolds?: number;
    refresh?: boolean;
  }): Promise<StrategySignalScanResult>;
  startTrendScan(options?: TrendScanRequest): Promise<TrendScanStatus>;
  evaluateTrendResearch(options: {
    requestId?: string;
    dataset: unknown;
    from: string;
    to: string;
    splitDate: string;
    advancedStrategyId?: string;
    advancedConfig?: unknown;
  }): Promise<StrategySignalScanResult>;
  checkTrendExecution(options: { security: Security; signalDate: string }): Promise<TrendExecutionCheck>;
  getTrendScan(): Promise<TrendScanStatus>;
  getTrendScan(cursor: TrendScanCursor): Promise<TrendScanSnapshot>;
  cancelTrendScan(): Promise<TrendScanStatus>;
  getWatchlist(): Promise<WatchItem[]>;
  saveWatchlist(items: WatchItem[]): Promise<WatchItem[]>;
  getHoldings(): Promise<HoldingItem[]>;
  getCorruptedOnLoad?(): Promise<string[]>;
  saveHoldings(items: HoldingItem[]): Promise<HoldingItem[]>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  testProvider(settings: Settings): Promise<{ ok: boolean; provider?: string; latency?: number; message?: string; error?: string; [key: string]: unknown }>;
  setTheme(theme: Settings["theme"]): Promise<void>;
  setZoomFactor?(factor: number): Promise<{ factor: number }>;
  controlWindow(action: "minimize" | "toggle-maximize" | "close"): Promise<{ ok: boolean; maximized: boolean }>;
  notify?(message: {
    title: string;
    body?: string;
    code?: string;
    name?: string;
    secid?: string;
    targetView?: string;
  }): Promise<{ shown: boolean }>;
  onNotificationClick?(listener: (payload: { code?: string; name?: string; secid?: string; targetView?: string }) => void): () => void;
  kvGet?(key: string): Promise<string | null>;
  kvSet?(key: string, value: string): Promise<boolean>;
  cleanupStorageCache?(input: { target: "web-cache" | "stale-bars" | "daily-bars" | "legacy-profile" }): Promise<{
    ok: boolean;
    message: string;
    summary?: { userDataBytes: number; dailyBarsBytes: number; dailyBarsCount: number; webCacheBytes: number };
  }>;
  getMasterPasswordStatus?(): Promise<{ enabled: boolean; locked: boolean }>;
  setMasterPassword?(input: { newPassword: string; currentPassword?: string }): Promise<{ enabled: boolean; locked: boolean }>;
  unlockMasterPassword?(input: { password: string } | string): Promise<{ enabled: boolean; locked: boolean }>;
  clearMasterPassword?(input: { currentPassword: string } | string): Promise<{ enabled: boolean; locked: boolean }>;
  syncNoteIntervals?(input: {
    items: Array<{ id: string; text: string; at: number; intervalMinutes: number; sessionOnly?: boolean }>;
    systemNotify: boolean;
  }): Promise<Array<{ id: string; at: number; lastFiredAt: number | null; nextAt: number; skipped?: boolean }>>;
  notesWatch?(input: {
    items: Array<{ id: string; code: string; name: string; secid: string; text: string; condition: { field: "latest" | "changePct"; op: "lte" | "gte"; value: number } }>;
    systemNotify: boolean;
  }): Promise<{ hits: Array<{ id: string; at: string; detail: string }>; watching: number; session: boolean; error?: string }>;
  backup?: BackupApi;
  openExternal(url: string): Promise<void>;
  getPlatform(): "win32" | "darwin" | "linux" | string;
  getVersion(): Promise<string>;
  getRuntimeInfo?(): RuntimeInfo;
};

/** Decode an untrusted IPC record payload safely at renderer/preview boundaries. */
export function decodePlainRecord(input: unknown, label = "IPC 载荷"): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label}必须为对象`);
  }
  return input as Record<string, unknown>;
}

/** Decode an untrusted IPC array payload safely at renderer/preview boundaries. */
export function decodeArrayPayload<T = unknown>(input: unknown, label = "IPC 列表"): T[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${label}必须为数组`);
  }
  return input as T[];
}
