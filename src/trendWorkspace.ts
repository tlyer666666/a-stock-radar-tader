import type { TrendCandidate, TrendScanStatus } from "./trendScreenerTypes";
import { validStrategySnapshot, libraryDefinition, strategyName, sameTrendStrategy } from "./trendStrategyConfig";

export const TREND_PLAN_STORAGE_KEY = "a-stock-radar:trend-plans:v1";
export type TrendReviewDraft = { fields: Record<string, string>; checks: Record<string, boolean> };

export type SavedTrendPlan = {
  id: string;
  savedAt: string;
  isPreview: boolean;
  coverageComplete: boolean;
  marketGate: TrendScanStatus["marketGate"];
  candidate: TrendCandidate;
  reviewDraft?: TrendReviewDraft;
};

type PlanStorage = Pick<Storage, "getItem" | "setItem">;
type PlanReadResult = { plans: SavedTrendPlan[]; error: string };
type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

export function trendPlanId(candidate: TrendCandidate, isPreview: boolean): string {
  const identity = [isPreview ? "demo" : "market", candidate.security.secid, candidate.asOf, candidate.limitDate];
  if (candidate.strategy && candidate.strategy.id !== "classic-v1") identity.push(candidate.strategy.id, candidate.strategy.version, candidate.strategy.configHash);
  return JSON.stringify(identity);
}

export function createSavedTrendPlan(candidate: TrendCandidate, status: Pick<TrendScanStatus, "isPreview" | "marketGate" | "coverageComplete">, savedAt = new Date().toISOString()): SavedTrendPlan {
  return {
    id: trendPlanId(candidate, Boolean(status.isPreview)), savedAt,
    isPreview: Boolean(status.isPreview), coverageComplete: status.coverageComplete,
    marketGate: status.marketGate,
    // The saved plan is a dated snapshot, independent of subsequent scan updates.
    candidate: JSON.parse(JSON.stringify(candidate)) as TrendCandidate
  };
}

export function reviewSavedTrendPlan(plan: SavedTrendPlan, status: TrendScanStatus | null): {
  verificationAvailable: boolean;
  marketGate: TrendScanStatus["marketGate"];
  latestCandidate?: TrendCandidate;
  latestAsOf?: string;
} {
  const unavailable = { verificationAvailable: false, marketGate: "unknown" as const };
  if (!status || Boolean(status.isPreview) !== plan.isPreview || !status.asOf || status.asOf < plan.candidate.asOf) return unavailable;
  const snapshots = status.strategies || (status.strategy ? [status.strategy] : []);
  const comparable = snapshots.length ? snapshots.some(snapshot => sameTrendStrategy(snapshot, plan.candidate.strategy)) :
    !status.strategies && sameTrendStrategy(status.strategy, plan.candidate.strategy);
  if (!comparable) return unavailable;
  const observed = status.candidates.find(candidate => candidate.security.secid === plan.candidate.security.secid && sameTrendStrategy(candidate.strategy, plan.candidate.strategy));
  // A stale stock row cannot establish either a current signal or an absence.
  if (observed && observed.asOf !== status.asOf) return unavailable;
  const legacySingle = snapshots.length <= 1 && (!status.strategies || Boolean(status.strategy));
  const complete = status.phase === "completed" && (status.strategyStats ?
    status.strategyStats.some(stat => sameTrendStrategy(stat.strategy, plan.candidate.strategy) && stat.coverageComplete) :
    legacySingle && status.coverageComplete);
  if (!observed && !complete) return unavailable;
  return { verificationAvailable: true, marketGate: status.marketGate, latestAsOf: status.asOf,
    ...(observed ? { latestCandidate: observed } : {}) };
}

function validCandidate(value: unknown): value is TrendCandidate {
  if (!record(value) || !record(value.security) || !record(value.metrics)) return false;
  const security = value.security;
  const metrics = value.metrics;
  if (![security.code, security.name, security.secid, value.asOf, value.limitDate].every((item) => typeof item === "string" && item.length > 0)) return false;
  if (security.industry !== undefined && typeof security.industry !== "string") return false;
  if (!["main", "growth", "star", "beijing"].includes(String(value.board)) || !["signal", "watch"].includes(String(value.stage))) return false;
  if (!["official", "calculated"].includes(String(value.limitEvidence)) || !finite(value.daysSinceLimit)) return false;
  if (!strings(value.patterns) || !value.patterns.every((pattern) => pattern === "A" || pattern === "B") || !strings(value.warnings)) return false;
  if (![metrics.close, metrics.ma20, metrics.ma60, metrics.avgAmount20, metrics.deviationPercent, metrics.atr14].every(finite)) return false;
  if (metrics.relativeStrength20 !== null && !finite(metrics.relativeStrength20)) return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every((item) => record(item) && typeof item.label === "string" && typeof item.passed === "boolean" && typeof item.value === "string" && typeof item.rule === "string")) return false;
  if (value.plan !== null && (!record(value.plan) || ![value.plan.stop, value.plan.maxEntry, value.plan.maxRiskPercent].every(finite) || typeof value.plan.holdingDays !== "string")) return false;
  if (value.strategy !== undefined && !validStrategySnapshot(value.strategy)) return false;
  if (record(value.strategy) && value.strategy.id === "quality-v2") {
    if (!record(value.quality) || !["A", "B", null].includes(value.primaryPattern as "A" | "B" | null)) return false;
    const q = value.quality;
    if (![q.atr14Previous, q.extensionAtr, q.closeLocation, q.volumeRatio, q.volumeMedian20, q.holdingMa20Count, q.stopDistanceAtr].every(finite)) return false;
    if (Number(q.atr14Previous) < 0 || Number(q.volumeMedian20) < 0 || Number(q.volumeRatio) < 0 || Number(q.closeLocation) < 0 || Number(q.closeLocation) > 1 || !Number.isInteger(q.holdingMa20Count) || Number(q.holdingMa20Count) < 0 || Number(q.holdingMa20Count) > 3) return false;
    if (typeof q.ma60Rising !== "boolean" || typeof q.relativeStrengthPositive !== "boolean") return false;
    if (value.stage === "signal" && !record(value.plan)) return false;
    if (value.stage === "watch" && value.plan !== null) return false;
    if (record(value.plan) && (!finite(value.plan.minEntry) || Number(value.plan.stop) <= 0 || value.plan.minEntry <= Number(value.plan.stop) || value.plan.minEntry > Number(value.plan.maxEntry) || Number(value.plan.maxRiskPercent) > 8 || Number(value.plan.maxRiskPercent) < 0)) return false;
  }
  if (record(value.strategy) && libraryDefinition(String(value.strategy.id))) {
    if (!record(value.setup) || value.setup.id !== value.strategy.id || typeof value.setup.label !== "string" || !finite(value.setup.triggerPrice) || Number(value.setup.triggerPrice) <= 0 || typeof value.setup.stopBasis !== "string") return false;
    if (!record(value.technical) || !record(value.technical.indicators) || !Object.values(value.technical.indicators).every(finite) || !Object.keys(value.technical.indicators).length) return false;
    if ((value.patterns as string[]).length !== 0 || (value.primaryPattern !== undefined && value.primaryPattern !== null)) return false;
    if (value.stage === "signal" && !record(value.plan)) return false;
    if (value.stage === "watch" && value.plan !== null) return false;
    if (record(value.plan) && (!finite(value.plan.minEntry) || Number(value.plan.stop) <= 0 || Number(value.plan.minEntry) <= Number(value.plan.stop) || Number(value.plan.minEntry) > Number(value.plan.maxEntry) || Number(value.plan.maxRiskPercent) > 8 || Number(value.plan.maxRiskPercent) < 0)) return false;
  }
  return true;
}

function validPlan(value: unknown): value is SavedTrendPlan {
  return record(value) && validCandidate(value.candidate) &&
    typeof value.isPreview === "boolean" && typeof value.coverageComplete === "boolean" &&
    ["open", "blocked", "unknown"].includes(String(value.marketGate)) &&
    typeof value.savedAt === "string" && !Number.isNaN(Date.parse(value.savedAt)) &&
    value.id === trendPlanId(value.candidate, value.isPreview) &&
    (value.reviewDraft === undefined || (record(value.reviewDraft) && record(value.reviewDraft.fields) && record(value.reviewDraft.checks) &&
      Object.values(value.reviewDraft.fields).every((item) => typeof item === "string") &&
      Object.values(value.reviewDraft.checks).every((item) => typeof item === "boolean")));
}

export function readTrendPlans(storage: PlanStorage): PlanReadResult {
  try {
    const raw = storage.getItem(TREND_PLAN_STORAGE_KEY);
    if (raw === null) return { plans: [], error: "" };
    const data: unknown = JSON.parse(raw);
    if (!record(data) || data.version !== 1 || !Array.isArray(data.plans)) throw new Error("invalid format");
    // Reject the whole write path on corruption so a later save cannot silently erase records.
    if (!data.plans.every(validPlan)) throw new Error("invalid saved plan");
    const ids = new Set<string>();
    const plans = data.plans.filter((plan) => !ids.has(plan.id) && Boolean(ids.add(plan.id)));
    return { plans, error: "" };
  } catch {
    return { plans: [], error: "本地计划读取失败，原始记录已保留。请检查浏览器存储权限或恢复本地记录后重试。" };
  }
}

export function writeTrendPlans(storage: PlanStorage, plans: SavedTrendPlan[]): boolean {
  try {
    if (!plans.every(validPlan)) return false;
    storage.setItem(TREND_PLAN_STORAGE_KEY, JSON.stringify({ version: 1, plans }));
    return true;
  } catch {
    return false;
  }
}

export function csvCell(value: unknown): string {
  const original = value == null ? "" : String(value);
  // Quoting alone does not prevent spreadsheet programs from evaluating formulas.
  const safe = /^[\s\uFEFF]*[=+\-@]/.test(original) || /^[\t\r\n]/.test(original) ? `'${original}` : original;
  return `"${safe.replace(/"/g, '""')}"`;
}

type CandidateExport = Pick<SavedTrendPlan, "candidate" | "isPreview" | "coverageComplete" | "marketGate"> & { savedAt?: string };

export function trendCandidatesCsv(rows: CandidateExport[]): string {
  const header = ["数据性质", "代码", "名称", "数据截止日", "快照保存时间", "板块", "行业", "阶段", "形态", "涨停日期", "涨停后交易日", "收盘", "MA20", "MA60", "距MA20(%)", "20日平均成交额(元)", "20日超额涨幅(百分点)", "参考止损S", "最高参考入场Pmax", "Pmax下计划风险(%)", "市场门槛", "覆盖状态", "规则依据", "待复核事项", "使用说明", "策略版本", "参数快照", "配置指纹", "最低参考入场", "止损引用形态", "策略名称", "独立信号", "触发参考价", "技术指标"];
  const gateNames = { open: "通过", blocked: "暂停新开仓", unknown: "未知" };
  const body = rows.map(({ candidate: candidate, isPreview, savedAt, coverageComplete, marketGate }) => [
    isPreview ? "DEMO 虚构演示" : "扫描结果 / 待人工复核",
    /^\d+$/.test(candidate.security.code) ? `'${candidate.security.code}` : candidate.security.code,
    candidate.security.name, candidate.asOf, savedAt || "", candidate.board, candidate.security.industry || "",
    candidate.stage === "signal" ? "收盘信号" : "趋势观察", candidate.patterns.join("+"), candidate.limitDate, candidate.daysSinceLimit,
    candidate.metrics.close, candidate.metrics.ma20, candidate.metrics.ma60, candidate.metrics.deviationPercent,
    candidate.metrics.avgAmount20, candidate.metrics.relativeStrength20,
    candidate.plan?.stop, candidate.plan?.maxEntry, candidate.plan?.maxRiskPercent,
    gateNames[marketGate], coverageComplete ? "完整" : "未完成 / 待核验",
    candidate.evidence.map((item) => `${item.passed ? "通过" : "未满足"} ${item.label}：${item.value}；规则：${item.rule}`).join(" | "),
    candidate.warnings.join("；"), "历史快照；次日人工复核；非持仓记录；不自动下单或退出",
    candidate.strategy ? `${candidate.strategy.id}@${candidate.strategy.version}` : "classic-v1@1.0.0",
    JSON.stringify(candidate.strategy?.config || {}), candidate.strategy?.configHash || "旧版快照", candidate.plan?.minEntry, candidate.primaryPattern || "", strategyName(candidate.strategy), candidate.setup?.label || "", candidate.setup?.triggerPrice ?? "", candidate.technical ? JSON.stringify(candidate.technical.indicators) : ""
  ]);
  return "\uFEFF" + [header, ...body].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
