import { clampNumber } from "../../domain/settings";
import { shanghaiDateTag } from "../../dateUtils";
import { loadSafeLocalJson } from "../../safeStorage";
import { isExecutionLogCollection, isPaperState } from "../../researchStorage";
import { emptyPaperState, normalizePaperState } from "./paperSimulationState";
import type {
  ExecutionDecisionLog, ExecutionDecisionResult, ExecutionDecisionSource, PaperSimulationState
} from "./paperSimulationTypes";

export const PAPER_SIM_STATE_KEY = "a-stock-radar-v054-paper-sim-v1";
export const EXECUTION_DECISION_LOG_KEY = "a-stock-radar-v054-execution-decision-log-v1";
export const EXECUTION_DECISION_LOG_LIMIT = 30;

const todayTag = shanghaiDateTag;

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

export const loadExecutionDecisionLog = (): ExecutionDecisionLog[] => {
  try {
    const parsed = loadSafeLocalJson<unknown>(EXECUTION_DECISION_LOG_KEY, [], isExecutionLogCollection);
    return Array.isArray(parsed)
      ? parsed.map(normalizeExecutionDecisionLogEntry).filter((item): item is ExecutionDecisionLog => Boolean(item))
      : [];
  } catch {
    return [];
  }
};

export const buildExecutionDecisionLogEntry = (input: {
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

export const loadPaperState = (): PaperSimulationState => {
  try {
    const parsed = loadSafeLocalJson<unknown>(PAPER_SIM_STATE_KEY, emptyPaperState(), isPaperState);
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

