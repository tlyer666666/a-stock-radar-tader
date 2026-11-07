import { loadSafeLocalJson } from "../../safeStorage";
import { normalizeSettings } from "../../domain/settings";
import { isBacktestHistoryCollection, isBacktestHistoryRow } from "../../researchStorage";
import { normalizeBacktestDraft, normalizeBacktestStrategyIds, normalizeBacktestStrategyProfile } from "./backtestModel";
import type { BacktestDraft, BacktestHistoryRecord, BacktestStrategyProfile } from "./backtestTypes";

export const BACKTEST_HISTORY_KEY = "a-stock-radar-v054-backtest-history-v1";
export const BACKTEST_HISTORY_LIMIT = 30;

const normalizeBacktestHistoryEntry = (input: any, fallbackSettings: Settings): BacktestHistoryRecord | null => {
  if (!isBacktestHistoryRow(input)) return null;
  const rawDraft = normalizeBacktestDraft(input.draft || input.input);
  const rawResult = input.rawResult || input.result || input;
  const rawMetrics =
    rawResult && typeof rawResult.metrics === "object" && rawResult.metrics ? rawResult.metrics : null;
  const securityCode = String(
    input.securityCode
      || rawResult?.security?.code
      || rawDraft.securityCode
      || ""
  );
  const strategyIds = normalizeBacktestStrategyIds(
    input.strategyIds || input.strategyProfile?.selectedStrategies || rawResult?.strategyIds
  );
  const strategyProfile: BacktestStrategyProfile = normalizeBacktestStrategyProfile(
    input.strategyProfile || rawResult?.strategyProfile || rawResult?.executionPolicy,
    fallbackSettings,
    rawDraft,
    strategyIds.length ? strategyIds : normalizeBacktestStrategyIds(fallbackSettings.selectedStrategies)
  );
  return {
    id: typeof input.id === "string" && input.id ? input.id : `${Date.now()}-${securityCode || "x"}`,
    createdAt: typeof input.createdAt === "string" && input.createdAt ? input.createdAt : new Date().toISOString(),
    draft: rawDraft,
    securityCode,
    securityName: String(input.securityName || rawResult?.security?.name || securityCode || ""),
    accepted: Boolean(input.accepted || rawMetrics?.accepted),
    metrics: rawMetrics,
    strategyIds,
    benchmarkReturns:
      rawResult?.benchmarkReturns && typeof rawResult.benchmarkReturns === "object" ? rawResult.benchmarkReturns : null,
    strategyProfile,
    rawResult
  };
};

const normalizeBacktestHistory = (input: unknown, fallbackSettings: Settings): BacktestHistoryRecord[] => {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => normalizeBacktestHistoryEntry(item, fallbackSettings))
    .filter((item): item is BacktestHistoryRecord => Boolean(item))
    .slice(0, BACKTEST_HISTORY_LIMIT);
};

export const loadBacktestHistory = (fallbackSettings: Settings) => {
  try {
    const parsed = loadSafeLocalJson<unknown>(BACKTEST_HISTORY_KEY, [], isBacktestHistoryCollection);
    return normalizeBacktestHistory(parsed, fallbackSettings);
  } catch {
    return [];
  }
};

export const buildBacktestHistoryRecord = (
  draft: BacktestDraft,
  result: any,
  settings: Settings
): BacktestHistoryRecord => {
  const normalizedDraft = normalizeBacktestDraft(draft);
  const safeSettings = normalizeSettings(settings);
  const strategyIds = normalizeBacktestStrategyIds(result?.strategyIds || settings.selectedStrategies);
  const strategyProfile = normalizeBacktestStrategyProfile(
    result?.strategyProfile || result?.executionPolicy,
    safeSettings,
    normalizedDraft,
    strategyIds.length ? strategyIds : normalizeBacktestStrategyIds(safeSettings.selectedStrategies)
  );
  return {
    id: `${Date.now()}-${normalizedDraft.securityCode || "backtest"}`,
    createdAt: new Date().toISOString(),
    draft: normalizedDraft,
    securityCode: String(result?.security?.code || normalizedDraft.securityCode || ""),
    securityName: String(result?.security?.name || normalizedDraft.securityCode || ""),
    accepted: Boolean(result?.metrics?.accepted),
    metrics: result?.metrics && typeof result.metrics === "object" ? result.metrics : null,
    strategyIds,
    benchmarkReturns:
      result?.benchmarkReturns && typeof result.benchmarkReturns === "object"
        ? result.benchmarkReturns
        : null,
    strategyProfile,
    rawResult: result
  };
};

