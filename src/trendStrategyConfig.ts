import catalog from "../config/trend-strategy-library.json";
import type { TrendQualityConfig, TrendStrategySnapshot, TrendLibraryId, TrendStrategyId } from "./trendScreenerTypes";

export const TREND_QUALITY_PRESETS: Readonly<Record<"robust" | "balanced", Readonly<TrendQualityConfig>>> = Object.freeze({
  robust: Object.freeze({ maxExtensionAtr: 2, minCloseLocation: 0.7, maxVolumeRatio: 3 }),
  balanced: Object.freeze({ maxExtensionAtr: 2.5, minCloseLocation: 0.65, maxVolumeRatio: 3.5 })
});
export const qualityPresetName = (config: TrendQualityConfig): "robust" | "balanced" | "custom-research" =>
  (["robust", "balanced"] as const).find(name => Object.entries(TREND_QUALITY_PRESETS[name]).every(([key, value]) => config[key as keyof TrendQualityConfig] === value)) || "custom-research";
export const TREND_DEFAULT_COMPARISON_STRATEGIES: TrendStrategyId[] = ["classic-v1", "quality-v2"];
export const TREND_CONFIG_FIELDS = [
  { key: "maxExtensionAtr", label: "最大均线偏离（ATR）", min: 0.5, max: 5, step: 0.1 },
  { key: "minCloseLocation", label: "最低收盘位置（0—1）", min: 0.5, max: 0.95, step: 0.05 },
  { key: "maxVolumeRatio", label: "最高五日量比", min: 1.2, max: 6, step: 0.1 }
] as const;
export type TrendLibraryDefinition = { entryType?: "breakout" | "close-confirmation"; id: TrendLibraryId; version: string; name: string; family: string; summary: string; trigger: string; parameters: Record<string, number>; marketCalendarLookback: number; fixedParameters: boolean; sources: { title: string; url: string }[] };
export const TREND_LIBRARY = catalog as unknown as TrendLibraryDefinition[];
export const libraryDefinition = (id: string | undefined) => TREND_LIBRARY.find(item => item.id === id);
export const TREND_STRATEGY_CHOICES: { id: TrendStrategyId; name: string }[] = [{ id: "quality-v2", name: "趋势质量 v2" }, ...TREND_LIBRARY.map(({ id, name }) => ({ id, name })), { id: "classic-v1", name: "原版趋势 v1" }];
export const strategyName = (strategy?: TrendStrategySnapshot) => libraryDefinition(strategy?.id)?.name || (strategy?.id === "quality-v2" ? "趋势质量 v2" : "原版趋势 v1");
function validLibraryConfig(id: string, value: unknown): value is Record<string, number> {
 const definition = libraryDefinition(id);
 if (!definition || !value || typeof value !== "object" || Array.isArray(value)) return false;
 const config = value as Record<string, unknown>;
 return Object.keys(config).length === Object.keys(definition.parameters).length && Object.entries(definition.parameters).every(([key, number]) => config[key] === number);
}
export const sameTrendStrategy = (a?: TrendStrategySnapshot, b?: TrendStrategySnapshot) => {
  if (!a && !b) return true;
  // Historical classic snapshots predate metadata; only the supported classic
  // version can stand in for that legacy identity.
  if (!a || !b) return Boolean((a || b)?.id === "classic-v1" && validStrategySnapshot(a || b));
  return validStrategySnapshot(a) && validStrategySnapshot(b) && a.id === b.id && a.version === b.version &&
    a.configHash === b.configHash && Object.keys(a.config).length === Object.keys(b.config).length &&
    Object.entries(a.config).every(([key, value]) => b.config[key] === value);
};
export function validQualityConfig(value: unknown): value is TrendQualityConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const values = value as Record<string, unknown>;
  return Object.keys(values).length === 3 && TREND_CONFIG_FIELDS.every(({ key, min, max }) => typeof values[key] === "number" && Number.isFinite(values[key]) && Number(values[key]) >= min && Number(values[key]) <= max);
}
export function validStrategySnapshot(value: unknown): value is TrendStrategySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.configHash !== "string" || !/^[a-f0-9]{64}$/.test(s.configHash)) return false;
  if (typeof s.id === "string" && libraryDefinition(s.id)) return ["1.0.0", "1.1.0"].includes(String(s.version)) && validLibraryConfig(s.id, s.config);
  if (s.id === "quality-v2") return ["2.0.0", "2.1.0"].includes(String(s.version)) && validQualityConfig(s.config);
  return s.id === "classic-v1" && s.version === "1.0.0" && Boolean(s.config && typeof s.config === "object" && !Array.isArray(s.config) && Object.keys(s.config).length === 0);
}
