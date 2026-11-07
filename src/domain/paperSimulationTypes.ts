export type PaperPosition = {
  id: string;
  code: string;
  name: string;
  shares: number;
  sectorName?: string;
  quoteDate?: string;
  quoteVolume?: number;
  quotePreClose?: number;
  quoteName?: string;
  lastObservedClose?: number;
  lastObservedCloseDate?: string;
  settlementBlockedReason?: string;
  entryPrice: number;
  latestPrice: number;
  stopPrice: number;
  takePrice: number;
  holdingBars: number;
  lastHoldingBarDate?: string;
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

export type PaperClosedPosition = PaperPosition & {
  closeTime: string;
  closePrice: number;
  closeReason: "TP" | "SL" | "TIME_EXIT" | "MANUAL" | "KILL_SWITCH";
  realizedPnl: number;
  realizedPnlPercent: number;
};

export const paperCloseReasonLabel = (reason: PaperClosedPosition["closeReason"]) => {
  if (reason === "TP") return "止盈触发";
  if (reason === "SL") return "止损触发";
  if (reason === "TIME_EXIT") return "超时退出";
  if (reason === "KILL_SWITCH") return "风控熔断";
  return "手动平仓";
};
