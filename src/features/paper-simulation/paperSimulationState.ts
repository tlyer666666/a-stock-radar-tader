import { clampNumber, normalizeRiskProfile, normalizeSettings } from "../../domain/settings";
import { shanghaiDateTag } from "../../dateUtils";
import type { PaperClosedPosition, PaperPosition } from "../../domain/paperSimulationTypes";
import type { PaperSimulationState } from "./paperSimulationTypes";

import { calcAshareSellFee } from "./paperTradingRules";

import { compactClosedHistory } from "./paperClosedHistory";

const todayTag = shanghaiDateTag;

export const emptyPaperState = (): PaperSimulationState => ({
  initialCapital: 200000,
  cash: 200000,
  openPositions: [],
  closedPositions: [],
  lastOpenAt: "",
  dailyRealizedPnl: 0,
  lastTradeDate: todayTag(),
  totalTradeCount: 0
});

export const buildPaperStrategySignature = (settings: Settings) => {
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

export const normalizePaperState = (input: unknown): PaperSimulationState => {
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
          // 科创板、北交所可按 1 股递增，读回时只取整数，不能再按 100 股取整（否则会凭空多出或少掉股数）。
          const shares = Math.max(0, Math.floor(clampNumber(item?.shares, 0, 1e7, 0)));
          return {
            id: typeof item?.id === "string" && item.id ? item.id : `sim-${Date.now()}-${Math.random().toFixed(6)}`,
            code: String(item?.code || ""),
            name: String(item?.name || item?.code || "UNKNOWN"),
            shares,
            quoteDate: typeof item?.quoteDate === "string" ? item.quoteDate : "",
            ...(item?.quoteVolume !== undefined && item?.quoteVolume !== null ? { quoteVolume: clampNumber(item.quoteVolume, 0, 1e14, 0) } : {}),
            ...(item?.quotePreClose !== undefined && item?.quotePreClose !== null ? { quotePreClose: clampNumber(item.quotePreClose, 0, 1e9, 0) } : {}),
            quoteName: String(item?.quoteName || item?.name || ""),
            lastObservedClose: clampNumber(item?.lastObservedClose, 0, 1e9, 0),
            lastObservedCloseDate: String(item?.lastObservedCloseDate || ""),
            settlementBlockedReason: String(item?.settlementBlockedReason || ""),
            entryPrice: clampNumber(item?.entryPrice, 0.01, 1e9, 0),
            latestPrice: clampNumber(item?.latestPrice, 0.01, 1e9, item?.entryPrice || 0.01),
            stopPrice: clampNumber(item?.stopPrice, 0.01, 1e9, 0.01),
            takePrice: clampNumber(item?.takePrice, 0.01, 1e9, 0.01),
            holdingBars: clampNumber(item?.holdingBars, 0, 500, 0),
            ...(typeof item?.lastHoldingBarDate === "string" ? { lastHoldingBarDate: item.lastHoldingBarDate } : {}),
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
            shares: Math.max(0, Math.floor(clampNumber(item?.shares, 0, 1e7, 0))),
            quoteDate: typeof item?.quoteDate === "string" ? item.quoteDate : "",
            ...(item?.quoteVolume !== undefined && item?.quoteVolume !== null ? { quoteVolume: clampNumber(item.quoteVolume, 0, 1e14, 0) } : {}),
            ...(item?.quotePreClose !== undefined && item?.quotePreClose !== null ? { quotePreClose: clampNumber(item.quotePreClose, 0, 1e9, 0) } : {}),
            quoteName: String(item?.quoteName || item?.name || ""),
            lastObservedClose: clampNumber(item?.lastObservedClose, 0, 1e9, 0),
            lastObservedCloseDate: String(item?.lastObservedCloseDate || ""),
            settlementBlockedReason: String(item?.settlementBlockedReason || ""),
            entryPrice: clampNumber(item?.entryPrice, 0.01, 1e9, 0),
            latestPrice: clampNumber(item?.latestPrice, 0.01, 1e9, item?.entryPrice || 0.01),
            stopPrice: clampNumber(item?.stopPrice, 0.01, 1e9, 0.01),
            takePrice: clampNumber(item?.takePrice, 0.01, 1e9, 0.01),
            holdingBars: clampNumber(item?.holdingBars, 0, 500, 0),
            ...(typeof item?.lastHoldingBarDate === "string" ? { lastHoldingBarDate: item.lastHoldingBarDate } : {}),
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
    equityPeak: clampNumber(raw.equityPeak, initialCapital, 1e12, initialCapital),
    maxDrawdownPercent: clampNumber(raw.maxDrawdownPercent, 0, 100, 0),
    cash: rawCash,
    openPositions,
    ...compactClosedHistory(closedPositions, raw.closedArchive, initialCapital, today),
    lastOpenAt,
    dailyRealizedPnl: clampNumber(raw.dailyRealizedPnl, -1e9, 1e9, 0),
    lastTradeDate,
    totalTradeCount: Math.max(0, Math.round(clampNumber(raw.totalTradeCount, 0, 1e7, 0)))
  };
};

export const resetPaperStateForNewDay = (state: PaperSimulationState) => {
  const today = todayTag();
  if (state.lastTradeDate === today) return state;
  return {
    ...state,
    dailyRealizedPnl: 0,
    lastTradeDate: today
  };
};

export const settlePaperPosition = (
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
  const closeFee = calcAshareSellFee(closeValue, position.feeRatePercent);
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

