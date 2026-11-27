/** 指标预警（主进程 electron/alert-rules.cjs）的类型与表单默认值。 */

export type AlertRuleType = "ma_cross" | "rsi" | "macd" | "kdj" | "cci" | "market_light";
export type AlertRuleScope = "symbol" | "watchlist" | "holdings" | "market";
export type AlertRuleParams = { direction?: string; window?: number; period?: number; threshold?: number; statuses?: string[] };
export type AlertRule = {
  id: string; type: AlertRuleType; scope: AlertRuleScope; code: string; name: string; params: AlertRuleParams;
  enabled: boolean; cooldownHours: number; createdAt: string; text?: string;
};
export type AlertHistoryItem = { id: string; at: string; ruleId: string; ruleText: string; target: string; code: string; status: "triggered" | "degraded" | "cooldown"; detail: string; date: string };
export type AlertDryResult = { ruleId: string; target: string; code: string; status: "triggered" | "not_triggered" | "degraded"; detail: string };
export type AlertRulesState = {
  rules: AlertRule[]; history: AlertHistoryItem[]; lastRunAt: string; types: Record<string, string>;
  run?: { at: string; triggered: number; evaluated: number }; dry?: AlertDryResult[];
};
export type AlertRulesRequest =
  | { op?: "list" | "run" | "clear" }
  | { op: "save"; rule: Partial<AlertRule> & { type: AlertRuleType } }
  | { op: "remove" | "dry"; id: string };

export const ALERT_TYPE_OPTIONS: Array<{ id: AlertRuleType; label: string; directions: Array<{ id: string; label: string }>; hint: string }> = [
  { id: "ma_cross", label: "收盘价穿均线", directions: [{ id: "above", label: "上穿（站上）" }, { id: "below", label: "跌破" }], hint: "收盘价从均线一侧到另一侧的那一天提醒" },
  { id: "macd", label: "MACD 金叉 / 死叉", directions: [{ id: "bullish", label: "金叉" }, { id: "bearish", label: "死叉" }], hint: "DIF 穿过 DEA 的那一天提醒（12, 26, 9）" },
  { id: "kdj", label: "KDJ 金叉 / 死叉", directions: [{ id: "bullish", label: "金叉" }, { id: "bearish", label: "死叉" }], hint: "K 穿过 D 的那一天提醒（9, 3, 3）" },
  { id: "rsi", label: "RSI 穿阈值", directions: [{ id: "above", label: "上穿" }, { id: "below", label: "下穿" }], hint: "例如 RSI 下穿 30（超卖）或上穿 70（过热）" },
  { id: "cci", label: "CCI 穿阈值", directions: [{ id: "above", label: "上穿" }, { id: "below", label: "下穿" }], hint: "例如 CCI 上穿 100 或下穿 -100" },
  { id: "market_light", label: "大盘红绿灯", directions: [], hint: "指数涨跌和涨跌家数合成的大盘状态转红灯或黄灯时提醒（盘中每 10 分钟看一次）" }
];

export const SCOPE_LABEL: Record<AlertRuleScope, string> = { symbol: "单只股票", watchlist: "全部自选", holdings: "全部持仓", market: "大盘" };
export const HISTORY_STATUS_LABEL: Record<AlertHistoryItem["status"] | "not_triggered", string> = { triggered: "已触发", degraded: "数据不足", cooldown: "冷却中", not_triggered: "未触发" };

export function defaultParams(type: AlertRuleType): AlertRuleParams {
  if (type === "ma_cross") return { direction: "above", window: 20 };
  if (type === "rsi") return { direction: "below", period: 12, threshold: 30 };
  if (type === "cci") return { direction: "above", period: 14, threshold: 100 };
  if (type === "market_light") return { statuses: ["red", "yellow"] };
  return { direction: "bullish" };
}

export function alertTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
}

export type AlertRuleDraftInput = {
  type: AlertRuleType;
  direction?: string;
  statuses?: string[];
  windowDraft: string;
  periodDraft: string;
  thresholdDraft: string;
  cooldownDraft: string;
};

export type AlertRuleDraftResult =
  | { ok: true; params: AlertRuleParams; cooldownHours: number }
  | { ok: false; error: string };

const parseStrictNumber = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
};

/** 校验并解析指标预警表单草稿（支持负阈值如 CCI -100 与 0 小时冷却）。 */
export function validateAlertRuleDraft(input: AlertRuleDraftInput): AlertRuleDraftResult {
  const cooldown = parseStrictNumber(input.cooldownDraft);
  if (cooldown === null || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > 240) {
    return { ok: false, error: "冷却时间需为 0–240 的整数" };
  }
  if (input.type === "ma_cross") {
    const win = parseStrictNumber(input.windowDraft);
    if (win === null || !Number.isInteger(win) || win < 2 || win > 250) {
      return { ok: false, error: "均线周期需为 2–250 的整数" };
    }
    return { ok: true, params: { direction: input.direction || "above", window: win }, cooldownHours: cooldown };
  }
  if (input.type === "rsi") {
    const period = parseStrictNumber(input.periodDraft);
    if (period === null || !Number.isInteger(period) || period < 2 || period > 60) {
      return { ok: false, error: "RSI 周期需为 2–60 的整数" };
    }
    const threshold = parseStrictNumber(input.thresholdDraft);
    if (threshold === null || threshold <= 0 || threshold >= 100) {
      return { ok: false, error: "RSI 阈值需大于 0 且小于 100" };
    }
    return { ok: true, params: { direction: input.direction || "below", period, threshold }, cooldownHours: cooldown };
  }
  if (input.type === "cci") {
    const period = parseStrictNumber(input.periodDraft);
    if (period === null || !Number.isInteger(period) || period < 2 || period > 60) {
      return { ok: false, error: "CCI 周期需为 2–60 的整数" };
    }
    const threshold = parseStrictNumber(input.thresholdDraft);
    if (threshold === null || threshold < -500 || threshold > 500) {
      return { ok: false, error: "CCI 阈值需在 -500 至 500 之间" };
    }
    return { ok: true, params: { direction: input.direction || "above", period, threshold }, cooldownHours: cooldown };
  }
  if (input.type === "market_light") {
    return { ok: true, params: { statuses: input.statuses?.length ? input.statuses : ["red", "yellow"] }, cooldownHours: cooldown };
  }
  return { ok: true, params: { direction: input.direction || "bullish" }, cooldownHours: cooldown };
}
