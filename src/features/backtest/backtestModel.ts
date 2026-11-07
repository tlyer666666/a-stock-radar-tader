import { clampNumber, initialSettings, normalizeRiskProfile, normalizeSettings } from "../../domain/settings";
import { shiftShanghaiDate } from "../../dateUtils";
import type { BacktestDraft, BacktestStrategyProfile, StrategyBacktestRequest } from "./backtestTypes";

export const MIN_SINGLE_BACKTEST_BARS = 120;
export const MAX_SINGLE_BACKTEST_BARS = 2500;
export const DEFAULT_SINGLE_BACKTEST_BARS = 120;

export const defaultBacktestStartDate = () => shiftShanghaiDate(-1);

export const normalizeBacktestStrategyIds = (value: any): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
};

export const normalizeBacktestStrategyContext = (input: any): StrategyBacktestRequest | undefined => {
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
      : input.universeSource === "manual" ? { universeSource: "manual" as const } : {}),
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

export const normalizeBacktestDraft = (input: Partial<BacktestDraft> = {}): BacktestDraft => ({
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

export const normalizeBacktestStrategyProfile = (
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

