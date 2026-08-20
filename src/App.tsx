import {
  Activity,
  BarChart3,
  Bell,
  BookOpenCheck,
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Clock3,
  Database,
  ExternalLink,
  FileText,
  Filter,
  Gauge,
  Layers3,
  LayoutDashboard,
  Download,
  LineChart,
  LoaderCircle,
  Minus,
  Monitor,
  Moon,
  Newspaper,
  Radar,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Sun,
  Target,
  TrendingDown,
  TrendingUp,
  Volume2,
  VolumeX,
  WalletCards,
  Wifi,
  X,
  Zap
} from "lucide-react";
import { FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StrategyBacktestRequest } from "./StrategySignalsView";
import FilterChipGroup from "./FilterChipGroup";
import InlineDecisionBar, { type InlineDecisionPrompt } from "./InlineDecisionBar";
import { createAsyncRequestGate } from "./asyncRequestGate";
import { loadSafeLocalJson, saveSafeLocalJson } from "./safeStorage";
import { shanghaiDateTag, shiftShanghaiDate } from "./dateUtils";
import {
  mergeObservationPool,
  normalizeObservationExclusions,
  removeObservationFromWatchlist,
  upsertObservationExclusion,
  type ObservationExclusion
} from "./watchlistLogic";
import {
  buildSettingsByRiskProfile,
  clampNumber,
  initialSettings,
  mergeSettingsDraft,
  normalizeRiskProfile,
  normalizeSettings,
  riskProfileLabel,
  riskProfilePresets,
  safeNumber,
  sameStrategySet,
  strategyOptions,
  strategyPresets
} from "./domain/settings";

const MultiStockCompareView = lazy(() => import("./MultiStockCompareView"));
const PortfolioBacktestView = lazy(() => import("./PortfolioBacktestView"));
const ProfessionalReview = lazy(() => import("./ProfessionalReview"));
const StrategySignalsView = lazy(() => import("./StrategySignalsView"));

type View =
  | "dashboard"
  | "favorites"
  | "holdings"
  | "watchlist"
  | "sectors"
  | "news"
  | "announcements"
  | "settings"
  | "backtest"
  | "review"
  | "signals"
  | "compare";
type BacktestBenchmark = "all" | "szzs" | "hs300";
type BacktestDraft = {
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
type BacktestEntryContext = {
  security: Security | null;
  sourceView: View;
  sourceLabel: string;
  strategyIds: string[];
  strategyLabel?: string;
  capturedAt: string;
};
const MIN_SINGLE_BACKTEST_BARS = 120;
const MAX_SINGLE_BACKTEST_BARS = 2500;
const DEFAULT_SINGLE_BACKTEST_BARS = 120;
type AnalysisOrigin = {
  view: View;
  label: string;
  node?: string;
  dashboardMode?: "pool" | "analysis";
};
type LimitPoolMeta = {
  dataDate: string;
  fetchedAt: string;
  checkedAt: string;
  providers: string[];
  count: number;
  trigger: "startup" | "auto" | "manual";
};
type AnalysisPayload = {
  security: Security;
  quote: Record<string, any>;
  history: Array<Record<string, number | string>>;
  analysis: Record<string, any>;
  sector: Record<string, any> | null;
  dataFederation?: Record<string, any>;
  announcements: Array<Record<string, any>>;
  actualProvider: string;
  warning?: string;
  updatedAt: string;
};

type PaperPosition = {
  id: string;
  code: string;
  name: string;
  shares: number;
  sectorName?: string;
  entryPrice: number;
  latestPrice: number;
  stopPrice: number;
  takePrice: number;
  holdingBars: number;
  entryFee: number;
  feeRatePercent: number;
  openedAt: string;
  planSignal: string;
  highWaterMark: number;
  strategySignature: string;
  riskProfile: Settings["riskProfile"];
  strategyIds: string[];
  entryReadinessScore: number;
  entryExecutionFillRatePercent: number;
};

type PaperClosedPosition = PaperPosition & {
  closeTime: string;
  closePrice: number;
  closeReason: "TP" | "SL" | "TIME_EXIT" | "MANUAL" | "KILL_SWITCH";
  realizedPnl: number;
  realizedPnlPercent: number;
};

type PaperSimulationState = {
  initialCapital: number;
  cash: number;
  openPositions: PaperPosition[];
  closedPositions: PaperClosedPosition[];
  dailyRealizedPnl: number;
  lastOpenAt: string;
  lastTradeDate: string;
  totalTradeCount: number;
};

type PaperTradeAction = {
  state: PaperSimulationState;
  message: string;
  changed: boolean;
};

type PaperExecutionReadiness = {
  score: number;
  level: "pass" | "wait" | "block";
  status: "PASS" | "WAIT" | "BLOCK";
  summary: string;
  recommendation: string;
  reasons: string[];
  canExecute: boolean;
};

type PaperStrategyStage = "collecting" | "candidate" | "promoted" | "degraded" | "suspended";

type PaperStrategyGovernance = {
  signature: string;
  stage: PaperStrategyStage;
  status: string;
  score: number;
  tradeCount: number;
  minimumPromotionTrades: number;
  winRate: number;
  profitFactor: number;
  realizedPnl: number;
  maxDrawdownPercent: number;
  averageExecutionFillRatePercent: number;
  consecutiveLosses: number;
  recentTenPnl: number;
  positionMultiplier: number;
  canPaperTrade: boolean;
  canPromoteToLive: boolean;
  suspendedUntil: string;
  reasons: string[];
};

type ExecutionDecisionResult = "APPROVED" | "BLOCKED" | "REJECTED" | "CONFIRM_REQUIRED";
type ExecutionDecisionSource = "BACKTEST_CURRENT" | "BACKTEST_HISTORY" | "PAPER_TRADE";

type ExecutionDecisionLog = {
  id: string;
  createdAt: string;
  source: ExecutionDecisionSource;
  result: ExecutionDecisionResult;
  level: "pass" | "wait" | "block";
  securityCode: string;
  securityName: string;
  summary: string;
  score: number;
  reasons: string[];
};

type PendingInlineDecision = {
  prompt: InlineDecisionPrompt;
  onConfirm: () => void;
  onCancel: () => void;
};

type BacktestStrategyProfile = {
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

type BacktestHistoryRecord = {
  id: string;
  createdAt: string;
  draft: BacktestDraft;
  securityCode: string;
  securityName: string;
  accepted: boolean;
  metrics: Record<string, any> | null;
  strategyIds: string[];
  benchmarkReturns: Record<string, any> | null;
  strategyProfile: BacktestStrategyProfile;
  rawResult: any;
};

type BacktestProfileComparisonItem = {
  profile: Settings["riskProfile"];
  loading: boolean;
  error: string;
  record: BacktestHistoryRecord | null;
};

type BacktestProfileComparisonReport = {
  sourceCode: string;
  comparedAt: string;
  items: BacktestProfileComparisonItem[];
};

type BacktestExecutionReadiness = {
  score: number;
  level: "pass" | "wait" | "block";
  status: "PASS" | "WAIT" | "BLOCK";
  recommendation: string;
  reasons: string[];
  canRunLive: boolean;
};

type BacktestExecutionPlan = {
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

const PAPER_SIM_STATE_KEY = "a-stock-radar-v054-paper-sim-v1";
const BACKTEST_HISTORY_KEY = "a-stock-radar-v054-backtest-history-v1";
const BACKTEST_HISTORY_LIMIT = 30;
const EXECUTION_DECISION_LOG_KEY = "a-stock-radar-v054-execution-decision-log-v1";
const EXECUTION_DECISION_LOG_LIMIT = 30;
const OBSERVATION_EXCLUSIONS_KEY = "a-stock-radar:observation-exclusions-v1";
const PAPER_SIM_COOLDOWN_MINUTES = 4;
const PAPER_SIM_COOLDOWN_MS = PAPER_SIM_COOLDOWN_MINUTES * 60 * 1000;

const todayTag = shanghaiDateTag;
const defaultBacktestStartDate = () => shiftShanghaiDate(-1);

const normalizeBacktestStrategyIds = (value: any): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
};

const normalizeBacktestStrategyContext = (input: any): StrategyBacktestRequest | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const strategyId = String(input.strategyId || "").trim();
  const strategyIds = normalizeBacktestStrategyIds(
    Array.isArray(input.strategyIds) && input.strategyIds.length
      ? input.strategyIds
      : strategyId
        ? [strategyId]
        : []
  );
  if (!strategyId || !strategyIds.length) return undefined;
  const security = input.security && /^\d{6}$/.test(String(input.security.code || ""))
    ? {
      ...input.security,
      code: String(input.security.code),
      name: String(input.security.name || input.security.code),
      secid: String(input.security.secid || "")
    } as Security
    : undefined;
  const securities: Security[] = Array.isArray(input.securities)
    ? [...new Map<string, Security>(input.securities.flatMap((item: any): Array<[string, Security]> => {
      const code = String(item?.code || "").trim();
      if (!/^\d{6}$/.test(code)) return [];
      return [[code, {
        ...item,
        code,
        name: String(item.name || code),
        secid: String(item.secid || "")
      } as Security]];
    })).values()].slice(0, 30)
    : [];
  return {
    ...(security ? { security } : {}),
    ...(securities.length ? { securities } : {}),
    ...(input.universeSource === "strategy_current_matches"
      ? { universeSource: "strategy_current_matches" as const }
      : {}),
    ...(Number.isFinite(Number(input.universeTotalCount))
      ? { universeTotalCount: Math.max(securities.length, Math.round(Number(input.universeTotalCount))) }
      : {}),
    source: input.source === "optimized_portfolio" ? "optimized_portfolio" : "single_strategy",
    strategyEngine: "verified-signal-v2",
    strategyId,
    strategyName: String(input.strategyName || strategyId),
    ...(input.strategyVersion ? { strategyVersion: String(input.strategyVersion) } : {}),
    strategyIds,
    minimumVotes: clampNumber(input.minimumVotes, 1, strategyIds.length, 1)
  };
};

const normalizeBacktestDraft = (input: Partial<BacktestDraft> = {}): BacktestDraft => ({
  securityCode: String(input.securityCode || ""),
  security: input.security && /^\d{6}$/.test(String(input.security.code || ""))
    ? {
      ...input.security,
      code: String(input.security.code),
      name: String(input.security.name || input.security.code),
      secid: String(input.security.secid || "")
    }
    : undefined,
  startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || ""))
    ? String(input.startDate).slice(0, 10)
    : defaultBacktestStartDate(),
  customEntryPrice: Number.isFinite(Number(input.customEntryPrice)) && Number(input.customEntryPrice) > 0
    ? Math.min(1_000_000, Number(input.customEntryPrice))
    : null,
  lookbackBars: clampNumber(
    input.lookbackBars,
    MIN_SINGLE_BACKTEST_BARS,
    MAX_SINGLE_BACKTEST_BARS,
    DEFAULT_SINGLE_BACKTEST_BARS
  ),
  benchmarks: clampNumber(input.benchmarks, 1, 10, 2),
  benchmark: input.benchmark === "szzs" || input.benchmark === "hs300" ? input.benchmark : "all",
  minSamples: clampNumber(input.minSamples, 1, 300, 12),
  minProjectedNetEdgePercent: clampNumber(input.minProjectedNetEdgePercent, -2, 10, initialSettings.minProjectedNetEdgePercent),
  minExpectancyPoints: clampNumber(input.minExpectancyPoints, -2, 8, initialSettings.minExpectancyPoints),
  minTurnoverPercent: clampNumber(input.minTurnoverPercent, 0, 20, initialSettings.minTurnoverPercent),
  minQuoteAmount: clampNumber(input.minQuoteAmount, 0, 1_000_000_000, initialSettings.minQuoteAmount),
  maxQuoteAgeSeconds: clampNumber(input.maxQuoteAgeSeconds, 30, 1800, initialSettings.maxQuoteAgeSeconds),
  commissionBps: clampNumber(input.commissionBps, 0, 60, initialSettings.commissionBps),
  slippageBps: clampNumber(input.slippageBps, 0, 60, initialSettings.slippageBps),
  strategyContext: normalizeBacktestStrategyContext(input.strategyContext)
});

const normalizeBacktestStrategyProfile = (
  input: any,
  fallbackSettings: Settings,
  draft: BacktestDraft,
  strategyIds: string[]
): BacktestStrategyProfile => {
  const safeSettings = normalizeSettings(fallbackSettings);
  const normalizedProfile = input && typeof input === "object" ? input : {};
  const selected = normalizeBacktestStrategyIds(normalizedProfile.selectedStrategies);
  const selectedStrategies = selected.length ? selected : strategyIds;
  return {
    selectedStrategies: normalizeBacktestStrategyIds(
      selectedStrategies.length ? selectedStrategies : safeSettings.selectedStrategies
    ),
    riskProfile: normalizeRiskProfile(
      input?.riskProfile || input?.riskProfileName || safeSettings.riskProfile || "balanced"
    ),
    minProjectedNetEdgePercent: clampNumber(
      normalizedProfile.minProjectedNetEdgePercent,
      -2,
      10,
      clampNumber(draft.minProjectedNetEdgePercent, -2, 10, safeSettings.minProjectedNetEdgePercent)
    ),
    minExpectancyPoints: clampNumber(
      normalizedProfile.minExpectancyPoints,
      -2,
      8,
      clampNumber(draft.minExpectancyPoints, -2, 8, safeSettings.minExpectancyPoints)
    ),
    minTurnoverPercent: clampNumber(
      normalizedProfile.minTurnoverPercent,
      0,
      20,
      clampNumber(safeSettings.minTurnoverPercent, 0, 20, 0.4)
    ),
    minQuoteAmount: clampNumber(
      normalizedProfile.minQuoteAmount,
      0,
      1_000_000_000,
      clampNumber(safeSettings.minQuoteAmount, 0, 1_000_000_000, 1200000)
    ),
    maxQuoteAgeSeconds: clampNumber(
      normalizedProfile.maxQuoteAgeSeconds,
      30,
      1800,
      clampNumber(safeSettings.maxQuoteAgeSeconds, 30, 1800, 480)
    ),
    commissionBps: clampNumber(
      normalizedProfile.commissionBps,
      0,
      60,
      clampNumber(draft.commissionBps, 0, 60, safeSettings.commissionBps)
    ),
    slippageBps: clampNumber(
      normalizedProfile.slippageBps,
      0,
      60,
      clampNumber(draft.slippageBps, 0, 60, safeSettings.slippageBps)
    ),
    maxPositionPercent: clampNumber(
      normalizedProfile.maxPositionPercent ?? normalizedProfile.maxPosition,
      5,
      90,
      safeSettings.maxPositionPercent
    ),
    maxRiskPerTradePercent: clampNumber(
      normalizedProfile.maxRiskPerTradePercent ?? normalizedProfile.maxRiskPercent,
      0.2,
      5,
      safeSettings.maxRiskPerTradePercent
    ),
    stopLossATRMultiple: clampNumber(
      normalizedProfile.stopLossATRMultiple,
      0.8,
      5,
      safeSettings.stopLossATRMultiple
    ),
    takeProfitATRMultiple: clampNumber(
      normalizedProfile.takeProfitATRMultiple,
      1,
      10,
      Math.max(safeSettings.takeProfitATRMultiple, safeSettings.stopLossATRMultiple + 0.2)
    ),
    maxHoldingBars: clampNumber(
      normalizedProfile.maxHoldingBars,
      3,
      120,
      safeSettings.maxHoldingBars
    ),
    maxOpenPositions: Math.round(clampNumber(
      normalizedProfile.maxOpenPositions,
      1,
      10,
      safeSettings.maxOpenPositions
    )),
    maxDailyRiskPercent: clampNumber(
      normalizedProfile.maxDailyRiskPercent,
      0.3,
      12,
      safeSettings.maxDailyRiskPercent ?? 3.2
    ),
    maxPortfolioRiskPercent: clampNumber(
      normalizedProfile.maxPortfolioRiskPercent,
      10,
      100,
      safeSettings.maxPortfolioRiskPercent ?? 70
    ),
    maxSectorExposurePercent: clampNumber(
      normalizedProfile.maxSectorExposurePercent,
      10,
      100,
      clampNumber(safeSettings.maxSectorExposurePercent, 10, 100, 45)
    ),
    minExecutionRatePercent: clampNumber(
      normalizedProfile.minExecutionRatePercent,
      40,
      100,
      safeSettings.minExecutionRatePercent ?? 90
    ),
    trailingStopPercent: clampNumber(
      normalizedProfile.trailingStopPercent,
      0,
      25,
      safeSettings.trailingStopPercent ?? 3
    ),
    lossStepPercent: clampNumber(
      normalizedProfile.lossStepPercent ?? normalizedProfile.lossStreakStepPercent,
      2,
      30,
      safeSettings.lossStreakStepPercent
    ),
    lossFloorPercent: clampNumber(
      normalizedProfile.lossFloorPercent ?? normalizedProfile.lossStreakFloorPercent,
      10,
      80,
      safeSettings.lossStreakFloorPercent
    ),
    maxConsecutiveLossesForStop: Math.round(clampNumber(
      normalizedProfile.maxConsecutiveLossesForStop,
      2,
      12,
      safeSettings.maxConsecutiveLossesForStop ?? 4
    )),
    timeDecayPerBarPercent: clampNumber(
      normalizedProfile.timeDecayPerBarPercent,
      0,
      1,
      safeSettings.timeDecayPerBarPercent ?? 0.11
    )
  };
};

const normalizeBacktestHistoryEntry = (input: any, fallbackSettings: Settings): BacktestHistoryRecord | null => {
  if (!input || typeof input !== "object") return null;
  const rawDraft = normalizeBacktestDraft(input.draft || input.input);
  const rawResult = input.rawResult || input.result || input;
  const rawMetrics =
    rawResult && typeof rawResult.metrics === "object" && rawResult.metrics ? rawResult.metrics : null;
  const securityCode = String(
    input.securityCode
      || rawResult?.security?.code
      || rawDraft.securityCode
      || ""
  );
  const strategyIds = normalizeBacktestStrategyIds(
    input.strategyIds || input.strategyProfile?.selectedStrategies || rawResult?.strategyIds
  );
  const strategyProfile: BacktestStrategyProfile = normalizeBacktestStrategyProfile(
    input.strategyProfile || rawResult?.strategyProfile || rawResult?.executionPolicy,
    fallbackSettings,
    rawDraft,
    strategyIds.length ? strategyIds : normalizeBacktestStrategyIds(fallbackSettings.selectedStrategies)
  );
  return {
    id: typeof input.id === "string" && input.id ? input.id : `${Date.now()}-${securityCode || "x"}`,
    createdAt: typeof input.createdAt === "string" && input.createdAt ? input.createdAt : new Date().toISOString(),
    draft: rawDraft,
    securityCode,
    securityName: String(input.securityName || rawResult?.security?.name || securityCode || ""),
    accepted: Boolean(input.accepted || rawMetrics?.accepted),
    metrics: rawMetrics,
    strategyIds,
    benchmarkReturns:
      rawResult?.benchmarkReturns && typeof rawResult.benchmarkReturns === "object" ? rawResult.benchmarkReturns : null,
    strategyProfile,
    rawResult
  };
};

const normalizeBacktestHistory = (input: unknown, fallbackSettings: Settings): BacktestHistoryRecord[] => {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => normalizeBacktestHistoryEntry(item, fallbackSettings))
    .filter((item): item is BacktestHistoryRecord => Boolean(item))
    .slice(0, BACKTEST_HISTORY_LIMIT);
};

const normalizeExecutionDecisionLogEntry = (input: any): ExecutionDecisionLog | null => {
  if (!input || typeof input !== "object") return null;
  const source = input.source === "BACKTEST_CURRENT" || input.source === "BACKTEST_HISTORY" || input.source === "PAPER_TRADE"
    ? input.source as ExecutionDecisionSource
    : null;
  const result = input.result === "APPROVED" || input.result === "BLOCKED" || input.result === "REJECTED" || input.result === "CONFIRM_REQUIRED"
    ? input.result
    : null;
  const level = input.level === "pass" || input.level === "wait" || input.level === "block"
    ? input.level
    : "block";
  if (!source || !result) return null;
  return {
    id: typeof input.id === "string" && input.id ? input.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: typeof input.createdAt === "string" && input.createdAt ? input.createdAt : new Date().toISOString(),
    source,
    result,
    level,
    securityCode: String(input.securityCode || ""),
    securityName: String(input.securityName || ""),
    summary: String(input.summary || "执行动作"),
    score: clampNumber(Number(input.score), 0, 100, 0),
    reasons: Array.isArray(input.reasons)
      ? input.reasons.filter((item: unknown): item is string => typeof item === "string" && Boolean(item.trim()))
      : []
  };
};

const loadExecutionDecisionLog = (): ExecutionDecisionLog[] => {
  try {
    const parsed = loadSafeLocalJson<unknown>(EXECUTION_DECISION_LOG_KEY, []);
    return Array.isArray(parsed)
      ? parsed.map(normalizeExecutionDecisionLogEntry).filter((item): item is ExecutionDecisionLog => Boolean(item))
      : [];
  } catch {
    return [];
  }
};

const buildExecutionDecisionLogEntry = (input: {
  source: ExecutionDecisionSource;
  result: ExecutionDecisionResult;
  level: ExecutionDecisionLog["level"];
  securityCode: string;
  securityName: string;
  summary: string;
  score?: number;
  reasons?: string[];
}): ExecutionDecisionLog => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  createdAt: new Date().toISOString(),
  source: input.source,
  result: input.result,
  level: input.level,
  securityCode: input.securityCode || "UNKNOWN",
  securityName: input.securityName || "UNKNOWN",
  summary: input.summary || "执行动作",
  score: clampNumber(Number(input.score), 0, 100, 0),
  reasons: Array.isArray(input.reasons) ? input.reasons.filter((item) => typeof item === "string" && item.trim()) : []
});

const loadBacktestHistory = (fallbackSettings: Settings) => {
  try {
    const parsed = loadSafeLocalJson<unknown>(BACKTEST_HISTORY_KEY, []);
    return normalizeBacktestHistory(parsed, fallbackSettings);
  } catch {
    return [];
  }
};

const buildBacktestHistoryRecord = (
  draft: BacktestDraft,
  result: any,
  settings: Settings
): BacktestHistoryRecord => {
  const normalizedDraft = normalizeBacktestDraft(draft);
  const safeSettings = normalizeSettings(settings);
  const strategyIds = normalizeBacktestStrategyIds(result?.strategyIds || settings.selectedStrategies);
  const strategyProfile = normalizeBacktestStrategyProfile(
    result?.strategyProfile || result?.executionPolicy,
    safeSettings,
    normalizedDraft,
    strategyIds.length ? strategyIds : normalizeBacktestStrategyIds(safeSettings.selectedStrategies)
  );
  return {
    id: `${Date.now()}-${normalizedDraft.securityCode || "backtest"}`,
    createdAt: new Date().toISOString(),
    draft: normalizedDraft,
    securityCode: String(result?.security?.code || normalizedDraft.securityCode || ""),
    securityName: String(result?.security?.name || normalizedDraft.securityCode || ""),
    accepted: Boolean(result?.metrics?.accepted),
    metrics: result?.metrics && typeof result.metrics === "object" ? result.metrics : null,
    strategyIds,
    benchmarkReturns:
      result?.benchmarkReturns && typeof result.benchmarkReturns === "object"
        ? result.benchmarkReturns
        : null,
    strategyProfile,
    rawResult: result
  };
};

const emptyPaperState = (): PaperSimulationState => ({
  initialCapital: 200000,
  cash: 200000,
  openPositions: [],
  closedPositions: [],
  lastOpenAt: "",
  dailyRealizedPnl: 0,
  lastTradeDate: todayTag(),
  totalTradeCount: 0
});

const buildPaperStrategySignature = (settings: Settings) => {
  const safe = normalizeSettings(settings);
  const strategies = [...new Set(safe.selectedStrategies || [])].sort();
  return [
    normalizeRiskProfile(safe.riskProfile),
    strategies.join("+"),
    clampNumber(safe.maxRiskPerTradePercent, 0.2, 5, 1).toFixed(2),
    clampNumber(safe.stopLossATRMultiple, 0.8, 5, 2).toFixed(2),
    clampNumber(safe.takeProfitATRMultiple, 1, 10, 3.2).toFixed(2),
    Math.round(clampNumber(safe.maxHoldingBars, 3, 120, 30))
  ].join("|");
};

const normalizePaperState = (input: unknown): PaperSimulationState => {
  const fallback = emptyPaperState();
  if (!input || typeof input !== "object") return fallback;
  const raw = input as Partial<PaperSimulationState>;
  const initialCapital = Math.max(
    5000,
    clampNumber(raw.initialCapital, 5000, 10_000_000, fallback.initialCapital)
  );
  const rawCash = clampNumber(raw.cash, 0, initialCapital * 20, initialCapital);
  const today = todayTag();
  const lastTradeDate = typeof raw.lastTradeDate === "string" && raw.lastTradeDate ? raw.lastTradeDate : today;
  const lastOpenAt = typeof raw.lastOpenAt === "string" && raw.lastOpenAt ? raw.lastOpenAt : "";
  const openPositions = Array.isArray(raw.openPositions)
    ? raw.openPositions
        .map((item: any) => {
          const shares = Math.max(0, Math.round(clampNumber(item?.shares, 0, 1e7, 0) / 100) * 100);
          return {
            id: typeof item?.id === "string" && item.id ? item.id : `sim-${Date.now()}-${Math.random().toFixed(6)}`,
            code: String(item?.code || ""),
            name: String(item?.name || item?.code || "UNKNOWN"),
            shares,
            entryPrice: clampNumber(item?.entryPrice, 0.01, 1e9, 0),
            latestPrice: clampNumber(item?.latestPrice, 0.01, 1e9, item?.entryPrice || 0.01),
            stopPrice: clampNumber(item?.stopPrice, 0.01, 1e9, 0.01),
            takePrice: clampNumber(item?.takePrice, 0.01, 1e9, 0.01),
            holdingBars: clampNumber(item?.holdingBars, 0, 500, 0),
            entryFee: clampNumber(item?.entryFee, 0, 1e9, 0),
            feeRatePercent: clampNumber(item?.feeRatePercent, 0, 5, 0.09),
            sectorName: String(item?.sectorName || ""),
            openedAt: typeof item?.openedAt === "string" && item.openedAt ? item.openedAt : todayTag(),
            planSignal: String(item?.planSignal || "BUY"),
            strategySignature: String(item?.strategySignature || "legacy"),
            riskProfile: normalizeRiskProfile(item?.riskProfile),
            strategyIds: Array.isArray(item?.strategyIds)
              ? item.strategyIds.filter((id: unknown): id is string => typeof id === "string" && Boolean(id))
              : [],
            entryReadinessScore: clampNumber(item?.entryReadinessScore, 0, 100, 0),
            entryExecutionFillRatePercent: clampNumber(item?.entryExecutionFillRatePercent, 0, 100, 0),
            highWaterMark: clampNumber(
              item?.highWaterMark,
              0.01,
              1e9,
              clampNumber(item?.latestPrice, 0.01, 1e9, item?.entryPrice || 0.01)
            )
          };
        })
        .filter((position) => position.code && position.shares > 0)
    : [];
  const closedPositions = Array.isArray(raw.closedPositions)
    ? raw.closedPositions
        .map((item: any) => ({
          ...{
            id: typeof item?.id === "string" && item.id ? item.id : `sim-${Date.now()}-${Math.random().toFixed(6)}`,
            code: String(item?.code || ""),
            name: String(item?.name || item?.code || "UNKNOWN"),
            shares: Math.max(0, Math.round(clampNumber(item?.shares, 0, 1e7, 0) / 100) * 100),
            entryPrice: clampNumber(item?.entryPrice, 0.01, 1e9, 0),
            latestPrice: clampNumber(item?.latestPrice, 0.01, 1e9, item?.entryPrice || 0.01),
            stopPrice: clampNumber(item?.stopPrice, 0.01, 1e9, 0.01),
            takePrice: clampNumber(item?.takePrice, 0.01, 1e9, 0.01),
            holdingBars: clampNumber(item?.holdingBars, 0, 500, 0),
            entryFee: clampNumber(item?.entryFee, 0, 1e9, 0),
            feeRatePercent: clampNumber(item?.feeRatePercent, 0, 5, 0.09),
            sectorName: String(item?.sectorName || ""),
            openedAt: typeof item?.openedAt === "string" && item.openedAt ? item.openedAt : todayTag(),
            planSignal: String(item?.planSignal || "BUY"),
            strategySignature: String(item?.strategySignature || "legacy"),
            riskProfile: normalizeRiskProfile(item?.riskProfile),
            strategyIds: Array.isArray(item?.strategyIds)
              ? item.strategyIds.filter((id: unknown): id is string => typeof id === "string" && Boolean(id))
              : [],
            entryReadinessScore: clampNumber(item?.entryReadinessScore, 0, 100, 0),
            entryExecutionFillRatePercent: clampNumber(item?.entryExecutionFillRatePercent, 0, 100, 0),
            highWaterMark: clampNumber(
              item?.highWaterMark,
              0.01,
              1e9,
              clampNumber(item?.entryPrice, 0.01, 1e9, 0)
            )
          },
          closeTime: typeof item?.closeTime === "string" && item.closeTime ? item.closeTime : todayTag(),
          closePrice: clampNumber(item?.closePrice, 0.01, 1e9, 0),
          closeReason: (item?.closeReason as PaperClosedPosition["closeReason"]) || "MANUAL",
          realizedPnl: clampNumber(item?.realizedPnl, -1e9, 1e9, 0),
          realizedPnlPercent: clampNumber(item?.realizedPnlPercent, -1e6, 1e6, 0)
        }))
        .filter((position) => position.code && position.shares > 0)
    : [];

  return {
    initialCapital,
    cash: rawCash,
    openPositions,
    closedPositions,
    lastOpenAt,
    dailyRealizedPnl: clampNumber(raw.dailyRealizedPnl, -1e9, 1e9, 0),
    lastTradeDate,
    totalTradeCount: Math.max(0, Math.round(clampNumber(raw.totalTradeCount, 0, 1e7, 0)))
  };
};

const loadPaperState = (): PaperSimulationState => {
  try {
    const parsed = loadSafeLocalJson<unknown>(PAPER_SIM_STATE_KEY, emptyPaperState());
    const state = normalizePaperState(parsed);
    const today = todayTag();
    if (state.lastTradeDate !== today) {
      return {
        ...state,
        lastTradeDate: today,
        dailyRealizedPnl: 0
      };
    }
    return state;
  } catch {
    return emptyPaperState();
  }
};

const resetPaperStateForNewDay = (state: PaperSimulationState) => {
  const today = todayTag();
  if (state.lastTradeDate === today) return state;
  return {
    ...state,
    dailyRealizedPnl: 0,
    lastTradeDate: today
  };
};

const settlePaperPosition = (
  position: PaperPosition,
  closePrice: number,
  reason: PaperClosedPosition["closeReason"],
  closeTime: string,
  settings: Settings
) => {
  const executionSlip = clampNumber(settings?.slippageBps, 0, 80, 2) / 10000;
  const executionClosePrice = clampNumber(
    closePrice * (1 - executionSlip),
    0.01,
    Number.MAX_SAFE_INTEGER,
    closePrice
  );
  const entryValue = position.entryPrice * position.shares;
  const closeValue = executionClosePrice * position.shares;
  const closeFee = closeValue * (position.feeRatePercent / 100);
  const realizedPnl = closeValue - entryValue - position.entryFee - closeFee;
  const realizedPnlPercent = entryValue > 0 ? realizedPnl / entryValue * 100 : 0;
  const record: PaperClosedPosition = {
    ...position,
    closeTime,
    closePrice: executionClosePrice,
    closeReason: reason,
    realizedPnl,
    realizedPnlPercent,
    latestPrice: executionClosePrice
  };
  return { cashDelta: closeValue - closeFee, record };
};

const reasonLabel = (reason: PaperClosedPosition["closeReason"]) => {
  if (reason === "TP") return "止盈触发";
  if (reason === "SL") return "止损触发";
  if (reason === "TIME_EXIT") return "超时退出";
  if (reason === "KILL_SWITCH") return "风控熔断";
  return "手动平仓";
};

type PaperKillSignal = {
  triggered: boolean;
  hardTriggered: boolean;
  warningTriggered: boolean;
  reasons: string[];
  hardReasons: string[];
  warningReasons: string[];
  dailyLossLimit: number;
  dailyRealizedLoss: number;
  openValue: number;
  openUnrealizedLoss: number;
  lossPressureRatio: number;
  portfolioExposurePercent: number;
  maxPortfolioRiskPercent: number;
};
type PaperLossStreakSignal = {
  consecutiveLosses: number;
  deRiskMultiplier: number;
  blockedByStreak: boolean;
  maxConsecutiveLossesForStop: number;
  stepPercent: number;
  floorPercent: number;
};

type PaperDailyTradeSignal = {
  todayTradeCount: number;
  todayClosedCount: number;
  todayClosedWinCount: number;
  todayWinRate: number;
  maxDailyTrades: number;
  blockedByDailyLimit: boolean;
};

type PaperOrderExecutionModel = {
  fillRatePercent: number;
  executionSlipBps: number;
  stressMultiplier: number;
  intradayShockPercent: number;
};

const evaluatePaperKillSwitch = (state: PaperSimulationState, settings: Settings): PaperKillSignal => {
  const normalized = normalizePaperState(state);
  const safe = normalizeSettings(settings);
  const openValue = normalized.openPositions.reduce(
    (sum, position) => sum + position.latestPrice * position.shares,
    0
  );
  const openCost = normalized.openPositions.reduce(
    (sum, position) => sum + position.entryPrice * position.shares + position.entryFee,
    0
  );
  const openUnrealizedLoss = openCost - openValue;
  const dailyLossLimit = normalized.initialCapital * clampNumber(safe.maxDailyRiskPercent ?? 0, 0, 100, 0) / 100;
  const maxPortfolioRiskPercent = clampNumber(safe.maxPortfolioRiskPercent ?? 70, 10, 100, 70);
  const portfolioExposurePercent = normalized.initialCapital > 0 ? openValue / normalized.initialCapital * 100 : 0;
  const totalDailyLoss = Math.max(0, -normalized.dailyRealizedPnl) + Math.max(0, openUnrealizedLoss);
  const lossPressureRatio = dailyLossLimit > 0 ? totalDailyLoss / dailyLossLimit : 0;

  const dailyLossTrigger = dailyLossLimit > 0 && normalized.dailyRealizedPnl <= -dailyLossLimit;
  const portfolioDrawdownTrigger = dailyLossLimit > 0 && lossPressureRatio >= 1;
  const portfolioExposureTrigger = portfolioExposurePercent > maxPortfolioRiskPercent;
  const nearLossPressureTrigger = dailyLossLimit > 0 && lossPressureRatio >= 0.75 && lossPressureRatio < 1;
  const hardReasons: string[] = [];
  const warningReasons: string[] = [];

  if (dailyLossTrigger) hardReasons.push(`日内已实现亏损触发`);
  if (portfolioDrawdownTrigger) hardReasons.push(`累计亏损超阈值：${lossPressureRatio.toFixed(2)} 倍`);
  if (nearLossPressureTrigger) warningReasons.push(`累计亏损逼近阈值：${lossPressureRatio.toFixed(2)} 倍`);
  if (portfolioExposureTrigger) hardReasons.push(`组合持仓超限 ${portfolioExposurePercent.toFixed(1)}%`);
  if (openUnrealizedLoss > 0 && safe.maxSectorExposurePercent) {
    warningReasons.push(`持仓浮亏压力 ${(openUnrealizedLoss / Math.max(1, normalized.initialCapital) * 100).toFixed(1)}%`);
  }
  const reasons = [...hardReasons, ...warningReasons];
  const hardTriggered = hardReasons.length > 0;
  const warningTriggered = warningReasons.length > 0;

  return {
    triggered: hardTriggered || warningTriggered,
    hardTriggered,
    warningTriggered,
    reasons,
    hardReasons,
    warningReasons,
    dailyLossLimit,
    dailyRealizedLoss: normalized.dailyRealizedPnl,
    openValue,
    openUnrealizedLoss,
    lossPressureRatio,
    portfolioExposurePercent,
    maxPortfolioRiskPercent
  };
};

const getPaperLossStreakState = (state: PaperSimulationState, settings: Settings): PaperLossStreakSignal => {
  const safe = normalizeSettings(settings);
  const today = todayTag();
  const maxConsecutiveLossesForStop = Math.round(clampNumber(safe.maxConsecutiveLossesForStop ?? 4, 2, 12, 4));
  const stepPercent = clampNumber(safe.lossStreakStepPercent ?? 18, 2, 60, 18);
  const floorPercent = clampNumber(safe.lossStreakFloorPercent ?? 30, 10, 80, 30);
  const todayCloses = [...state.closedPositions]
    .filter((position) => String(position.closeTime).slice(0, 10) === today)
    .sort((a, b) => new Date(b.closeTime).getTime() - new Date(a.closeTime).getTime());
  let consecutiveLosses = 0;
  for (const record of todayCloses) {
    if (record.realizedPnl < 0) {
      consecutiveLosses += 1;
      continue;
    }
    break;
  }

  const blockedByStreak = consecutiveLosses >= maxConsecutiveLossesForStop;
  const deRiskMultiplier = blockedByStreak
    ? 0
    : consecutiveLosses > 0
      ? Math.max(floorPercent / 100, 1 - consecutiveLosses * (stepPercent / 100))
      : 1;

  return {
    consecutiveLosses,
    deRiskMultiplier,
    blockedByStreak,
    maxConsecutiveLossesForStop,
    stepPercent,
    floorPercent
  };
};

const getPaperDailyTradeSignal = (state: PaperSimulationState, settings: Settings): PaperDailyTradeSignal => {
  const normalized = normalizePaperState(state);
  const safe = normalizeSettings(settings);
  const today = todayTag();
  const todayOpenCount = normalized.openPositions.filter(
    (position) => String(position.openedAt || "").slice(0, 10) === today
  ).length;
  const todayClosed = normalized.closedPositions.filter(
    (position) => String(position.closeTime || "").slice(0, 10) === today
  );
  const todayClosedCount = todayClosed.length;
  const todayClosedWinCount = todayClosed.filter((position) => Number(position.realizedPnl) > 0).length;
  const todayTradeCount = todayOpenCount + todayClosedCount;
  const todayWinRate = todayClosedCount > 0 ? todayClosedWinCount / todayClosedCount * 100 : 0;
  const maxDailyTrades = clampNumber(safe.maxDailyTrades ?? 12, 1, 200, 12);

  return {
    todayTradeCount,
    todayClosedCount,
    todayClosedWinCount,
    todayWinRate,
    maxDailyTrades,
    blockedByDailyLimit: todayTradeCount >= maxDailyTrades
  };
};

const evaluatePaperStrategyGovernance = (
  state: PaperSimulationState,
  settings: Settings
): PaperStrategyGovernance => {
  const normalized = normalizePaperState(state);
  const safe = normalizeSettings(settings);
  const signature = buildPaperStrategySignature(safe);
  const minimumPromotionTrades = 30;
  const minimumCandidateTrades = 20;
  const minimumWinRate = clampNumber(safe.minPaperWinRatePercent ?? 52, 40, 90, 52);
  const minimumProfitFactor = 1.2;
  const maximumPromotionDrawdownPercent = 8;
  const minimumExecutionFillRatePercent = clampNumber(safe.minExecutionRatePercent ?? 90, 40, 100, 90);
  const trades = normalized.closedPositions
    .filter((position) => position.strategySignature === signature)
    .filter((position) => Number.isFinite(Number(position.realizedPnl)))
    .sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
  const tradeCount = trades.length;
  const wins = trades.filter((position) => position.realizedPnl > 0);
  const grossProfit = trades.reduce((sum, position) => sum + Math.max(0, position.realizedPnl), 0);
  const grossLoss = trades.reduce((sum, position) => sum + Math.max(0, -position.realizedPnl), 0);
  const realizedPnl = trades.reduce((sum, position) => sum + position.realizedPnl, 0);
  const winRate = tradeCount ? wins.length / tradeCount * 100 : 0;
  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0
      ? Number.POSITIVE_INFINITY
      : 0;
  const averageExecutionFillRatePercent = tradeCount
    ? trades.reduce((sum, position) => sum + position.entryExecutionFillRatePercent, 0) / tradeCount
    : 0;
  let equity = normalized.initialCapital;
  let peak = equity;
  let maxDrawdownPercent = 0;
  for (const trade of trades) {
    equity += trade.realizedPnl;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdownPercent = Math.max(maxDrawdownPercent, (peak - equity) / peak * 100);
    }
  }
  let consecutiveLosses = 0;
  for (const trade of [...trades].reverse()) {
    if (trade.realizedPnl < 0) consecutiveLosses += 1;
    else break;
  }
  const recentTenPnl = trades
    .slice(-10)
    .reduce((sum, position) => sum + position.realizedPnl, 0);
  const severeDrawdown = maxDrawdownPercent >= 12;
  const severeRecentLoss = recentTenPnl <= -normalized.initialCapital * 0.02;
  const severeLossStreak = consecutiveLosses >= 5;
  const severeProfitFactor = tradeCount >= 10 && profitFactor < 0.8;
  const severe = severeDrawdown || severeRecentLoss || severeLossStreak || severeProfitFactor;
  const latestCloseAt = trades.at(-1)?.closeTime || "";
  const latestCloseTime = Date.parse(latestCloseAt);
  const suspendedUntilTime = Number.isFinite(latestCloseTime)
    ? latestCloseTime + 24 * 60 * 60 * 1000
    : 0;
  const suspensionActive = severe && suspendedUntilTime > Date.now();
  const promotionPassed =
    tradeCount >= minimumPromotionTrades &&
    winRate >= minimumWinRate &&
    profitFactor >= minimumProfitFactor &&
    realizedPnl > 0 &&
    maxDrawdownPercent <= maximumPromotionDrawdownPercent &&
    averageExecutionFillRatePercent >= minimumExecutionFillRatePercent;
  let stage: PaperStrategyStage;
  if (suspensionActive) stage = "suspended";
  else if (severe) stage = "degraded";
  else if (tradeCount < minimumCandidateTrades) stage = "collecting";
  else if (tradeCount < minimumPromotionTrades) stage = "candidate";
  else stage = promotionPassed ? "promoted" : "degraded";
  const status =
    stage === "promoted" ? "已具备晋级资格" :
      stage === "candidate" ? "候选验证中" :
        stage === "collecting" ? "样本收集中" :
          stage === "suspended" ? "策略已暂停" : "策略已降级";
  const reasons: string[] = [];
  if (tradeCount < minimumPromotionTrades) reasons.push(`平仓样本 ${tradeCount}/${minimumPromotionTrades}`);
  if (tradeCount > 0 && winRate < minimumWinRate) reasons.push(`胜率 ${winRate.toFixed(1)}% < ${minimumWinRate}%`);
  if (tradeCount > 0 && profitFactor < minimumProfitFactor) reasons.push(`盈利因子 ${profitFactor.toFixed(2)} < ${minimumProfitFactor}`);
  if (maxDrawdownPercent > maximumPromotionDrawdownPercent) {
    reasons.push(`最大回撤 ${maxDrawdownPercent.toFixed(2)}% > ${maximumPromotionDrawdownPercent}%`);
  }
  if (tradeCount > 0 && averageExecutionFillRatePercent < minimumExecutionFillRatePercent) {
    reasons.push(`平均模拟成交率 ${averageExecutionFillRatePercent.toFixed(1)}% < ${minimumExecutionFillRatePercent}%`);
  }
  if (severeRecentLoss) reasons.push(`最近10笔累计亏损 ${recentTenPnl.toFixed(2)} 元`);
  if (severeLossStreak) reasons.push(`连续亏损 ${consecutiveLosses} 笔`);
  if (stage === "promoted") reasons.push("纸面业绩、回撤和执行质量均通过");
  const score = Math.round(clampNumber(
    Math.min(25, tradeCount / minimumPromotionTrades * 25) +
      Math.min(20, winRate / Math.max(1, minimumWinRate) * 20) +
      Math.min(20, (Number.isFinite(profitFactor) ? profitFactor : minimumProfitFactor * 2) / minimumProfitFactor * 20) +
      Math.max(0, 15 - maxDrawdownPercent) +
      Math.min(20, averageExecutionFillRatePercent / Math.max(1, minimumExecutionFillRatePercent) * 20),
    0,
    100,
    0
  ));
  const positionMultiplier =
    stage === "promoted" ? 1 :
      stage === "candidate" ? 0.5 :
        stage === "collecting" ? 0.25 :
          stage === "degraded" ? 0.2 : 0;

  return {
    signature,
    stage,
    status,
    score,
    tradeCount,
    minimumPromotionTrades,
    winRate,
    profitFactor,
    realizedPnl,
    maxDrawdownPercent,
    averageExecutionFillRatePercent,
    consecutiveLosses,
    recentTenPnl,
    positionMultiplier,
    canPaperTrade: stage !== "suspended",
    canPromoteToLive: stage === "promoted",
    suspendedUntil: suspensionActive ? new Date(suspendedUntilTime).toISOString() : "",
    reasons: reasons.length ? reasons : ["等待首笔纸面交易完成"]
  };
};

const normalizePaperExecutionReadiness = (input: any): PaperExecutionReadiness | null => {
  if (!input || typeof input !== "object") return null;
  const level =
    input.level === "pass" || input.level === "wait" || input.level === "block"
      ? input.level
      : null;
  if (!level) return null;
  const status =
    input.status === "PASS" || input.status === "WAIT" || input.status === "BLOCK"
      ? input.status
      : level === "pass" ? "PASS" : level === "wait" ? "WAIT" : "BLOCK";
  const scoreValue = Number(input.score);
  if (!Number.isFinite(scoreValue)) return null;
  const score = clampNumber(Math.round(scoreValue), 0, 100, 0);
  const summary = typeof input.summary === "string" && input.summary.trim() ? input.summary : "执行评估已返回但摘要缺失";
  const recommendation = typeof input.recommendation === "string" && input.recommendation.trim()
    ? input.recommendation
    : status === "PASS" ? "可执行"
      : status === "WAIT" ? "建议先确认后执行"
        : "当前不适合执行";
  const reasons = Array.isArray(input.reasons)
    ? input.reasons.filter((item: unknown): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  const canExecute = typeof input.canExecute === "boolean" ? input.canExecute : level !== "block";
  return {
    score,
    level,
    status,
    summary,
    recommendation,
    reasons: reasons.length ? reasons : ["执行评估已完成"],
    canExecute: canExecute && level !== "block"
  };
};

type PaperMarketExecutionReadiness = {
  hard: string[];
  soft: string[];
  staleSeconds: number;
  quoteAmount: number;
  quoteTurnover: number;
};

const getSectorOfPayload = (payload: AnalysisPayload | null) => {
  if (!payload) return "";
  const fromSector = typeof payload.sector?.name === "string" ? payload.sector.name.trim() : "";
  const fromQuote = typeof payload.quote?.industry === "string" ? payload.quote.industry.trim() : "";
  return fromSector || fromQuote || "";
};

const getPaperSectorExposureValue = (state: PaperSimulationState, sectorName?: string) => {
  const target = typeof sectorName === "string" ? sectorName.trim() : "";
  if (!target) return 0;
  return state.openPositions.reduce(
    (sum, position) => (String(position.sectorName || "").trim() === target ? sum + position.latestPrice * position.shares : sum),
    0
  );
};

const getPaperSectorExposurePercent = (state: PaperSimulationState, sectorName?: string) => {
  const exposureValue = getPaperSectorExposureValue(state, sectorName);
  return state.initialCapital > 0 ? exposureValue / state.initialCapital * 100 : 0;
};

const estimatePaperOrderExecutionModel = (
  payload: AnalysisPayload | null,
  settings: Settings
): PaperOrderExecutionModel => {
  const safe = normalizeSettings(settings);
  const quote = payload?.quote || {};
  const analysis = payload?.analysis || {};
  const updatedAt = typeof payload?.updatedAt === "string" ? Date.parse(payload.updatedAt) : Number.NaN;
  const now = Date.now();
  const staleSeconds = Number.isFinite(updatedAt) ? Math.max(0, (now - updatedAt) / 1000) : Number.POSITIVE_INFINITY;
  const turnover = clampNumber(Number(quote.turnover), 0, 100, 0.5);
  const amount = clampNumber(Number(quote.amount), 0, Number.MAX_SAFE_INTEGER, 0);
  const mrs = clampNumber(analysis.mrs, 20, 100, 50);
  const relativeTurnover = clampNumber(Number(analysis.relativeTurnover || analysis.volumeRatio || 0), 0, 10, 0);
  const intradayShockPercent = clampNumber(Math.abs(clampNumber(quote.changePct || 0, -20, 20, 0)), 0, 20, 0);
  const stalePenalty = Number.isFinite(staleSeconds) ? clampNumber(staleSeconds / 120, 0, 30, 0) : 0;
  const liquidityScore = clampNumber(
    Math.min(10, Math.max(0, (Math.log10(amount + 1) - 6))) * 1.2,
    0,
    12,
    0
  );
  const qualityScore = clampNumber((mrs - 20) * 0.25, 0, 20, 0);
  const turnoverScore = clampNumber(turnover * 1.6, 0, 18, 0);
  const turnRelScore = clampNumber(relativeTurnover * 0.9, 0, 6, 0);
  const fillRatePercent = clampNumber(
    84 + qualityScore + turnoverScore + turnRelScore + liquidityScore
      - intradayShockPercent * 1.1
      - stalePenalty
      - Math.max(0, turnRelScore - 2),
    1,
    100,
    84
  );
  const executionSlipBps = clampNumber(
    safe.slippageBps + intradayShockPercent * 0.55 + stalePenalty * 0.45 + Math.max(0, 12 - turnover * 1.2),
    1,
    80,
    2
  );
  const stressMultiplier = clampNumber(
    1 + (100 - fillRatePercent) / 120 + Math.max(0, intradayShockPercent) / 28,
    1,
    2.8,
    1.15
  );
  return {
    fillRatePercent,
    executionSlipBps,
    stressMultiplier,
    intradayShockPercent
  };
};

const evaluatePaperMarketReadiness = (
  payload: AnalysisPayload | null,
  settings: Settings
): PaperMarketExecutionReadiness => {
  const safe = normalizeSettings(settings);
  const quote = payload?.quote || {};
  const updatedAt = typeof payload?.updatedAt === "string" ? Date.parse(payload.updatedAt) : Number.NaN;
  const now = Date.now();
  const staleSeconds = Number.isFinite(updatedAt) ? Math.max(0, (now - updatedAt) / 1000) : Number.POSITIVE_INFINITY;
  const staleMaxSeconds = clampNumber(safe.maxQuoteAgeSeconds ?? 480, 30, 1800, 480);
  const minTurnover = clampNumber(safe.minTurnoverPercent ?? 0.4, 0, 20, 0.4);
  const minAmount = clampNumber(safe.minQuoteAmount ?? 1200000, 0, 1_000_000_000, 1200000);
  const quoteAmount = clampNumber(Number(quote.amount), 0, Number.MAX_SAFE_INTEGER, 0);
  const quoteTurnover = clampNumber(Number(quote.turnover), 0, 100, 0);
  const hard: string[] = [];
  const soft: string[] = [];
  const federation = payload?.dataFederation || {};
  const federationSources = Array.isArray(federation.sources) ? federation.sources : [];
  const realtimeSourceCount = federationSources.filter((source: any) =>
    source?.ok === true && source?.realtime !== false && Number(source?.latest) > 0
  ).length;
  const spreadPct = Number(federation.spreadPct);
  const federationStatus = String(federation.status || "");

  if (!Number.isFinite(staleSeconds)) {
    hard.push("标的更新时间缺失，无法确认实时性");
  } else if (staleSeconds > staleMaxSeconds) {
    hard.push(`行情超过 ${Math.ceil(staleMaxSeconds / 60)} 分钟未更新`);
  } else if (staleSeconds > staleMaxSeconds * 0.6) {
    soft.push(`行情延迟 ${Math.ceil(staleSeconds / 60)} 分钟`);
  }

  if (federationSources.length) {
    if (federationStatus.includes("需复核") || (Number.isFinite(spreadPct) && spreadPct > 0.2)) {
      hard.push(`三线行情价差 ${Number.isFinite(spreadPct) ? spreadPct.toFixed(3) : "--"}% 超过复核阈值，禁止执行`);
    } else if (realtimeSourceCount < 2) {
      soft.push("当前仅一个实时行情源可用，建议先复核报价");
    } else if (Number.isFinite(spreadPct) && spreadPct > 0.05) {
      soft.push(`三线行情存在轻微价差 ${spreadPct.toFixed(3)}%`);
    }
  }

  if (quoteAmount <= 0) {
    hard.push("缺少有效成交额字段，禁止执行");
  } else if (minAmount > 0) {
    if (quoteAmount < minAmount * 0.4) {
      hard.push(`成交额 ${fmtMoney(quoteAmount)} 低于硬阈值 ${fmtMoney(minAmount)}（低流动性）`);
    } else if (quoteAmount < minAmount) {
      soft.push(`成交额 ${fmtMoney(quoteAmount)} 低于推荐阈值 ${fmtMoney(minAmount)}`);
    }
  }

  if (quoteTurnover <= 0) {
    hard.push("换手率异常（≤0），禁止执行");
  } else if (minTurnover > 0 && quoteTurnover < minTurnover * 0.4) {
    hard.push(`换手率 ${quoteTurnover.toFixed(2)}% 过低（硬阈值）`);
  } else if (minTurnover > 0 && quoteTurnover < minTurnover) {
    soft.push(`换手率 ${quoteTurnover.toFixed(2)}% 低于推荐阈值 ${minTurnover}%`);
  }

  return {
    hard,
    soft,
    staleSeconds,
    quoteAmount,
    quoteTurnover
  };
};

const mergeReasonArrays = (left: string[] = [], right: string[] = []) => {
  const dedupe = new Set<string>();
  const merged: string[] = [];
  [...left, ...right].forEach((item) => {
    const text = String(item || "").trim();
    if (!text || dedupe.has(text)) return;
    dedupe.add(text);
    merged.push(text);
  });
  return merged;
};

const evaluatePaperExecutionReadinessLocal = (
  state: PaperSimulationState,
  payload: AnalysisPayload | null,
  settings: Settings
): PaperExecutionReadiness => {
  const normalized = resetPaperStateForNewDay(normalizePaperState(state));
  const safe = normalizeSettings(settings);
  const strategyGovernance = evaluatePaperStrategyGovernance(normalized, safe);
  const marketReadiness = evaluatePaperMarketReadiness(payload, safe);
  if (!payload) {
    return {
      score: 0,
      level: "block",
      status: "BLOCK",
      summary: "请先在分析页选择标的",
      recommendation: "先完成标的分析，再进入纸面执行。",
      reasons: ["当前未加载到可执行标的"],
      canExecute: false
    };
  }
  if (!strategyGovernance.canPaperTrade) {
    return {
      score: 0,
      level: "block",
      status: "BLOCK",
      summary: "当前策略纸面资格已暂停",
      recommendation: strategyGovernance.suspendedUntil
        ? `请等待至 ${new Date(strategyGovernance.suspendedUntil).toLocaleString("zh-CN")} 后以降级仓位重新验证。`
        : "请更换策略参数并重新开始纸面验证。",
      reasons: strategyGovernance.reasons,
      canExecute: false
    };
  }

  const security = payload.security || {};
  const analysis = payload.analysis || {};
  const tradePlan = analysis.tradePlan || {};
  const sectorName = getSectorOfPayload(payload);
  const maxSectorExposurePercent = clampNumber(safe.maxSectorExposurePercent, 10, 100, 45);
  const sectorExposurePercent = sectorName ? getPaperSectorExposurePercent(normalized, sectorName) : 0;
  const executionModel = estimatePaperOrderExecutionModel(payload, safe);
  const modelFillRatePercent = clampNumber(executionModel.fillRatePercent, 0, 100, 85);
  const tradePlanFillRatePercent = clampNumber(tradePlan.executionFillRatePercent, 0, 100, modelFillRatePercent);
  const executionFillRatePercent = clampNumber(Math.min(modelFillRatePercent, tradePlanFillRatePercent), 0, 100, modelFillRatePercent);
  const code = String(security?.code || "");
  const latest = clampNumber(payload.quote?.latest, 0.01, Number.MAX_SAFE_INTEGER, 0);
  const reasonList: string[] = [];
  const softReasonList: string[] = [];
  if (strategyGovernance.stage === "degraded") {
    softReasonList.push(`策略处于降级验证期，仓位系数 ${Math.round(strategyGovernance.positionMultiplier * 100)}%`);
  }
  if (!code || latest <= 0) {
    return {
      score: 0,
      level: "block",
      status: "BLOCK",
      summary: "当前标的无可执行价格",
      recommendation: "更新行情后再尝试。",
      reasons: ["标的代码不存在或价格缺失"],
      canExecute: false
    };
  }
  if (safe.enabledPaperSim === false) {
    return {
      score: 12,
      level: "block",
      status: "BLOCK",
      summary: "当前关闭纸面模拟",
      recommendation: "请先开启“仅纸面模拟”后再尝试执行。",
      reasons: ["纸面模拟开关未开启"],
      canExecute: false
    };
  }
  const isBuySignal = tradePlan.signal === "BUY" || tradePlan.signal === "BUY_AGGRESSIVE";
  if (!isBuySignal) {
    return {
      score: 8,
      level: "block",
      status: "BLOCK",
      summary: "当前未形成可执行买入信号",
      recommendation: "等待下一次买入信号后再提交开仓。",
      reasons: ["交易计划未给出 BUY/BUY_AGGRESSIVE 信号"],
      canExecute: false
    };
  }
  if (!(tradePlan.positionSizePercent > 0)) {
    return {
      score: 20,
      level: "block",
      status: "BLOCK",
      summary: "建议仓位为 0，不执行",
      recommendation: "等信号修正为有效仓位后再尝试。",
      reasons: ["交易计划仓位过低"],
      canExecute: false
    };
  }

  const minExecutionRatePercent = clampNumber(safe.minExecutionRatePercent, 40, 100, 90);
  if (executionFillRatePercent < minExecutionRatePercent) {
    return {
      score: 30,
      level: "block",
      status: "BLOCK",
      summary: "成交率低于最低要求",
      recommendation: "建议降低滑点、扩展流动性样本后再试。",
      reasons: [`成交率 ${executionFillRatePercent.toFixed(1)}% < ${minExecutionRatePercent}%`],
      canExecute: false
    };
  }

  if (tradePlan.killSwitchTriggered) {
    return {
      score: 18,
      level: "block",
      status: "BLOCK",
      summary: "信号被风险开关打断",
      recommendation: "请等待风控状态回归后再执行。",
      reasons: ["交易计划已触发 Kill Switch"],
      canExecute: false
    };
  }
  reasonList.push(...marketReadiness.hard);
  softReasonList.push(...marketReadiness.soft);

  if (sectorName) {
    if (sectorExposurePercent > maxSectorExposurePercent) {
      reasonList.push(`当前行业 ${sectorName} 曝露 ${sectorExposurePercent.toFixed(1)}% > 行业集中度上限 ${maxSectorExposurePercent}%`);
    } else if (sectorExposurePercent > maxSectorExposurePercent * 0.9) {
      softReasonList.push(`当前行业 ${sectorName} 曝露 ${sectorExposurePercent.toFixed(1)}%，接近上限 ${maxSectorExposurePercent}%`);
    }
  }

  const todayLossStreak = getPaperLossStreakState(normalized, safe);
  if (todayLossStreak.blockedByStreak) {
    reasonList.push(`连亏 ${todayLossStreak.consecutiveLosses} 笔达到上限 ${todayLossStreak.maxConsecutiveLossesForStop}，今日禁开仓`);
  }
  if (todayLossStreak.deRiskMultiplier < 1) {
    const deRiskPercent = Math.round(todayLossStreak.deRiskMultiplier * 100);
    softReasonList.push(`连亏 ${todayLossStreak.consecutiveLosses} 笔，仓位已降仓 ${deRiskPercent}%`);
  }

  const tradeProjection = payload?.analysis?.tradeProjection?.projection || {};
  const projectedNetEdge = Number(tradeProjection.projectedNetEdge);
  const projectedExpectancy = Number(tradeProjection.expectancyPoints);
  const projectedRiskReward = Number(tradeProjection.riskReward);
  const projectedExpectedReturnPercent = Number(tradeProjection.expectedReturnPercent);
  const takeProbability = Number(tradeProjection.probabilityTakeProfit);
  const stopProbability = Number(tradeProjection.probabilityStopLoss);
  const timeoutProbability = Number(tradeProjection.probabilityTimeExit);
  const minProjectedNetEdgePercent = clampNumber(safe.minProjectedNetEdgePercent ?? 0.2, -2, 10, 0.2);
  const minExpectancyPoints = clampNumber(safe.minExpectancyPoints ?? 0.2, -2, 8, 0.2);
  const minPaperWinRatePercent = clampNumber(safe.minPaperWinRatePercent ?? 52, 40, 90, 52);
  const minPaperRiskRewardRatio = clampNumber(safe.minPaperRiskRewardRatio ?? 1.15, 1, 3, 1.15);
  const dailyTradeSignal = getPaperDailyTradeSignal(normalized, safe);
  if (Number.isFinite(projectedNetEdge) && projectedNetEdge < minProjectedNetEdgePercent) {
    softReasonList.push(`预期净收益偏低 ${projectedNetEdge.toFixed(2)}% < ${minProjectedNetEdgePercent}%`);
  }
  if (Number.isFinite(projectedExpectancy) && projectedExpectancy < minExpectancyPoints) {
    softReasonList.push(`期望值偏低 ${projectedExpectancy.toFixed(2)} < ${minExpectancyPoints}`);
  }
  if (Number.isFinite(projectedExpectedReturnPercent) && projectedExpectedReturnPercent <= 0) {
    reasonList.push(`预期回报为非正值 ${projectedExpectedReturnPercent.toFixed(2)}%`);
  }
  if (Number.isFinite(takeProbability) && takeProbability < 25) {
    softReasonList.push(`TP 概率偏低 ${takeProbability.toFixed(1)}%`);
  }
  if (Number.isFinite(stopProbability) && stopProbability > 60) {
    softReasonList.push(`SL 概率偏高 ${stopProbability.toFixed(1)}%`);
  }
  if (Number.isFinite(timeoutProbability) && timeoutProbability > 55) {
    softReasonList.push(`超时退出概率偏高 ${timeoutProbability.toFixed(1)}%`);
  }
  if (dailyTradeSignal.blockedByDailyLimit) {
    reasonList.push(`今日交易已达上限 ${dailyTradeSignal.todayTradeCount}/${dailyTradeSignal.maxDailyTrades}`);
  }
  if (dailyTradeSignal.todayClosedCount > 0 && dailyTradeSignal.todayWinRate < minPaperWinRatePercent) {
    softReasonList.push(`今日胜率 ${dailyTradeSignal.todayWinRate.toFixed(1)}% < 阈值 ${minPaperWinRatePercent}%`);
  }
  if (Number.isFinite(projectedRiskReward) && projectedRiskReward < minPaperRiskRewardRatio) {
    softReasonList.push(`风险收益比 ${projectedRiskReward.toFixed(2)} < 阈值 ${minPaperRiskRewardRatio}`);
  }

  const stopDistancePercent = clampNumber(
    clampNumber(tradePlan.stopLossDistancePercent, 0.5, 25, safe.stopLossATRMultiple * 1.3),
    0.2,
    25,
    2.8
  );
  const stopPriceCandidate = clampNumber(tradePlan.stopLossPrice, 0.01, Number.MAX_SAFE_INTEGER, latest * (1 - stopDistancePercent / 100));
  const takeDistancePercent = clampNumber(
    clampNumber(tradePlan.takeProfitDistancePercent, Math.max(stopDistancePercent * 1.15, 1), 50, 4),
    1,
    50,
    4
  );
  const takePriceCandidate = clampNumber(tradePlan.takeProfitPrice, 0.01, Number.MAX_SAFE_INTEGER, latest * (1 + takeDistancePercent / 100));
  const finalStop = Math.min(stopPriceCandidate, latest * 0.99);
  const finalTake = Math.max(takePriceCandidate, latest * 1.001, latest + 0.01);
  if (!(finalTake > finalStop && finalStop > 0)) {
    return {
      score: 28,
      level: "block",
      status: "BLOCK",
      summary: "止盈止损参数异常",
      recommendation: "停止执行：请检查执行计划后再试。",
      reasons: ["止盈/止损价格计算失败"],
      canExecute: false
    };
  }

  const lastOpenAt = normalized.lastOpenAt;
  if (lastOpenAt) {
    const lastTs = Date.parse(lastOpenAt);
    if (Number.isFinite(lastTs)) {
      const elapsed = Date.now() - lastTs;
      if (elapsed >= 0 && elapsed < PAPER_SIM_COOLDOWN_MS) {
        const remainMinutes = Math.max(1, Math.ceil((PAPER_SIM_COOLDOWN_MS - elapsed) / 60000));
        return {
          score: 38,
          level: "block",
          status: "BLOCK",
          summary: "触发纸面下单频率限制",
          recommendation: `请等待 ${remainMinutes} 分钟后继续尝试。`,
          reasons: [`最近一次开仓在 ${new Date(lastOpenAt).toLocaleTimeString("zh-CN", { hour12: false })}`],
          canExecute: false
        };
      }
    }
  }

  const preOpenKill = evaluatePaperKillSwitch(normalized, safe);
  if (preOpenKill.hardTriggered) {
    reasonList.push(...preOpenKill.hardReasons);
  } else if (preOpenKill.warningTriggered) {
    softReasonList.push(...preOpenKill.warningReasons);
  }

  const dailyLossLimit = normalized.initialCapital * Math.max(0, safe.maxDailyRiskPercent || 0) / 100;
  if (dailyLossLimit > 0 && normalized.dailyRealizedPnl <= -dailyLossLimit) {
    reasonList.push("今日日内风险限额已触发");
  }

  const maxOpen = Math.max(1, Math.round(safe.maxOpenPositions || 2));
  const currentOpen = normalized.openPositions.length;
  if (currentOpen >= maxOpen) {
    reasonList.push(`当前持仓数已达上限 ${maxOpen} 只`);
  }
  if (normalized.openPositions.some((position) => position.code === code)) {
    reasonList.push(`${code} 已有持仓，避免重复开仓`);
  }

  const rawPortfolioRiskPercent = normalized.initialCapital > 0
    ? normalized.openPositions.reduce((sum, position) => sum + position.latestPrice * position.shares, 0) / normalized.initialCapital * 100
    : 0;
  const maxPortfolioRiskPercent = clampNumber(safe.maxPortfolioRiskPercent ?? 70, 10, 100, 70);
  if (rawPortfolioRiskPercent > maxPortfolioRiskPercent) {
    reasonList.push(`当前组合占用 ${rawPortfolioRiskPercent.toFixed(1)}% 已超上限 ${maxPortfolioRiskPercent}%`);
  }

  const hardFailCount = reasonList.length;
  const score = clampNumber(100 - hardFailCount * 26 - softReasonList.length * 12, 0, 100);
  if (hardFailCount > 0) {
    return {
      score,
      level: "block",
      status: "BLOCK",
      summary: reasonList[0] || "执行前检查存在阻断项",
      recommendation: "先处理阻断项后再执行。",
      reasons: [...reasonList, ...softReasonList],
      canExecute: false
    };
  }

  if (softReasonList.length > 0) {
    return {
      score,
      level: "wait",
      status: "WAIT",
      summary: "当前满足硬约束，建议先复核确认后执行",
      recommendation: "建议先纸面确认后再执行。",
      reasons: [...reasonList, ...softReasonList],
      canExecute: true
    };
  }

  return {
    score,
    level: "pass",
    status: "PASS",
    summary: "符合执行条件",
    recommendation: "可直接执行开仓。",
    reasons: [...reasonList, ...softReasonList],
    canExecute: true
  };
};

const evaluatePaperExecutionReadiness = (
  state: PaperSimulationState,
  payload: AnalysisPayload | null,
  settings: Settings
): PaperExecutionReadiness => {
  const local = evaluatePaperExecutionReadinessLocal(state, payload, settings);
  const remote = normalizePaperExecutionReadiness(payload?.analysis?.tradeExecutionReadiness) ||
    normalizePaperExecutionReadiness((payload as any)?.analysis?.executionReadiness);

  if (!remote) return local;
  if (remote.level === "block") {
    return {
      ...remote,
      level: "block",
      status: "BLOCK",
      canExecute: false,
      score: Math.min(remote.score, local.score),
      reasons: mergeReasonArrays(remote.reasons, local.reasons)
    };
  }
  if (local.level === "block") {
    return {
      ...remote,
      level: "block",
      status: "BLOCK",
      canExecute: false,
      score: Math.min(remote.score, local.score),
      summary: local.summary || remote.summary,
      recommendation: local.recommendation,
      reasons: mergeReasonArrays(remote.reasons, local.reasons)
    };
  }
  if (remote.level === "wait" || local.level === "wait") {
    return {
      ...remote,
      level: "wait",
      status: "WAIT",
      canExecute: true,
      score: Math.min(remote.score, local.score),
      reasons: mergeReasonArrays(remote.reasons, local.reasons)
    };
  }
  return {
    ...remote,
    level: "pass",
    status: "PASS",
    canExecute: true,
    score: Math.min(remote.score, local.score),
    reasons: mergeReasonArrays(remote.reasons, local.reasons)
  };
};

const closePaperAllSimulationByCode = (
  state: PaperSimulationState,
  reason: PaperClosedPosition["closeReason"] = "KILL_SWITCH",
  fallbackPrice: number | undefined,
  settings: Settings
) => {
  const normalized = resetPaperStateForNewDay(normalizePaperState(state));
  if (!normalized.openPositions.length) {
    return {
      state: normalized,
      changed: false,
      message: "当前无持仓无需平仓"
    };
  }

  const now = new Date().toISOString();
  let cash = normalized.cash;
  let dailyRealizedPnl = normalized.dailyRealizedPnl;
  const closedPositions: PaperClosedPosition[] = [...normalized.closedPositions];

  for (const position of normalized.openPositions) {
    const closePrice = clampNumber(fallbackPrice, 0.01, Number.MAX_SAFE_INTEGER, position.latestPrice);
    const settle = settlePaperPosition(position, closePrice, reason, now, settings);
    cash += settle.cashDelta;
    dailyRealizedPnl += settle.record.realizedPnl;
    closedPositions.unshift(settle.record);
  }

  return {
    state: {
      ...normalized,
      cash,
      dailyRealizedPnl,
      openPositions: [],
      closedPositions
    },
    changed: true,
    message: `${reasonLabel(reason)}：全仓平仓，共 ${normalized.openPositions.length} 笔`
  };
};

const openPaperPositionFromSignal = (
  state: PaperSimulationState,
  payload: AnalysisPayload | null,
  settings: Settings
): PaperTradeAction => {
  const normalized = resetPaperStateForNewDay(normalizePaperState(state));
  const now = new Date();
  const nowIso = now.toISOString();
  const safe = normalizeSettings(settings);
  const strategyGovernance = evaluatePaperStrategyGovernance(normalized, safe);
  if (!strategyGovernance.canPaperTrade) {
    return {
      state: normalized,
      changed: false,
      message: `策略资格暂停：${strategyGovernance.reasons.join("；")}`
    };
  }
  if (!payload) return { state: normalized, message: "请先在分析页选择标的", changed: false };
  const security = payload.security;
  const analysis = payload.analysis || {};
  const tradePlan = analysis.tradePlan || {};
  const sectorName = getSectorOfPayload(payload);
  const maxSectorExposurePercent = clampNumber(safe.maxSectorExposurePercent, 10, 100, 45);
  const code = String(security?.code || "");
  const name = String(security?.name || code || "UNKNOWN");
  const latest = clampNumber(payload.quote?.latest, 0.01, Number.MAX_SAFE_INTEGER, 0);
  const executionModel = estimatePaperOrderExecutionModel(payload, safe);
  const tradePlanFillRatePercent = clampNumber(tradePlan.executionFillRatePercent, 0, 100, executionModel.fillRatePercent);
  const executionFillRatePercent = clampNumber(Math.min(executionModel.fillRatePercent, tradePlanFillRatePercent), 0, 100, executionModel.fillRatePercent);
  const marketReadiness = evaluatePaperMarketReadiness(payload, safe);
  const remoteReadiness = normalizePaperExecutionReadiness(payload?.analysis?.tradeExecutionReadiness) ||
    normalizePaperExecutionReadiness((payload as any)?.analysis?.executionReadiness);
  if (remoteReadiness?.level === "block") {
    return {
      state: normalized,
      changed: false,
      message: `执行前风控拦截：${remoteReadiness.summary}`
    };
  }
  const isBuySignal = tradePlan.signal === "BUY" || tradePlan.signal === "BUY_AGGRESSIVE";
  const todayLossStreak = getPaperLossStreakState(normalized, safe);
  const lastOpenAt = normalized.lastOpenAt;
  if (lastOpenAt) {
    const lastTs = Date.parse(lastOpenAt);
    if (Number.isFinite(lastTs)) {
      const elapsed = now.getTime() - lastTs;
      if (elapsed >= 0 && elapsed < PAPER_SIM_COOLDOWN_MS) {
        const remainMinutes = Math.max(1, Math.ceil((PAPER_SIM_COOLDOWN_MS - elapsed) / 60000));
        return {
          state: normalized,
          changed: false,
          message: `纸面开仓限频：请再等 ${remainMinutes} 分钟（冷却 ${PAPER_SIM_COOLDOWN_MINUTES} 分钟）后再试`
        };
      }
    }
  }

  if (!code || latest <= 0) return { state: normalized, message: "当前标的无有效价格", changed: false };
  if (safe.enabledPaperSim === false) return { state: normalized, message: "当前关闭纸面模拟", changed: false };
  if (!isBuySignal) return { state: normalized, message: "非买入信号，不执行", changed: false };
  const minExecutionRatePercent = clampNumber(safe.minExecutionRatePercent, 40, 100, 90);
  if (executionFillRatePercent < minExecutionRatePercent) {
    return {
      state: normalized,
      changed: false,
      message: `成交成功率不足 ${executionFillRatePercent.toFixed(1)}%，低于阈值 ${minExecutionRatePercent}%`
    };
  }
  if (marketReadiness.hard.length) {
    return {
      state: normalized,
      changed: false,
      message: `交易前市场检查阻断：${marketReadiness.hard.join("；")}`
    };
  }
  if (!(tradePlan.positionSizePercent > 0)) return { state: normalized, changed: false, message: "当前建议仓位为 0，不执行开仓" };
  if (tradePlan.killSwitchTriggered) return { state: normalized, message: "信号杀死开仓（Kill Switch）", changed: false };
  if (todayLossStreak.blockedByStreak) {
    return {
      state: normalized,
      changed: false,
      message: `日内连续亏损${todayLossStreak.consecutiveLosses}笔达到上限${todayLossStreak.maxConsecutiveLossesForStop}，今日停仓执行`
    };
  }
  if (todayLossStreak.deRiskMultiplier < 1) {
    const deRiskTag = `连续亏损${todayLossStreak.consecutiveLosses}笔，降仓系数 ${(todayLossStreak.deRiskMultiplier * 100).toFixed(1)}%`;
    const streakProjection = (tradePlan.positionSizePercent || 0) * todayLossStreak.deRiskMultiplier;
    if (streakProjection < 1) {
      return {
        state: normalized,
        changed: false,
        message: `${deRiskTag}，当前信号仓位不足`
      };
    }
  }
  const preOpenKill = evaluatePaperKillSwitch(normalized, safe);
  const lossPressureMultiplier = preOpenKill.warningTriggered
    ? clampNumber(1 - (preOpenKill.lossPressureRatio - 0.75) * 2, 0.25, 1, 1)
    : 1;
  if (preOpenKill.hardTriggered) {
    const forcedClose = closePaperAllSimulationByCode(normalized, "KILL_SWITCH", undefined, safe);
    if (forcedClose.changed) {
      return {
        ...forcedClose,
        message: `风控熔断：${preOpenKill.reasons.join("；")}，已执行全仓平仓`
      };
    }
    return { state: normalized, message: `风控熔断：${preOpenKill.reasons.join("；")}`, changed: false };
  }

  const dailyLossLimit = normalized.initialCapital * Math.max(0, safe.maxDailyRiskPercent || 0) / 100;
  if (dailyLossLimit > 0 && normalized.dailyRealizedPnl <= -dailyLossLimit) {
    return { state: normalized, message: "今日风控阈值已触发，暂停新仓", changed: false };
  }

  const readiness = evaluatePaperExecutionReadiness(normalized, payload, safe);
  if (readiness.level === "block") {
    return { state: normalized, changed: false, message: `执行前风控拦截：${readiness.summary}` };
  }

  const projectedPortfolioRiskLimit = clampNumber(safe.maxPortfolioRiskPercent ?? 70, 10, 100, 70);
  const maxSectorRiskValue = safe.maxSectorExposurePercent > 0 && sectorName
    ? normalized.initialCapital * (maxSectorExposurePercent / 100)
    : Number.POSITIVE_INFINITY;
  const currentOpenValue = normalized.openPositions.reduce(
    (sum, position) => sum + position.latestPrice * position.shares,
    0
  );
  const currentSectorExposureValue = sectorName
    ? getPaperSectorExposureValue(normalized, sectorName)
    : 0;

  const maxOpen = Math.max(1, Math.round(safe.maxOpenPositions || 2));
  const currentOpen = normalized.openPositions.length;
  if (currentOpen >= maxOpen) {
    return { state: normalized, message: `当前持仓数已达上限 ${maxOpen} 只`, changed: false };
  }
  if (normalized.openPositions.some((position) => position.code === code)) {
    return { state: normalized, message: `${code} 当前已有持仓，建议先平仓后再开仓`, changed: false };
  }

  const kellySuggestPercent = clampNumber(
    Number(tradePlan.kellyPositionPercent ?? tradePlan.positionSizePercent),
    0,
    safe.maxPositionPercent,
    0
  );
  const streakAdjustedPositionPercent = clampNumber(
    kellySuggestPercent *
      todayLossStreak.deRiskMultiplier *
      lossPressureMultiplier *
      strategyGovernance.positionMultiplier,
    0.01,
    safe.maxPositionPercent,
    0
  );
  const plannedPositionPercent = clampNumber(
    Math.min(
      Math.max(streakAdjustedPositionPercent, 1),
      safe.maxPositionPercent
    ),
    1,
    safe.maxPositionPercent,
    safe.maxPositionPercent
  );
  const plannedSizeCash = normalized.cash * (plannedPositionPercent / 100);
  const commissionRate = clampNumber(
    Number(safe.commissionBps ?? 7) / 100,
    0,
    5,
    0.09
  );
  const stopDistancePercent = clampNumber(
    clampNumber(tradePlan.stopLossDistancePercent, 0.5, 25, safe.stopLossATRMultiple * 1.3),
    0.2,
    25,
    2.8
  );
  const maxRiskMoney = normalized.cash * (safe.maxRiskPerTradePercent / 100);
  const sharesByRisk = Math.max(
    0,
    Math.floor((maxRiskMoney / (latest * (stopDistancePercent / 100) || 1)) / 100) * 100
  );
  let shares = Math.floor((plannedSizeCash / latest) / 100) * 100;
  if (sharesByRisk > 0) shares = Math.min(shares, sharesByRisk);
  let sectorAdjusted = false;
  if (sectorName && Number.isFinite(maxSectorRiskValue) && currentSectorExposureValue < maxSectorRiskValue) {
    const sectorBudgetValue = Math.max(0, maxSectorRiskValue - currentSectorExposureValue);
    const maxSharesBySector = Math.floor((sectorBudgetValue / latest) / 100) * 100;
    if (maxSharesBySector <= 0) {
      return { state: normalized, message: `${sectorName} 行业集中度已达上限 ${maxSectorExposurePercent}%，无法新增建仓`, changed: false };
    }
    if (shares > maxSharesBySector) {
      shares = maxSharesBySector;
      sectorAdjusted = true;
    }
  }

  if (shares < 100) {
    return {
      state: normalized,
      message: `风险调整后仓位不足 100 股（策略仓位系数 ${Math.round(strategyGovernance.positionMultiplier * 100)}%），本次不追单`,
      changed: false
    };
  }

  const stopPriceCandidate = clampNumber(tradePlan.stopLossPrice, 0.01, Number.MAX_SAFE_INTEGER, latest * (1 - stopDistancePercent / 100));
  const takeDistancePercent = clampNumber(
    clampNumber(tradePlan.takeProfitDistancePercent, Math.max(stopDistancePercent * 1.15, 1), 50, 4),
    1,
    50,
    4
  );
  const takePriceCandidate = clampNumber(tradePlan.takeProfitPrice, 0.01, Number.MAX_SAFE_INTEGER, latest * (1 + takeDistancePercent / 100));
  const finalStop = Math.min(stopPriceCandidate, latest * 0.99);
  const finalTake = Math.max(takePriceCandidate, latest * 1.001, latest + 0.01);

  if (!(finalTake > finalStop && finalStop > 0)) {
    return { state: normalized, message: "止盈/止损参数异常，暂不下单", changed: false };
  }

  const executionEntryPrice = clampNumber(
    latest * (1 + (Math.min(executionModel.executionSlipBps, safe.slippageBps * 2) || 0) / 10000),
    0.01,
    Number.MAX_SAFE_INTEGER,
    latest
  );
  const entryValue = shares * executionEntryPrice;
  const entryFee = entryValue * (commissionRate / 100);
  const required = entryValue + entryFee;
  if (required > normalized.cash + 1e-6) {
    shares = Math.floor((normalized.cash / (executionEntryPrice * (1 + commissionRate / 100)) / 100) * 100);
    if (shares < 100) {
      return { state: normalized, message: "资金不足，无法满足入场费用", changed: false };
    }
  }

  const finalEntryValue = shares * executionEntryPrice;
  const finalEntryFee = finalEntryValue * (commissionRate / 100);
  const finalStopLossPrice = finalStop;
  const finalTakeProfitPrice = finalTake;
  const projectedOpenExposurePercent = normalized.initialCapital > 0
    ? (currentOpenValue + finalEntryValue) / normalized.initialCapital * 100
    : 0;
  if (projectedOpenExposurePercent > projectedPortfolioRiskLimit) {
    return {
      state: normalized,
      changed: false,
      message: `组合仓位约束触发，当前持仓暴露 ${(projectedOpenExposurePercent).toFixed(1)}% > ${projectedPortfolioRiskLimit}%`
      };
    }
  if (sectorName) {
    const projectedSectorExposurePercent = normalized.initialCapital > 0
      ? (currentSectorExposureValue + finalEntryValue) / normalized.initialCapital * 100
      : 0;
    if (projectedSectorExposurePercent > maxSectorExposurePercent) {
      return {
        state: normalized,
        changed: false,
        message: `${sectorName} 行业集中度约束触发，当前行内持仓 ${(projectedSectorExposurePercent).toFixed(1)}% > ${maxSectorExposurePercent}%`
      };
    }
  }
  const nextPosition: PaperPosition = {
    id: `sim-${Date.now()}-${Math.random().toFixed(6).slice(2)}`,
    code,
    name,
    shares,
    sectorName,
    entryPrice: executionEntryPrice,
    latestPrice: latest,
    stopPrice: finalStopLossPrice,
    takePrice: finalTakeProfitPrice,
    holdingBars: 0,
    entryFee: finalEntryFee,
    feeRatePercent: commissionRate,
    openedAt: nowIso,
    planSignal: "BUY",
    strategySignature: strategyGovernance.signature,
    riskProfile: normalizeRiskProfile(safe.riskProfile),
    strategyIds: [...new Set(safe.selectedStrategies || [])],
    entryReadinessScore: readiness.score,
    entryExecutionFillRatePercent: executionFillRatePercent,
    highWaterMark: executionEntryPrice
  };
  return {
    state: {
      ...normalized,
      cash: normalized.cash - (finalEntryValue + finalEntryFee),
      lastOpenAt: nowIso,
      openPositions: [...normalized.openPositions, nextPosition],
      totalTradeCount: normalized.totalTradeCount + 1
    },
    changed: true,
      message: `已模拟开仓：${code}（${shares} 股，成交价 ${executionEntryPrice.toFixed(2)}，金额 ${finalEntryValue.toFixed(2)}）${sectorAdjusted ? `｜已按 ${sectorName} 行业上限裁剪` : ""}`
      + (lossPressureMultiplier < 1 ? `｜风控降仓 ${Math.round(lossPressureMultiplier * 100)}%` : "")
      + (strategyGovernance.positionMultiplier < 1
        ? `｜策略${strategyGovernance.status}，仓位系数 ${Math.round(strategyGovernance.positionMultiplier * 100)}%`
        : "")
  };
};

const closePaperSimulationByCode = (
  state: PaperSimulationState,
  payload: AnalysisPayload | null,
  settings: Settings,
  reason: PaperClosedPosition["closeReason"] = "MANUAL",
  closeCode?: string,
  fallbackPrice?: number
) => {
  const normalized = resetPaperStateForNewDay(normalizePaperState(state));
  const code = String(closeCode || payload?.security?.code || "");
  if (!code) return { state: normalized, message: "请先打开要平仓的标的", changed: false };
  const price = clampNumber(fallbackPrice, 0.01, Number.MAX_SAFE_INTEGER, clampNumber(payload?.quote?.latest, 0.01, Number.MAX_SAFE_INTEGER, 0));
  if (price <= 0) return { state: normalized, message: "当前标的缺少可用价格", changed: false };

  let cash = normalized.cash;
  let dailyRealizedPnl = normalized.dailyRealizedPnl;
  let changed = false;
  const now = new Date().toISOString();
  const closedPositions: PaperClosedPosition[] = [...normalized.closedPositions];
  const remain: PaperPosition[] = [];
  const matchingPositions = normalized.openPositions.filter((position) => position.code === code);
  if (!matchingPositions.length) {
    return { state: normalized, message: "当前标的无持仓", changed: false };
  }
  for (const position of normalized.openPositions) {
    if (position.code !== code) {
      remain.push(position);
      continue;
    }
    const closePrice = price;
    const settle = settlePaperPosition(position, closePrice, reason, now, settings);
    cash += settle.cashDelta;
    dailyRealizedPnl += settle.record.realizedPnl;
    closedPositions.unshift(settle.record);
    changed = true;
  }
  if (!changed) return { state: normalized, message: "当前标的无持仓可平", changed: false };
  const riskLabel = reasonLabel(reason);
  return {
    state: {
      ...normalized,
      cash,
      dailyRealizedPnl,
      openPositions: remain,
      closedPositions
    } as PaperSimulationState,
    changed: true,
    message: `${riskLabel}: ${code} 已全部平仓，共 ${matchingPositions.length} 笔`
  };
};

const advancePaperSimulationByQuote = (
  state: PaperSimulationState,
  payload: AnalysisPayload | null,
  settings: Settings
) => {
  const normalized = resetPaperStateForNewDay(normalizePaperState(state));
  if (!payload || !normalized.openPositions.length) return { state: normalized, changed: false, message: "" };
  const code = String(payload.security?.code || "");
  const safe = normalizeSettings(settings);
  const latest = clampNumber(payload.quote?.latest, 0.01, Number.MAX_SAFE_INTEGER, 0);
  const maxHoldingBars = Math.max(3, Math.round(safe.maxHoldingBars || 30));
  const trailingStopPercent = clampNumber(safe.trailingStopPercent ?? 0, 0, 25, 0);
  const now = new Date().toISOString();
  let changed = false;
  let cash = normalized.cash;
  let dailyRealizedPnl = normalized.dailyRealizedPnl;
  const closedPositions: PaperClosedPosition[] = [...normalized.closedPositions];
  const openPositions: PaperPosition[] = [];

  for (const position of normalized.openPositions) {
    if (position.code !== code) {
      openPositions.push(position);
      continue;
    }
    const holdingBars = position.holdingBars + 1;
    const highWaterMark = Math.max(position.highWaterMark, latest);
    const trailingStopPrice = trailingStopPercent > 0
      ? highWaterMark * (1 - trailingStopPercent / 100)
      : Number.MAX_SAFE_INTEGER;
    const withPrice: PaperPosition = {
      ...position,
      latestPrice: latest,
      highWaterMark,
      holdingBars
    };
    const stopHit = latest <= withPrice.stopPrice;
    const trailingStopHit = latest <= trailingStopPrice;
    const takeHit = latest >= withPrice.takePrice;
    const timeout = holdingBars >= maxHoldingBars;
    if (stopHit || trailingStopHit || takeHit || timeout) {
      const reason: PaperClosedPosition["closeReason"] = takeHit
        ? "TP"
        : stopHit
          ? "SL"
          : trailingStopHit
          ? "SL"
          : "TIME_EXIT";
      const settle = settlePaperPosition(withPrice, latest, reason, now, safe);
      cash += settle.cashDelta;
      dailyRealizedPnl += settle.record.realizedPnl;
      closedPositions.unshift(settle.record);
      changed = true;
    } else {
      openPositions.push(withPrice);
    }
  }

  const nextState = {
    ...normalized,
    cash,
    dailyRealizedPnl,
    openPositions,
    closedPositions
  };

  const killSwitch = evaluatePaperKillSwitch(nextState, settings);
  if (killSwitch.hardTriggered && nextState.openPositions.length) {
    const killAction = closePaperAllSimulationByCode(nextState, "KILL_SWITCH", latest, safe);
    if (killAction.changed) {
      return {
        ...killAction,
        message: `风控熔断：${killSwitch.reasons.join("；")}，已执行全仓平仓`
      };
    }
  }
  if (killSwitch.hardTriggered) {
    return {
      state: nextState,
      changed,
      message: `风控熔断：${killSwitch.reasons.join("；")}`
    };
  }

  if (!changed && !killSwitch.hardTriggered) return { state: normalized, changed: false, message: "" };
  return {
    state: nextState,
    changed: changed,
    message: "按行情触发了持仓闭环处理"
  };
};

const themeOptions = [
  { id: "light" as const, label: "白天", icon: Sun },
  { id: "dark" as const, label: "黑夜", icon: Moon },
  { id: "system" as const, label: "跟随系统", icon: Monitor }
];

const observationReturnLabel = (node: string) =>
  node === "all" ? "返回全部十日观察池" : `返回 ${node} 观察池`;

const executionStatusLabel = (value: unknown) => {
  const status = String(value || "WAIT").toUpperCase();
  if (status === "PASS" || status === "APPROVED") return "允许执行";
  if (status === "BLOCK" || status === "BLOCKED" || status === "REJECTED") {
    return "不可执行（风险否决）";
  }
  return "等待条件确认";
};

const tradeSignalLabel = (value: unknown) => {
  const signal = String(value || "WAIT").toUpperCase();
  if (signal === "BUY_AGGRESSIVE") return "强势买入条件满足";
  if (signal === "BUY") return "买入条件满足";
  if (signal === "SELL") return "退出或回避";
  if (signal === "HOLD") return "继续观察";
  if (signal === "BLOCK") return "不可执行（风险否决）";
  return "等待条件确认";
};

const overfitRiskLabel = (value: unknown) => {
  const risk = String(value || "").toLowerCase();
  if (risk === "low") return "低";
  if (risk === "medium" || risk === "moderate") return "中等";
  if (risk === "high") return "高";
  if (risk === "insufficient") return "样本不足";
  return risk ? "待人工复核" : "--";
};

const limitPoolSignature = (rows: any[] = [], dataDate = "") => [
  String(dataDate || ""),
  ...rows
    .filter((item) => item && typeof item === "object")
    .slice()
    .sort((left, right) => String(left?.code || "").localeCompare(String(right?.code || "")))
    .map((item) => JSON.stringify([
      item?.code ?? "",
      item?.name ?? "",
      item?.industry ?? "",
      item?.limitReason ?? "",
      item?.latest ?? null,
      item?.changePct ?? null,
      item?.turnover ?? null,
      item?.amount ?? null,
      item?.firstSealTime ?? "",
      item?.lastSealTime ?? "",
      item?.sealedAmount ?? null,
      item?.sealFloatRatio ?? null,
      item?.openBoardCount ?? null,
      item?.consecutiveBoards ?? null
    ]))
].join("|");

const limitPoolProviderLabel = (providers: string[] = []) => {
  const hasThs = providers.some((item) => String(item).startsWith("ths"));
  const hasEastmoney = providers.some((item) => String(item).startsWith("eastmoney"));
  if (hasThs && hasEastmoney) return "同花顺主源 · 东方财富补全校验";
  if (hasThs) return "同花顺";
  if (hasEastmoney) return "东方财富";
  if (providers.some((item) => String(item).startsWith("tencent"))) return "腾讯";
  if (providers.some((item) => String(item).startsWith("preview"))) return "预览数据";
  return "公开行情";
};

const computeExecutionProjection = (analysis: any, quote: any, settings: Settings) => {
  const safe = normalizeSettings(settings);
  const src = analysis || {};
  const latest = clampNumber(quote?.latest, 0.01, Number.MAX_SAFE_INTEGER, 0);
  const executionModel = estimatePaperOrderExecutionModel({ analysis: src, quote } as any, safe);
  const mrs = clampNumber(src.mrs, 50, 100, 50);
  const stopRatio = clampNumber(src.stopLossDistancePercent, 0.8, 22, 0);
  const marketCap = clampNumber(quote?.totalMarketCap || (src.marketCap || 0), 0, Number.MAX_SAFE_INTEGER, 0);
  const qualityIndex = clampNumber(
    0.6 * mrs + 0.4 * clampNumber(src.strategyMatchRate, 0, 100, 50) - clampNumber(src.maxDrawdown, 0, 20, 0) - clampNumber(src.riskPenalty, 0, 10, 0),
    0,
    100,
    0
  );
  const historicalEdge = Number.isFinite(src.historicalEdge)
    ? src.historicalEdge
    : clampNumber((src.historicalEdge || src.edge || src.marketScore || 0), -20, 80, 0);
  const historicalEdgePassed = src.qualification?.historicalEdgePassed === true
    ? true
    : historicalEdge >= 2;
  const minMarketCap = clampNumber(safe.minMarketCap, 0, 100000, 0);
  const marketCapPassed = minMarketCap <= 0 ? true : marketCap >= minMarketCap * 1e8;
  const strictGatePassed = safe.strictGate
    ? historicalEdgePassed && Boolean(auditStrategyFit(src.qualification, src.strategyMatched, src.strategyTotal))
    : true;
  const minProjectedEdge = clampNumber(safe.minProjectedNetEdgePercent ?? 0.2, -2, 10, 0.2);
  const minExpectancyPoints = clampNumber(safe.minExpectancyPoints ?? 0.2, -2, 5, 0.2);
  const effectiveAlertScore = Math.max(safe.alertScore, 60);
  const qualifiesForEntry = src.alertQualified !== false && qualityIndex >= effectiveAlertScore && historicalEdgePassed && marketCapPassed && strictGatePassed;
  const signal = qualifiesForEntry && strictGatePassed ? "BUY" : "WAIT";
  const stopDistancePercent = clampNumber(src.stopLossDistancePercent, 0.4, 20, stopRatio || 2.8);
  const rrRatio = clampNumber(
    safe.takeProfitATRMultiple / Math.max(safe.stopLossATRMultiple, 0.2),
    1.1,
    8,
    1.8
  );
  const rrSafety = clampNumber(rrRatio * (qualityIndex / 100), 0.1, 5, 1.0);
  const takeDistancePercent = clampNumber(stopDistancePercent * rrRatio, stopDistancePercent + 0.2, 40, 3.6);
  const tpBaseRate = clampNumber(
    18 + (qualityIndex - 40) * 0.7 + (signal === "BUY" ? 12 : 4),
    2,
    85,
    18
  );
  const slBaseRate = clampNumber(40 - (qualityIndex - 40) * 0.45 + (signal === "BUY" ? -2 : 0), 8, 75, 28);
  const tpProbability = signal === "BUY" ? clampNumber(tpBaseRate, 6, 85, 18) : 6;
  const slProbability = signal === "BUY" ? clampNumber(slBaseRate, 4, 80, 18) : 2;
  const timeoutProbability = clampNumber(100 - tpProbability - slProbability, 1, 100, 60);
  const quoteTurnover = clampNumber(quote?.turnover, 0, 20, 0.5);
  const relativeTurnover = clampNumber(Number(src.relativeTurnover || src.volumeRatio || 0), 0, 10, 0);
  const intradayShock = clampNumber(Math.abs(clampNumber(quote?.changePct, -20, 20, 0)), 0, 20, 0);
  const qualityExecutionFillRatePercent = clampNumber(
    18 +
      qualityIndex * 0.9 +
      Math.min(16, quoteTurnover * 2.2) +
      Math.min(12, relativeTurnover * 2.8) -
      intradayShock * 0.8 -
      Math.min(12, Math.max(0, Number(src.riskPenalty || 0)) * 1.2),
    1,
    100,
    80
  );
  const executionFillRatePercent = clampNumber(
    qualityExecutionFillRatePercent * 0.62 + executionModel.fillRatePercent * 0.38,
    1,
    100,
    executionModel.fillRatePercent
  );
  const estimatedSlippageBps = clampNumber(
    (safe.slippageBps + executionModel.executionSlipBps) / 2,
    0,
    80,
    executionModel.executionSlipBps
  );
  const minExecutionRatePercent = clampNumber(safe.minExecutionRatePercent, 40, 100, 90);
  const expectedReturnPercent = tpProbability / 100 * takeDistancePercent - slProbability / 100 * stopDistancePercent - ((safe.commissionBps + estimatedSlippageBps) / 100);
  const kellyWinRate = tpProbability / 100;
  const kellyLoseRate = 1 - kellyWinRate;
  const kellyRaw = clampNumber((kellyWinRate * rrRatio - kellyLoseRate) / rrRatio, -0.5, 1, 0);
  const halfKelly = clampNumber(kellyRaw / 2, 0, 0.5, 0);
  const qualitySignalScale = clampNumber(qualityIndex / 100, 0.25, 1, 0.75);
  const positionSizePercent = clampNumber(
    safe.maxPositionPercent * halfKelly * (0.5 + 0.5 * qualitySignalScale),
    0,
    safe.maxPositionPercent,
    0
  );
  const kellyPositionPercent = clampNumber(safe.maxPositionPercent * halfKelly, 0, safe.maxPositionPercent, 0);
  const atRiskPercent = clampNumber(positionSizePercent * (stopDistancePercent / 100), 0, safe.maxRiskPerTradePercent, 0);
  const projectedCommissionPercent = clampNumber(
    (safe.commissionBps + estimatedSlippageBps) / 100,
    0,
    5,
    0.09
  );
  const expectancyPoints = expectedReturnPercent * (positionSizePercent / Math.max(safe.maxPositionPercent, 1));
  const decay = clampNumber(safe.timeDecayPerBarPercent, 0, 1, 0.11);
  const estimatedHoldingBars = Math.max(1, Math.round(safe.maxHoldingBars * (1 - timeoutProbability / 100) * (1 - decay / 100) * (qualityIndex / 100)));
  const riskReward = Number((takeDistancePercent / Math.max(stopDistancePercent, 0.01)).toFixed(2));
  const projectedNetEdge = expectedReturnPercent - projectedCommissionPercent;
  const projectedNetEdgeAfterDecay = projectedNetEdge - qualityIndex * 0.002;
  const killSwitchReasons = (() => {
    const reasons: string[] = [];
    if (signal !== "BUY") reasons.push("未触发买入信号");
    if (qualityIndex < effectiveAlertScore) reasons.push("质量评分不足");
    if (projectedNetEdgeAfterDecay < minProjectedEdge) reasons.push("预期净收益不足");
    if (expectancyPoints < minExpectancyPoints) reasons.push("期望值不足");
    if (rrSafety < 1.1) reasons.push("风险收益比不足");
    if (tpProbability < 30) reasons.push("TP概率偏低");
    if (slProbability > 65) reasons.push("SL概率偏高");
    if (executionFillRatePercent < minExecutionRatePercent) reasons.push("成交率不足");
    if (!marketCapPassed) reasons.push("市值未达阈值");
    if (stopDistancePercent >= 16) reasons.push("止损过宽");
    return reasons;
  })();
  const killSwitchTriggered = signal === "BUY" && killSwitchReasons.length > 0;
  const tradePlan = {
    signal,
    maxPositionPercent: +positionSizePercent.toFixed(2),
    positionSizePercent: +positionSizePercent.toFixed(2),
    kellyPositionPercent: +kellyPositionPercent.toFixed(2),
    halfKellyFraction: +halfKelly.toFixed(3),
    atRiskPercent: +atRiskPercent.toFixed(3),
    riskReward,
    stopLossPrice: latest * (1 - stopDistancePercent / 100),
    takeProfitPrice: latest * (1 + takeDistancePercent / 100),
    stopLossDistancePercent: +stopDistancePercent.toFixed(2),
    takeProfitDistancePercent: +takeDistancePercent.toFixed(2),
    projectedCommissionPercent: +projectedCommissionPercent.toFixed(3),
    executionFillRatePercent: +executionFillRatePercent.toFixed(2),
    qualificationNote: signal === "BUY" ? "符合执行条件" : "未通过执行条件",
    killSwitchTriggered,
    killSwitchReasons
  };
  const tradeProjection = {
    strategyLabel: `${src.trendLabel || "趋势策略"} (${src.grade || "A"}-${src.infoScore ?? "N/A"})`,
    expectedReturnPercent: +expectedReturnPercent.toFixed(2),
    expectancyPoints: +expectancyPoints.toFixed(2),
    projectedNetEdge: +projectedNetEdge.toFixed(2),
    executionFillRatePercent: +executionFillRatePercent.toFixed(2),
    rrSafety: +rrSafety.toFixed(2),
    estimatedSlippageBps: +estimatedSlippageBps.toFixed(2),
    kellyPositionPercent: +kellyPositionPercent.toFixed(2),
    kellyHalfFraction: +halfKelly.toFixed(3),
    probabilityTakeProfit: +tpProbability.toFixed(2),
    probabilityStopLoss: +slProbability.toFixed(2),
    probabilityTimeExit: +timeoutProbability.toFixed(2),
    estimatedHoldingBars
  };
  return {
    qualityIndex,
    historicalEdge,
    historicalEdgePassed,
    marketCap,
    marketCapPassed,
    tradePlan,
    tradeProjection,
    executionPolicy: {
      riskProfile: safe.riskProfile,
      maxDailyRiskPercent: safe.maxDailyRiskPercent,
      maxHoldingBars: safe.maxHoldingBars,
      maxOpenPositions: safe.maxOpenPositions,
      timeDecayPerBarPercent: decay,
      minProjectedNetEdgePercent: minProjectedEdge,
      minExpectancyPoints,
      minExecutionRatePercent,
      trailingStopPercent: safe.trailingStopPercent,
      maxConsecutiveLossesForStop: safe.maxConsecutiveLossesForStop,
      lossStreakStepPercent: safe.lossStreakStepPercent,
      lossStreakFloorPercent: safe.lossStreakFloorPercent,
      expectedCostBps: projectedCommissionPercent * 100,
      estimatedExecutionSlipBps: estimatedSlippageBps,
      killSwitchTriggered: tradePlan.killSwitchTriggered,
      maxPortfolioRiskPercent: safeNumber(safe.maxPortfolioRiskPercent, 70),
      maxSectorExposurePercent: safe.maxSectorExposurePercent
    }
  };
};

const auditStrategyFit = (qualification: any, matched = 0, total = 0) => {
  if (qualification && typeof qualification === "object") {
    if (qualification.vetoReasons?.length) return false;
    if (typeof qualification.strength === "number" && qualification.strength < 0.5) return false;
  }
  if (Number.isFinite(total) && Number.isFinite(matched)) {
    return matched / Math.max(total, 1) >= 0.35;
  }
  return true;
};

const enrichAnalysisWithExecution = (payload: AnalysisPayload, settings: Settings): AnalysisPayload => {
  const analysis = payload?.analysis || {};
  if (!analysis || typeof analysis !== "object") return payload;
  const safeSettings = normalizeSettings(settings);
  const {
    qualityIndex,
    historicalEdge,
    historicalEdgePassed,
    marketCapPassed,
    marketCap,
    tradePlan,
    tradeProjection,
    executionPolicy
  } = computeExecutionProjection(analysis, payload.quote, safeSettings);
  const tradeExecutionReadiness = normalizePaperExecutionReadiness(analysis.tradeExecutionReadiness) ||
    normalizePaperExecutionReadiness(analysis.executionReadiness);
  return {
    ...payload,
    analysis: {
      ...analysis,
      qualityIndex,
      historicalEdge,
      historicalEdgePassed,
      marketCapPassed,
      marketCap,
      tradePlan: {
        ...tradePlan,
        ...(analysis.tradePlan || {})
      },
      tradeProjection: {
        ...tradeProjection,
        ...analysis.tradeProjection,
        projection: {
          ...tradeProjection,
          ...(analysis.tradeProjection?.projection || {})
        }
      },
      executionPolicy: {
        ...executionPolicy,
        ...(analysis.executionPolicy || {})
      },
      tradeExecutionReadiness: tradeExecutionReadiness
      }
  };
};

const fmt = (value: number | null | undefined, digits = 2) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "--";

const fmtMoney = (value: number) => {
  if (!Number.isFinite(value)) return "--";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1e8) return `${sign}${(absolute / 1e8).toFixed(2)} 亿`;
  if (absolute >= 1e4) return `${sign}${(absolute / 1e4).toFixed(0)} 万`;
  return String(Math.round(value));
};

type WindowControlAction = "minimize" | "toggle-maximize" | "close";

function WindowTitleBar() {
  const [maximized, setMaximized] = useState(false);
  const platform = window.stockApi.getPlatform?.() || "win32";

  const runControl = async (action: WindowControlAction) => {
    try {
      const result = await window.stockApi.controlWindow(action);
      if (action === "toggle-maximize" && result.ok) setMaximized(result.maximized);
    } catch {
      // Window chrome must remain independent from market data and navigation.
    }
  };

  return (
    <div
      className="window-dragbar"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("[data-window-controls]")) return;
        void runControl("toggle-maximize");
      }}
    >
      <span className={platform === "darwin" ? "window-title-macos" : undefined}>A股雷达</span>
      {platform !== "darwin" && <div className="window-controls" data-window-controls>
        <button
          type="button"
          className="window-control window-control-minimize"
          onClick={() => void runControl("minimize")}
          data-window-action="minimize"
          title="最小化"
          aria-label="最小化窗口"
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`window-control window-control-toggle-maximize ${maximized ? "is-maximized" : ""}`}
          onClick={() => void runControl("toggle-maximize")}
          data-window-action="toggle-maximize"
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
        >
          <Square aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-control window-control-close"
          onClick={() => void runControl("close")}
          data-window-action="close"
          title="关闭"
          aria-label="关闭窗口"
        >
          <X aria-hidden="true" />
        </button>
      </div>}
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [dashboardMode, setDashboardMode] = useState<"pool" | "analysis">("pool");
  const [watchlistNode, setWatchlistNode] = useState("all");
  const [analysisOrigin, setAnalysisOrigin] = useState<AnalysisOrigin | null>(null);
  const [backtestReturnMode, setBacktestReturnMode] = useState<"pool" | "analysis">("pool");
  const [backtestCenterMode, setBacktestCenterMode] = useState<"portfolio" | "single">("single");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Security[]>([]);
  const [payload, setPayload] = useState<AnalysisPayload | null>(null);
  const [analysisTarget, setAnalysisTarget] = useState<Security | string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [live, setLive] = useState(true);
  const [limitUps, setLimitUps] = useState<any[]>([]);
  const [limitPoolMeta, setLimitPoolMeta] = useState<LimitPoolMeta>({
    dataDate: "",
    fetchedAt: "",
    checkedAt: "",
    providers: [],
    count: 0,
    trigger: "startup"
  });
  const [discovering, setDiscovering] = useState(false);
  const [backtestDraft, setBacktestDraft] = useState<BacktestDraft>({
    securityCode: "",
    startDate: defaultBacktestStartDate(),
    customEntryPrice: null,
    lookbackBars: DEFAULT_SINGLE_BACKTEST_BARS,
    benchmarks: 2,
    benchmark: "all",
    minSamples: 12,
    minProjectedNetEdgePercent: initialSettings.minProjectedNetEdgePercent ?? 0.2,
    minExpectancyPoints: initialSettings.minExpectancyPoints ?? 0.2,
    minTurnoverPercent: initialSettings.minTurnoverPercent ?? 0.4,
    minQuoteAmount: initialSettings.minQuoteAmount ?? 1_200_000,
    maxQuoteAgeSeconds: initialSettings.maxQuoteAgeSeconds ?? 480,
    commissionBps: initialSettings.commissionBps ?? 7,
    slippageBps: initialSettings.slippageBps ?? 2
  });
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestError, setBacktestError] = useState("");
  const [backtestResult, setBacktestResult] = useState<any>(null);
  const [backtestCurrentRecord, setBacktestCurrentRecord] = useState<BacktestHistoryRecord | null>(null);
  const [backtestHistory, setBacktestHistory] = useState<BacktestHistoryRecord[]>(
    loadBacktestHistory(initialSettings)
  );
  const [backtestProfileComparisons, setBacktestProfileComparisons] = useState<BacktestProfileComparisonReport | null>(null);
  const [backtestEntryContext, setBacktestEntryContext] = useState<BacktestEntryContext | null>(null);
  const [sectorBoard, setSectorBoard] = useState<any[]>([]);
  const [sectorBoardLoading, setSectorBoardLoading] = useState(false);
  const [sectorBoardLoaded, setSectorBoardLoaded] = useState(false);
  const [sectorBoardError, setSectorBoardError] = useState("");
  const [strategyMenuOpen, setStrategyMenuOpen] = useState(false);
  const [reviewMounted, setReviewMounted] = useState(false);
  const [version, setVersion] = useState("0.1.0");
  const [paperState, setPaperState] = useState<PaperSimulationState>(loadPaperState);
  const [executionDecisionLog, setExecutionDecisionLog] = useState<ExecutionDecisionLog[]>(loadExecutionDecisionLog);
  const [pendingDecision, setPendingDecision] = useState<PendingInlineDecision | null>(null);
  const searchTimer = useRef<number>();
  const searchRequestId = useRef(0);
  const analysisRequestId = useRef(0);
  const limitPoolRequestId = useRef(0);
  const limitPoolSignatureRef = useRef("");
  const limitPoolManualRefresh = useRef(false);
  const sectorBoardRequestId = useRef(0);
  const sectorBoardBusy = useRef(false);
  const backtestRequestId = useRef(0);
  const backtestComparisonRequestId = useRef(0);
  const toastTimer = useRef<number>();
  const voiceSeenIds = useRef<Set<string>>(new Set());
  const voiceFeedSeeded = useRef(false);
  const paperStateRef = useRef(paperState);
  const settingsRef = useRef<Settings>(normalizeSettings(initialSettings));
  const settingsChangedDuringStartupRef = useRef(false);
  const observationExclusionsRef = useRef<ObservationExclusion[]>([]);
  const observationExclusionsLoadedRef = useRef(false);
  if (!observationExclusionsLoadedRef.current) {
    observationExclusionsLoadedRef.current = true;
    observationExclusionsRef.current = normalizeObservationExclusions(
      loadSafeLocalJson<unknown>(OBSERVATION_EXCLUSIONS_KEY, [])
    );
  }

  const showToast = (message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  };

  const requestInlineDecision = (
    prompt: InlineDecisionPrompt,
    onConfirm: () => void,
    onCancel: () => void
  ) => {
    setPendingDecision({
      prompt,
      onConfirm: () => {
        setPendingDecision(null);
        onConfirm();
      },
      onCancel: () => {
        setPendingDecision(null);
        onCancel();
      }
    });
  };

  const updateBacktestDraft = (updater: (current: BacktestDraft) => BacktestDraft) => {
    backtestRequestId.current += 1;
    backtestComparisonRequestId.current += 1;
    setBacktestLoading(false);
    setBacktestError("");
    setBacktestResult(null);
    setBacktestCurrentRecord(null);
    setBacktestProfileComparisons(null);
    setBacktestDraft(updater);
  };

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  useEffect(() => {
    paperStateRef.current = paperState;
  }, [paperState]);

  const commitLimitUpPool = useCallback((snapshot: any, requestId: number, trigger: LimitPoolMeta["trigger"]) => {
    if (requestId !== limitPoolRequestId.current) return null;
    if (!Array.isArray(snapshot) && !Array.isArray(snapshot?.rows)) {
      throw new Error("涨停池响应结构异常，已保留上次有效数据");
    }
    const rows = Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    const responseMeta = !Array.isArray(snapshot) && snapshot?.meta && typeof snapshot.meta === "object"
      ? snapshot.meta
      : {};
    const dataDate = String(responseMeta.dataDate || rows[0]?.limitDate || "");
    const signature = limitPoolSignature(rows, dataDate);
    const previousSignature = limitPoolSignatureRef.current;
    const providers = Array.isArray(responseMeta.providers)
      ? responseMeta.providers.map(String)
      : [...new Set(rows.map((item: any) => String(item?.dataProvider || "")).filter(Boolean))];
    const nextMeta: LimitPoolMeta = {
      dataDate,
      fetchedAt: String(responseMeta.fetchedAt || new Date().toISOString()),
      checkedAt: new Date().toISOString(),
      providers,
      count: rows.length,
      trigger
    };
    limitPoolSignatureRef.current = signature;
    setLimitUps(rows);
    setLimitPoolMeta(nextMeta);
    return {
      changed: signature !== previousSignature,
      meta: nextMeta,
      rows
    };
  }, []);

  const appendExecutionDecisionLog = (entry: Omit<ExecutionDecisionLog, "id" | "createdAt">) => {
    const next = buildExecutionDecisionLogEntry(entry);
    setExecutionDecisionLog((current) => [next, ...current].slice(0, EXECUTION_DECISION_LOG_LIMIT));
  };
  const clearExecutionDecisionLog = () => {
    setExecutionDecisionLog([]);
  };

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
    settingsRef.current = normalizeSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (view === "review") setReviewMounted(true);
  }, [view]);

  useEffect(() => {
    if (!saveSafeLocalJson(PAPER_SIM_STATE_KEY, normalizePaperState(paperState))) {
      // Persisting paper simulation state is optional.
    }
  }, [paperState]);

  useEffect(() => {
    if (!saveSafeLocalJson(
      EXECUTION_DECISION_LOG_KEY,
      executionDecisionLog.slice(0, EXECUTION_DECISION_LOG_LIMIT)
    )) {
      // Persisting execution decision log is optional.
    }
  }, [executionDecisionLog]);

  useEffect(() => {
    if (!saveSafeLocalJson(
      BACKTEST_HISTORY_KEY,
      backtestHistory.slice(0, BACKTEST_HISTORY_LIMIT)
    )) {
      // Persisting backtest history is optional.
    }
  }, [backtestHistory]);

  useEffect(() => {
    document.querySelector<HTMLElement>(".page")?.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

  const toSafeBacktestSettings = (nextSettings: Settings) => {
  const safe = normalizeSettings(nextSettings);
  return {
    selectedStrategies: safe.selectedStrategies,
    riskProfile: safe.riskProfile,
    minProjectedNetEdgePercent: safe.minProjectedNetEdgePercent,
    minExpectancyPoints: safe.minExpectancyPoints,
    minTurnoverPercent: safe.minTurnoverPercent,
    minQuoteAmount: safe.minQuoteAmount,
    maxQuoteAgeSeconds: safe.maxQuoteAgeSeconds,
    commissionBps: safe.commissionBps,
    slippageBps: safe.slippageBps,
    maxPositionPercent: safe.maxPositionPercent,
      maxRiskPerTradePercent: safe.maxRiskPerTradePercent,
      stopLossATRMultiple: safe.stopLossATRMultiple,
      takeProfitATRMultiple: safe.takeProfitATRMultiple,
      maxHoldingBars: safe.maxHoldingBars,
      maxOpenPositions: safe.maxOpenPositions,
      maxDailyRiskPercent: safe.maxDailyRiskPercent,
      maxPortfolioRiskPercent: safe.maxPortfolioRiskPercent,
      maxSectorExposurePercent: safe.maxSectorExposurePercent,
      minExecutionRatePercent: safe.minExecutionRatePercent,
      trailingStopPercent: safe.trailingStopPercent,
      maxConsecutiveLossesForStop: safe.maxConsecutiveLossesForStop,
      lossStreakStepPercent: safe.lossStreakStepPercent,
      lossStreakFloorPercent: safe.lossStreakFloorPercent,
      timeDecayPerBarPercent: safe.timeDecayPerBarPercent,
      minPaperWinRatePercent: safe.minPaperWinRatePercent,
      minPaperRiskRewardRatio: safe.minPaperRiskRewardRatio
    };
  };

  const toBacktestStrategyProfile = (nextSettings: Settings): BacktestStrategyProfile => {
    const safe = normalizeSettings(nextSettings);
    return {
      selectedStrategies: normalizeBacktestStrategyIds(safe.selectedStrategies),
      riskProfile: safe.riskProfile,
      minProjectedNetEdgePercent: safe.minProjectedNetEdgePercent,
      minExpectancyPoints: safe.minExpectancyPoints,
      minTurnoverPercent: safe.minTurnoverPercent,
      minQuoteAmount: safe.minQuoteAmount,
      maxQuoteAgeSeconds: safe.maxQuoteAgeSeconds,
      commissionBps: safe.commissionBps,
      slippageBps: safe.slippageBps,
      maxPositionPercent: safe.maxPositionPercent,
      maxRiskPerTradePercent: safe.maxRiskPerTradePercent,
      stopLossATRMultiple: safe.stopLossATRMultiple,
      takeProfitATRMultiple: safe.takeProfitATRMultiple,
      maxHoldingBars: safe.maxHoldingBars,
      maxOpenPositions: safe.maxOpenPositions,
      maxDailyRiskPercent: safe.maxDailyRiskPercent,
      maxPortfolioRiskPercent: safe.maxPortfolioRiskPercent,
      maxSectorExposurePercent: safe.maxSectorExposurePercent,
      minExecutionRatePercent: safe.minExecutionRatePercent,
      trailingStopPercent: safe.trailingStopPercent,
      lossStepPercent: safe.lossStreakStepPercent,
      lossFloorPercent: safe.lossStreakFloorPercent,
      maxConsecutiveLossesForStop: safe.maxConsecutiveLossesForStop,
      timeDecayPerBarPercent: safe.timeDecayPerBarPercent
    };
  };

  const formatStrategyDiffValue = (value: string[]) => {
    if (!value.length) return "未设置";
    const normalized = [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
    const visible = normalized.slice(0, 5).join(" / ");
    return normalized.length > 5 ? `${visible} 等${normalized.length}项` : visible;
  };

  const buildBacktestProfileDiff = (
    source: BacktestStrategyProfile,
    target: BacktestStrategyProfile
  ) => {
    const diff = [] as Array<{ label: string; sourceValue: string; targetValue: string }>;
    const addTextDiff = (label: string, left: string, right: string) => {
      if (left === right) return;
      diff.push({ label, sourceValue: left, targetValue: right });
    };
  const addNumberDiff = (
    label: string,
    left: number,
    right: number,
    precision = 0.01,
    suffix = ""
  ) => {
      if (!Number.isFinite(left) || !Number.isFinite(right)) return;
    if (Math.abs(left - right) <= precision) return;
    const format = (value: number) => `${value.toFixed(2)}${suffix}`;
    addTextDiff(label, format(left), format(right));
  };

  addTextDiff("风险档位", riskProfileLabel(source.riskProfile), riskProfileLabel(target.riskProfile));
  if (!sameStrategySet(source.selectedStrategies, target.selectedStrategies)) {
      diff.push({
        label: "策略组合",
        sourceValue: formatStrategyDiffValue(source.selectedStrategies),
        targetValue: formatStrategyDiffValue(target.selectedStrategies)
      });
    }

  addNumberDiff("最小预期净收益", source.minProjectedNetEdgePercent, target.minProjectedNetEdgePercent, 0.01, "%");
  addNumberDiff("最小期望值", source.minExpectancyPoints, target.minExpectancyPoints, 0.01, "");
  addNumberDiff("最低成交额", source.minQuoteAmount, target.minQuoteAmount, 10000, "元");
  addNumberDiff("最低换手率", source.minTurnoverPercent, target.minTurnoverPercent, 0.05, "%");
  addNumberDiff("最大行情时延", source.maxQuoteAgeSeconds, target.maxQuoteAgeSeconds, 5, "秒");
  addNumberDiff("佣金", source.commissionBps, target.commissionBps, 0.01, "BPS");
    addNumberDiff("滑点", source.slippageBps, target.slippageBps, 0.01, "BPS");
    addNumberDiff("最大仓位", source.maxPositionPercent, target.maxPositionPercent, 0.1, "%");
    addNumberDiff("单笔风险上限", source.maxRiskPerTradePercent, target.maxRiskPerTradePercent, 0.01, "%");
    addNumberDiff("止损ATR", source.stopLossATRMultiple, target.stopLossATRMultiple, 0.01, "x");
    addNumberDiff("止盈ATR", source.takeProfitATRMultiple, target.takeProfitATRMultiple, 0.01, "x");
    addNumberDiff("最大持仓Bars", source.maxHoldingBars, target.maxHoldingBars, 1, " 根");
    addNumberDiff("最大持仓数", source.maxOpenPositions, target.maxOpenPositions, 1);
    addNumberDiff("日内最大风险", source.maxDailyRiskPercent, target.maxDailyRiskPercent, 0.01, "%");
    addNumberDiff("组合仓位上限", source.maxPortfolioRiskPercent, target.maxPortfolioRiskPercent, 0.01, "%");
    addNumberDiff("行业仓位上限", source.maxSectorExposurePercent, target.maxSectorExposurePercent, 0.01, "%");
    addNumberDiff("最小成交率", source.minExecutionRatePercent, target.minExecutionRatePercent, 0.5, "%");
    addNumberDiff("追踪止损", source.trailingStopPercent, target.trailingStopPercent, 0.01, "%");
    addNumberDiff("减仓步幅", source.lossStepPercent, target.lossStepPercent, 0.5, "%");
    addNumberDiff("减仓下限", source.lossFloorPercent, target.lossFloorPercent, 0.5, "%");
    addNumberDiff("连续亏损停手", source.maxConsecutiveLossesForStop, target.maxConsecutiveLossesForStop, 1);
    addNumberDiff("时间衰减", source.timeDecayPerBarPercent, target.timeDecayPerBarPercent, 0.01, "%");

    return diff;
  };

const normalizeBacktestExecutionReadiness = (input: any): BacktestExecutionReadiness | null => {
  if (!input || typeof input !== "object") return null;
  const level =
    input.level === "pass" || input.level === "wait" || input.level === "block"
      ? input.level
      : null;
  if (!level) return null;
  const status =
    input.status === "PASS" || input.status === "WAIT" || input.status === "BLOCK"
      ? input.status
      : level === "pass" ? "PASS" : level === "wait" ? "WAIT" : "BLOCK";
  const scoreValue = Number(input.score);
  if (!Number.isFinite(scoreValue)) return null;
  const score = clampNumber(Math.round(scoreValue), 0, 100, 0);
  const recommendation =
    typeof input.recommendation === "string" && input.recommendation.trim()
      ? input.recommendation
      : status === "PASS"
        ? "可用于执行"
        : status === "WAIT"
          ? "建议先确认再执行"
          : "不建议执行";
  const reasons = Array.isArray(input.reasons)
    ? input.reasons.filter((item: unknown): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  const canRunLive =
    level === "pass" ? (Boolean(input.canRunLive) || input.canRunLive === undefined) : false;

  return {
    score,
    level,
    status,
    recommendation,
    reasons: reasons.length ? reasons : ["执行评估已完成"],
    canRunLive
  };
};

type BacktestDeRiskProfileResult = {
  profile: BacktestStrategyProfile;
  adjustments: string[];
};

const buildBacktestDeRiskProfile = (
  source: BacktestStrategyProfile,
  readiness: BacktestExecutionReadiness
): BacktestDeRiskProfileResult => {
  const score = clampNumber(readiness.score, 0, 100, 60);
  const riskScale = score >= 72
    ? 0.72
    : score >= 62
      ? 0.64
      : 0.56;

  const next: BacktestStrategyProfile = {
    ...source,
    maxPositionPercent: clampNumber(source.maxPositionPercent * riskScale, 5, 90, source.maxPositionPercent),
    maxRiskPerTradePercent: clampNumber(source.maxRiskPerTradePercent * riskScale, 0.2, 5, source.maxRiskPerTradePercent),
    stopLossATRMultiple: clampNumber(source.stopLossATRMultiple * 0.9, 0.8, 5, source.stopLossATRMultiple),
    maxHoldingBars: clampNumber(Math.round(source.maxHoldingBars * 0.82), 3, 120, source.maxHoldingBars),
    maxOpenPositions: clampNumber(Math.max(1, Math.round(source.maxOpenPositions * 0.66)), 1, 10, source.maxOpenPositions),
    maxDailyRiskPercent: clampNumber(source.maxDailyRiskPercent * 0.75, 0.3, 12, source.maxDailyRiskPercent),
    maxPortfolioRiskPercent: clampNumber(source.maxPortfolioRiskPercent * 0.8, 10, 100, source.maxPortfolioRiskPercent),
    maxSectorExposurePercent: clampNumber(source.maxSectorExposurePercent * 0.9, 10, 100, source.maxSectorExposurePercent),
    minExecutionRatePercent: clampNumber(Math.min(source.minExecutionRatePercent + 6, 100), 40, 100, source.minExecutionRatePercent),
    trailingStopPercent: clampNumber(source.trailingStopPercent * 1.18, 0, 25, source.trailingStopPercent),
    lossStepPercent: clampNumber(source.lossStepPercent * 1.15, 2, 60, source.lossStepPercent),
    lossFloorPercent: clampNumber(source.lossFloorPercent * 0.9, 10, 80, source.lossFloorPercent),
    maxConsecutiveLossesForStop: clampNumber(
      Math.max(2, source.maxConsecutiveLossesForStop - 1),
      2,
      12,
      source.maxConsecutiveLossesForStop
    ),
    timeDecayPerBarPercent: clampNumber(source.timeDecayPerBarPercent * 1.18, 0, 1, source.timeDecayPerBarPercent)
  };

  next.takeProfitATRMultiple = clampNumber(
    Math.max(source.takeProfitATRMultiple * 0.9, next.stopLossATRMultiple * 1.2),
    1,
    10,
    source.takeProfitATRMultiple
  );

  const adjustments: string[] = [];
  const addDiff = (label: string, left: number, right: number, suffix = "") => {
    if (Math.abs(left - right) < 0.02) return;
    adjustments.push(`${label}：${left.toFixed(2)}${suffix} -> ${right.toFixed(2)}${suffix}`);
  };
  addDiff("最大仓位", source.maxPositionPercent, next.maxPositionPercent, "%");
  addDiff("单笔风险", source.maxRiskPerTradePercent, next.maxRiskPerTradePercent, "%");
  addDiff("止损ATR", source.stopLossATRMultiple, next.stopLossATRMultiple, "x");
  addDiff("止盈ATR", source.takeProfitATRMultiple, next.takeProfitATRMultiple, "x");
  addDiff("最大持仓Bars", source.maxHoldingBars, next.maxHoldingBars, " 根");
  addDiff("最大并行仓位", source.maxOpenPositions, next.maxOpenPositions);
  addDiff("日内最大风险", source.maxDailyRiskPercent, next.maxDailyRiskPercent, "%");
  addDiff("组合仓位上限", source.maxPortfolioRiskPercent, next.maxPortfolioRiskPercent, "%");
  addDiff("行业仓位上限", source.maxSectorExposurePercent, next.maxSectorExposurePercent, "%");
  addDiff("减仓步幅", source.lossStepPercent, next.lossStepPercent, "%");
  addDiff("减仓下限", source.lossFloorPercent, next.lossFloorPercent, "%");
  addDiff("连续亏损熔断", source.maxConsecutiveLossesForStop, next.maxConsecutiveLossesForStop, " 次");

  return {
    profile: next,
    adjustments: adjustments.length
      ? adjustments
      : ["已触发“等待确认”风控兜底，自动收紧仓位与持仓约束"]
  };
};

const evaluateBacktestExecutionReadiness = (
  metrics: Record<string, any> | null,
  profileDiffs: Array<{ label: string; sourceValue: string; targetValue: string }>,
  executionReadinessInput?: any
): BacktestExecutionReadiness => {
  const remote = normalizeBacktestExecutionReadiness(executionReadinessInput);
  if (!metrics || typeof metrics !== "object") {
    if (remote) {
      return remote;
    }
    return {
      score: 0,
      level: "block",
      status: "BLOCK",
      recommendation: "请先完成回测后再评估执行。",
      reasons: ["当前缺少完整回测指标。"],
      canRunLive: false
    };
  }

  const replayableSignals = Number(metrics.replayableSignals);
  const accepted = Boolean(metrics.accepted);
  const projectedNetEdge = Number(metrics.projectedNetEdge);
  const expectancy5 = Number(metrics.expectancy5);
  const winRate5 = Number(metrics.winRate5);
  const worstMdd5 = Number(metrics.worstMdd5);
  const averageExcess5 = Number(metrics.avgExcess5);

  const sampleScore = clampNumber(Number.isFinite(replayableSignals) ? Math.min(30, replayableSignals / 4) : 0, 0, 30);
  const edgeScore = clampNumber(
    Number.isFinite(projectedNetEdge) ? Math.min(22, (projectedNetEdge + 2) * 5) : 0,
    0,
    22
  );
  const expectancyScore = clampNumber(
    Number.isFinite(expectancy5) ? Math.min(20, (expectancy5 + 3) * 5) : 0,
    0,
    20
  );
  const winRateScore = clampNumber(
    Number.isFinite(winRate5) ? Math.min(18, winRate5 / 6) : 0,
    0,
    18
  );
  const drawdownScore = clampNumber(
    Number.isFinite(worstMdd5) ? Math.min(16, 16 - Math.max(0, -worstMdd5) * 1.4) : 0,
    0,
    16
  );
  const excessScore = clampNumber(
    Number.isFinite(averageExcess5) ? Math.min(10, Math.max(0, (averageExcess5 + 1) * 3)) : 0,
    0,
    10
  );
  const diffPenalty = clampNumber(profileDiffs.length * 2.5, 0, 24);
  const rawScore = sampleScore + edgeScore + expectancyScore + winRateScore + drawdownScore + excessScore - diffPenalty;
  let score = clampNumber(Math.round(rawScore - (accepted ? 0 : 28)), 0, 100);

  const reasons: string[] = [];
  if (!accepted) reasons.push(`预检未通过：${metrics.passReason || "参数门槛未满足"}`);
  if (!Number.isFinite(replayableSignals) || replayableSignals < 18) reasons.push(`样本偏少：${Number.isFinite(replayableSignals) ? replayableSignals.toFixed(0) : "--"} 条`);
  if (Number.isFinite(projectedNetEdge) && projectedNetEdge < 0.5) reasons.push(`净收益率偏低：${projectedNetEdge.toFixed(2)}%`);
  if (Number.isFinite(expectancy5) && expectancy5 < 0.6) reasons.push(`期望值偏低：${expectancy5.toFixed(2)}`);
  if (Number.isFinite(winRate5) && winRate5 < 52) reasons.push(`5 日胜率不足：${winRate5.toFixed(1)}%`);
  if (Number.isFinite(worstMdd5) && worstMdd5 <= -7.5) reasons.push(`回撤偏深：${worstMdd5.toFixed(2)}%`);
  if (Number.isFinite(averageExcess5) && averageExcess5 < 0) reasons.push(`历史样本5日平均超额为负：${averageExcess5.toFixed(2)}%`);
  if (profileDiffs.length > 0) reasons.push(`执行参数与回测快照差异 ${profileDiffs.length} 项`);

  let level: BacktestExecutionReadiness["level"] = "block";
  if (score >= 75 && accepted && profileDiffs.length <= 2 && worstMdd5 > -8 && replayableSignals >= 18) {
    level = "pass";
  } else if (score >= 58 && accepted && profileDiffs.length <= 5 && replayableSignals >= 12) {
    level = "wait";
  }

  const local: BacktestExecutionReadiness = {
    score,
    level,
    status: level === "pass" ? "PASS" : level === "wait" ? "WAIT" : "BLOCK",
    recommendation:
      level === "pass"
        ? "可进入执行评估：先小规模纸面试跑，再逐步放大。"
        : level === "wait"
          ? "建议先进行纸面模拟 + 进一步参数对齐，等待更稳定信号。"
          : "不建议执行：先补齐样本、优化边界后再评估。",
    reasons: reasons.length ? reasons : ["当前回测指标结构完整，执行可尝试推进。"],
    canRunLive: level === "pass"
  };

  if (!remote) return local;
  if (remote.level === "block" || local.level === "block") {
    return {
      score: Math.min(remote.score, local.score),
      level: "block",
      status: "BLOCK",
      recommendation: remote.level === "block"
        ? remote.recommendation
        : local.recommendation,
      reasons: mergeReasonArrays(remote.reasons, local.reasons),
      canRunLive: false
    };
  }
  if (remote.level === "wait" || local.level === "wait") {
    return {
      score: Math.min(remote.score, local.score),
      level: "wait",
      status: "WAIT",
      recommendation: remote.recommendation || local.recommendation,
      reasons: mergeReasonArrays(remote.reasons, local.reasons),
      canRunLive: false
    };
  }
  return {
    ...remote,
    score: Math.min(remote.score, local.score),
    reasons: mergeReasonArrays(remote.reasons, local.reasons),
    recommendation: remote.recommendation || local.recommendation,
    canRunLive: remote.canRunLive && local.canRunLive
  };
};

const buildBacktestExecutionPlan = (
  metrics: Record<string, any> | null,
  readiness: BacktestExecutionReadiness,
  profile: BacktestStrategyProfile
): BacktestExecutionPlan => {
  if (!metrics || typeof metrics !== "object") {
    return {
      canExecute: false,
      confidence: 0,
      signal: "WAIT",
      positionSizePercent: 0,
      stopLossPercent: 2,
      takeProfitPercent: 3,
      riskRewardRatio: 1.5,
      estimatedHoldingBars: Number.isFinite(Number(profile.maxHoldingBars)) ? Number(profile.maxHoldingBars) : 10,
      expectedNetEdge: 0,
      rationale: ["缺少回测指标，无法产出交易计划。"]
    };
  }

  const accepted = Boolean(metrics.accepted);
  const replayableSignals = Number(metrics.replayableSignals);
  const projectedNetEdge = Number(metrics.projectedNetEdge);
  const expectancy5 = Number(metrics.expectancy5);
  const winRate5 = Number(metrics.winRate5);
  const worstMdd5 = Number(metrics.worstMdd5);

  const basePosition = clampNumber(Number(profile.maxPositionPercent), 1, 100, 30);
  const stopLossPercent = clampNumber((Number(profile.stopLossATRMultiple) || 2) * 1.8, 0.5, 7, 2);
  const takeProfitBase = clampNumber((Number(profile.takeProfitATRMultiple) || 4) * 1.45, 1, 12, 4);
  const sampleFactor = clampNumber(Number.isFinite(replayableSignals) ? replayableSignals / 16 : 1, 0.4, 1.4, 0.9);
  const edgeFactor = clampNumber(
    Number.isFinite(projectedNetEdge) ? (projectedNetEdge + 2) / 6 : 1,
    0.45,
    1.4,
    1
  );
  const expectancyFactor = clampNumber(
    Number.isFinite(expectancy5) ? (expectancy5 + 2.5) / 4.5 : 1,
    0.5,
    1.35,
    1
  );
  const drawdownPenalty = clampNumber(
    Number.isFinite(worstMdd5) ? Math.min(0.45, Math.max(0, -worstMdd5) / 18) : 0.15,
    0,
    0.45,
    0.12
  );
  const qualityFactor = clampNumber(readiness.score / 100, 0.25, 1, 0.4);

  const dynamicPosition = clampNumber(
    basePosition * sampleFactor * edgeFactor * expectancyFactor * (1 - drawdownPenalty) * qualityFactor,
    1,
    basePosition,
    clampNumber(basePosition * 0.35, 1, 100, 5)
  );
  const dynamicTake = clampNumber(takeProfitBase * (0.75 + edgeFactor * 0.5) * (readiness.level === "pass" ? 1 : 0.86), stopLossPercent + 0.2, 12, 4);
  const expectedEdge = Number.isFinite(projectedNetEdge) ? projectedNetEdge : 0;
  const estimatedHoldingBars = clampNumber(
    Number.isFinite(Number(profile.maxHoldingBars)) ? Number(profile.maxHoldingBars) : 12,
    1,
    120,
    12
  );

  const rationale = [
    `信号质量评分 ${readiness.score}，当前执行评估为“${executionStatusLabel(readiness.status)}”。`
  ];
  if (!accepted) rationale.push("回测预检未通过，仅支持复核评估。");
  if (readiness.level === "wait") rationale.push("当前仍需等待条件确认，建议先纸面演练再考虑执行。");
  if (!Number.isFinite(replayableSignals) || replayableSignals < 18) rationale.push(`样本量偏少：${Number.isFinite(replayableSignals) ? replayableSignals.toFixed(0) : "--"} 条`);
  if (Number.isFinite(winRate5) && winRate5 < 52) rationale.push(`最近期胜率偏弱：${winRate5.toFixed(1)}%`);
  if (Number.isFinite(projectedNetEdge) && projectedNetEdge < 0.8) rationale.push(`预期收益偏弱：${projectedNetEdge.toFixed(2)}%`);

  return {
    canExecute: readiness.level !== "block",
    confidence: Math.round(qualityFactor * 100),
    signal: accepted && readiness.level !== "block" ? "BUY" : "WAIT",
    positionSizePercent: Math.round(dynamicPosition * 10) / 10,
    stopLossPercent: Math.round(stopLossPercent * 10) / 10,
    takeProfitPercent: Math.round(dynamicTake * 10) / 10,
    riskRewardRatio: Math.round((dynamicTake / Math.max(stopLossPercent, 0.01)) * 10) / 10,
    estimatedHoldingBars: Math.round(estimatedHoldingBars),
    expectedNetEdge: Math.round(expectedEdge * 100) / 100,
    rationale: rationale.length ? rationale : ["依据回测指标生成的保守执行方案"]
  };
};

  const setThemeMode = async (theme: Settings["theme"]) => {
    const next = normalizeSettings({ ...settings, theme });
    settingsChangedDuringStartupRef.current = true;
    setSettings(next);
    try {
      await window.stockApi.setTheme(theme);
      setSettings(normalizeSettings(await window.stockApi.saveSettings(next)));
    } catch {
      showToast("主题保存失败");
    }
  };

  const loadSecurity = useCallback(async (
    security: Security | string,
    silent = false,
    forceRefresh = false
  ) => {
    const requestId = ++analysisRequestId.current;
    if (!silent) {
      setAnalysisTarget(security);
      setPayload(null);
      setLoading(true);
      setError("");
      setSuggestions([]);
    }
    try {
      const next = await window.stockApi.analyze(security, { forceRefresh });
      if (requestId !== analysisRequestId.current) return;
      const nextPayload = enrichAnalysisWithExecution(next, settingsRef.current);
      setPayload(nextPayload);
      setAnalysisTarget(nextPayload.security);
      setPaperState((current) => {
        const updated = advancePaperSimulationByQuote(current, nextPayload, settingsRef.current);
        return updated.state;
      });
      if (!silent) setQuery("");
      if (next.warning) showToast(next.warning);
    } catch (e) {
      if (requestId !== analysisRequestId.current) return;
      if (silent) showToast("刷新失败，继续显示上次有效行情");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === analysisRequestId.current) setLoading(false);
    }
  }, []);

  const runBacktestWithSettings = async (draft: BacktestDraft, profileSettings: Settings) => {
    const safeSettings = normalizeSettings(profileSettings);
    const normalizedDraft = normalizeBacktestDraft(draft);
    const selectedStrategies = normalizedDraft.strategyContext?.strategyIds?.length
      ? normalizedDraft.strategyContext.strategyIds
      : safeSettings.selectedStrategies;
    const backtestSecurity = normalizedDraft.security?.code === normalizedDraft.securityCode
      ? normalizedDraft.security
      : normalizedDraft.securityCode;
    return await window.stockApi.runBacktest(backtestSecurity, {
      startDate: normalizedDraft.startDate,
      customEntryPrice: normalizedDraft.customEntryPrice,
      lookbackBars: clampNumber(
        normalizedDraft.lookbackBars,
        MIN_SINGLE_BACKTEST_BARS,
        MAX_SINGLE_BACKTEST_BARS,
        DEFAULT_SINGLE_BACKTEST_BARS
      ),
      benchmarks: clampNumber(normalizedDraft.benchmarks, 1, 10, 2),
      benchmark: normalizedDraft.benchmark,
      minSamples: clampNumber(normalizedDraft.minSamples, 1, 300, 12),
      ...(normalizedDraft.strategyContext
        ? {
            strategyContext: normalizedDraft.strategyContext,
            signalStrategyIds: normalizedDraft.strategyContext.strategyIds
          }
        : {}),
      settings: {
        ...toSafeBacktestSettings(safeSettings),
        selectedStrategies,
        minProjectedNetEdgePercent: clampNumber(normalizedDraft.minProjectedNetEdgePercent, -2, 10, safeSettings.minProjectedNetEdgePercent),
        minExpectancyPoints: clampNumber(normalizedDraft.minExpectancyPoints, -2, 8, safeSettings.minExpectancyPoints),
        minTurnoverPercent: clampNumber(normalizedDraft.minTurnoverPercent, 0, 20, safeSettings.minTurnoverPercent ?? 0.4),
        minQuoteAmount: clampNumber(normalizedDraft.minQuoteAmount, 0, 1_000_000_000, safeSettings.minQuoteAmount ?? 1200000),
        maxQuoteAgeSeconds: clampNumber(normalizedDraft.maxQuoteAgeSeconds, 30, 1800, safeSettings.maxQuoteAgeSeconds ?? 480),
        commissionBps: clampNumber(normalizedDraft.commissionBps, 0, 60, safeSettings.commissionBps),
        slippageBps: clampNumber(normalizedDraft.slippageBps, 0, 40, safeSettings.slippageBps)
      }
    });
  };

  const runBacktest = async (draft: BacktestDraft) => {
    const normalizedDraft = normalizeBacktestDraft(draft);
    const code = String(normalizedDraft.securityCode || "").trim();
    if (!code || !/^\d{6}$/.test(code)) {
      setBacktestError("请先选择股票名称或输入6位A股代码");
      return;
    }
    const requestId = ++backtestRequestId.current;
    backtestComparisonRequestId.current += 1;
    const settingsSnapshot = normalizeSettings(settings);
    setBacktestLoading(true);
    setBacktestError("");
    setBacktestResult(null);
    setBacktestCurrentRecord(null);
    setBacktestProfileComparisons(null);
    try {
      const result = await runBacktestWithSettings(normalizedDraft, settingsSnapshot);
      if (requestId !== backtestRequestId.current) return;
      const record = buildBacktestHistoryRecord(normalizedDraft, result, settingsSnapshot);
      setBacktestResult(result);
      setBacktestCurrentRecord(record);
      setBacktestHistory((current) =>
        [record, ...current.filter((item) => item.id !== record.id)].slice(0, BACKTEST_HISTORY_LIMIT)
      );
    } catch (reason) {
      if (requestId === backtestRequestId.current) {
        setBacktestError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestId === backtestRequestId.current) setBacktestLoading(false);
    }
  };

  const runBacktestProfileComparisons = async (draft: BacktestDraft) => {
    const code = String(draft.securityCode || "").trim();
    if (!code || !/^\d{6}$/.test(code)) {
      setBacktestError("请先选择股票名称或输入6位A股代码，再运行风险档位对比");
      return;
    }
    const requestId = ++backtestComparisonRequestId.current;
    const normalizedDraft = normalizeBacktestDraft(draft);
    const seed = {
      sourceCode: code,
      comparedAt: new Date().toISOString(),
      items: riskProfilePresets.map((item) => ({
        profile: item.id,
        loading: true,
        error: "",
        record: null
      }))
    };
    setBacktestProfileComparisons(seed);
    const baseSettings = normalizeSettings(settings);
    const nextItems: BacktestProfileComparisonReport["items"] = [];
    for (const preset of riskProfilePresets) {
      let nextItem: BacktestProfileComparisonReport["items"][number];
      try {
        const profileSettings = buildSettingsByRiskProfile(baseSettings, preset.id);
        const result = await runBacktestWithSettings(normalizedDraft, profileSettings);
        if (requestId !== backtestComparisonRequestId.current) return;
        const record = buildBacktestHistoryRecord(normalizedDraft, result, profileSettings);
        nextItem = {
          profile: preset.id,
          loading: false,
          error: "",
          record
        };
      } catch (error) {
        nextItem = {
          profile: preset.id,
          loading: false,
          error: error instanceof Error ? error.message : "风险档位回测失败",
          record: null
        };
      }
      if (requestId !== backtestComparisonRequestId.current) return;
      nextItems.push(nextItem);
      setBacktestProfileComparisons((current) => {
        if (!current || current.comparedAt !== seed.comparedAt) return current;
        return {
          ...current,
          items: current.items.map((item) => item.profile === preset.id ? nextItem : item)
        };
      });
    }
    if (requestId !== backtestComparisonRequestId.current) return;
    setBacktestProfileComparisons({
      sourceCode: seed.sourceCode,
      comparedAt: seed.comparedAt,
      items: nextItems
    });
  };

  const csvEscape = (value: unknown) => {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  };

  const exportBacktestPayload = (record: BacktestHistoryRecord, format: "csv" | "json") => {
    const baseName = `${record.securityCode || "backtest"}-${record.createdAt.slice(0, 10)}`;
    if (format === "json") {
      const payload = JSON.stringify(record, null, 2);
      const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${baseName}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    }

    const metrics = record.metrics || {};
    const lines: Array<(string | number)[]> = [
      ["回测时间", "证券代码", "证券名称", "开始日期", "策略", "是否通过", "完成交易", "累计净收益%", "累计盈亏", "总信号", "有效样本", "平均单笔净收益", "胜率", "资金最大回撤", "样本外样本", "样本外净边际", "滚动窗口通过率", "过拟合风险", "训练外退化%", "BenchmarkR1", "BenchmarkR3", "BenchmarkR5"],
      [
        record.createdAt,
        record.securityCode,
        record.securityName,
        record.draft.startDate,
        record.draft.strategyContext?.strategyName || record.strategyProfile.selectedStrategies.join(" / "),
        record.accepted ? "PASS" : "REJECT",
        metrics.tradeCount ?? record.rawResult?.profitSummary?.tradeCount ?? "",
        metrics.totalNetReturnPercent ?? record.rawResult?.profitSummary?.totalNetReturnPercent ?? "",
        metrics.totalProfitAmount ?? record.rawResult?.profitSummary?.totalProfitAmount ?? "",
        metrics.totalSignals ?? "",
        metrics.replayableSignals ?? "",
        metrics.projectedNetEdge ?? "",
        metrics.winRatePercent ?? metrics.winRate5 ?? "",
        metrics.accountMaxDrawdownPercent ?? metrics.worstMdd5 ?? "",
        metrics.oosSampleCount ?? "",
        metrics.oosProjectedNetEdge ?? "",
        metrics.walkForwardPassRate ?? "",
        metrics.overfitRisk ?? "",
        metrics.degradationPercent ?? "",
        record.benchmarkReturns?.r1 ?? "",
        record.benchmarkReturns?.r3 ?? "",
        record.benchmarkReturns?.r5 ?? ""
      ],
      [],
      ["策略参数"],
      ["开始日期", "买入价格规则", "同日最少命中策略数", "最小样本", "最小预期净收益%", "最小期望值", "佣金", "滑点", "风险档位", "策略列表", "取值标尺"],
      [
        record.draft.startDate,
        record.draft.customEntryPrice ? `自定义限价 ${record.draft.customEntryPrice}` : "次日开盘价",
        record.draft.strategyContext?.minimumVotes || 1,
        record.draft.minSamples,
        record.draft.minProjectedNetEdgePercent,
        record.draft.minExpectancyPoints,
        record.draft.commissionBps,
        record.draft.slippageBps,
        riskProfileLabel(record.strategyProfile.riskProfile),
        record.strategyProfile.selectedStrategies.join(" / "),
        record.draft.benchmarks
      ],
      ["仓位上限(%)", "单笔风险上限(%)", "止损ATR", "止盈ATR", "最长期限Bars", "最大持仓数", "日内最大风险(%)", "组合最大风险(%)", "行业仓位上限(%)", "最低成交率(%)"],
      [
        record.strategyProfile.maxPositionPercent,
        record.strategyProfile.maxRiskPerTradePercent,
        record.strategyProfile.stopLossATRMultiple,
        record.strategyProfile.takeProfitATRMultiple,
        record.strategyProfile.maxHoldingBars,
        record.strategyProfile.maxOpenPositions,
        record.strategyProfile.maxDailyRiskPercent,
        record.strategyProfile.maxPortfolioRiskPercent,
        record.strategyProfile.maxSectorExposurePercent,
        record.strategyProfile.minExecutionRatePercent
      ],
      ["追踪止损(%)", "减仓步幅(%)", "减仓下限(%)", "连续亏损熔断", "时间衰减(%)"],
      [
        record.strategyProfile.trailingStopPercent,
        record.strategyProfile.lossStepPercent,
        record.strategyProfile.lossFloorPercent,
        record.strategyProfile.maxConsecutiveLossesForStop,
        record.strategyProfile.timeDecayPerBarPercent
      ],
      [],
      ["完整回测快照JSON"]
    ];
    const trades = Array.isArray(record.rawResult?.trades) ? record.rawResult.trades : [];
    const strategyBreakdown = Array.isArray(record.rawResult?.strategyBreakdown)
      ? record.rawResult.strategyBreakdown
      : [];
    if (strategyBreakdown.length > 1) {
      lines.splice(
        lines.length - 2,
        0,
        ["各策略独立收益对比"],
        ["策略ID", "策略名称", "完成交易", "盈利", "亏损", "胜率%", "累计净收益%", "累计盈亏", "最大回撤%"],
        ...strategyBreakdown.map((item: any) => [
          item.strategyId ?? "",
          item.strategyName ?? "",
          item.tradeCount ?? "",
          item.profitableTrades ?? "",
          item.losingTrades ?? "",
          item.winRatePercent ?? "",
          item.totalNetReturnPercent ?? "",
          item.totalProfitAmount ?? "",
          item.maxDrawdownPercent ?? ""
        ]),
        []
      );
    }
    if (trades.length) {
      lines.splice(
        lines.length - 2,
        0,
        ["逐笔交易"],
        ["序号", "命中策略", "信号日", "买入日", "买入价", "买入价格来源", "卖出日", "卖出价", "单笔毛收益%", "单笔净收益%", "单笔盈亏", "累计收益%", "期末资金"],
        ...trades.map((trade: any) => [
          trade.sequence ?? "",
          Array.isArray(trade.strategyIds) ? trade.strategyIds.join(" / ") : "",
          trade.signalDate ?? "",
          trade.entryDate ?? "",
          trade.entryPrice ?? "",
          trade.entryPriceSource === "custom_limit_price" ? "自定义限价" : "次日开盘",
          trade.exitDate ?? "",
          trade.exitPrice ?? "",
          trade.grossReturnPercent ?? "",
          trade.netReturnPercent ?? "",
          trade.profitAmount ?? "",
          trade.cumulativeReturnPercent ?? "",
          trade.endingCapital ?? ""
        ]),
        []
      );
    }
    const rows = lines.map((row) => {
      if (!Array.isArray(row)) return "";
      return row.map(csvEscape).join(",");
    });
    rows.push(csvEscape(JSON.stringify(record.rawResult || {})));
    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const applyBacktestProfile = (record: BacktestHistoryRecord, profileOverride?: BacktestStrategyProfile) => {
    const profile = profileOverride || record.strategyProfile;
    const selectedStrategies = profile?.selectedStrategies?.length
      ? normalizeBacktestStrategyIds([...profile.selectedStrategies, "riskVeto"])
      : normalizeBacktestStrategyIds(settings.selectedStrategies);
    if (!selectedStrategies.includes("riskVeto")) {
      selectedStrategies.push("riskVeto");
    }
    if (!selectedStrategies.length) return;
    const next = normalizeSettings({
      ...settings,
      riskProfile: normalizeRiskProfile(profile.riskProfile),
      selectedStrategies,
      minProjectedNetEdgePercent: clampNumber(profile.minProjectedNetEdgePercent, -2, 10, settings.minProjectedNetEdgePercent),
      minExpectancyPoints: clampNumber(profile.minExpectancyPoints, -2, 8, settings.minExpectancyPoints),
      minTurnoverPercent: clampNumber(profile.minTurnoverPercent, 0, 20, settings.minTurnoverPercent ?? 0.4),
      minQuoteAmount: clampNumber(profile.minQuoteAmount, 0, 1_000_000_000, settings.minQuoteAmount ?? 1200000),
      maxQuoteAgeSeconds: clampNumber(profile.maxQuoteAgeSeconds, 30, 1800, settings.maxQuoteAgeSeconds ?? 480),
      commissionBps: clampNumber(profile.commissionBps, 0, 60, settings.commissionBps),
      slippageBps: clampNumber(profile.slippageBps, 0, 60, settings.slippageBps),
      maxPositionPercent: clampNumber(profile.maxPositionPercent, 5, 90, settings.maxPositionPercent),
      maxRiskPerTradePercent: clampNumber(profile.maxRiskPerTradePercent, 0.2, 5, settings.maxRiskPerTradePercent),
      stopLossATRMultiple: clampNumber(profile.stopLossATRMultiple, 0.8, 5, settings.stopLossATRMultiple),
      takeProfitATRMultiple: clampNumber(profile.takeProfitATRMultiple, 1, 10, settings.takeProfitATRMultiple),
      maxHoldingBars: Math.round(clampNumber(profile.maxHoldingBars, 3, 120, settings.maxHoldingBars)),
      maxOpenPositions: Math.round(clampNumber(profile.maxOpenPositions, 1, 10, settings.maxOpenPositions)),
      maxDailyRiskPercent: clampNumber(profile.maxDailyRiskPercent, 0.3, 12, settings.maxDailyRiskPercent ?? 3.2),
      maxPortfolioRiskPercent: clampNumber(profile.maxPortfolioRiskPercent, 10, 100, settings.maxPortfolioRiskPercent ?? 70),
      maxSectorExposurePercent: clampNumber(profile.maxSectorExposurePercent, 10, 100, settings.maxSectorExposurePercent ?? 45),
      minExecutionRatePercent: clampNumber(profile.minExecutionRatePercent, 40, 100, settings.minExecutionRatePercent ?? 90),
      trailingStopPercent: clampNumber(profile.trailingStopPercent, 0, 25, settings.trailingStopPercent ?? 3),
      lossStreakStepPercent: clampNumber(profile.lossStepPercent, 2, 60, settings.lossStreakStepPercent ?? 18),
      lossStreakFloorPercent: clampNumber(profile.lossFloorPercent, 10, 80, settings.lossStreakFloorPercent ?? 30),
      maxConsecutiveLossesForStop: Math.round(clampNumber(profile.maxConsecutiveLossesForStop, 2, 12, settings.maxConsecutiveLossesForStop ?? 4)),
      timeDecayPerBarPercent: clampNumber(profile.timeDecayPerBarPercent, 0, 1, settings.timeDecayPerBarPercent ?? 0.11)
    });
    settingsChangedDuringStartupRef.current = true;
    setSettings(next);
    void window.stockApi.saveSettings(next).then((saved) => {
      setSettings(normalizeSettings(saved));
      showToast("已将回测参数同步到执行设置（已保存）");
    }).catch(() => {
      showToast("已将回测参数同步到执行设置（未写入存储）");
    });
  };

  const applyBacktestProfileWithGovernance = (
    record: BacktestHistoryRecord,
    source: ExecutionDecisionSource,
    label: string
  ) => {
    const strategyProfile = record.strategyProfile;
    const securityCode = String(record.securityCode || "");
    const securityName = String(record.securityName || securityCode || "UNKNOWN");
    if (record.rawResult?.strategyEngine === "verified-signal-v2") {
      showToast("策略信号规则仅用于本次回放，不会写入设置页的执行因子");
      return;
    }
    if (record.metrics?.walkForwardAccepted !== true) {
      const reason = record.metrics?.walkForwardAvailable === false
        ? "缺少足够的滚动样本外验证"
        : "滚动样本外验证未通过";
      appendExecutionDecisionLog({
        source,
        result: "BLOCKED",
        level: "block",
        securityCode,
        securityName,
        summary: `${label}回测参数应用失败：${reason}`,
        score: 0,
        reasons: [reason]
      });
      showToast(`回测执行决策阻断：${reason}`);
      return;
    }
    const diff = buildBacktestProfileDiff(strategyProfile, toBacktestStrategyProfile(settings));
    const remoteReadiness = record.rawResult?.tradeExecutionReadiness || record.rawResult?.executionReadiness;
    const readiness = evaluateBacktestExecutionReadiness(record.metrics, diff, remoteReadiness);
    const waitDeRiskMessage = `${securityName} 回测执行评估为“等待条件确认”：${readiness.score} 分。`;

    if (readiness.level === "block") {
      appendExecutionDecisionLog({
        source,
        result: "BLOCKED",
        level: "block",
        securityCode,
        securityName,
        summary: `${label}回测参数应用失败：${readiness.recommendation}`,
        score: readiness.score,
        reasons: readiness.reasons
      });
      showToast(`回测执行决策阻断：${readiness.recommendation}`);
      return;
    }

    if (readiness.level === "wait") {
      const deRiskResult = buildBacktestDeRiskProfile(strategyProfile, readiness);
      requestInlineDecision(
        {
          id: `backtest-profile-${record.id}`,
          title: "确认应用保守回测档位",
          description: `${waitDeRiskMessage} ${readiness.recommendation}`,
          details: deRiskResult.adjustments,
          confirmLabel: "按保守档位应用",
          cancelLabel: "暂不应用"
        },
        () => {
          applyBacktestProfile(record, deRiskResult.profile);
          appendExecutionDecisionLog({
            source,
            result: "APPROVED",
            level: "wait",
            securityCode,
            securityName,
            summary: `${label}回测参数已应用（等待确认降仓档位）`,
            score: readiness.score,
            reasons: [
              `等待确认风险评估：${readiness.recommendation}`,
              ...deRiskResult.adjustments,
              ...readiness.reasons
            ]
          });
          showToast("已按“等待确认”降仓档位应用回测参数");
        },
        () => {
          appendExecutionDecisionLog({
            source,
            result: "REJECTED",
            level: "wait",
            securityCode,
            securityName,
            summary: `${label}回测参数应用已取消`,
            score: readiness.score,
            reasons: readiness.reasons
          });
          showToast("已取消应用回测参数");
        }
      );
      return;
    }

    applyBacktestProfile(record);
    appendExecutionDecisionLog({
      source,
      result: "APPROVED",
      level: readiness.level,
      securityCode,
      securityName,
      summary: `${label}回测参数已应用`,
      score: readiness.score,
      reasons: readiness.reasons
    });
  };

  const clearBacktestHistory = () => {
    setBacktestHistory([]);
    showToast("已清空回测历史");
  };

  const applyCurrentBacktestToPaper = () => {
    if (!backtestCurrentRecord) {
      showToast("请先运行回测后再应用");
      return;
    }
    applyBacktestProfileWithGovernance(backtestCurrentRecord, "BACKTEST_CURRENT", "当前");
  };

  const exportCurrentBacktest = (format: "csv" | "json") => {
    if (!backtestCurrentRecord) {
      showToast("请先运行回测后再导出");
      return;
    }
    exportBacktestPayload(backtestCurrentRecord, format);
  };

  const applyHistoryToSettings = (record: BacktestHistoryRecord) => {
    applyBacktestProfileWithGovernance(record, "BACKTEST_HISTORY", "历史");
  };

  const loadBacktestRecord = (record: BacktestHistoryRecord) => {
    backtestRequestId.current += 1;
    backtestComparisonRequestId.current += 1;
    const restoredDraft = normalizeBacktestDraft(record.draft);
    const restoredStrategyContext = normalizeBacktestStrategyContext(
      restoredDraft.strategyContext || record.rawResult?.strategyContext
    );
    setBacktestDraft(restoredDraft);
    setBacktestResult(record.rawResult || null);
    setBacktestCurrentRecord(record.rawResult ? record : null);
    setBacktestLoading(false);
    setBacktestProfileComparisons(null);
    setBacktestError("");
    const restoredSecurity = record.rawResult?.security && typeof record.rawResult.security === "object"
      ? record.rawResult.security as Security
      : {
        code: record.securityCode,
        name: record.securityName || record.securityCode,
        secid: ""
      };
    setBacktestEntryContext({
      security: restoredSecurity,
      sourceView: "backtest",
      sourceLabel: "历史回测记录",
      strategyIds: restoredStrategyContext?.strategyIds || normalizeBacktestStrategyIds(record.strategyProfile?.selectedStrategies),
      strategyLabel: restoredStrategyContext?.strategyName || "记录内保存的策略快照",
      capturedAt: record.createdAt
    });
    showToast(`已恢复 ${record.securityName || record.securityCode} 的回测记录`);
  };

  const originForView = (sourceView: View = view): AnalysisOrigin => {
    if (sourceView === "watchlist") {
      return {
        view: "watchlist",
        node: watchlistNode,
        label: observationReturnLabel(watchlistNode)
      };
    }
    if (sourceView === "favorites") return { view: "favorites", label: "返回自选板块" };
    if (sourceView === "sectors") return { view: "sectors", label: "返回板块强度" };
    if (sourceView === "news") return { view: "news", label: "返回资讯雷达" };
    if (sourceView === "announcements") return { view: "announcements", label: "返回A股公告" };
    if (sourceView === "signals") return { view: "signals", label: "返回策略信号" };
    if (sourceView === "compare") return { view: "compare", label: "返回多股同列" };
    if (sourceView === "review") return { view: "review", label: "返回专业复盘" };
    if (sourceView === "settings") return { view: "settings", label: "返回数据源设置" };
    if (sourceView === "backtest") return { view: "backtest", label: "返回回测结果" };
    return { view: "dashboard", label: "返回涨停池" };
  };

  const openAnalysis = (security: Security | string, origin?: AnalysisOrigin | null) => {
    setAnalysisOrigin(origin || analysisOrigin || originForView());
    setDashboardMode("analysis");
    setView("dashboard");
    loadSecurity(security);
  };

  const backtestSourceLabel = (sourceView: View) => {
    if (sourceView === "signals") return "策略信号";
    if (sourceView === "favorites") return "自选板块";
    if (sourceView === "holdings") return "持仓板块";
    if (sourceView === "watchlist") return "十日观察池";
    if (sourceView === "compare") return "多股同列";
    if (sourceView === "review") return "专业复盘";
    if (sourceView === "sectors") return "板块强度";
    if (sourceView === "news") return "资讯雷达";
    if (sourceView === "announcements") return "A股公告";
    if (sourceView === "dashboard" && dashboardMode === "analysis") return "个股复盘";
    if (sourceView === "backtest") return "回测中心";
    return "回测中心手工选择";
  };

  const openBacktest = (
    security?: Security | string | null,
    strategyRequest?: StrategyBacktestRequest | null
  ) => {
    const safeSettings = normalizeSettings(settings);
    setBacktestCenterMode("single");
    const strategyContext = normalizeBacktestStrategyContext(strategyRequest);
    const visiblePayloadSecurity =
      view === "dashboard" && dashboardMode === "analysis"
        ? payload?.security || null
        : null;
    const upstreamSecurity =
      security && typeof security === "object"
        ? security
        : visiblePayloadSecurity;
    const next = typeof security === "string"
      ? security
      : upstreamSecurity?.code || (view === "backtest" ? backtestDraft.securityCode : "");
    updateBacktestDraft((current) => normalizeBacktestDraft({
      ...current,
      securityCode: next || (view === "backtest" ? current.securityCode : ""),
      security:
        upstreamSecurity ||
        (typeof security === "string" && /^\d{6}$/.test(security)
          ? { code: security, name: security, secid: "" }
          : view === "backtest"
            ? current.security
            : undefined),
      strategyContext: strategyContext || (view === "backtest" ? current.strategyContext : undefined),
      startDate: current.startDate || defaultBacktestStartDate(),
      lookbackBars: current.lookbackBars,
      minProjectedNetEdgePercent: safeSettings.minProjectedNetEdgePercent,
      minExpectancyPoints: safeSettings.minExpectancyPoints,
      minTurnoverPercent: safeSettings.minTurnoverPercent,
      minQuoteAmount: safeSettings.minQuoteAmount,
      maxQuoteAgeSeconds: safeSettings.maxQuoteAgeSeconds,
      commissionBps: safeSettings.commissionBps,
      slippageBps: safeSettings.slippageBps,
      benchmarks: current.benchmarks
    }));
    setBacktestEntryContext((current) => ({
      security:
        upstreamSecurity ||
        (typeof security === "string" && /^\d{6}$/.test(security)
          ? { code: security, name: security, secid: "" }
          : view === "backtest"
            ? current?.security || null
            : null),
      sourceView: view,
      sourceLabel: strategyContext
        ? `策略信号 · ${strategyContext.strategyName}`
        : backtestSourceLabel(view),
      strategyIds: strategyContext?.strategyIds || normalizeBacktestStrategyIds(settings.selectedStrategies),
      strategyLabel: strategyContext?.strategyName || "当前执行设置",
      capturedAt: new Date().toISOString()
    }));
    setAnalysisOrigin({
      ...originForView(view),
      dashboardMode: view === "dashboard" ? dashboardMode : "pool"
    });
    setBacktestReturnMode(view === "dashboard" && dashboardMode === "analysis" ? "analysis" : "pool");
    setView("backtest");
  };

  const navigateTo = (next: View) => {
    if (next === "sectors" && view !== "sectors") setSectorBoardError("");
    setView(next);
    setAnalysisOrigin(null);
    if (next === "dashboard") setDashboardMode("pool");
  };

  const returnFromAnalysis = () => {
    if (analysisOrigin) {
      if (analysisOrigin.node) setWatchlistNode(analysisOrigin.node);
      setView(analysisOrigin.view);
      if (analysisOrigin.view === "dashboard") {
        setDashboardMode(analysisOrigin.dashboardMode || backtestReturnMode);
      }
    } else {
      setDashboardMode("pool");
      setView("dashboard");
    }
    setAnalysisOrigin(null);
  };

  const toggleNewsVoice = async () => {
    const next = {
      ...settings,
      newsVoiceEnabled: settings.newsVoiceEnabled === false
    };
    const safeNext = normalizeSettings(next);
    settingsChangedDuringStartupRef.current = true;
    setSettings(safeNext);
    if (!safeNext.newsVoiceEnabled) window.speechSynthesis?.cancel();
    try {
      setSettings(normalizeSettings(await window.stockApi.saveSettings(safeNext)));
      showToast(safeNext.newsVoiceEnabled ? "重大资讯自动播报已开启" : "重大资讯自动播报已关闭");
    } catch {
      showToast("语音播报设置保存失败");
    }
  };

  const executePaperTrade = () => {
    if (!payload) {
      showToast("请先在分析页选择标的");
      return;
    }
    const targetPayload = payload;
    const readiness = evaluatePaperExecutionReadiness(paperStateRef.current, targetPayload, settingsRef.current);
    if (readiness.level === "block") {
      appendExecutionDecisionLog({
        source: "PAPER_TRADE",
        result: "BLOCKED",
        level: "block",
        securityCode: String(targetPayload.security?.code || ""),
        securityName: String(targetPayload.security?.name || targetPayload.security?.code || "UNKNOWN"),
        summary: readiness.summary,
        score: readiness.score,
        reasons: readiness.reasons
      });
      showToast(`${readiness.summary}，${readiness.recommendation}`);
      return;
    }

    const completePaperTrade = () => {
      const currentReadiness = evaluatePaperExecutionReadiness(
        paperStateRef.current,
        targetPayload,
        settingsRef.current
      );
      if (currentReadiness.level === "block") {
        appendExecutionDecisionLog({
          source: "PAPER_TRADE",
          result: "BLOCKED",
          level: "block",
          securityCode: String(targetPayload.security?.code || ""),
          securityName: String(targetPayload.security?.name || targetPayload.security?.code || "UNKNOWN"),
          summary: currentReadiness.summary,
          score: currentReadiness.score,
          reasons: currentReadiness.reasons
        });
        showToast(`${currentReadiness.summary}，${currentReadiness.recommendation}`);
        return;
      }
      const action = openPaperPositionFromSignal(paperStateRef.current, targetPayload, settingsRef.current);
      if (action.changed) {
        paperStateRef.current = action.state;
        setPaperState(action.state);
      }
      appendExecutionDecisionLog({
        source: "PAPER_TRADE",
        result: action.changed ? "APPROVED" : "BLOCKED",
        level: action.changed ? currentReadiness.level : "block",
        securityCode: String(targetPayload.security?.code || ""),
        securityName: String(targetPayload.security?.name || targetPayload.security?.code || "UNKNOWN"),
        summary: action.message,
        score: currentReadiness.score,
        reasons: currentReadiness.reasons
      });
      showToast(action.message);
    };

    if (readiness.level === "wait") {
      requestInlineDecision(
        {
          id: `paper-trade-${targetPayload.security?.code || Date.now()}`,
          title: "确认模拟下单",
          description: `${readiness.summary}。${readiness.recommendation}`,
          details: readiness.reasons,
          confirmLabel: "继续模拟下单",
          cancelLabel: "取消下单"
        },
        completePaperTrade,
        () => {
          appendExecutionDecisionLog({
            source: "PAPER_TRADE",
            result: "REJECTED",
            level: "wait",
            securityCode: String(targetPayload.security?.code || ""),
            securityName: String(targetPayload.security?.name || targetPayload.security?.code || "UNKNOWN"),
            summary: "用户取消执行",
            score: readiness.score,
            reasons: readiness.reasons
          });
          showToast("已取消本次模拟下单");
        }
      );
      return;
    }
    completePaperTrade();
  };

  const closePaperTradeForCode = (code: string, reason: PaperClosedPosition["closeReason"] = "MANUAL") => {
    const position = paperSummary.normalized.openPositions.find((item) => item.code === code);
    if (!position) {
      showToast("当前标的无持仓可平");
      return;
    }
    const action = closePaperSimulationByCode(
      paperState,
      payload,
      settingsRef.current,
      reason,
      code,
      position.latestPrice
    );
    if (action.changed) {
      setPaperState(action.state);
    }
    showToast(action.message);
  };

  const closePaperTradeForCurrent = (reason: PaperClosedPosition["closeReason"] = "MANUAL") => {
    const code = String(payload?.security?.code || "");
    if (!code) {
      showToast("请先在分析页选择标的");
      return;
    }
    const action = closePaperSimulationByCode(paperState, payload, settingsRef.current, reason, code);
    if (action.changed) {
      setPaperState(action.state);
    }
    showToast(action.message);
  };

  const paperSummary = useMemo(() => {
    const normalized = normalizePaperState(paperState);
    const strategyGovernance = evaluatePaperStrategyGovernance(normalized, settings);
    const dailyTradeSignal = getPaperDailyTradeSignal(normalized, settings);
    const openValue = normalized.openPositions.reduce(
      (sum, position) => sum + position.latestPrice * position.shares,
      0
    );
    const openCost = normalized.openPositions.reduce(
      (sum, position) => sum + position.entryPrice * position.shares + position.entryFee,
      0
    );
    const openPnl = normalized.openPositions.reduce(
      (sum, position) => sum + (position.latestPrice * position.shares - position.entryPrice * position.shares),
      0
    );
    const closedPositions = [...normalized.closedPositions];
    const cumulativeRealizedPnl = closedPositions.reduce((sum, position) => sum + position.realizedPnl, 0);
    const closedCount = closedPositions.length;
    const closedWinCount = closedPositions.filter((position) => position.realizedPnl > 0).length;
    const grossProfit = closedPositions.reduce((sum, position) => sum + Math.max(0, position.realizedPnl), 0);
    const grossLoss = closedPositions.reduce((sum, position) => sum + Math.max(0, -position.realizedPnl), 0);
    const avgHoldingBars = closedCount > 0
      ? closedPositions.reduce((sum, position) => sum + position.holdingBars, 0) / closedCount
      : 0;
    const lossStreakState = getPaperLossStreakState(normalized, settings);
    const currentSectorName = payload ? getSectorOfPayload(payload) : "";
    const currentSectorExposurePercent = currentSectorName
      ? getPaperSectorExposurePercent(normalized, currentSectorName)
      : 0;
    const sortedCloses = [...closedPositions]
      .filter((position) => Number.isFinite(new Date(position.closeTime).getTime()))
      .sort((a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime());
    let equityPeak = normalized.initialCapital;
    let equityCursor = normalized.initialCapital;
    let maxDrawdownPercent = 0;
    for (const position of sortedCloses) {
      equityCursor += position.realizedPnl;
      if (equityCursor > equityPeak) {
        equityPeak = equityCursor;
      } else if (equityPeak > 0) {
        const dd = (equityPeak - equityCursor) / equityPeak * 100;
        if (dd > maxDrawdownPercent) maxDrawdownPercent = dd;
      }
    }
    const killSwitch = evaluatePaperKillSwitch(normalized, settings);
    const openPnlPercent = openCost > 0 ? openPnl / openCost * 100 : 0;
  const equity = normalized.cash + openValue;
  const dailyLossLimit = normalized.initialCapital * (settings.maxDailyRiskPercent || 0) / 100;
  const cumulativeNetPnl = equity - normalized.initialCapital;
    const cumulativeReturnPercent = normalized.initialCapital > 0
      ? cumulativeNetPnl / normalized.initialCapital * 100
      : 0;
    const realizedReturnPercent = normalized.initialCapital > 0
      ? cumulativeRealizedPnl / normalized.initialCapital * 100
      : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;
    return {
      normalized,
      strategyGovernance,
      openValue,
      openCost,
      openPnl,
      openPnlPercent,
      equity,
      closedCount,
      winCount: closedWinCount,
      cumulativeRealizedPnl,
      realizedReturnPercent,
      cumulativeNetPnl,
      cumulativeReturnPercent,
      profitFactor,
      maxDrawdownPercent,
      avgHoldingBars,
      grossProfit,
      grossLoss,
      portfolioRiskPercent: killSwitch.portfolioExposurePercent,
      maxPortfolioRiskPercent: killSwitch.maxPortfolioRiskPercent,
      portfolioKill: killSwitch.hardTriggered,
      portfolioKillWarning: killSwitch.warningTriggered,
      portfolioKillReasons: killSwitch.reasons,
      lossPressureRatio: killSwitch.lossPressureRatio,
      portfolioUnrealizedLoss: killSwitch.openUnrealizedLoss,
      currentSectorName,
      currentSectorExposurePercent,
      maxSectorExposurePercent: settings.maxSectorExposurePercent ?? 45,
      lossStreakState,
      lossStreakConsecutive: lossStreakState.consecutiveLosses,
      lossStreakMultiplier: lossStreakState.deRiskMultiplier,
      lossStreakBlocked: lossStreakState.blockedByStreak,
      lossStreakStepPercent: lossStreakState.stepPercent,
      lossStreakFloorPercent: lossStreakState.floorPercent,
      lossStreakLimit: lossStreakState.maxConsecutiveLossesForStop,
      dailyTradeSignal,
      dailyLossLimit,
      dailyStopped: dailyLossLimit > 0 && normalized.dailyRealizedPnl <= -dailyLossLimit,
      winRate: closedCount > 0 ? closedWinCount / closedCount * 100 : 0
    };
  }, [
    paperState,
    payload?.security?.code,
    payload?.security?.name,
    settings.maxDailyRiskPercent,
    settings.maxPortfolioRiskPercent,
    settings.maxSectorExposurePercent,
    settings.maxConsecutiveLossesForStop,
    settings.lossStreakFloorPercent,
    settings.lossStreakStepPercent,
    settings.maxDailyTrades,
    settings.minPaperWinRatePercent,
    settings.minPaperRiskRewardRatio,
    settings.minExecutionRatePercent,
    settings.riskProfile,
    settings.selectedStrategies,
    settings.maxRiskPerTradePercent,
    settings.stopLossATRMultiple,
    settings.takeProfitATRMultiple,
    settings.maxHoldingBars
  ]);

  const paperCurrentPositions = payload
    ? paperSummary.normalized.openPositions.filter((position) => position.code === payload.security?.code)
    : [];
  const paperExecutionReadiness = evaluatePaperExecutionReadiness(
    paperSummary.normalized,
    payload,
    settings
  );
  const latestExecutionDecision = executionDecisionLog[0] || null;
  const canPaperTrade = paperExecutionReadiness.level !== "block";

  useEffect(() => {
    const synthesis = window.speechSynthesis;
    if (!live || settings.newsVoiceEnabled === false || !synthesis) {
      synthesis?.cancel();
      return;
    }
    let active = true;
    let busy = false;
    const pollMajorNews = async () => {
      if (busy) return;
      busy = true;
      try {
        const feed = await window.stockApi.getNewsFeed({
          scope: "all",
          direction: "all",
          limit: 120
        });
        if (!active) return;
        const items = Array.isArray(feed?.items) ? feed.items : [];
        if (!voiceFeedSeeded.current) {
          items.forEach((item: any) => voiceSeenIds.current.add(String(item.id)));
          voiceFeedSeeded.current = true;
          return;
        }
        const freshMajor = items.filter((item: any) => {
          const id = String(item.id || "");
          return id &&
            !voiceSeenIds.current.has(id) &&
            Number(item.ageMinutes || 0) <= 15 &&
            item.autoBroadcast === true;
        });
        items.forEach((item: any) => voiceSeenIds.current.add(String(item.id)));
        if (!freshMajor.length) return;
        const text = freshMajor.slice(0, 3).reverse().map((item: any, index: number) => {
          const direction =
            item.direction === "negative" ? "风险事项" :
              item.direction === "positive" ? "正向事项" : "重要事项";
          const sectors = (item.relatedSectors || []).slice(0, 3).join("、");
          return `${index ? "下一条，" : ""}${direction}，${item.title}${sectors ? `，涉及${sectors}` : ""}`;
        }).join("。");
        const utterance = new SpeechSynthesisUtterance(`重大资讯播报。${text}`);
        utterance.lang = "zh-CN";
        utterance.rate = 0.95;
        synthesis.speak(utterance);
      } catch {
        // A failed news source should not interrupt the rest of the monitor.
      } finally {
        busy = false;
      }
    };
    pollMajorNews();
    const timer = window.setInterval(
      pollMajorNews,
      Math.max(5, Number(settings.newsRefreshSeconds) || 6) * 1000
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, settings.newsRefreshSeconds, settings.newsVoiceEnabled]);

  const applyStrategyPreset = async (preset: typeof strategyPresets[number]) => {
    const next = normalizeSettings({ ...settings, selectedStrategies: preset.strategies });
    setStrategyMenuOpen(false);
    settingsChangedDuringStartupRef.current = true;
    setSettings(next);
    try {
      const saved = await window.stockApi.saveSettings(next);
      setSettings(normalizeSettings(saved));
      if (payload?.security) await loadSecurity(payload.security, true);
      showToast(`已切换：${preset.name}`);
    } catch {
      showToast("策略组合保存失败");
    }
  };

  useEffect(() => {
    let active = true;
    const startupPoolRequestId = ++limitPoolRequestId.current;
    Promise.allSettled([
      window.stockApi.getWatchlist(),
      window.stockApi.getHoldings(),
      window.stockApi.getSettings(),
      window.stockApi.getVersion(),
      window.stockApi.getLimitUpPoolSnapshot(),
      window.stockApi.discoverRecentLimitUps(11)
    ]).then((results) => {
      if (!active) return;
      const [watchlistResult, holdingsResult, settingsResult, versionResult, poolResult, recentResult] = results;
      const savedWatchlist = watchlistResult.status === "fulfilled" && Array.isArray(watchlistResult.value)
        ? watchlistResult.value
        : [];
      const savedHoldings = holdingsResult.status === "fulfilled" && Array.isArray(holdingsResult.value)
        ? holdingsResult.value
        : [];
      const savedSettings = settingsResult.status === "fulfilled"
        ? settingsResult.value
        : initialSettings;
      const appVersion = versionResult.status === "fulfilled" && typeof versionResult.value === "string"
        ? versionResult.value
        : version;
      const poolSnapshot = poolResult.status === "fulfilled" && poolResult.value && typeof poolResult.value === "object"
        ? poolResult.value
        : { rows: [], meta: {} };
      const discovered = Array.isArray((poolSnapshot as any).rows)
        ? (poolSnapshot as any).rows
        : [];
      const recentLimitUps = recentResult.status === "fulfilled" && Array.isArray(recentResult.value)
        ? recentResult.value
        : [];
      const completeWatchlist = mergeObservationPool(
        savedWatchlist,
        recentLimitUps,
        observationExclusionsRef.current
      );
      setWatchlist(completeWatchlist);
      if (watchlistResult.status === "fulfilled") {
        void window.stockApi.saveWatchlist(completeWatchlist).catch(() => {
          showToast("观察池自动整理未保存，原数据保持不变");
        });
      }
      setHoldings(savedHoldings);
      if (!settingsChangedDuringStartupRef.current) {
        setSettings(normalizeSettings(savedSettings));
      }
      setVersion(appVersion);
      const localFailures = [watchlistResult, holdingsResult, settingsResult, versionResult]
        .filter((result) => result.status === "rejected").length;
      if (localFailures) showToast(`启动时有 ${localFailures} 项本地数据暂未加载，其余功能可继续使用`);
      const activePool = discovered.length
        ? discovered
        : recentLimitUps.filter((item: WatchItem) => item.tradingDaysSince === 0);
      const appliedPool = commitLimitUpPool({
        rows: activePool,
        meta: {
          ...((poolSnapshot as any).meta || {}),
          dataDate: activePool[0]?.limitDate || (poolSnapshot as any).meta?.dataDate || ""
        }
      }, startupPoolRequestId, "startup");
      if (appliedPool && activePool[0]) {
        loadSecurity(activePool[0]);
      } else if (appliedPool && recentLimitUps[0]) {
        loadSecurity(recentLimitUps[0]);
      } else if (appliedPool) {
        setError(
          poolResult.status === "rejected" && recentResult.status === "rejected"
            ? "涨停行情暂时不可用，请稍后点击刷新"
            : "最近交易日没有符合条件的涨停股票"
        );
      }
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
    };
  }, [commitLimitUpPool, loadSecurity]);

  useEffect(() => {
    const requestId = ++searchRequestId.current;
    window.clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    const searchText = query.trim();
    searchTimer.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const next = await window.stockApi.search(searchText);
        if (requestId === searchRequestId.current) setSuggestions(next);
      } catch {
        if (requestId === searchRequestId.current) setSuggestions([]);
      } finally {
        if (requestId === searchRequestId.current) setSearching(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(searchTimer.current);
      if (requestId === searchRequestId.current) searchRequestId.current += 1;
    };
  }, [query]);

  useEffect(() => {
    if (!live || !payload || view !== "dashboard" || dashboardMode !== "analysis") return;
    let active = true;
    let busy = false;
    const security = payload.security;
    const refreshQuote = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const snapshot = await window.stockApi.getQuoteSnapshot(security);
        if (!active) return;
        setPayload((current) => {
          if (!current || current.security.code !== security.code) return current;
          return {
            ...current,
            quote: {
              ...current.quote,
              ...snapshot.quote,
              name: snapshot.quote?.name || current.quote.name,
              industry: snapshot.quote?.industry || current.quote.industry
            },
            actualProvider: snapshot.actualProvider || current.actualProvider,
            updatedAt: snapshot.updatedAt || new Date().toISOString()
          };
        });
      } catch {
        // The last valid quote stays visible; the slower full refresh can recover.
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(
      refreshQuote,
      Math.max(3, Number(settings.quoteRefreshSeconds) || 5) * 1000
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, payload?.security.code, settings.quoteRefreshSeconds, view, dashboardMode]);

  useEffect(() => {
    if (
      !payload ||
      !live ||
      settings.multiSourceEnabled === false ||
      view !== "dashboard" ||
      dashboardMode !== "analysis"
    ) return;
    let active = true;
    let busy = false;
    const security = payload.security;
    const refreshFederation = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const federation = await window.stockApi.getDataFederation(security);
        if (!active) return;
        setPayload((current) =>
          current?.security.code === security.code
            ? { ...current, dataFederation: federation }
            : current
        );
      } catch {
        // Primary quote remains available even if an auxiliary verifier fails.
      } finally {
        busy = false;
      }
    };
    refreshFederation();
    const timer = window.setInterval(refreshFederation, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, payload?.security.code, settings.multiSourceEnabled, view, dashboardMode]);

  useEffect(() => {
    if (!live || !payload || view !== "dashboard" || dashboardMode !== "analysis") return;
    const timer = window.setInterval(
      () => loadSecurity(payload.security, true),
      Math.max(60, settings.refreshSeconds) * 1000
    );
    return () => window.clearInterval(timer);
  }, [live, payload?.security.code, settings.refreshSeconds, loadSecurity, view, dashboardMode]);

  useEffect(() => {
    if (!live) return;
    let active = true;
    let busy = false;
    const refreshPool = async () => {
      if (busy || limitPoolManualRefresh.current || document.hidden) return;
      busy = true;
      const requestId = ++limitPoolRequestId.current;
      try {
        const snapshot = await window.stockApi.getLimitUpPoolSnapshot();
        if (active) commitLimitUpPool(snapshot, requestId, "auto");
      } catch {
        // Keep the most recent complete pool during a transient source failure.
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(refreshPool, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [commitLimitUpPool, live]);

  useEffect(() => {
    if (!live) return;
    let active = true;
    let busy = false;
    const refreshObservationPool = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const recent = await window.stockApi.discoverRecentLimitUps(11);
        if (!active) return;
        setWatchlist((current) => {
          const next = mergeObservationPool(
            current,
            recent,
            observationExclusionsRef.current
          );
          window.stockApi.saveWatchlist(next).catch(() => {});
          return next;
        });
      } catch {
        // Keep the last complete ten-day pool until the data source recovers.
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(refreshObservationPool, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live]);

  const loadSectorBoard = useCallback(async (forceRefresh = false) => {
    if (sectorBoardBusy.current) return false;
    sectorBoardBusy.current = true;
    const requestId = ++sectorBoardRequestId.current;
    setSectorBoardLoading(true);
    try {
      const rows = await window.stockApi.getLimitUpSectorBoard({ forceRefresh });
      if (!Array.isArray(rows)) throw new Error("板块排行响应结构异常，已保留上次有效数据");
      if (requestId !== sectorBoardRequestId.current) return false;
      setSectorBoard(rows);
      setSectorBoardError("");
      setSectorBoardLoaded(true);
      if (forceRefresh) showToast("涨停板块排行已重新计算");
      return true;
    } catch (e) {
      if (requestId !== sectorBoardRequestId.current) return false;
      const message = e instanceof Error ? e.message : "涨停板块对比加载失败";
      setSectorBoardError(message);
      showToast(message);
      return false;
    } finally {
      if (requestId === sectorBoardRequestId.current) setSectorBoardLoading(false);
      sectorBoardBusy.current = false;
    }
  }, []);

  useEffect(() => {
    if (view === "sectors" && !sectorBoardLoaded && !sectorBoardLoading && !sectorBoardError) {
      loadSectorBoard(false);
    }
  }, [view, sectorBoardLoaded, sectorBoardLoading, sectorBoardError, loadSectorBoard]);

  const observationItems = useMemo(
    () => watchlist.filter((item) =>
      item.autoAdded &&
      Number(item.tradingDaysSince) >= 1 &&
      Number(item.tradingDaysSince) <= 10
    ),
    [watchlist]
  );
  const favoriteItems = useMemo(
    () => watchlist.filter((item) => item.favorite || !item.autoAdded),
    [watchlist]
  );
  const compareCandidates = useMemo(() => {
    const merged = new Map<string, Security>();
    const add = (item: any) => {
      const code = String(item?.code || "");
      if (!/^\d{6}$/.test(code) || merged.has(code)) return;
      merged.set(code, {
        ...item,
        code,
        name: String(item?.name || code),
        secid: String(item?.secid || "")
      });
    };
    if (payload?.security) add(payload.security);
    limitUps.forEach(add);
    holdings.forEach(add);
    favoriteItems.forEach(add);
    observationItems.forEach(add);
    return [...merged.values()];
  }, [payload?.security, limitUps, holdings, favoriteItems, observationItems]);
  const isFavorite = useMemo(
    () => !!payload && favoriteItems.some((item) => item.code === payload.security.code),
    [payload, favoriteItems]
  );
  const activeStrategyPreset =
    strategyPresets.find((preset) =>
      sameStrategySet(settings.selectedStrategies || [], preset.strategies)
    ) || null;

  const toggleFavorite = async (security = payload?.security) => {
    if (!security) return;
    const previousWatchlist = watchlist;
    const existing = watchlist.find((item) => item.code === security.code);
    const currentlyFavorite = Boolean(existing && (existing.favorite || !existing.autoAdded));
    const next: WatchItem[] = currentlyFavorite
      ? existing?.autoAdded
        ? watchlist.map((item) =>
            item.code === security.code
              ? (() => {
                  const updated = { ...item, favorite: false };
                  delete updated.favoriteAddedAt;
                  return updated;
                })()
              : item
          )
        : watchlist.filter((item) => item.code !== security.code)
      : existing
        ? watchlist.map((item) =>
            item.code === security.code
              ? { ...item, favorite: true, favoriteAddedAt: new Date().toISOString() }
              : item
          )
        : [
            ...watchlist,
            {
              ...security,
              createdAt: new Date().toISOString(),
              favoriteAddedAt: new Date().toISOString(),
              favorite: true,
              autoAdded: false,
              note: ""
            }
          ];
    setWatchlist(next);
    try {
      await window.stockApi.saveWatchlist(next);
      showToast(currentlyFavorite ? "已移出自选板块" : "已加入自选板块");
    } catch {
      setWatchlist(previousWatchlist);
      showToast("自选板块保存失败，已恢复原状态");
    }
  };

  const removeObservation = async (security: WatchItem) => {
    const previousWatchlist = watchlist;
    const previousExclusions = observationExclusionsRef.current;
    const nextExclusions = upsertObservationExclusion(previousExclusions, security);
    const next = removeObservationFromWatchlist(watchlist, security.code);
    observationExclusionsRef.current = nextExclusions;
    saveSafeLocalJson(OBSERVATION_EXCLUSIONS_KEY, nextExclusions);
    setWatchlist(next);
    try {
      await window.stockApi.saveWatchlist(next);
      showToast(security.favorite
        ? "已从观察列表移除，自选收藏继续保留"
        : "已从当前观察列表移除");
    } catch {
      observationExclusionsRef.current = previousExclusions;
      saveSafeLocalJson(OBSERVATION_EXCLUSIONS_KEY, previousExclusions);
      setWatchlist(previousWatchlist);
      showToast("观察列表保存失败，已恢复原状态");
    }
  };

  const saveHoldings = async (next: HoldingItem[]) => {
    try {
      const saved = await window.stockApi.saveHoldings(next);
      setHoldings(saved);
      return true;
    } catch {
      showToast("持仓保存失败，未覆盖原有数据");
      return false;
    }
  };

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    if (suggestions[0]) openAnalysis(suggestions[0]);
    else if (/^\d{6}$/.test(query.trim())) openAnalysis(query.trim());
  };

  const discover = async () => {
    if (limitPoolManualRefresh.current) return;
    limitPoolManualRefresh.current = true;
    setDiscovering(true);
    const requestId = ++limitPoolRequestId.current;
    try {
      const snapshot = await window.stockApi.getLimitUpPoolSnapshot({ forceRefresh: true });
      const result = commitLimitUpPool(snapshot, requestId, "manual");
      if (!result) return;
      setError("");
      const source = limitPoolProviderLabel(result.meta.providers);
      const dateLabel = result.meta.dataDate || "最近交易日";
      const datePrefix = result.meta.dataDate && result.meta.dataDate !== shanghaiDateTag()
        ? `当前显示最近交易日 ${dateLabel}`
        : `${dateLabel}`;
      showToast(
        result.changed
          ? `${datePrefix} · 涨停池已更新：${result.rows.length}只 · ${source}`
          : `${datePrefix} · 涨停池已核对，暂无变化：${result.rows.length}只 · ${source}`
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : "涨停池更新失败");
    } finally {
      limitPoolManualRefresh.current = false;
      setDiscovering(false);
    }
  };

  const navItems = [
    { id: "dashboard" as View, label: "涨停监控", icon: LayoutDashboard },
    { id: "favorites" as View, label: "自选板块", icon: Star },
    { id: "holdings" as View, label: "持仓股", icon: WalletCards },
    { id: "watchlist" as View, label: "观察池", icon: Bookmark },
    { id: "sectors" as View, label: "板块强度", icon: Layers3 },
    { id: "news" as View, label: "资讯雷达", icon: Newspaper },
    { id: "announcements" as View, label: "A股公告", icon: FileText },
    { id: "signals" as View, label: "策略信号", icon: Sparkles },
    { id: "compare" as View, label: "多股同列", icon: BarChart3 },
    { id: "review" as View, label: "专业复盘", icon: BookOpenCheck },
    { id: "backtest" as View, label: "回测中心", icon: LineChart }
  ];
  const providerLabel = (provider: unknown) => {
    if (provider === "ths") return "同花顺";
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
      : "行情监控运行中";
  const marketStatusDetail = payload?.updatedAt
    ? `当前 ${actualProviderLabel} · ${new Date(payload.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
    : `主线 ${requestedProviderLabel} · 涨停池 ${limitUps.length} 只`;

  return (
    <div className="app-shell">
      <WindowTitleBar />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Radar size={23} /></div>
          <div>
          <strong>A股雷达</strong>
          <span>LIMIT-UP RADAR</span>
          </div>
        </div>

        <nav>
          <p className="nav-caption">工作台</p>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => item.id === "backtest" ? openBacktest() : navigateTo(item.id)}
              aria-current={view === item.id ? "page" : undefined}
              data-professional-review-nav={item.id === "review" ? true : undefined}
              data-announcements-nav={item.id === "announcements" ? true : undefined}
              data-backtest-nav={item.id === "backtest" ? true : undefined}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === "favorites" && <em>{favoriteItems.length}</em>}
              {item.id === "holdings" && <em>{holdings.length}</em>}
              {item.id === "watchlist" && <em>{observationItems.length}</em>}
              {item.id === "review" && <em>PRO</em>}
            </button>
          ))}
          <p className="nav-caption nav-caption-spaced">系统</p>
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => navigateTo("settings")}
            aria-current={view === "settings" ? "page" : undefined}
          >
            <SettingsIcon size={18} />
            <span>数据源设置</span>
          </button>
        </nav>

        <div className="sidebar-status">
          <div className="status-row">
            <span className={`live-dot ${!live ? "paused" : marketDegraded ? "degraded" : ""}`} />
            <div><strong>{marketStatus}</strong><small>{marketStatusDetail}</small></div>
          </div>
          <div className="quota-text"><span>请求主源 {requestedProviderLabel}</span><b>实际 {actualProviderLabel}</b></div>
        </div>
        <div className="version">v{version} · 仅供研究，不构成投资建议</div>
      </aside>

      <main className="main">
        <header className="topbar">
          <form className="search-box" onSubmit={handleSearch}>
            <Search size={18} />
            <input
              id="global-security-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setSuggestions([]);
                } else if (event.key === "ArrowDown" && suggestions.length > 0) {
                  event.preventDefault();
                  document.querySelector<HTMLButtonElement>("#global-security-suggestions button")?.focus();
                }
              }}
              placeholder="搜索 A股、ETF、可转债（代码 / 名称 / 拼音）"
              role="combobox"
              aria-label="证券搜索：A股、ETF、可转债"
              aria-expanded={suggestions.length > 0}
              aria-controls="global-security-suggestions"
            />
            {searching && <LoaderCircle size={16} className="spin" />}
            {query && !searching && (
              <button type="button" onClick={() => setQuery("")} aria-label="清空证券搜索"><X size={15} /></button>
            )}
            {suggestions.length > 0 && (
              <div className="suggestions" id="global-security-suggestions" role="listbox">
                {suggestions.map((item) => (
                  <button
                    key={item.secid}
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => openAnalysis(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setQuery("");
                        document.querySelector<HTMLInputElement>("#global-security-search")?.focus();
                        return;
                      }
                      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                      event.preventDefault();
                      const options = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button") || [])];
                      const currentIndex = options.indexOf(event.currentTarget);
                      const nextIndex = event.key === "ArrowDown"
                        ? (currentIndex + 1) % options.length
                        : (currentIndex - 1 + options.length) % options.length;
                      options[nextIndex]?.focus();
                    }}
                  >
                    <span><b>{item.name}</b><small>{item.code}</small></span>
                    <em>{item.marketName}</em>
                  </button>
                ))}
              </div>
            )}
          </form>
          <div className="top-actions">
            <div className={`strategy-quick ${strategyMenuOpen ? "open" : ""}`}>
              <button
                type="button"
                className="strategy-quick-trigger"
                onClick={() => setStrategyMenuOpen((open) => !open)}
                aria-expanded={strategyMenuOpen}
              >
                <SlidersHorizontal size={16} />
                <span>策略：{activeStrategyPreset?.name || "自定义"}</span>
                <ChevronDown size={14} />
              </button>
              {strategyMenuOpen && (
                <div className="strategy-quick-menu">
                  <strong>快捷策略组合</strong>
                  {strategyPresets.map((preset) => (
                    <button
                      type="button"
                      key={preset.id}
                      className={activeStrategyPreset?.id === preset.id ? "active" : ""}
                      onClick={() => applyStrategyPreset(preset)}
                    >
                      <span><b>{preset.name}</b><small>{preset.detail}</small></span>
                      <em>{preset.strategies.length} 项</em>
                    </button>
                  ))}
                  <button type="button" className="strategy-custom-link" onClick={() => { setStrategyMenuOpen(false); navigateTo("settings"); }}>
                    自定义勾选全部策略
                    <ChevronRight size={15} />
                  </button>
                </div>
              )}
            </div>
            <div className="theme-switch" aria-label="界面主题">
              {themeOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={(settings.theme || "system") === item.id ? "active" : ""}
                  onClick={() => setThemeMode(item.id)}
                  title={item.label}
                >
                  <item.icon size={15} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            <button className={`live-toggle ${live ? "on" : ""}`} onClick={() => setLive(!live)} aria-pressed={live}>
              <span />
              {live ? "实时刷新" : "已暂停"}
            </button>
            <button className="icon-button" onClick={() => payload && loadSecurity(payload.security, false, true)} title="刷新当前股票" aria-label="刷新当前股票">
              <RefreshCw size={18} className={loading ? "spin" : ""} />
            </button>
            <button
              className={`icon-button ${settings.newsVoiceEnabled === false ? "" : "voice-on"}`}
              onClick={toggleNewsVoice}
              title={settings.newsVoiceEnabled === false ? "开启重大资讯自动播报" : "关闭重大资讯自动播报"}
            >
              {settings.newsVoiceEnabled === false ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <button className="icon-button" onClick={() => navigateTo("news")} title="打开资讯雷达"><Bell size={18} /><i /></button>
          </div>
        </header>

        <div className={`page ${view === "review" ? "review-page-host" : ""}`}>
          {pendingDecision && (
            <InlineDecisionBar
              prompt={pendingDecision.prompt}
              onConfirm={pendingDecision.onConfirm}
              onCancel={pendingDecision.onCancel}
            />
          )}
          {view === "dashboard" && (
            <Dashboard
              payload={payload}
              loading={loading}
              error={error}
              isWatched={isFavorite}
              onToggleWatch={() => toggleFavorite()}
              onDiscover={discover}
              discovering={discovering}
              limitUps={limitUps}
              limitPoolMeta={limitPoolMeta}
              onOpen={(security: Security) => openAnalysis(security, { view: "dashboard", label: "返回涨停池" })}
              onAdd={toggleFavorite}
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
                onRetry={() => analysisTarget && loadSecurity(analysisTarget, false, true)}
              />
            )}
          {view === "favorites" && (
            <FavoritesView
              items={favoriteItems}
              onOpen={(item: WatchItem) => openAnalysis(item, { view: "favorites", label: "返回自选板块" })}
              onRemove={toggleFavorite}
            />
          )}
          {view === "holdings" && (
            <HoldingsView
              items={holdings}
              settings={settings}
              live={live}
              onSave={saveHoldings}
              onOpen={(item: HoldingItem) =>
                openAnalysis(item, { view: "holdings", label: "返回持仓股" })
              }
            />
          )}
          {view === "watchlist" && (
            <WatchlistView
              items={observationItems}
              limitUps={limitUps}
              activeNode={watchlistNode}
              onNodeChange={setWatchlistNode}
              onOpen={(item: WatchItem) => openAnalysis(item, {
                view: "watchlist",
                node: watchlistNode,
                label: observationReturnLabel(watchlistNode)
              })}
              onRemove={removeObservation}
            />
          )}
          {view === "sectors" && (
            <SectorView
              rows={sectorBoard}
              loading={sectorBoardLoading}
              loadError={sectorBoardError}
              onRefresh={() => loadSectorBoard(true)}
              onOpenStock={(stock: Security) => openAnalysis(stock, { view: "sectors", label: "返回板块强度" })}
            />
          )}
          {view === "news" && (
            <NewsView
              payload={payload}
              watchlist={observationItems}
              holdings={holdings}
              limitUps={limitUps}
              settings={settings}
              onOpenStock={(stock: Security) => openAnalysis(stock, { view: "news", label: "返回资讯雷达" })}
            />
          )}
          {view === "announcements" && (
            <NewsView
              payload={payload}
              watchlist={observationItems}
              holdings={holdings}
              limitUps={limitUps}
              settings={settings}
              announcementOnly
              onOpenStock={(stock: Security) => openAnalysis(stock, { view: "announcements", label: "返回A股公告" })}
            />
          )}
          {view === "signals" && (
            <Suspense fallback={<LoadingState />}>
              <StrategySignalsView
                onOpen={(stock: Security) =>
                  openAnalysis(stock, { view: "signals", label: "返回策略信号" })
                }
                onOpenBacktest={(request: StrategyBacktestRequest) =>
                  openBacktest(request.security || null, request)
                }
              />
            </Suspense>
          )}
          {view === "compare" && (
            <Suspense fallback={<LoadingState />}>
              <MultiStockCompareView
                candidates={compareCandidates}
                live={live}
                onOpen={(stock: Security) =>
                  openAnalysis(stock, { view: "compare", label: "返回多股同列" })
                }
              />
            </Suspense>
          )}
          {(view === "review" || reviewMounted) && (
            <div hidden={view !== "review"}>
              <Suspense fallback={<LoadingState />}>
                <ProfessionalReview />
              </Suspense>
            </div>
          )}
          {view === "backtest" && (
            <>
              <div hidden={backtestCenterMode !== "portfolio"}>
                <Suspense fallback={<LoadingState />}>
                  <PortfolioBacktestView
                    initialStrategyContext={backtestDraft.strategyContext || null}
                    initialSecurities={
                      backtestDraft.strategyContext?.securities?.length
                        ? backtestDraft.strategyContext.securities
                        : backtestEntryContext?.security
                          ? [backtestEntryContext.security]
                          : []
                    }
                    onBack={returnFromAnalysis}
                    backLabel={analysisOrigin?.label || "返回涨停监控"}
                    onOpenSingle={() => setBacktestCenterMode("single")}
                    onOpenSecurity={(security) =>
                      openAnalysis(security, { view: "backtest", label: "返回组合回测" })
                    }
                  />
                </Suspense>
              </div>
              <div hidden={backtestCenterMode !== "single"}>
                <BacktestView
                  draft={backtestDraft}
                  loading={backtestLoading}
                  error={backtestError}
                  result={backtestResult}
                  history={backtestHistory}
                  profileComparisons={backtestProfileComparisons}
                  onDraftChange={updateBacktestDraft}
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
                  onTargetChange={(security, sourceLabel) => {
                    setBacktestEntryContext({
                      security,
                      sourceView: "backtest",
                      sourceLabel: backtestDraft.strategyContext
                        ? `策略信号 · ${backtestDraft.strategyContext.strategyName}`
                        : sourceLabel,
                      strategyIds: backtestDraft.strategyContext?.strategyIds || normalizeBacktestStrategyIds(settings.selectedStrategies),
                      strategyLabel: backtestDraft.strategyContext?.strategyName || "当前执行设置",
                      capturedAt: new Date().toISOString()
                    });
                  }}
                  currentSettings={settings}
                  executionProfile={toBacktestStrategyProfile(settings)}
                  profileDiff={(source) => buildBacktestProfileDiff(source, toBacktestStrategyProfile(settings))}
                  evaluateBacktestExecutionReadiness={evaluateBacktestExecutionReadiness}
                  buildBacktestExecutionPlan={buildBacktestExecutionPlan}
                  onOpenPortfolio={() => setBacktestCenterMode("portfolio")}
                />
              </div>
            </>
          )}
          {view === "settings" && (
            <SettingsView
              value={settings}
              onSave={async (next) => {
                const safe = normalizeSettings(next);
                settingsChangedDuringStartupRef.current = true;
                const saved = await window.stockApi.saveSettings(safe);
                setSettings(normalizeSettings(saved));
                if (payload?.security) await loadSecurity(payload.security, true);
                showToast("设置已保存");
              }}
            />
          )}
        </div>
      </main>
      {toast && <div className="toast" role="status" aria-live="polite"><ShieldCheck size={17} />{toast}</div>}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, actions }: any) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

function limitUpMarketAnalysis(item: any) {
  const firstSealMinutes = (() => {
    const [hours = Number.NaN, minutes = Number.NaN] = String(item.firstSealTime || "").split(":").map(Number);
    return Number.isFinite(hours) && Number.isFinite(minutes)
      ? hours * 60 + minutes
      : null;
  })();
  const numericField = (value: unknown) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const sealRatio = numericField(item.sealFloatRatio);
  const turnover = numericField(item.turnover);
  const amount = numericField(item.amount);
  const openBoardCount = numericField(item.openBoardCount);
  const consecutiveBoards = numericField(item.consecutiveBoards);
  const coreFieldCount = [firstSealMinutes, sealRatio, openBoardCount].filter((value) => value !== null).length;
  let score = 45;
  if (firstSealMinutes !== null && firstSealMinutes <= 10 * 60 + 30) score += 14;
  else if (firstSealMinutes !== null && firstSealMinutes <= 13 * 60 + 30) score += 7;
  if (openBoardCount !== null) {
    if (openBoardCount === 0) score += 15;
    else score -= Math.min(20, openBoardCount * 5);
  }
  if (sealRatio !== null) {
    if (sealRatio >= 0.008) score += 12;
    else if (sealRatio >= 0.003) score += 7;
  }
  if (amount !== null && amount >= 3e8) score += 6;
  if (turnover !== null && turnover >= 2 && turnover <= 18) score += 7;
  if (turnover !== null && turnover > 28) score -= 12;
  if (consecutiveBoards !== null && consecutiveBoards >= 2) score += Math.min(8, consecutiveBoards * 2);
  const qualityScore = coreFieldCount >= 2 ? Math.round(clampNumber(score, 0, 100, 50)) : null;
  const state =
    qualityScore === null ? "封板数据待补" :
      qualityScore >= 80 ? "强势封板" :
        qualityScore >= 66 ? "结构稳健" :
          qualityScore >= 52 ? "换手观察" : "分歧偏大";
  const tags = [
    consecutiveBoards === null ? "连板数据待补" : consecutiveBoards >= 2 ? `${consecutiveBoards}连板` : "首板",
    firstSealMinutes === null ? "首封时间待补" : firstSealMinutes <= 10 * 60 + 30 ? "早盘封板" : "盘中确认",
    openBoardCount === null ? "开板数据待补" : openBoardCount === 0 ? "未开板" : `${openBoardCount}次开板`,
    turnover === null ? "换手数据待补" : turnover >= 2 && turnover <= 18 ? "换手健康" : turnover > 28 ? "换手过热" : "换手偏低"
  ];
  return { qualityScore, state, tags, coreFieldCount };
}

function LimitUpPool({ items, meta, onOpen, onAdd }: any) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  if (!items.length) return null;
  const normalized = filter.trim().toLowerCase();
  const filteredItems = normalized
    ? items.filter((item: any) =>
        [item.name, item.code, item.industry]
          .join(" ")
          .toLowerCase()
          .includes(normalized)
      )
    : items;
  const visibleItems = expanded ? filteredItems : filteredItems.slice(0, 8);
  return (
    <section className="panel discover-panel discover-panel-top">
      <PanelTitle
        title="涨停池"
        subtitle={meta?.dataDate ? `完整涨停名单 · 数据日 ${meta.dataDate}` : "最近交易日完整涨停名单"}
        icon={Sparkles}
        badge={`${items.length} 只`}
      />
      <div className="limit-pool-tools">
        {expanded && (
          <label>
            <Search size={15} />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="筛选股票、代码或板块"
            />
          </label>
        )}
        {items.length > 8 && (
          <button onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起列表" : `查看全部 ${items.length} 只`}
            <ChevronDown size={15} className={expanded ? "rotated" : ""} />
          </button>
        )}
      </div>
      <div className={`discover-table limit-analysis-table table ${expanded ? "expanded" : ""}`}>
        <div className="tr th">
          <span>股票 / 板块</span>
          <span>实时行情</span>
          <span>封板数据</span>
          <span>行情分析</span>
          <span>操作</span>
        </div>
        {visibleItems.map((item: any) => {
          const insight = limitUpMarketAnalysis(item);
          return (
            <div className="tr" key={item.code}>
              <button className="stock-cell" onClick={() => onOpen(item)}>
                <span><b>{item.name}</b><small>{item.code}</small></span>
                <em>{item.industry || "未分类"}</em>
              </button>
              <span className="limit-quote-cell">
                <b>{item.latest ? fmt(item.latest) : "--"}</b>
                <em className="red">+{fmt(item.changePct)}%</em>
                <small>换手 {fmt(item.turnover)}% · {fmtMoney(item.amount)}</small>
              </span>
              <span className="limit-seal-cell">
                <b>{item.firstSealTime || "--"} 首封</b>
                <small>
                  {item.openBoardCount ?? "--"} 次开板 · 封单/流通{" "}
                  {Number.isFinite(Number(item.sealFloatRatio))
                    ? `${fmt(Number(item.sealFloatRatio) * 100, 2)}%`
                    : "--"}
                </small>
              </span>
              <span className="limit-insight-cell">
                <b className={insight.qualityScore !== null && insight.qualityScore >= 66 ? "good" : insight.qualityScore !== null && insight.qualityScore < 52 ? "risk" : ""}>
                  {insight.qualityScore === null
                    ? `${insight.state} · ${insight.coreFieldCount}/3`
                    : `${insight.state} · ${insight.qualityScore}分`}
                </b>
                <small>{insight.tags.join(" · ")}</small>
              </span>
              <span className="limit-row-actions">
                <button className="table-action" onClick={() => onOpen(item)}>
                  <Activity size={15} />分析
                </button>
                <button className="table-action" onClick={() => onAdd(item)}>
                  <Bookmark size={15} />监控
                </button>
              </span>
            </div>
          );
        })}
        {!visibleItems.length && <div className="empty-inline">没有匹配的涨停股。</div>}
      </div>
    </section>
  );
}

function Dashboard({
  payload,
  loading,
  error,
  isWatched,
  onToggleWatch,
  onDiscover,
  discovering,
  limitUps,
  limitPoolMeta,
  onOpen,
  onAdd,
  settings,
  analysisTarget,
  mode,
  backLabel,
  onBack,
  onOpenBacktest,
  executionDecisionLog,
  onClearExecutionDecisionLog,
  paperSummary,
  paperExecutionReadiness,
  paperCurrentPositions,
  canPaperTrade,
  latestExecutionDecision,
  executePaperTrade,
  closePaperTradeForCurrent,
  closePaperTradeForCode,
  onRetry
}: any) {
  const [showFullExecutionDecisionLog, setShowFullExecutionDecisionLog] = useState(false);
  if (mode === "analysis" && !payload) {
    const targetName = typeof analysisTarget === "string"
      ? analysisTarget
      : analysisTarget?.name || analysisTarget?.code || "所选股票";
    const targetCode = typeof analysisTarget === "string" ? analysisTarget : analysisTarget?.code;
    return (
      <>
        <PageHeading
          eyebrow="SECURITY ANALYSIS"
          title={`个股复盘 · ${targetName}`}
          description={targetCode && targetCode !== targetName ? `正在读取 ${targetCode} 的最新有效数据` : "正在读取最新有效数据"}
          actions={(
            <button type="button" className="secondary-btn analysis-back-btn" onClick={onBack}>
              <ChevronLeft size={17} />
              {backLabel}
            </button>
          )}
        />
        {loading
          ? <LoadingState />
          : error
            ? <ErrorState message={error} onRetry={onRetry} />
            : <EmptyInline text="请选择股票后生成个股复盘。" />}
      </>
    );
  }
  if (mode === "pool" || !payload) {
    return (
      <>
        <PageHeading
          eyebrow="LIMIT-UP RADAR"
          title="涨停池"
          description={limitPoolMeta?.dataDate
            ? `数据日 ${limitPoolMeta.dataDate} · ${limitPoolMeta.count}只 · 最近核对 ${new Date(limitPoolMeta.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })} · ${limitPoolProviderLabel(limitPoolMeta.providers)}`
            : "每只涨停股同步显示实时行情、封板质量与结构判断；点击“分析”进入完整个股复盘。"}
          actions={<button className="primary-btn" onClick={onDiscover} disabled={discovering}>{discovering ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}刷新涨停池</button>}
        />
        <LimitUpPool items={limitUps} meta={limitPoolMeta} onOpen={onOpen} onAdd={onAdd} />
        {loading ? <LoadingState /> : error ? <ErrorState message={error} /> : <EmptyInline text="请选择涨停池股票查看详细分析。" />}
      </>
    );
  }
  const { quote, analysis: a, sector, history, announcements, security } = payload;
  const assetLabel = a.isSearchOnlyAsset
    ? String(a.assetLabel || quote.assetLabel || (security.assetType === "etf" ? "ETF" : "可转债"))
    : "";
  const isGeneralStock = !assetLabel && !a.limitEvent;
  const up = quote.changePct >= 0;
  const scoreTone = a.mrs >= 75 ? "good" : a.mrs >= 60 ? "warn" : "risk";
  const signal =
    a.grade === "S" ? "主线核心" : a.grade === "A" ? "主线回踩" : a.grade === "B" ? "等待确认" : "风险观察";
  const tradePlan = a.tradePlan || {};
  const tradeProjection = a.tradeProjection?.projection || {};
  const executionPolicy = a.executionPolicy || {};
  const historicalEdge = Number.isFinite(a.historicalEdge) ? a.historicalEdge : null;
  const historicalEdgePassed = a.qualification?.historicalEdgePassed === true;
  const qualityIndex = Number.isFinite(a.qualityIndex) ? a.qualityIndex : null;
  const marketCap = Number(quote.totalMarketCap || 0);
  const marketCapInBn = Number.isFinite(marketCap) ? marketCap / 1e8 : 0;
  const marketCapPassed =
    settings.minMarketCap <= 0 || marketCap >= settings.minMarketCap * 1e8;
  const hasTradePlan = tradePlan.signal === "BUY" || tradePlan.signal === "BUY_AGGRESSIVE";
  const killReasons: string[] = Array.isArray(tradePlan.killSwitchReasons)
    ? tradePlan.killSwitchReasons.filter((reason: unknown): reason is string => typeof reason === "string")
    : [];
  const killReasonsText = killReasons
    .filter((reason) => !(hasTradePlan && reason === "未触发买入信号"))
    .slice(0, 3)
    .join("；");
  const executionFillRate = clampNumber(tradePlan.executionFillRatePercent, 0, 100, 100);
  const minExecutionRate = clampNumber(
    executionPolicy.minExecutionRatePercent ?? settings.minExecutionRatePercent,
    40,
    100,
    90
  );
  const minProjectedNetEdge = clampNumber(executionPolicy.minProjectedNetEdgePercent ?? settings.minProjectedNetEdgePercent, -2, 10, 0.2);
  const minExpectancy = clampNumber(executionPolicy.minExpectancyPoints ?? settings.minExpectancyPoints, -2, 5, 0.2);
  const minPaperWinRatePercent = clampNumber(settings.minPaperWinRatePercent ?? 52, 40, 90, 52);
  const minPaperRiskRewardRatio = clampNumber(settings.minPaperRiskRewardRatio ?? 1.15, 1, 3, 1.15);
  const executionRiskProfile = normalizeRiskProfile(executionPolicy.riskProfile);
  const executionRiskProfileLabel = riskProfileLabel(executionRiskProfile);
  const quoteAmount = Number(quote.amount);
  const turnoverPercent = Number(quote.turnover);
  const updatedAtSeconds = Number.isFinite(Date.parse(payload.updatedAt))
    ? Math.max(0, Math.round((Date.now() - Date.parse(payload.updatedAt)) / 1000))
    : null;
  const marketReadinessPolicy = {
    minTurnoverPercent: clampNumber(settings.minTurnoverPercent ?? 0.4, 0, 20, 0.4),
    minQuoteAmount: clampNumber(settings.minQuoteAmount ?? 1200000, 0, 1_000_000_000, 1200000),
    maxQuoteAgeSeconds: clampNumber(settings.maxQuoteAgeSeconds ?? 480, 30, 1800, 480)
  };
  const riskControlsPass = [
    {
      name: "市值过滤",
      ok: marketCap >= (settings.minMarketCap || 0) * 1e8,
      value: `${marketCapInBn > 0 ? `${fmt(marketCapInBn)}亿` : "未知"}`
    },
    {
      name: "行情新鲜度",
      ok: updatedAtSeconds === null ? true : updatedAtSeconds <= marketReadinessPolicy.maxQuoteAgeSeconds,
      value: `${updatedAtSeconds === null ? "未知" : `${updatedAtSeconds}s / 阈值 ${marketReadinessPolicy.maxQuoteAgeSeconds}s`}`
    },
    {
      name: "成交额门槛",
      ok: Number.isFinite(quoteAmount) ? quoteAmount >= marketReadinessPolicy.minQuoteAmount : false,
      value: `${Number.isFinite(quoteAmount) ? fmtMoney(quoteAmount) : "未知"} / 阈值 ${fmtMoney(marketReadinessPolicy.minQuoteAmount)}`
    },
    {
      name: "换手率门槛",
      ok: Number.isFinite(turnoverPercent) ? turnoverPercent >= marketReadinessPolicy.minTurnoverPercent : false,
      value: `${Number.isFinite(turnoverPercent) ? `${turnoverPercent.toFixed(2)}%` : "未知"} / 阈值 ${marketReadinessPolicy.minTurnoverPercent}%`
    },
    {
      name: "历史边界",
      ok: historicalEdgePassed,
      value: historicalEdge !== null ? `${historicalEdge}%` : "待计算"
    },
    {
      name: "当日风险限额",
      ok: (executionPolicy.maxDailyRiskPercent || 0) > 0,
      value: `${executionPolicy.maxDailyRiskPercent || "--"}%`
    },
    {
      name: "成交率",
      ok: executionFillRate >= minExecutionRate,
      value: `${executionFillRate.toFixed(1)}% / 阈值 ${minExecutionRate}%`
    },
    {
      name: "最小预期净收益",
      ok: Number.isFinite(tradeProjection.projectedNetEdge) && tradeProjection.projectedNetEdge >= minProjectedNetEdge,
      value: `${minProjectedNetEdge}%`
    },
    {
      name: "最小期望值",
      ok: Number.isFinite(tradeProjection.expectancyPoints) && tradeProjection.expectancyPoints >= minExpectancy,
      value: `${minExpectancy}`
    },
    {
      name: "组合仓位上限",
      ok: (executionPolicy.maxPortfolioRiskPercent || 0) > 0,
      value: `${executionPolicy.maxPortfolioRiskPercent || "--"}%`
    },
    {
      name: "行业集中度",
      ok: Number.isFinite(executionPolicy.maxSectorExposurePercent ?? 45)
        ? paperSummary.currentSectorExposurePercent <= Number(executionPolicy.maxSectorExposurePercent ?? 45)
        : true,
      value: `${paperSummary.currentSectorName || "未知行业"} ${paperSummary.currentSectorExposurePercent.toFixed(1)}% / ${executionPolicy.maxSectorExposurePercent || "--"}%`
    },
    {
      name: "日内交易上限",
      ok: !paperSummary.dailyTradeSignal.blockedByDailyLimit,
      value: `${paperSummary.dailyTradeSignal.todayTradeCount}/${paperSummary.dailyTradeSignal.maxDailyTrades} 笔`
    },
    {
      name: "日内胜率",
      ok: paperSummary.dailyTradeSignal.todayClosedCount === 0 || paperSummary.dailyTradeSignal.todayWinRate >= minPaperWinRatePercent,
      value: `${paperSummary.dailyTradeSignal.todayClosedCount > 0 ? `${paperSummary.dailyTradeSignal.todayWinRate.toFixed(1)}%` : "--"} / 阈值 ${minPaperWinRatePercent}%`
    },
    {
      name: "风险收益比",
      ok: Number.isFinite(Number(tradeProjection.riskReward)) && Number(tradeProjection.riskReward) >= minPaperRiskRewardRatio,
      value: `风险收益比 ${tradeProjection.riskReward ?? "--"} / 阈值 ${minPaperRiskRewardRatio}`
    },
    {
      name: "仓位限额",
      ok: Number.isFinite(tradePlan.positionSizePercent) && Number(tradePlan.positionSizePercent) > 0,
      value: `${tradePlan.positionSizePercent ?? 0}%`
    }
  ];
  const paperExecutionButtonClass = `primary-btn paper-trade-btn ${
    paperExecutionReadiness.level === "wait" ? "paper-trade-btn--wait" : ""
  }`;
  const executionDecisionRows = Array.isArray(executionDecisionLog)
    ? (showFullExecutionDecisionLog ? executionDecisionLog : executionDecisionLog.slice(0, 5))
    : [];
  const hasMoreExecutionDecisionLog = Array.isArray(executionDecisionLog) && executionDecisionLog.length > 5;

  return (
    <>
      <PageHeading
        eyebrow={assetLabel
          ? `${assetLabel} · 实时行情`
          : `${quote.industry || "A股"} · 涨停股 · ${payload.actualProvider === "ths" ? "同花顺实时" : "免费实时行情"}`}
        title={
          <span className="stock-title">
            {quote.name}<small>{quote.code}</small>
            <em className={`market-pill ${security.thscode?.endsWith("SH") ? "sh" : "sz"}`}>
              {security.thscode?.split(".")[1] || "A"}
            </em>
          </span>
        }
        description={`数据更新于 ${new Date(payload.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}`}
        actions={
          <>
<button className="secondary-btn analysis-back-btn" onClick={onBack}>
              <ChevronLeft size={17} />
              {backLabel}
            </button>
            <button className="secondary-btn" onClick={onToggleWatch}>
              {isWatched ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
              {isWatched ? "已加入自选" : "加入自选"}
            </button>
            <button className="secondary-btn" onClick={() => onOpenBacktest(security)}>
              <LineChart size={17} />
              运行回测
            </button>
            <button className="primary-btn" onClick={onRetry} disabled={loading}>
              {loading ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
              刷新个股
            </button>
          </>
        }
      />

      {payload.warning && <div className="warning-banner"><CircleAlert size={17} />{payload.warning}</div>}

      <MarketDataStatusPanel
        federation={payload.dataFederation}
        actualProvider={payload.actualProvider}
        updatedAt={payload.updatedAt}
      />


      <section className="hero-grid">
        <div className="price-card panel">
          <div className="price-block">
            <span>最新价</span>
            <strong className={up ? "red" : "green"}>{fmt(quote.latest)}</strong>
            <div className={up ? "red" : "green"}>
              {up ? <TrendingUp size={17} /> : <TrendingDown size={17} />}
              {up ? "+" : ""}{fmt(quote.change)} &nbsp; {up ? "+" : ""}{fmt(quote.changePct)}%
            </div>
          </div>
          <div className="quote-grid">
            <Metric label="今开" value={fmt(quote.open)} />
            <Metric label="最高" value={fmt(quote.high)} tone="red" />
            <Metric label="最低" value={fmt(quote.low)} tone="green" />
            <Metric label="昨收" value={fmt(quote.preClose)} />
            <Metric label="换手" value={`${fmt(quote.turnover)}%`} />
            <Metric label="成交额" value={fmtMoney(quote.amount)} />
          </div>
        </div>

        <div className={`score-card panel ${scoreTone}`}>
          <div className="score-ring" style={{ "--score": `${a.mrs * 3.6}deg` } as any}>
            <div><strong>{a.mrs}</strong><span>MRS</span></div>
          </div>
          <div className="score-copy">
            <span className="grade">等级 {a.grade}</span>
            <h3>{signal}</h3>
            <p>{assetLabel
              ? `${assetLabel} · 技术结构与多周期 K 线`
              : a.limitEvent
                ? `${a.exactNode || a.nextNode || "观察期"} · ${a.trendLabel}`
                : "近60个交易日暂无涨停事件 · 通用行情分析"}</p>
          </div>
          <div className="score-components">
            <MiniBar label="个股结构" value={a.structureScore} />
            <MiniBar label="板块强度" value={a.sectorScore} />
            <MiniBar label="资讯驱动" value={a.infoScore} />
          </div>
        </div>
      </section>

      <section className="content-grid">
        <TrendChartPanel
          security={security}
          dailyHistory={history}
          eventDate={a.limitEvent?.date}
          support={a.limitEvent?.low}
          trendLabel={a.trendLabel}
        />

        <div className="panel node-panel">
          <PanelTitle
            title={assetLabel ? "行情结构" : isGeneralStock ? "通用行情结构" : "事件观察窗"}
            subtitle={assetLabel
              ? "主动搜索专属，不进入涨停观察池"
              : isGeneralStock
                ? "手工搜索、自选、持仓与多股同列均可分析"
                : "按交易日计算"}
            icon={Target}
          />
          {assetLabel ? (
            <div className="asset-search-scope-note">
              <b>{assetLabel} 行情已接入</b>
              <span>支持实时价格、分时与多周期 K 线；涨停日、T+节点和连板数据不适用于该标的。</span>
            </div>
          ) : isGeneralStock ? (
            <div className="asset-search-scope-note">
              <b>普通 A 股行情与技术分析已接入</b>
              <span>近期没有涨停事件，因此不生成 T+ 节点和封板质量；实时行情、趋势、量价、板块比较与回测仍可正常使用。</span>
            </div>
          ) : (
            <>
              <Timeline daysSince={a.daysSince} />
              <div className="event-facts">
                <Fact label="涨停日期" value={a.limitEvent?.date || "未识别"} />
                <Fact label="关键支撑" value={a.limitEvent ? `¥ ${fmt(a.limitEvent.low)}` : "--"} />
                <Fact label="距支撑位" value={`${a.supportDistance >= 0 ? "+" : ""}${fmt(a.supportDistance)}%`} tone={a.heldSupport ? "good" : "risk"} />
                <Fact label="锚定均价" value={a.avwap ? `¥ ${fmt(a.avwap)}` : "--"} />
              </div>
            </>
          )}
        </div>
      </section>

      <section className="signal-grid">
        {assetLabel ? (
          <SignalCard icon={ShieldCheck} label="标的范围" value="搜索专属" detail="默认池隐藏，不触发涨停策略" good />
        ) : isGeneralStock ? (
          <SignalCard icon={ShieldCheck} label="涨停事件" value="近60日未识别" detail="仅跳过涨停事件因子，不影响通用行情分析" good />
        ) : (
          <SignalCard icon={ShieldCheck} label="关键位防守" value={a.heldSupport ? "支撑有效" : "支撑失效"} detail={`观察期最低价 ${a.limitEvent ? fmt(Math.min(...history.filter((x: any) => x.date >= a.limitEvent.date).map((x: any) => x.low))) : "--"}`} good={a.heldSupport} />
        )}
        <SignalCard icon={Activity} label="量价状态" value={a.volumeRatio < 0.8 ? "缩量整理" : a.volumeRatio < 1.5 ? "量能温和" : "量能放大"} detail={`量能倍数 ${fmt(a.volumeRatio)} · 相对换手 ${fmt(a.relativeTurnover)}`} good={a.volumeRatio < 1.5} />
        <SignalCard icon={TrendingUp} label="均线趋势" value={a.trendLabel} detail={`MA5-MA20 发散 ${fmt(a.divergence)}%`} good={a.maBull && a.slopesUp} />
        {assetLabel ? (
          <SignalCard icon={Gauge} label="市场参照" value="中性比较" detail="不纳入涨停板块强度排名" good />
        ) : (
          <SignalCard icon={Gauge} label="相对板块" value={`${a.rsSector >= 0 ? "+" : ""}${fmt(a.rsSector)}%`} detail={`个股3日 ${fmt(a.stockReturn3)}%`} good={a.rsSector >= 0} />
        )}
      </section>

      {a.limitEvent ? <FirstBoardQualityPanel quality={a.firstBoardQuality} /> : null}

      <section className="panel strategy-status-panel">
        <PanelTitle
          title="当前策略组合"
          subtitle="逐项显示实际结果；风险否决始终执行"
          icon={SlidersHorizontal}
          badge={a.alertQualified ? "已达到提醒条件" : `${a.strategyMatched || 0} / ${a.strategyTotal || settings?.selectedStrategies?.length || 0} 符合`}
        />
        <div className={`qualification-strip ${a.alertQualified ? "qualified" : "waiting"}`}>
          {a.alertQualified ? <CheckCircle2 size={18} /> : <CircleDot size={18} />}
          <div>
            <b>{a.alertQualified ? "策略、分数、节点和风险过滤均通过" : "当前未触发提醒"}</b>
            <small>
              匹配率 {a.strategyMatchRate || 0}% · MRS {a.mrs}/{a.qualification?.alertScore || settings?.alertScore} ·
              {a.qualification?.exactNodesOnly ? ` 节点 ${a.exactNode || "未到"}` : " 节点不限"} ·
              风险否决 {a.qualification?.riskVetoPassed ? "通过" : "未通过"}
            </small>
          </div>
        </div>
        <div className="strategy-result-grid">
          {(a.strategyResults || []).map((item: any) => (
            <div className={`strategy-result ${item.matched ? "matched" : "missed"}`} key={item.id}>
              <span>{item.matched ? "✓" : "×"}</span>
              <div><b>{item.label}</b><small>{item.detail}</small></div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel execution-plan-panel">
        <PanelTitle
          title="执行计划与风控"
          subtitle="基于策略与账户风控规则输出可执行动作"
          icon={Target}
          badge={qualityIndex === null ? "未生成执行计划" : `质量评分 ${qualityIndex}`}
        />
        <div className={`qualification-strip ${hasTradePlan ? "qualified" : "waiting"}`}>
          {hasTradePlan ? <CheckCircle2 size={18} /> : <CircleDot size={18} />}
          <div>
            <b>执行信号：{tradeSignalLabel(tradePlan.signal)}</b>
            <small>
              历史边界 {historicalEdge !== null ? `${historicalEdge}%` : "--"}，
              {historicalEdgePassed ? "历史通过" : "历史未通过"}，市值 {marketCapPassed ? "通过" : "未通过"}
            </small>
          </div>
        </div>
        <div className="fact-grid">
          <h4>执行约束</h4>
          {(riskControlsPass || []).map((item) => (
            <Fact key={item.name} label={item.name} value={item.ok ? `✅ ${item.value}` : `❌ ${item.value}`} />
          ))}
        </div>
        <div className="execution-grid">
          <div>
            <h4>仓位与风控</h4>
            <div className="fact-grid">
              <Fact label="最大仓位" value={`${tradePlan.maxPositionPercent ?? "--"}%`} />
              <Fact label="建议仓位" value={`${tradePlan.positionSizePercent ?? "--"}%`} />
              <Fact label="单笔风险占比" value={`${tradePlan.atRiskPercent ?? "--"}%`} />
              <Fact label="止损位" value={tradePlan.stopLossPrice ? fmtMoney(tradePlan.stopLossPrice) : "--"} />
              <Fact label="止盈位" value={tradePlan.takeProfitPrice ? fmtMoney(tradePlan.takeProfitPrice) : "--"} />
              <Fact label="止损距离" value={tradePlan.stopLossDistancePercent ? `${fmt(tradePlan.stopLossDistancePercent)}%` : "--"} />
              <Fact label="止盈距离" value={tradePlan.takeProfitDistancePercent ? `${fmt(tradePlan.takeProfitDistancePercent)}%` : "--"} />
              <Fact label="风险收益比" value={tradePlan.riskReward ?? "--"} />
              <Fact label="Kelly系数" value={tradePlan.halfKellyFraction !== undefined ? fmt(tradePlan.halfKellyFraction) : "--"} />
              <Fact label="Kelly仓位建议" value={tradePlan.kellyPositionPercent !== undefined ? `${fmt(tradePlan.kellyPositionPercent)}%` : "--"} />
              <Fact label="Kill 开关" value={tradePlan.killSwitchTriggered ? "触发" : "未触发"} />
              <Fact label="Kill原因" value={killReasonsText || "--"} />
            </div>
          </div>
          <div>
            <h4>收益与概率</h4>
            <div className="fact-grid">
              <Fact label="目标策略" value={tradeProjection.strategyLabel || "--"} />
              <Fact label="预期回报" value={tradeProjection.expectedReturnPercent !== undefined ? `${fmt(tradeProjection.expectedReturnPercent)}%` : "--"} />
              <Fact label="净收益率" value={tradeProjection.projectedNetEdge !== undefined ? `${fmt(tradeProjection.projectedNetEdge)}%` : "--"} />
              <Fact label="期望值" value={tradeProjection.expectancyPoints !== undefined ? `${fmt(tradeProjection.expectancyPoints)}` : "--"} />
              <Fact label="预期成交率" value={tradeProjection.executionFillRatePercent !== undefined ? `${fmt(tradeProjection.executionFillRatePercent)}%` : "--"} />
              <Fact label="风控安全系数" value={tradeProjection.rrSafety !== undefined ? `${fmt(tradeProjection.rrSafety)}` : "--"} />
              <Fact label="TP概率" value={tradeProjection.probabilityTakeProfit !== undefined ? `${fmt(tradeProjection.probabilityTakeProfit)}%` : "--"} />
              <Fact label="SL概率" value={tradeProjection.probabilityStopLoss !== undefined ? `${fmt(tradeProjection.probabilityStopLoss)}%` : "--"} />
              <Fact label="超时概率" value={tradeProjection.probabilityTimeExit !== undefined ? `${fmt(tradeProjection.probabilityTimeExit)}%` : "--"} />
              <Fact label="Kelly仓位" value={tradeProjection.kellyPositionPercent !== undefined ? `${fmt(tradeProjection.kellyPositionPercent)}%` : "--"} />
              <Fact label="半Kelly" value={tradeProjection.kellyHalfFraction !== undefined ? fmt(tradeProjection.kellyHalfFraction) : "--"} />
              <Fact label="预计持仓期" value={`${tradeProjection.estimatedHoldingBars ?? 0} 根`} />
            </div>
          </div>
          <div>
            <h4>约束与执行开关</h4>
            <div className="fact-grid">
              <Fact label="风险档位" value={executionRiskProfileLabel} />
              <Fact label="日内风险上限" value={`${executionPolicy.maxDailyRiskPercent ?? "--"}%`} />
              <Fact label="最大持仓窗口" value={`${executionPolicy.maxHoldingBars ?? "--"} 根`} />
              <Fact label="单笔滑点+佣金" value={tradePlan.projectedCommissionPercent !== undefined ? `${tradePlan.projectedCommissionPercent}%` : "--"} />
              <Fact label="最小成交率" value={`${executionPolicy.minExecutionRatePercent ?? "--"}%`} />
              <Fact label="最大持仓数" value={`${executionPolicy.maxOpenPositions ?? "--"} 只`} />
              <Fact label="追踪止损" value={`${executionPolicy.trailingStopPercent ?? "--"}%`} />
              <Fact label="时间衰减" value={executionPolicy.timeDecayPerBarPercent !== undefined ? `${executionPolicy.timeDecayPerBarPercent}%` : "--"} />
              <Fact label="连续亏损停手" value={`${executionPolicy.maxConsecutiveLossesForStop ?? "--"} 笔`} />
              <Fact label="减仓步幅" value={`${executionPolicy.lossStreakStepPercent ?? "--"}% / 笔`} />
              <Fact label="组合仓位上限" value={`${executionPolicy.maxPortfolioRiskPercent ?? "--"}%`} />
              <Fact label="行业仓位上限" value={`${executionPolicy.maxSectorExposurePercent ?? "--"}%`} />
            </div>
          </div>
          <div>
            <h4>纸面模拟执行</h4>
            <div className="paper-trade-controls">
              <div className="paper-trade-actions">
                <button
                  className={paperExecutionButtonClass}
                  onClick={executePaperTrade}
                  disabled={!canPaperTrade}
                  title={
                    paperExecutionReadiness.level === "block"
                      ? paperExecutionReadiness.summary
                      : paperExecutionReadiness.level === "wait"
                        ? `${paperExecutionReadiness.recommendation}（可继续确认）`
                        : "按当前执行计划模拟开仓"
                  }
                >
                  模拟下单
                </button>
                <button
                  className="secondary-btn"
                  onClick={() => closePaperTradeForCurrent("MANUAL")}
                  disabled={!paperCurrentPositions.length}
                >
                  平掉当前标的
                </button>
              </div>
              <div className="execution-decision-log panel">
                <div className="execution-decision-log-head">
                  <strong>执行决策日志</strong>
                  <div className="execution-decision-log-actions">
                    {!!hasMoreExecutionDecisionLog && (
                      <button
                        className="secondary-btn ghost-btn"
                        onClick={() => setShowFullExecutionDecisionLog((current) => !current)}
                      >
                        {showFullExecutionDecisionLog ? "收起" : "展开"}
                      </button>
                    )}
                    {!!executionDecisionLog.length && (
                      <button
                        className="secondary-btn ghost-btn danger-btn"
                        onClick={onClearExecutionDecisionLog}
                        title="清空决策日志"
                      >
                        清空
                      </button>
                    )}
                  </div>
                </div>
                {!executionDecisionRows.length ? (
                  <div className="execution-decision-empty">暂无决策记录</div>
                ) : (
                  <div className="execution-decision-list">
                    {executionDecisionRows.map((decision: any) => (
                      <div className={`execution-decision-item execution-decision-item--${decision.level}`} key={decision.id}>
                        <b>
                          {decision.securityCode || "--"} · {decision.summary}
                        </b>
                        <span>
                          来源：{decision.source} · 等级：{decision.level.toUpperCase()} · 结果：{decision.result}
                        </span>
                        {!!decision.reasons?.length ? <small>{decision.reasons.join("；")}</small> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <small style={{ color: "var(--muted)", display: "block", marginTop: latestExecutionDecision ? 4 : 8, fontSize: 11 }}>
                {paperSummary.portfolioKill
                  ? `组合风控触发：${paperSummary.portfolioKillReasons.join("；")}`
                  : paperSummary.portfolioKillWarning
                  ? `组合风控预警：${paperSummary.portfolioKillReasons.join("；")}`
                  : paperSummary.dailyStopped
                  ? "今日日内风控已触发，停止新开仓。"
                  : paperSummary.lossStreakBlocked
                  ? `日内连续亏损过载，已触发降仓停手（${paperSummary.lossStreakConsecutive || 0}笔）`
                  : paperSummary.lossStreakConsecutive > 0
                  ? `日内连续亏损 ${paperSummary.lossStreakConsecutive} 笔，减仓系数 ${Math.round((paperSummary.lossStreakMultiplier || 1) * 100)}%`
                  : `可用仓位 ${paperCurrentPositions.length} / ${settings.maxOpenPositions}`}
              </small>
            </div>
          </div>
        </div>
      </section>

      <section className="panel paper-sim-panel">
        <PanelTitle
          title="纸面交易日志"
          subtitle="基于模拟资金的持仓与盈亏追踪（不接入真实下单）"
          icon={Bookmark}
          badge={`总交易 ${paperSummary.normalized.totalTradeCount || 0} 笔`}
        />
        <div className={`paper-governance-card ${paperSummary.strategyGovernance.stage}`}>
          <div className="paper-governance-head">
            <div>
              <strong>策略生命周期：{paperSummary.strategyGovernance.status}</strong>
              <small>
                当前档位 {riskProfileLabel(settings.riskProfile)} ·
                策略仓位系数 {Math.round(paperSummary.strategyGovernance.positionMultiplier * 100)}%
              </small>
            </div>
            <span className={`history-state ${
              paperSummary.strategyGovernance.stage === "promoted" ? "ok" :
                paperSummary.strategyGovernance.stage === "candidate" ? "wait" : "bad"
            }`}>
              {paperSummary.strategyGovernance.canPromoteToLive ? "可晋级" : paperSummary.strategyGovernance.stage.toUpperCase()}
            </span>
          </div>
          <div className="paper-governance-progress">
            <div>
              <span>验证进度</span>
              <b>{paperSummary.strategyGovernance.tradeCount}/{paperSummary.strategyGovernance.minimumPromotionTrades} 笔</b>
            </div>
            <em>
              <i style={{
                width: `${Math.min(
                  100,
                  paperSummary.strategyGovernance.tradeCount /
                    paperSummary.strategyGovernance.minimumPromotionTrades * 100
                )}%`
              }} />
            </em>
          </div>
          <div className="paper-governance-metrics">
            <div><span>资格评分</span><b>{paperSummary.strategyGovernance.score}</b></div>
            <div><span>当前策略胜率</span><b>{fmt(paperSummary.strategyGovernance.winRate)}%</b></div>
            <div>
              <span>盈利因子</span>
              <b>{Number.isFinite(paperSummary.strategyGovernance.profitFactor) ? fmt(paperSummary.strategyGovernance.profitFactor) : "∞"}</b>
            </div>
            <div><span>策略最大回撤</span><b>{fmt(paperSummary.strategyGovernance.maxDrawdownPercent)}%</b></div>
            <div><span>平均模拟成交率</span><b>{fmt(paperSummary.strategyGovernance.averageExecutionFillRatePercent)}%</b></div>
            <div><span>最近10笔盈亏</span><b>{fmtMoney(paperSummary.strategyGovernance.recentTenPnl)}</b></div>
          </div>
          <small className="paper-governance-reasons">
            {paperSummary.strategyGovernance.reasons.slice(0, 3).join("；")}
            {paperSummary.strategyGovernance.suspendedUntil
              ? `；暂停至 ${new Date(paperSummary.strategyGovernance.suspendedUntil).toLocaleString("zh-CN")}`
              : ""}
          </small>
        </div>
        <div className="fact-grid paper-summary-grid">
          <Fact label="账户总资金" value={fmtMoney(paperSummary.equity)} />
          <Fact label="可用资金" value={fmtMoney(paperSummary.normalized.cash)} />
          <Fact label="持仓市值" value={fmtMoney(paperSummary.openValue)} />
          <Fact label="组合占用" value={`${fmt(paperSummary.portfolioRiskPercent)}% / ${paperSummary.maxPortfolioRiskPercent}%`} />
          <Fact label="行业集中度（当前）" value={paperSummary.currentSectorName ? `${paperSummary.currentSectorName} ${paperSummary.currentSectorExposurePercent.toFixed(1)}% / ${paperSummary.maxSectorExposurePercent}%` : "--"} />
          <Fact label="日内风险占用" value={`${(paperSummary.lossPressureRatio * 100).toFixed(2)}% / ${paperSummary.dailyLossLimit > 0 ? "阈值 " + fmt(paperSummary.dailyLossLimit) : "未启用"}`} />
          <Fact label="已实现盈亏" value={fmt(paperSummary.cumulativeRealizedPnl)} />
          <Fact label="累计回报" value={`${fmt(paperSummary.cumulativeReturnPercent)}%（${fmt(paperSummary.cumulativeNetPnl)}）`} />
          <Fact label="持仓未实现盈亏" value={`${fmt(paperSummary.openPnl)}（${fmt(paperSummary.openPnlPercent)}%）`} />
          <Fact label="今日已实现盈亏" value={fmt(paperSummary.normalized.dailyRealizedPnl)} />
          <Fact label="日内交易" value={`${paperSummary.dailyTradeSignal.todayTradeCount}/${paperSummary.dailyTradeSignal.maxDailyTrades}`} />
          <Fact label="今日胜率" value={paperSummary.dailyTradeSignal.todayClosedCount > 0 ? `${fmt(paperSummary.dailyTradeSignal.todayWinRate)}%` : "--"} />
          <Fact label="交易质量阈值" value={`胜率 ${fmt(paperSummary.dailyTradeSignal.todayClosedCount > 0 ? paperSummary.dailyTradeSignal.todayWinRate : 0)}% / RR ${fmt(settings.minPaperRiskRewardRatio ?? 1.15)}`} />
          <Fact label="盈亏比" value={paperSummary.profitFactor === Number.POSITIVE_INFINITY ? "∞" : fmt(paperSummary.profitFactor)} />
          <Fact label="平均持仓时长" value={`${paperSummary.avgHoldingBars.toFixed(1)} 根`} />
          <Fact label="最大回撤" value={`${fmt(paperSummary.maxDrawdownPercent)}%`} />
          <Fact label="连续亏损（当日）" value={`${paperSummary.lossStreakConsecutive || 0} 笔`} />
          <Fact label="减仓系数" value={paperSummary.lossStreakMultiplier !== undefined ? `${fmt(paperSummary.lossStreakMultiplier * 100)}%` : "--"} />
          <Fact label="连续亏损停手" value={paperSummary.lossStreakBlocked ? "是" : "否"} />
          <Fact label="历史胜率" value={paperSummary.closedCount ? `${fmt(paperSummary.winRate)}%` : "--"} />
          <Fact label="日内风险上限" value={paperSummary.dailyLossLimit > 0 ? `${fmt(paperSummary.dailyLossLimit)} 元` : "未启用"} />
          <Fact label="今天是否熔断" value={paperSummary.dailyStopped ? "是" : "否"} />
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="paper-summary-header">
            <h4>当前持仓</h4>
            {paperSummary.normalized.openPositions.length ? (
              <button className="secondary-btn" onClick={() => closePaperTradeForCurrent("MANUAL")}>一键平掉所有当前标的</button>
            ) : (
              <small style={{ color: "var(--muted)" }}>暂无持仓</small>
            )}
          </div>
        {paperSummary.normalized.openPositions.length ? (
            <div className="table paper-position-table">
              <div className="th tr"><span>标的</span><span>仓位参数</span><span>持仓/成本</span><span>未实现/原因</span><span>操作</span></div>
              {paperSummary.normalized.openPositions.map((position: PaperPosition) => (
                <div className="tr" key={position.id}>
                  <span className="stock-cell">
                    <button className="table-action" onClick={() => onOpen({ code: position.code, name: position.name, secid: "" } as Security)}> {position.code}</button>
                    <small>{position.name}</small>
                  </span>
                  <span>{`${position.shares} 股 · 入场 ${fmt(position.entryPrice)}元`}</span>
                  <span>
                    {`持仓 ${position.holdingBars} 根`}
                    <br />
                    {`止损 ${fmtMoney(position.stopPrice)} / 止盈 ${fmtMoney(position.takePrice)}`}
                  </span>
                  <span>
                    {`最新 ${fmtMoney(position.latestPrice)}`}
                    <br />
                    {`未实 ${fmt(position.latestPrice * position.shares - position.entryPrice * position.shares)}元`}
                  </span>
                  <span>
                    <button className="table-action" onClick={() => closePaperTradeForCode(position.code, "MANUAL")}>平仓</button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <h4 style={{ marginTop: 12 }}>最近平仓</h4>
          {!paperSummary.normalized.closedPositions.length ? (
            <div className="empty-inline">暂无平仓记录</div>
          ) : (
            <div className="table paper-position-table">
              <div className="th tr"><span>时间</span><span>标的</span><span>原因</span><span>盈亏</span><span>平仓价</span></div>
              {paperSummary.normalized.closedPositions.slice(0, 6).map((position: PaperClosedPosition) => (
                <div className="tr" key={`${position.id}-${position.closeTime}`}>
                  <span>{position.closeTime.slice(0, 10)} {position.closeTime.slice(11, 16)}</span>
                  <span>{position.code}</span>
                  <span>{reasonLabel(position.closeReason)}</span>
                  <span>{`${fmt(position.realizedPnl)}（${fmt(position.realizedPnlPercent)}%）`}</span>
                  <span>{fmtMoney(position.closePrice)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <HistoricalStatsPanel data={a.historicalStats} />

      <section className="content-grid lower">
        <div className="panel sector-panel">
          <PanelTitle
            title="板块强度"
            subtitle="1 / 3 / 5 日滚动"
            icon={Layers3}
            badge={sector?.state || "暂无数据"}
          />
          {sector ? (
            <>
              <div className="sector-head">
                <div><span>{sector.name}</span><strong>{sector.score ?? "--"}</strong><small>{sector.score == null ? " 评分暂停" : "/ 100"}</small></div>
                <div className="sector-rank">{sector.state}</div>
              </div>
              <div className="return-bars">
                <ReturnBar label="1日超额" value={subtractNullable(sector.returns.r1, sector.benchmarkReturns.r1)} />
                <ReturnBar label="3日超额" value={subtractNullable(sector.returns.r3, sector.benchmarkReturns.r3)} />
                <ReturnBar label="5日超额" value={subtractNullable(sector.returns.r5, sector.benchmarkReturns.r5)} />
              </div>
              <div className="sector-stats">
                <Metric label="上涨广度" value={sector.breadth == null ? "--" : `${fmt(sector.breadth * 100, 0)}%`} />
                <Metric label="涨停家数" value={String(sector.limitUps)} tone="red" />
                <Metric label="成交热度" value={sector.amountHeat == null ? "--" : `${fmt(sector.amountHeat)}x`} />
                <Metric label="5日持续" value={sector.persistence == null ? "--" : `${fmt(sector.persistence * 100, 0)}%`} />
              </div>
            </>
          ) : <EmptyInline text="板块数据暂不可用" />}
        </div>

        <div className="panel news-panel">
          <PanelTitle title="最新公告" subtitle="信息驱动 · 原始披露" icon={Newspaper} badge={`${announcements.length} 条`} />
          {announcements.slice(0, 4).map((item: any) => (
            <button
              className="news-item"
              key={item.art_code || item.sourceUrl || `${item.title}-${item.display_time}`}
              onClick={() => window.stockApi.openExternal(
                item.sourceUrl || `https://data.eastmoney.com/notices/detail/${quote.code}/${item.art_code}.html`
              )}
            >
              <span className={`news-score ${item.direction}`}>{item.score}</span>
              <span className="news-copy"><b>{item.title}</b><small>{item.category} · {item.display_time?.slice(0, 16)}</small></span>
              <ExternalLink size={15} />
            </button>
          ))}
          {!announcements.length && <EmptyInline text="暂无公告" />}
        </div>
      </section>

      {a.risks.length > 0 && (
        <div className="risk-strip">
          <CircleAlert size={18} />
          <b>风险提示</b>
          {a.risks.map((risk: string) => <span key={risk}>{risk}</span>)}
        </div>
      )}

    </>
  );
}

function sourceDisplayName(source: any) {
  const id = String(source?.id || "").toLowerCase();
  if (id === "ths") return "同花顺";
  if (id === "eastmoney") return "东方财富";
  if (id === "tencent") return "腾讯";
  return String(source?.name || "行情源");
}

function MarketDataStatusPanel({ federation, actualProvider, updatedAt }: any) {
  const sourceRows = Array.isArray(federation?.sources) ? federation.sources : [];
  const byId = new Map(sourceRows.map((source: any) => [String(source?.id || ""), source]));
  const lines = ["ths", "eastmoney", "tencent"].map((id) => byId.get(id) || { id, enabled: false, ok: null });
  const spreadPct = Number(federation?.spreadPct);
  const realtimeCount = Number(federation?.realtimeCount);
  const status = String(federation?.status || "等待校验");
  const needsReview = status.includes("需复核") || (Number.isFinite(spreadPct) && spreadPct > 0.2);
  const isConsistent = !needsReview && Number.isFinite(realtimeCount) && realtimeCount >= 2 && Number.isFinite(spreadPct) && spreadPct <= 0.05;
  const updateTime = Number.isFinite(Date.parse(String(updatedAt || "")))
    ? new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "--";
  const activeProvider = sourceDisplayName({ id: actualProvider });
  return (
    <section className={`panel market-data-status ${needsReview ? "review" : isConsistent ? "consistent" : "limited"}`}>
      <div className="market-data-status-head">
        <div>
          <span><Database size={16} /> THREE-LINE QUOTE CHECK</span>
          <b>行情可信度</b>
          <small>主源、接力和交叉校验均按实际返回状态展示，不把降级行情标成同花顺实时。</small>
        </div>
        <em>{needsReview ? "需人工复核" : isConsistent ? "多源一致" : status}</em>
      </div>
      <div className="market-data-metrics">
        <div><span>当前报价</span><b>{activeProvider}</b><small>{updateTime} 更新</small></div>
        <div><span>实时可用</span><b>{Number.isFinite(realtimeCount) ? `${realtimeCount} 路` : "--"}</b><small>三线并行校验</small></div>
        <div><span>多源价差</span><b>{Number.isFinite(spreadPct) ? `${spreadPct.toFixed(3)}%` : "--"}</b><small>{needsReview ? "超过阈值，已禁止纸面执行" : "不以均价替换主报价"}</small></div>
        <div><span>一致性价格</span><b>{Number(federation?.consensusPrice) > 0 ? fmt(federation.consensusPrice) : "--"}</b><small>仅用于交叉核验</small></div>
      </div>
      <div className="market-data-sources">
        {lines.map((source: any) => {
          const ok = source?.ok === true;
          const disabled = source?.enabled === false;
          const label = ok ? "已校验" : disabled ? "未配置" : "不可用";
          return (
            <div className={`market-data-source ${ok ? "ok" : disabled ? "disabled" : "fail"}`} key={source.id}>
              <span>{sourceDisplayName(source)}</span>
              <b>{ok && Number(source.latest) > 0 ? fmt(source.latest) : "--"}</b>
              <small>{source?.role || label} · {label}{Number.isFinite(Number(source?.latencyMs)) ? ` · ${Math.round(Number(source.latencyMs))}ms` : ""}</small>
            </div>
          );
        })}
      </div>
      {federation?.note && <p className="market-data-note"><CircleAlert size={15} />{federation.note}</p>}
    </section>
  );
}

function FirstBoardQualityPanel({ quality }: { quality: any }) {
  if (!quality) return null;
  return (
    <section className="panel first-board-panel">
      <PanelTitle
        title="首板质量"
        subtitle="首次封板、开板次数、封单、换手和位置综合评分"
        icon={Zap}
        badge={!quality.available
          ? "数据待补"
          : quality.dataComplete === false
            ? "字段缺失 · 暂停评分"
            : `${quality.score} 分 · ${quality.grade}级`}
      />
      {!quality.available ? (
        <EmptyInline text={quality.summary || "涨停专题字段暂不可用"} />
      ) : (
        <>
          <div className="first-board-summary">
            <div className={`quality-score ${quality.matched ? "good" : "warn"}`}>
              <strong>{quality.dataComplete === false ? "--" : quality.score}</strong><span>/ 100</span><b>{quality.summary}</b>
            </div>
            <div className="quality-keyfacts">
              <Fact label="首次封板" value={quality.firstSealTime || "--"} />
              <Fact label="最后封板" value={quality.lastSealTime || "--"} />
              <Fact label="开板次数" value={`${quality.openBoardCount ?? "--"} 次`} />
              <Fact label="涨停换手" value={`${fmt(quality.turnover)}%`} />
              <Fact
                label="封单/流通市值"
                value={quality.sealFloatRatio == null ? "--" : `${fmt(quality.sealFloatRatio * 100)}%`}
              />
              <Fact label="封单金额" value={fmtMoney(quality.sealedAmount)} />
            </div>
          </div>
          <div className="quality-factor-grid">
            {(quality.factors || []).map((factor: any) => (
              <div className={factor.passed ? "passed" : "missed"} key={factor.id}>
                <span>{factor.label}<b>{factor.value}</b></span>
                <i><em style={{ width: `${factor.maxPoints ? factor.points / factor.maxPoints * 100 : 0}%` }} /></i>
                <small>{factor.points}/{factor.maxPoints}分 · 标准 {factor.threshold}</small>
              </div>
            ))}
          </div>
          {!!quality.risks?.length && (
            <div className="quality-risks"><ShieldAlert size={17} />{quality.risks.map((item: string) => <span key={item}>{item}</span>)}</div>
          )}
        </>
      )}
    </section>
  );
}

function HistoricalStatsPanel({ data }: { data: any }) {
  if (!data) return null;
  const value = (number: number | null, suffix = "%") =>
    Number.isFinite(number) ? `${number! >= 0 ? "+" : ""}${fmt(number!)}${suffix}` : "--";
  return (
    <section className="panel historical-stats-panel">
      <PanelTitle
        title="策略历史统计"
        subtitle={`${data.source} · ${data.range || "历史区间不足"} · ${data.entryRule || "严格按当时数据回测"}`}
        icon={BarChart3}
        badge={`${data.totalEvents || 0} 轮涨停事件`}
      />
      <div className="stats-warning">
        <CircleAlert size={16} />
        <span>
          当前为该股票历史回放，不是全市场承诺胜率。1/3/5日分别按已结算样本统计。
          {data.benchmarkAvailable ? " 5日超额收益以中证全指同期表现为基准。" : " 当前缺少全A基准序列，暂不显示超额收益。"}
          {Number(data.rawEventCount || 0) > Number(data.totalEvents || 0)
            ? ` 连板已去重：${data.rawEventCount} 个涨停日归并为 ${data.totalEvents} 轮。`
            : ""}
          {data.untradeableCount ? ` 已剔除 ${data.untradeableCount} 个次日一字涨停不可成交节点。` : ""}
        </span>
      </div>
      <div className="strategy-stats-table">
        <div className="strategy-stat-row stat-head">
          <span>策略</span><span>结算样本</span><span>次日胜率</span><span>3日胜率</span><span>5日胜率</span><span>5日均值/超额</span><span>最差回撤</span><span>置信度</span>
        </div>
        {(data.stats || []).map((item: any) => (
          <div className={`strategy-stat-row ${item.available ? "" : "unavailable"}`} key={item.id}>
            <span><b>{item.label}</b><small>{item.unavailableReason || item.confidenceNote}</small></span>
            <span className="sample-breakdown">
              <b>{item.sampleCount}</b>
              <small>1日 {item.n1 ?? 0} · 3日 {item.n3 ?? 0} · 5日 {item.n5 ?? 0}</small>
            </span>
            <span>{Number.isFinite(item.winRate1) ? `${fmt(item.winRate1, 1)}%` : "--"}</span>
            <span>{Number.isFinite(item.winRate3) ? `${fmt(item.winRate3, 1)}%` : "--"}</span>
            <span className="win-interval">
              {Number.isFinite(item.winRate5) ? `${fmt(item.winRate5, 1)}%` : "--"}
              {Array.isArray(item.winRate5Interval) && (
                <small>95%区间 {fmt(item.winRate5Interval[0], 0)}–{fmt(item.winRate5Interval[1], 0)}%</small>
              )}
            </span>
            <span className={`return-breakdown ${item.average5 >= 0 ? "red" : "green"}`}>
              {value(item.average5)}
              {Number.isFinite(item.averageExcess5) && (
                <small>全A超额 {value(item.averageExcess5)}</small>
              )}
            </span>
            <span className="green">{value(item.worstMdd5)}</span>
            <span><em className={`confidence ${item.confidence}`}>{item.confidence}</em></span>
          </div>
        ))}
      </div>
      <div className="node-stat-grid">
        {(data.nodeStats || []).map((item: any) => (
          <div key={item.node}>
            <span>{item.node}</span><b>{item.sampleCount} 触发 / {item.n5 ?? 0} 结算</b>
            <small>
              5日胜率 {Number.isFinite(item.winRate5) ? `${fmt(item.winRate5, 1)}%` : "--"}
              {" · "}均值 {value(item.average5)}
              {Number.isFinite(item.averageExcess5) ? ` · 超额 ${value(item.averageExcess5)}` : ""}
            </small>
            <em>{item.confidence}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function TrendChartPanel({ security, dailyHistory, eventDate, support, trendLabel }: any) {
  const frames: any[] = [
    { value: "1", label: "1分钟", defaultRange: "1d", ranges: [["1d", "1日"], ["3d", "3日"], ["5d", "5日"], ["10d", "10日"]] },
    { value: "5", label: "5分钟", defaultRange: "3d", ranges: [["1d", "1日"], ["3d", "3日"], ["5d", "5日"], ["10d", "10日"]] },
    { value: "15", label: "15分钟", defaultRange: "10d", ranges: [["5d", "5日"], ["10d", "10日"], ["20d", "20日"], ["30d", "30日"]] },
    { value: "30", label: "30分钟", defaultRange: "20d", ranges: [["10d", "10日"], ["20d", "20日"], ["1m", "1个月"]] },
    { value: "60", label: "60分钟", defaultRange: "20d", ranges: [["10d", "10日"], ["20d", "20日"], ["1m", "1个月"]] },
    { value: "120", label: "120分钟·半日", defaultRange: "1m", ranges: [["10d", "10日"], ["20d", "20日"], ["1m", "1个月"]] },
    { value: "101", label: "日线", defaultRange: "3m", ranges: [["3m", "3个月"], ["6m", "6个月"], ["1y", "1年"], ["3y", "3年"]] },
    { value: "102", label: "周线", defaultRange: "3y", ranges: [["1y", "1年"], ["3y", "3年"], ["5y", "5年"], ["10y", "10年"]] },
    { value: "103", label: "月线", defaultRange: "10y", ranges: [["3y", "3年"], ["5y", "5年"], ["10y", "10年"], ["all", "全部"]] }
  ];
  const [frame, setFrame] = useState("101");
  const [range, setRange] = useState("3m");
  const [density, setDensity] = useState("120");
  const [adjustment, setAdjustment] = useState("front");
  const [windowOffset, setWindowOffset] = useState(0);
  const [chartData, setChartData] = useState(dailyHistory);
  const [chartMeta, setChartMeta] = useState<any>({
    source: "分析日线",
    adjustment: "前复权",
    visibleLimit: 90
  });
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState("");
  const chartRequest = useRef(0);
  const [indicators, setIndicators] = useState<string[]>(["MA", "VOL"]);
  const indicatorOptions = [
    { id: "MA", label: "MA均线" },
    { id: "BOLL", label: "BOLL" },
    { id: "VOL", label: "成交量" },
    { id: "MACD", label: "MACD" },
    { id: "KDJ", label: "KDJ" },
    { id: "RSI", label: "RSI" }
  ];
  const toggleIndicator = (id: string) => {
    setIndicators((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  useEffect(() => {
    setFrame("101");
    setRange("3m");
    setWindowOffset(0);
    setChartData(dailyHistory);
  }, [security.code]);

  const selectedFrame = frames.find((item) => item.value === frame) as any;
  const selectedRange =
    selectedFrame?.ranges?.find((item: string[]) => item[0] === range) ||
    selectedFrame?.ranges?.[0];
  const visibleCount =
    density === "all"
      ? Number(chartMeta.visibleLimit || chartData.length)
      : Number(density);
  const maxWindowOffset = Math.max(0, chartData.length - visibleCount);
  const safeWindowOffset = Math.min(maxWindowOffset, Math.max(0, windowOffset));
  const visibleEndIndex = Math.max(0, chartData.length - safeWindowOffset);
  const visibleStartIndex = Math.max(0, visibleEndIndex - visibleCount);

  const chooseFrame = (nextFrame: any) => {
    setFrame(nextFrame.value);
    setRange(nextFrame.defaultRange);
    setWindowOffset(0);
    setChartError("");
  };

  const loadChart = useCallback(async (silent = false) => {
    const requestId = ++chartRequest.current;
    if (!silent) setChartLoading(true);
    setChartError("");
    try {
      const response = await window.stockApi.getChart(security, frame, {
        range,
        adjustment
      });
      const rows = Array.isArray(response) ? response : response?.rows || [];
      if (!rows.length) throw new Error("该周期暂无K线数据");
      if (requestId !== chartRequest.current) return;
      setChartData(rows);
      setChartMeta(Array.isArray(response)
        ? { source: "行情源", adjustment: adjustment === "none" ? "不复权" : "前复权", visibleLimit: rows.length }
        : response);
    } catch (reason) {
      if (requestId !== chartRequest.current) return;
      setChartData([]);
      setChartError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId === chartRequest.current) setChartLoading(false);
    }
  }, [security.code, frame, range, adjustment]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!active) return;
      await loadChart(false);
    };
    run();
    return () => {
      active = false;
    };
  }, [loadChart]);

  useEffect(() => {
    const seconds = Number(frame) < 100 ? 10 : frame === "101" ? 30 : 180;
    const timer = window.setInterval(() => {
      if (!document.hidden) loadChart(true);
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [frame, loadChart]);

  useEffect(() => {
    setWindowOffset(0);
  }, [range, density, adjustment]);

  const dataStart = chartData[visibleStartIndex]?.date || "";
  const dataEnd = chartData[Math.max(0, visibleEndIndex - 1)]?.date || "";

  return (
    <div className="panel chart-panel">
      <div className="chart-heading">
        <PanelTitle
          title="K线趋势结构"
          subtitle={`${selectedFrame?.label || frame} · ${selectedRange?.[1] || range} · ${chartMeta.adjustment || "前复权"} · ${chartMeta.source || "行情源"}`}
          icon={LineChart}
          badge={trendLabel}
        />
        <div className="timeframe-tabs">
          {frames.map((item) => (
            <button
              key={item.value}
              className={frame === item.value ? "active" : ""}
              onClick={() => chooseFrame(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className={chartLoading ? "chart-loading" : ""}>
        <div className="chart-control-row">
          <div className="range-tabs">
            <span>日期范围</span>
            {(selectedFrame?.ranges || []).map((item: [string, string]) => (
              <button
                key={item[0]}
                className={range === item[0] ? "active" : ""}
                onClick={() => setRange(item[0])}
              >
                {item[1]}
              </button>
            ))}
          </div>
          <div className="chart-density">
            <span>显示K线</span>
            {["60", "90", "120", "all"].map((item) => (
              <button
                key={item}
                className={density === item ? "active" : ""}
                onClick={() => setDensity(item)}
              >
                {item === "all" ? "范围内全部" : item}
              </button>
            ))}
          </div>
          <div className="adjustment-tabs">
            <span>复权</span>
            <button className={adjustment === "front" ? "active" : ""} onClick={() => setAdjustment("front")}>前复权</button>
            <button className={adjustment === "none" ? "active" : ""} onClick={() => setAdjustment("none")}>不复权</button>
          </div>
        </div>
        <div className="indicator-selector">
          <span className="indicator-selector-label">技术指标</span>
          {indicatorOptions.map((item) => (
            <button
              key={item.id}
              className={indicators.includes(item.id) ? "active" : ""}
              aria-pressed={indicators.includes(item.id)}
              title={`${indicators.includes(item.id) ? "隐藏" : "显示"}${item.label}`}
              onClick={() => toggleIndicator(item.id)}
            >
              {indicators.includes(item.id) && <CheckCircle2 size={15} />}
              <span>{item.label}</span>
            </button>
          ))}
          <em>{dataStart ? `${dataStart} 至 ${dataEnd}` : ""}</em>
        </div>
        {maxWindowOffset > 0 && (
          <div className="chart-window-slider">
            <span>历史窗口</span>
            <small>更早</small>
            <input
              type="range"
              min="0"
              max={maxWindowOffset}
              value={maxWindowOffset - safeWindowOffset}
              onChange={(event) =>
                setWindowOffset(maxWindowOffset - Number(event.target.value))
              }
            />
            <small>最新</small>
            <button onClick={() => setWindowOffset(0)} disabled={safeWindowOffset === 0}>
              回到最新
            </button>
          </div>
        )}
        <div className="kline-composite-chart">
          {chartError ? (
            <div className="chart-error"><CircleAlert size={18} />{chartError}<button onClick={() => loadChart(false)}>重试</button></div>
          ) : (
            <>
              <PriceChart
                history={chartData}
                eventDate={eventDate}
                support={support}
                indicators={indicators}
                visibleCount={visibleCount}
                interval={frame}
                windowOffset={safeWindowOffset}
              />
              <div className="indicator-stack">
                {["VOL", "MACD", "KDJ", "RSI"]
                  .filter((item) => indicators.includes(item))
                  .map((item) => (
                    <IndicatorChart
                      key={item}
                      type={item}
                      history={chartData}
                      visibleCount={visibleCount}
                      windowOffset={safeWindowOffset}
                    />
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
      {chartMeta.note && <div className="chart-note"><CircleAlert size={14} />{chartMeta.note}</div>}
      <div className="chart-legend">
        <span><i className="candle rise" />上涨K</span>
        <span><i className="candle fall" />下跌K</span>
        {indicators.includes("MA") && <><span><i className="line ma5" />MA5</span><span><i className="line ma10" />MA10</span><span><i className="line ma20" />MA20</span><span><i className="line ma60" />MA60</span></>}
        {indicators.includes("BOLL") && <span><i className="line boll" />BOLL(20,2)</span>}
        <span><i className="line support" />涨停日最低 {support ? fmt(support) : "--"}</span>
      </div>
    </div>
  );
}

function averageAt(data: any[], days: number, index: number, field = "close") {
  if (index + 1 < days) return Number.NaN;
  const slice = data.slice(Math.max(0, index - days + 1), index + 1);
  return slice.reduce((sum, item) => sum + Number(item[field] || 0), 0) / days;
}

function linePoints(values: number[], x: (index: number) => number, y: (value: number) => number) {
  return values
    .map((value, index) => Number.isFinite(value) ? `${x(index)},${y(value)}` : "")
    .filter(Boolean)
    .join(" ");
}

function PriceChart({
  history,
  eventDate,
  support,
  indicators = [],
  visibleCount = 120,
  interval = "101",
  windowOffset = 0
}: any) {
  const fullData = Array.isArray(history) ? history : [];
  const windowSize = Math.max(20, Number(visibleCount) || 120);
  const safeOffset = Math.min(
    Math.max(0, fullData.length - windowSize),
    Math.max(0, Number(windowOffset) || 0)
  );
  const endIndex = Math.max(0, fullData.length - safeOffset);
  const startIndex = Math.max(0, endIndex - windowSize);
  const data = fullData.slice(startIndex, endIndex);
  const width = 760;
  const height = 270;
  const pad = 22;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  if (!data.length) return <div className="empty-inline">暂无K线数据</div>;
  const fullMaValues = {
    ma5: fullData.map((_: any, i: number) => averageAt(fullData, 5, i)),
    ma10: fullData.map((_: any, i: number) => averageAt(fullData, 10, i)),
    ma20: fullData.map((_: any, i: number) => averageAt(fullData, 20, i)),
    ma60: fullData.map((_: any, i: number) => averageAt(fullData, 60, i))
  };
  const maValues = {
    ma5: fullMaValues.ma5.slice(startIndex, endIndex),
    ma10: fullMaValues.ma10.slice(startIndex, endIndex),
    ma20: fullMaValues.ma20.slice(startIndex, endIndex),
    ma60: fullMaValues.ma60.slice(startIndex, endIndex)
  };
  const fullBollMid = fullMaValues.ma20;
  const fullBollUpper = fullData.map((_: any, i: number) => {
    if (i < 19) return Number.NaN;
    const slice = fullData.slice(i - 19, i + 1);
    const mean = fullBollMid[i] ?? Number.NaN;
    const deviation = Math.sqrt(
      slice.reduce((sum: number, item: any) => sum + (item.close - mean) ** 2, 0) /
        20
    );
    return mean + deviation * 2;
  });
  const fullBollLower = fullData.map((_: any, i: number) => {
    if (i < 19) return Number.NaN;
    const slice = fullData.slice(i - 19, i + 1);
    const mean = fullBollMid[i] ?? Number.NaN;
    const deviation = Math.sqrt(
      slice.reduce((sum: number, item: any) => sum + (item.close - mean) ** 2, 0) /
        20
    );
    return mean - deviation * 2;
  });
  const bollMid = fullBollMid.slice(startIndex, endIndex);
  const bollUpper = fullBollUpper.slice(startIndex, endIndex);
  const bollLower = fullBollLower.slice(startIndex, endIndex);
  const values = [
    ...data.flatMap((item: any) => [item.high, item.low]),
    ...(indicators.includes("BOLL") ? [...bollUpper, ...bollLower] : [])
  ].filter(Number.isFinite);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const supportInScale = Number.isFinite(Number(support)) &&
    Number(support) >= rawMin * 0.85 &&
    Number(support) <= rawMax * 1.15;
  const min = Math.min(rawMin, supportInScale ? Number(support) : Infinity) * 0.997;
  const max = Math.max(rawMax, supportInScale ? Number(support) : -Infinity) * 1.003;
  const slot = (width - pad * 2) / Math.max(1, data.length);
  const candleWidth = Math.max(1.5, Math.min(7, slot * 0.62));
  const x = (i: number) => pad + slot * i + slot / 2;
  const y = (value: number) => pad + ((max - value) / Math.max(0.01, max - min)) * (height - pad * 2);
  const exactEventIndexes = data
    .map((item: any, index: number) =>
      String(item.date || "").slice(0, 10) === String(eventDate || "").slice(0, 10)
        ? index
        : -1
    )
    .filter((index: number) => index >= 0);
  let eventIndexes = exactEventIndexes;
  if (!eventIndexes.length && ["102", "103"].includes(String(interval)) && eventDate) {
    const targetTime = new Date(String(eventDate).slice(0, 10)).getTime();
    const fallbackIndex = data.findIndex(
      (item: any) => new Date(String(item.date || "").slice(0, 10)).getTime() >= targetTime
    );
    if (fallbackIndex >= 0) {
      const currentEnd = new Date(String(data[fallbackIndex].date || "").slice(0, 10)).getTime();
      const priorEnd = fallbackIndex > 0
        ? new Date(String(data[fallbackIndex - 1].date || "").slice(0, 10)).getTime()
        : currentEnd - (String(interval) === "102" ? 8 : 32) * 86400000;
      if (targetTime > priorEnd && targetTime <= currentEnd) eventIndexes = [fallbackIndex];
    }
  }
  const shortDate = (value: string) => value?.length > 10 ? value.slice(5, 16) : value;
  const selectedIndex = hoverIndex ?? data.length - 1;
  const selected = data[selectedIndex];
  const axisValues = [0, 0.25, 0.5, 0.75, 1].map((ratio) => max - (max - min) * ratio);
  const dateTickIndexes = [...new Set(
    [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
      Math.min(data.length - 1, Math.round((data.length - 1) * ratio))
    )
  )];
  const handleMove = (event: any) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.9999, (event.clientX - rect.left) / rect.width));
    setHoverIndex(Math.min(data.length - 1, Math.floor(ratio * data.length)));
  };
  return (
    <div className="chart-wrap">
      <div className="chart-ohlc-strip">
        <b>{selected?.date || "--"}</b>
        <span>开 <em>{fmt(Number(selected?.open))}</em></span>
        <span>高 <em className="red">{fmt(Number(selected?.high))}</em></span>
        <span>低 <em className="green">{fmt(Number(selected?.low))}</em></span>
        <span>收 <em>{fmt(Number(selected?.close))}</em></span>
        <span>涨跌 <em className={Number(selected?.changePct) >= 0 ? "red" : "green"}>{Number(selected?.changePct) >= 0 ? "+" : ""}{fmt(Number(selected?.changePct))}%</em></span>
        <span>量 <em>{fmtMoney(Number(selected?.volume || 0))}</em></span>
        <span>额 <em>{fmtMoney(Number(selected?.amount || 0))}</em></span>
        <span>换手 <em>{fmt(Number(selected?.turnover || 0))}%</em></span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="股票K线行情"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio, index) => (
          <g key={ratio}>
            <line
              x1={pad}
              x2={width - pad}
              y1={pad + (height - pad * 2) * ratio}
              y2={pad + (height - pad * 2) * ratio}
              className="grid-line"
            />
            <text
              x={width - pad + 2}
              y={pad + (height - pad * 2) * ratio + 4}
              className="chart-axis-text"
            >
              {fmt(axisValues[index] ?? rawMin)}
            </text>
          </g>
        ))}
        {supportInScale && <line x1={pad} x2={width - pad} y1={y(Number(support))} y2={y(Number(support))} className="support-line" />}
        {eventIndexes.length > 0 && eventIndexes[0] !== undefined && (
          <rect
            x={Math.max(pad, x(eventIndexes[0]) - slot / 2)}
            y={pad}
            width={Math.max(slot, x(eventIndexes.at(-1)!) - x(eventIndexes[0]) + slot)}
            height={height - pad * 2}
            className="event-zone"
          />
        )}
        {data.map((item: any, index: number) => {
          const rising = item.close >= item.open;
          const bodyTop = y(Math.max(item.open, item.close));
          const bodyBottom = y(Math.min(item.open, item.close));
          return (
            <g key={`${item.date}-${index}`} className={rising ? "k-rise" : "k-fall"}>
              <line x1={x(index)} x2={x(index)} y1={y(item.high)} y2={y(item.low)} className="wick" />
              <rect
                x={x(index) - candleWidth / 2}
                y={bodyTop}
                width={candleWidth}
                height={Math.max(1.2, bodyBottom - bodyTop)}
                className="candle-body"
              />
            </g>
          );
        })}
        {indicators.includes("BOLL") && (
          <>
            <polyline points={linePoints(bollUpper, x, y)} className="path boll-upper-path" />
            <polyline points={linePoints(bollMid, x, y)} className="path boll-mid-path" />
            <polyline points={linePoints(bollLower, x, y)} className="path boll-lower-path" />
          </>
        )}
        {indicators.includes("MA") && (
          <>
            <polyline points={linePoints(maValues.ma60, x, y)} className="path ma60-path" />
            <polyline points={linePoints(maValues.ma20, x, y)} className="path ma20-path" />
            <polyline points={linePoints(maValues.ma10, x, y)} className="path ma10-path" />
            <polyline points={linePoints(maValues.ma5, x, y)} className="path ma5-path" />
          </>
        )}
        {hoverIndex !== null && selected && (
          <>
            <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={pad} y2={height - pad} className="chart-crosshair" />
            <line x1={pad} x2={width - pad} y1={y(Number(selected.close))} y2={y(Number(selected.close))} className="chart-crosshair" />
            <circle cx={x(selectedIndex)} cy={y(Number(selected.close))} r="3" className="chart-crosshair-dot" />
          </>
        )}
      </svg>
      {!supportInScale && Number.isFinite(Number(support)) && (
        <div className={`support-offscale ${Number(support) < rawMin ? "below" : "above"}`}>
          涨停支撑 {fmt(Number(support))} {Number(support) < rawMin ? "↓" : "↑"}
        </div>
      )}
      <div className="chart-labels">
        {dateTickIndexes.map((index) => <span key={index}>{shortDate(data[index]?.date)}</span>)}
      </div>
    </div>
  );
}

function ema(values: number[], period: number) {
  const multiplier = 2 / (period + 1);
  return values.map((value, index, result) =>
    index === 0 ? value : value * multiplier + (result[index - 1] ?? value) * (1 - multiplier)
  );
}

function rsiValues(data: any[], period: number) {
  return data.map((_: any, index: number) => {
    const start = Math.max(1, index - period + 1);
    let gain = 0;
    let loss = 0;
    for (let i = start; i <= index; i += 1) {
      const change = data[i].close - data[i - 1].close;
      if (change >= 0) gain += change;
      else loss -= change;
    }
    const count = Math.max(1, index - start + 1);
    const avgGain = gain / count;
    const avgLoss = loss / count;
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  });
}

function kdjValues(data: any[]) {
  let k = 50;
  let d = 50;
  const result = { k: [] as number[], d: [] as number[], j: [] as number[] };
  data.forEach((item: any, index: number) => {
    const slice = data.slice(Math.max(0, index - 8), index + 1);
    const low = Math.min(...slice.map((row: any) => row.low));
    const high = Math.max(...slice.map((row: any) => row.high));
    const rsv = high === low ? 50 : ((item.close - low) / (high - low)) * 100;
    k = (2 * k + rsv) / 3;
    d = (2 * d + k) / 3;
    result.k.push(k);
    result.d.push(d);
    result.j.push(3 * k - 2 * d);
  });
  return result;
}

function IndicatorChart({
  type,
  history,
  visibleCount = 120,
  windowOffset = 0
}: {
  type: string;
  history: any[];
  visibleCount?: number;
  windowOffset?: number;
}) {
  const fullData = Array.isArray(history) ? history : [];
  const windowSize = Math.max(20, Number(visibleCount) || 120);
  const safeOffset = Math.min(
    Math.max(0, fullData.length - windowSize),
    Math.max(0, Number(windowOffset) || 0)
  );
  const endIndex = Math.max(0, fullData.length - safeOffset);
  const startIndex = Math.max(0, endIndex - windowSize);
  const data = fullData.slice(startIndex, endIndex);
  if (data.length < 2) return null;
  const width = 760;
  const height = 105;
  const pad = 12;
  const slot = (width - pad * 2) / data.length;
  const x = (index: number) => pad + slot * index + slot / 2;
  let series: Array<{ name: string; values: number[]; className: string }> = [];
  let bars: number[] = [];
  let fixedRange: [number, number] | null = null;

  if (type === "VOL") {
    bars = data.map((item: any) => Number(item.volume || 0));
    series = [
      {
        name: "VOL MA5",
        values: fullData
          .map((_: any, i: number) => averageAt(fullData, 5, i, "volume"))
          .slice(startIndex, endIndex),
        className: "indicator-yellow"
      },
      {
        name: "VOL MA10",
        values: fullData
          .map((_: any, i: number) => averageAt(fullData, 10, i, "volume"))
          .slice(startIndex, endIndex),
        className: "indicator-blue"
      }
    ];
  } else if (type === "MACD") {
    const closes = fullData.map((item: any) => item.close);
    const fast = ema(closes, 12);
    const slow = ema(closes, 26);
    const dif = fast.map((value, index) => value - (slow[index] ?? value));
    const dea = ema(dif, 9);
    bars = dif.map((value, index) => (value - (dea[index] ?? value)) * 2).slice(startIndex, endIndex);
    series = [
      { name: "DIF", values: dif.slice(startIndex, endIndex), className: "indicator-yellow" },
      { name: "DEA", values: dea.slice(startIndex, endIndex), className: "indicator-blue" }
    ];
  } else if (type === "KDJ") {
    const kdj = kdjValues(fullData);
    const visibleJ = kdj.j.slice(startIndex, endIndex);
    fixedRange = [
      Math.min(-20, ...visibleJ.filter(Number.isFinite)),
      Math.max(120, ...visibleJ.filter(Number.isFinite))
    ];
    series = [
      { name: "K", values: kdj.k.slice(startIndex, endIndex), className: "indicator-yellow" },
      { name: "D", values: kdj.d.slice(startIndex, endIndex), className: "indicator-blue" },
      { name: "J", values: visibleJ, className: "indicator-purple" }
    ];
  } else {
    fixedRange = [0, 100];
    series = [
      { name: "RSI6", values: rsiValues(fullData, 6).slice(startIndex, endIndex), className: "indicator-yellow" },
      { name: "RSI12", values: rsiValues(fullData, 12).slice(startIndex, endIndex), className: "indicator-blue" },
      { name: "RSI24", values: rsiValues(fullData, 24).slice(startIndex, endIndex), className: "indicator-purple" }
    ];
  }

  const allValues = [...bars, ...series.flatMap((item) => item.values)].filter(Number.isFinite);
  const rawMin = fixedRange?.[0] ?? Math.min(0, ...allValues);
  const rawMax = fixedRange?.[1] ?? Math.max(1, ...allValues);
  const range = Math.max(0.0001, rawMax - rawMin);
  const y = (value: number) => pad + ((rawMax - value) / range) * (height - pad * 2);
  const zeroY = y(Math.max(rawMin, Math.min(rawMax, 0)));
  const last = (values: number[]) => values.at(-1);

  return (
    <div className="indicator-chart">
      <div className="indicator-chart-head">
        <b>{type}</b>
        {series.map((item) => <span className={item.className} key={item.name}>{item.name} {fmt(last(item.values) || 0)}</span>)}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1={pad} x2={width - pad} y1={zeroY} y2={zeroY} className="indicator-zero" />
        {(type === "KDJ" ? [20, 80] : type === "RSI" ? [20, 50, 80] : [])
          .filter((value) => value >= rawMin && value <= rawMax)
          .map((value) => (
            <line
              key={`${type}-reference-${value}`}
              x1={pad}
              x2={width - pad}
              y1={y(value)}
              y2={y(value)}
              className="indicator-reference"
            />
          ))}
        {bars.map((value, index) => {
          const top = Math.min(y(value), zeroY);
          return (
            <rect
              key={`${type}-${index}`}
              x={x(index) - Math.max(1, slot * 0.28)}
              y={top}
              width={Math.max(1.2, slot * 0.56)}
              height={Math.max(1, Math.abs(y(value) - zeroY))}
              className={type === "VOL"
                ? data[index].close >= data[index].open ? "indicator-bar up" : "indicator-bar down"
                : value >= 0 ? "indicator-bar up" : "indicator-bar down"}
            />
          );
        })}
        {series.map((item) => (
          <polyline key={item.name} points={linePoints(item.values, x, y)} className={`indicator-line ${item.className}`} />
        ))}
      </svg>
    </div>
  );
}

function Timeline({ daysSince }: { daysSince: number | null }) {
  const nodes = [0, 3, 5, 7, 9];
  return (
    <div className="timeline">
      <div className="timeline-track" />
      {nodes.map((node) => {
        const current = daysSince === node;
        const passed = daysSince !== null && daysSince > node;
        return (
          <div className={`timeline-node ${current ? "current" : ""} ${passed ? "passed" : ""}`} key={node}>
            <span>{passed ? "✓" : node === 0 ? "T" : node}</span>
            <b>{node === 0 ? "涨停日" : `T+${node}`}</b>
            {current && <small>当前</small>}
          </div>
        );
      })}
    </div>
  );
}

function BacktestView({
  draft,
  loading,
  error,
  result,
  history,
  profileComparisons,
  onDraftChange,
  onRun,
  onRunProfileComparisons,
  onApplyProfileComparison,
  onLoadHistory,
  onExportHistory,
  onExportCurrent,
  onApplyCurrent,
  onApplyHistory,
  onClearHistory,
  onBack,
  backLabel,
  entryContext,
  onTargetChange,
  currentSettings,
  executionProfile,
  profileDiff,
  evaluateBacktestExecutionReadiness,
  buildBacktestExecutionPlan,
  onOpenPortfolio
}: {
  draft: BacktestDraft;
  loading: boolean;
  error: string;
  result: any;
  history: BacktestHistoryRecord[];
  profileComparisons: BacktestProfileComparisonReport | null;
  onDraftChange: (updater: (current: BacktestDraft) => BacktestDraft) => void;
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
    metrics: Record<string, any> | null,
    profileDiffs: Array<{ label: string; sourceValue: string; targetValue: string }>,
    executionReadinessInput?: any
  ) => BacktestExecutionReadiness;
  buildBacktestExecutionPlan: (
    metrics: Record<string, any> | null,
    readiness: BacktestExecutionReadiness,
    profile: BacktestStrategyProfile
  ) => BacktestExecutionPlan;
  onOpenPortfolio: () => void;
}) {
  const metrics = result?.metrics && typeof result.metrics === "object" ? result.metrics : null;
  const walkForwardValidation = result?.walkForwardValidation && typeof result.walkForwardValidation === "object"
    ? result.walkForwardValidation
    : null;
  const strategyIds = Array.isArray(result?.strategyIds) ? result.strategyIds : [];
  const benchmark = result?.benchmarkReturns && typeof result.benchmarkReturns === "object" ? result.benchmarkReturns : null;
  const historicalSamplePath = result?.historicalSamplePath && typeof result.historicalSamplePath === "object"
    ? result.historicalSamplePath
    : null;
  const historicalSamplePoints = Array.isArray(historicalSamplePath?.points)
    ? historicalSamplePath.points
    : [];
  const tradeLedger = Array.isArray(result?.trades) ? result.trades : [];
  const profitSummary = result?.profitSummary && typeof result.profitSummary === "object"
    ? result.profitSummary
    : null;
  const strategyBreakdown = Array.isArray(result?.strategyBreakdown)
    ? result.strategyBreakdown
    : [];
  const backtestRange = result?.range && typeof result.range === "object"
    ? result.range
    : null;
  const contextStrategyIds = normalizeBacktestStrategyIds(
    draft.strategyContext?.strategyIds || entryContext?.strategyIds
  );
  const contextProfile = contextStrategyIds.length
    ? normalizeBacktestStrategyProfile(
      { selectedStrategies: contextStrategyIds },
      currentSettings,
      draft,
      contextStrategyIds
    )
    : executionProfile;
  const resultProfile = result?.strategyProfile
    ? normalizeBacktestStrategyProfile(
      result.strategyProfile,
      currentSettings,
      draft,
      normalizeBacktestStrategyIds(result.strategyIds || executionProfile.selectedStrategies)
    )
    : contextProfile;
  const profileDiffs = result ? profileDiff(resultProfile) : [];
  const executionReadiness = evaluateBacktestExecutionReadiness(
    metrics,
    profileDiffs,
    result?.tradeExecutionReadiness || result?.executionReadiness
  );
  const executionPlan = buildBacktestExecutionPlan(metrics, executionReadiness, resultProfile);
  const isVerifiedStrategyBacktest =
    result?.strategyEngine === "verified-signal-v2" ||
    draft.strategyContext?.strategyEngine === "verified-signal-v2";
  const canApplyCurrent =
    Boolean(result) &&
    executionReadiness.level !== "block" &&
    !isVerifiedStrategyBacktest;
  const comparisonRunning = Boolean(profileComparisons?.items.some((item) => item.loading));
  const readinessPriority = (level?: BacktestExecutionReadiness["level"]) =>
    level === "pass" ? 3 : level === "wait" ? 2 : level === "block" ? 1 : 0;
  const comparisonRows = [...(profileComparisons?.items || [])]
    .map((item) => {
      const recordMetrics = item.record?.metrics && typeof item.record.metrics === "object"
        ? item.record.metrics
        : null;
      const readiness = item.record
        ? evaluateBacktestExecutionReadiness(
          recordMetrics,
          profileDiff(item.record.strategyProfile),
          item.record.rawResult?.tradeExecutionReadiness || item.record.rawResult?.executionReadiness
        )
        : null;
      const projectedNetEdge = Number(recordMetrics?.projectedNetEdge);
      return {
        ...item,
        readiness,
        projectedNetEdge: Number.isFinite(projectedNetEdge) ? projectedNetEdge : Number.NEGATIVE_INFINITY
      };
    })
    .sort((left, right) => {
      if (left.loading !== right.loading) return left.loading ? 1 : -1;
      const readinessDiff =
        readinessPriority(right.readiness?.level) -
        readinessPriority(left.readiness?.level);
      if (readinessDiff) return readinessDiff;
      if (Boolean(left.record?.accepted) !== Boolean(right.record?.accepted)) {
        return left.record?.accepted ? -1 : 1;
      }
      return right.projectedNetEdge - left.projectedNetEdge;
    });
  const contextSecurity =
    entryContext?.security?.code === draft.securityCode
      ? entryContext.security
      : null;
  const resultSecurity =
    result?.security?.code === draft.securityCode
      ? result.security as Security
      : null;
  const initialSecurity = resultSecurity || contextSecurity;
  const formatSecurityInput = (security?: Security | null, fallbackCode = "") =>
    security?.code
      ? `${security.name && security.name !== security.code ? `${security.name} · ` : ""}${security.code}`
      : fallbackCode;
  const [securityInput, setSecurityInput] = useState(() =>
    formatSecurityInput(initialSecurity, draft.securityCode)
  );
  const [selectedSecurity, setSelectedSecurity] = useState<Security | null>(initialSecurity || null);
  const [securitySuggestions, setSecuritySuggestions] = useState<Security[]>([]);
  const [securitySearching, setSecuritySearching] = useState(false);
  const [securitySuggestionOpen, setSecuritySuggestionOpen] = useState(false);
  const [securityInputError, setSecurityInputError] = useState("");
  const [resolvingSecurity, setResolvingSecurity] = useState(false);
  const [verifiedStrategies, setVerifiedStrategies] = useState<any[]>([]);
  const [strategyDefinitionError, setStrategyDefinitionError] = useState("");

  useEffect(() => {
    let active = true;
    window.stockApi.getStrategyDefinitions()
      .then((value) => {
        if (!active) return;
        const rows = Array.isArray(value)
          ? value
          : Array.isArray(value?.strategies)
            ? value.strategies
            : Array.isArray(value?.definitions)
              ? value.definitions
              : [];
        const definitions = rows.filter((item: any) => item?.id && item?.name);
        setVerifiedStrategies(definitions);
        setStrategyDefinitionError(definitions.length ? "" : "未取得可回放策略定义");
        if (!draft.strategyContext && definitions[0]) {
          const first = definitions[0];
          onDraftChange((current) => ({
            ...current,
            strategyContext: {
              source: "single_strategy",
              strategyEngine: "verified-signal-v2",
              strategyId: String(first.id),
              strategyName: String(first.name),
              strategyVersion: "robust-v2",
              strategyIds: [String(first.id)],
              minimumVotes: 1
            }
          }));
        }
      })
      .catch((error) => {
        if (active) setStrategyDefinitionError(error instanceof Error ? error.message : "策略定义加载失败");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const nextSecurity = resultSecurity || contextSecurity;
    setSelectedSecurity(nextSecurity || null);
    setSecurityInput(formatSecurityInput(nextSecurity, draft.securityCode));
    setSecuritySuggestions([]);
    setSecuritySuggestionOpen(false);
    setSecurityInputError("");
  }, [
    draft.securityCode,
    contextSecurity?.code,
    contextSecurity?.name,
    resultSecurity?.code,
    resultSecurity?.name
  ]);

  useEffect(() => {
    const keyword = securityInput.trim();
    const selectedText = formatSecurityInput(selectedSecurity, selectedSecurity?.code || "");
    if (keyword.length < 2 || (selectedSecurity && keyword === selectedText)) {
      setSecuritySuggestions([]);
      setSecuritySearching(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(async () => {
      setSecuritySearching(true);
      try {
        const rows = await window.stockApi.search(keyword);
        if (!active) return;
        setSecuritySuggestions(
          (Array.isArray(rows) ? rows : [])
            .filter((item) => /^\d{6}$/.test(String(item?.code || "")))
            .filter((item) => !item.assetType || item.assetType === "stock")
            .slice(0, 8)
        );
        setSecuritySuggestionOpen(true);
      } catch {
        if (active) setSecuritySuggestions([]);
      } finally {
        if (active) setSecuritySearching(false);
      }
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [securityInput, selectedSecurity?.code, selectedSecurity?.name]);

  const chooseSecurity = (security: Security, sourceLabel = "回测中心搜索") => {
    const normalized: Security = {
      ...security,
      code: String(security.code || ""),
      name: String(security.name || security.code || ""),
      secid: String(security.secid || "")
    };
    setSelectedSecurity(normalized);
    setSecurityInput(formatSecurityInput(normalized, normalized.code));
    setSecuritySuggestions([]);
    setSecuritySuggestionOpen(false);
    setSecurityInputError("");
    onDraftChange((current) => ({
      ...current,
      securityCode: normalized.code,
      security: normalized
    }));
    onTargetChange(normalized, sourceLabel);
    return normalized;
  };

  const resolveSecurityInput = async () => {
    const keyword = securityInput.trim();
    if (!keyword) {
      setSecurityInputError("请输入股票名称或6位代码");
      return null;
    }
    const selectedText = formatSecurityInput(selectedSecurity, selectedSecurity?.code || "");
    if (selectedSecurity && keyword === selectedText) return selectedSecurity;
    const embeddedCode = keyword.match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1] || "";
    let candidates = securitySuggestions;
    try {
      if (!candidates.length || embeddedCode) {
        const rows = await window.stockApi.search(embeddedCode || keyword);
        candidates = (Array.isArray(rows) ? rows : [])
          .filter((item) => /^\d{6}$/.test(String(item?.code || "")))
          .filter((item) => !item.assetType || item.assetType === "stock");
      }
    } catch {
      candidates = [];
    }
    const exact = candidates.find((item) => item.code === embeddedCode) ||
      candidates.find((item) => item.name === keyword) ||
      (candidates.length === 1 ? candidates[0] : null);
    if (exact) return chooseSecurity(exact);
    if (embeddedCode) {
      return chooseSecurity({ code: embeddedCode, name: embeddedCode, secid: "" }, "回测中心代码输入");
    }
    setSecuritySuggestions(candidates.slice(0, 8));
    setSecuritySuggestionOpen(Boolean(candidates.length));
    setSecurityInputError(
      candidates.length
        ? "找到多只股票，请从候选列表选择"
        : "未找到对应A股，请检查名称或代码"
    );
    return null;
  };

  const runWithResolvedSecurity = async (runner: (next: BacktestDraft) => void) => {
    if (resolvingSecurity || loading || comparisonRunning) return;
    setResolvingSecurity(true);
    try {
      const security = await resolveSecurityInput();
      if (!security) return;
      let strategyContext = draft.strategyContext;
      if (!strategyContext) {
        const definition = verifiedStrategies[0];
        if (!definition) {
          setSecurityInputError(strategyDefinitionError || "请先选择一套策略");
          return;
        }
        strategyContext = {
          source: "single_strategy",
          strategyEngine: "verified-signal-v2",
          strategyId: String(definition.id),
          strategyName: String(definition.name),
          strategyVersion: "robust-v2",
          strategyIds: [String(definition.id)],
          minimumVotes: 1
        };
      }
      const next = {
        ...draft,
        securityCode: security.code,
        security,
        strategyContext
      };
      onDraftChange(() => next);
      runner(next);
    } finally {
      setResolvingSecurity(false);
    }
  };

  const effectiveStrategyIds = normalizeBacktestStrategyIds(
    strategyIds.length
      ? strategyIds
      : contextStrategyIds.length
        ? contextStrategyIds
        : executionProfile.selectedStrategies
  );
  const strategyNameById = new Map(strategyOptions.map((item) => [item.id, item.name]));
  const verifiedStrategyNameById = new Map(
    verifiedStrategies.map((item) => [String(item.id), String(item.name)])
  );
  const selectedVerifiedStrategyIds = normalizeBacktestStrategyIds(
    draft.strategyContext?.strategyIds
  );
  const updateVerifiedStrategySelection = (
    strategyIds: string[],
    requestedMinimumVotes?: number
  ) => {
    const allowedIds = new Set(verifiedStrategies.map((item) => String(item.id)));
    const nextIds = normalizeBacktestStrategyIds(strategyIds).filter((id) => allowedIds.has(id));
    if (!nextIds.length) return;
    const names = nextIds.map((id) => verifiedStrategyNameById.get(id) || id);
    const minimumVotes = clampNumber(
      requestedMinimumVotes ?? draft.strategyContext?.minimumVotes,
      1,
      nextIds.length,
      1
    );
    onDraftChange((current) => ({
      ...current,
      strategyContext: {
        source: "single_strategy",
        strategyEngine: "verified-signal-v2",
        strategyId: nextIds.length > 1 ? "custom_strategy_vote" : String(nextIds[0]),
        strategyName: nextIds.length > 1 ? `多策略组合（${nextIds.length}套）` : String(names[0]),
        strategyVersion: "robust-v2",
        strategyIds: nextIds,
        minimumVotes
      }
    }));
  };
  const toggleVerifiedStrategy = (strategyId: string) => {
    const selected = new Set(selectedVerifiedStrategyIds);
    if (selected.has(strategyId)) {
      if (selected.size === 1) return;
      selected.delete(strategyId);
    } else {
      selected.add(strategyId);
    }
    updateVerifiedStrategySelection([...selected]);
  };
  const setMinimumStrategyVotes = (value: number) => {
    updateVerifiedStrategySelection(selectedVerifiedStrategyIds, value);
  };
  const verifiedComponentNames: string[] = Array.isArray(result?.strategyContext?.componentNames)
    ? result.strategyContext.componentNames.map(String).filter(Boolean)
    : [];
  const effectiveStrategyNames = isVerifiedStrategyBacktest
    ? verifiedComponentNames.length
      ? verifiedComponentNames
      : effectiveStrategyIds.length === 1 && draft.strategyContext?.strategyName
        ? [draft.strategyContext.strategyName]
        : effectiveStrategyIds.map((id) => verifiedStrategyNameById.get(id) || id)
    : effectiveStrategyIds.map((id) => strategyNameById.get(id) || id);
  const displayedSecurity = selectedSecurity || resultSecurity || contextSecurity;
  const format = (value: unknown, digits = 2) => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "--";
  };

  const setNumber = (key: keyof BacktestDraft, value: number) => {
    if (!Number.isFinite(value)) return;
    onDraftChange((current) => ({ ...current, [key]: value }));
  };
  const canExport = Boolean(result);

  return (
    <>
      <PageHeading
        eyebrow="HISTORY BACKTEST"
        title="策略单股回测"
        description="选择一套或多套策略、一只股票和起始日期，逐笔回放历史买卖，并直接对比各策略与组合收益。"
        actions={
          <div className="backtest-heading-actions">
            <button className="secondary-btn" onClick={onBack}>
              <ChevronLeft size={17} />
              {backLabel}
            </button>
            <button className="secondary-btn" onClick={onOpenPortfolio}>
              <BarChart3 size={17} />
              多股组合回测
            </button>
            <button
              className="primary-btn"
              disabled={loading || comparisonRunning || resolvingSecurity}
              onClick={() => runWithResolvedSecurity(onRun)}
            >
              {loading || resolvingSecurity ? <LoaderCircle className="spin" size={17} /> : <LineChart size={17} />}
              {resolvingSecurity ? "确认股票" : "从所选日期开始回测"}
            </button>
            <button className="secondary-btn" disabled={!canExport} onClick={() => onExportCurrent("csv")}>
              <Download size={17} />
              导出CSV
            </button>
            <button className="secondary-btn" disabled={!canExport} onClick={() => onExportCurrent("json")}>
              <Download size={17} />
              导出JSON
            </button>
            <button
              className="secondary-btn"
              disabled={!canApplyCurrent}
              title={
                isVerifiedStrategyBacktest
                  ? "策略信号规则与设置页执行因子属于不同口径，不会写入全局执行设置"
                  : executionReadiness.level === "block"
                  ? executionReadiness.recommendation
                  : executionReadiness.level === "wait"
                    ? "建议先执行纸面验证后再应用"
                    : "应用当前回测的参数快照到执行设置"
              }
              onClick={() => onApplyCurrent()}
            >
              <Target size={17} />
              {isVerifiedStrategyBacktest
                ? "策略规则仅本次使用"
                : executionReadiness.level === "wait"
                  ? "应用到执行（需确认）"
                  : "应用到执行策略"}
            </button>
          </div>
        }
      />
      <section className="panel backtest-context-panel">
        <div className="backtest-context-head">
          <div>
            <Target size={18} />
            <span><b>本次回放上下文</b><small>先确认股票和策略口径，再解释回测结果</small></span>
          </div>
          <em>{entryContext?.sourceLabel || "回测中心手工选择"}</em>
        </div>
        <div className="backtest-context-grid">
          <div>
            <span>回测对象</span>
            <b>{displayedSecurity?.name || "待选择股票"}</b>
            <small>{displayedSecurity?.code || "支持股票名称 / 6位代码"}</small>
          </div>
          <div>
            <span>实际策略快照</span>
            <b>
              {isVerifiedStrategyBacktest
                ? draft.strategyContext?.strategyName || result?.strategyContext?.strategyName || "已验证策略"
                : `${effectiveStrategyIds.length} 个执行因子`}
            </b>
            <small>
              {isVerifiedStrategyBacktest
                ? `${effectiveStrategyIds.length} 套冻结规则 · 至少 ${result?.minimumVotes || draft.strategyContext?.minimumVotes || 1} 票`
                : `${riskProfileLabel(resultProfile.riskProfile)} · 风险否决始终启用`}
            </small>
          </div>
          <div>
            <span>验证对象</span>
            <b>单只股票历史事件</b>
            <small>不是全市场横截面策略排名</small>
          </div>
          <div>
            <span>回测区间</span>
            <b>{draft.startDate} 至最新交易日</b>
            <small>起始日前数据只用于指标预热，不计入收益</small>
          </div>
        </div>
        <div className="backtest-context-strategies">
          <span>参与回放</span>
          <div>
            {effectiveStrategyNames.slice(0, 9).map((name) => <em key={name}>{name}</em>)}
            {effectiveStrategyNames.length > 9 && <em>+{effectiveStrategyNames.length - 9}</em>}
            {!effectiveStrategyNames.length && <em className="missing">尚未配置执行因子</em>}
          </div>
        </div>
        <p className="backtest-context-note">
          {isVerifiedStrategyBacktest
            ? `当前回放严格复用策略信号引擎 robust-v2 的 ${effectiveStrategyIds.length} 套已选规则；同日达到至少 ${draft.strategyContext?.minimumVotes || 1} 票才形成组合信号。默认次日开盘入场；填写自定义买入价后，仅在次日价格区间触达时成交。固定持有五日并扣除佣金/滑点，不会污染全局设置。`
            : "当前回放使用设置页保存的执行因子组合与成本参数：普通因子按组合门槛判定，风险否决必须通过。若要比较不同策略谁更优，应使用策略信号页的全市场样本外验证，而不是用单只股票结果代替。"}
        </p>
      </section>
      <div className="backtest-layout">
        <section className="panel backtest-setup-panel">
          <PanelTitle title="回测条件" subtitle="多选策略后设置共振门槛，再选择股票、日期和买入方式" icon={LineChart} />
          <div className="backtest-form-grid" data-single-stock-backtest>
            <div className="field backtest-primary-field backtest-strategy-picker" data-backtest-strategy-picker>
              <div className="backtest-strategy-picker-head">
                <span>1. 回测策略 <b>已选 {selectedVerifiedStrategyIds.length} 套</b></span>
                <div>
                  <button
                    type="button"
                    onClick={() => updateVerifiedStrategySelection(
                      verifiedStrategies.map((item) => String(item.id)),
                      draft.strategyContext?.minimumVotes || 1
                    )}
                    disabled={!verifiedStrategies.length || selectedVerifiedStrategyIds.length === verifiedStrategies.length}
                  >全选</button>
                  <button
                    type="button"
                    onClick={() => updateVerifiedStrategySelection([
                      selectedVerifiedStrategyIds[0] || String(verifiedStrategies[0]?.id || "")
                    ], 1)}
                    disabled={selectedVerifiedStrategyIds.length <= 1}
                  >仅保留一套</button>
                </div>
              </div>
              <div className="backtest-strategy-options">
                {verifiedStrategies.map((item) => {
                  const strategyId = String(item.id);
                  const checked = selectedVerifiedStrategyIds.includes(strategyId);
                  return (
                    <label key={strategyId} className={checked ? "selected" : ""}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={checked && selectedVerifiedStrategyIds.length === 1}
                        data-strategy-id={strategyId}
                        onChange={() => toggleVerifiedStrategy(strategyId)}
                      />
                      <span><b>{String(item.name)}</b><small>{String(item.detail || "同策略中心冻结规则")}</small></span>
                    </label>
                  );
                })}
              </div>
              <div className="backtest-vote-control">
                <span>同一交易日最少命中</span>
                <input
                  type="number"
                  min="1"
                  max={Math.max(1, selectedVerifiedStrategyIds.length)}
                  value={draft.strategyContext?.minimumVotes || 1}
                  data-backtest-minimum-votes
                  onChange={(event) => setMinimumStrategyVotes(Number(event.target.value))}
                />
                <b>/ {selectedVerifiedStrategyIds.length || 1} 套</b>
                <small>设为1表示任一已选策略命中即可买入；提高票数表示只测同日共振。</small>
              </div>
              {strategyDefinitionError && <small className="field-error">{strategyDefinitionError}</small>}
            </div>
            <label className="field backtest-security-field">
              <span>2. 回测股票 <b>{displayedSecurity?.code || draft.securityCode || "未选择"}</b></span>
              <div className={`backtest-security-search ${securityInputError ? "invalid" : ""}`}>
                <Search size={16} />
                <input
                  type="text"
                  maxLength={40}
                  autoComplete="off"
                  value={securityInput}
                  onFocus={() => setSecuritySuggestionOpen(Boolean(securitySuggestions.length))}
                  onChange={(event) => {
                    setSecurityInput(event.target.value);
                    setSelectedSecurity(null);
                    setSecurityInputError("");
                    setSecuritySuggestionOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      runWithResolvedSecurity(onRun);
                    }
                  }}
                  placeholder="输入股票名称或6位代码，例如 贵州茅台 / 600519"
                />
                {securitySearching && <LoaderCircle className="spin" size={15} />}
                {securitySuggestionOpen && securitySuggestions.length > 0 && (
                  <div className="backtest-security-suggestions">
                    {securitySuggestions.map((item) => (
                      <button type="button" key={`${item.code}-${item.secid}`} onClick={() => chooseSecurity(item)}>
                        <span><b>{item.name}</b><small>{item.code}</small></span>
                        <em>{item.marketName || item.thscode?.split(".")[1] || "A股"}</em>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <small className={securityInputError ? "field-error" : ""}>
                {securityInputError || (entryContext?.security?.code === draft.securityCode
                  ? `已沿用${entryContext.sourceLabel}选择的股票，可直接运行`
                  : "支持中文名称、简称或6位代码；名称有重名时请从候选中选择")}
              </small>
            </label>
            <label className="field backtest-primary-field">
              <span>3. 开始日期 <b>{draft.startDate}</b></span>
              <input
                type="date"
                min="2010-01-01"
                max={todayTag()}
                value={draft.startDate}
                data-backtest-start-date
                onChange={(event) => onDraftChange((current) => ({
                  ...current,
                  startDate: event.target.value
                }))}
              />
              <small>只统计该日期及之后产生的策略信号；系统会自动多取预热行情</small>
            </label>
            <label className="field backtest-primary-field">
              <span>4. 自定义买入价 <b>{draft.customEntryPrice ? `${draft.customEntryPrice} 元` : "按次日开盘"}</b></span>
              <input
                type="number"
                min="0.001"
                max="1000000"
                step="0.01"
                inputMode="decimal"
                value={draft.customEntryPrice ?? ""}
                data-backtest-custom-entry-price
                placeholder="留空则按历史次日开盘价"
                onChange={(event) => onDraftChange((current) => ({
                  ...current,
                  customEntryPrice: event.target.value === "" ? null : Number(event.target.value)
                }))}
              />
              <small>填写后按限价成交：下一交易日价格区间触达才买入，未触达不计收益</small>
            </label>
            <details className="backtest-advanced-options">
              <summary>高级参数（成本、基准和准入条件）</summary>
              <div className="backtest-form-grid">
              <label className="field">
              <span>取值标尺（最近几次基准） <b>{draft.benchmarks}</b></span>
              <input
                type="number"
                min="1"
                max="10"
                value={draft.benchmarks}
                onChange={(event) => setNumber("benchmarks", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>基准指数 <b>{draft.benchmark}</b></span>
              <select
                value={draft.benchmark}
                onChange={(event) => onDraftChange((current) => ({
                  ...current,
                  benchmark: event.target.value as BacktestBenchmark
                }))}
                className="backtest-select"
              >
                <option value="all">中证全指</option>
                <option value="szzs">上证指数</option>
                <option value="hs300">沪深300</option>
              </select>
            </label>
            <label className="field">
              <span>最小样本数 <b>{draft.minSamples}</b></span>
              <input
                type="number"
                min="1"
                max="300"
                value={draft.minSamples}
                onChange={(event) => setNumber("minSamples", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>最小预期净收益% <b>{draft.minProjectedNetEdgePercent}</b></span>
              <input
                type="number"
                min="-2"
                max="10"
                step="0.05"
                value={draft.minProjectedNetEdgePercent}
                onChange={(event) => setNumber("minProjectedNetEdgePercent", Number(event.target.value))}
              />
            </label>
          <label className="field">
            <span>最小期望值 <b>{draft.minExpectancyPoints}</b></span>
            <input
              type="number"
                min="-2"
                max="8"
                step="0.05"
                value={draft.minExpectancyPoints}
              onChange={(event) => setNumber("minExpectancyPoints", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>最小成交额(元) <b>{draft.minQuoteAmount}</b></span>
            <input
              type="number"
              min="0"
              max="8000000"
              step="100000"
              value={draft.minQuoteAmount}
              onChange={(event) => setNumber("minQuoteAmount", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>最小换手率(%) <b>{draft.minTurnoverPercent}</b></span>
            <input
              type="number"
              min="0"
              max="10"
              step="0.05"
              value={draft.minTurnoverPercent}
              onChange={(event) => setNumber("minTurnoverPercent", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>行情新鲜度上限(秒) <b>{draft.maxQuoteAgeSeconds}</b></span>
            <input
              type="number"
              min="30"
              max="1800"
              step="15"
              value={draft.maxQuoteAgeSeconds}
              onChange={(event) => setNumber("maxQuoteAgeSeconds", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>佣金 BPS <b>{draft.commissionBps}</b></span>
            <input
                type="number"
                min="0"
                max="60"
                step="0.1"
                value={draft.commissionBps}
                onChange={(event) => setNumber("commissionBps", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>滑点 BPS <b>{draft.slippageBps}</b></span>
              <input
                type="number"
                min="0"
                max="60"
                step="0.1"
                value={draft.slippageBps}
                onChange={(event) => setNumber("slippageBps", Number(event.target.value))}
              />
            </label>
              </div>
            </details>
          </div>
        </section>

        <section className="panel backtest-result-panel">
          <PanelTitle
            title="回测结果"
            subtitle={result
              ? `标的 ${result.security?.name || draft.securityCode || "--"}`
              : "运行后展示样本与收益判断"}
            icon={LineChart}
            badge={result?.metrics?.accepted ? "预检通过" : result ? "预检未通过" : "等待运行"}
          />
          {error && <ErrorState message={error} />}
          {!result && !error && (
            <div className="backtest-empty-result" data-backtest-empty-result>
              <div className="backtest-empty-result-title">
                <LineChart size={22} />
                <div>
                  <b>等待生成单股回测结果</b>
                  <small>按左侧条件运行后，这里会先展示收益，再展示逐笔交易和策略拆分。</small>
                </div>
              </div>
              <ol>
                <li><span>策略</span><b>已选 {selectedVerifiedStrategyIds.length} 套 · 至少命中 {draft.strategyContext?.minimumVotes || 1} 套</b></li>
                <li><span>标的</span><b>{displayedSecurity?.name || securityInput || "请选择一只股票"}</b></li>
                <li><span>买入</span><b>{draft.customEntryPrice ? `${draft.customEntryPrice} 元触达成交` : "信号次日开盘成交"}</b></li>
              </ol>
            </div>
          )}
          {result && metrics && (
            <>
              <div className="backtest-profit-overview" data-backtest-profit-overview>
                <div className="backtest-profit-range">
                  <span>实际回测区间</span>
                  <b>{backtestRange?.signalFrom || draft.startDate} 至 {backtestRange?.signalTo || "最新交易日"}</b>
                  <small>
                    历史行情 {backtestRange?.historyBars ?? result.lookbackBars ?? "--"} 根 · 起始资金 {fmt(profitSummary?.startingCapital)} 元 · 单次仓位 {format(profitSummary?.positionPercent)}% · {result.entryPriceMode === "custom_limit_price" ? `自定义买入价 ${format(result.customEntryPrice, 3)} 元` : "次日开盘买入"}
                  </small>
                </div>
                <div className="backtest-profit-grid">
                  <div>
                    <span>累计净收益</span>
                    <b className={Number(profitSummary?.totalNetReturnPercent) >= 0 ? "red" : "green"}>
                      {format(profitSummary?.totalNetReturnPercent)}%
                    </b>
                  </div>
                  <div>
                    <span>累计盈亏</span>
                    <b className={Number(profitSummary?.totalProfitAmount) >= 0 ? "red" : "green"}>
                      {fmt(profitSummary?.totalProfitAmount)} 元
                    </b>
                  </div>
                  <div><span>完成交易</span><b>{profitSummary?.tradeCount ?? 0} 笔</b></div>
                  <div><span>盈利 / 亏损</span><b>{profitSummary?.profitableTrades ?? 0} / {profitSummary?.losingTrades ?? 0}</b></div>
                  <div><span>交易胜率</span><b>{format(profitSummary?.winRatePercent)}%</b></div>
                  <div><span>资金最大回撤</span><b className="green">{format(profitSummary?.maxDrawdownPercent)}%</b></div>
                </div>
              </div>
              {strategyBreakdown.length > 1 && (
                <div className="backtest-strategy-breakdown" data-backtest-strategy-breakdown>
                  <div className="backtest-trade-ledger-head">
                    <div><strong>各策略独立收益对比</strong><small>每套策略单独运行，便于判断是哪一套策略贡献或拖累收益；下方逐笔账本是按所设票数形成的组合结果。</small></div>
                    <em>{strategyBreakdown.length} 套</em>
                  </div>
                  <div className="backtest-trade-table-wrap">
                    <table className="backtest-trade-table backtest-strategy-table">
                      <thead><tr><th>策略</th><th>完成交易</th><th>盈利 / 亏损</th><th>胜率</th><th>累计净收益</th><th>累计盈亏</th><th>最大回撤</th></tr></thead>
                      <tbody>
                        {strategyBreakdown.map((item: any) => (
                          <tr key={String(item.strategyId)}>
                            <td>{item.strategyName}<small>{item.strategyId}</small></td>
                            <td>{item.tradeCount ?? 0} 笔</td>
                            <td>{item.profitableTrades ?? 0} / {item.losingTrades ?? 0}</td>
                            <td>{format(item.winRatePercent)}%</td>
                            <td className={Number(item.totalNetReturnPercent) >= 0 ? "red" : "green"}>{format(item.totalNetReturnPercent)}%</td>
                            <td className={Number(item.totalProfitAmount) >= 0 ? "red" : "green"}>{fmt(item.totalProfitAmount)}</td>
                            <td className="green">{format(item.maxDrawdownPercent)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="backtest-trade-ledger" data-backtest-trade-ledger>
                <div className="backtest-trade-ledger-head">
                  <div><strong>组合逐笔买卖与收益</strong><small>{result.entryPriceMode === "custom_limit_price" ? "策略命中后，下一交易日触达自定义买入价才成交" : "策略命中后下一交易日开盘买入"}；固定持有五个交易日卖出，收益已扣除佣金与滑点。</small></div>
                  <em>{tradeLedger.length} 笔</em>
                </div>
                {tradeLedger.length ? (
                  <div className="backtest-trade-table-wrap">
                    <table className="backtest-trade-table">
                      <thead>
                        <tr><th>序号</th><th>命中策略</th><th>信号日</th><th>买入日 / 价</th><th>卖出日 / 价</th><th>单笔净收益</th><th>单笔盈亏</th><th>累计收益</th></tr>
                      </thead>
                      <tbody>
                        {tradeLedger.map((trade: any) => (
                          <tr key={`${trade.sequence}-${trade.signalDate}-${trade.entryDate}`}>
                            <td>{trade.sequence}</td>
                            <td>
                              {(Array.isArray(trade.strategyIds) ? trade.strategyIds : [])
                                .slice(0, 2)
                                .map((id: string) => verifiedStrategyNameById.get(id) || id)
                                .join("、") || "组合信号"}
                              {Array.isArray(trade.strategyIds) && trade.strategyIds.length > 2
                                ? <small>+{trade.strategyIds.length - 2} 套</small>
                                : null}
                            </td>
                            <td>{trade.signalDate}</td>
                            <td>{trade.entryDate}<small>{format(trade.entryPrice, 3)}</small></td>
                            <td>{trade.exitDate}<small>{format(trade.exitPrice, 3)}</small></td>
                            <td className={Number(trade.netReturnPercent) >= 0 ? "red" : "green"}>{format(trade.netReturnPercent)}%</td>
                            <td className={Number(trade.profitAmount) >= 0 ? "red" : "green"}>{fmt(trade.profitAmount)}</td>
                            <td className={Number(trade.cumulativeReturnPercent) >= 0 ? "red" : "green"}>{format(trade.cumulativeReturnPercent)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-inline">所选策略在这只股票的所选日期范围内没有形成可完成的买卖，累计收益为 0。</div>
                )}
              </div>
              <details className="backtest-diagnostics">
                <summary>专业验证与风控诊断</summary>
                <div className="backtest-diagnostics-body">
              <div className={`qualification-strip ${metrics.accepted ? "qualified" : "waiting"}`}>
                {metrics.accepted ? <CheckCircle2 size={18} /> : <CircleDot size={18} />}
                <div>
                  <b>{metrics.accepted ? "回测通过预检" : "回测未通过预检"}</b>
                  <small>{metrics.passReason || "参数未满足全部过滤条件"}</small>
                </div>
              </div>
              <div className={`backtest-quality-card walk-forward-card ${walkForwardValidation?.accepted ? "pass" : "block"}`}>
                <div className="execution-readiness-header">
                  <strong>滚动样本外验证</strong>
                  <span className={`history-state ${walkForwardValidation?.accepted ? "ok" : "bad"}`}>
                    {walkForwardValidation?.accepted ? "样本外验证通过" : "样本外验证未通过"}
                  </span>
                </div>
                <small>{walkForwardValidation?.reason || "该回测没有可核验的样本外结果，禁止应用到执行策略。"}</small>
                <div className="backtest-walk-forward-metrics">
                  <div><span>样本外样本</span><b>{walkForwardValidation?.oosSampleCount ?? "--"}</b></div>
                  <div><span>窗口通过率</span><b>{walkForwardValidation ? `${format(Number(walkForwardValidation.foldPassRate) * 100, 0)}%` : "--"}</b></div>
                  <div><span>样本外净边际</span><b>{walkForwardValidation ? `${format(walkForwardValidation.oosProjectedNetEdge)}%` : "--"}</b></div>
                  <div><span>样本外胜率</span><b>{walkForwardValidation ? `${format(walkForwardValidation.oosWinRate5)}%` : "--"}</b></div>
                  <div><span>训练外退化</span><b>{walkForwardValidation ? `${format(walkForwardValidation.degradationPercent, 0)}%` : "--"}</b></div>
                  <div><span>过拟合风险</span><b>{overfitRiskLabel(walkForwardValidation?.overfitRisk)}</b></div>
                </div>
                {!!walkForwardValidation?.folds?.length && (
                  <div className="backtest-walk-forward-folds">
                    {walkForwardValidation.folds.map((fold: any) => (
                      <div key={fold.fold}>
                        <span>窗口 {fold.fold} · {fold.testStart || "--"} 至 {fold.testEnd || "--"}</span>
                        <b className={fold.accepted ? "red" : "green"}>
                          {fold.accepted ? "通过" : "未通过"} · 净边际 {format(fold.oosProjectedNetEdge)}%
                        </b>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className={`backtest-quality-card execution-readiness ${executionReadiness.level}`}>
                <div className="execution-readiness-header">
                  <strong>执行决策评分</strong>
                  <span className={`history-state ${executionReadiness.level === "pass" ? "ok" : executionReadiness.level === "wait" ? "wait" : "bad"}`}>
                    {executionStatusLabel(executionReadiness.status)}
                  </span>
                </div>
                <small>{executionReadiness.recommendation}</small>
                <div className="execution-score-meter">
                  <b>{executionReadiness.score}</b>
                  <div className="execution-score-bar"><em style={{ width: `${executionReadiness.score}%` }} /></div>
                </div>
                <div className="execution-reasons">
                  {executionReadiness.reasons.slice(0, 2).map((item) => (
                    <small key={item}>{item}</small>
                  ))}
                  {executionReadiness.reasons.length > 2 ? <small>...</small> : null}
                </div>
              </div>
              <div className={`backtest-quality-card backtest-trade-plan ${executionReadiness.level}`}>
                <div className="execution-readiness-header">
                  <strong>执行交易计划</strong>
                  <span className={`history-state ${executionPlan.canExecute ? "ok" : executionReadiness.level === "wait" ? "wait" : "bad"}`}>
                    {executionPlan.canExecute ? "可执行" : "暂停"}
                  </span>
                </div>
                <small>基于回测回撤与样本统计的执行参数建议，仅供仿真与风控演练使用。</small>
                <div className="backtest-trade-plan-grid">
                  <div className="backtest-kv"><span>建议信号</span><b>{tradeSignalLabel(executionPlan.signal)}</b></div>
                  <div className="backtest-kv"><span>建议仓位</span><b>{executionPlan.positionSizePercent}%</b></div>
                  <div className="backtest-kv"><span>止损距离</span><b>{executionPlan.stopLossPercent}%</b></div>
                  <div className="backtest-kv"><span>止盈距离</span><b>{executionPlan.takeProfitPercent}%</b></div>
                  <div className="backtest-kv"><span>风险收益比</span><b>{executionPlan.riskRewardRatio.toFixed(1)}</b></div>
                  <div className="backtest-kv"><span>预计持仓期</span><b>{executionPlan.estimatedHoldingBars} 根</b></div>
                  <div className="backtest-kv"><span>预期净收益</span><b>{fmt(executionPlan.expectedNetEdge)}%</b></div>
                  <div className="backtest-kv"><span>执行置信度</span><b>{executionPlan.confidence}</b></div>
                </div>
                <div className="execution-reasons">
                  {executionPlan.rationale.slice(0, 3).map((item) => (
                    <small key={item}>{item}</small>
                  ))}
                  {executionPlan.rationale.length > 3 ? <small>...</small> : null}
                </div>
              </div>
              <div className="backtest-metric-grid">
                <div className="backtest-kv"><span>总事件</span><b>{format(metrics.totalSignals)}</b></div>
                <div className="backtest-kv"><span>有效样本</span><b>{format(metrics.replayableSignals, 0)}</b></div>
                <div className="backtest-kv"><span>平均R5</span><b>{format(metrics.averageR5)}</b></div>
                <div className="backtest-kv"><span>中位R5</span><b>{format(metrics.medianR5)}</b></div>
                <div className="backtest-kv"><span>盈亏期望值</span><b>{format(metrics.expectancy5)}</b></div>
                <div className="backtest-kv"><span>净收益率</span><b>{format(metrics.projectedNetEdge)}</b></div>
                <div className="backtest-kv"><span>胜率5</span><b>{format(metrics.winRate5)}</b></div>
                <div className="backtest-kv"><span>最大回撤5</span><b>{format(metrics.worstMdd5)}</b></div>
                <div className="backtest-kv"><span>基准回测1日</span><b>{format(benchmark?.r1, 2)}</b></div>
                <div className="backtest-kv"><span>基准回测3日</span><b>{format(benchmark?.r3, 2)}</b></div>
                <div className="backtest-kv"><span>基准回测5日</span><b>{format(benchmark?.r5, 2)}</b></div>
                <div className="backtest-kv">
                  <span>非重叠结算样本</span>
                  <b>{historicalSamplePoints.length ? `${historicalSamplePoints.length} 笔` : "--"}</b>
                </div>
              </div>
              {strategyIds.length > 0 && (
                <div className="backtest-strategy-list">
                  <span>执行策略</span>
                  <small>{strategyIds.join(" / ")}</small>
                </div>
              )}
              <div className="backtest-strategy-list">
                <span>回测参数对齐</span>
                {isVerifiedStrategyBacktest ? (
                  <small>
                    策略信号规则采用独立的 robust-v2 命名空间，仅用于本次诊断；
                    不会覆盖设置页的分析因子组合。
                  </small>
                ) : profileDiffs.length ? (
                  <>
                    <small>
                      当前执行设置与回测快照存在 {profileDiffs.length} 项差异，
                      点击“应用到执行策略”可自动对齐关键风控参数
                    </small>
                    <div className="backtest-diff-list">
                      {profileDiffs.slice(0, 3).map((item) => (
                        <small key={item.label}>
                          {item.label}：{item.sourceValue} → {item.targetValue}
                        </small>
                      ))}
                      {profileDiffs.length > 3 ? <small>...更多参数差异请在历史记录展开查看</small> : null}
                    </div>
                  </>
                ) : (
                  <small>回测快照与当前执行设置一致，可直接沿用</small>
                )}
              </div>
              {historicalSamplePoints.length > 0 && (
                <div className="backtest-summary-card">
                  <span>真实历史样本结算轨迹（按入场日顺序，重叠信号不重复计入）</span>
                  <small>
                    起始资金 {fmt(historicalSamplePath?.startingCapital)} · 单笔上限 {format(historicalSamplePath?.positionPercent)}% · 往返成本 {format(historicalSamplePath?.roundTripCostPercent)}%
                  </small>
                  <ol>
                    {historicalSamplePoints.slice(-10).map((item: any) => (
                      <li key={`${item.entryDate}-${item.exitDate}-${item.node}`}>
                        {item.entryDate} → {item.exitDate}：净 {format(item.netReturnPercent)}% · 资金 {fmt(item.capital)}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
                </div>
              </details>
            </>
          )}
          <details
            className="backtest-profile-comparison"
            open={comparisonRunning || Boolean(profileComparisons) ? true : undefined}
          >
            <summary>
              <span><strong>三档风险参数对比（可选）</strong><small>展开后比较保守、平衡、激进三档</small></span>
              <em>{profileComparisons ? "已有结果" : "按需展开"}</em>
            </summary>
            <div className="backtest-profile-comparison-body">
              <div className="backtest-profile-comparison-head">
                <div>
                  <strong>固定标的与成本，仅切换风险档位</strong>
                  <small>通过准入且净边际更高的结果优先；不会改变上方单股回测的策略选择。</small>
                </div>
              <button
                className="secondary-btn"
                disabled={comparisonRunning || loading || resolvingSecurity}
                onClick={() => runWithResolvedSecurity(onRunProfileComparisons)}
              >
                {comparisonRunning || resolvingSecurity ? <LoaderCircle className="spin" size={16} /> : <LineChart size={16} />}
                {comparisonRunning ? "对比运行中" : resolvingSecurity ? "确认股票" : "运行三档对比"}
              </button>
              </div>
              {!profileComparisons && (
                <div className="empty-inline">运行三档对比后，可在同一组成本与样本约束下选择更合适的执行档位。</div>
              )}
              {!!profileComparisons && (
                <div className="backtest-profile-comparison-list">
                  {comparisonRows.map((item) => {
                    const record = item.record;
                    const rowMetrics = record?.metrics;
                    const readiness = item.readiness;
                    return (
                      <article className="backtest-profile-comparison-row" key={item.profile}>
                        <div className="backtest-profile-comparison-meta">
                          <div>
                            <strong>{riskProfileLabel(item.profile)}</strong>
                            <small>{item.loading ? "正在回放历史样本" : item.error || readiness?.recommendation || "等待结果"}</small>
                          </div>
                          {item.loading ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <span className={`history-state ${readiness?.level === "pass" ? "ok" : readiness?.level === "wait" ? "wait" : "bad"}`}>
                              {readiness ? executionStatusLabel(readiness.status) : "回放失败"}
                            </span>
                          )}
                        </div>
                        {record && readiness && (
                          <>
                            <div className="backtest-profile-comparison-metrics">
                              <div><span>净边际</span><b>{format(rowMetrics?.projectedNetEdge)}%</b></div>
                              <div><span>胜率</span><b>{format(rowMetrics?.winRate5)}%</b></div>
                              <div><span>最大回撤</span><b>{format(rowMetrics?.worstMdd5)}%</b></div>
                              <div><span>可回放样本</span><b>{rowMetrics?.replayableSignals ?? "--"}</b></div>
                            </div>
                            <button
                              className="secondary-btn"
                              disabled={readiness.level === "block" || isVerifiedStrategyBacktest}
                              title={isVerifiedStrategyBacktest
                                ? "已验证策略规则仅用于本次回放，不写入设置页"
                                : readiness.level === "block"
                                  ? readiness.recommendation
                                  : "通过执行治理后应用该档位参数"}
                              onClick={() => onApplyProfileComparison(record)}
                            >
                              <Target size={15} />
                              {readiness.level === "wait" ? "审慎应用此档" : "应用此档参数"}
                            </button>
                          </>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </details>
        </section>
        <section className="panel backtest-history-panel">
          <PanelTitle
            title="历史回测记录"
            subtitle="本地保存的回测记录，可一键恢复参数并导出"
            icon={Database}
            badge={`${history.length} 条`}
          />
          {!history.length && <div className="empty-inline">暂无历史回测记录，运行一次回测后会自动保存</div>}
          {!!history.length && (
            <div className="backtest-history-list">
              {history.map((record) => (
                <article key={record.id} className="backtest-history-item">
                  {(() => {
                    const recordIsVerified = record.rawResult?.strategyEngine === "verified-signal-v2";
                    const recordReadiness = evaluateBacktestExecutionReadiness(
                      record.metrics && typeof record.metrics === "object" ? record.metrics : null,
                      profileDiff(record.strategyProfile),
                      record.rawResult?.tradeExecutionReadiness || record.rawResult?.executionReadiness
                    );
                    return (
                      <>
                        <div className="backtest-history-meta">
                          <div>
                            <b>{record.securityCode || "--"}</b>
                            <small>{record.securityName}</small>
                          </div>
                          <span className={`history-state ${record.accepted ? "ok" : "bad"}`}>
                            {record.accepted ? "预检通过" : "预检未通过"}
                          </span>
                          <span className={`history-state ${recordReadiness.level === "pass" ? "ok" : recordReadiness.level === "wait" ? "wait" : "bad"}`}>
                            {executionStatusLabel(recordReadiness.status)}
                          </span>
                        </div>
                        <p>执行评分：{recordReadiness.score} / 100</p>
                        <p>{recordReadiness.recommendation}</p>
                        <p>
                          回测时间：{new Date(record.createdAt).toLocaleString("zh-CN")} |
                          净收益：{fmt(record.metrics?.projectedNetEdge)} | 样本：{record.metrics?.replayableSignals ?? "--"}
                        </p>
                        <p>
                          策略：{record.rawResult?.strategyContext?.strategyName || record.strategyProfile?.selectedStrategies?.slice(0, 6).join(" / ") || "--"}
                        </p>
                        <p>风险档位：{riskProfileLabel(record.strategyProfile.riskProfile)}</p>
                        <p>
                          样本外：{record.metrics?.oosSampleCount ?? "--"} 条 |
                          净边际：{fmt(record.metrics?.oosProjectedNetEdge)}% |
                          过拟合风险：{overfitRiskLabel(record.metrics?.overfitRisk)}
                        </p>
                        {(() => {
                          const hot = recordReadiness.reasons.slice(0, 2).join(" / ");
                          return <p>{`关键风险：${hot}${recordReadiness.reasons.length > 2 ? " ..." : ""}`}</p>;
                        })()}
                        <div className="backtest-history-actions">
                          <button className="secondary-btn" onClick={() => onLoadHistory(record)}>载入</button>
                          <button className="secondary-btn" onClick={() => onExportHistory(record, "csv")}>CSV</button>
                          <button className="secondary-btn" onClick={() => onExportHistory(record, "json")}>JSON</button>
                          <button
                            className="secondary-btn"
                            disabled={
                              recordIsVerified ||
                              recordReadiness.level === "block" ||
                              record.metrics?.walkForwardAccepted !== true
                            }
                            title={
                              recordIsVerified
                                ? "策略信号规则仅用于该记录回放，不写入设置页"
                                : record.metrics?.walkForwardAccepted !== true
                                ? "滚动样本外验证未通过，不能应用到执行设置"
                                : recordReadiness.level === "block"
                                ? recordReadiness.recommendation
                                : recordReadiness.level === "wait"
                                  ? "建议先纸面验证后再应用历史参数"
                                  : "应用该记录参数到执行设置"
                            }
                            onClick={() => onApplyHistory(record)}
                          >
                            {recordIsVerified
                              ? "策略规则仅本次使用"
                              : recordReadiness.level === "wait"
                                ? "应用到执行（请谨慎）"
                                : "应用到执行"}
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </article>
              ))}
            </div>
          )}
          {!!history.length && (
            <div className="backtest-history-actions">
              <button className="secondary-btn" onClick={onClearHistory}>清空历史</button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function FavoritesView({
  items,
  onOpen,
  onRemove
}: {
  items: WatchItem[];
  onOpen: (item: WatchItem) => void;
  onRemove: (item: WatchItem) => void;
}) {
  return (
    <>
      <PageHeading
        eyebrow="PERSONAL MONITOR BOARD"
        title="自选板块"
        description="在涨停池或个股分析中点击“监控/加入自选”，股票会集中保存在这里。"
      />
      <section className="panel favorites-panel">
        <PanelTitle
          title="我的监控"
          subtitle="自选数据保存在本机；点击任意股票进入独立分析"
          icon={Star}
          badge={`${items.length} 只`}
        />
        {items.length ? (
          <div className="favorites-grid">
            {items.map((item: WatchItem) => (
              <button className="favorite-card" key={item.code} onClick={() => onOpen(item)}>
                <span className="favorite-market">{item.thscode?.split(".")[1] || "A"}</span>
                <strong>{item.name}</strong>
                <small>{item.code}</small>
                <div>
                  <span>{item.observationNode || "自选监控"}</span>
                  {item.limitDate && <em>涨停 {item.limitDate}</em>}
                </div>
                <i>
                  <Clock3 size={13} />
                  {new Date(item.favoriteAddedAt || item.createdAt || Date.now()).toLocaleDateString("zh-CN")}
                </i>
                <span
                  className="favorite-remove"
                  role="button"
                  tabIndex={0}
                  title="移出自选"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(item);
                  }}
                >
                  <X size={15} />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="favorites-empty">
            <Star size={32} />
            <b>自选板块还是空的</b>
            <span>到涨停池点击“监控”，或在个股分析中点击“加入自选”。</span>
          </div>
        )}
      </section>
    </>
  );
}

function HoldingsView({
  items,
  settings,
  live,
  onSave,
  onOpen
}: {
  items: HoldingItem[];
  settings: Settings;
  live: boolean;
  onSave: (items: HoldingItem[]) => Promise<boolean>;
  onOpen: (item: HoldingItem) => void;
}) {
  const [code, setCode] = useState("");
  const [shares, setShares] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [note, setNote] = useState("");
  const [quotes, setQuotes] = useState<Record<string, any>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const quoteRefreshGate = useMemo(() => createAsyncRequestGate(), []);

  const refreshQuotes = useCallback(async (force = false) => {
    if (!force && document.hidden) {
      setRefreshing(false);
      return;
    }
    const requestId = quoteRefreshGate.begin();
    if (requestId === null) return;
    try {
      if (!items.length) {
        if (quoteRefreshGate.isCurrent(requestId)) setQuotes({});
        return;
      }
      setRefreshing(true);
      const pending = [...items];
      const results: Array<readonly [string, any]> = [];
      const workerCount = Math.min(4, pending.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (pending.length) {
          const item = pending.shift();
          if (!item) return;
          try {
            const snapshot = await window.stockApi.getQuoteSnapshot(item);
            results.push([item.code, snapshot?.quote || null] as const);
          } catch {
            results.push([item.code, null] as const);
          }
        }
      }));
      if (!quoteRefreshGate.isCurrent(requestId)) return;
      setQuotes((current) => {
        const next = { ...current };
        for (const [itemCode, quote] of results) {
          if (quote) next[itemCode] = quote;
        }
        return next;
      });
    } finally {
      if (quoteRefreshGate.finish(requestId)) setRefreshing(false);
    }
  }, [items, quoteRefreshGate]);

  useEffect(() => {
    void refreshQuotes();
    const timer = live && items.length
      ? window.setInterval(
          () => void refreshQuotes(),
          Math.max(5, Number(settings.quoteRefreshSeconds) || 5) * 1000
        )
      : undefined;
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      quoteRefreshGate.invalidate();
    };
  }, [items.length, live, settings.quoteRefreshSeconds, refreshQuotes, quoteRefreshGate]);

  const rows = useMemo(() => items.map((item) => {
    const quote = quotes[item.code] || null;
    const latest = Number(quote?.latest);
    const preClose = Number(quote?.preClose);
    const changePct = Number(quote?.changePct);
    const quoteAvailable = Number.isFinite(latest) && latest > 0;
    const marketValue = quoteAvailable ? latest * item.shares : Number.NaN;
    const costValue = item.costPrice * item.shares;
    const profit = quoteAvailable ? marketValue - costValue : Number.NaN;
    const profitPercent = quoteAvailable && costValue > 0 ? profit / costValue * 100 : Number.NaN;
    const dayProfit = quoteAvailable && Number.isFinite(preClose) && preClose > 0
      ? (latest - preClose) * item.shares
      : Number.NaN;
    return { item, quote, latest, changePct, quoteAvailable, marketValue, costValue, profit, profitPercent, dayProfit };
  }), [items, quotes]);
  const summary = useMemo(() => {
    const priced = rows.filter((row) => row.quoteAvailable);
    const marketValue = priced.reduce((sum, row) => sum + row.marketValue, 0);
    const costValue = priced.reduce((sum, row) => sum + row.costValue, 0);
    const profit = marketValue - costValue;
    const dayPriced = priced.filter((row) => Number.isFinite(row.dayProfit));
    const dayProfit = dayPriced.reduce((sum, row) => sum + row.dayProfit, 0);
    return {
      pricedCount: priced.length,
      dayPricedCount: dayPriced.length,
      marketValue,
      costValue,
      profit,
      profitPercent: costValue > 0 ? profit / costValue * 100 : Number.NaN,
      dayProfit
    };
  }, [rows]);

  const signedMoney = (value: number) => `${value >= 0 ? "+" : ""}${fmtMoney(value)}`;
  const signedPercent = (value: number) => `${value >= 0 ? "+" : ""}${fmt(value)}%`;
  const editHolding = (item: HoldingItem) => {
    setCode(item.code);
    setShares(String(item.shares));
    setCostPrice(String(item.costPrice));
    setNote(item.note || "");
    setFormError("");
  };
  const saveHolding = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedCode = code.trim();
    const normalizedShares = Math.floor(Number(shares));
    const normalizedCost = Number(costPrice);
    if (!/^\d{6}$/.test(normalizedCode)) {
      setFormError("请输入 6 位证券代码");
      return;
    }
    if (!Number.isFinite(normalizedShares) || normalizedShares <= 0) {
      setFormError("持仓数量必须是大于 0 的整数");
      return;
    }
    if (!Number.isFinite(normalizedCost) || normalizedCost <= 0) {
      setFormError("成本价必须大于 0");
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      const choices = await window.stockApi.search(normalizedCode);
      const security = choices.find((item) => item.code === normalizedCode);
      if (!security) throw new Error("未找到该证券，请确认代码后重试");
      const existing = items.find((item) => item.code === normalizedCode);
      const timestamp = new Date().toISOString();
      const nextItem: HoldingItem = {
        ...security,
        shares: normalizedShares,
        costPrice: normalizedCost,
        note: note.trim().slice(0, 160),
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp
      };
      const next = [...items.filter((item) => item.code !== normalizedCode), nextItem]
        .sort((left, right) => left.code.localeCompare(right.code));
      if (!await onSave(next)) return;
      setCode("");
      setShares("");
      setCostPrice("");
      setNote("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "持仓保存失败");
    } finally {
      setSubmitting(false);
    }
  };
  const removeHolding = async (item: HoldingItem) => {
    await onSave(items.filter((entry) => entry.code !== item.code));
  };

  return (
    <>
      <PageHeading
        eyebrow="PERSONAL HOLDINGS BOARD"
        title="持仓股"
        description="持仓数据仅保存在本机；行情沿用同花顺主源和三线校验，不连接券商、不会发出交易指令。"
        actions={<button className="secondary-btn" onClick={() => void refreshQuotes(true)} disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}刷新行情</button>}
      />
      <section className="panel holdings-summary-panel">
        <PanelTitle title="持仓总览" subtitle={`已取得 ${summary.pricedCount}/${items.length} 条有效报价`} icon={WalletCards} badge={`${items.length} 只`} />
        <div className="fact-grid holdings-summary-grid">
          <Fact label="持仓市值" value={summary.pricedCount ? fmtMoney(summary.marketValue) : "--"} />
          <Fact label="持仓成本" value={summary.pricedCount ? fmtMoney(summary.costValue) : "--"} />
          <Fact label="浮动盈亏" value={summary.pricedCount ? `${signedMoney(summary.profit)}（${signedPercent(summary.profitPercent)}）` : "--"} />
          <Fact label="按昨收估算今日盈亏" value={summary.dayPricedCount ? signedMoney(summary.dayProfit) : "--"} />
        </div>
      </section>
      <section className="panel holdings-entry-panel">
        <PanelTitle title="录入或更新持仓" subtitle="同一代码再次保存会更新数量、成本价和备注。" icon={BookmarkCheck} />
        <form className="holdings-entry-form" onSubmit={saveHolding}>
          <input aria-label="证券代码" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="证券代码，如 600519" inputMode="numeric" />
          <input aria-label="持仓数量" value={shares} onChange={(event) => setShares(event.target.value.replace(/\D/g, ""))} placeholder="持仓数量（股）" inputMode="numeric" />
          <input aria-label="成本价" value={costPrice} onChange={(event) => setCostPrice(event.target.value)} placeholder="成本价" inputMode="decimal" />
          <input aria-label="持仓备注" value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注（可选）" maxLength={160} />
          <button className="primary-btn" type="submit" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} /> : <BookmarkCheck size={16} />}保存持仓</button>
        </form>
        {formError && <div className="holdings-form-error">{formError}</div>}
      </section>
      <section className="panel holdings-table-panel">
        <PanelTitle title="持仓明细" subtitle="报价暂不可用时保留持仓，不使用成本价伪造实时盈亏。" icon={LineChart} />
        {rows.length ? (
          <div className="table holdings-table">
            <div className="th tr"><span>股票 / 备注</span><span>持仓 / 成本</span><span>最新行情</span><span>市值</span><span>浮动盈亏</span><span>操作</span></div>
            {rows.map((row) => (
              <div className="tr" key={row.item.code}>
                <span className="stock-cell"><b>{row.item.name}</b><small>{row.item.code}{row.item.note ? ` · ${row.item.note}` : ""}</small></span>
                <span>{row.item.shares.toLocaleString("zh-CN")} 股<br /><small>成本 {fmt(row.item.costPrice)} 元</small></span>
                <span>{row.quoteAvailable ? <><b>{fmt(row.latest)} 元</b><small className={row.changePct >= 0 ? "holding-pnl up" : "holding-pnl down"}>{Number.isFinite(row.changePct) ? signedPercent(row.changePct) : "--"}</small></> : <small>报价待恢复</small>}</span>
                <span>{row.quoteAvailable ? fmtMoney(row.marketValue) : "--"}</span>
                <span className={row.profit >= 0 ? "holding-pnl up" : "holding-pnl down"}>{row.quoteAvailable ? <><b>{signedMoney(row.profit)}</b><small>{signedPercent(row.profitPercent)}</small></> : "--"}</span>
                <span className="holdings-row-actions"><button className="table-action" onClick={() => onOpen(row.item)}>分析</button><button className="table-action" onClick={() => editHolding(row.item)}>编辑</button><button className="table-action danger" onClick={() => void removeHolding(row.item)}>移除</button></span>
              </div>
            ))}
          </div>
        ) : (
          <div className="favorites-empty holdings-empty"><WalletCards size={32} /><b>还没有录入持仓</b><span>输入证券代码、数量和成本价后保存；数据只留在本机。</span></div>
        )}
      </section>
    </>
  );
}

function WatchlistView({
  items,
  limitUps = [],
  activeNode,
  onNodeChange,
  onOpen,
  onRemove
}: any) {
  const dayTabs = Array.from({ length: 10 }, (_, index) => {
    const day = index + 1;
    return { id: `T+${day}`, label: `第${day}个 T+${day}` };
  });
  const tabs = [{ id: "all", label: "全部十日" }, ...dayTabs];
  const [boardSort, setBoardSort] = useState<{
    key: "height" | "openBoard" | "turnover";
    direction: "asc" | "desc";
  }>({ key: "height", direction: "desc" });
  const toggleBoardSort = (key: "openBoard" | "turnover") => {
    setBoardSort((current) => ({
      key,
      direction: current.key === key && current.direction === "desc" ? "asc" : "desc"
    }));
  };
  const boardSortMark = (key: "openBoard" | "turnover") =>
    boardSort.key === key ? (boardSort.direction === "desc" ? "↓" : "↑") : "↕";
  const nodeFor = (item: WatchItem) =>
    item.observationNode || (
      Number(item.tradingDaysSince) >= 1 && Number(item.tradingDaysSince) <= 10
        ? `T+${item.tradingDaysSince}`
        : "手动"
    );
  const counts = Object.fromEntries(
    tabs.map((tab) => [
      tab.id,
      tab.id === "all"
        ? items.length
        : items.filter((item: WatchItem) => nodeFor(item) === tab.id).length
    ])
  );
  const visibleItems = items.filter((item: WatchItem) =>
    activeNode === "all" ? true : nodeFor(item) === activeNode
  );
  const consecutiveBoards = [...limitUps]
    .filter((item: any) => Number(item.consecutiveBoards) >= 2)
    .sort((left: any, right: any) => {
      const direction = boardSort.direction === "asc" ? 1 : -1;
      const valueFor = (item: any) =>
        boardSort.key === "openBoard"
          ? Number(item.openBoardCount || 0)
          : boardSort.key === "turnover"
            ? Number(item.turnover || 0)
            : Number(item.consecutiveBoards || 0);
      const primary = (valueFor(left) - valueFor(right)) * direction;
      return primary ||
        Number(right.consecutiveBoards) - Number(left.consecutiveBoards) ||
        Number(left.firstSealRaw || Number.MAX_SAFE_INTEGER) - Number(right.firstSealRaw || Number.MAX_SAFE_INTEGER);
    });
  return (
    <>
      <PageHeading eyebrow="10-DAY LIMIT-UP WATCHLIST" title="涨停后十日观察池" description={`共 ${items.length} 只，按 T+1 至 T+10 的实际交易日完整细分。`} />

      <section className="panel consecutive-board-panel">
        <PanelTitle
          title="当日连板梯队"
          subtitle="从当日完整涨停池提取；点击开板次数或换手率可切换升降序"
          icon={TrendingUp}
          badge={`${consecutiveBoards.length} 只`}
        />
        {consecutiveBoards.length ? (
          <div className="consecutive-board-table">
            <div className="board-row board-head">
              <span>股票</span>
              <span>连板高度</span>
              <span>所属板块</span>
              <span>首次封板</span>
              <span>
                <button
                  type="button"
                  className={boardSort.key === "openBoard" ? "board-sort-btn active" : "board-sort-btn"}
                  onClick={() => toggleBoardSort("openBoard")}
                  title="按开板次数升降序"
                >
                  开板次数 <b>{boardSortMark("openBoard")}</b>
                </button>
              </span>
              <span>
                <button
                  type="button"
                  className={boardSort.key === "turnover" ? "board-sort-btn active" : "board-sort-btn"}
                  onClick={() => toggleBoardSort("turnover")}
                  title="按换手率升降序"
                >
                  换手率 <b>{boardSortMark("turnover")}</b>
                </button>
              </span>
            </div>
            {consecutiveBoards.map((item: any) => (
              <button className="board-row" key={item.code} onClick={() => onOpen(item)}>
                <span><b>{item.name}</b><small>{item.code}</small></span>
                <span><em>{item.consecutiveBoards} 连板</em><small>{item.consecutiveBoards >= 4 ? "高标" : item.consecutiveBoards === 3 ? "中高标" : "晋级股"}</small></span>
                <span>{item.industry || "未分类"}</span>
                <span>{item.firstSealTime || "--"}</span>
                <span>{item.openBoardCount ?? 0} 次</span>
                <span>{fmt(Number(item.turnover || 0))}%</span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyInline text="当前交易日暂无二连板及以上股票" />
        )}
      </section>

      <div className="watch-node-tabs">
        {tabs.map((tab) => (
          <button key={tab.id} className={activeNode === tab.id ? "active" : ""} onClick={() => onNodeChange(tab.id)}>
            <span>{tab.label}</span><b>{counts[tab.id]}</b>
          </button>
        ))}
      </div>
      <div className="panel">
        {visibleItems.length ? (
          <div className="watch-grid">
            {visibleItems.map((item: WatchItem) => (
              <div className="watch-card" role="button" tabIndex={0} key={item.code} onClick={() => onOpen(item)} onKeyDown={(event) => event.key === "Enter" && onOpen(item)}>
                <div className="watch-card-top"><span>{item.thscode?.split(".")[1] || "A"}</span><button onClick={(e) => { e.stopPropagation(); onRemove(item); }}><X size={15} /></button></div>
                <strong>{item.name}</strong><small>{item.code}</small>
                <div>
                  <Clock3 size={14} />
                  {item.limitDate ? `${item.limitDate} 涨停` : `加入于 ${new Date(item.createdAt).toLocaleDateString("zh-CN")}`}
                </div>
                <span className="node-badge">{item.tradingDaysSince === 0 ? "涨停当日" : `涨停后第 ${item.tradingDaysSince ?? "--"} 个交易日`}</span>
                {item.consecutiveBoards && item.consecutiveBoards > 1 && (
                  <span className="board-badge">{item.consecutiveBoards} 连板</span>
                )}
                <em>打开分析 <ChevronRight size={15} /></em>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state"><Bookmark size={32} /><h3>该观察节点暂无股票</h3><p>切换 T+1 至 T+10 查看其他交易日节点。</p></div>
        )}
      </div>
    </>
  );
}

function ConceptChainPanel({
  data,
  loading,
  onOpen
}: {
  data: any;
  loading: boolean;
  onOpen: (sector: any) => void;
}) {
  if (loading) {
    return (
      <section className="panel concept-chain-panel">
        <PanelTitle title="产业链细分概览" subtitle="正在读取免费行情成分股与交叉概念" icon={Layers3} />
        <div className="concept-chain-loading"><LoaderCircle className="spin" size={18} />加载细分概念...</div>
      </section>
    );
  }
  if (!data) return null;
  return (
    <section className="panel concept-chain-panel">
      <PanelTitle
        title={`${data.name} · 细分概念`}
        subtitle={data.source}
        icon={Layers3}
        badge={data.thsStatus === "已连接" ? "动态已校验" : data.thsStatus}
      />
      <div className="concept-chain-notice">
        <Database size={16} />
        <span>{data.message}</span>
      </div>
      <div className="concept-chain-groups">
        {(data.groups || []).map((group: any) => (
          <div className="concept-chain-group" key={group.name}>
            <h3>{group.name}</h3>
            <div>
              {(group.segments || []).map((segment: any) => (
                <button
                  key={segment.name}
                  onClick={() => onOpen(segment.matchedBoard || segment.name)}
                  title={segment.thsQuery}
                >
                  <span><b>{segment.name}</b><em>{segment.role}</em></span>
                  <small>{segment.description}</small>
                  <i>
                    重合 {segment.stockCount ?? segment.thsStockCount} / {data.stockCount} 只
                    {Number.isFinite(segment.overlapRatio)
                      ? ` · ${(segment.overlapRatio * 100).toFixed(1)}%`
                      : ""}
                  </i>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {!data.groups?.length && (
        <div className="concept-chain-empty">
          <Search size={22} />
          <b>暂未取得可用细分概念</b>
          <span>{data.query}</span>
        </div>
      )}
    </section>
  );
}

const nullableNumber = (value: any): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const subtractNullable = (left: any, right: any): number | null => {
  const leftNumber = nullableNumber(left);
  const rightNumber = nullableNumber(right);
  return leftNumber === null || rightNumber === null ? null : leftNumber - rightNumber;
};

const normalizeSectorViewRow = (value: any, index = 0) => {
  const item = value && typeof value === "object" ? value : {};
  const normalizeMember = (value: any, memberIndex = 0) => {
    const member = value && typeof value === "object" ? value : {};
    const code = String(member.code || "").trim();
    return {
      ...member,
      code,
      name: String(member.name || code || `成分股${memberIndex + 1}`),
      secid: String(member.secid || ""),
      latest: nullableNumber(member.latest) ?? nullableNumber(member.price),
      changePct: nullableNumber(member.changePct),
      turnover: nullableNumber(member.turnover),
      amount: nullableNumber(member.amount),
      mainNetInflow: nullableNumber(member.mainNetInflow),
      firstSealTime: String(member.firstSealTime || ""),
      openBoardCount: member.openBoardCount == null ? null : safeNumber(member.openBoardCount),
      consecutiveBoards: member.consecutiveBoards == null ? null : safeNumber(member.consecutiveBoards),
      isLimitUp: Boolean(member.isLimitUp)
    };
  };
  const normalizeReturns = (returns: any) => ({
    r1: nullableNumber(returns?.r1),
    r3: nullableNumber(returns?.r3),
    r5: nullableNumber(returns?.r5)
  });
  const rawConstituents = Array.isArray(item.constituents)
    ? item.constituents
    : Array.isArray(item.members)
      ? item.members
      : [];
  const constituents = rawConstituents
    .filter((member: any) => member && typeof member === "object")
    .map(normalizeMember);
  const poolLimitUps = nullableNumber(item.poolLimitUps) ?? nullableNumber(item.limitUps) ?? 0;
  const memberCount = nullableNumber(item.memberCount) ??
    (typeof item.members === "number" ? nullableNumber(item.members) : constituents.length || null);

  return {
    ...item,
    name: String(item.name || "未命名板块"),
    rank: Math.max(1, safeNumber(item.rank, index + 1)),
    state: String(item.state || "数据待补"),
    score: nullableNumber(item.score),
    returns: normalizeReturns(item.returns),
    benchmarkReturns: normalizeReturns(item.benchmarkReturns),
    allMarketReturns: normalizeReturns(item.allMarketReturns),
    constituents,
    leaders: Array.isArray(item.leaders)
      ? item.leaders.filter((member: any) => member && typeof member === "object").map(normalizeMember)
      : constituents.slice(0, 8),
    history: Array.isArray(item.history) ? item.history : [],
    memberCount,
    limitUps: nullableNumber(item.limitUps) ?? poolLimitUps,
    poolLimitUps,
    poolShare: safeNumber(item.poolShare),
    breadth: nullableNumber(item.breadth),
    memberAverageReturn: nullableNumber(item.memberAverageReturn),
    relativeReturn: nullableNumber(item.relativeReturn),
    amountHeat: nullableNumber(item.amountHeat),
    persistence: nullableNumber(item.persistence),
    memberAverageTurnover: nullableNumber(item.memberAverageTurnover),
    leadershipQualityScore: nullableNumber(item.leadershipQualityScore),
    advancingAmountShare: item.advancingAmountShare == null ? null : safeNumber(item.advancingAmountShare),
    positiveInflowRatio: item.positiveInflowRatio == null ? null : safeNumber(item.positiveInflowRatio),
    top5AmountShare: item.top5AmountShare == null ? null : safeNumber(item.top5AmountShare),
    medianMemberReturn: item.medianMemberReturn == null ? null : safeNumber(item.medianMemberReturn),
    returnDispersion: item.returnDispersion == null ? null : safeNumber(item.returnDispersion),
    dataCoveragePercent: nullableNumber(item.dataCoveragePercent),
    breadthDiagnostics: item.breadthDiagnostics && typeof item.breadthDiagnostics === "object"
      ? item.breadthDiagnostics
      : null
  };
};

function SectorView({ rows, loading, loadError, onRefresh, onOpenStock }: {
  rows: any[];
  loading: boolean;
  loadError: string;
  onRefresh: () => Promise<boolean | void> | boolean | void;
  onOpenStock: (stock: Security) => void;
}) {
  const [selectedName, setSelectedName] = useState("");
  const [sectorQuery, setSectorQuery] = useState("");
  const [sectorSuggestions, setSectorSuggestions] = useState<any[]>([]);
  const [sectorSearchFocused, setSectorSearchFocused] = useState(false);
  const [sectorSearching, setSectorSearching] = useState(false);
  const [sectorAnalyzing, setSectorAnalyzing] = useState(false);
  const [customSector, setCustomSector] = useState<any>(null);
  const [sectorError, setSectorError] = useState("");
  const [memberFilter, setMemberFilter] = useState("all");
  const [memberQuery, setMemberQuery] = useState("");
  const [conceptChain, setConceptChain] = useState<any>(null);
  const [conceptChainLoading, setConceptChainLoading] = useState(false);
  const sectorSearchTimer = useRef<number>();
  const sectorSearchRequest = useRef(0);
  const sectorAnalysisRequest = useRef(0);
  const conceptChainRequest = useRef(0);
  const normalizedRows = useMemo(
    () => (Array.isArray(rows) ? rows : []).filter(Boolean).map((item, index) => normalizeSectorViewRow(item, index)),
    [rows]
  );

  useEffect(() => () => {
    sectorSearchRequest.current += 1;
    sectorAnalysisRequest.current += 1;
    conceptChainRequest.current += 1;
    window.clearTimeout(sectorSearchTimer.current);
  }, []);

  useEffect(() => {
    if (normalizedRows.length && !normalizedRows.some((item) => item.name === selectedName)) {
      setSelectedName(normalizedRows[0].name);
    }
  }, [normalizedRows, selectedName]);

  useEffect(() => {
    const requestId = ++sectorSearchRequest.current;
    window.clearTimeout(sectorSearchTimer.current);
    if (!sectorQuery.trim()) {
      setSectorSuggestions([]);
      return;
    }
    sectorSearchTimer.current = window.setTimeout(async () => {
      setSectorSearching(true);
      try {
        const suggestions = await window.stockApi.searchSectors(sectorQuery);
        if (requestId === sectorSearchRequest.current) setSectorSuggestions(suggestions);
      } catch {
        if (requestId === sectorSearchRequest.current) setSectorSuggestions([]);
      } finally {
        if (requestId === sectorSearchRequest.current) setSectorSearching(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(sectorSearchTimer.current);
      if (requestId === sectorSearchRequest.current) sectorSearchRequest.current += 1;
    };
  }, [sectorQuery]);

  const openSector = async (item: any) => {
    const requestId = ++sectorAnalysisRequest.current;
    setSectorAnalyzing(true);
    setSectorSearchFocused(false);
    setSectorError("");
    setSectorSuggestions([]);
    try {
      const detail = await window.stockApi.analyzeSector(item);
      const requestedName = typeof item === "string"
        ? item
        : String(item?.name || item?.query || "");
      const normalizedDetail = {
        ...(detail && typeof detail === "object" ? detail : {}),
        name: String(detail?.name || requestedName || "未命名板块")
      };
      if (requestId !== sectorAnalysisRequest.current) return;
      setCustomSector(normalizedDetail);
      setSectorQuery(normalizedDetail.name);
      setMemberFilter("all");
      setMemberQuery("");
    } catch (error) {
      if (requestId === sectorAnalysisRequest.current) {
        setSectorError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === sectorAnalysisRequest.current) setSectorAnalyzing(false);
    }
  };

  const selectedSector = customSector || normalizedRows.find((item) => item.name === selectedName) || normalizedRows[0];
  const sector = selectedSector ? normalizeSectorViewRow(selectedSector) : null;

  const refreshSectorBoard = async () => {
    if (loading) return;
    sectorAnalysisRequest.current += 1;
    setSectorAnalyzing(false);
    const refreshed = await onRefresh();
    if (refreshed === false) return;
    setCustomSector(null);
    setSectorQuery("");
    setSectorError("");
    setMemberFilter("all");
    setMemberQuery("");
  };

  useEffect(() => {
    const name = customSector?.name || "";
    const requestId = ++conceptChainRequest.current;
    if (!name) {
      setConceptChain(null);
      setConceptChainLoading(false);
      return;
    }
    setConceptChainLoading(true);
    window.stockApi
      .getConceptChain(customSector)
      .then((value) => {
        if (requestId === conceptChainRequest.current) setConceptChain(value);
      })
      .catch(() => {
        if (requestId === conceptChainRequest.current) setConceptChain(null);
      })
      .finally(() => {
        if (requestId === conceptChainRequest.current) setConceptChainLoading(false);
      });
  }, [customSector?.name]);

  const members = (sector?.constituents || []).filter((item: any) => {
    const queryMatched = !memberQuery.trim() || item.name.includes(memberQuery.trim()) || item.code.includes(memberQuery.trim());
    const filterMatched =
      memberFilter === "all" ||
      (memberFilter === "limitUp" && item.isLimitUp) ||
      (memberFilter === "up" && item.changePct > 0) ||
      (memberFilter === "down" && item.changePct < 0);
    return queryMatched && filterMatched;
  });
  const sectorHistory = sector?.history || [];
  const historyAmounts = sectorHistory.map((day: any) => Number(day.amount || 0));
  const maxHistoryAmount = Math.max(1, ...historyAmounts);
  const averageHistoryAmount = historyAmounts.length
    ? historyAmounts.reduce((sum: number, amount: number) => sum + amount, 0) / historyAmounts.length
    : 0;

  return (
    <>
      <PageHeading
        eyebrow="SECTOR SEARCH & STRENGTH"
        title="板块强度"
        actions={<button className="primary-btn" onClick={refreshSectorBoard} disabled={loading}><RefreshCw size={17} className={loading ? "spin" : ""} />刷新板块排行</button>}
      />
      {loadError && (
        <div className="warning-banner">
          <CircleAlert size={17} />板块排行刷新失败：{loadError}。当前继续显示上一次有效结果。
        </div>
      )}

      <div className="panel sector-search-panel">
        <div className="sector-search-copy">
          <Search size={22} />
          <div><b>搜索任意板块</b><small>板块无需出现在涨停排行榜中</small></div>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); if (sectorSuggestions[0]) openSector(sectorSuggestions[0]); else if (sectorQuery.trim()) openSector(sectorQuery.trim()); }}>
          <Search size={18} />
          <input
            value={sectorQuery}
            onChange={(event) => setSectorQuery(event.target.value)}
            onFocus={() => setSectorSearchFocused(true)}
            onBlur={() => window.setTimeout(() => setSectorSearchFocused(false), 150)}
            placeholder="输入 PCB、CPO、机器人、算力、低空经济等"
          />
          {sectorSearching && <LoaderCircle size={17} className="spin" />}
          <button type="submit" disabled={sectorAnalyzing}>{sectorAnalyzing ? <LoaderCircle size={17} className="spin" /> : "查询板块"}</button>
          {sectorSearchFocused && sectorSuggestions.length > 0 && (
            <div className="sector-suggestions">
              {sectorSuggestions.map((item) => (
                <button type="button" key={item.secid} onClick={() => openSector(item)}>
                  <span><b>{item.name}</b><small>{item.code}</small></span><em>{item.type}</em>
                </button>
              ))}
            </div>
          )}
        </form>
        <div className="sector-quick-search">
          {["PCB", "CPO", "机器人", "算力", "低空经济"].map((item) => <button key={item} onClick={() => { setSectorQuery(item); openSector(item); }}>{item}</button>)}
        </div>
      </div>
      {sectorError && <div className="warning-banner"><CircleAlert size={17} />{sectorError}</div>}

      {loading && !normalizedRows.length && !customSector ? (
        <LoadingState />
      ) : !sector ? (
        <div className="panel empty-state"><Layers3 size={32} /><h3>请输入板块名称</h3><p>例如输入 CPO，即可读取 CPO 概念的完整强度信息。</p></div>
      ) : (
        <>
          {customSector && (
            <div className="sector-query-result">
              <span><Search size={16} />搜索结果</span><b>{customSector.name}</b><small>{customSector.code} · {customSector.memberCount} 只成分股</small>
              <button onClick={() => { sectorAnalysisRequest.current += 1; setSectorAnalyzing(false); setCustomSector(null); setSectorQuery(""); }}>返回涨停板块榜</button>
            </div>
          )}
          {sector.partial && (
            <div className="warning-banner"><CircleAlert size={17} />{sector.warning || "板块详情正在由备用源接力；未取得的字段显示为 --。"}</div>
          )}
          {sector.dataCoveragePercent != null && sector.dataCoveragePercent > 0 && sector.dataCoveragePercent < 70 && (
            <div className="warning-banner"><CircleAlert size={17} />板块成分字段覆盖仅 {fmt(sector.dataCoveragePercent, 0)}%，成交参与、资金广度或集中度只作辅助，不提高强度结论。</div>
          )}

          <ConceptChainPanel
            data={conceptChain}
            loading={conceptChainLoading}
            onOpen={openSector}
          />

          <div className="market-summary-grid">
            <div className="panel"><span>板块成分股</span><b>{sector.memberCount}</b><small>{sector.name}</small></div>
            <div className="panel"><span>板块涨停股</span><b>{sector.limitUps ?? sector.poolLimitUps}</b><small>当前交易日</small></div>
            <div className="panel"><span>中证全指 1日</span><b className={sector.allMarketReturns?.r1 == null ? "" : sector.allMarketReturns.r1 >= 0 ? "red" : "green"}>{sector.allMarketReturns?.r1 == null ? "--" : `${sector.allMarketReturns.r1 >= 0 ? "+" : ""}${fmt(sector.allMarketReturns.r1)}%`}</b><small>全市场代理基准</small></div>
            <div className="panel"><span>沪深300 1日</span><b className={sector.benchmarkReturns?.r1 == null ? "" : sector.benchmarkReturns.r1 >= 0 ? "red" : "green"}>{sector.benchmarkReturns?.r1 == null ? "--" : `${sector.benchmarkReturns.r1 >= 0 ? "+" : ""}${fmt(sector.benchmarkReturns.r1)}%`}</b><small>大盘权重基准</small></div>
          </div>

          {sector.ladder && (
            <div className="panel sector-ladder-panel">
              <PanelTitle
                title="涨停梯队与扩散"
                subtitle="对比今日涨停、昨日晋级与当前炸板，判断板块持续性"
                icon={Target}
                badge={`${sector.ladder.score == null ? "评分暂停" : `${sector.ladder.score}分`} · ${sector.ladder.state}`}
              />
              <div className="ladder-metric-grid">
                <Metric label="板块高度" value={sector.ladder.maxHeight ? `${sector.ladder.maxHeight} 板` : "无连板"} />
                <Metric label="首板家数" value={String(sector.ladder.firstBoards)} tone="red" />
                <Metric label="连板家数" value={String(sector.ladder.continuationBoards)} tone="red" />
                <Metric label="昨日晋级率" value={`${fmt(sector.ladder.promotionRate * 100, 1)}%`} />
                <Metric
                  label="当前炸板数"
                  value={sector.ladder.failedBoards == null ? "--" : String(sector.ladder.failedBoards)}
                  tone={sector.ladder.failedBoards > 0 ? "green" : ""}
                />
                <Metric
                  label="炸板率"
                  value={sector.ladder.breakRate == null ? "--" : `${fmt(sector.ladder.breakRate * 100, 1)}%`}
                  tone={sector.ladder.breakRate != null && sector.ladder.breakRate > 0.35 ? "green" : ""}
                />
              </div>
              <div className="ladder-levels">
                {(sector.ladder.levels || []).map((level: any) => (
                  <div key={level.height}>
                    <b>{level.label}</b>
                    <span>
                      {level.stocks.map((stock: any) => (
                        <button key={stock.code} onClick={() => onOpenStock(stock)}>
                          {stock.name}<small>{stock.firstSealTime || "--"} · 开板{stock.openBoardCount ?? 0}</small>
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
                {!sector.ladder.levels?.length && <EmptyInline text="当前板块暂无涨停梯队" />}
              </div>
              <div className="ladder-explain">
                今日涨停 {sector.ladder.currentLimitUps} 家，昨日该板块涨停 {sector.ladder.previousLimitUps} 家，
                实际晋级 {sector.ladder.promotedCount} 家；
                {sector.ladder.failedPoolAvailable === false
                  ? "炸板源本次不可用，风险分与炸板率暂停计算，避免把缺失数据误判为零。"
                  : "炸板股单独计入风险，不再用“最新价等于最高价”近似判断。"}
              </div>
            </div>
          )}

          {normalizedRows.length > 0 && (
            <div className="panel sector-board-panel">
              <PanelTitle title="涨停板块排行榜" subtitle="点击板块切换详情；搜索结果不受榜单限制" icon={Layers3} badge={`${normalizedRows.length} 个板块`} />
              <div className="sector-comparison-table">
                <div className="sector-row sector-row-head">
                  <span>排名 / 板块</span><span>涨停扩散</span><span>板块涨幅</span><span>对比全市场</span><span>上涨广度</span><span>1/3/5日超额</span><span>综合强度</span>
                </div>
                {normalizedRows.map((item) => {
                  const excess1 = subtractNullable(item.returns.r1, item.benchmarkReturns.r1);
                  const excess3 = subtractNullable(item.returns.r3, item.benchmarkReturns.r3);
                  const excess5 = subtractNullable(item.returns.r5, item.benchmarkReturns.r5);
                  return (
                  <button className={`sector-row ${!customSector && sector.name === item.name ? "active" : ""}`} key={item.name} onClick={() => { sectorAnalysisRequest.current += 1; setSectorAnalyzing(false); setCustomSector(null); setSelectedName(item.name); }}>
                    <span><b>#{item.rank} {item.name}</b><small>{item.state}</small></span>
                    <span><b>{item.poolLimitUps} 家</b><small>占涨停池 {fmt(item.poolShare * 100, 1)}%</small></span>
                    <span><b className={item.memberAverageReturn == null ? "" : item.memberAverageReturn >= 0 ? "red" : "green"}>{item.memberAverageReturn == null ? "--" : `${item.memberAverageReturn >= 0 ? "+" : ""}${fmt(item.memberAverageReturn)}%`}</b><small>板块成分均涨</small></span>
                    <span><b className={item.relativeReturn == null ? "" : item.relativeReturn >= 0 ? "red" : "green"}>{item.relativeReturn == null ? "--" : `${item.relativeReturn >= 0 ? "+" : ""}${fmt(item.relativeReturn)}%`}</b><small>相对中证全指</small></span>
                    <span><b>{item.breadth == null ? "--" : `${fmt(item.breadth * 100, 0)}%`}</b><small>板块内部</small></span>
                    <span><b>{fmt(excess1)} / {fmt(excess3)} / {fmt(excess5)}</b><small>相对沪深300</small></span>
                    <span><strong>{item.score ?? "--"}</strong><small>质量 {fmt(item.leadershipQualityScore, 0)} · 覆盖 {item.dataCoveragePercent == null ? "--" : `${fmt(item.dataCoveragePercent, 0)}%`}</small></span>
                  </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="sector-analysis-grid">
            <div className="panel sector-score-summary">
              <span>当前板块</span><h2>{sector.name}</h2><strong>{sector.score ?? "--"}</strong><em>{sector.state}</em>
              <p>板块代码 {sector.code || "--"}。{sector.score == null ? "详情源尚未取得足够字段，综合评分暂停。" : `综合强度 ${sector.score} 分，内部质量 ${fmt(sector.leadershipQualityScore, 0)} 分，证据覆盖 ${fmt(sector.dataCoveragePercent, 0)}%。`} 数据源：{sector.dataSource || "--"}；评分用于横向比较，不直接等同于买入信号。</p>
              <div className="leader-tags">
                {(sector.leaders || []).slice(0, 8).map((item: any) => <span key={item.code}>{item.name} <b className={item.changePct == null ? "" : item.changePct >= 0 ? "red" : "green"}>{item.changePct == null ? "--" : `${item.changePct >= 0 ? "+" : ""}${fmt(item.changePct)}%`}</b></span>)}
              </div>
            </div>
            <div className="panel comparison-detail">
              <PanelTitle title="完整收益对比" subtitle={`${sector.name} vs 中证全指 / 沪深300`} icon={Activity} />
              <div className="comparison-periods">
                {[1, 3, 5].map((day) => {
                  const key = `r${day}`;
                  const sectorReturn = nullableNumber(sector.returns[key]);
                  const hs300Excess = subtractNullable(sectorReturn, sector.benchmarkReturns[key]);
                  const marketExcess = subtractNullable(sectorReturn, sector.allMarketReturns?.[key]);
                  return (
                    <div key={day}>
                      <span>{day} 日板块</span>
                      <b className={sectorReturn == null ? "" : sectorReturn >= 0 ? "red" : "green"}>{sectorReturn == null ? "--" : `${sectorReturn >= 0 ? "+" : ""}${fmt(sectorReturn)}%`}</b>
                      <small>中证全指 {sector.allMarketReturns?.[key] == null ? "--" : `${fmt(sector.allMarketReturns[key])}%`} · 沪深300 {sector.benchmarkReturns[key] == null ? "--" : `${fmt(sector.benchmarkReturns[key])}%`}</small>
                      <em className={marketExcess == null ? "" : marketExcess >= 0 ? "red" : "green"}>全市场超额 {marketExcess == null ? "--" : `${marketExcess >= 0 ? "+" : ""}${fmt(marketExcess)}%`}</em>
                      <em className={hs300Excess == null ? "" : hs300Excess >= 0 ? "red" : "green"}>沪深300超额 {hs300Excess == null ? "--" : `${hs300Excess >= 0 ? "+" : ""}${fmt(hs300Excess)}%`}</em>
                    </div>
                  );
                })}
              </div>
              <div className="detail-factor-grid">
                <div><span>板块上涨广度</span><b>{sector.breadth == null ? "--" : `${fmt(sector.breadth * 100, 1)}%`}</b><small>{sector.memberCount ?? "--"} 只成分股内部比较</small></div>
                <div><span>成分股平均涨幅</span><b>{sector.memberAverageReturn == null ? "--" : `${sector.memberAverageReturn >= 0 ? "+" : ""}${fmt(sector.memberAverageReturn)}%`}</b><small>相对中证全指 {sector.relativeReturn == null ? "--" : `${sector.relativeReturn >= 0 ? "+" : ""}${fmt(sector.relativeReturn)}%`}</small></div>
                <div><span>涨停扩散</span><b>{sector.limitUps} 家</b><small>占全市场涨停池 {fmt((sector.poolShare || 0) * 100, 1)}%</small></div>
                <div><span>成交热度</span><b>{sector.amountHeat == null ? "--" : `${fmt(sector.amountHeat)}x`}</b><small>板块成交额 / 15日均额</small></div>
                <div><span>五日持续性</span><b>{sector.persistence == null ? "--" : `${fmt(sector.persistence * 100, 0)}%`}</b><small>5日板块指数收涨比率</small></div>
                <div><span>成分平均换手</span><b>{sector.memberAverageTurnover == null ? "--" : `${fmt(sector.memberAverageTurnover)}%`}</b><small>用于识别热度是否过高</small></div>
                <div><span>上涨股成交参与</span><b>{sector.advancingAmountShare == null ? "--" : `${fmt(sector.advancingAmountShare * 100, 1)}%`}</b><small>上涨成分成交额 / 板块总成交额</small></div>
                <div><span>主力净流入广度</span><b>{sector.positiveInflowRatio == null ? "--" : `${fmt(sector.positiveInflowRatio * 100, 1)}%`}</b><small>主力净流入为正的成分占比</small></div>
                <div><span>头部成交集中度</span><b>{sector.top5AmountShare == null ? "--" : `${fmt(sector.top5AmountShare * 100, 1)}%`}</b><small>前5大成交股占比，过高表示少数股独撑</small></div>
                <div><span>成分涨幅中位数</span><b>{sector.medianMemberReturn == null ? "--" : `${sector.medianMemberReturn >= 0 ? "+" : ""}${fmt(sector.medianMemberReturn, 2)}%`}</b><small>比平均数更不易被极端龙头扭曲</small></div>
                <div><span>涨跌离散度</span><b>{sector.returnDispersion == null ? "--" : `${fmt(sector.returnDispersion, 2)}%`}</b><small>越低代表板块内部同步性越高</small></div>
                <div><span>内部质量评分</span><b>{fmt(sector.leadershipQualityScore, 0)}</b><small>广度、成交参与、资金、集中度、离散度</small></div>
              </div>
            </div>
            <div className="panel sector-history">
              <PanelTitle title="近5日强弱轨迹" subtitle="上方为每日涨跌，下方为成交量柱" icon={Activity} />
              <div className="bar-chart">
                {sectorHistory.map((day: any) => (
                  <div key={day.date} title={`${day.date} ${day.changePct}%`}>
                    <span className={day.changePct >= 0 ? "up" : "down"} style={{ height: `${Math.max(6, Math.min(100, Math.abs(day.changePct) * 20))}%` }} />
                  </div>
                ))}
              </div>
              <div className="sector-volume-head">
                <span>成交量能</span>
                <b className={sector.amountHeat == null ? "" : sector.amountHeat >= 1 ? "red" : "green"}>
                  最近 / 5日均量 {sector.amountHeat == null ? "--" : `${fmt(sector.amountHeat)}x`}
                </b>
              </div>
              <div className="sector-volume-chart">
                {sectorHistory.map((day: any) => {
                  const amount = Number(day.amount || 0);
                  const aboveAverage = averageHistoryAmount > 0 && amount >= averageHistoryAmount;
                  return (
                    <div key={day.date} title={`${day.date} · 成交额 ${fmtMoney(amount)}`}>
                      <span
                        className={aboveAverage ? "hot" : "normal"}
                        style={{ height: `${Math.max(5, (amount / maxHistoryAmount) * 100)}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="sector-volume-legend">
                <span><i className="hot" />高于15日均量</span>
                <span><i />低于15日均量</span>
              </div>
            </div>
          </div>

          <div className="panel sector-members-panel">
            <PanelTitle title={`${sector.name} 成分股明细`} subtitle="包含价格、涨幅、换手、成交额、主力净流入和涨停状态" icon={LayoutDashboard} badge={`${members.length} / ${sector.memberCount}`} />
            <div className="member-toolbar">
              <div>
                {[
                  { id: "all", label: "全部" },
                  { id: "limitUp", label: `涨停 ${sector.limitUps}` },
                  { id: "up", label: "上涨" },
                  { id: "down", label: "下跌" }
                ].map((item) => <button key={item.id} className={memberFilter === item.id ? "active" : ""} onClick={() => setMemberFilter(item.id)}>{item.label}</button>)}
              </div>
              <label><Search size={15} /><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="筛选股票名称或代码" /></label>
            </div>
            <div className="sector-member-table">
              <div className="member-row member-head"><span>股票</span><span>最新价</span><span>涨幅</span><span>换手</span><span>成交额</span><span>主力净流入</span><span>状态</span></div>
              {members.map((item: any) => (
                <button className="member-row" key={item.code} onClick={() => onOpenStock(item)}>
                  <span><b>{item.name}</b><small>{item.code}</small></span>
                  <span>{fmt(item.latest)}</span>
                  <span className={item.changePct >= 0 ? "red" : "green"}>{item.changePct >= 0 ? "+" : ""}{fmt(item.changePct)}%</span>
                  <span>{fmt(item.turnover)}%</span>
                  <span>{fmtMoney(item.amount)}</span>
                  <span className={item.mainNetInflow >= 0 ? "red" : "green"}>{item.mainNetInflow >= 0 ? "+" : ""}{fmtMoney(item.mainNetInflow)}</span>
                  <span>{item.isLimitUp ? <em className="limit-status">涨停</em> : "正常"}</span>
                </button>
              ))}
              {!members.length && <EmptyInline text="当前筛选条件下没有成分股" />}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function NewsView({
  payload,
  watchlist,
  holdings,
  limitUps,
  settings,
  announcementOnly = false,
  onOpenStock
}: {
  payload: AnalysisPayload | null;
  watchlist: WatchItem[];
  holdings: HoldingItem[];
  limitUps: any[];
  settings: Settings;
  announcementOnly?: boolean;
  onOpenStock: (stock: Security) => void;
}) {
  const scopes = [
    { id: "all", label: "全市场" },
    { id: "limitUp", label: `涨停池 ${limitUps.length}` },
    { id: "watchlist", label: `观察池 ${watchlist.length}` },
    { id: "holdings", label: `持仓股 ${holdings.length}` },
    { id: "stock", label: "当前个股", disabled: !payload },
    { id: "sector", label: "当前板块", disabled: !payload?.sector }
  ];
  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("all");
  const [importance, setImportance] = useState("all");
  const [eventType, setEventType] = useState("all");
  const [feed, setFeed] = useState<any>({ items: [], sourceStatus: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const feedRequestId = useRef(0);

  useEffect(() => () => {
    feedRequestId.current += 1;
  }, []);

  const feedInput = useMemo(() => ({
    scope,
    limit: 160,
    limitUps,
    watchlist,
    holdings,
    contentType: announcementOnly ? "announcement" : "all",
    currentStock: payload?.security || null,
    currentSector: payload?.sector?.name || payload?.quote?.industry || ""
  }), [scope, limitUps, watchlist, holdings, announcementOnly, payload?.security?.code, payload?.sector?.name, payload?.quote?.industry]);

  const loadFeed = useCallback(async (force = false) => {
    const requestId = ++feedRequestId.current;
    setLoading(true);
    setError("");
    try {
      const next = force
        ? await window.stockApi.refreshNewsFeed(feedInput)
        : await window.stockApi.getNewsFeed(feedInput);
      if (requestId === feedRequestId.current) setFeed(next);
    } catch (reason) {
      if (requestId === feedRequestId.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestId === feedRequestId.current) setLoading(false);
    }
  }, [feedInput]);

  useEffect(() => {
    loadFeed(false);
  }, [loadFeed]);

  useEffect(() => {
    if (!autoRefresh) return;
    const baseSeconds = Math.max(
      5,
      Number(feed.refreshAfterSeconds || settings.newsRefreshSeconds || 6)
    );
    const intervalSeconds = document.hidden ? Math.max(30, baseSeconds) : baseSeconds;
    const timer = window.setTimeout(() => loadFeed(false), intervalSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, settings.newsRefreshSeconds, feed.refreshAfterSeconds, feed.updatedAt, loadFeed]);

  const visibleItems = (feed.items || []).filter((item: any) => {
    const text = [
      item.title,
      item.summary,
      item.source,
      item.eventType,
      ...(item.relatedSectors || []),
      ...(item.relatedStocks || []).flatMap((stock: any) => [stock.code, stock.name])
    ].join(" ").toLowerCase();
    const matchesImportance = importance === "all" ||
      (importance === "major" && Number(item.importanceScore || 0) >= 75) ||
      (importance === "risk" && (Number(item.riskSeverity || 0) >= 1 || item.direction === "negative")) ||
      (importance === "corrected" && item.status === "corrected");
    return (!announcementOnly || item.type === "announcement") &&
      (!query.trim() || text.includes(query.trim().toLowerCase())) &&
      (direction === "all" || item.direction === direction) &&
      (eventType === "all" || item.eventType === eventType) &&
      matchesImportance;
  });
  const sourceStatus = announcementOnly
    ? (feed.sourceStatus || []).filter((source: any) => ["announcement", "ths"].includes(source.id))
    : (feed.sourceStatus || []);
  const levelACount = visibleItems.filter((item: any) => item.sourceLevel === "A").length;
  const freshCount = visibleItems.filter((item: any) => item.ageMinutes <= 30).length;
  const riskCount = visibleItems.filter((item: any) => item.riskSeverity >= 2).length;
  const directionName: Record<string, string> = {
    positive: "正向",
    negative: "风险",
    mixed: "多空混合",
    neutral: "中性"
  };
  const ageText = (minutes: number) =>
    minutes < 1 ? "刚刚" :
      minutes < 60 ? `${minutes}分钟前` :
        minutes < 1440 ? `${Math.floor(minutes / 60)}小时前` : `${Math.floor(minutes / 1440)}天前`;

  return (
    <>
      <PageHeading
        eyebrow={announcementOnly ? "A-SHARE DISCLOSURE CENTER" : "REAL-TIME INFORMATION RADAR"}
        title={announcementOnly ? "A股公告" : "资讯雷达"}
        description={announcementOnly
          ? "集中查看沪深北A股公司公告，按持仓、自选、事件类型、重要性与风险快速筛选。"
          : "准实时聚合 7×24 快讯与公司公告；可信度、方向和影响强度分别计算。"}
        actions={
          <>
            <button
              type="button"
              className={`secondary-btn news-live-switch ${autoRefresh ? "active" : ""}`}
              aria-pressed={autoRefresh}
              onClick={() => setAutoRefresh((value) => !value)}
            >
              <span className="live-dot" />{autoRefresh ? "自动刷新中" : "自动刷新已停"}
            </button>
            <button type="button" className="primary-btn" disabled={loading} onClick={() => loadFeed(true)}>
              <RefreshCw size={17} className={loading ? "spin" : ""} />立即刷新
            </button>
          </>
        }
      />

      <div
        className="news-mode-banner"
        data-announcement-module={announcementOnly ? true : undefined}
        data-content-type={announcementOnly ? "announcement" : "all"}
      >
        <Wifi size={17} />
        <b>{feed.mode || "准实时"}</b>
        <span>最后更新 {feed.updatedAt ? new Date(feed.updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "--"}</span>
        <small>{announcementOnly ? "公司公告15秒复核；同花顺增强源30秒复核" : (feed.collectionPolicy || "快讯10秒轮询；公告低频复核")}。源平台发布时间延迟另计，“待行情确认”不会被伪装成已确认。</small>
      </div>

      <div className="news-source-strip">
        {sourceStatus.map((source: any) => (
          <div className={source.ok === false ? "failed" : source.ok === null ? "idle" : "online"} key={source.id}>
            <span /><b>{source.name}</b><em>{source.level}级</em><small>{source.message}{source.pollSeconds ? ` · ${source.pollSeconds}秒轮询` : ""}</small>
          </div>
        ))}
      </div>

      <div className="news-overview-grid">
        <div className="panel">{announcementOnly ? <FileText size={19} /> : <Newspaper size={19} />}<span>当前范围</span><b>{visibleItems.length}</b><small>{announcementOnly ? "去重后的公司公告" : "去重后的资讯事件"}</small></div>
        <div className="panel"><ShieldCheck size={19} /><span>A级原始源</span><b>{levelACount}</b><small>官方披露或官方接口</small></div>
        <div className="panel"><Zap size={19} /><span>30分钟内</span><b>{freshCount}</b><small>按原始发布时间</small></div>
        <div className={`panel ${riskCount ? "risk" : ""}`}><ShieldAlert size={19} /><span>重要风险</span><b>{riskCount}</b><small>风险等级高</small></div>
      </div>

      <div className="panel news-control-panel">
        <div className="news-scope-tabs">
          {scopes.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              className={scope === item.id ? "active" : ""}
              aria-pressed={scope === item.id}
              onClick={() => setScope(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="news-filters">
          <label>
            <Search size={16} />
            <input
              value={query}
              aria-label={announcementOnly ? "搜索A股公告" : "搜索资讯"}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={announcementOnly ? "搜索股票、公告标题、事件关键词" : "搜索股票、板块、事件关键词"}
            />
          </label>
          <FilterChipGroup
            label="方向"
            icon={<Filter size={15} />}
            value={direction}
            onChange={setDirection}
            options={[
              { id: "all", label: "全部方向" },
              { id: "positive", label: "正向" },
              { id: "negative", label: "风险" },
              { id: "mixed", label: "多空混合" },
              { id: "neutral", label: "中性" }
            ]}
          />
          {announcementOnly && <FilterChipGroup
            label="重要性"
            icon={<Gauge size={15} />}
            value={importance}
            onChange={setImportance}
            options={[
              { id: "all", label: "全部重要性" },
              { id: "major", label: "重大" },
              { id: "risk", label: "风险" },
              { id: "corrected", label: "更正/修订" }
            ]}
          />}
          {announcementOnly && <FilterChipGroup
            label="公告类型"
            icon={<FileText size={15} />}
            value={eventType}
            onChange={setEventType}
            options={["all", "业绩", "股东行为", "并购重组", "监管风险", "经营订单", "公司公告"].map((item) => ({
              id: item,
              label: item === "all" ? "全部类型" : item
            }))}
          />}
        </div>
      </div>

      {error && <div className="warning-banner"><CircleAlert size={17} />{error}</div>}

      <div className="news-radar-layout">
        <div className="panel realtime-news-list">
          <PanelTitle
            title={announcementOnly ? `A股公告 · ${scopes.find((item) => item.id === scope)?.label || "全市场"}` : (scopes.find((item) => item.id === scope)?.label || "资讯")}
            subtitle={announcementOnly ? "按披露时间倒序；同一公告的聚合转载自动合并" : "按原始发布时间倒序；重复转载自动合并"}
            icon={announcementOnly ? FileText : Activity}
            badge={`${visibleItems.length} 条`}
          />
          {loading && !visibleItems.length ? <LoadingState /> : visibleItems.map((item: any) => (
            <article className={`realtime-news-card ${item.direction} ${item.riskSeverity >= 2 ? "major-risk" : ""}`} key={item.id}>
              <div className="news-card-rail">
                <span className={`source-level level-${item.sourceLevel}`}>{item.sourceLevel}</span>
                <i />
              </div>
              <div className="news-card-body">
                <div className="news-card-meta">
                  <time>{item.publishedAt?.slice(5, 16)} · {ageText(item.ageMinutes || 0)}</time>
                  <span>{item.source}</span>
                  <em className={`direction ${item.direction}`}>{directionName[item.direction] || item.direction}</em>
                  <em>{item.eventType}</em>
                  {item.duplicateCount > 1 && <em>合并 {item.duplicateCount} 条</em>}
                </div>
                <h3>{item.title}</h3>
                {item.summary && <p>{item.summary}</p>}
                <div className="news-score-row">
                  <span>可信度 <b>{item.credibilityScore}</b></span>
                  <span>重要性 <b>{item.importanceScore}</b></span>
                  <span>新鲜度 <b>{item.freshnessScore}</b></span>
                  <span>影响周期 <b>{item.impactHorizon}</b></span>
                  <span className="pending">行情确认 <b>{item.marketConfirmation}</b></span>
                </div>
                <div className="news-relations">
                  {(item.relatedSectors || []).map((sector: string) => <span key={sector}>板块 · {sector}</span>)}
                  {(item.relatedStocks || []).slice(0, 8).map((stock: any) => (
                    <button key={`${item.id}-${stock.code}`} onClick={() => onOpenStock(stock)}>
                      {stock.name || stock.code}<small>{stock.code}</small>
                    </button>
                  ))}
                  {!item.relatedSectors?.length && !item.relatedStocks?.length && <small>尚未建立A股直接映射</small>}
                </div>
                <div className="news-card-footer">
                  <span>首次发现 {new Date(item.firstSeenAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                  <span>{item.reasons?.[0]}</span>
                  <button onClick={() => window.stockApi.openExternal(item.sourceUrl)}>查看原文 <ExternalLink size={14} /></button>
                </div>
              </div>
            </article>
          ))}
          {!loading && !visibleItems.length && (
            <div className="empty-state">{announcementOnly ? <FileText size={32} /> : <Newspaper size={32} />}<h3>当前范围暂无匹配{announcementOnly ? "公告" : "资讯"}</h3><p>可切换到全市场或清除筛选条件。</p></div>
          )}
        </div>

        <aside className="panel news-method-panel">
          <PanelTitle title={announcementOnly ? "公告判定规则" : "信息判定规则"} subtitle="不把“重要利空”误判为低价值" icon={Gauge} />
          {announcementOnly ? <>
            <div><b>官方原文优先</b><p>A级表示链接可核验至交易所或巨潮等官方披露平台；聚合页面明确标记为B级。</p></div>
            <div><b>公告分类</b><p>业绩、股东行为、并购重组、监管风险和经营订单按标题关键词分类。</p></div>
            <div><b>重大与风险分开</b><p>重要性衡量潜在影响，风险等级衡量负面强度；重大利空不会被隐藏。</p></div>
            <div><b>更正与修订</b><p>标题包含“更正”或“修订”的公告可单独筛选，避免沿用旧版本结论。</p></div>
            <div><b>行情确认</b><p>公告事实与市场反应分开呈现，初始保持“待行情确认”。</p></div>
          </> : <>
            <div><b>A级来源</b><p>公司公告和官方披露，用于确认事实。</p></div>
            <div><b>B级来源</b><p>7×24市场快讯，用于快速发现，仍需公告或行情验证。</p></div>
            <div><b>方向与重要性分开</b><p>重大利空会显示“高重要性、高风险”，不会因为方向为负而被隐藏。</p></div>
            <div><b>旧闻与重复</b><p>按原始发布时间判断新鲜度；标题相同且时间接近的转载会合并。</p></div>
            <div><b>市场确认</b><p>只有后续量价与板块扩散满足条件才会改为“已确认”，初始一律待确认。</p></div>
          </>}
        </aside>
      </div>
    </>
  );
}

function SettingsView({ value, onSave }: { value: Settings; onSave: (next: Settings) => Promise<void> }) {
  const [draft, setDraftState] = useState<Settings>({ ...value, provider: "ths" });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const settingsMounted = useRef(true);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyFields = useRef<Set<keyof Settings>>(new Set());
  const draftRevision = useRef(0);
  const setDraft = useCallback((next: Settings | ((current: Settings) => Settings)) => {
    const current = draftRef.current;
    const resolved = typeof next === "function" ? next(current) : next;
    const changedFields = (Object.keys(resolved) as Array<keyof Settings>)
      .filter((field) => !Object.is(current[field], resolved[field]));
    if (changedFields.length) {
      draftRevision.current += 1;
      changedFields.forEach((field) => dirtyFields.current.add(field));
    }
    draftRef.current = resolved;
    setDraftState(resolved);
  }, []);
  useEffect(() => {
    settingsMounted.current = true;
    return () => {
      settingsMounted.current = false;
    };
  }, []);
  useEffect(() => {
    const merged = mergeSettingsDraft(draftRef.current, value, dirtyFields.current);
    draftRef.current = merged;
    setDraftState(merged);
  }, [value]);
  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.stockApi.testProvider(draft);
      if (settingsMounted.current) setTestResult(result);
    } catch (error) {
      if (settingsMounted.current) {
        setTestResult({
          ok: false,
          message: error instanceof Error ? error.message : "连接测试失败，请检查网络或数据源设置"
        });
      }
    } finally {
      if (settingsMounted.current) setTesting(false);
    }
  };
  const toggleStrategy = (id: string) => {
    if (id === "riskVeto") return;
    const current = draft.selectedStrategies || [];
    setDraft({
      ...draft,
      selectedStrategies: current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    });
  };
  const applyRiskProfile = (profile: Settings["riskProfile"]) => {
    const preset = riskProfilePresets.find((item) => item.id === profile);
    if (!preset) {
      setDraft((current) => ({ ...current, riskProfile: "balanced" }));
      return;
    }
    setDraft((current) => ({
      ...current,
      riskProfile: preset.id,
      ...preset.settings
    }));
  };
  const activeRiskProfile = riskProfilePresets.find((item) => item.id === draft.riskProfile) || riskProfilePresets[0]!;
  const saveDraft = async () => {
    if (saving) return;
    const submittedRevision = draftRevision.current;
    const normalizedDraft: Settings = {
      ...draft,
    provider: "ths",
    riskProfile: normalizeRiskProfile(draft.riskProfile),
    maxDailyRiskPercent: clampNumber(draft.maxDailyRiskPercent, 0.3, 12, 3.2),
    maxPortfolioRiskPercent: clampNumber(draft.maxPortfolioRiskPercent, 10, 100, 70),
    maxSectorExposurePercent: clampNumber(draft.maxSectorExposurePercent, 10, 100, 45),
    minExecutionRatePercent: clampNumber(draft.minExecutionRatePercent, 40, 100, 90),
    trailingStopPercent: clampNumber(draft.trailingStopPercent, 0, 25, 3),
    minProjectedNetEdgePercent: clampNumber(draft.minProjectedNetEdgePercent, -2, 10, 0.2),
    minExpectancyPoints: clampNumber(draft.minExpectancyPoints, -2, 5, 0.2),
    maxConsecutiveLossesForStop: Math.round(clampNumber(draft.maxConsecutiveLossesForStop, 2, 12, 4)),
    lossStreakStepPercent: clampNumber(draft.lossStreakStepPercent, 2, 60, 18),
    lossStreakFloorPercent: clampNumber(draft.lossStreakFloorPercent, 10, 80, 30),
    commissionBps: clampNumber(draft.commissionBps, 0, 40, 7),
    slippageBps: clampNumber(draft.slippageBps, 0, 40, 2),
    minTurnoverPercent: clampNumber(draft.minTurnoverPercent, 0, 20, 0.4),
    minQuoteAmount: clampNumber(draft.minQuoteAmount, 0, 1_000_000_000, 1200000),
    maxQuoteAgeSeconds: clampNumber(draft.maxQuoteAgeSeconds, 30, 1800, 480),
    maxDailyTrades: Math.round(clampNumber(draft.maxDailyTrades, 1, 200, 12)),
    timeDecayPerBarPercent: clampNumber(draft.timeDecayPerBarPercent, 0, 1, 0.11),
    maxOpenPositions: Math.round(clampNumber(draft.maxOpenPositions, 1, 10, 2)),
    strictGate: Boolean(draft.strictGate),
    enabledPaperSim: Boolean(draft.enabledPaperSim),
    minMarketCap: clampNumber(draft.minMarketCap, 0, 100000, 0),
    minPaperWinRatePercent: clampNumber(draft.minPaperWinRatePercent, 40, 90, 52),
    minPaperRiskRewardRatio: clampNumber(draft.minPaperRiskRewardRatio, 1, 3, 1.15),
    maxPositionPercent: clampNumber(draft.maxPositionPercent, 5, 90, 28),
    maxRiskPerTradePercent: clampNumber(draft.maxRiskPerTradePercent, 0.2, 5, 1),
    stopLossATRMultiple: Math.max(clampNumber(draft.stopLossATRMultiple, 0.8, 5, 1.8), 0.6),
    takeProfitATRMultiple: Math.max(
      clampNumber(draft.takeProfitATRMultiple, 0.8, 10, 3.2),
      clampNumber(draft.stopLossATRMultiple, 0.8, 5, 1.8) + 0.2
    ),
    maxHoldingBars: Math.round(clampNumber(draft.maxHoldingBars, 3, 120, 30)),
    alertScore: clampNumber(draft.alertScore, 50, 95, 75),
    quoteRefreshSeconds: clampNumber(draft.quoteRefreshSeconds, 3, 20, 5),
    refreshSeconds: clampNumber(draft.refreshSeconds, 30, 300, 90),
    newsRefreshSeconds: clampNumber(draft.newsRefreshSeconds, 5, 45, 6),
      selectedStrategies: [...new Set([...(draft.selectedStrategies || []), "riskVeto"])]
    };
    setSaving(true);
    setSaveError("");
    try {
      await onSave(normalizedDraft);
      if (settingsMounted.current && draftRevision.current === submittedRevision) {
        dirtyFields.current.clear();
        draftRef.current = normalizedDraft;
        setDraftState(normalizedDraft);
      }
    } catch (error) {
      if (settingsMounted.current) {
        setSaveError(error instanceof Error ? error.message : "设置保存失败，请稍后重试");
      }
    } finally {
      if (settingsMounted.current) setSaving(false);
    }
  };
  return (
    <>
      <PageHeading eyebrow="THREE-LINE MARKET DATA" title="数据源设置" description="同花顺为主源；东方财富与腾讯并行校验和故障接力。Refresh Token 只加密保存在本机。" />
      <div className="settings-grid">
        <div className="panel settings-card">
          <PanelTitle title="行情主数据源" subtitle="默认同花顺主源，三线并存" icon={Database} />
          <div className="provider-options">
            <label className="selected">
              <input type="radio" checked readOnly />
              <span className="provider-icon ths">同</span>
              <span><b>同花顺 QuantAPI · 主源</b><small>优先用于实时报价、分析历史和板块成分</small></span>
              <i />
            </label>
            <label>
              <input type="radio" checked={false} disabled />
              <span className="provider-icon free"><Wifi size={19} /></span>
              <span><b>东方财富 · 次源</b><small>同花顺缺 Token、限流或超时时自动接力</small></span>
              <i />
            </label>
          </div>
          <div className="three-source-topology" aria-label="三线行情结构">
            <div className="source-lane source-lane-primary">
              <b>① 同花顺</b>
              <small>{draft.refreshToken ? "主源：行情与历史" : "主源待配置 Refresh Token"}</small>
            </div>
            <div className="source-lane">
              <b>② 东方财富</b>
              <small>实时交叉校验 · 首个免费接力</small>
            </div>
            <div className="source-lane">
              <b>③ 腾讯</b>
              <small>实时交叉校验 · 第二接力</small>
            </div>
          </div>
          {(draft.provider === "ths" || draft.multiSourceEnabled) && (
            <label className="field">
              <span>Refresh Token</span>
              <input type="password" value={draft.refreshToken} onChange={(e) => setDraft({ ...draft, refreshToken: e.target.value })} placeholder="从同花顺超级命令或账号详情获取" />
              <small>同花顺主源必需；凭据仅加密保存在本机，不会上传或显示明文。</small>
            </label>
          )}
          <label className="switch-row">
            <span><b>三线并行校验</b><small>同花顺主源；东方财富与腾讯同时校验。任一路失败会保留状态并由可用通道接力。</small></span>
            <input type="checkbox" checked={draft.multiSourceEnabled} onChange={(e) => setDraft({ ...draft, multiSourceEnabled: e.target.checked })} />
            <i />
          </label>
          {draft.multiSourceEnabled && (
            <label className="field">
              <span>Tushare Token <b>可选</b></span>
              <input type="password" value={draft.tushareToken} onChange={(e) => setDraft({ ...draft, tushareToken: e.target.value })} placeholder="用于盘后日线与历史数据复核" />
              <small>Tushare实时/特色接口可能需要积分或单独权限；未配置不会影响免费模式。</small>
            </label>
          )}
          <label className="switch-row">
            <span><b>自动降级</b><small>同花顺权限不足或超时，自动切到免费行情。</small></span>
            <input type="checkbox" checked={draft.fallbackEnabled} onChange={(e) => setDraft({ ...draft, fallbackEnabled: e.target.checked })} />
            <i />
          </label>
          <div className="settings-actions">
            <button className="secondary-btn" onClick={test}>{testing ? <LoaderCircle className="spin" size={17} /> : <Wifi size={17} />}测试连接</button>
            <button className="primary-btn" onClick={() => void saveDraft()} disabled={saving}>{saving ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}{saving ? "正在保存" : "保存设置"}</button>
          </div>
          {saveError && <div className="test-result fail" role="alert"><span />{saveError}</div>}
          {testResult && <div className={`test-result ${testResult.ok ? "ok" : "fail"}`}><span />{testResult.message}<small>{testResult.latency} ms</small></div>}
        </div>

        <div className="panel settings-card">
          <PanelTitle title="监控策略" subtitle="额度与提醒" icon={Gauge} />
          <label className="field">
            <span>当前个股报价 <b>{draft.quoteRefreshSeconds} 秒</b></span>
            <input type="range" min="3" max="30" step="1" value={draft.quoteRefreshSeconds} onChange={(e) => setDraft({ ...draft, quoteRefreshSeconds: Number(e.target.value) })} />
            <small>只拉最新价、高低价、成交额和换手；不会重复运行完整策略。</small>
          </label>
          <label className="field">
            <span>完整策略重算 <b>{draft.refreshSeconds} 秒</b></span>
            <input type="range" min="60" max="300" step="30" value={draft.refreshSeconds} onChange={(e) => setDraft({ ...draft, refreshSeconds: Number(e.target.value) })} />
            <small>重算板块、资讯、历史统计和风险项；默认90秒。</small>
          </label>
          <label className="field">
            <span>资讯页面轮询 <b>{draft.newsRefreshSeconds} 秒</b></span>
            <input type="range" min="5" max="30" step="1" value={draft.newsRefreshSeconds} onChange={(e) => setDraft({ ...draft, newsRefreshSeconds: Number(e.target.value) })} />
            <small>财联社与财经快讯10秒缓存，公告15秒复核；源平台发布时间延迟另计。</small>
          </label>
          <label className="switch-row">
            <span><b>重大资讯自动语音播报</b><small>只播报新出现的高重要性、重大风险或高可信事项，普通资讯保持静默。</small></span>
            <input type="checkbox" checked={draft.newsVoiceEnabled !== false} onChange={(e) => setDraft({ ...draft, newsVoiceEnabled: e.target.checked })} />
            <i />
          </label>
          <label className="field">
            <span>提醒分数线 <b>{draft.alertScore} 分</b></span>
            <input type="range" min="50" max="90" step="5" value={draft.alertScore} onChange={(e) => setDraft({ ...draft, alertScore: Number(e.target.value) })} />
            <small>MRS 达到该阈值时进入重点关注。</small>
          </label>
          <label className="switch-row">
            <span><b>只提醒精确节点</b><small>仅在 T+3 / T+5 / T+7 / T+9 触发。</small></span>
            <input type="checkbox" checked={draft.exactNodesOnly} onChange={(e) => setDraft({ ...draft, exactNodesOnly: e.target.checked })} />
            <i />
          </label>
          <div className="api-note">
            <CircleAlert size={18} />
            <p><b>免费模式边界</b>不抓客户端隐藏接口，不提供 Level-2、逐笔委托或自动交易。所有信号用于研究与监控。</p>
          </div>
        </div>

        <div className="panel settings-card">
          <PanelTitle title="交易执行参数" subtitle="定义仓位、成本与风控边界后才进入实盘执行评估" icon={Target} />
          <div className="provider-options">
            {riskProfilePresets.map((profile) => {
              const isSelected = draft.riskProfile === profile.id;
              return (
                <label key={profile.id} className={isSelected ? "selected" : ""}>
                  <input
                    type="radio"
                    checked={isSelected}
                    onChange={() => applyRiskProfile(profile.id)}
                  />
                  <span className="provider-icon free"><ShieldAlert size={16} /></span>
                  <span><b>{profile.name}</b><small>{profile.detail}</small></span>
                  <i />
                </label>
              );
            })}
          </div>
          <div className="api-note">
            <ShieldAlert size={18} />
            <p>
              <b>{activeRiskProfile.name}</b>：切换后会一次性覆盖以上执行参数。你可在下方继续手动微调，避免与个人风格偏差。
            </p>
          </div>
          <label className="field">
            <span>最大仓位 <b>{draft.maxPositionPercent}%</b></span>
            <input type="range" min="5" max="90" step="1" value={draft.maxPositionPercent} onChange={(e) => setDraft({ ...draft, maxPositionPercent: Number(e.target.value) })} />
            <small>单笔标的建议的上限仓位，超过后仅按上限比例下单。</small>
          </label>
          <label className="field">
            <span>日内最大交易 <b>{draft.maxDailyTrades ?? 12}</b></span>
            <input type="range" min="1" max="200" step="1" value={draft.maxDailyTrades ?? 12} onChange={(e) => setDraft({ ...draft, maxDailyTrades: Number(e.target.value) })} />
            <small>今日达到上限后拒绝新开仓，限制高频交易失控。</small>
          </label>
          <label className="field">
            <span>单笔风险上限 <b>{draft.maxRiskPerTradePercent}%</b></span>
            <input type="range" min="0.2" max="5" step="0.1" value={draft.maxRiskPerTradePercent} onChange={(e) => setDraft({ ...draft, maxRiskPerTradePercent: Number(e.target.value) })} />
            <small>按仓位和止损距离折算，超过该比例即拒绝该交易。</small>
          </label>
          <label className="field">
            <span>止损 ATR 倍数 <b>{draft.stopLossATRMultiple}</b></span>
            <input type="range" min="0.8" max="5" step="0.1" value={draft.stopLossATRMultiple} onChange={(e) => setDraft({ ...draft, stopLossATRMultiple: Number(e.target.value) })} />
            <small>越大越保守，建议 1.8 ~ 3.2。</small>
          </label>
          <label className="field">
            <span>止盈 ATR 倍数 <b>{draft.takeProfitATRMultiple}</b></span>
            <input type="range" min="1.0" max="10" step="0.1" value={draft.takeProfitATRMultiple} onChange={(e) => setDraft({ ...draft, takeProfitATRMultiple: Number(e.target.value) })} />
            <small>建议保持高于止损 0.2 倍及以上，且不低于 2.5。</small>
          </label>
          <label className="field">
            <span>最大持仓窗口 <b>{draft.maxHoldingBars}</b></span>
            <input type="range" min="3" max="120" step="1" value={draft.maxHoldingBars} onChange={(e) => setDraft({ ...draft, maxHoldingBars: Number(e.target.value) })} />
            <small>超过后触发时间退出逻辑，避免资金长期被套。</small>
          </label>
          <label className="field">
            <span>最小成交率 <b>{draft.minExecutionRatePercent ?? 90}%</b></span>
            <input type="range" min="40" max="100" step="1" value={draft.minExecutionRatePercent ?? 90} onChange={(e) => setDraft({ ...draft, minExecutionRatePercent: Number(e.target.value) })} />
            <small>低于该成交率时拒绝开仓，降低滑点与未成交风险。</small>
          </label>
          <label className="field">
            <span>追踪止损 <b>{draft.trailingStopPercent ?? 3}%</b></span>
            <input type="range" min="0" max="25" step="0.5" value={draft.trailingStopPercent ?? 3} onChange={(e) => setDraft({ ...draft, trailingStopPercent: Number(e.target.value) })} />
            <small>持仓后价格从高点回撤该比例时触发止损退出。</small>
          </label>
          <label className="field">
            <span>最大持仓数 <b>{draft.maxOpenPositions}</b></span>
            <input type="range" min="1" max="10" step="1" value={draft.maxOpenPositions ?? 2} onChange={(e) => setDraft({ ...draft, maxOpenPositions: Number(e.target.value) })} />
            <small>限制同时持有标的数量，降低系统性交易风险。</small>
          </label>
          <label className="field">
            <span>最小预期净收益 <b>{draft.minProjectedNetEdgePercent ?? 0.2}%</b></span>
            <input type="range" min="-2" max="3" step="0.05" value={draft.minProjectedNetEdgePercent ?? 0.2} onChange={(e) => setDraft({ ...draft, minProjectedNetEdgePercent: Number(e.target.value) })} />
            <small>低于该净收益的信号会在执行前自动挂起。</small>
          </label>
          <label className="field">
            <span>最小期望值 <b>{draft.minExpectancyPoints ?? 0.2}</b></span>
            <input type="range" min="-2" max="5" step="0.05" value={draft.minExpectancyPoints ?? 0.2} onChange={(e) => setDraft({ ...draft, minExpectancyPoints: Number(e.target.value) })} />
            <small>期望值越低说明该信号对组合贡献不足。</small>
          </label>
          <label className="field">
            <span>单日连续亏损停手 <b>{draft.maxConsecutiveLossesForStop ?? 4}</b></span>
            <input type="range" min="2" max="10" step="1" value={draft.maxConsecutiveLossesForStop ?? 4} onChange={(e) => setDraft({ ...draft, maxConsecutiveLossesForStop: Number(e.target.value) })} />
            <small>连续亏损达到上限后，今日禁止新开仓。</small>
          </label>
          <label className="field">
            <span>减仓步幅 % <b>{draft.lossStreakStepPercent ?? 18}%</b></span>
            <input type="range" min="2" max="30" step="1" value={draft.lossStreakStepPercent ?? 18} onChange={(e) => setDraft({ ...draft, lossStreakStepPercent: Number(e.target.value) })} />
            <small>每多一笔连续亏损，仓位将按步幅下调。</small>
          </label>
          <label className="field">
            <span>减仓下限 % <b>{draft.lossStreakFloorPercent ?? 30}%</b></span>
            <input type="range" min="10" max="80" step="1" value={draft.lossStreakFloorPercent ?? 30} onChange={(e) => setDraft({ ...draft, lossStreakFloorPercent: Number(e.target.value) })} />
            <small>连续亏损严重时，单笔仓位不低于该比例。</small>
          </label>
          <label className="field">
            <span>日内最大风险 <b>{draft.maxDailyRiskPercent} %</b></span>
            <input type="range" min="0.3" max="12" step="0.1" value={draft.maxDailyRiskPercent ?? 3.2} onChange={(e) => setDraft({ ...draft, maxDailyRiskPercent: Number(e.target.value) })} />
            <small>超过阈值时触发 Kill Switch，停止新交易。</small>
          </label>
          <label className="field">
            <span>最低日内胜率 <b>{draft.minPaperWinRatePercent ?? 52}%</b></span>
            <input type="range" min="40" max="90" step="1" value={draft.minPaperWinRatePercent ?? 52} onChange={(e) => setDraft({ ...draft, minPaperWinRatePercent: Number(e.target.value) })} />
            <small>当日胜率不足将进入复核提示，不建议直接下单。</small>
          </label>
          <label className="field">
            <span>最低风险收益比 <b>{draft.minPaperRiskRewardRatio ?? 1.15}x</b></span>
            <input type="range" min="1" max="3" step="0.05" value={draft.minPaperRiskRewardRatio ?? 1.15} onChange={(e) => setDraft({ ...draft, minPaperRiskRewardRatio: Number(e.target.value) })} />
            <small>风险收益比低于阈值后仅在复核后允许开仓。</small>
          </label>
          <label className="field">
            <span>组合持仓上限 <b>{draft.maxPortfolioRiskPercent}%</b></span>
            <input type="range" min="10" max="100" step="1" value={draft.maxPortfolioRiskPercent ?? 70} onChange={(e) => setDraft({ ...draft, maxPortfolioRiskPercent: Number(e.target.value) })} />
            <small>当持仓估值超过该占比时触发熔断，避免单日仓位过度集中。</small>
          </label>
          <label className="field">
            <span>行业集中度上限 <b>{draft.maxSectorExposurePercent ?? 45}%</b></span>
            <input type="range" min="10" max="100" step="1" value={draft.maxSectorExposurePercent ?? 45} onChange={(e) => setDraft({ ...draft, maxSectorExposurePercent: Number(e.target.value) })} />
            <small>单一行业持仓超该占比时触发降仓/拒单，控制行业集中风险。</small>
          </label>
          <label className="field">
            <span>佣金 BPS <b>{draft.commissionBps}</b></span>
            <input type="range" min="0" max="40" step="0.1" value={draft.commissionBps ?? 7} onChange={(e) => setDraft({ ...draft, commissionBps: Number(e.target.value) })} />
            <small>交易成本评估时使用的固定佣金，单位：BPS。</small>
          </label>
          <label className="field">
            <span>滑点 BPS <b>{draft.slippageBps}</b></span>
            <input type="range" min="0" max="40" step="0.1" value={draft.slippageBps ?? 2} onChange={(e) => setDraft({ ...draft, slippageBps: Number(e.target.value) })} />
            <small>每次成交的隐含滑点估计，单位：BPS。</small>
          </label>
          <label className="field">
            <span>时间衰减/Bar <b>{draft.timeDecayPerBarPercent ?? 0.11}%</b></span>
            <input type="range" min="0" max="1" step="0.01" value={draft.timeDecayPerBarPercent ?? 0.11} onChange={(e) => setDraft({ ...draft, timeDecayPerBarPercent: Number(e.target.value) })} />
            <small>时间越久，信号有效性折损越快。</small>
          </label>
          <label className="field">
            <span>最小市值过滤 <b>{draft.minMarketCap} 亿</b></span>
            <input type="range" min="0" max="100000" step="100" value={draft.minMarketCap ?? 0} onChange={(e) => setDraft({ ...draft, minMarketCap: Number(e.target.value) })} />
            <small>低于阈值可直接过滤，0 表示不限制。</small>
          </label>
          <label className="field">
            <span>最低成交额 <b>{draft.minQuoteAmount ?? 1200000}</b></span>
            <input type="range" min="0" max="8000000" step="100000" value={draft.minQuoteAmount ?? 1200000} onChange={(e) => setDraft({ ...draft, minQuoteAmount: Number(e.target.value) })} />
            <small>成交额低于阈值视为流动性不足，默认按「元」计。</small>
          </label>
          <label className="field">
            <span>最低换手率 <b>{draft.minTurnoverPercent ?? 0.4}%</b></span>
            <input type="range" min="0" max="10" step="0.05" value={draft.minTurnoverPercent ?? 0.4} onChange={(e) => setDraft({ ...draft, minTurnoverPercent: Number(e.target.value) })} />
            <small>换手率低于阈值时不允许快速放量开仓。</small>
          </label>
          <label className="field">
            <span>行情新鲜度阈值 <b>{draft.maxQuoteAgeSeconds ?? 480}s</b></span>
            <input type="range" min="30" max="1800" step="15" value={draft.maxQuoteAgeSeconds ?? 480} onChange={(e) => setDraft({ ...draft, maxQuoteAgeSeconds: Number(e.target.value) })} />
            <small>最新快照超过该秒数不参与执行打分。</small>
          </label>
          <label className="switch-row">
            <span><b>严格闸门</b><small>开启后需同时满足历史/策略拟合与市值通过条件才出信号。</small></span>
            <input type="checkbox" checked={draft.strictGate !== false} onChange={(e) => setDraft({ ...draft, strictGate: e.target.checked })} />
            <i />
          </label>
          <label className="switch-row">
            <span><b>仅纸面模拟</b><small>避免真实下单，仅保留执行评估和日志，不触发实盘委托。</small></span>
            <input type="checkbox" checked={draft.enabledPaperSim !== false} onChange={(e) => setDraft({ ...draft, enabledPaperSim: e.target.checked })} />
            <i />
          </label>
          <div className="settings-actions">
            <button className="secondary-btn" onClick={() => void saveDraft()} disabled={saving}><ShieldCheck size={17} />{saving ? "正在保存" : "保存执行参数"}</button>
          </div>
          {saveError && <div className="test-result fail" role="alert"><span />{saveError}</div>}
        </div>

        <div className="panel settings-card strategy-config-card">
          <PanelTitle title="自主策略组合" subtitle="勾选后会参与个股匹配和预警判定，可自由组合" icon={SlidersHorizontal} badge={`${draft.selectedStrategies?.length || 0} 项已启用`} />
          <div className="strategy-option-grid">
            {strategyOptions.map((item) => {
              const selected = draft.selectedStrategies?.includes(item.id);
              return (
                <button key={item.id} disabled={item.id === "riskVeto"} className={`${selected ? "selected" : ""} ${item.id === "riskVeto" ? "locked" : ""}`} onClick={() => toggleStrategy(item.id)}>
                  <span>{selected ? "✓" : "+"}</span>
                  <div><b>{item.name}{item.id === "riskVeto" ? " · 始终启用" : ""}</b><small>{item.detail}</small></div>
                </button>
              );
            })}
          </div>
          <div className="strategy-presets">
            <span>快捷组合</span>
            {strategyPresets.map((preset) => (
              <button key={preset.id} onClick={() => setDraft({ ...draft, selectedStrategies: preset.strategies })}>{preset.name}</button>
            ))}
            <button onClick={() => setDraft({ ...draft, selectedStrategies: strategyOptions.map((item) => item.id) })}>全部条件</button>
          </div>
          <div className="settings-actions">
            <button className="primary-btn" onClick={() => void saveDraft()} disabled={saving}><ShieldCheck size={17} />{saving ? "正在保存" : "保存策略组合"}</button>
          </div>
          {saveError && <div className="test-result fail" role="alert"><span />{saveError}</div>}
        </div>
      </div>
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="metric"><span>{label}</span><b className={tone || ""}>{value}</b></div>;
}

function PanelTitle({ title, subtitle, icon: Icon, badge }: any) {
  return (
    <div className="panel-title">
      <div className="panel-title-icon"><Icon size={17} /></div>
      <div><h3>{title}</h3><p>{subtitle}</p></div>
      {badge && <span>{badge}</span>}
    </div>
  );
}

function MiniBar({ label, value }: { label: string; value: number }) {
  return <div className="mini-bar"><span>{label}<b>{value}</b></span><i><em style={{ width: `${value}%` }} /></i></div>;
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="fact"><span>{label}</span><b className={tone || ""}>{value}</b></div>;
}

function SignalCard({ icon: Icon, label, value, detail, good }: any) {
  return <div className={`panel signal-card ${good ? "positive" : "negative"}`}><div><Icon size={19} /></div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function ReturnBar({ label, value }: { label: string; value: number | null }) {
  if (value == null || !Number.isFinite(value)) {
    return <div className="return-bar"><span>{label}</span><i /><b>--</b></div>;
  }
  const positive = value >= 0;
  const width = Math.min(100, Math.abs(value) * 13 + 8);
  return <div className="return-bar"><span>{label}</span><i><em className={positive ? "up" : "down"} style={{ width: `${width}%` }} /></i><b className={positive ? "red" : "green"}>{positive ? "+" : ""}{fmt(value)}%</b></div>;
}

function LoadingState() {
  return <div className="loading-state" role="status" aria-live="polite"><Radar size={42} /><h2>正在构建主线画像</h2><p>同步实时行情、历史K线、板块与公告。</p></div>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: (() => void) | undefined }) {
  return (
    <div className="panel empty-state error" role="alert">
      <CircleAlert size={34} />
      <h3>查询失败</h3>
      <p>{message}</p>
      {onRetry && <button type="button" className="secondary-btn" onClick={onRetry}>重新尝试</button>}
    </div>
  );
}

function EmptyInline({ text }: { text: string }) {
  return <div className="empty-inline">{text}</div>;
}

export default App;
