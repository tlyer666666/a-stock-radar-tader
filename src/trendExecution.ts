import type { TrendCandidate, TrendExecutionCheck } from "./trendScreenerTypes";

export const TREND_EXECUTION_TTL_MS = 60_000;
export const trendBoardQuantity = (board: TrendCandidate["board"]) => ({
  minimumBuyQuantity: board === "star" ? 200 : 100,
  quantityStep: board === "star" || board === "beijing" ? 1 : 100
});
export type TrendExecutionRequest = { security: TrendCandidate["security"]; signalDate: string };

const unknownCheck = (signalDate: string, reason: string): TrendExecutionCheck => ({
  checkedAt: new Date().toISOString(), signalDate, executionDate: null, expectedSignalDate: null,
  state: "unknown", reasons: [reason], latest: null, upperLimit: null, lowerLimit: null,
  suspended: null, priceDate: null, source: "未取得执行行情", minimumBuyQuantity: 0, quantityStep: 0
});

/** Optional bridge permits older preview fixtures without silently granting readiness. */
export async function requestTrendExecution(api: unknown, request: TrendExecutionRequest): Promise<TrendExecutionCheck> {
  const bridge = api as { checkTrendExecution?: (request: TrendExecutionRequest) => Promise<TrendExecutionCheck> } | null;
  if (typeof bridge?.checkTrendExecution !== "function") return unknownCheck(request.signalDate, "当前运行环境不支持执行检查，请更新后重试");
  try {
    const result = await bridge.checkTrendExecution(request);
    return result && Array.isArray(result.reasons) ? result : unknownCheck(request.signalDate, "执行检查返回数据不完整");
  } catch (reason) {
    return unknownCheck(request.signalDate, `执行检查失败：${reason instanceof Error ? reason.message : String(reason)}`);
  }
}

/** Calendar and session eligibility are established by the backend; the client only
 * narrows it with a short lifetime, identity, quote evidence and the session cutoff. */
export function currentTrendExecution(check: TrendExecutionCheck | null, signalDate: string, now = Date.now()): { state: TrendExecutionCheck["state"]; reasons: string[] } {
  if (!Number.isFinite(now) || (check && (!Array.isArray(check.reasons) || !check.reasons.every(reason => typeof reason === "string") || !["ready", "blocked", "unknown", "expired"].includes(check.state)))) return { state: "unknown", reasons: ["执行状态或本机时间无效，请重新检查"] };
  if (!check) return { state: "unknown", reasons: ["尚未检查当前交易日、最新行情和交易状态"] };
  if (check.state !== "ready") return { state: check.state, reasons: check.reasons };
  const checked = Date.parse(check.checkedAt);
  const quoteAt = check.quoteAt === undefined ? NaN : Date.parse(check.quoteAt);
  if (!Number.isFinite(quoteAt)) return { state: "unknown", reasons: ["缺少源端报价时间，不能用检查时间替代"] };
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const cutoff = Date.parse(`${today}T09:35:00+08:00`);
  const opening = Date.parse(`${today}T09:25:00+08:00`);
  const validUntil = check.validUntil === undefined ? Infinity : Date.parse(check.validUntil);
  if (!Number.isFinite(checked) || !Number.isFinite(quoteAt) || checked > now || quoteAt > now || now - checked >= TREND_EXECUTION_TTL_MS || now - quoteAt >= TREND_EXECUTION_TTL_MS ||
      now >= cutoff || now >= validUntil || check.executionDate !== today || check.signalDate !== signalDate ||
      check.expectedSignalDate !== signalDate || check.priceDate !== today) {
    return { state: "expired", reasons: ["执行检查已过期或日期不匹配，请重新检查；历史勾选不能恢复入场资格"] };
  }
  if (now < opening || Number.isNaN(validUntil) || ![check.latest, check.upperLimit, check.lowerLimit].every(value => typeof value === "number" && Number.isFinite(value) && value > 0) ||
      check.suspended !== false || (typeof check.source !== "string" || !check.source.trim()) || ![check.minimumBuyQuantity, check.quantityStep].every(value => Number.isSafeInteger(value) && value > 0)) {
    return { state: "unknown", reasons: ["当前报价、限价、停牌或数量规则尚不完整，暂不能形成执行计划"] };
  }
  if (check.latest! >= check.upperLimit! || check.latest! <= check.lowerLimit!) return { state: "blocked", reasons: ["最新价格已触及限价，不能确认可成交性"] };
  return { state: "ready", reasons: check.reasons };
}
