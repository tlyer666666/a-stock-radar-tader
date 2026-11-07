import { clampNumber } from "./settings";

/**
 * Execution-readiness payloads analysed by the paper-trading page and the backtest page.
 *
 * Both surfaces receive the same upstream shape from the analysis service and derive the
 * same four fields (level, status, score, reasons). That shared derivation lives here so
 * the two pages cannot drift apart: before this module the logic existed as two
 * copy-pasted bodies, which is the kind of duplication where a rule fixed on one page
 * silently stops matching the other.
 */
export type ExecutionReadinessLevel = "pass" | "wait" | "block";
export type ExecutionReadinessStatus = "PASS" | "WAIT" | "BLOCK";

export type PaperExecutionReadiness = {
  score: number;
  level: ExecutionReadinessLevel;
  status: ExecutionReadinessStatus;
  summary: string;
  recommendation: string;
  reasons: string[];
  canExecute: boolean;
};

export type BacktestExecutionReadiness = {
  score: number;
  level: ExecutionReadinessLevel;
  status: ExecutionReadinessStatus;
  recommendation: string;
  reasons: string[];
  canRunLive: boolean;
};

/** A missing or unparseable payload is "no data", never a zero-scored verdict. */
type ReadinessCore = {
  level: ExecutionReadinessLevel;
  status: ExecutionReadinessStatus;
  score: number;
  reasons: string[];
};

const LEVELS: readonly ExecutionReadinessLevel[] = ["pass", "wait", "block"];
const NO_REASON = "执行评估已完成";

function statusFor(level: ExecutionReadinessLevel, rawStatus: unknown): ExecutionReadinessStatus {
  if (rawStatus === "PASS" || rawStatus === "WAIT" || rawStatus === "BLOCK") return rawStatus;
  return level === "pass" ? "PASS" : level === "wait" ? "WAIT" : "BLOCK";
}

/** Fields derived identically for both surfaces; `null` means "treat as absent". */
function readReadinessCore(input: unknown): ReadinessCore | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;

  const rawLevel = source.level;
  const level = LEVELS.find((candidate) => candidate === rawLevel);
  if (!level) return null;

  const status = statusFor(level, source.status);

  const scoreValue = Number(source.score);
  if (!Number.isFinite(scoreValue)) return null;
  const score = clampNumber(Math.round(scoreValue), 0, 100, 0);

  const reasons = Array.isArray(source.reasons)
    ? source.reasons.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];

  return { level, status, score, reasons: reasons.length ? reasons : [NO_REASON] };
}

export const normalizePaperExecutionReadiness = (input: unknown): PaperExecutionReadiness | null => {
  const core = readReadinessCore(input);
  if (!core) return null;
  const source = input as Record<string, unknown>;
  const { level, status, score, reasons } = core;

  const summary = typeof source.summary === "string" && source.summary.trim()
    ? source.summary
    : "执行评估已返回但摘要缺失";
  const recommendation = typeof source.recommendation === "string" && source.recommendation.trim()
    ? source.recommendation
    : status === "PASS" ? "可执行"
      : status === "WAIT" ? "建议先确认后执行"
        : "当前不适合执行";
  const canExecute = typeof source.canExecute === "boolean" ? source.canExecute : level !== "block";

  return {
    score,
    level,
    status,
    summary,
    recommendation,
    reasons,
    canExecute: canExecute && level !== "block"
  };
};

export const normalizeBacktestExecutionReadiness = (input: unknown): BacktestExecutionReadiness | null => {
  const core = readReadinessCore(input);
  if (!core) return null;
  const source = input as Record<string, unknown>;
  const { level, status, score, reasons } = core;

  const recommendation = typeof source.recommendation === "string" && source.recommendation.trim()
    ? source.recommendation
    : status === "PASS"
      ? "可用于执行"
      : status === "WAIT"
        ? "建议先确认再执行"
        : "不建议执行";
  const canRunLive = level === "pass"
    ? (Boolean(source.canRunLive) || source.canRunLive === undefined)
    : false;

  return { score, level, status, recommendation, reasons, canRunLive };
};
