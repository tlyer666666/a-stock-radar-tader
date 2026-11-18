import { marketCapitalization } from "./marketCapitalization";
import { clampNumber, normalizeSettings, safeNumber } from "./settings";
import { normalizePaperExecutionReadiness } from "./executionReadiness";
import { estimatePaperOrderExecutionModel } from "../features/paper-simulation/paperSimulationEngine";
import type { AnalysisPayload } from "../features/market/analysisTypes";

type RawAnalysisProjection = Record<string, unknown> & {
  mrs?: unknown;
  stopLossDistancePercent?: unknown;
  marketCap?: unknown;
  strategyMatchRate?: unknown;
  maxDrawdown?: unknown;
  riskPenalty?: unknown;
  historicalEdge?: unknown;
  qualification?: { historicalEdgePassed?: unknown; vetoReasons?: unknown[]; strength?: unknown } | null;
  edge?: unknown;
  marketScore?: unknown;
  strategyMatched?: number;
  strategyTotal?: number;
  alertQualified?: unknown;
  historicalStats?: { currentCombination?: Record<string, unknown>; stats?: Array<Record<string, unknown>> };
  relativeTurnover?: unknown;
  volumeRatio?: unknown;
  trendLabel?: unknown;
  grade?: unknown;
  infoScore?: unknown;
  tradePlan?: Record<string, unknown> | undefined;
  tradeProjection?: (Record<string, unknown> & { projection?: Record<string, unknown> | undefined }) | undefined;
  executionPolicy?: Record<string, unknown> | undefined;
  tradeExecutionReadiness?: unknown;
  executionReadiness?: unknown;
};
type RawQuoteProjection = Record<string, unknown> & { latest?: unknown; turnover?: unknown; changePct?: unknown; totalMarketCap?: unknown; missingFields?: unknown };

export const computeExecutionProjection = (
  analysis: RawAnalysisProjection | null | undefined,
  quote: RawQuoteProjection | null | undefined,
  settings: Settings
) => {
  const safe = normalizeSettings(settings);
  const src: RawAnalysisProjection = analysis || {};
  const latest = clampNumber(quote?.latest, 0.01, Number.MAX_SAFE_INTEGER, 0);
  const executionModel = estimatePaperOrderExecutionModel(
    { analysis: src, quote: quote || {} } as Pick<AnalysisPayload, "analysis" | "quote"> as AnalysisPayload,
    safe
  );
  const mrs = clampNumber(src.mrs, 50, 100, 50);
  const stopRatio = clampNumber(src.stopLossDistancePercent, 0.8, 22, 0);
  const marketCap = marketCapitalization(quote ?? undefined, src.marketCap);
  const qualityIndex = clampNumber(
    0.6 * mrs + 0.4 * clampNumber(src.strategyMatchRate, 0, 100, 50) - clampNumber(src.maxDrawdown, 0, 20, 0) - clampNumber(src.riskPenalty, 0, 10, 0),
    0,
    100,
    0
  );
  // R-01 修复：服务端 analysis.historicalEdge 是**对象**
  // （{ passed, sampleCount, winRate5, average5, worstMdd5, penalty, reasons }），
  // 不是数字。原实现用 `Number.isFinite(src.historicalEdge) ? … : clampNumber((src.historicalEdge || …))`，
  // 对象为真值 → `||` 短路 → clampNumber(对象) → **恒等于 0**，
  // 导致「历史边界」永远显示 0%，与同屏「历史通过/未通过」自相矛盾。
  //
  // 正确用法在项目里已有范本（ProfessionalReview.tsx:544 / MultiStockCompareView.tsx:498）：
  // 取 average5（平均 5 日收益%）作为展示数值，passed 取对象的权威判定。
  const edgeObject = src.historicalEdge && typeof src.historicalEdge === "object"
    ? (src.historicalEdge as { average5?: unknown; winRate5?: unknown; passed?: unknown })
    : null;
  const historicalEdge = edgeObject
    ? clampNumber(edgeObject.average5 ?? edgeObject.winRate5 ?? 0, -20, 80, 0)
    : Number.isFinite(src.historicalEdge)
      ? (src.historicalEdge as number)
      : clampNumber((src.edge || src.marketScore || 0), -20, 80, 0);
  const historicalEdgePassed = src.qualification?.historicalEdgePassed === true
    ? true
    : edgeObject && typeof edgeObject.passed === "boolean"
      ? edgeObject.passed
      : historicalEdge >= 2;
  const minMarketCap = clampNumber(safe.minMarketCap, 0, 100000, 0);
  const marketCapPassed = minMarketCap <= 0 || (marketCap !== null && marketCap >= minMarketCap * 1e8);
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
  const comboStat = src.historicalStats?.currentCombination
    ?? (Array.isArray(src.historicalStats?.stats)
      ? src.historicalStats.stats.find((entry) => entry?.id === "currentCombination")
      : null);
  const empiricalSamples = Number(comboStat?.n5 ?? comboStat?.sampleCount);
  const empiricalWinRate5 = Number(comboStat?.winRate5);
  let tpBaseRate = clampNumber(
    18 + (qualityIndex - 40) * 0.7 + (signal === "BUY" ? 12 : 4),
    2,
    85,
    18
  );
  if (Number.isFinite(empiricalSamples) && empiricalSamples >= 10 && Number.isFinite(empiricalWinRate5)) {
    tpBaseRate = clampNumber(
      0.65 * tpBaseRate + 0.35 * clampNumber(empiricalWinRate5, 0, 100, tpBaseRate),
      2,
      85,
      tpBaseRate
    );
  }
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
  const projectedNetEdge = expectedReturnPercent;
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
    if (!marketCapPassed) reasons.push(marketCap === null ? "未取得市值，无法核对阈值" : "市值未达阈值");
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

export const auditStrategyFit = (qualification: RawAnalysisProjection["qualification"], matched = 0, total = 0) => {
  if (qualification && typeof qualification === "object") {
    if (qualification.vetoReasons?.length) return false;
    if (typeof qualification.strength === "number" && qualification.strength < 0.5) return false;
  }
  if (Number.isFinite(total) && Number.isFinite(matched)) {
    return matched / Math.max(total, 1) >= 0.35;
  }
  return true;
};

// 服务端原始的交易计划/执行字段。快速刷新行情时要用它重新合并，而不是用上次合并后的结果（否则按旧价算的计划会被冻结）。
type ServerExecutionParts = {
  tradePlan: RawAnalysisProjection["tradePlan"];
  tradeProjection: RawAnalysisProjection["tradeProjection"];
  executionPolicy: RawAnalysisProjection["executionPolicy"];
};
const serverExecutionParts = new WeakMap<object, ServerExecutionParts>();

export const enrichAnalysisWithExecution = (payload: AnalysisPayload, settings: Settings): AnalysisPayload => {
  const enriched = (payload?.analysis || {}) as RawAnalysisProjection;
  if (!enriched || typeof enriched !== "object") return payload;
  const raw = serverExecutionParts.get(enriched) || { tradePlan: enriched.tradePlan, tradeProjection: enriched.tradeProjection, executionPolicy: enriched.executionPolicy };
  const analysis: RawAnalysisProjection = { ...enriched, tradePlan: raw.tradePlan, tradeProjection: raw.tradeProjection, executionPolicy: raw.executionPolicy };
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
  const next: AnalysisPayload = {
    ...payload,
    analysis: {
      ...payload.analysis,
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
  serverExecutionParts.set(next.analysis, raw);
  return next;
};
