/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

type Security = {
  code: string;
  name: string;
  secid: string;
  thscode?: string;
  marketName?: string;
  assetType?: "stock" | "etf" | "convertibleBond";
  defaultVisible?: boolean;
};

type PortfolioBacktestSignalEvent = {
  sampleId?: string;
  code: string;
  name: string;
  strategyId?: string;
  strategyIds?: string[];
  strategyNames?: string[];
  signalDate: string;
  entryDate?: string;
  exitDate?: string;
  status: "filled" | "rejected" | "pending" | string;
  reason?: string;
  reasonText?: string;
  allocation?: number;
  shares?: number;
  pnl?: number;
  netReturnPercent?: number;
};

type PortfolioBacktestSignalDateGroup = {
  signalDate: string;
  date?: string;
  events?: PortfolioBacktestSignalEvent[];
  signals?: PortfolioBacktestSignalEvent[];
  items?: PortfolioBacktestSignalEvent[];
};

type PortfolioBacktestResult = {
  signalEvents?: PortfolioBacktestSignalEvent[];
  signalTimeline?: Array<PortfolioBacktestSignalEvent | PortfolioBacktestSignalDateGroup>;
  signals?: PortfolioBacktestSignalEvent[];
  [key: string]: any;
};

type WatchItem = Security & {
  createdAt: string;
  note?: string;
  limitDate?: string;
  tradingDaysSince?: number;
  observationNode?: string;
  consecutiveBoards?: number;
  autoAdded?: boolean;
  favorite?: boolean;
  favoriteAddedAt?: string;
};

type HoldingItem = Security & {
  shares: number;
  costPrice: number;
  createdAt: string;
  updatedAt: string;
  note?: string;
};

type Settings = {
  riskProfile: "conservative" | "balanced" | "aggressive";
  provider: "eastmoney" | "ths";
  refreshToken: string;
  tushareToken: string;
  fuyaoApiKey?: string;
  aiBaseUrl?: string;
  aiModel?: string;
  aiApiKey?: string;
  aiRankInstructions?: string;
  aiSummaryInstructions?: string;
  multiSourceEnabled: boolean;
  fallbackEnabled: boolean;
  quoteRefreshSeconds: number;
  refreshSeconds: number;
  newsRefreshSeconds: number;
  newsVoiceEnabled: boolean;
  alertScore: number;
  exactNodesOnly: boolean;
  strictGate: boolean;
  maxPositionPercent: number;
  maxRiskPerTradePercent: number;
  stopLossATRMultiple: number;
  takeProfitATRMultiple: number;
  maxHoldingBars: number;
  minMarketCap: number;
  maxDailyRiskPercent?: number;
  maxPortfolioRiskPercent?: number;
  minProjectedNetEdgePercent?: number;
  minExpectancyPoints?: number;
  maxConsecutiveLossesForStop?: number;
  maxDailyTrades?: number;
  lossStreakStepPercent?: number;
  lossStreakFloorPercent?: number;
  minPaperWinRatePercent?: number;
  minExecutionRatePercent?: number;
  minPaperRiskRewardRatio?: number;
  maxSectorExposurePercent?: number;
  minTurnoverPercent?: number;
  minQuoteAmount?: number;
  maxQuoteAgeSeconds?: number;
  trailingStopPercent?: number;
  commissionBps?: number;
  slippageBps?: number;
  timeDecayPerBarPercent?: number;
  maxOpenPositions?: number;
  enabledPaperSim?: boolean;
  selectedStrategies: string[];
  theme: "light" | "dark" | "system";
};

type PreviousLimitUpFailedBoardStatus = "ready" | "awaiting-confirmation" | "unavailable";

type PreviousLimitUpFailedBoardSource = {
  providers: string[];
  requestedDate: string | null;
  sourceTradingDate: string | null;
  sourceLatestDate?: string | null;
  fetchedAt: string | null;
};

type FailedBoardDayRow = {
  code: string;
  name: string;
  industry: string;
  consecutiveBoards: number | null;
  firstSealTime: string | null;
  lastSealTime: string | null;
  openBoardCount: number | null;
  latest: number | null;
  changePct: number | null;
  amount: number | null;
  turnover: number | null;
};

type FailedBoardDaySnapshot = {
  date: string;
  status: PreviousLimitUpFailedBoardStatus;
  rows: FailedBoardDayRow[];
  source: {
    providers: string[];
    requestedDate: string;
    sourceLatestDate: string | null;
    fetchedAt: string | null;
  } | null;
  error: string | null;
};

type PreviousLimitUpFailedBoardRow = {
  code: string;
  name: string;
  industry: string;
  previous: {
    consecutiveBoards: number | null;
    firstSealTime: string | null;
    lastSealTime: string | null;
    openBoardCount: number | null;
    boardType: string | null;
    isOneWordBoard: boolean | null;
  };
  today: {
    latest: number | null;
    changePct: number | null;
    amount: number | null;
    turnover: number | null;
    firstSealTime: string | null;
    lastSealTime: string | null;
    openBoardCount: number | null;
  };
};

type PreviousLimitUpFailedBoardSnapshot = {
  status: PreviousLimitUpFailedBoardStatus;
  previousDate: string | null;
  currentDate: string | null;
  rows: PreviousLimitUpFailedBoardRow[];
  failedBoardDays: FailedBoardDaySnapshot[];
  sources: {
    previousLimitUp: PreviousLimitUpFailedBoardSource | null;
    todayFailed: PreviousLimitUpFailedBoardSource | null;
  };
  errors: {
    previousLimitUp: string | null;
    todayFailed: string | null;
  };
  checkedAt: string;
  isPreview: boolean;
  previewLabel?: string;
};

type MarketSourceHealthEntry = {
  id: string;
  name: string;
  kind: string;
  status: "ok" | "degraded" | "open" | "idle";
  consecutiveFailures: number;
  retryAt: string | null;
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastError: string;
  lastLatencyMs: number | null;
  successCount: number;
  failureCount: number;
};

type MarketSourceHealth = {
  checkedAt: string;
  quotes: MarketSourceHealthEntry[];
  history: MarketSourceHealthEntry[];
};

type AiProfile = { id: string; name: string; baseUrl: string; model: string; hasKey: boolean };
type AiProfileList = { activeId: string; rankIds?: string[]; profiles: AiProfile[]; max: number };
type AiPick = { code: string; name: string; industry?: string | undefined; latest?: number | null | undefined; changePct?: number | null | undefined; turnover?: number | null | undefined; amount?: number | null | undefined;
  limitDate?: string | undefined; daysSinceLimit?: number | null | undefined; consecutiveBoards?: number | null | undefined; signalStrength?: number | null | undefined; overheatCount?: number | null | undefined;
  strategies: string[]; notes?: string[] | undefined; reasons?: string[] | undefined };
/** 板块强度：行业 + 概念两张榜、今日涨停主线（1.6.43）。 */
type SectorLimitStock = { code: string; name: string; boards?: number | undefined };
type SectorConceptRow = { kind: "concept"; id: string; code: string; conceptCid: string; indexCode: string; name: string; changePct: number; netInflow: number | null;
  memberCount: number | null; leaderName: string; limitUps: number | null; limitUpStocks: SectorLimitStock[] };
type SectorTheme = { reason: string; count: number; stocks: SectorLimitStock[]; concept?: { name: string; code: string; conceptCid: string } | undefined };
type SectorLimitCount = { limitUps: number | null; limitUpStocks: { code: string; name: string }[]; memberCount: number | null; countComplete: boolean; asOfDate: string | null; fetchedAt: string; source: string; warning: string };
type SectorStrengthBoard = { fetchedAt: string; industries: any[]; concepts: SectorConceptRow[]; themes: SectorTheme[]; limitUpTotal: number | null; conceptLimitUpSource: string; warnings: string[] };
type AiSelectionInput = { asOfDate: string; picks: AiPick[]; strategyCounts?: { name: string; count: number }[]; force?: boolean; only?: string[] | undefined };
type AiRankItem = { fallback?: boolean | undefined; code: string; name: string; score: number; rating: "重点关注" | "关注" | "观望" | "回避"; highlights: string; risks: string; nextDay: string;
  trend?: string | undefined; volume?: string | undefined; keyLevels?: string | undefined;
  base?: number | undefined; adjust?: number | undefined; reason?: string | undefined; framework?: string | undefined; dims?: AiDimScore[] | undefined; caps?: string[] | undefined;
  plays?: AiPlayPick[] | undefined; situation?: string[] | undefined; orchestration?: string | undefined;
  scores?: { id: string; name: string; score: number; rating: string }[]; spread?: number; disagreement?: boolean };
type AiCustomStock = { code: string; name: string };
type AiDimScore = { id: string; label: string; weight: number; score: number; note: string };
/** AI 自动编排时为一只股票选用的策略（权重合计 100）。 */
type AiPlayPick = { id: string; name: string; weight: number; base: number; fit: number };
type AiFrameworkInfo = { id: string; name: string; description: string; guidance: string;
  dimensions: { id: string; label: string; detail: string; weight: number }[]; caps: { id: string; label: string }[] };
type AiCustomFramework = { name: string; weights: Record<string, number>; caps: string[]; note: string };
type AiFrameworkCatalog = { active: AiFrameworkInfo["id"]; custom: AiCustomFramework; frameworks: AiFrameworkInfo[];
  dimensions: { id: string; label: string; detail: string }[]; caps: { id: string; label: string }[] };
type AiPriceLevel = { label: string; price: number };
/** 任意股票的「体检数据」（主进程用日线算出）；「我的股票」表里只保存其中几项。 */
type AiStockProfile = { code: string; name: string; industry?: string; asOfDate: string; latest: number | null; changePct: number | null;
  return5: number | null; return20: number | null; volumeRatio: number | null; trend: string; limitUps20: number | null; consecutiveBoards: number | null;
  daysSinceLimit: number | null; limitReason?: string; return60?: number | null; turnover?: number | null; amountYi?: number | null; avgAmount20Yi?: number | null;
  broken20?: number | null; lastLimitDate?: string; fromHigh20Pct?: number | null; fromLow20Pct?: number | null;
  ma?: Record<"ma5" | "ma10" | "ma20" | "ma60", number | null>; support?: AiPriceLevel[]; resistance?: AiPriceLevel[];
  rsi14?: number | null; bias5?: number | null; alignment?: string; macdCross?: string;
  announcements?: AiNotice[]; announcementsAvailable?: boolean; noticeCount?: number | null; noticeNegative?: number | null; noticeRisk?: boolean };
type AiStamp = { asOfDate: string; model: string; generatedAt: string; cached?: boolean };
type AiMarketReview = AiStamp & { headline: string; market: string; cycle: { phase: string; reason: string }; mainlines: { name: string; comment: string }[];
  ladder: string; indices: string; nextDay: { posture: string; focus: string[]; avoid: string[] }; risks: string[]; confidence: "高" | "中" | "低"; softwareRegime: string;
  /** 1.6.44：AI 自主调用复盘技能时的分析过程（每一轮的思路和调用的技能）。 */
  mode?: "skills" | undefined; steps?: AiSkillStep[] | undefined };
type AiSkillStep = { thought: string; calls: { skill: string; name: string; ok: boolean; summary: string; args: string }[] };
type AiLookback = AiStamp & { previousDate: string; previousHeadline: string; summary: string; verdicts: { claim: string; result: "兑现" | "部分兑现" | "未兑现" | "无法判断"; evidence: string }[];
  lessons: string[]; hitRatePct: number | null; judged: number };
type AiInterpretKind = "ecology" | "failed-boards" | "sectors";
type AgentFocus = { code: string; name: string };
type AgentStepCall = { tool: string; name: string; args: string; status: "running" | "ok" | "failed"; summary: string };
type AgentStep = { kind: "prefetch" | "tools" | "answer"; thought: string; calls: AgentStepCall[] };
type AgentStance = "偏多" | "中性" | "偏空" | "回避" | "不适用";
type AgentSkillTag = { id: string; name: string };
type AgentSkillVerdict = { skill: string; id: string; verdict: "符合" | "接近" | "不符合" | "不适用"; reason: string };
type AgentSkill = { id: string; name: string; group: string; summary: string; custom: boolean; tools: string[]; method?: string | undefined; toolIds?: string[] | undefined };
type AgentSkillCatalog = { groups: string[]; skills: AgentSkill[]; maxSelected: number; maxCustom: number };
type AgentMessage = {
  id: string; role: "user" | "assistant"; content: string; at: string; focus?: AgentFocus | undefined;
  stance?: AgentStance | undefined; confidence?: "高" | "中" | "低" | undefined; followUps?: string[] | undefined; steps?: AgentStep[] | undefined;
  model?: string | undefined; durationMs?: number | undefined; error?: boolean | undefined; cancelled?: boolean | undefined; fallback?: boolean | undefined;
  skills?: AgentSkillTag[] | undefined; skillVerdicts?: AgentSkillVerdict[] | undefined; persistenceError?: string | undefined;
};
type AgentConversationSummary = { id: string; title: string; focus: AgentFocus | null; createdAt: string; updatedAt: string; turns: number; stance?: AgentStance | undefined; running?: boolean | undefined };
type AgentConversation = { id: string; title: string; focus: AgentFocus | null; createdAt: string; updatedAt: string; messages: AgentMessage[]; runningRunId?: string | undefined; persistenceError?: string | undefined };
type AgentState = {
  configured: boolean; model: string; profileName: string; profileId: string; activeProfileId: string;
  profiles: { id: string; name: string; model: string }[]; memory: string; conversations: AgentConversationSummary[]; tools: { id: string; name: string }[];
  skills?: AgentSkillCatalog | undefined; skillIds?: string[] | undefined; savedSkillId?: string | undefined; persistenceError?: string | undefined;
};
type AgentRun = { runId: string; conversationId: string; status: "running" | "done" | "error" | "cancelled"; steps: AgentStep[]; startedAt: string; elapsedMs: number; model: string;
  message?: AgentMessage | undefined; error?: string | undefined; persistenceError?: string | undefined };
type AiInterpretation = AiStamp & { kind: AiInterpretKind; title: string; headline: string; points: string[]; risks: string[]; watch: string[] };
type AiNotice = { date: string; title: string; direction: "利好" | "利空" | "多空交织" | "中性"; risk: number };
type AiRankModel = { id: string; name: string; model: string; ok: boolean; cached?: boolean; generatedAt?: string; evaluated?: number; error?: string; missed?: number };
type AiRanking = { asOfDate: string; model: string; generatedAt: string; items: AiRankItem[]; evaluated: number; cached?: boolean; models?: AiRankModel[]; failed?: string[] | undefined;
  profiles?: AiStockProfile[] | undefined; profile?: AiStockProfile | undefined; framework?: string | undefined };
type AiSummary = { asOfDate: string; model: string; generatedAt: string; headline: string; market: string; themes: { name: string; stocks: string[] }[];
  focus: { code: string; name: string; reason: string }[]; risks: string[]; cached?: boolean };
type ThsWebState = { open: boolean; url: string; title: string; loading: boolean; canGoBack: boolean; error: string };

interface Window {
  stockApi: import("./sectorExplorerTypes").SectorExplorerApi & {
    search(query: string): Promise<Security[]>;
    analyze(security: Security | string, options?: { forceRefresh?: boolean }): Promise<any>;
    getQuoteSnapshot(security: Security | string): Promise<any>;
    getDataFederation(security: Security | string): Promise<any>;
    getMarketSourceHealth?(): Promise<MarketSourceHealth>;
    getConvertibleBonds?(options?: { forceRefresh?: boolean; waitForQuotes?: boolean }): Promise<import("./features/bonds/bondTypes").ConvertibleBondSnapshot>;
    getLimitEcology?(options?: { forceRefresh?: boolean }): Promise<any>;
    ai?: {
      status(): Promise<{ configured: boolean; model: string; profile?: string; rankModels?: string[]; framework?: string }>;
      rank(input: AiSelectionInput): Promise<AiRanking>;
      summary(input: AiSelectionInput): Promise<AiSummary>;
      cached(input: AiSelectionInput): Promise<{ rank: AiRanking | null; summary: AiSummary | null }>;
      draftStrategy(input: { text: string; patterns: { id: string; name: string; detail?: string | undefined }[] }): Promise<{ strategy: any; notes: string; model: string }>;
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
      rankCustom?(input?: { force?: boolean; codes?: string[] | undefined }): Promise<AiRanking & { failed?: string[] | undefined }>;
      cachedCustom?(): Promise<AiRanking | null>;
      frameworks?(): Promise<AiFrameworkCatalog>;
      saveFramework?(input: { active?: AiFrameworkInfo["id"]; custom?: AiCustomFramework }): Promise<AiFrameworkCatalog>;
      marketReview?(input?: { force?: boolean }): Promise<AiMarketReview>;
      lookback?(input?: { force?: boolean }): Promise<AiLookback>;
      cachedMarketReview?(asOfDate: string): Promise<{ review: AiMarketReview | null; lookback: AiLookback | null; previousDate: string }>;
      interpret?(input: { kind: AiInterpretKind; data: unknown; asOfDate?: string; force?: boolean }): Promise<AiInterpretation>;
      cachedInterpret?(input: { kind: AiInterpretKind; asOfDate?: string }): Promise<AiInterpretation | null>;
      agent?: {
        state(): Promise<AgentState>;
        conversation(id: string): Promise<AgentConversation | null>;
        start(input: { message: string; conversationId?: string | undefined; focus?: AgentFocus | null | undefined; title?: string | undefined; skillIds?: string[] | undefined }): Promise<{ runId: string; conversationId: string }>;
        poll(runId: string): Promise<AgentRun>;
        cancel(runId: string): Promise<AgentRun | null>;
        remove(id: string): Promise<AgentState>;
        settings(input: { memory?: string; profileId?: string; skillIds?: string[] }): Promise<AgentState>;
        saveSkill?(input: { id?: string | undefined; name: string; method: string; tools: string[] }): Promise<AgentState>;
        removeSkill?(id: string): Promise<AgentState>;
      };
    };
    thsWeb?: {
      show(options: { bounds: { x: number; y: number; width: number; height: number }; page?: "hsgt" | "login" }): Promise<ThsWebState>;
      setBounds(options: { bounds: { x: number; y: number; width: number; height: number } }): Promise<ThsWebState>;
      hide(): Promise<ThsWebState>;
      command(options: { action: "home" | "login" | "reload" | "back" | "external" | "logout" }): Promise<ThsWebState>;
      state(): Promise<ThsWebState>;
    };
    getChart(
      security: Security | string,
      interval: string,
      options?: { range?: string; limit?: number; adjustment?: string; forceRefresh?: boolean; requestId?: string; timeoutMs?: number }
    ): Promise<{
      rows: any[];
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
    }>;
    discoverLimitUps(options?: { forceRefresh?: boolean }): Promise<{
      rows: any[];
      meta: { dataDate: string; fetchedAt: string; providers: string[] };
    }>;
    getLimitUpPoolSnapshot(options?: { forceRefresh?: boolean }): Promise<{
      rows: any[];
      meta: { dataDate: string; fetchedAt: string; providers: string[] };
    }>;
    getPreviousLimitUpFailedBoardSnapshot(options?: { forceRefresh?: boolean }): Promise<PreviousLimitUpFailedBoardSnapshot>;
    discoverRecentLimitUps(days?: number, options?: { forceRefresh?: boolean }): Promise<any[]>;
    getLimitUpSectorBoard(options?: { forceRefresh?: boolean }): Promise<any[]>;
    getSectorStrengthBoard?(options?: { forceRefresh?: boolean }): Promise<SectorStrengthBoard>;
    getSectorLimitUpCount?(input: { boardType: "industry" | "concept"; name: string; code?: string; indexCode?: string; conceptCid?: string; memberCount?: number | null }, options?: { forceRefresh?: boolean }): Promise<SectorLimitCount>;
    searchSectors(query: string): Promise<any[]>;
    getConceptChain(query: string | Record<string, any>): Promise<any>;
    analyzeSector(sector: any): Promise<any>;
    getProfessionalReview(options?: { refresh?: boolean }): Promise<any>;
    openProfessionalReviewWindow?(): Promise<{ ok: boolean }>;
    getReviewTheme?(): Promise<{ theme: string }>;
    onThemeChange?(handler: (theme: string) => void): () => void;
    getNewsFeed(input: Record<string, any>): Promise<any>;
    refreshNewsFeed(input: Record<string, any>): Promise<any>;
    getStrategyDefinitions(): Promise<any[] | { strategies?: any[]; definitions?: any[] }>;
    listCustomStrategies?(): Promise<import("./features/strategy-selection/customStrategyModel").CustomStrategy[]>;
    saveCustomStrategy?(strategy: import("./features/strategy-selection/customStrategyModel").CustomStrategy): Promise<{ strategy: import("./features/strategy-selection/customStrategyModel").CustomStrategy; strategies: import("./features/strategy-selection/customStrategyModel").CustomStrategy[] }>;
    deleteCustomStrategy?(id: string): Promise<{ strategies: import("./features/strategy-selection/customStrategyModel").CustomStrategy[] }>;
    importSettingsStrategy?(): Promise<{ strategy: import("./features/strategy-selection/customStrategyModel").CustomStrategy; strategies: import("./features/strategy-selection/customStrategyModel").CustomStrategy[] }>;
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
    ): Promise<any>;
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
    }): Promise<any>;
    startTrendScan(options?: import("./trendScreenerTypes").TrendScanRequest): Promise<import("./trendScreenerTypes").TrendScanStatus>;
    evaluateTrendResearch(options: { requestId?: string; dataset: unknown; from: string; to: string; splitDate: string; advancedStrategyId?: string; advancedConfig?: unknown }): Promise<any>;
    checkTrendExecution(options: { security: Security; signalDate: string }): Promise<import("./trendScreenerTypes").TrendExecutionCheck>;
    getTrendScan(): Promise<import("./trendScreenerTypes").TrendScanStatus>;
    getTrendScan(cursor: import("./trendScreenerTypes").TrendScanCursor): Promise<import("./trendScreenerTypes").TrendScanSnapshot>;
    cancelTrendScan(): Promise<import("./trendScreenerTypes").TrendScanStatus>;
    getWatchlist(): Promise<WatchItem[]>;
    saveWatchlist(items: WatchItem[]): Promise<WatchItem[]>;
    getHoldings(): Promise<HoldingItem[]>;
    saveHoldings(items: HoldingItem[]): Promise<HoldingItem[]>;
    getSettings(): Promise<Settings>;
    saveSettings(settings: Settings): Promise<Settings>;
    testProvider(settings: Settings): Promise<any>;
    setTheme(theme: Settings["theme"]): Promise<void>;
    controlWindow(
      action: "minimize" | "toggle-maximize" | "close"
    ): Promise<{ ok: boolean; maximized: boolean }>;
    /** 系统通知（随心记提醒）；旧版本没有这个接口。 */
    notify?(message: { title: string; body?: string }): Promise<{ shown: boolean }>;
    /** 数据备份（1.6.64）；类型见 src/features/backup/backupClient.ts。 */
    backup?: import("./features/backup/backupClient").BackupApi;
    openExternal(url: string): Promise<void>;
    getPlatform(): "win32" | "darwin" | "linux" | string;
    getVersion(): Promise<string>;
  };
}
