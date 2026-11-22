import { clampNumber, initialSettings, normalizeRiskProfile, normalizeSettings } from "../../domain/settings";
import { shiftShanghaiDate } from "../../dateUtils";
import type { BacktestDraft, BacktestStrategyProfile, StrategyBacktestRequest } from "./backtestTypes";

export const MIN_SINGLE_BACKTEST_BARS = 120;
export const MAX_SINGLE_BACKTEST_BARS = 2500;
export const DEFAULT_SINGLE_BACKTEST_BARS = 120;

/**
 * 单股回测默认看近 3 年：涨停类信号在单只股票上很稀少，只看 1 年经常一笔交易都没有，
 * 3 年是「样本够看、行情又不算太旧」的折中；界面上可一键切到近 1 年 / 近 5 年。
 */
export const DEFAULT_BACKTEST_YEARS = 3;
export const defaultBacktestStartDate = () => shiftShanghaiDate(-DEFAULT_BACKTEST_YEARS);
export const BACKTEST_RANGE_PRESETS = [
  { id: "1y", label: "近1年", years: 1 },
  { id: "3y", label: "近3年", years: 3 },
  { id: "5y", label: "近5年", years: 5 }
] as const;
export const backtestRangeStartDate = (years: number, date = new Date()) => shiftShanghaiDate(-Math.abs(years), date);

type StrategyLike = { id?: unknown; featured?: unknown; retired?: unknown };

/**
 * 回测默认勾选的策略：全部「精选」策略（全A实测留强的那几套，未下线），任一命中即买入。
 * 单独勾一套时单只股票往往没有样本；一起跑既有样本，又能在「各策略独立收益对比」里看出哪套适合这只股票。
 */
export function featuredBacktestStrategyIds(definitions: ReadonlyArray<StrategyLike>): string[] {
  const usable = definitions.filter(item => item && item.id);
  const featured = usable.filter(item => item.featured === true && item.retired !== true).map(item => String(item.id));
  if (featured.length) return featured;
  return usable[0] ? [String(usable[0].id)] : [];
}

export type BacktestOutcomeTone = "empty" | "profit" | "loss" | "flat";
export type BacktestOutcome = {
  tone: BacktestOutcomeTone;
  tradeCount: number;
  /** 一句话结论，直接告诉用户赚没赚、赚了几次。 */
  headline: string;
  /** 样本太少等需要提醒的话；没有则为空。 */
  caution: string;
};

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const signedPercent = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

/** 把回测收益汇总翻译成一句大白话；缺失的数字不编造。 */
export function describeBacktestOutcome(
  summary: Record<string, unknown> | null | undefined,
  range: { from?: unknown; to?: unknown } = {},
  minReliableTrades = 5
): BacktestOutcome {
  const tradeCount = Math.max(0, Math.floor(finiteOrNull(summary?.tradeCount) ?? 0));
  const period = range.from ? `${String(range.from)} 至${range.to ? ` ${String(range.to)} ` : "今"}` : "所选区间内";
  if (!tradeCount) {
    return {
      tone: "empty",
      tradeCount: 0,
      headline: `${period.trim()}，所选策略在这只股票上没有触发过可成交的买入，所以没有收益可算。`,
      caution: "这不代表策略不好，只是单只股票上这类信号本来就少。"
    };
  }
  const wins = finiteOrNull(summary?.profitableTrades);
  const losses = finiteOrNull(summary?.losingTrades);
  const winRate = finiteOrNull(summary?.winRatePercent);
  const net = finiteOrNull(summary?.totalNetReturnPercent);
  const drawdown = finiteOrNull(summary?.maxDrawdownPercent);
  const parts = [`${period}共完成 ${tradeCount} 笔交易`];
  if (wins !== null && losses !== null) parts.push(`${wins} 笔赚、${losses} 笔亏${winRate !== null ? `（胜率 ${winRate.toFixed(1)}%）` : ""}`);
  if (net !== null) parts.push(`扣费后累计 ${signedPercent(net)}`);
  if (drawdown !== null && drawdown !== 0) parts.push(`期间资金最大回撤 ${Math.abs(drawdown).toFixed(2)}%`);
  const tone: BacktestOutcomeTone = net === null || net === 0 ? "flat" : net > 0 ? "profit" : "loss";
  return {
    tone,
    tradeCount,
    headline: `${parts.join("，")}。`,
    caution: tradeCount < minReliableTrades ? `只有 ${tradeCount} 笔交易，样本太少，结论仅供参考；可以把开始日期往前调，或多选几套策略。` : ""
  };
}

/** 历史记录卡片用的精简摘要：交易笔数、胜率、累计净收益，取不到的留空。 */
export function summarizeBacktestRecord(record: { rawResult?: { profitSummary?: Record<string, unknown> | null } | null } | null | undefined): {
  tradeCount: number | null; winRatePercent: number | null; netReturnPercent: number | null; tone: BacktestOutcomeTone;
} {
  const summary = record?.rawResult?.profitSummary;
  if (!summary || typeof summary !== "object") return { tradeCount: null, winRatePercent: null, netReturnPercent: null, tone: "empty" };
  const tradeCount = finiteOrNull(summary.tradeCount);
  const netReturnPercent = finiteOrNull(summary.totalNetReturnPercent);
  const tone: BacktestOutcomeTone = !tradeCount ? "empty" : netReturnPercent === null || netReturnPercent === 0 ? "flat" : netReturnPercent > 0 ? "profit" : "loss";
  return { tradeCount, winRatePercent: tradeCount ? finiteOrNull(summary.winRatePercent) : null, netReturnPercent: tradeCount ? netReturnPercent : null, tone };
}

export const normalizeBacktestStrategyIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
};

export const normalizeBacktestStrategyContext = (rawInput: unknown): StrategyBacktestRequest | undefined => {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const input = rawInput as Record<string, unknown> & { security?: Record<string, unknown> };
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
      ...(input.security as Partial<Security>),
      code: String(input.security.code),
      name: String(input.security.name || input.security.code),
      secid: String(input.security.secid || "")
    } as Security
    : undefined;
  const securities: Security[] = Array.isArray(input.securities)
    ? [...new Map<string, Security>(input.securities.flatMap((rawItem: unknown): Array<[string, Security]> => {
      const item = (rawItem && typeof rawItem === "object" ? rawItem : {}) as Record<string, unknown>;
      const code = String(item.code || "").trim();
      if (!/^\d{6}$/.test(code)) return [];
      return [[code, {
        ...(item as Partial<Security>),
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
  input: unknown,
  fallbackSettings: Settings,
  draft: BacktestDraft,
  strategyIds: string[]
): BacktestStrategyProfile => {
  const safeSettings = normalizeSettings(fallbackSettings);
  const normalizedProfile = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const selected = normalizeBacktestStrategyIds(normalizedProfile.selectedStrategies);
  const selectedStrategies = selected.length ? selected : strategyIds;
  return {
    selectedStrategies: normalizeBacktestStrategyIds(
      selectedStrategies.length ? selectedStrategies : safeSettings.selectedStrategies
    ),
    riskProfile: normalizeRiskProfile(
      normalizedProfile.riskProfile || normalizedProfile.riskProfileName || safeSettings.riskProfile || "balanced"
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

