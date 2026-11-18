import { executionStatusLabel } from "../../domain/executionLabels";
import { normalizeBacktestExecutionReadiness, type BacktestExecutionReadiness } from "../../domain/executionReadiness";
import { clampNumber, normalizeSettings, riskProfileLabel, sameStrategySet } from "../../domain/settings";
import { mergeReasonArrays } from "../paper-simulation/paperSimulationEngine";
import { normalizeBacktestStrategyIds } from "./backtestModel";
import type { BacktestExecutionPlan, BacktestStrategyProfile } from "./backtestTypes";

export const toSafeBacktestSettings = (nextSettings: Settings) => {
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
export const toBacktestStrategyProfile = (nextSettings: Settings): BacktestStrategyProfile => {
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
export const buildBacktestProfileDiff = (
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
export type BacktestDeRiskProfileResult = {
  profile: BacktestStrategyProfile;
  adjustments: string[];
};
export const buildBacktestDeRiskProfile = (
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
  addDiff("最小成交率", source.minExecutionRatePercent, next.minExecutionRatePercent, "%");
  addDiff("追踪止损", source.trailingStopPercent, next.trailingStopPercent, "%");
  addDiff("减仓步幅", source.lossStepPercent, next.lossStepPercent, "%");
  addDiff("减仓下限", source.lossFloorPercent, next.lossFloorPercent, "%");
  addDiff("连续亏损熔断", source.maxConsecutiveLossesForStop, next.maxConsecutiveLossesForStop, " 次");
  addDiff("时间衰减", source.timeDecayPerBarPercent, next.timeDecayPerBarPercent, "%");

  return {
    profile: next,
    adjustments: adjustments.length
      ? adjustments
      : ["已触发“等待确认”风控兜底，自动收紧仓位与持仓约束"]
  };
};
export const evaluateBacktestExecutionReadiness = (
  metrics: Record<string, unknown> | null,
  profileDiffs: Array<{ label: string; sourceValue: string; targetValue: string }>,
  executionReadinessInput?: unknown
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
const score = clampNumber(Math.round(rawScore - (accepted ? 0 : 28)), 0, 100);
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
export const buildBacktestExecutionPlan = (
  metrics: Record<string, unknown> | null,
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
