import type { PaperClosedPosition, PaperPosition } from "../../domain/paperSimulationTypes";

export type PaperSimulationState = {
  equityPeak?: number;
  maxDrawdownPercent?: number;
  initialCapital: number;
  cash: number;
  openPositions: PaperPosition[];
  closedPositions: PaperClosedPosition[];
  closedArchive?: import("./paperClosedHistory").ClosedArchive;
  dailyRealizedPnl: number;
  lastOpenAt: string;
  lastTradeDate: string;
  totalTradeCount: number;
};

export type PaperTradeAction = {
  state: PaperSimulationState;
  message: string;
  changed: boolean;
};

export type PaperStrategyStage = "collecting" | "candidate" | "promoted" | "degraded" | "suspended";

export type PaperStrategyGovernance = {
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

export type ExecutionDecisionResult = "APPROVED" | "BLOCKED" | "REJECTED" | "CONFIRM_REQUIRED";
export type ExecutionDecisionSource = "BACKTEST_CURRENT" | "BACKTEST_HISTORY" | "PAPER_TRADE";

export type ExecutionDecisionLog = {
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
