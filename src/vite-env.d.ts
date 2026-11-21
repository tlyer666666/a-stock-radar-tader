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
  [key: string]: unknown;
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
  sellableShares?: number | undefined;
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
type SectorStrengthBoard = { fetchedAt: string; industries: Array<Record<string, unknown>>; concepts: SectorConceptRow[]; themes: SectorTheme[]; limitUpTotal: number | null; conceptLimitUpSource: string; warnings: string[] };
type AiSelectionInput = { asOfDate: string; picks: AiPick[]; strategyCounts?: { name: string; count: number }[]; force?: boolean; only?: string[] | undefined };
type AiDisagreementDetail = {
  spread: number;
  highest: { model: string; score: number; rating?: string | undefined; thesis?: string | undefined; highlights: string };
  lowest: { model: string; score: number; rating?: string | undefined; thesis?: string | undefined; risks: string };
  verificationPoint?: string | undefined;
  summary: string;
};
type AiStockOutcome = {
  t1: number | null;
  t3: number | null;
  t5: number | null;
  maxDrawdownPct?: number | null | undefined;
  stopHit?: boolean | undefined;
  baseClose?: number;
  asOfDate?: string;
  latestDate?: string;
};
type AiOutcomeBucket = { count: number; wins: number; winRatePct: number; avgPct: number } | null;
type AiOutcomeSummary = {
  evaluatedCount: number;
  t1: AiOutcomeBucket;
  t3: AiOutcomeBucket;
  t5: AiOutcomeBucket;
  avgDrawdownPct?: number | null | undefined;
  stopHits?: number | undefined;
  stopHitRatePct?: number | null | undefined;
};
type AiLeaderboardRow = {
  key: string;
  label: string;
  sublabel?: string;
  totalScored: number;
  sampleCount: number;
  highScoreMisses: number;
  missRatePct: number | null;
  avgDrawdownPct?: number | null | undefined;
  stopHits?: number | undefined;
  stopHitRatePct?: number | null | undefined;
  t1: AiOutcomeBucket;
  t3: AiOutcomeBucket;
  t5: AiOutcomeBucket;
};
type NewsAiImpact = {
  headline: string;
  impactLevel: "高" | "中" | "低";
  direction: "利好" | "利空" | "多空交织" | "中性";
  supplyChain: { upstream: string[]; downstream: string[]; peers: string[] };
  portfolioExposure: string[];
  actionWatch: string[];
  model: string;
};
type RegimeWeightProfile = {
  regimeId: "ice" | "climax" | "ferment" | "rotation";
  regimeLabel: string;
  summary: string;
  factorWeights: { trend: number; volume: number; emotion: number; sector: number; defensive: number };
  backtestPreset: {
    label: string;
    lookbackBars: number;
    minProjectedNetEdgePercent: number;
    minExpectancyPoints: number;
    minTurnoverPercent: number;
    note: string;
  };
};
type ExternalFactorArchiveSummary = {
  days: number;
  latestDate: string;
  latestSnapshot: Record<string, unknown> | null;
  regimeAdvice: RegimeWeightProfile;
};
type AiMissLesson = {
  asOfDate: string;
  code: string;
  name: string;
  score: number;
  rating: string;
  model: string;
  framework: string;
  cycle: string;
  t1: number | null;
  t3: number | null;
  t5: number | null;
  maxDrawdownPct?: number | null | undefined;
  stopHit?: boolean | undefined;
  lesson: string;
};
type AiOutcomesLeaderboard = {
  daysCovered: number;
  evaluatedSamples: number;
  byModel: AiLeaderboardRow[];
  byFramework: AiLeaderboardRow[];
  byCycle: AiLeaderboardRow[];
  recentMisses: AiMissLesson[];
  recentLessons: string[];
  lookbackStats: { count: number; avgHitRatePct: number | null; recentLessons: string[] };
};
type AiRankItem = { fallback?: boolean | undefined; code: string; name: string; score: number; rating: "重点关注" | "关注" | "观望" | "回避"; highlights: string; risks: string; nextDay: string;
  trend?: string | undefined; volume?: string | undefined; keyLevels?: string | undefined;
  base?: number | undefined; adjust?: number | undefined; reason?: string | undefined; framework?: string | undefined; dims?: AiDimScore[] | undefined; caps?: string[] | undefined;
  plays?: AiPlayPick[] | undefined; situation?: string[] | undefined; orchestration?: string | undefined;
  scores?: { id: string; name: string; score: number; rating: string }[]; spread?: number; disagreement?: boolean;
  disagreementDetail?: AiDisagreementDetail | undefined; outcome?: AiStockOutcome | undefined };
type AiCustomStock = { code: string; name: string };
type AiCustomListMutation = { kind: "add"; items: Array<{ code: string; name?: string | undefined }> } | { kind: "remove"; codes: string[] };
type AiCustomListMutationResult = { list: AiCustomStock[]; added: number; duplicate: number; overflow: number; removed: AiCustomStock[] };
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
type AgentFocus = { code: string; name: string; kind?: "etf" | "sector" | "market" };
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
  memoryCandidates?: string[] | undefined;
  skills?: AgentSkillTag[] | undefined; skillVerdicts?: AgentSkillVerdict[] | undefined; persistenceError?: string | undefined;
};
type AgentConversationSummary = { id: string; title: string; focus: AgentFocus | null; createdAt: string; updatedAt: string; turns: number; stance?: AgentStance | undefined; preview?: string | undefined; running?: boolean | undefined };
type AgentConversation = { id: string; title: string; focus: AgentFocus | null; createdAt: string; updatedAt: string; messages: AgentMessage[]; runningRunId?: string | undefined; persistenceError?: string | undefined };
type AgentState = {
  configured: boolean; model: string; profileName: string; profileId: string; activeProfileId: string;
  profiles: { id: string; name: string; model: string }[]; memory: string; conversations: AgentConversationSummary[]; tools: { id: string; name: string }[];
  skills?: AgentSkillCatalog | undefined; skillIds?: string[] | undefined; savedSkillId?: string | undefined; persistenceError?: string | undefined;
};
type AgentRun = { runId: string; conversationId: string; status: "running" | "done" | "error" | "cancelled"; steps: AgentStep[]; startedAt: string; elapsedMs: number; model: string;
  streamText?: string | undefined; message?: AgentMessage | undefined; error?: string | undefined; persistenceError?: string | undefined };
type AiStreamEvent =
  | { channel: "agent"; runId: string; conversationId: string; phase: "token" | "step" | "status"; text?: string; steps?: AgentStep[]; elapsedMs?: number }
  | { channel: "market-review"; phase: "token" | "step"; round?: number; thought?: string; text?: string; steps?: AiSkillStep[]; pendingStep?: AiSkillStep }
  | { channel: "interpret"; kind: AiInterpretKind; asOfDate?: string; phase: "token"; text?: string };
type AiInterpretation = AiStamp & { kind: AiInterpretKind; title: string; headline: string; points: string[]; risks: string[]; watch: string[] };
type AiNotice = { date: string; title: string; direction: "利好" | "利空" | "多空交织" | "中性"; risk: number };
type AiRankModel = { id: string; name: string; model: string; ok: boolean; cached?: boolean; generatedAt?: string; evaluated?: number; error?: string; missed?: number };
type AiRanking = { asOfDate: string; model: string; generatedAt: string; items: AiRankItem[]; evaluated: number; cached?: boolean; models?: AiRankModel[]; failed?: string[] | undefined;
  profiles?: AiStockProfile[] | undefined; profile?: AiStockProfile | undefined; framework?: string | undefined; outcomeSummary?: AiOutcomeSummary | undefined };
type AiSummary = { asOfDate: string; model: string; generatedAt: string; headline: string; market: string; themes: { name: string; stocks: string[] }[];
  focus: { code: string; name: string; reason: string }[]; risks: string[]; cached?: boolean };
type ThsWebState = import("./shared/ipc-contract").ThsWebBridgeState;

interface Window {
  stockApi: import("./shared/ipc-contract").StockApi;
  __aStockOpenSettings?: ((category?: string) => void) | undefined;
}
