"use strict";

// 用户自定义选股策略：声明式条件组合 → 选股引擎可执行的策略定义。
// 只描述“选什么”，不含任何函数或代码；保存在主进程 custom-strategies.json。
// 条件词表来自 config/strategy-custom-conditions.json（前后端共用）。

const catalog = require("../config/strategy-custom-conditions.json");
const { isBseAshareCode } = require("./price-limit-rules.cjs");
const { presetForSelection } = require("./analysis-selection-policy.cjs");

const SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({ ...catalog.limits });
const DEFAULTS = Object.freeze({ ...catalog.defaults });
const FACTOR_BY_ID = new Map(catalog.factors.map(item => [item.id, item]));
const FILTER_BY_KEY = new Map(catalog.filters.map(item => [item.key, item]));
const BOARD_IDS = catalog.boards.map(item => item.id);
const UNIVERSE_BY_ID = new Map(catalog.universes.map(item => [item.id, item]));
const ID_PATTERN = /^cs_[a-z0-9]{6,32}$/;
const REF_PATTERN = /^(factor|pattern):([A-Za-z0-9_]{1,64})$/;
// 设置页旧组合同样把精确节点视为门槛，不参与匹配率；风险否决始终启用。
const GATE_FACTORS = new Set(catalog.factors.filter(item => item.gate).map(item => item.id));
const LEGACY_PRESET_NAMES = Object.freeze({
  steady: "稳健趋势", firstBoard: "低位首板", leader: "主线龙头", secondWave: "二波蓄势", turnStrong: "弱转强",
  anchoredTrend: "锚定趋势", volumeSupport: "缩量承接", breakoutOrigin: "突破源头", compressionWatch: "压缩待变",
  lowBaseAccumulation: "低位缩量观察", leaderSupport: "龙头承接", sectorBreadth: "梯队共振", catalystTrend: "催化趋势",
  firstBoardNode: "首板观察节点", breakoutFollow: "突破跟随"
});

class CustomStrategyError extends Error {
  constructor(message, field = "") { super(message); this.name = "CustomStrategyError"; this.code = "INVALID_CUSTOM_STRATEGY"; this.field = field; }
}
const fail = (message, field) => { throw new CustomStrategyError(message, field); };
const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isoTime = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function boardOf(code) {
  const text = String(code || "");
  if (isBseAshareCode(text)) return "bse";
  if (/^68[89]\d{3}$/.test(text)) return "star";
  if (/^30[012]\d{3}$/.test(text)) return "chinext";
  if (/^(?:000|001|002|003|600|601|603|605)\d{3}$/.test(text)) return "main";
  return "";
}

function parseRef(ref, patternIds) {
  const match = typeof ref === "string" ? ref.match(REF_PATTERN) : null;
  if (!match) return null;
  const [, kind, id] = match;
  if (kind === "factor" && FACTOR_BY_ID.has(id)) return { ref, kind, id };
  if (kind === "pattern" && patternIds.has(id)) return { ref, kind, id };
  return null;
}

function normalizeFilters(raw) {
  const input = plainObject(raw) ? raw : {};
  const filters = {};
  for (const [key, spec] of FILTER_BY_KEY) {
    const value = input[key];
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number < spec.min || number > spec.max) fail(`${spec.label}须在 ${spec.min}–${spec.max}${spec.unit} 之间`, `filters.${key}`);
    if (spec.integer && !Number.isInteger(number)) fail(`${spec.label}须为整数`, `filters.${key}`);
    filters[key] = number;
  }
  if (filters.minDaysSinceLimit !== undefined && filters.maxDaysSinceLimit !== undefined && filters.minDaysSinceLimit > filters.maxDaysSinceLimit) {
    fail("涨停后最少天数不能大于最多天数", "filters.minDaysSinceLimit");
  }
  if (input.excludeOnePriceToday === true) filters.excludeOnePriceToday = true;
  if (input.boards !== undefined) {
    if (!Array.isArray(input.boards) || input.boards.some(item => !BOARD_IDS.includes(item))) fail("板块范围无效", "filters.boards");
    const boards = BOARD_IDS.filter(item => input.boards.includes(item));
    if (!boards.length) fail("至少保留一个板块", "filters.boards");
    if (boards.length < BOARD_IDS.length) filters.boards = boards;
  }
  return filters;
}

/**
 * Validate and normalize one user strategy. Throws CustomStrategyError with a
 * user-facing Chinese message (and the offending field) on invalid input.
 * `patternIds` are the built-in rule ids that may be referenced as conditions.
 */
function normalizeCustomStrategy(input, { patternIds = new Set() } = {}) {
  if (!plainObject(input)) fail("策略内容无效");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) fail("请填写策略名称", "name");
  if ([...name].length > LIMITS.nameMax) fail(`策略名称不超过 ${LIMITS.nameMax} 个字`, "name");
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if ([...description].length > LIMITS.descriptionMax) fail(`策略说明不超过 ${LIMITS.descriptionMax} 个字`, "description");
  const universe = input.universe === undefined ? DEFAULTS.universe : input.universe;
  if (!UNIVERSE_BY_ID.has(universe)) fail("选股范围无效", "universe");
  if (!Array.isArray(input.conditions) || !input.conditions.length) fail("请至少选择一个条件", "conditions");
  const byRef = new Map();
  for (const item of input.conditions) {
    const parsed = parseRef(plainObject(item) ? item.ref : item, patternIds);
    if (!parsed) fail(`条件无法识别：${String(plainObject(item) ? item.ref : item).slice(0, 60)}`, "conditions");
    const required = plainObject(item) && item.required === true;
    byRef.set(parsed.ref, { ref: parsed.ref, required: Boolean(byRef.get(parsed.ref)?.required || required) });
  }
  if (byRef.size > LIMITS.maxConditions) fail(`条件不超过 ${LIMITS.maxConditions} 个`, "conditions");
  const conditions = [...byRef.values()];
  const groupsInput = input.requiredAnyGroups === undefined ? [] : input.requiredAnyGroups;
  if (!Array.isArray(groupsInput) || groupsInput.length > LIMITS.maxRequiredAnyGroups) fail(`“至少满足其一”分组不超过 ${LIMITS.maxRequiredAnyGroups} 组`, "requiredAnyGroups");
  const requiredAnyGroups = groupsInput.map(group => {
    if (!Array.isArray(group)) fail("“至少满足其一”分组无效", "requiredAnyGroups");
    const refs = [...new Set(group)];
    if (refs.length < 2 || refs.some(ref => !byRef.has(ref))) fail("“至少满足其一”分组须包含两个以上已选条件", "requiredAnyGroups");
    return refs;
  });
  const percent = input.minMatchPercent === undefined ? DEFAULTS.minMatchPercent : Number(input.minMatchPercent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) fail("最低匹配比例须在 0–100% 之间", "minMatchPercent");
  const revision = Number.isSafeInteger(input.revision) && input.revision > 0 ? input.revision : 1;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: typeof input.id === "string" && ID_PATTERN.test(input.id) ? input.id : null,
    name, description, universe, conditions, requiredAnyGroups,
    minMatchPercent: Math.round(percent),
    filters: normalizeFilters(input.filters),
    origin: ["legacy-settings", "copy", "user"].includes(input.origin) ? input.origin : "user",
    revision,
    createdAt: isoTime(input.createdAt),
    updatedAt: isoTime(input.updatedAt)
  };
}

/**
 * C2-02：只有「全市场 · 近期涨停股」这类范围本身要求近期涨停，才可能因为缺少涨停事件被否决。
 * 自选与持仓范围（watchlist）明确不要求近期涨停，不能用涨停事件派生出的风险否决去否决它。
 */
const scopeRequiresLimitEvent = universe => universe !== "watchlist";

function labelFor(parsed, patternNames) {
  return parsed.kind === "factor" ? FACTOR_BY_ID.get(parsed.id)?.label || parsed.id : patternNames.get(parsed.id) || parsed.id;
}

function describe(strategy, refs, patternNames) {
  const label = ref => labelFor(refs.get(ref), patternNames);
  const required = strategy.conditions.filter(item => item.required || GATE_FACTORS.has(refs.get(item.ref).id)).map(item => label(item.ref));
  const optional = strategy.conditions.filter(item => !item.required && !GATE_FACTORS.has(refs.get(item.ref).id)).map(item => label(item.ref));
  const external = strategy.conditions.filter(item => refs.get(item.ref).kind === "factor" && FACTOR_BY_ID.get(refs.get(item.ref).id)?.group === "external").map(item => label(item.ref));
  const f = strategy.filters;
  const lines = [];
  if (required.length) lines.push(`必要条件：${required.join("、")}`);
  if (optional.length) lines.push(`其他条件：${optional.join("、")}`);
  for (const group of strategy.requiredAnyGroups) lines.push(`至少满足其一：${group.map(label).join(" 或 ")}`);
  lines.push(`匹配规则：全部条件（不含门槛）中至少满足 ${strategy.minMatchPercent}%`);
  // C2-02：风险否决的比较基准是「最近一次涨停事件」（涨停日低点、涨停日起算的锚定均价）。
  // 自选与持仓范围不要求近期涨停，无涨停事件时没有可比基准，文案必须与实际判定一致。
  lines.push(scopeRequiresLimitEvent(strategy.universe)
    ? "风险否决：始终启用（跌破涨停低点、量能超过2倍、放量跌破均价或放量弱收盘时排除）"
    : "风险否决：以最近一次涨停事件为基准（跌破涨停低点、量能超过2倍、放量跌破均价或放量弱收盘时排除）；本范围不要求近期涨停，无涨停事件时不做风险否决，按条件匹配判定");
  if (f.minDaysSinceLimit !== undefined || f.maxDaysSinceLimit !== undefined) lines.push(`涨停后天数：${f.minDaysSinceLimit ?? 0}–${f.maxDaysSinceLimit ?? 60} 天`);
  if (f.minAmountYi !== undefined) lines.push(`当日成交额不低于 ${f.minAmountYi} 亿元`);
  if (f.maxConsecutiveBoards !== undefined) lines.push(`连板数不超过 ${f.maxConsecutiveBoards} 板`);
  if (f.maxDistanceToInvalidationPct !== undefined) lines.push(`距失效位不超过 ${f.maxDistanceToInvalidationPct}%`);
  if (f.excludeOnePriceToday) lines.push("排除当日一字涨停");
  if (f.boards) lines.push(`板块范围：${f.boards.map(id => catalog.boards.find(item => item.id === id)?.label || id).join("、")}`);
  if (external.length) lines.push(`需个股数据：${external.join("、")}（选股时标为待确认）`);
  return { lines, external };
}

/**
 * Compile a normalized strategy into a selection-engine definition. Pattern
 * conditions call the built-in rule matchers; daily factors read the lazily
 * computed `feature.legacyFactors` (个股分析同口径). External factors are
 * "pending": they never block screening but are surfaced for confirmation.
 */
function compileCustomStrategy(strategy, { patternMatchers = new Map(), patternNames = new Map() } = {}) {
  const refs = new Map(strategy.conditions.map(item => [item.ref, parseRef(item.ref, new Set(patternMatchers.keys()))]));
  if ([...refs.values()].some(item => !item)) throw new CustomStrategyError(`策略「${strategy.name}」引用的内置规则已不存在，请编辑后重新保存`, "conditions");
  const { lines, external } = describe(strategy, refs, patternNames);
  const universe = UNIVERSE_BY_ID.get(strategy.universe) || UNIVERSE_BY_ID.get(DEFAULTS.universe);
  const statusOf = (parsed, feature) => {
    if (parsed.kind === "pattern") return patternMatchers.get(parsed.id)(feature) === true ? "pass" : "fail";
    if (FACTOR_BY_ID.get(parsed.id).group === "external") return "pending";
    return feature.legacyFactors?.factors?.[parsed.id] === true ? "pass" : "fail";
  };
  const filterFailure = (feature, legacy) => {
    const f = strategy.filters;
    const days = legacy?.daysSinceLimit;
    if ((f.minDaysSinceLimit !== undefined || f.maxDaysSinceLimit !== undefined) &&
        (!Number.isInteger(days) || days < (f.minDaysSinceLimit ?? 0) || days > (f.maxDaysSinceLimit ?? 60))) return "涨停后天数不在范围内";
    if (f.minAmountYi !== undefined && !(Number(feature.latestAmount) >= f.minAmountYi * 1e8)) return "成交额不足";
    // 连板数、失效位来自 20 日内的涨停事件；「涨停后天数」看 60 日内。两者不是同一次涨停时如实说明，不按 0 连板、无失效位误判。
    const sameEvent = !legacy?.eventDate || legacy.eventDate === feature.eventDate;
    if ((f.maxConsecutiveBoards !== undefined || f.maxDistanceToInvalidationPct !== undefined) && !sameEvent) return "最近一次涨停超出 20 日，连板数和失效位无法核对";
    if (f.maxConsecutiveBoards !== undefined && Number(feature.consecutiveBoards) > f.maxConsecutiveBoards) return "连板数超过上限";
    if (f.maxDistanceToInvalidationPct !== undefined) {
      const invalidation = Number(feature.eventLow) * 0.995, latest = Number(feature.latest);
      if (!(invalidation > 0 && latest > 0) || (latest - invalidation) / latest * 100 > f.maxDistanceToInvalidationPct) return "距失效位过远";
    }
    if (f.excludeOnePriceToday && feature.onePriceToday === true) return "当日一字涨停";
    if (f.boards && !f.boards.includes(boardOf(feature.securityCode))) return "不在所选板块";
    return "";
  };
  const evaluate = feature => {
    const empty = { passed: false, needsConfirmation: false, matchRate: 0, optimisticRate: 0, matched: [], pending: [], failed: [], reasons: [], blockedBy: "" };
    if (!feature) return { ...empty, blockedBy: "行情不足" };
    const legacy = feature.legacyFactors;
    if (!legacy) return { ...empty, blockedBy: "行情不足" };
    // C2-02：风险否决只对「有涨停事件可比」的样本生效。
    // watchlist 范围不要求近期涨停，无涨停事件时 legacy.factors.riskVeto 恒为 false，
    // 旧逻辑会把这类股票一律判「风险否决」，与该范围文案矛盾；此时应交给条件匹配判定。
    const riskVetoUnavailable = legacy.hasEvent === false && !scopeRequiresLimitEvent(strategy.universe);
    if (legacy.factors?.riskVeto !== true && !riskVetoUnavailable) return { ...empty, blockedBy: "风险否决" };
    const blockedBy = filterFailure(feature, legacy);
    if (blockedBy) return { ...empty, blockedBy };
    const status = new Map(strategy.conditions.map(item => [item.ref, statusOf(refs.get(item.ref), feature)]));
    const label = ref => labelFor(refs.get(ref), patternNames);
    const matched = [], pending = [], failed = [];
    for (const item of strategy.conditions) {
      const value = status.get(item.ref);
      (value === "pass" ? matched : value === "pending" ? pending : failed).push(label(item.ref));
    }
    const mustHold = strategy.conditions.filter(item => item.required || GATE_FACTORS.has(refs.get(item.ref).id));
    if (mustHold.some(item => status.get(item.ref) === "fail")) return { ...empty, matched, pending, failed, blockedBy: "必要条件未满足" };
    for (const group of strategy.requiredAnyGroups) {
      if (!group.some(ref => status.get(ref) !== "fail")) return { ...empty, matched, pending, failed, blockedBy: "“至少满足其一”未满足" };
    }
    const scoring = strategy.conditions.filter(item => !GATE_FACTORS.has(refs.get(item.ref).id));
    const passCount = scoring.filter(item => status.get(item.ref) === "pass").length;
    const pendingCount = scoring.filter(item => status.get(item.ref) === "pending").length;
    const matchRate = scoring.length ? Math.round(passCount / scoring.length * 100) : 100;
    const optimisticRate = scoring.length ? Math.round((passCount + pendingCount) / scoring.length * 100) : 100;
    const passed = optimisticRate >= strategy.minMatchPercent;
    const needsConfirmation = passed && (matchRate < strategy.minMatchPercent ||
      mustHold.some(item => status.get(item.ref) === "pending") ||
      strategy.requiredAnyGroups.some(group => !group.some(ref => status.get(ref) === "pass")));
    const reasons = [`满足 ${passCount}/${scoring.length} 项（要求 ≥${strategy.minMatchPercent}%）`, ...matched.slice(0, 3)];
    if (pending.length) reasons.push(`待确认：${pending.join("、")}`);
    return { passed, needsConfirmation, matchRate, optimisticRate, matched, pending, failed, reasons, blockedBy: passed ? "" : "匹配比例不足" };
  };
  return {
    id: strategy.id, version: `custom-r${strategy.revision}`, type: "custom", custom: true, family: "custom",
    name: strategy.name, detail: strategy.description || lines[0] || "用户自定义条件组合",
    conditions: lines, componentNames: strategy.conditions.map(item => label(item)), components: [],
    parameters: Object.fromEntries(Object.entries({ minMatchPercent: strategy.minMatchPercent, ...strategy.filters }).filter(([, value]) => typeof value === "number")),
    dataRequirements: ["与个股分析相同的日线算法（近60日最近一次涨停为事件）", external.length ? "板块、资讯、情绪、封板类条件需个股数据，批量选股时待确认" : "仅使用日线数据"],
    scope: universe.detail, universeId: universe.id,
    evidenceLevel: "用户自定义条件组合；历史参考只按日线条件计算，待确认条件按满足处理",
    sources: [], adaptationNote: "", origin: strategy.origin, revision: strategy.revision, hasExternal: external.length > 0,
    evaluate,
    matches: feature => evaluate(feature).passed,
    reasons: feature => evaluate(feature).reasons
  };
  function label(item) { return labelFor(refs.get(item.ref), patternNames); }
}

/** Convert the legacy Settings factor combination into a custom strategy with identical gates. */
function legacyStrategyFromSettings(selectedStrategies, { now = new Date() } = {}) {
  const ids = [...new Set((Array.isArray(selectedStrategies) ? selectedStrategies : []).filter(id => typeof id === "string" && FACTOR_BY_ID.has(id)))];
  if (!ids.length) return null;
  const preset = presetForSelection([...ids, "riskVeto"]);
  const requiredAll = new Set(preset?.requiredAll || []);
  const stamp = new Date(now).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION, id: null,
    name: preset ? `${LEGACY_PRESET_NAMES[preset.id] || preset.id}（由设置迁移）` : "我的自主组合（由设置迁移）",
    description: "由「数据源设置 → 自主策略组合」自动迁移，保持原有 70% 匹配率与命名组合必要条件；个股分析与预警仍使用设置中的组合。",
    universe: DEFAULTS.universe,
    conditions: ids.map(id => ({ ref: `factor:${id}`, required: requiredAll.has(id) })),
    requiredAnyGroups: (preset?.requiredAnyGroups || []).map(group => group.map(id => `factor:${id}`)),
    minMatchPercent: 70, filters: {}, origin: "legacy-settings", revision: 1, createdAt: stamp, updatedAt: stamp
  };
}

function emptyStore() { return { schemaVersion: SCHEMA_VERSION, migratedLegacy: false, strategies: [] }; }

/** Keep every valid saved strategy; drop entries that no longer validate instead of failing the whole store. */
function normalizeCustomStrategyStore(doc, { patternIds = new Set() } = {}) {
  if (!plainObject(doc)) return { ...emptyStore(), dropped: 0 };
  const strategies = [];
  let dropped = 0;
  const seen = new Set();
  for (const raw of Array.isArray(doc.strategies) ? doc.strategies : []) {
    try {
      const strategy = normalizeCustomStrategy(raw, { patternIds });
      if (!strategy.id || seen.has(strategy.id)) { dropped += 1; continue; }
      seen.add(strategy.id);
      strategies.push(strategy);
    } catch { dropped += 1; }
  }
  return { schemaVersion: SCHEMA_VERSION, migratedLegacy: doc.migratedLegacy === true, strategies: strategies.slice(0, LIMITS.maxStrategies), dropped };
}

function saveCustomStrategyInStore(store, input, { patternIds = new Set(), now = new Date(), newId } = {}) {
  const current = store && Array.isArray(store.strategies) ? store.strategies : [];
  const strategy = normalizeCustomStrategy(input, { patternIds });
  const stamp = new Date(now).toISOString();
  const existing = strategy.id ? current.find(item => item.id === strategy.id) : null;
  const key = strategy.name.toLocaleLowerCase("zh-CN");
  if (current.some(item => item.id !== existing?.id && item.name.toLocaleLowerCase("zh-CN") === key)) fail("已有同名策略，请换一个名称", "name");
  let saved;
  if (existing) {
    saved = { ...strategy, origin: existing.origin, createdAt: existing.createdAt || stamp, updatedAt: stamp, revision: existing.revision + 1 };
  } else {
    if (current.length >= LIMITS.maxStrategies) fail(`最多保存 ${LIMITS.maxStrategies} 套自定义策略`);
    const id = typeof newId === "function" ? newId() : `cs_${Math.random().toString(36).slice(2, 12)}`;
    if (!ID_PATTERN.test(id) || current.some(item => item.id === id)) fail("无法生成策略编号，请重试");
    saved = { ...strategy, id, createdAt: stamp, updatedAt: stamp, revision: 1 };
  }
  const strategies = existing ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved];
  return { store: { schemaVersion: SCHEMA_VERSION, migratedLegacy: store?.migratedLegacy === true, strategies }, strategy: saved };
}

function deleteCustomStrategyFromStore(store, id) {
  const current = store && Array.isArray(store.strategies) ? store.strategies : [];
  if (!current.some(item => item.id === id)) fail("策略不存在或已删除");
  return { schemaVersion: SCHEMA_VERSION, migratedLegacy: store?.migratedLegacy === true, strategies: current.filter(item => item.id !== id) };
}

module.exports = {
  SCHEMA_VERSION, LIMITS, CustomStrategyError, boardOf,
  normalizeCustomStrategy, compileCustomStrategy, legacyStrategyFromSettings,
  emptyStore, normalizeCustomStrategyStore, saveCustomStrategyInStore, deleteCustomStrategyFromStore
};
