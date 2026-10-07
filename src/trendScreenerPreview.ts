import type { TrendCandidate, TrendScanStatus, TrendScanRequest, TrendStrategySnapshot, TrendStrategySelection } from "./trendScreenerTypes";

import { TREND_QUALITY_PRESETS, validQualityConfig, libraryDefinition } from "./trendStrategyConfig";

const evidence = (shape: "A" | "B" | "watch", daysSinceLimit: number) => [
  { label: "近期涨停", passed: true, value: `距截止日 ${daysSinceLimit} 个交易日收盘触及推算涨停价`, rule: "最近 15 个交易日内" },
  { label: "趋势", passed: true, value: "收盘 > MA20 > MA60", rule: "MA20 高于 5 个交易日前" },
  { label: shape === "A" ? "回踩转强" : shape === "B" ? "平台突破" : "形态确认", passed: shape !== "watch", value: shape === "watch" ? "尚未出现完整 A/B 信号" : shape === "A" ? "三日缩量，收盘越过前日高点" : "整理区间缩量，收盘越过区间高点", rule: shape === "watch" ? "只作为趋势观察" : "信号日收盘确认，区间排除信号日" }
];

const candidates: TrendCandidate[] = [
  {
    security: { code: "DEMO-A01", name: "演示甲（虚构）", secid: "demo.a01", industry: "演示行业" },
    board: "main", asOf: "2026-09-29", limitDate: "2026-09-21", daysSinceLimit: 6,
    patterns: ["A"], stage: "signal", limitEvidence: "calculated", evidence: evidence("A", 6),
    metrics: { close: 12.48, ma20: 11.91, ma60: 10.87, avgAmount20: 328000000, deviationPercent: 4.8, relativeStrength20: 8.2, atr14: 0.38 },
    plan: { stop: 11.42, maxEntry: 12.41, maxRiskPercent: 7.98, holdingDays: "10–30 个交易日" },
    warnings: ["DEMO 演示数据，非真实证券", "涨停价按规则推算，待官方核验"]
  },
  {
    security: { code: "DEMO-B02", name: "演示乙（虚构）", secid: "demo.b02", industry: "演示行业" },
    board: "growth", asOf: "2026-09-29", limitDate: "2026-09-17", daysSinceLimit: 8,
    patterns: ["B"], stage: "signal", limitEvidence: "calculated", evidence: evidence("B", 8),
    metrics: { close: 24.36, ma20: 22.74, ma60: 20.58, avgAmount20: 415000000, deviationPercent: 7.1, relativeStrength20: 6.4, atr14: 0.81 },
    plan: { stop: 22.66, maxEntry: 24.63, maxRiskPercent: 8, holdingDays: "10–30 个交易日" },
    warnings: ["DEMO 演示数据，非真实证券", "涨停价按规则推算，待官方核验"]
  },
  {
    security: { code: "DEMO-W03", name: "演示丙（虚构）", secid: "demo.w03", industry: "演示行业" },
    board: "beijing", asOf: "2026-09-29", limitDate: "2026-09-23", daysSinceLimit: 4,
    patterns: [], stage: "watch", limitEvidence: "calculated", evidence: evidence("watch", 4),
    metrics: { close: 8.52, ma20: 8.14, ma60: 7.73, avgAmount20: 215000000, deviationPercent: 4.7, relativeStrength20: null, atr14: 0.29 },
    plan: null,
    warnings: ["DEMO 演示数据，非真实证券", "未形成 A/B 信号，无入场参考区间"]
  }
];

export function createTrendPreviewStatus(): TrendScanStatus {
  const now = new Date().toISOString();
  return {
    jobId: "DEMO-PARTIAL-COVERAGE", phase: "completed", startedAt: now, updatedAt: now, asOf: "2026-09-29",
    universeLoaded: 8, universeExpected: 12, processed: 8, excluded: 3, unavailable: 1, failed: 1,
    coverageComplete: false, marketGate: "open", validation: "unvalidated", isPreview: true,
    boards: [
      { id: "main", label: "沪深主板", expected: 3, loaded: 3, complete: true },
      { id: "growth", label: "创业板", expected: 3, loaded: 2, complete: false },
      { id: "star", label: "科创板", expected: 3, loaded: 2, complete: false },
      { id: "beijing", label: "北交所", expected: 3, loaded: 1, complete: false, error: "演示：一页名单请求失败" }
    ],
    candidates: structuredClone(candidates),
    errors: [{ stage: "universe", message: "DEMO：北交所名单分页未完成，此结果只用于界面演示。" }],
    note: "DEMO / 演示状态：虚构证券、演示市场门槛与部分覆盖样例，不代表任何真实市场扫描结果。"
  };
}

// Deliberately synthetic UI examples, never a substitute for the backend evaluator.
const sha256 = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2, "0")).join("");
async function previewStrategy(options: TrendStrategySelection): Promise<TrendStrategySnapshot> {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["strategyId", "config"].includes(key))) throw new Error("未知策略选项");
  const id = options.strategyId ?? "classic-v1";
  const definition = libraryDefinition(id);
  if (id !== "quality-v2" && id !== "classic-v1" && !definition) throw new Error("未知趋势策略 ID");
  if (options.config !== undefined && (!options.config || typeof options.config !== "object" || Array.isArray(options.config))) throw new Error("策略配置必须为对象");
  const config: Record<string, number> = definition ? { ...definition.parameters } : id === "quality-v2" ? { ...TREND_QUALITY_PRESETS.robust, ...options.config } : {};
  if (definition && Object.entries(options.config || {}).some(([key, value]) => !Object.hasOwn(definition.parameters, key) || value !== definition.parameters[key])) throw new Error("此策略版本使用固定参数");
  if ((id === "quality-v2" && !validQualityConfig(config)) || (id === "classic-v1" && Object.keys(options.config || {}).length)) throw new Error("无效策略参数");
  const version = definition?.version || (id === "quality-v2" ? "2.0.0" : "1.0.0");
  const configHash = await sha256({ id, version, config });
  return { id, version, configHash, config };
}
function previewCandidates(strategy: TrendStrategySnapshot): TrendCandidate[] {
  const { id, config } = strategy;
  const definition = libraryDefinition(id);
  return structuredClone(candidates).map((candidate, index) => {
    if (id === "classic-v1") return { ...candidate, strategy };
    if (definition) {
      const triggerPrice = index === 0 ? 12.29 : index === 1 ? 24.09 : 8.50;
      return { ...candidate, strategy, patterns: [], primaryPattern: null,
        setup: { id: definition.id, label: definition.name, triggerPrice, stopBasis: "DEMO 五日低点与涨停日低点示例" },
        technical: { indicators: { triggerPrice, atr14Previous: candidate.metrics.atr14, extensionAtr: 1.5 } },
        plan: candidate.plan ? { ...candidate.plan, minEntry: index === 0 ? 12.30 : 24.10 } : null,
        warnings: [...candidate.warnings.filter(warning => !warning.includes("A/B")), ...(candidate.stage === "watch" ? ["DEMO 独立策略条件尚未确认，无入场参考区间"] : [])],
        evidence: [{ label: "DEMO 独立规则", passed: candidate.stage === "signal", value: definition.name, rule: definition.summary }, { label: "DEMO 数据", passed: true, value: "虚构指标与价格", rule: "只验证界面和保存交互，不是后端选股计算结果" }]
      };
    }
    const quality = { atr14Previous: candidate.metrics.atr14, extensionAtr: index === 0 ? 1.5 : index === 1 ? 2 : 1.31, closeLocation: 0.82, volumeRatio: 1.5, volumeMedian20: 10000000, ma60Rising: true, relativeStrengthPositive: candidate.metrics.relativeStrength20 !== null && candidate.metrics.relativeStrength20 > 0, holdingMa20Count: 3, stopDistanceAtr: candidate.plan ? (candidate.metrics.close - candidate.plan.stop) / candidate.metrics.atr14 : 0 };
    const passed = candidate.stage === "signal" && quality.extensionAtr <= Number(config.maxExtensionAtr) && quality.closeLocation >= Number(config.minCloseLocation) && quality.volumeRatio <= Number(config.maxVolumeRatio);
    return { ...candidate, strategy, quality, primaryPattern: candidate.patterns[0] || null, stage: passed ? "signal" : "watch", plan: passed && candidate.plan ? { ...candidate.plan, minEntry: index === 0 ? 12.30 : 24.10 } : null,
      evidence: [...candidate.evidence, { label: "DEMO 质量约束", passed, value: "虚构质量指标与参数的交互示例", rule: "只用于演示控件和冻结快照；真实扫描由独立后端引擎计算" }] };
  });
}
export async function createConfiguredTrendPreviewStatus(options: TrendScanRequest = {}): Promise<TrendScanStatus> {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["strategyId", "config", "strategies", "forceRefresh"].includes(key))) throw new Error("未知扫描选项");
  if (options.forceRefresh !== undefined && typeof options.forceRefresh !== "boolean") throw new Error("forceRefresh 必须为布尔值");
  let selections: TrendStrategySelection[];
  if ("strategies" in options) {
    if ("strategyId" in options || "config" in options || !Array.isArray(options.strategies) || options.strategies.length < 1 || options.strategies.length > 14 || options.strategies.some(s => !s?.strategyId) || new Set(options.strategies.map(s => s.strategyId)).size !== options.strategies.length) throw new Error("联选需要1—14个不重复策略且不能混用单选参数");
    selections = options.strategies;
  } else selections = [{ ...(options.strategyId === undefined ? {} : { strategyId: options.strategyId }), ...(options.config === undefined ? {} : { config: options.config }) }];
  const strategies = (await Promise.all(selections.map(previewStrategy))).sort((a, b) => a.id.localeCompare(b.id));
  const state = createTrendPreviewStatus();
  state.strategies = strategies; state.strategySetHash = await sha256(strategies);
  if (strategies.length === 1) state.strategy = strategies[0]!;
  state.candidates = strategies.flatMap(previewCandidates);
  state.strategyStats = strategies.map(strategy => ({ strategy, processed: state.processed, candidateCount: state.candidates.filter(c => c.strategy?.id === strategy.id).length, excluded: state.excluded, unavailable: state.unavailable, failed: state.failed, coverageComplete: false }));
  return state;
}
