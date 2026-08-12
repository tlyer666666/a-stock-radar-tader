import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  Gauge,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingUp
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type StrategySignalStock = Security & {
  industry?: string;
  latest?: number;
  changePct?: number;
  turnover?: number;
  amount?: number;
  mrs?: number;
  grade?: string;
  score?: number;
  signalScore?: number;
  signalStrength?: number;
  strategyMatchRate?: number;
  limitDate?: string;
  observationNode?: string;
  reasons?: string[];
  matchedReasons?: string[];
  matchedComponents?: string[];
  matchedStrategyIds?: string[];
  componentMatches?:
    | Record<string, boolean | number | Record<string, any>>
    | Array<string | Record<string, any>>;
  componentVotes?:
    | Record<string, boolean | number | Record<string, any>>
    | Array<string | Record<string, any>>;
  votes?:
    | Record<string, boolean | number | Record<string, any>>
    | Array<string | Record<string, any>>;
  risks?: string[];
  riskVetoStatus?: "passed" | "failed" | "unknown" | string;
  quote?: Record<string, any>;
  analysis?: Record<string, any>;
};

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

type ValidationRange = {
  from?: string;
  to?: string;
};

type ValidationSample = {
  sampleCount?: number;
  independentSignalDays?: number;
  winRate?: number;
  averageReturn?: number;
  averageReturnLowerBound95?: number;
  averageExcessReturn?: number;
  maxDrawdown?: number;
  benchmarkSampleCount?: number;
  range?: ValidationRange;
};

type WalkForwardValidation = {
  available?: boolean;
  accepted?: boolean;
  sampleCount?: number;
  minimumSamples?: number;
  initialTraining?: ValidationSample;
  outOfSample?: ValidationSample;
  folds?: Array<Record<string, any>>;
  passedFolds?: number;
  passRate?: number;
  positiveFoldRate?: number;
  degradationPercent?: number;
  overfitRisk?: string;
  reason?: string;
};

type StrategyValidation = {
  accepted?: boolean;
  publicationAccepted?: boolean;
  publicationFailureReasons?: string[];
  sampleCount?: number;
  minimumSamples?: number;
  outOfSampleCount?: number;
  walkForwardPassRate?: number;
  winRate5?: number;
  average5?: number;
  excess5?: number;
  worstMdd5?: number;
  stabilityScore?: number;
  grade?: string;
  status?: string;
  reason?: string;
  reasons?: string[];
  range?: ValidationRange;
  inSample?: ValidationSample;
  outOfSample?: ValidationSample;
  walkForward?: WalkForwardValidation;
  roundTripCostBps?: number;
  benchmarkSampleCount?: number;
  untradeableCount?: number;
  confidence?: string;
  entryRule?: string;
  returnType?: string;
  validationVersion?: string;
  regimes?: Array<ValidationSample & {
    id?: string;
    label?: string;
    supported?: boolean;
    minimumSignalDays?: number;
  }>;
  currentRegimeFit?: {
    regimeId?: string;
    regimeLabel?: string;
    available?: boolean;
    supported?: boolean;
    sampleCount?: number;
    independentSignalDays?: number;
    averageReturn?: number;
    averageReturnLowerBound95?: number;
    averageExcessReturn?: number;
    maxDrawdown?: number;
    reason?: string;
  };
  thresholds?: {
    minSamples?: number;
    minOutOfSampleSamples?: number;
    minIndependentSignalDays?: number;
    minWalkForwardFoldSamples?: number;
    minWinRate?: number;
    minAverageReturn?: number;
    maxDrawdown?: number;
  };
};

type StrategySignalGroup = {
  id: string;
  name: string;
  type?: "base" | "composite" | string;
  detail?: string;
  description?: string;
  components?: string[];
  voteRule?: string;
  conditions?: string[];
  risk?: string;
  validation?: StrategyValidation;
  stocks: StrategySignalStock[];
};

type OptimizedPortfolio = {
  id?: string;
  name?: string;
  version?: string;
  accepted?: boolean;
  engineAccepted?: boolean;
  publicationAccepted?: boolean;
  reason?: string;
  publicationFailureReasons?: string[];
  minimumVotes?: number;
  maxAllowedContainment?: number;
  splitDate?: string;
  selectedStrategies?: Array<{
    id: string;
    name?: string;
    robustScore?: number;
    developmentAccepted?: boolean;
    currentMatchCount?: number;
  }>;
  dependence?: Array<{
    leftId?: string;
    rightId?: string;
    commonSignals?: number;
    jaccard?: number;
    containment?: number;
    returnCorrelation?: number;
  }>;
  terminalHoldout?: ValidationSample & {
    accepted?: boolean;
    minimumSamples?: number;
    splitDate?: string;
    reason?: string;
  };
  validation?: StrategyValidation;
  currentRegime?: {
    id?: string;
    label?: string;
    return20?: number;
    volatility20?: number;
  };
  currentRegimeFit?: StrategyValidation["currentRegimeFit"];
  matchedStockCount?: number;
  stocks?: StrategySignalStock[];
};

type StrategySignalReport = {
  generatedAt?: string;
  source?: string;
  sourceClass?: string;
  universeSize?: number;
  availableUniverseSize?: number;
  processed?: number;
  failed?: number;
  candidateCount?: number;
  qualifiedCount?: number;
  benchmarkBars?: number;
  historyBarsRequested?: number;
  coverage?: Record<string, any>;
  methodologyDetails?: Record<string, any>;
  methodology?: string;
  warning?: string;
  selectionBiasWarning?: string;
  multipleTestingWarning?: string;
  publicationPolicy?: string;
  independentValidationUniverse?: boolean;
  independentValidationSampleSize?: number;
  optimizedPortfolio?: OptimizedPortfolio | null;
  currentRegime?: OptimizedPortfolio["currentRegime"];
  publishedStrategyCount?: number;
  baseStrategyCount?: number;
  compositeStrategyCount?: number;
  publishedBaseCount?: number;
  publishedCompositeCount?: number;
  strategiesTested?: number;
  dataRange?: ValidationRange;
  sampleDiversity?: {
    securities?: number;
    boardCount?: number;
    dateCohortCount?: number;
    industryOrThemeCount?: number;
    boardBuckets?: Record<string, number>;
    dateCohorts?: Record<string, number>;
    maximumBoardShare?: number;
    maximumDateCohortShare?: number;
    concentrationWarnings?: string[];
    diversified?: boolean;
  };
  strategies: StrategySignalGroup[];
};

type ValidationState = "verified" | "observing" | "insufficient";

const strategyReportCache = new Map<string, {
  report: StrategySignalReport;
  savedAt: number;
}>();
const strategyActiveIdCache = new Map<string, string>();

const componentFallbackNames: Record<string, string> = {
  low_first_board: "低位首板",
  platform_breakout: "平台突破首板",
  trend_first_board: "多头趋势首板",
  low_volume_first_board: "缩量控盘首板",
  vcp_compression: "涨停后VCP压缩",
  high_tight_flag: "涨停后高位窄旗",
  volume_dryup_rebound: "涨停后地量反包",
  second_breakout: "涨停后二次突破",
  weak_to_strong: "弱转强修复",
  ma_reclaim_after_limit: "涨停后均线反转",
  double_limit_relay: "双涨停N形接力",
  long_lower_shadow_limit: "长下影涨停封板",
  limit_gap_hold: "涨停后缺口守卫",
  limit_ma10_pullback: "涨停后MA10回踩"
};

const nullableNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const number = (value: unknown, fallback = 0) => {
  const parsed = nullableNumber(value);
  return parsed === null ? fallback : parsed;
};

const fmt = (value: unknown, digits = 1) => {
  const parsed = nullableNumber(value);
  return parsed === null ? "--" : parsed.toFixed(digits);
};

const pct = (value: unknown, digits = 1) => {
  const parsed = nullableNumber(value);
  return parsed !== null
    ? `${parsed >= 0 ? "+" : ""}${parsed.toFixed(digits)}%`
    : "--";
};

const unit = (value: unknown, digits: number, suffix: string) => {
  const parsed = nullableNumber(value);
  return parsed === null ? "--" : `${parsed.toFixed(digits)}${suffix}`;
};

const money = (value: unknown) => {
  const parsed = nullableNumber(value);
  if (parsed === null) return "--";
  if (Math.abs(parsed) >= 1e8) return `${(parsed / 1e8).toFixed(1)}亿`;
  if (Math.abs(parsed) >= 1e4) return `${(parsed / 1e4).toFixed(0)}万`;
  return parsed.toFixed(0);
};

const normalizeStringList = (input: unknown) => {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[，,、；;\n]+/)
      : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
};

const isCompositeStrategy = (group?: Pick<StrategySignalGroup, "type" | "components">) =>
  String(group?.type || "").toLowerCase() === "composite" ||
  Boolean(group?.components?.length);

const componentName = (
  id: string,
  strategyNames: ReadonlyMap<string, string>
) => strategyNames.get(id) || componentFallbackNames[id] || id;

const collectMatchedComponentTokens = (input: unknown): string[] => {
  if (Array.isArray(input)) {
    return input.flatMap((item) => collectMatchedComponentTokens(item));
  }
  if (typeof input === "string" || typeof input === "number") {
    return [String(input)];
  }
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, any>;
  const ownId = record.id ?? record.strategyId ?? record.componentId ?? record.name;
  if (ownId !== undefined) {
    const rejected =
      record.matched === false ||
      record.passed === false ||
      record.hit === false ||
      record.active === false ||
      record.vote === false ||
      Number(record.vote) === 0;
    return rejected ? [] : [String(ownId)];
  }
  return Object.entries(record).flatMap(([key, value]) => {
    const accepted =
      value === true ||
      (typeof value === "number" && value > 0) ||
      (value &&
        typeof value === "object" &&
        (value.matched === true ||
          value.passed === true ||
          value.hit === true ||
          value.active === true ||
          Number(value.vote) > 0));
    return accepted ? [key] : [];
  });
};

const matchedComponentIds = (
  stock: StrategySignalStock,
  group: StrategySignalGroup,
  strategyNames: ReadonlyMap<string, string>
) => {
  const componentIds = group.components || [];
  if (!componentIds.length) return [];
  const byName = new Map(
    componentIds.map((id) => [componentName(id, strategyNames).toLowerCase(), id])
  );
  const explicitTokens = [
    stock.matchedComponents,
    stock.matchedStrategyIds,
    stock.componentMatches,
    stock.componentVotes,
    stock.votes
  ].flatMap((value) => collectMatchedComponentTokens(value));
  const explicitIds = explicitTokens
    .map((token) => {
      const normalized = String(token).trim();
      if (componentIds.includes(normalized)) return normalized;
      return byName.get(normalized.toLowerCase()) || "";
    })
    .filter(Boolean);
  if (explicitIds.length) {
    return componentIds.filter((id) => explicitIds.includes(id));
  }
  return [];
};

const normalizeRange = (input: any): ValidationRange => ({
  from: String(input?.from || input?.start || ""),
  to: String(input?.to || input?.end || "")
});

const normalizeSample = (input: any): ValidationSample => {
  const raw = input || {};
  return {
    ...raw,
    sampleCount: nullableNumber(raw.sampleCount) ?? undefined,
    independentSignalDays:
      nullableNumber(raw.independentSignalDays) ?? undefined,
    winRate: nullableNumber(raw.winRate) ?? undefined,
    averageReturn:
      nullableNumber(raw.averageReturn ?? raw.averageReturnPct) ?? undefined,
    averageReturnLowerBound95:
      nullableNumber(raw.averageReturnLowerBound95) ?? undefined,
    averageExcessReturn:
      nullableNumber(raw.averageExcessReturn ?? raw.excessReturn) ?? undefined,
    maxDrawdown:
      nullableNumber(raw.maxDrawdown ?? raw.maxDrawdownPct) ?? undefined,
    benchmarkSampleCount:
      nullableNumber(raw.benchmarkSampleCount) ?? undefined,
    range: normalizeRange(raw.range)
  };
};

const normalizeStocks = (input: any): StrategySignalStock[] => {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  return rows
    .map((item) => {
      const quote = item?.quote || {};
      const analysis = item?.analysis || {};
      const code = String(item?.code || item?.security?.code || quote.code || "");
      return {
        ...item?.security,
        ...item,
        code,
        name: String(item?.name || item?.security?.name || quote.name || code),
        secid: String(item?.secid || item?.security?.secid || ""),
        latest: nullableNumber(item?.latest ?? quote.latest) ?? undefined,
        changePct: nullableNumber(item?.changePct ?? quote.changePct) ?? undefined,
        turnover: nullableNumber(item?.turnover ?? quote.turnover) ?? undefined,
        amount: nullableNumber(item?.amount ?? quote.amount) ?? undefined,
        industry: String(item?.industry || quote.industry || "未分类"),
        mrs: nullableNumber(item?.mrs ?? analysis.mrs) ?? undefined,
        grade: String(item?.grade || analysis.grade || ""),
        score:
          nullableNumber(
            item?.score ?? item?.signalScore ?? item?.signalStrength ?? analysis.mrs
          ) ?? undefined,
        signalScore:
          nullableNumber(
            item?.signalScore ?? item?.signalStrength ?? item?.score ?? analysis.mrs
          ) ?? undefined,
        signalStrength: nullableNumber(item?.signalStrength) ?? undefined,
        strategyMatchRate:
          nullableNumber(item?.strategyMatchRate ?? analysis.strategyMatchRate) ??
          undefined,
        reasons: Array.isArray(item?.reasons)
          ? item.reasons
          : Array.isArray(item?.matchedReasons)
            ? item.matchedReasons
            : []
      } as StrategySignalStock;
    })
    .filter((item) => {
      if (!/^\d{6}$/.test(item.code) || seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
};

const normalizeValidation = (input: any): StrategyValidation => {
  const raw = input || {};
  const walkForward = raw.walkForward || {};
  const outOfSample = raw.outOfSample || {};
  const inSample = raw.inSample || raw.training || walkForward.initialTraining || {};
  const hasPublicationDecision =
    typeof raw.publicationAccepted === "boolean";
  return {
    ...raw,
    accepted: hasPublicationDecision
      ? raw.publicationAccepted === true
      : raw.accepted === true,
    publicationAccepted:
      hasPublicationDecision ? raw.publicationAccepted === true : undefined,
    publicationFailureReasons: Array.isArray(raw.publicationFailureReasons)
      ? raw.publicationFailureReasons.filter(Boolean).map(String)
      : undefined,
    sampleCount: nullableNumber(raw.sampleCount) ?? undefined,
    minimumSamples:
      nullableNumber(
        raw.minimumSamples ??
          raw.thresholds?.minSamples ??
          walkForward.minimumSamples
      ) ?? undefined,
    outOfSampleCount:
      nullableNumber(raw.outOfSampleCount ?? outOfSample.sampleCount) ?? undefined,
    walkForwardPassRate:
      nullableNumber(raw.walkForwardPassRate ?? walkForward.passRate) ?? undefined,
    winRate5:
      nullableNumber(raw.winRate5 ?? outOfSample.winRate ?? raw.winRate) ??
      undefined,
    average5:
      nullableNumber(
        raw.average5 ?? outOfSample.averageReturn ?? raw.averageReturn
      ) ?? undefined,
    excess5:
      nullableNumber(
        raw.excess5 ??
          outOfSample.averageExcessReturn ??
          raw.averageExcessReturn
      ) ?? undefined,
    worstMdd5:
      nullableNumber(
        raw.worstMdd5 ?? outOfSample.maxDrawdown ?? raw.maxDrawdown
      ) ?? undefined,
    stabilityScore: nullableNumber(raw.stabilityScore) ?? undefined,
    range: normalizeRange(raw.range),
    inSample: normalizeSample(inSample),
    outOfSample: normalizeSample(outOfSample),
    walkForward: {
      ...walkForward,
      available: walkForward.available === true,
      accepted: walkForward.accepted === true,
      sampleCount: nullableNumber(walkForward.sampleCount) ?? undefined,
      minimumSamples:
        nullableNumber(walkForward.minimumSamples) ?? undefined,
      initialTraining: normalizeSample(walkForward.initialTraining),
      outOfSample: normalizeSample(walkForward.outOfSample),
      passedFolds: nullableNumber(walkForward.passedFolds) ?? undefined,
      passRate: nullableNumber(walkForward.passRate) ?? undefined,
      positiveFoldRate:
        nullableNumber(walkForward.positiveFoldRate) ?? undefined,
      degradationPercent:
        nullableNumber(walkForward.degradationPercent) ?? undefined,
      folds: Array.isArray(walkForward.folds) ? walkForward.folds : []
    },
    roundTripCostBps:
      nullableNumber(raw.roundTripCostBps) ?? undefined,
    benchmarkSampleCount:
      nullableNumber(raw.benchmarkSampleCount) ?? undefined,
    untradeableCount:
      nullableNumber(raw.untradeableCount) ?? undefined,
    grade: String(raw.grade || ""),
    status: hasPublicationDecision
      ? raw.publicationAccepted === true
        ? "PASS"
        : String(raw.status || "").toUpperCase().includes("INSUFFICIENT")
          ? "INSUFFICIENT"
          : "REVIEW"
      : String(raw.status || ""),
    reason: String(raw.reason || "")
  };
};

const validationState = (
  validation?: StrategyValidation
): ValidationState => {
  if (validation?.accepted === true) return "verified";
  const status = String(validation?.status || "").toUpperCase();
  const samples = nullableNumber(validation?.sampleCount);
  const minimumSamples = nullableNumber(
    validation?.minimumSamples ?? validation?.thresholds?.minSamples
  );
  const outOfSampleCount = nullableNumber(validation?.outOfSampleCount);
  const walkForward = validation?.walkForward;
  if (status.includes("INSUFFICIENT")) return "insufficient";
  if (samples === null || (minimumSamples !== null && samples < minimumSamples)) {
    return "insufficient";
  }
  if (outOfSampleCount === null || outOfSampleCount <= 0) return "insufficient";
  if (!walkForward || walkForward.available !== true) return "insufficient";
  return "observing";
};

const validationStateLabel = (state: ValidationState) =>
  state === "verified"
    ? "已验证"
    : state === "insufficient"
      ? "数据不足"
      : "观察中";

const ratioPercent = (value: unknown) => {
  const parsed = nullableNumber(value);
  if (parsed === null) return "--";
  return unit(parsed * (Math.abs(parsed) <= 1 ? 100 : 1), 0, "%");
};

const rangeText = (range?: ValidationRange) => {
  const from = String(range?.from || "");
  const to = String(range?.to || "");
  if (!from && !to) return "--";
  if (!from || !to) return from || to;
  return `${from} 至 ${to}`;
};

const validationReasons = (validation: StrategyValidation) => {
  const items = [
    ...(Array.isArray(validation.publicationFailureReasons)
      ? validation.publicationFailureReasons
      : []),
    ...(Array.isArray(validation.reasons) ? validation.reasons : []),
    ...String(validation.reason || "")
      .split(/[；;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    validation.walkForward?.reason || ""
  ].filter(Boolean);
  return [...new Set(items)];
};

const reportCoverage = (report?: StrategySignalReport | null) => {
  const coverage = report?.coverage || {};
  const universe = nullableNumber(
    coverage.universeSize ??
      report?.universeSize ??
      coverage.candidateCount ??
      report?.candidateCount
  );
  const historiesUsed = nullableNumber(
    coverage.historiesUsed ?? coverage.processed ?? report?.processed
  );
  const failed = nullableNumber(coverage.failed ?? report?.failed);
  const historyBarsRequested = nullableNumber(
    coverage.historyBarsRequested ?? report?.historyBarsRequested
  );
  const benchmarkBars = nullableNumber(
    coverage.benchmarkBars ?? report?.benchmarkBars
  );
  const percent =
    universe !== null && universe > 0 && historiesUsed !== null
      ? Math.min(100, Math.max(0, historiesUsed / universe * 100))
      : null;
  return {
    universe,
    historiesUsed,
    failed,
    historyBarsRequested,
    benchmarkBars,
    percent
  };
};

const methodologyText = (input: unknown) => {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    return Object.values(input)
      .filter((item): item is string => typeof item === "string" && !!item.trim())
      .join("；");
  }
  return "按历史事件回放、样本外复核、风险否决与当前行情共同筛选。";
};

const normalizeReport = (input: any): StrategySignalReport => {
  const groupSources = [
    ...(Array.isArray(input?.groups) ? input.groups : []),
    ...(Array.isArray(input?.strategies) ? input.strategies : []),
    ...(Array.isArray(input?.auditedStrategies) ? input.auditedStrategies : [])
  ];
  const mergedGroups = new Map<string, any>();
  groupSources.forEach((group: any, index: number) => {
    const id = String(group?.id || `strategy-${index + 1}`);
    const previous = mergedGroups.get(id) || {};
    mergedGroups.set(id, {
      ...previous,
      ...group,
      id,
      validation: {
        ...(previous?.validation || previous?.backtest || previous?.metrics || {}),
        ...(group?.validation || group?.backtest || group?.metrics || {})
      }
    });
  });
  const strategies = [...mergedGroups.values()].map(
    (group: any, index: number): StrategySignalGroup => {
      const rawValidation =
        group?.validation || group?.backtest || group?.metrics || {};
      const publicationAccepted =
        typeof group?.publicationAccepted === "boolean"
          ? group.publicationAccepted
          : rawValidation?.publicationAccepted;
      return {
        id: String(group?.id || `strategy-${index + 1}`),
        name: String(group?.name || group?.label || `策略 ${index + 1}`),
        type:
          String(group?.type || "").toLowerCase() === "composite" ||
          normalizeStringList(group?.components).length
            ? "composite"
            : "base",
        detail: String(group?.detail || group?.description || ""),
        description: String(group?.description || group?.detail || ""),
        components: normalizeStringList(group?.components),
        voteRule: String(group?.voteRule || group?.vote || ""),
        conditions: normalizeStringList(group?.conditions),
        risk: String(group?.risk || group?.riskRule || ""),
        validation: normalizeValidation({
          ...rawValidation,
          ...(typeof publicationAccepted === "boolean"
            ? { publicationAccepted }
            : {})
        }),
        stocks: normalizeStocks(group?.stocks || group?.signals || group?.candidates)
      };
    }
  );
  const acceptedQualifiedCount = strategies.reduce(
    (sum: number, group: StrategySignalGroup) =>
      sum + (group.validation?.accepted === true ? group.stocks.length : 0),
    0
  );
  const rawOptimized = input?.optimizedPortfolio;
  const optimizedPortfolio: OptimizedPortfolio | null =
    rawOptimized && typeof rawOptimized === "object"
      ? {
          ...rawOptimized,
          accepted:
            typeof rawOptimized.publicationAccepted === "boolean"
              ? rawOptimized.publicationAccepted === true
              : rawOptimized.accepted === true,
          publicationAccepted:
            typeof rawOptimized.publicationAccepted === "boolean"
              ? rawOptimized.publicationAccepted === true
              : undefined,
          publicationFailureReasons: normalizeStringList(
            rawOptimized.publicationFailureReasons
          ),
          selectedStrategies: Array.isArray(rawOptimized.selectedStrategies)
            ? rawOptimized.selectedStrategies
            : [],
          dependence: Array.isArray(rawOptimized.dependence)
            ? rawOptimized.dependence
            : [],
          validation: normalizeValidation(rawOptimized.validation),
          terminalHoldout: {
            ...normalizeSample(rawOptimized.terminalHoldout),
            accepted: rawOptimized?.terminalHoldout?.accepted === true,
            minimumSamples:
              nullableNumber(rawOptimized?.terminalHoldout?.minimumSamples) ??
              undefined,
            splitDate: String(rawOptimized?.terminalHoldout?.splitDate || ""),
            reason: String(rawOptimized?.terminalHoldout?.reason || "")
          },
          stocks: normalizeStocks(rawOptimized.stocks)
        }
      : null;
  const report = {
    generatedAt: input?.generatedAt || input?.updatedAt,
    source: input?.source || input?.dataSource || "本地历史推演",
    sourceClass: input?.sourceClass,
    universeSize:
      nullableNumber(input?.universeSize ?? input?.poolSize) ?? undefined,
    availableUniverseSize:
      nullableNumber(input?.availableUniverseSize) ?? undefined,
    processed: nullableNumber(input?.processed) ?? undefined,
    failed: nullableNumber(input?.failed) ?? undefined,
    candidateCount: nullableNumber(input?.candidateCount) ?? undefined,
    qualifiedCount:
      nullableNumber(input?.qualifiedCount) ?? acceptedQualifiedCount,
    benchmarkBars:
      nullableNumber(input?.benchmarkBars ?? input?.coverage?.benchmarkBars) ??
      undefined,
    historyBarsRequested:
      nullableNumber(
        input?.historyBarsRequested ?? input?.coverage?.historyBarsRequested
      ) ?? undefined,
    coverage:
      input?.coverage && typeof input.coverage === "object"
        ? input.coverage
        : {},
    methodologyDetails:
      input?.methodologyDetails &&
      typeof input.methodologyDetails === "object"
        ? input.methodologyDetails
        : {},
    methodology: methodologyText(input?.methodology),
    warning: input?.warning,
    selectionBiasWarning: String(input?.selectionBiasWarning || ""),
    multipleTestingWarning: String(input?.multipleTestingWarning || ""),
    publicationPolicy: String(input?.publicationPolicy || ""),
    independentValidationUniverse:
      input?.independentValidationUniverse === true,
    independentValidationSampleSize:
      nullableNumber(input?.independentValidationSampleSize) ?? undefined,
    optimizedPortfolio,
    currentRegime:
      input?.currentRegime && typeof input.currentRegime === "object"
        ? input.currentRegime
        : optimizedPortfolio?.currentRegime,
    publishedStrategyCount:
      nullableNumber(input?.publishedStrategyCount) ?? undefined,
    baseStrategyCount:
      nullableNumber(input?.baseStrategyCount) ??
      strategies.filter((group) => !isCompositeStrategy(group)).length,
    compositeStrategyCount:
      nullableNumber(input?.compositeStrategyCount) ??
      strategies.filter(isCompositeStrategy).length,
    publishedBaseCount:
      nullableNumber(input?.publishedBaseCount) ??
      strategies.filter(
        (group) =>
          !isCompositeStrategy(group) && group.validation?.accepted === true
      ).length,
    publishedCompositeCount:
      nullableNumber(input?.publishedCompositeCount) ??
      strategies.filter(
        (group) =>
          isCompositeStrategy(group) && group.validation?.accepted === true
      ).length,
    strategiesTested:
      nullableNumber(input?.strategiesTested) ?? undefined,
    sampleDiversity:
      input?.sampleDiversity && typeof input.sampleDiversity === "object"
        ? input.sampleDiversity
        : undefined,
    dataRange: normalizeRange(input?.dataRange),
    strategies
  };
  return Object.fromEntries(
    Object.entries(report).filter(([, value]) => value !== undefined)
  ) as StrategySignalReport;
};

function ValidationPanel({
  group,
  report
}: {
  group: StrategySignalGroup;
  report: StrategySignalReport;
}) {
  const validation = group.validation || {};
  const state = validationState(validation);
  const reasons = validationReasons(validation);
  const coverage = reportCoverage(report);
  const training =
    validation.inSample || validation.walkForward?.initialTraining || {};
  const outOfSample =
    validation.outOfSample || validation.walkForward?.outOfSample || {};
  const walkForward = validation.walkForward || {};
  const folds = Array.isArray(walkForward.folds) ? walkForward.folds : [];
  const passedFolds = nullableNumber(walkForward.passedFolds);
  const costBps = nullableNumber(validation.roundTripCostBps);
  const currentRegimeFit = validation.currentRegimeFit;
  const minimumSamples = nullableNumber(
    validation.minimumSamples ?? validation.thresholds?.minSamples
  );
  const originalStatus =
    state === "verified"
      ? validation.grade ? `验证评级 ${validation.grade}` : "验证通过"
      : state === "insufficient"
        ? "样本不足"
        : "等待复核";
  return (
    <div className={`strategy-validation state-${state}`}>
      <div className="strategy-validation-head">
        <div>
          {state === "verified" ? (
            <CheckCircle2 size={18} />
          ) : state === "insufficient" ? (
            <Database size={18} />
          ) : (
            <ShieldAlert size={18} />
          )}
          <span>{validationStateLabel(state)}</span>
        </div>
        <em>{originalStatus}</em>
      </div>
      <div className="strategy-validation-grid">
        <div className="strategy-validation-range">
          <span>有效历史起止</span>
          <b>{rangeText(validation.range)}</b>
          <small>
            服务端回传请求窗口 {fmt(coverage.historyBarsRequested, 0)} 根日线
          </small>
        </div>
        <div>
          <span>总样本 / 最低要求</span>
          <b>{fmt(validation.sampleCount, 0)} / {fmt(minimumSamples, 0)}</b>
          <small>不可成交剔除 {fmt(validation.untradeableCount, 0)}</small>
        </div>
        <div>
          <span>样本外样本</span>
          <b>{fmt(validation.outOfSampleCount, 0)}</b>
          <small>基准匹配 {fmt(outOfSample.benchmarkSampleCount ?? validation.benchmarkSampleCount, 0)}</small>
        </div>
        <div>
          <span>走步窗口通过</span>
          <b>
            {walkForward.available === true
              ? `${fmt(passedFolds, 0)} / ${folds.length || "--"}`
              : "--"}
          </b>
          <small>通过率 {ratioPercent(validation.walkForwardPassRate)}</small>
        </div>
        <div>
          <span>简化双边成本</span>
          <b>{costBps === null ? "--" : `${fmt(costBps, 1)} bps`}</b>
          <small>{costBps === null ? "成本字段未返回" : `佣金+滑点约 ${(costBps / 100).toFixed(3)}%，未含最低佣金与税费版本化`}</small>
        </div>
        <div>
          <span>数据完整度</span>
          <b>
            {coverage.historiesUsed === null || coverage.universe === null
              ? "--"
              : `${fmt(coverage.historiesUsed, 0)} / ${fmt(coverage.universe, 0)}`}
          </b>
          <small>
            {coverage.percent === null ? "覆盖率未知" : `覆盖 ${coverage.percent.toFixed(1)}%`}
            {coverage.failed ? ` · 失败 ${coverage.failed}` : ""}
          </small>
        </div>
        <div>
          <span>基准历史</span>
          <b>{fmt(coverage.benchmarkBars, 0)} 根</b>
          <small>{nullableNumber(coverage.benchmarkBars) === null ? "基准字段未返回" : "中证全指不复权日线"}</small>
        </div>
        <div>
          <span>稳定性 / 过拟合</span>
          <b>{fmt(validation.stabilityScore, 0)}</b>
          <small>
            {walkForward.overfitRisk
              ? `过拟合风险 ${walkForward.overfitRisk}`
              : "过拟合字段未返回"}
          </small>
        </div>
        <div>
          <span>当前市场适配</span>
          <b>{currentRegimeFit?.regimeLabel || "--"}</b>
          <small>
            {currentRegimeFit
              ? currentRegimeFit.supported
                ? "该状态历史优势达标"
                : currentRegimeFit.reason || "该状态暂不发布"
              : "市场状态证据未返回"}
          </small>
        </div>
      </div>

      <div className="strategy-validation-periods">
        <div className="strategy-validation-period training">
          <header><span>训练期</span><em>{rangeText(training.range)}</em></header>
          <div>
            <span><small>样本</small><b>{fmt(training.sampleCount, 0)}</b></span>
            <span><small>胜率</small><b>{unit(training.winRate, 1, "%")}</b></span>
            <span><small>净均收益</small><b>{pct(training.averageReturn, 2)}</b></span>
            <span><small>95%收益下限</small><b>{pct(training.averageReturnLowerBound95, 2)}</b></span>
            <span><small>基准超额</small><b>{pct(training.averageExcessReturn, 2)}</b></span>
            <span><small>信号序列回撤</small><b>{pct(training.maxDrawdown, 2)}</b></span>
          </div>
        </div>
        <div className="strategy-validation-period out-of-sample">
          <header><span>样本外</span><em>{rangeText(outOfSample.range)}</em></header>
          <div>
            <span><small>样本</small><b>{fmt(outOfSample.sampleCount ?? validation.outOfSampleCount, 0)}</b></span>
            <span><small>胜率</small><b>{unit(outOfSample.winRate ?? validation.winRate5, 1, "%")}</b></span>
            <span><small>净均收益</small><b>{pct(outOfSample.averageReturn ?? validation.average5, 2)}</b></span>
            <span><small>95%收益下限</small><b>{pct(outOfSample.averageReturnLowerBound95, 2)}</b></span>
            <span><small>基准超额</small><b>{pct(outOfSample.averageExcessReturn ?? validation.excess5, 2)}</b></span>
            <span><small>信号序列回撤</small><b>{pct(outOfSample.maxDrawdown ?? validation.worstMdd5, 2)}</b></span>
          </div>
        </div>
      </div>

      <div className={`strategy-validation-reasons state-${state}`}>
        <b>{state === "verified" ? "通过依据" : "拒绝 / 保留原因"}</b>
        {reasons.length ? (
          <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        ) : (
          <p>
            {state === "verified"
              ? "总样本、时间切分样本外和走步验证均通过。"
              : "接口未返回可核验的拒绝原因，因此不会发布为优质信号。"}
          </p>
        )}
      </div>

      <div className="strategy-validation-method">
        <span>{validation.entryRule || "入场与退出规则未返回"}</span>
        <span>{validation.returnType || "收益口径未返回"}</span>
      </div>
    </div>
  );
}

function OptimizedPortfolioPanel({
  portfolio,
  onOpen,
  onOpenBacktest
}: {
  portfolio: OptimizedPortfolio;
  onOpen: (security: Security) => void;
  onOpenBacktest: (request: StrategyBacktestRequest) => void;
}) {
  const passed = portfolio.publicationAccepted === true || portfolio.accepted === true;
  const validation = portfolio.validation || {};
  const outOfSample = validation.outOfSample || {};
  const terminal = portfolio.terminalHoldout || {};
  const regimeFit = portfolio.currentRegimeFit || {};
  const failures = [
    ...(portfolio.publicationFailureReasons || []),
    ...(passed ? [] : [portfolio.reason || ""]),
    ...(terminal.accepted === true ? [] : [terminal.reason || ""]),
    ...(regimeFit.supported === true ? [] : [regimeFit.reason || ""])
  ].filter(Boolean);
  const maxContainment = Math.max(
    0,
    ...(portfolio.dependence || []).map((item) => number(item.containment))
  );
  const optimizedStrategyIds = (portfolio.selectedStrategies || [])
    .map((item) => String(item.id || "").trim())
    .filter(Boolean);
  const openPortfolioBacktest = (security?: Security) => onOpenBacktest({
    ...(security ? { security } : {}),
    ...(!security && portfolio.stocks?.length
      ? {
          securities: portfolio.stocks,
          universeSource: "strategy_current_matches" as const,
          universeTotalCount: portfolio.stocks.length
        }
      : {}),
    source: "optimized_portfolio",
    strategyEngine: "verified-signal-v2",
    strategyId: portfolio.id || "optimized_robust_consensus",
    strategyName: portfolio.name || "稳健优选组合",
    ...(portfolio.version ? { strategyVersion: portfolio.version } : {}),
    strategyIds: optimizedStrategyIds,
    minimumVotes: portfolio.minimumVotes || 2
  });
  return (
    <section className={`panel optimized-strategy-panel ${passed ? "passed" : "waiting"}`}>
      <header>
        <div className="optimized-strategy-title">
          <Sparkles size={22} />
          <div>
            <span>ROBUST OPTIMIZED CONSENSUS</span>
            <h2>{portfolio.name || "稳健优选组合"}</h2>
            <p>先在开发期选低重复策略，再用未参与选优的终端留出样本考试；只有当前市场状态也适配时才发布股票。</p>
          </div>
        </div>
        <em className={passed ? "pass" : "wait"}>{passed ? "可发布" : "继续观察"}</em>
      </header>

      <div className="optimized-strategy-backtest-action">
        <button
          className="secondary-btn"
          onClick={() => openPortfolioBacktest()}
          disabled={!optimizedStrategyIds.length}
        >
          <Target size={16} />
          带入回测中心
        </button>
        <small>冻结本轮入选组件、投票门槛和本轮命中股票；回测中心可选单只、部分或全部回放。</small>
      </div>

      <div className="optimized-strategy-components">
        {(portfolio.selectedStrategies || []).length ? (
          portfolio.selectedStrategies?.map((strategy) => (
            <div key={strategy.id}>
              <span>{strategy.name || strategy.id}</span>
              <b>{fmt(strategy.robustScore, 1)}</b>
              <small>{strategy.developmentAccepted ? "开发期通过" : "开发期未通过"}</small>
            </div>
          ))
        ) : (
          <p>目前没有至少两套低相关且通过开发期复核的基础策略。</p>
        )}
      </div>

      <div className="optimized-strategy-metrics">
        <div>
          <span>开发期共识样本</span>
          <b>{fmt(validation.sampleCount, 0)}</b>
          <small>样本外 {fmt(outOfSample.sampleCount, 0)} 条</small>
        </div>
        <div>
          <span>样本外95%收益下限</span>
          <b>{pct(outOfSample.averageReturnLowerBound95, 2)}</b>
          <small>超额 {pct(outOfSample.averageExcessReturn, 2)}</small>
        </div>
        <div>
          <span>终端留出考试</span>
          <b>{terminal.accepted ? "验证通过" : "未通过"}</b>
          <small>{fmt(terminal.sampleCount, 0)} / {fmt(terminal.minimumSamples, 0)} 条</small>
        </div>
        <div>
          <span>走步通过率</span>
          <b>{ratioPercent(validation.walkForward?.passRate)}</b>
          <small>信号序列回撤 {pct(outOfSample.maxDrawdown, 2)}</small>
        </div>
        <div>
          <span>当前市场状态</span>
          <b>{regimeFit.regimeLabel || portfolio.currentRegime?.label || "未知"}</b>
          <small>{regimeFit.supported ? "历史适配" : "暂不适配"}</small>
        </div>
        <div>
          <span>组件最大包含率</span>
          <b>{unit(maxContainment * 100, 1, "%")}</b>
          <small>上限 {unit(number(portfolio.maxAllowedContainment) * 100, 0, "%")}</small>
        </div>
      </div>

      {!passed && failures.length > 0 && (
        <div className="optimized-strategy-failures">
          <ShieldAlert size={17} />
          <div>
            <b>本轮不发布的原因</b>
            <ul>{[...new Set(failures)].map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </div>
        </div>
      )}

      {passed && Boolean(portfolio.stocks?.length) && (
        <div className="optimized-strategy-stocks">
          <div>
            <b>本轮优选股票</b>
            <small>至少 {portfolio.minimumVotes || 2} 套低相关策略同股同日共振</small>
          </div>
          <div>
            {portfolio.stocks?.slice(0, 12).map((stock) => (
              <article key={stock.code}>
                <span>{stock.name}<small>{stock.code}</small></span>
                <b>{fmt(stock.signalScore ?? stock.signalStrength, 0)}分</b>
                <em>{(stock.matchedStrategyIds || []).length} 策略共振</em>
                <div className="optimized-stock-actions">
                  <button onClick={() => onOpen(stock)}>复盘</button>
                  <button onClick={() => openPortfolioBacktest(stock)}>组合回测</button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const defaultStrategyId = (strategies: StrategySignalGroup[]) =>
  strategies.find(
    (group) =>
      isCompositeStrategy(group) && group.validation?.accepted === true
  )?.id ||
  strategies.find((group) => group.validation?.accepted === true)?.id ||
  strategies.find(isCompositeStrategy)?.id ||
  strategies[0]?.id ||
  "";

export default function StrategySignalsView({
  onOpen,
  onOpenBacktest
}: {
  onOpen: (security: Security) => void;
  onOpenBacktest: (request: StrategyBacktestRequest) => void;
}) {
  // 个股页的 selectedStrategies 是分析因子，不是历史信号引擎的策略 ID。
  // 策略信号页始终复核完整的版本化策略库，避免无效 ID 触发重复的 300×720 扫描。
  const strategyKey = "verified-signal-engine-v2";
  const selectedStrategyIds = useMemo<string[]>(() => [], []);
  const cachedEntry = strategyReportCache.get(strategyKey);
  const [report, setReport] = useState<StrategySignalReport | null>(
    cachedEntry?.report || null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState(
    strategyActiveIdCache.get(strategyKey) || ""
  );
  const requestId = useRef(0);

  const load = useCallback(async (force = false) => {
    const cached = strategyReportCache.get(strategyKey);
    // Always re-enter the main-process cache so a provider/settings change is
    // reflected immediately. Keep the renderer copy only as a non-blocking
    // placeholder while the provider-keyed backend result is resolved.
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError("");
    if (!cached) setReport(null);
    try {
      const next = await window.stockApi.scanStrategySignals({
        strategyIds: selectedStrategyIds,
        historyBars: 720,
        maxUniverse: 300,
        maxStocksPerStrategy: 200,
        minSamples: 120,
        minOutOfSampleSamples: 36,
        minIndependentSignalDays: 60,
        minWalkForwardFoldSamples: 10,
        walkForwardFolds: 4,
        refresh: force
      });
      if (requestId.current !== currentRequest) return;
      const normalized = normalizeReport(next);
      strategyReportCache.set(strategyKey, {
        report: normalized,
        savedAt: Date.now()
      });
      setReport(normalized);
      setActiveId((current) => {
        const preferred = strategyActiveIdCache.get(strategyKey) || current;
        const nextActive = normalized.strategies.some(
          (item) => item.id === preferred
        )
          ? preferred
          : defaultStrategyId(normalized.strategies);
        strategyActiveIdCache.set(strategyKey, nextActive);
        return nextActive;
      });
    } catch (reason) {
      if (requestId.current !== currentRequest) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [selectedStrategyIds, strategyKey]);

  useEffect(() => {
    load(false);
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const activateStrategy = (id: string) => {
    strategyActiveIdCache.set(strategyKey, id);
    setActiveId(id);
  };

  const compositeStrategies = useMemo(
    () => report?.strategies.filter(isCompositeStrategy) || [],
    [report]
  );
  const baseStrategies = useMemo(
    () => report?.strategies.filter((group) => !isCompositeStrategy(group)) || [],
    [report]
  );
  const strategyNames = useMemo(
    () =>
      new Map(
        (report?.strategies || []).map((group) => [group.id, group.name])
      ),
    [report]
  );
  const activeGroup = useMemo(() => {
    const strategies = report?.strategies || [];
    return (
      strategies.find((item) => item.id === activeId) ||
      strategies.find((item) => item.id === defaultStrategyId(strategies))
    );
  }, [activeId, report]);
  const acceptedCount = report?.strategies.filter(
    (item) => item.validation?.accepted === true
  ).length || 0;
  const observingCount = report?.strategies.filter(
    (item) => validationState(item.validation) === "observing"
  ).length || 0;
  const insufficientCount = report?.strategies.filter(
    (item) => validationState(item.validation) === "insufficient"
  ).length || 0;
  const uniqueStockCount = new Set(
    report?.strategies.flatMap((item) =>
      item.validation?.accepted === true
        ? item.stocks.map((stock) => stock.code)
        : []
    ) || []
  ).size;
  const activeAccepted = activeGroup?.validation?.accepted === true;
  const activeComposite = isCompositeStrategy(activeGroup);
  const activeValidationState = validationState(activeGroup?.validation);
  const activeStocks = activeAccepted ? activeGroup?.stocks || [] : [];
  const coverage = reportCoverage(report);

  const renderStrategyTabs = (
    groups: StrategySignalGroup[],
    label: string,
    kind: "composite" | "base"
  ) => (
    <>
      <div className={`strategy-signal-tab-section ${kind}`}>
        <span>{label}</span>
        <b>{groups.length}</b>
        <small>
          已发布 {groups.filter((group) => group.validation?.accepted === true).length}
        </small>
      </div>
      {groups.map((group) => {
        const state = validationState(group.validation);
        return (
          <button
            key={group.id}
            className={`${activeGroup?.id === group.id ? "active" : ""} state-${state} type-${kind}`}
            onClick={() => activateStrategy(group.id)}
          >
            <span>
              <span className="strategy-signal-tab-name">
                <b>{group.name}</b>
                <i className={`strategy-type-badge ${kind}`}>
                  {kind === "composite" ? "组合共振" : "基础"}
                </i>
              </span>
              <small>{group.detail || "历史与当前信号共同过滤"}</small>
              <small className="strategy-signal-tab-audit">
                {state === "verified"
                  ? `发布 ${group.stocks.length} 只合格股票`
                  : `命中 ${group.stocks.length} 条已隔离，不发布`}
              </small>
            </span>
            <em>{validationStateLabel(state)}</em>
            <ChevronRight size={15} />
          </button>
        );
      })}
    </>
  );

  return (
    <div className="strategy-signals-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">VERIFIED STRATEGY SIGNALS</span>
          <h1>策略信号</h1>
          <p>不同策略独立选股；只有完成历史推演、样本外复核和当前风险过滤的结果才进入信号板。</p>
        </div>
        <div className="heading-actions">
          <button className="primary-btn" onClick={() => load(true)} disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
            重新推演复核
          </button>
        </div>
      </div>

      {report?.warning && (
        <div className="warning-banner"><CircleAlert size={17} />{report.warning}</div>
      )}

      {report && (report.selectionBiasWarning || report.multipleTestingWarning) && (
        <section className="panel strategy-validation-disclosure">
          <CircleAlert size={19} />
          <div>
            <b>验证边界（必须同时查看）</b>
            {report.selectionBiasWarning && <p>{report.selectionBiasWarning}</p>}
            {report.multipleTestingWarning && <p>{report.multipleTestingWarning}</p>}
            {report.publicationPolicy && <small>{report.publicationPolicy}</small>}
          </div>
        </section>
      )}

      {report?.optimizedPortfolio && (
        <OptimizedPortfolioPanel
          portfolio={report.optimizedPortfolio}
          onOpen={onOpen}
          onOpenBacktest={onOpenBacktest}
        />
      )}

      <section className="strategy-signal-summary">
        <div className="panel">
          <Sparkles size={20} />
          <span>策略复核库</span>
          <b>{report?.strategies.length || 0}</b>
          <small>
            组合共振 {compositeStrategies.length} · 基础 {baseStrategies.length}；通过 {acceptedCount} / 观察 {observingCount} / 不足 {insufficientCount}
          </small>
        </div>
        <div className="panel">
          <Target size={20} />
          <span>优质股票</span>
          <b>{uniqueStockCount}</b>
          <small>仅统计复核通过策略</small>
        </div>
        <div className="panel">
          <Gauge size={20} />
          <span>本轮复核</span>
          <b>{report ? report.processed ?? report.universeSize ?? report.candidateCount ?? "--" : "--"}</b>
          <small>
            最近11日候选 {report?.availableUniverseSize ?? report?.universeSize ?? "--"}
            {report?.failed ? ` · 失败 ${report.failed}` : ""}
          </small>
        </div>
        <div className="panel">
          <Database size={20} />
          <span>历史数据窗口</span>
          <b>{coverage.historyBarsRequested === null ? "--" : `${coverage.historyBarsRequested.toFixed(0)} 根（约三年）`}</b>
          <small title={report?.source || ""}>
            {report?.source || "等待生成"} · 基准 {fmt(coverage.benchmarkBars, 0)} 根
          </small>
        </div>
        <div className="panel">
          <Activity size={20} />
          <span>样本多样性</span>
          <b>
            {report?.sampleDiversity
              ? `${report.sampleDiversity.boardCount ?? "--"} 板 / ${report.sampleDiversity.dateCohortCount ?? "--"} 期`
              : "--"}
          </b>
          <small>
            证券 {report?.sampleDiversity?.securities ?? "--"} · 行业/题材 {report?.sampleDiversity?.industryOrThemeCount ?? "--"} ·
            {report?.sampleDiversity?.diversified ? " 覆盖达标" : " 覆盖仍不足"}
            {report?.sampleDiversity?.concentrationWarnings?.length ? " · 主板偏重" : ""}
          </small>
        </div>
      </section>

      {loading && !report && (
        <div className="panel strategy-signal-loading">
          <LoaderCircle className="spin" size={32} />
          <b>最近三年策略复核正在后台运行</b>
          <p>最多为 300 只候选读取每只 720 根日线（约 3 年），再执行训练集、样本外与四段走步复核；计算已与主界面隔离，加载期间可以正常切换并使用其他功能。</p>
        </div>
      )}
      {error && !loading && (
        <div className="panel strategy-signal-error">
          <CircleAlert size={28} />
          <b>策略信号生成失败</b>
          <p>{error}</p>
          <button className="secondary-btn" onClick={() => load(true)}>重试</button>
        </div>
      )}

      {!!report?.strategies.length && (
        <section className="strategy-signal-layout">
          <aside className="panel strategy-signal-tabs">
            <header>
              <Activity size={18} />
              <div><b>策略复核库</b><small>组合共振与基础策略分组审计</small></div>
            </header>
            <div className="strategy-signal-tab-list">
              {renderStrategyTabs(compositeStrategies, "组合共振策略", "composite")}
              {renderStrategyTabs(baseStrategies, "基础策略", "base")}
            </div>
            <footer>
              <Clock3 size={15} />
              信号会随最新行情变化，历史优势不代表未来收益。
            </footer>
          </aside>

          <div className="strategy-signal-main">
            {activeGroup && (
              <>
                <section className="panel strategy-signal-group-head">
                  <div className="strategy-signal-group-copy">
                    <span className="strategy-signal-active-kicker">
                      {activeComposite ? "ACTIVE COMPOSITE" : "ACTIVE BASE STRATEGY"}
                    </span>
                    <div className="strategy-signal-title-line">
                      <h2>{activeGroup.name}</h2>
                      <i className={`strategy-type-badge ${activeComposite ? "composite" : "base"}`}>
                        {activeComposite ? "组合共振" : "基础策略"}
                      </i>
                    </div>
                    <p>{activeGroup.detail || activeGroup.description}</p>
                    <button
                      className="secondary-btn strategy-group-backtest-btn"
                      onClick={() => onOpenBacktest({
                        securities: activeStocks,
                        universeSource: "strategy_current_matches",
                        universeTotalCount: activeStocks.length,
                        source: "single_strategy",
                        strategyEngine: "verified-signal-v2",
                        strategyId: activeGroup.id,
                        strategyName: activeGroup.name,
                        strategyIds: [activeGroup.id],
                        minimumVotes: 1
                      })}
                    >
                      <Target size={16} />
                      带入回测中心
                    </button>
                  </div>
                  <ValidationPanel group={activeGroup} report={report} />
                  {(activeComposite ||
                    activeGroup.conditions?.length ||
                    activeGroup.risk) && (
                    <div className={`strategy-rule-panel ${activeComposite ? "composite" : "base"}`}>
                      <header>
                        <Sparkles size={16} />
                        <div>
                          <b>{activeComposite ? "组合共振构成" : "基础策略规则"}</b>
                          <small>
                            {activeComposite
                              ? "组件只说明规则构成，不代表放宽发布复核门槛"
                              : "单策略硬条件与风险否决"}
                          </small>
                        </div>
                      </header>
                      {activeComposite && (
                        <div className="strategy-rule-field components">
                          <span>组成策略</span>
                          <div>
                            {(activeGroup.components || []).map((componentId) => (
                              <em key={componentId}>
                                {componentName(componentId, strategyNames)}
                              </em>
                            ))}
                          </div>
                        </div>
                      )}
                      {activeComposite && (
                        <div className="strategy-rule-field vote">
                          <span>投票 / 同时满足</span>
                          <b>
                            {activeGroup.voteRule ||
                              "服务端未返回组合投票规则，不据此推测命中。"}
                          </b>
                        </div>
                      )}
                      {!!activeGroup.conditions?.length && (
                        <div className="strategy-rule-field conditions">
                          <span>{activeComposite ? "组合硬条件" : "策略硬条件"}</span>
                          <ul>
                            {activeGroup.conditions.map((condition) => (
                              <li key={condition}>{condition}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {activeGroup.risk && (
                        <div className="strategy-rule-field risk">
                          <span>策略风险</span>
                          <p>{activeGroup.risk}</p>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="panel strategy-stock-panel">
                  <div className="strategy-stock-panel-title">
                    <div>
                      {activeAccepted ? <TrendingUp size={18} /> : <ShieldAlert size={18} />}
                      <span>
                        <b>{activeAccepted ? "本轮复核全部合格股票" : "当前不发布优质股票"}</b>
                        <small>
                          {activeAccepted
                            ? activeComposite
                              ? "同一股票须达到当前组合的投票与同时满足规则"
                              : "按信号质量排序，不跨策略混合"
                            : activeValidationState === "insufficient"
                              ? "样本或数据覆盖不足，命中候选仅保留在后台审计"
                              : "样本外或走步复核未通过，命中候选仅保留在后台审计"}
                        </small>
                      </span>
                    </div>
                    <em>{activeStocks.length} 只</em>
                  </div>
                  <div className="strategy-stock-table">
                    <div className="strategy-stock-row head">
                      <span>股票 / 板块</span>
                      <span>行情</span>
                      <span>信号质量</span>
                      <span>{activeComposite ? "命中组件 / 策略依据" : "策略依据"}</span>
                      <span>风险 / 操作</span>
                    </div>
                    {activeStocks.map((stock) => {
                      const reasons = stock.reasons || stock.matchedReasons || [];
                      const risks = Array.isArray(stock.risks) ? stock.risks : [];
                      const riskVetoPassed = stock.riskVetoStatus === "passed";
                      const matchedComponents = activeComposite
                        ? matchedComponentIds(stock, activeGroup, strategyNames)
                        : [];
                      return (
                        <div
                          className="strategy-stock-row"
                          key={stock.code}
                        >
                          <span className="strategy-stock-name">
                            <b>{stock.name}<small>{stock.code}</small></b>
                            <em>{stock.industry || "未分类"} · {stock.observationNode || stock.limitDate || "当前"}</em>
                          </span>
                          <span>
                            <b>{fmt(stock.latest, 2)}</b>
                            <em
                              className={
                                nullableNumber(stock.changePct) === null
                                  ? ""
                                  : number(stock.changePct) >= 0
                                    ? "red"
                                    : "green"
                              }
                            >
                              {pct(stock.changePct)}
                            </em>
                            <small>换手 {unit(stock.turnover, 1, "%")} · {money(stock.amount)}</small>
                          </span>
                          <span>
                            <b>{unit(stock.signalScore ?? stock.score ?? stock.mrs, 0, "分")}</b>
                            <em>{stock.grade || "--"}级 · 匹配 {unit(stock.strategyMatchRate, 0, "%")}</em>
                          </span>
                          <span className={`strategy-stock-reasons ${activeComposite ? "composite" : ""}`}>
                            {activeComposite && (
                              <span className="strategy-stock-component-hits">
                                <small>
                                  本股命中组件 {matchedComponents.length}/{activeGroup.components?.length || 0}
                                </small>
                                <span>
                                  {matchedComponents.length ? (
                                    matchedComponents.map((componentId) => (
                                      <i key={componentId}>
                                        {componentName(componentId, strategyNames)}
                                      </i>
                                    ))
                                  ) : (
                                    <i className="missing">组件明细未返回</i>
                                  )}
                                </span>
                              </span>
                            )}
                            <span className="strategy-stock-reason-tags">
                              {reasons.length
                                ? reasons.map((reason) => (
                                    <em key={reason}>{reason}</em>
                                  ))
                                : <em>通过策略硬条件</em>}
                            </span>
                          </span>
                          <span className="strategy-stock-action">
                            <small className={risks.length || !riskVetoPassed ? "has-risk" : "no-risk"}>
                              {risks.length
                                ? risks[0]
                                : riskVetoPassed
                                  ? "风险否决已核验通过"
                                  : "风险状态未完成核验"}
                            </small>
                            <span className="strategy-stock-row-actions">
                              <button onClick={() => onOpen(stock)}>
                                详细复盘 <ChevronRight size={14} />
                              </button>
                              <button
                                onClick={() => onOpenBacktest({
                                  security: stock,
                                  source: "single_strategy",
                                  strategyEngine: "verified-signal-v2",
                                  strategyId: activeGroup.id,
                                  strategyName: activeGroup.name,
                                  strategyIds: [activeGroup.id],
                                  minimumVotes: 1
                                })}
                              >
                                用该策略回测
                              </button>
                            </span>
                          </span>
                        </div>
                      );
                    })}
                    {!activeStocks.length && (
                      <div className="strategy-stock-empty">
                        <ShieldAlert size={28} />
                        <b>
                          {activeAccepted
                            ? "当前没有股票通过这套策略的全部过滤"
                            : activeValidationState === "insufficient"
                              ? "这套策略的真实数据不足"
                              : "这套策略仍在观察中"}
                        </b>
                        <p>
                          {activeAccepted
                            ? "不以放宽风险阈值凑数；等待下一次行情刷新。"
                            : "不把未验证候选包装成优质信号；可查看上方完整拒绝原因。"}
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        </section>
      )}

      {report && !report.strategies.length && !loading && !error && (
        <div className="panel strategy-stock-empty">
          <ShieldAlert size={30} />
          <b>暂无可复核策略结果</b>
          <p>当前数据源没有返回足够历史样本，未生成推测性股票名单。</p>
        </div>
      )}

      {report && (
        <div className="strategy-method-note">
          <CheckCircle2 size={16} />
          <span>
            {report.methodology}
            {report.historyBarsRequested
              ? ` 服务端回传历史请求窗口 ${report.historyBarsRequested} 根日线（约 ${Math.max(1, Math.round(report.historyBarsRequested / 240))} 年）。`
              : " 服务端未回传历史请求窗口。"}
            {report.generatedAt
              ? ` 本轮生成于 ${new Date(report.generatedAt).toLocaleString("zh-CN", { hour12: false })}。`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
}
