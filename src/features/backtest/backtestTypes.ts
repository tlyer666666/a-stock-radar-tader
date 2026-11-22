import type { BacktestExecutionReadiness } from "../../domain/executionReadiness";
import type { WorkspaceView } from "../../workspaceView";

export type BacktestBenchmark = "all" | "szzs" | "hs300";
export type StrategyBacktestRequest = {
  security?: Security;
  securities?: Security[];
  universeSource?: "strategy_current_matches" | "manual";
  universeTotalCount?: number;
  source: "single_strategy" | "optimized_portfolio";
  strategyEngine: "verified-signal-v2";
  strategyId: string;
  strategyName: string;
  strategyVersion?: string;
  strategyIds: string[];
  minimumVotes: number;
};

export type BacktestDraft = {
  securityCode: string;
  security?: Security | undefined;
  startDate: string;
  customEntryPrice: number | null;
  lookbackBars: number;
  benchmarks: number;
  benchmark: BacktestBenchmark;
  minSamples: number;
  minProjectedNetEdgePercent: number;
  minExpectancyPoints: number;
  minTurnoverPercent: number;
  minQuoteAmount: number;
  maxQuoteAgeSeconds: number;
  commissionBps: number;
  slippageBps: number;
  strategyContext?: StrategyBacktestRequest | undefined;
};
export type BacktestEntryContext = {
  security: Security | null;
  sourceView: WorkspaceView;
  sourceLabel: string;
  strategyIds: string[];
  strategyLabel?: string;
  capturedAt: string;
};
export type BacktestStrategyProfile = {
  selectedStrategies: string[];
  riskProfile: Settings["riskProfile"];
  minProjectedNetEdgePercent: number;
  minExpectancyPoints: number;
  minTurnoverPercent: number;
  minQuoteAmount: number;
  maxQuoteAgeSeconds: number;
  commissionBps: number;
  slippageBps: number;
  maxPositionPercent: number;
  maxRiskPerTradePercent: number;
  stopLossATRMultiple: number;
  takeProfitATRMultiple: number;
  maxHoldingBars: number;
  maxOpenPositions: number;
  maxDailyRiskPercent: number;
  maxPortfolioRiskPercent: number;
  minExecutionRatePercent: number;
  trailingStopPercent: number;
  lossStepPercent: number;
  lossFloorPercent: number;
  maxConsecutiveLossesForStop: number;
  timeDecayPerBarPercent: number;
  maxSectorExposurePercent: number;
};

export type BacktestPrimitiveMap = Record<string, string | number | boolean | null | undefined>;

export type BacktestRawResult = Record<string, unknown> & {
  security?: { code?: string; name?: string };
  strategyIds?: string[];
  strategyContext?: { strategyName?: string; componentNames?: string[] };
  strategyProfile?: Record<string, unknown>;
  executionPolicy?: Record<string, unknown>;
  lookbackBars?: number;
  customEntryPrice?: number | null;
  entryPriceMode?: string;
  metrics?: BacktestPrimitiveMap & { accepted?: boolean; passReason?: string | null };
  benchmarkReturns?: Record<string, string | number | null | undefined>;
  walkForwardValidation?: {
    accepted?: boolean;
    reason?: string;
    oosSampleCount?: number | null;
    foldPassRate?: number | null;
    oosProjectedNetEdge?: number | null;
    oosWinRate5?: number | null;
    degradationPercent?: number | null;
    overfitRisk?: string;
    folds?: Array<BacktestPrimitiveMap>;
  };
  historicalSamplePath?: {
    startingCapital?: number | null;
    positionPercent?: number | null;
    roundTripCostPercent?: number | null;
    points?: Array<BacktestPrimitiveMap>;
  };
  trades?: Array<Record<string, unknown>>;
  profitSummary?: Record<string, string | number | null | undefined>;
  strategyBreakdown?: Array<BacktestPrimitiveMap>;
  range?: Record<string, string | number | null | undefined>;
};

export type BacktestHistoryRecord = {
  id: string;
  createdAt: string;
  draft: BacktestDraft;
  securityCode: string;
  securityName: string;
  accepted: boolean;
  metrics: BacktestPrimitiveMap | null;
  strategyIds: string[];
  benchmarkReturns: Record<string, string | number | null | undefined> | null;
  strategyProfile: BacktestStrategyProfile;
  rawResult: BacktestRawResult | null;
};

export type BacktestProfileComparisonItem = {
  profile: Settings["riskProfile"];
  loading: boolean;
  error: string;
  record: BacktestHistoryRecord | null;
};

export type BacktestProfileComparisonReport = {
  sourceCode: string;
  comparedAt: string;
  items: BacktestProfileComparisonItem[];
};

export type BacktestExecutionPlan = {
  canExecute: boolean;
  confidence: number;
  signal: "BUY" | "WAIT";
  positionSizePercent: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  riskRewardRatio: number;
  estimatedHoldingBars: number;
  expectedNetEdge: number;
  rationale: string[];
};

export type BacktestViewProps = {
  draft: BacktestDraft;
  loading: boolean;
  error: string;
  result: BacktestRawResult | null;
  history: BacktestHistoryRecord[];
  profileComparisons: BacktestProfileComparisonReport | null;
  onDraftChange: (updater: (current: BacktestDraft) => BacktestDraft) => void;
  onInvalidateRun: () => void;
  onRun: (next: BacktestDraft) => void;
  onRunProfileComparisons: (next: BacktestDraft) => void;
  onApplyProfileComparison: (record: BacktestHistoryRecord) => void;
  onLoadHistory: (record: BacktestHistoryRecord) => void;
  onExportHistory: (record: BacktestHistoryRecord, format: "json" | "csv") => void;
  onExportCurrent: (format: "json" | "csv") => void;
  onApplyCurrent: () => void;
  onApplyHistory: (record: BacktestHistoryRecord) => void;
  onClearHistory: () => void;
  onBack: () => void;
  backLabel: string;
  entryContext: BacktestEntryContext | null;
  onTargetChange: (security: Security, sourceLabel: string) => void;
  currentSettings: Settings;
  executionProfile: BacktestStrategyProfile;
  profileDiff: (source: BacktestStrategyProfile) => Array<{ label: string; sourceValue: string; targetValue: string }>;
  evaluateBacktestExecutionReadiness: (
    metrics: Record<string, unknown> | null,
    profileDiffs: Array<{ label: string; sourceValue: string; targetValue: string }>,
    executionReadinessInput?: unknown
  ) => BacktestExecutionReadiness;
  buildBacktestExecutionPlan: (
    metrics: Record<string, unknown> | null,
    readiness: BacktestExecutionReadiness,
    profile: BacktestStrategyProfile
  ) => BacktestExecutionPlan;
  onOpenPortfolio: () => void;
  /** 打开「策略实测榜」（全市场回放，主进程长任务）。 */
  onOpenLeaderboard: () => void;
};

