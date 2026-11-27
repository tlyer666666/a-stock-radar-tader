/** AI 建议池（主进程 electron/decision-signals.cjs）的类型与展示用纯函数。 */

export type SignalAction = "buy" | "add" | "hold" | "reduce" | "sell" | "watch" | "avoid";
export type SignalHorizon = "1d" | "3d" | "5d" | "10d" | "swing";
export type SignalStatus = "active" | "expired" | "invalidated" | "closed";
export type SignalOutcome =
  | { status: "done"; verdict: "hit" | "miss" | "neutral"; returnPct: number | null; maxAdversePct: number | null; stopHit: boolean; targetHit: boolean; endDate: string; endClose: number | null; startPrice: number }
  | { status: "unable"; reason: string };

export type DecisionSignal = {
  id: string; code: string; name: string; assetType: "stock" | "etf"; status: SignalStatus;
  createdAt: string; updatedAt: string; expiresAt: string;
  action: SignalAction; horizon: SignalHorizon;
  entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targetPrice: number | null;
  invalidation: string; watch: string[]; reason: string; guardrail: string; rawAction?: SignalAction;
  stance: string; confidence: string; referencePrice: number | null;
  source: { conversationId: string; messageId: string; model: string; skills: string[] };
  outcomes: Partial<Record<"1" | "3" | "5" | "10", SignalOutcome>>;
  feedback: "useful" | "not_useful" | null;
  endedReason?: string;
};

export type SignalSummary = {
  total: number; completed: number; hit: number; miss: number; neutral: number; unable: number;
  enough: boolean; minSample: number; hitRatePct: number | null; avgReturnPct: number | null; maxAdversePct: number | null;
};
export type SignalStats = {
  total: number; active: number;
  byDays: Record<"1" | "3" | "5" | "10", SignalSummary>;
  byAction: Partial<Record<SignalAction, { count: number; d5: SignalSummary }>>;
  feedback: { useful: number; notUseful: number };
  minSample: number; hitPct: number;
};
export type DecisionSignalList = { signals: DecisionSignal[]; stats: SignalStats | null; evaluation: { evaluated: number; failed: number } | null };

/** 问股回答里附带的建议摘要（已存进建议池）。 */
export type MessageDecision = {
  id: string; action: SignalAction; actionLabel: string; horizon: SignalHorizon; horizonLabel: string;
  entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targetPrice: number | null;
  invalidation: string; watch: string[]; guardrail: string; expiresAt: string; created: boolean;
};

export const ACTION_LABEL: Record<SignalAction, string> = { buy: "买入", add: "加仓", hold: "持有", reduce: "减仓", sell: "卖出", watch: "观望", avoid: "回避" };
export const HORIZON_LABEL: Record<SignalHorizon, string> = { "1d": "1 日", "3d": "3 日", "5d": "5 日", "10d": "10 日", swing: "波段" };
export const STATUS_LABEL: Record<SignalStatus, string> = { active: "生效中", expired: "已过期", invalidated: "已失效", closed: "已关闭" };

export function actionTone(action: SignalAction): "up" | "down" | "muted" {
  if (action === "buy" || action === "add" || action === "hold") return "up";
  if (action === "reduce" || action === "sell" || action === "avoid") return "down";
  return "muted";
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const price = (value: number | null) => !finite(value) ? "--" : String(Number(value.toFixed(value < 10 ? 3 : 2)));

/** 「入场 10.2–10.5 · 止损 9.8 · 目标 11.6」；全都没有时返回空字符串。 */
export function planText(signal: Pick<DecisionSignal, "entryLow" | "entryHigh" | "stopLoss" | "targetPrice">): string {
  const parts: string[] = [];
  const low = finite(signal.entryLow) ? signal.entryLow : null;
  const high = finite(signal.entryHigh) ? signal.entryHigh : null;
  if (low !== null || high !== null) {
    const a = low ?? high, b = high ?? low;
    parts.push(`入场 ${a === b ? price(a) : `${price(a)}–${price(b)}`}`);
  }
  if (finite(signal.stopLoss)) parts.push(`止损 ${price(signal.stopLoss)}`);
  if (finite(signal.targetPrice)) parts.push(`目标 ${price(signal.targetPrice)}`);
  return parts.join(" · ");
}

export function outcomeText(outcome: SignalOutcome | undefined): { text: string; tone: "good" | "bad" | "muted" } {
  if (!outcome) return { text: "待评", tone: "muted" };
  if (outcome.status === "unable") return { text: "不评", tone: "muted" };
  const pct = !finite(outcome.returnPct) ? "" : ` ${outcome.returnPct > 0 ? "+" : ""}${outcome.returnPct.toFixed(1)}%`;
  if (outcome.verdict === "hit") return { text: `对${pct}`, tone: "good" };
  if (outcome.verdict === "miss") return { text: `${outcome.stopHit ? "破止损" : "错"}${pct}`, tone: "bad" };
  return { text: `平${pct}`, tone: "muted" };
}

/** 统计一句话：样本不足时只说样本数；样本充足但全持平时明确标出「全持平」。 */
export function summaryText(summary: SignalSummary | undefined): string {
  if (!summary || !finite(summary.completed) || summary.completed <= 0) return "还没有评完的建议";
  if (!summary.enough) return `已评 ${summary.completed} 条，不足 ${summary.minSample} 条，暂不给命中率`;
  const avgText = finite(summary.avgReturnPct) ? `${summary.avgReturnPct > 0 ? "+" : ""}${summary.avgReturnPct}%` : "--";
  if (summary.hit + summary.miss === 0) {
    return `已评 ${summary.completed} 条 · 全持平（平 ${summary.neutral}）· 平均涨跌 ${avgText}`;
  }
  const hitText = finite(summary.hitRatePct) ? `${summary.hitRatePct}%` : "--%";
  return `已评 ${summary.completed} 条 · 命中率 ${hitText}（对 ${summary.hit} / 错 ${summary.miss} / 平 ${summary.neutral}）· 平均涨跌 ${avgText}`;
}

export function shortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
}
