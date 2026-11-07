import conditionCatalog from "../../../config/strategy-custom-conditions.json";

// 自定义选股策略的前端模型。条件词表与主进程共用 config/strategy-custom-conditions.json；
// 这里的校验只为即时提示，最终以主进程保存时的校验为准。

export type CustomUniverse = "limit_pool" | "watchlist";
export type CustomConditionRef = { ref: string; required?: boolean };
export type CustomStrategyFilters = {
  minDaysSinceLimit?: number; maxDaysSinceLimit?: number; minAmountYi?: number; maxConsecutiveBoards?: number;
  maxDistanceToInvalidationPct?: number; excludeOnePriceToday?: boolean; boards?: string[];
};
export type CustomStrategy = {
  schemaVersion?: number; id: string | null; name: string; description: string; universe: CustomUniverse;
  conditions: CustomConditionRef[]; requiredAnyGroups: string[][]; minMatchPercent: number; filters: CustomStrategyFilters;
  origin?: string; revision?: number; createdAt?: string | null; updatedAt?: string | null;
};
export type CustomFactor = { id: string; label: string; group: "daily" | "external"; detail: string; gate?: boolean };
export type CustomFilterSpec = { key: keyof CustomStrategyFilters; label: string; min: number; max: number; step: number; integer?: boolean; unit: string };
export type PatternOption = { id: string; name: string; family?: string | undefined; detail?: string | undefined };

export const CUSTOM_CATALOG = conditionCatalog as unknown as {
  version: string; groups: { id: string; label: string; detail: string }[]; factors: CustomFactor[]; filters: CustomFilterSpec[];
  boards: { id: string; label: string }[]; universes: { id: CustomUniverse; label: string; detail: string }[];
  limits: { maxStrategies: number; maxConditions: number; nameMax: number; descriptionMax: number; maxRequiredAnyGroups: number };
  defaults: { minMatchPercent: number; universe: CustomUniverse };
};
const factorById = new Map(CUSTOM_CATALOG.factors.map(item => [item.id, item]));

export const emptyCustomStrategy = (): CustomStrategy => ({
  id: null, name: "", description: "", universe: CUSTOM_CATALOG.defaults.universe, conditions: [], requiredAnyGroups: [],
  minMatchPercent: CUSTOM_CATALOG.defaults.minMatchPercent, filters: {}
});

/** A copy keeps every condition but becomes a new strategy with its own id and history. */
export const copyCustomStrategy = (source: CustomStrategy): CustomStrategy => ({
  ...structuredClone(source), id: null, origin: "copy", revision: 1, createdAt: null, updatedAt: null,
  name: `${source.name.slice(0, CUSTOM_CATALOG.limits.nameMax - 3)}副本`
});

export const conditionLabel = (ref: string, patterns: PatternOption[]) => {
  const [kind, id] = ref.split(":");
  if (kind === "factor") return factorById.get(id || "")?.label || id || ref;
  return patterns.find(item => item.id === id)?.name || id || ref;
};
export const isExternalRef = (ref: string) => ref.startsWith("factor:") && factorById.get(ref.slice(7))?.group === "external";
export const isGateRef = (ref: string) => ref.startsWith("factor:") && factorById.get(ref.slice(7))?.gate === true;

export type CustomStrategyIssue = { field: string; message: string };
/** Instant client-side checks mirroring electron/custom-strategy.cjs. */
export function validateCustomStrategy(strategy: CustomStrategy, patterns: PatternOption[], others: CustomStrategy[] = []): CustomStrategyIssue[] {
  const issues: CustomStrategyIssue[] = [];
  const name = strategy.name.trim();
  if (!name) issues.push({ field: "name", message: "请填写策略名称" });
  else if ([...name].length > CUSTOM_CATALOG.limits.nameMax) issues.push({ field: "name", message: `策略名称不超过 ${CUSTOM_CATALOG.limits.nameMax} 个字` });
  else if (others.some(item => item.id !== strategy.id && item.name.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) issues.push({ field: "name", message: "已有同名策略，请换一个名称" });
  if ([...strategy.description.trim()].length > CUSTOM_CATALOG.limits.descriptionMax) issues.push({ field: "description", message: `策略说明不超过 ${CUSTOM_CATALOG.limits.descriptionMax} 个字` });
  if (!strategy.conditions.length) issues.push({ field: "conditions", message: "请至少选择一个条件" });
  if (strategy.conditions.length > CUSTOM_CATALOG.limits.maxConditions) issues.push({ field: "conditions", message: `条件不超过 ${CUSTOM_CATALOG.limits.maxConditions} 个` });
  const known = (ref: string) => ref.startsWith("factor:") ? factorById.has(ref.slice(7)) : ref.startsWith("pattern:") && patterns.some(item => item.id === ref.slice(8));
  const unknown = strategy.conditions.filter(item => !known(item.ref));
  if (unknown.length) issues.push({ field: "conditions", message: `有 ${unknown.length} 个条件已不存在，请移除后保存` });
  if (!Number.isFinite(strategy.minMatchPercent) || strategy.minMatchPercent < 0 || strategy.minMatchPercent > 100) issues.push({ field: "minMatchPercent", message: "最低匹配比例须在 0–100% 之间" });
  for (const spec of CUSTOM_CATALOG.filters) {
    const value = strategy.filters[spec.key];
    if (value === undefined) continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number < spec.min || number > spec.max || (spec.integer && !Number.isInteger(number))) {
      issues.push({ field: `filters.${spec.key}`, message: `${spec.label}须为 ${spec.min}–${spec.max}${spec.unit}${spec.integer ? " 的整数" : ""}` });
    }
  }
  const { minDaysSinceLimit: min, maxDaysSinceLimit: max } = strategy.filters;
  if (min !== undefined && max !== undefined && min > max) issues.push({ field: "filters.minDaysSinceLimit", message: "涨停后最少天数不能大于最多天数" });
  if (strategy.filters.boards && !strategy.filters.boards.length) issues.push({ field: "filters.boards", message: "至少保留一个板块" });
  strategy.requiredAnyGroups.forEach((group, index) => {
    if (group.length < 2 || group.some(ref => !strategy.conditions.some(item => item.ref === ref))) issues.push({ field: `requiredAnyGroups.${index}`, message: "“至少满足其一”分组须包含两个以上已选条件" });
  });
  return issues;
}

/** Plain-language summary used in the library and detail header. */
export function describeCustomStrategy(strategy: CustomStrategy, patterns: PatternOption[]) {
  const label = (ref: string) => conditionLabel(ref, patterns);
  const required = strategy.conditions.filter(item => item.required || isGateRef(item.ref)).map(item => label(item.ref));
  const optional = strategy.conditions.filter(item => !item.required && !isGateRef(item.ref)).map(item => label(item.ref));
  const external = strategy.conditions.filter(item => isExternalRef(item.ref)).map(item => label(item.ref));
  return { required, optional, external, count: strategy.conditions.length,
    universe: CUSTOM_CATALOG.universes.find(item => item.id === strategy.universe)?.label || "全市场 · 近期涨停股" };
}

/** Turn an IPC error ("Error invoking remote method …: Error: msg") into the user-facing message. */
export const ipcMessage = (reason: unknown) => {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^(?:[A-Za-z]*Error):\s*/, "");
};
