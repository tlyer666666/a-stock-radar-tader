export type StockMonitorField = "latest" | "changePct" | "turnover" | "amount";
export type StockMonitorCondition = {
  id: string;
  field: StockMonitorField;
  operator: "gte" | "lte";
  value: number;
};
export type StockMonitorConfig = {
  enabled: boolean;
  mode: "all" | "any";
  cooldownMinutes: number;
  conditions: StockMonitorCondition[];
};
export type StockMonitorSnapshot = {
  quote?: Record<string, unknown>;
  updatedAt?: string;
  actualProvider?: string;
  provider?: string;
};
export type StockMonitorRuntime = {
  configSignature: string;
  initialized: boolean;
  matched: boolean | null;
  lastAlertAt: number | null;
  lastSampleAt: number | null;
};
export type StockMonitorEvaluation = {
  runtime: StockMonitorRuntime;
  status: "disabled" | "waiting" | "stale" | "unavailable" | "baseline" | "watching" | "matched" | "triggered" | "cooldown";
  shouldAlert: boolean;
  detail: string;
};

export const stockMonitorFields: { value: StockMonitorField; label: string; unit: string; scale: number }[] = [
  { value: "latest", label: "最新价", unit: "元", scale: 1 },
  { value: "changePct", label: "涨跌幅", unit: "%", scale: 1 },
  { value: "turnover", label: "换手率", unit: "%", scale: 1 },
  { value: "amount", label: "成交额", unit: "万元", scale: 10000 }
];
export const MAX_MONITOR_CONDITIONS = 6;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function normalizeStockMonitorConfig(input: unknown): StockMonitorConfig | null {
  if (!isRecord(input) || typeof input.enabled !== "boolean" || (input.mode !== "all" && input.mode !== "any")) return null;
  if (!finiteNumber(input.cooldownMinutes) || input.cooldownMinutes < 1 || input.cooldownMinutes > 1440) return null;
  if (!Array.isArray(input.conditions) || !input.conditions.length || input.conditions.length > MAX_MONITOR_CONDITIONS) return null;
  const conditions: StockMonitorCondition[] = [];
  const ids = new Set<string>();
  for (const candidate of input.conditions) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id || ids.has(candidate.id)) return null;
    if (!stockMonitorFields.some(field => field.value === candidate.field) || (candidate.operator !== "gte" && candidate.operator !== "lte")) return null;
    if (!finiteNumber(candidate.value)) return null;
    if (["latest", "amount"].includes(String(candidate.field)) && candidate.value <= 0) return null;
    if (candidate.field === "turnover" && (candidate.value < 0 || candidate.value > 100)) return null;
    if (candidate.field === "changePct" && candidate.value < -100) return null;
    ids.add(candidate.id);
    conditions.push({ id: candidate.id, field: candidate.field as StockMonitorField, operator: candidate.operator as "gte" | "lte", value: candidate.value });
  }
  return { enabled: input.enabled, mode: input.mode as "all" | "any", cooldownMinutes: input.cooldownMinutes, conditions };
}

export function normalizeStockMonitorRules(input: unknown): Record<string, StockMonitorConfig> {
  if (!isRecord(input)) return {};
  const result: Record<string, StockMonitorConfig> = {};
  for (const [code, value] of Object.entries(input)) {
    if (!/^\d{6}$/.test(code)) continue;
    const normalized = normalizeStockMonitorConfig(value);
    if (normalized) result[code] = normalized;
  }
  return result;
}

export function summarizeStockMonitor(config: StockMonitorConfig): string {
  return config.conditions.map(condition => {
    const field = stockMonitorFields.find(entry => entry.value === condition.field)!;
    return `${field.label} ${condition.operator === "gte" ? "≥" : "≤"} ${Number((condition.value / field.scale).toFixed(6))} ${field.unit}`;
  }).join(config.mode === "all" ? " 且 " : " 或 ");
}

const signature = (config: StockMonitorConfig) => JSON.stringify([config.enabled, config.mode, config.cooldownMinutes, config.conditions.map(({ field, operator, value }) => [field, operator, value])]);

export function evaluateStockMonitor(
  config: StockMonitorConfig,
  snapshot: StockMonitorSnapshot | null | undefined,
  previous?: StockMonitorRuntime,
  now = Date.now(),
  maxAgeSeconds = 120
): StockMonitorEvaluation {
  const configSignature = signature(config);
  const runtime: StockMonitorRuntime = previous?.configSignature === configSignature
    ? { ...previous }
    : { configSignature, initialized: false, matched: null, lastAlertAt: previous?.lastAlertAt ?? null, lastSampleAt: null };
  const result = (status: StockMonitorEvaluation["status"], detail: string, shouldAlert = false): StockMonitorEvaluation => ({ runtime, status, detail, shouldAlert });
  if (!config.enabled) return result("disabled", "条件监控已暂停");
  if (!snapshot) return result("waiting", "等待获取有效行情");
  const quote = snapshot.quote;
  if (!quote || [snapshot.actualProvider, snapshot.provider, quote.source].some(value => /preview|mock|demo/i.test(String(value || "")))) return result("unavailable", "当前数据不可用于实时提醒");
  const fetchedAt = Date.parse(String(snapshot.updatedAt || ""));
  const sourceTimeText = String(quote.updatedAt || "").trim();
  const sourceTime = sourceTimeText ? Date.parse(sourceTimeText) : null;
  const maxAgeMs = Math.max(1, maxAgeSeconds) * 1000;
  const fresh = (time: number) => Number.isFinite(time) && now - time <= maxAgeMs && time - now <= 30000;
  if (!fresh(fetchedAt) || (sourceTime !== null && !fresh(sourceTime))) return result("stale", "行情已过期或时间无效，等待新报价");
  const sampleTime = sourceTime ?? fetchedAt;
  // Legacy quote adapters keep numeric zero fallbacks for other screens; their
  // missingFields metadata prevents those placeholders from satisfying rules.
  const missingFields = new Set(Array.isArray(quote.missingFields) ? quote.missingFields : []);
  const missing = config.conditions.filter(condition => missingFields.has(condition.field) || !finiteNumber(quote[condition.field]) || (condition.field !== "changePct" && Number(quote[condition.field]) < 0));
  if (missingFields.has("latest") || !finiteNumber(quote.latest) || quote.latest <= 0 || missing.length) {
    const labels = missing.map(condition => stockMonitorFields.find(field => field.value === condition.field)!.label);
    return result("unavailable", labels.length ? `缺少有效${[...new Set(labels)].join("、")}，暂不判断` : "缺少有效最新价，暂不判断");
  }
  if (runtime.lastSampleAt !== null && sampleTime <= runtime.lastSampleAt) return result(runtime.matched ? "matched" : "watching", "等待更新的行情样本");
  const matches = config.conditions.map(condition => condition.operator === "gte" ? Number(quote[condition.field]) >= condition.value : Number(quote[condition.field]) <= condition.value);
  const matched = config.mode === "all" ? matches.every(Boolean) : matches.some(Boolean);
  const wasMatched = runtime.matched;
  runtime.lastSampleAt = sampleTime;
  runtime.matched = matched;
  if (!runtime.initialized) {
    runtime.initialized = true;
    return result("baseline", matched ? "当前已满足；首次仅记录基线，等待条件回落后再次满足" : "基线已建立，等待条件满足");
  }
  if (!matched) return result("watching", "监控中，尚未满足条件");
  if (wasMatched) return result("matched", "条件持续满足，等待回落后再次触发");
  if (runtime.lastAlertAt !== null && now - runtime.lastAlertAt < config.cooldownMinutes * 60000) return result("cooldown", "条件再次满足，但仍在提醒冷却期");
  runtime.lastAlertAt = now;
  return result("triggered", summarizeStockMonitor(config), true);
}
