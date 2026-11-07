import type { AnalysisPayload } from "../market/analysisTypes";
import { normalizePaperExecutionReadiness, type PaperExecutionReadiness } from "../../domain/executionReadiness";
import { fmtMoney } from "../../domain/formatters";
import { paperCloseReasonLabel, type PaperClosedPosition, type PaperPosition } from "../../domain/paperSimulationTypes";
import { clampNumber, normalizeRiskProfile, normalizeSettings } from "../../domain/settings";
import { shanghaiDateTag } from "../../dateUtils";
import { advancePaperHoldingBars } from "../../paperHoldingBars";
import {
  buildPaperStrategySignature, normalizePaperState, resetPaperStateForNewDay, settlePaperPosition
} from "./paperSimulationState";
import type {
  PaperSimulationState, PaperStrategyGovernance, PaperStrategyStage, PaperTradeAction
} from "./paperSimulationTypes";

import { calcAshareBuyFee, paperDate, paperMatchBlock, paperQuoteEvidence, paperCorporateActionBlock, paperLotRule, paperRoundShares } from "./paperTradingRules";

import { closeStats, compactClosedHistory } from "./paperClosedHistory";

const PAPER_SIM_COOLDOWN_MINUTES = 4;
const PAPER_SIM_COOLDOWN_MS = PAPER_SIM_COOLDOWN_MINUTES * 60 * 1000;
const todayTag = shanghaiDateTag;

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

export const getPaperAccountMetrics = (state: PaperSimulationState) => {
  const normalized = normalizePaperState(state);
  const openValue = normalized.openPositions.reduce((sum, p) => sum + p.latestPrice * p.shares, 0);
  const openCost = normalized.openPositions.reduce((sum, p) => sum + p.entryPrice * p.shares + p.entryFee, 0);
  const equity = normalized.cash + openValue;
  const archived = normalized.closedArchive?.total;
  let cursor = normalized.initialCapital + (archived?.grossProfit ?? 0) - (archived?.grossLoss ?? 0);
  let peak = Math.max(normalized.initialCapital, normalized.equityPeak || 0, equity);
  let maxDrawdownPercent = normalized.maxDrawdownPercent || 0;
  if (archived) {
    const archivedLow = normalized.initialCapital + archived.minGain;
    maxDrawdownPercent = Math.max(maxDrawdownPercent, archived.drawdown, (peak - archivedLow) / peak * 100);
    peak = Math.max(peak, normalized.initialCapital + archived.peakGain);
  }
  for (const p of [...normalized.closedPositions].sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))) {
    cursor += p.realizedPnl;
    peak = Math.max(peak, cursor);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, peak > 0 ? (peak - cursor) / peak * 100 : 0);
  }
  maxDrawdownPercent = Math.max(maxDrawdownPercent, peak > 0 ? (peak - equity) / peak * 100 : 0);
  return { openValue, openCost, openPnl: openValue - openCost, equity, equityPeak: peak, maxDrawdownPercent };
};

const recordPaperEquity = (state: PaperSimulationState): PaperSimulationState => {
  const bounded = { ...state, ...compactClosedHistory(state.closedPositions, state.closedArchive, state.initialCapital, todayTag()) };
  const metrics = getPaperAccountMetrics(bounded);
  return { ...bounded, equityPeak: metrics.equityPeak, maxDrawdownPercent: metrics.maxDrawdownPercent };
};

export const evaluatePaperKillSwitch = (state: PaperSimulationState, settings: Settings): PaperKillSignal => {
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
  const equity = normalized.cash + openValue;
  const portfolioExposurePercent = equity > 0 ? openValue / equity * 100 : 0;
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

export const getPaperLossStreakState = (state: PaperSimulationState, settings: Settings): PaperLossStreakSignal => {
  const safe = normalizeSettings(settings);
  const today = todayTag();
  const maxConsecutiveLossesForStop = Math.round(clampNumber(safe.maxConsecutiveLossesForStop ?? 4, 2, 12, 4));
  const stepPercent = clampNumber(safe.lossStreakStepPercent ?? 18, 2, 60, 18);
  const floorPercent = clampNumber(safe.lossStreakFloorPercent ?? 30, 10, 80, 30);
  const todayCloses = [...state.closedPositions]
    .filter((position) => paperDate(position.closeTime) === today)
    .sort((a, b) => new Date(b.closeTime).getTime() - new Date(a.closeTime).getTime());
  let consecutiveLosses = 0;
  for (const record of todayCloses) {
    if (record.realizedPnl < 0) {
      consecutiveLosses += 1;
      continue;
    }
    break;
  }

  if (consecutiveLosses === todayCloses.length && state.closedArchive?.daily.date === today) {
    consecutiveLosses += state.closedArchive.daily.streak;
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

export const getPaperDailyTradeSignal = (state: PaperSimulationState, settings: Settings): PaperDailyTradeSignal => {
  const normalized = normalizePaperState(state);
  const safe = normalizeSettings(settings);
  const today = todayTag();
  const todayOpenCount = normalized.openPositions.filter(
    (position) => paperDate(position.openedAt || "") === today
  ).length;
  const todayClosed = normalized.closedPositions.filter(
    (position) => paperDate(position.closeTime || "") === today
  );
  const archivedDay = normalized.closedArchive?.daily.date === today ? normalized.closedArchive.daily : undefined;
  const todayClosedCount = todayClosed.length + (archivedDay?.closes ?? 0);
  const todayClosedWinCount = (archivedDay?.wins ?? 0) + todayClosed.filter((position) => Number(position.realizedPnl) > 0).length;
  const todayTradeCount = todayOpenCount + (archivedDay?.opens ?? 0) + normalized.closedPositions.filter(position => paperDate(position.openedAt || "") === today).length;
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

export const evaluatePaperStrategyGovernance = (
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
  const archived = normalized.closedArchive?.strategies.find(([key]) => key === signature)?.[1];
  const completeHistory = Boolean(archived) || !normalized.closedArchive?.strategyLimitReached;
  const trades = normalized.closedPositions.filter(position => position.strategySignature === signature);
  const totals = closeStats(archived, trades, normalized.initialCapital);
  const tradeCount = totals.count;
  const { grossProfit, grossLoss } = totals;
  const realizedPnl = grossProfit - grossLoss;
  const winRate = tradeCount ? totals.wins / tradeCount * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const averageExecutionFillRatePercent = tradeCount ? totals.fillSum / tradeCount : 0;
  const peak = normalized.initialCapital + totals.peakGain;
  const liveEquity = normalized.cash + normalized.openPositions.reduce((sum, p) => sum + p.latestPrice * p.shares, 0);
  const maxDrawdownPercent = Math.max(totals.drawdown, (peak - liveEquity) / peak * 100, normalized.maxDrawdownPercent || 0);
  const consecutiveLosses = totals.streak;
  const recentTenPnl = totals.recent.reduce((sum,pnl) => sum + pnl, 0);
  const severeDrawdown = maxDrawdownPercent >= 12;
  const severeRecentLoss = recentTenPnl <= -normalized.initialCapital * 0.02;
  const severeLossStreak = consecutiveLosses >= 5;
  const severeProfitFactor = tradeCount >= 10 && profitFactor < 0.8;
  const severe = severeDrawdown || severeRecentLoss || severeLossStreak || severeProfitFactor;
  const latestCloseAt = totals.latest;
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
  else if (!completeHistory || tradeCount < minimumCandidateTrades) stage = "collecting";
  else if (tradeCount < minimumPromotionTrades) stage = "candidate";
  else stage = promotionPassed ? "promoted" : "degraded";
  const status =
    stage === "promoted" ? "已具备晋级资格" :
      stage === "candidate" ? "候选验证中" :
        stage === "collecting" ? "样本收集中" :
          stage === "suspended" ? "策略已暂停" : "策略已降级";
  const reasons: string[] = [];
  if (!completeHistory) reasons.push("该配置的早期明细已归档，完整历史不足以评定晋级");
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

type PaperMarketExecutionReadiness = {
  hard: string[];
  soft: string[];
  staleSeconds: number;
  quoteAmount: number;
  quoteTurnover: number;
};

export const getSectorOfPayload = (payload: AnalysisPayload | null) => {
  if (!payload) return "";
  const fromSector = typeof payload.sector?.name === "string" ? payload.sector.name.trim() : "";
  const fromQuote = typeof payload.quote?.industry === "string" ? payload.quote.industry.trim() : "";
  return fromSector || fromQuote || "";
};

export const getPaperSectorExposureValue = (state: PaperSimulationState, sectorName?: string) => {
  const target = typeof sectorName === "string" ? sectorName.trim() : "";
  if (!target) return 0;
  return state.openPositions.reduce(
    (sum, position) => (String(position.sectorName || "").trim() === target ? sum + position.latestPrice * position.shares : sum),
    0
  );
};

export const getPaperSectorExposurePercent = (state: PaperSimulationState, sectorName?: string) => {
  const exposureValue = getPaperSectorExposureValue(state, sectorName);
  const equity = state.cash + state.openPositions.reduce((sum, p) => sum + p.latestPrice * p.shares, 0);
  return equity > 0 ? exposureValue / equity * 100 : 0;
};

export const estimatePaperOrderExecutionModel = (
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

export const evaluatePaperMarketReadiness = (
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

export const mergeReasonArrays = (left: string[] = [], right: string[] = []) => {
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

export const evaluatePaperExecutionReadinessLocal = (
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
        ? `请等待至 ${new Date(strategyGovernance.suspendedUntil).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 后以降级仓位重新验证。`
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
  const latest = typeof payload.quote?.latest === "number" && Number.isFinite(payload.quote.latest) && payload.quote.latest > 0 ? payload.quote.latest : 0;
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
  const executionEntryPrice = clampNumber(
    latest * (1 + (Math.min(executionModel.executionSlipBps, safe.slippageBps * 2) || 0) / 10000),
    0.01, Number.MAX_SAFE_INTEGER, latest
  );
  const incoming = {
    code,
    name: String(security?.name || code || "UNKNOWN"),
    latestPrice: latest,
    openedAt: new Date().toISOString(),
    ...paperQuoteEvidence(payload)
  } as PaperPosition;
  const slippedBlock = paperMatchBlock(incoming, "buy", executionEntryPrice);
  if (slippedBlock) {
    return {
      score: 0,
      level: "block",
      status: "BLOCK",
      summary: "当前行情无法撮合",
      recommendation: "等待有效行情后再试。",
      reasons: [slippedBlock],
      canExecute: false
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
  const finalStop = Math.min(stopPriceCandidate, executionEntryPrice * (1 - stopDistancePercent / 100), executionEntryPrice * 0.99);
  const finalTake = Math.max(takePriceCandidate, executionEntryPrice * (1 + takeDistancePercent / 100), executionEntryPrice + 0.01);
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
          reasons: [`最近一次开仓在 ${new Date(lastOpenAt).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`],
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

export const evaluatePaperExecutionReadiness = (
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

export const closePaperAllSimulationByCode = (
  state: PaperSimulationState,
  reason: PaperClosedPosition["closeReason"] = "KILL_SWITCH",
  settings: Settings
) => {
  const hydrated = normalizePaperState(state);
  const normalized = resetPaperStateForNewDay(hydrated);
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

  const remain: PaperPosition[] = [];
  const blocks: string[] = [];
  for (const position of normalized.openPositions) {
    let block = paperMatchBlock(position, "sell", position.latestPrice * (1 - (settings.slippageBps || 0) / 10000));
    // 紧急风控熔断或一键平仓时，若仅因未单独浏览该股导致缺少今日行情，只要满足T+1且有有效最新价，允许按最新价强平
    // 但停牌、跌停等规则仍按最后一次行情检查：最后一次行情是停牌或跌停价的，不强平。
    if (block === "缺少今日有效行情，暂停撮合" && position.latestPrice > 0 && !position.settlementBlockedReason) {
      block = paperMatchBlock({ ...position, quoteDate: shanghaiDateTag() }, "sell", position.latestPrice * (1 - (settings.slippageBps || 0) / 10000));
    }
    if (block) { remain.push(position); blocks.push(`${position.code} ${block}`); continue; }
    const closePrice = position.latestPrice;
    const settle = settlePaperPosition(position, closePrice, reason, now, settings);
    cash += settle.cashDelta;
    dailyRealizedPnl += settle.record.realizedPnl;
    closedPositions.unshift(settle.record);
  }

  return {
    state: recordPaperEquity({
      ...normalized,
      cash,
      dailyRealizedPnl,
      openPositions: remain,
      closedPositions
    }),
    changed: remain.length !== normalized.openPositions.length,
    message: `${paperCloseReasonLabel(reason)}：已平 ${normalized.openPositions.length - remain.length} 笔${blocks.length ? `；保留 ${blocks.join("；")}` : ""}`
  };
};

export const openPaperPositionFromSignal = (
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
  const latest = typeof payload.quote?.latest === "number" && Number.isFinite(payload.quote.latest) && payload.quote.latest > 0 ? payload.quote.latest : 0;
  const incoming = { code, name, latestPrice: latest, openedAt: nowIso, ...paperQuoteEvidence(payload) } as PaperPosition;
  const marketBlock = paperCorporateActionBlock(incoming, payload) || paperMatchBlock(incoming, "buy", latest);
  if (marketBlock) return { state: normalized, changed: false, message: marketBlock };
  const executionModel = estimatePaperOrderExecutionModel(payload, safe);
  const executionEntryPrice = clampNumber(
    latest * (1 + (Math.min(executionModel.executionSlipBps, safe.slippageBps * 2) || 0) / 10000),
    0.01,
    Number.MAX_SAFE_INTEGER,
    latest
  );
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
    const forcedClose = closePaperAllSimulationByCode(normalized, "KILL_SWITCH", safe);
    if (forcedClose.changed) {
      return {
        ...forcedClose,
        message: `风控熔断：${preOpenKill.reasons.join("；")}；${forcedClose.message}`
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
    ? (normalized.cash + normalized.openPositions.reduce((sum, p) => sum + p.latestPrice * p.shares, 0)) * (maxSectorExposurePercent / 100)
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
    paperRoundShares(code, maxRiskMoney / (latest * (stopDistancePercent / 100) || 1))
  );
  const lot = paperLotRule(code);
  let shares = paperRoundShares(code, plannedSizeCash / latest);
  // F-02 修复：风险上限必须始终生效。
  //
  // 原实现 `if (sharesByRisk > 0) shares = Math.min(...)` 在「风险金额不足一手」
  // （整手向下去整得 0）时**静默跳过**约束 —— 风控形同不存在。实测设置 0.2% 上限，
  // 实际下单风险可达 1.00%（5 倍）。
  //
  // 这里改为与本函数下方「行业集中度」一致的写法：不足一手就显式拒绝下单，
  // 而不是用「0 = 无约束」这种会让风控失效的语义。
  if (sharesByRisk <= 0) {
    return {
      state: normalized,
      message: `按当前单笔风险上限 ${safe.maxRiskPerTradePercent}% 可买不足${lot.step === 100 ? " 1 手" : "最低申报数"}（${lot.min} 股），本次不建仓；如需提高上限请在设置中调整`,
      changed: false
    };
  }
  shares = Math.min(shares, sharesByRisk);
  let sectorAdjusted = false;
  if (sectorName && Number.isFinite(maxSectorRiskValue) && currentSectorExposureValue < maxSectorRiskValue) {
    const sectorBudgetValue = Math.max(0, maxSectorRiskValue - currentSectorExposureValue);
    const maxSharesBySector = paperRoundShares(code, sectorBudgetValue / latest);
    if (maxSharesBySector <= 0) {
      return { state: normalized, message: `${sectorName} 行业集中度已达上限 ${maxSectorExposurePercent}%，无法新增建仓`, changed: false };
    }
    if (shares > maxSharesBySector) {
      shares = maxSharesBySector;
      sectorAdjusted = true;
    }
  }

  if (shares < lot.min) {
    return {
      state: normalized,
      message: `风险调整后仓位不足 ${lot.min} 股（策略仓位系数 ${Math.round(strategyGovernance.positionMultiplier * 100)}%），本次不追单`,
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
  const finalStop = Math.min(stopPriceCandidate, executionEntryPrice * (1 - stopDistancePercent / 100), executionEntryPrice * 0.99);
  const finalTake = Math.max(takePriceCandidate, executionEntryPrice * (1 + takeDistancePercent / 100), executionEntryPrice + 0.01);

  if (!(finalTake > finalStop && finalStop > 0)) {
    return { state: normalized, message: "止盈/止损参数异常，暂不下单", changed: false };
  }

  const entryValue = shares * executionEntryPrice;
  const entryFee = calcAshareBuyFee(entryValue, commissionRate);
  const required = entryValue + entryFee;
  if (required > normalized.cash + 1e-6) {
    while (shares >= lot.min && shares * executionEntryPrice + calcAshareBuyFee(shares * executionEntryPrice, commissionRate) > normalized.cash) shares -= lot.step;
    if (shares < lot.min) {
      return { state: normalized, message: "资金不足，无法满足入场费用", changed: false };
    }
  }

  const finalEntryValue = shares * executionEntryPrice;
  const finalEntryFee = calcAshareBuyFee(finalEntryValue, commissionRate);
  const finalStopLossPrice = finalStop;
  const finalTakeProfitPrice = finalTake;
  const currentEquity = normalized.cash + currentOpenValue;
  const projectedEquity = currentEquity - finalEntryFee - (executionEntryPrice - latest) * shares;
  const projectedOpenExposurePercent = projectedEquity > 0
    ? (currentOpenValue + latest * shares) / projectedEquity * 100
    : 0;
  if (projectedOpenExposurePercent > projectedPortfolioRiskLimit) {
    return {
      state: normalized,
      changed: false,
      message: `组合仓位约束触发，当前持仓暴露 ${(projectedOpenExposurePercent).toFixed(1)}% > ${projectedPortfolioRiskLimit}%`
      };
    }
  if (sectorName) {
    const projectedSectorExposurePercent = projectedEquity > 0
      ? (currentSectorExposureValue + latest * shares) / projectedEquity * 100
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
    ...paperQuoteEvidence(payload),
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
    lastHoldingBarDate: shanghaiDateTag(new Date(nowIso)),
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
    state: recordPaperEquity({
      ...normalized,
      cash: normalized.cash - (finalEntryValue + finalEntryFee),
      lastOpenAt: nowIso,
      openPositions: [...normalized.openPositions, nextPosition],
      totalTradeCount: normalized.totalTradeCount + 1
    }),
    changed: true,
      message: `已模拟开仓：${code}（${shares} 股，成交价 ${executionEntryPrice.toFixed(2)}，金额 ${finalEntryValue.toFixed(2)}）${sectorAdjusted ? `｜已按 ${sectorName} 行业上限裁剪` : ""}`
      + (lossPressureMultiplier < 1 ? `｜风控降仓 ${Math.round(lossPressureMultiplier * 100)}%` : "")
      + (strategyGovernance.positionMultiplier < 1
        ? `｜策略${strategyGovernance.status}，仓位系数 ${Math.round(strategyGovernance.positionMultiplier * 100)}%`
        : "")
  };
};

export const closePaperSimulationByCode = (
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
  const blocks: string[] = [];
  for (const position of normalized.openPositions) {
    if (position.code !== code) {
      remain.push(position);
      continue;
    }
    const matchingPayload = payload?.security?.code === code ? payload : null;
    const observed = matchingPayload ? { ...position, ...paperQuoteEvidence(matchingPayload), latestPrice: Number(matchingPayload.quote?.latest) } : position;
    const corporateBlock = matchingPayload ? paperCorporateActionBlock(position, matchingPayload) : position.settlementBlockedReason || "";
    const block = corporateBlock || paperMatchBlock(observed, "sell", observed.latestPrice * (1 - (settings.slippageBps || 0) / 10000));
    if (block) { remain.push({ ...observed, ...(corporateBlock ? { settlementBlockedReason: corporateBlock } : {}) }); blocks.push(block); continue; }
    const closePrice = observed.latestPrice;
    const settle = settlePaperPosition(observed, closePrice, reason, now, settings);
    cash += settle.cashDelta;
    dailyRealizedPnl += settle.record.realizedPnl;
    closedPositions.unshift(settle.record);
    changed = true;
  }
  if (!changed) return { state: { ...normalized, openPositions: remain }, message: blocks.join("；") || "当前标的无持仓可平", changed: Boolean(blocks.length && remain.some(p => p.settlementBlockedReason)) };
  const riskLabel = paperCloseReasonLabel(reason);
  return {
    state: recordPaperEquity({
      ...normalized, cash, dailyRealizedPnl, openPositions: remain, closedPositions
    }),
    changed: true,
    message: `${riskLabel}: ${code} 已平 ${matchingPositions.length - remain.filter(p => p.code === code).length} 笔${blocks.length ? `；${blocks.join("；")}` : ""}`
  };
};

export const advancePaperSimulationByQuote = (
  state: PaperSimulationState,
  payload: AnalysisPayload | null,
  settings: Settings
) => {
  const hydrated = normalizePaperState(state);
  const sourceEquityPeak = Number.isFinite(Number(state?.equityPeak)) ? Number(state.equityPeak) : hydrated.equityPeak;
  const sourceMaxDrawdown = Number.isFinite(Number(state?.maxDrawdownPercent)) ? Number(state.maxDrawdownPercent) : hydrated.maxDrawdownPercent;
  const normalized = resetPaperStateForNewDay(hydrated);
  if (!payload || !normalized.openPositions.length) return { state: normalized, changed: false, message: "" };
  const code = String(payload.security?.code || "");
  const safe = normalizeSettings(settings);
  const rawLatest = payload.quote?.latest;
  const latest = (typeof rawLatest === "number" || (typeof rawLatest === "string" && rawLatest.trim() !== ""))
    ? Number(rawLatest) : NaN;
  if (!Number.isFinite(latest) || latest <= 0) return { state: normalized, changed: false, message: "" };
  const maxHoldingBars = Math.max(3, Math.round(safe.maxHoldingBars || 30));
  const trailingStopPercent = clampNumber(safe.trailingStopPercent ?? 0, 0, 25, 0);
  const now = new Date().toISOString();
  let changed = false;
  let cash = normalized.cash;
  let dailyRealizedPnl = normalized.dailyRealizedPnl;
  const closedPositions: PaperClosedPosition[] = [...normalized.closedPositions];
  const openPositions: PaperPosition[] = [];
  const blocks: string[] = [];

  for (const position of normalized.openPositions) {
    if (position.code !== code) {
      openPositions.push(position);
      continue;
    }
    const corporateBlock = paperCorporateActionBlock(position, payload);
    if (corporateBlock) {
      openPositions.push({ ...position, settlementBlockedReason: corporateBlock });
      changed ||= position.settlementBlockedReason !== corporateBlock;
      blocks.push(corporateBlock); continue;
    }
    const barProgress = advancePaperHoldingBars(position, payload.history);
    const holdingBars = barProgress.holdingBars;
    const observedHigh = paperDate(position.openedAt) < todayTag() ? Number(payload.quote?.high) : latest;
    const highWaterMark = Math.max(position.highWaterMark, latest, Number.isFinite(observedHigh) ? observedHigh : latest);
    const trailingStopPrice = trailingStopPercent > 0
      ? highWaterMark * (1 - trailingStopPercent / 100)
      : 0;
    const withPrice: PaperPosition = {
      ...position,
      ...paperQuoteEvidence(payload),
      latestPrice: latest,
      highWaterMark,
      ...barProgress
    };
    const stopHit = latest <= withPrice.stopPrice;
    const trailingStopHit = trailingStopPercent > 0 && latest <= trailingStopPrice;
    const takeHit = latest >= withPrice.takePrice;
    const timeout = holdingBars >= maxHoldingBars;
    const block = paperMatchBlock(withPrice, "sell", latest * (1 - safe.slippageBps / 10000));
    if (block) blocks.push(block);
    if (!block && (stopHit || trailingStopHit || takeHit || timeout)) {
      const reason: PaperClosedPosition["closeReason"] = stopHit || trailingStopHit ? "SL" : takeHit ? "TP" : "TIME_EXIT";
      const settle = settlePaperPosition(withPrice, latest, reason, now, safe);
      cash += settle.cashDelta;
      dailyRealizedPnl += settle.record.realizedPnl;
      closedPositions.unshift(settle.record);
      changed = true;
    } else {
      openPositions.push(withPrice);
      changed ||= latest !== position.latestPrice || highWaterMark !== position.highWaterMark
        || holdingBars !== position.holdingBars || barProgress.lastHoldingBarDate !== position.lastHoldingBarDate
        || Object.entries(paperQuoteEvidence(payload)).some(([key, value]) => position[key as keyof PaperPosition] !== value);
    }
  }

  const beforeEquityRecord = { ...normalized, cash, dailyRealizedPnl, openPositions, closedPositions };
  const nextState = recordPaperEquity(beforeEquityRecord);
  changed ||= normalized.equityPeak !== sourceEquityPeak || normalized.maxDrawdownPercent !== sourceMaxDrawdown;

  const killSwitch = evaluatePaperKillSwitch(nextState, settings);
  if (killSwitch.hardTriggered && nextState.openPositions.length) {
    const killAction = closePaperAllSimulationByCode(nextState, "KILL_SWITCH", safe);
    if (killAction.changed) {
      return {
        ...killAction,
        message: `风控熔断：${killSwitch.reasons.join("；")}；${killAction.message}`
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

  return {
    state: nextState,
    changed,
    message: blocks.length ? [...new Set(blocks)].join("；") : closedPositions.length > normalized.closedPositions.length ? "按行情触发了持仓闭环处理" : ""
  };
};

