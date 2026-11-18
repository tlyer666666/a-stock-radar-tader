import { inferSecid } from "./securityIdentifiers";
export type { StrategyBacktestRequest } from "../features/backtest/backtestTypes";

export type StrategySignalStock = Pick<Security, "code" | "name"> & {
  secid?: string | undefined; industry?: string | undefined; latest?: number | null | undefined; changePct?: number | null | undefined;
  turnover?: number | null | undefined; amount?: number | null | undefined; limitDate?: string | undefined; signalDate?: string | undefined; signalStrength?: number | null | undefined;
  daysSinceLimit?: number | null | undefined; consecutiveBoards?: number | null | undefined; reasons?: string[] | undefined; executionNotes?: string[] | undefined;
  invalidationPrice?: number | null | undefined; overheatCount?: number | null | undefined;
  matchRate?: number | null | undefined; needsConfirmation?: boolean | undefined; pendingConditions?: string[] | undefined;
};
export type StrategySignalGroup = {
  id: string; name: string; type?: string | undefined; family?: string | undefined; detail?: string | undefined; components?: string[] | undefined;
  version?: string | undefined; componentNames?: string[] | undefined; parameters?: Record<string, number> | undefined;
  sources?: Array<{ title: string; url: string }> | undefined; adaptationNote?: string | undefined;
  conditions?: string[] | undefined; dataRequirements?: string[] | undefined; scope?: string | undefined; evidenceLevel?: string | undefined;
  custom?: boolean | undefined; error?: string | undefined; universeId?: string | undefined; origin?: string | undefined;
  /** 精选：按全A历史实测挑出的较强策略，排在策略库最前面。 */
  featured?: boolean | undefined;
  stocks: StrategySignalStock[];
};
export type StrategySignalReport = {
  cacheValidUntil?: number | null | undefined;
  generatedAt?: string | undefined; asOfDate?: string | undefined; source?: string | undefined; warning?: string | undefined; universeSize?: number | undefined;
  availableUniverseSize?: number | undefined; processed?: number | undefined; failed?: number | undefined; notes?: string[] | undefined;
  watchlistCoverage?: { requested?: number | undefined; processed?: number | undefined; failed?: number | undefined; invalid?: number | undefined; stale?: number | undefined; missing?: number | undefined; benchmarkReady?: boolean | undefined; note?: string | undefined } | undefined;
  selectionDiagnostics?: { failures: Array<{ stage: string; label: string; count: number; hint: string }>; sources: Array<{ stage: string; source: string; successes: number; failures: number; reason: string }> } | undefined;
  universeCoverage?: { boards?: Array<{ label: string; expected: number | null; loaded: number; complete: boolean }> | undefined; listed?: number | undefined; eligible?: number | undefined; excludedRisk?: number | undefined; failed?: number | undefined; requestsComplete?: boolean | undefined; complete?: boolean | undefined } | undefined;
  dataQuality?: { requested?: number | undefined; processed?: number | undefined; invalid?: number | undefined; stale?: number | undefined; missing?: number | undefined; excluded?: number | undefined;
    benchmarkReady?: boolean | undefined; calendarState?: string | undefined; reasons: Record<string, number> } | undefined;
  strategies: StrategySignalGroup[];
};
const numeric = (value: unknown) => value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const counter = (value: unknown) => { const number = numeric(value); return number !== null && number >= 0 ? Math.floor(number) : undefined; };
const dateOnly = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : undefined;
const textList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
const text = (value: unknown) => typeof value === "string" && value ? value : undefined;

type RawSignalDiagnosticFailure = { stage?: unknown; label?: unknown; count?: unknown; hint?: unknown };
type RawSignalDiagnosticSource = { stage?: unknown; source?: unknown; successes?: unknown; failures?: unknown; reason?: unknown };
type RawUniverseBoardCoverage = { label?: unknown; expected?: unknown; loaded?: unknown; complete?: unknown };
type RawSignalStock = Record<string, unknown> & { quote?: Record<string, unknown> };
type RawSignalGroup = {
  id?: unknown; name?: unknown; type?: unknown; family?: unknown; detail?: unknown; description?: unknown;
  components?: unknown; version?: unknown; componentNames?: unknown; parameters?: unknown;
  sources?: unknown; adaptationNote?: unknown; conditions?: unknown; dataRequirements?: unknown;
  scope?: unknown; evidenceLevel?: unknown; custom?: unknown; error?: unknown;
  universeId?: unknown; origin?: unknown; featured?: unknown; stocks?: unknown;
};
type RawSignalReportInput = {
  strategies?: unknown; groups?: unknown; auditedStrategies?: unknown;
  generatedAt?: unknown; asOfDate?: unknown; source?: unknown; warning?: unknown;
  universeSize?: unknown; availableUniverseSize?: unknown; processed?: unknown; failed?: unknown;
  notes?: unknown; cacheValidUntil?: unknown;
  watchlistCoverage?: Record<string, unknown>;
  selectionDiagnostics?: { failures?: unknown; sources?: unknown };
  universeCoverage?: { boards?: unknown; listed?: unknown; eligible?: unknown; excludedRisk?: unknown; failed?: unknown; requestsComplete?: unknown; complete?: unknown };
  dataQuality?: { requested?: unknown; processed?: unknown; invalid?: unknown; stale?: unknown; missing?: unknown; excluded?: unknown; benchmarkReady?: unknown; calendarState?: unknown; reasons?: unknown };
};

// Keep only selection fields at the renderer boundary. Strategies are for picking
// stocks: legacy audit or historical statistics in a payload are not rendered.
export const normalizeSignalReport = (rawInput: unknown): StrategySignalReport => {
  const input: RawSignalReportInput = rawInput && typeof rawInput === "object" ? (rawInput as RawSignalReportInput) : {};
  const groups = (Array.isArray(input.strategies) ? input.strategies : Array.isArray(input.groups) ? input.groups : Array.isArray(input.auditedStrategies) ? input.auditedStrategies : []) as RawSignalGroup[];
  return {
    generatedAt: text(input.generatedAt), asOfDate: dateOnly(input.asOfDate), source: text(input.source), warning: text(input.warning),
    universeSize: numeric(input.universeSize) ?? undefined,
    availableUniverseSize: numeric(input.availableUniverseSize) ?? undefined,
    processed: numeric(input.processed) ?? undefined, failed: numeric(input.failed) ?? undefined,
    notes: textList(input.notes),
    cacheValidUntil: input.cacheValidUntil === null ? null : typeof input.cacheValidUntil === "number" && Number.isFinite(new Date(input.cacheValidUntil).getTime()) && input.cacheValidUntil > 0 ? input.cacheValidUntil : undefined,
    watchlistCoverage: input.watchlistCoverage && typeof input.watchlistCoverage === "object" ? {
      requested: counter(input.watchlistCoverage.requested), processed: counter(input.watchlistCoverage.processed),
      failed: counter(input.watchlistCoverage.failed), invalid: counter(input.watchlistCoverage.invalid),
      stale: counter(input.watchlistCoverage.stale), missing: counter(input.watchlistCoverage.missing),
      benchmarkReady: typeof input.watchlistCoverage.benchmarkReady === "boolean" ? input.watchlistCoverage.benchmarkReady : undefined, note: text(input.watchlistCoverage.note)
    } : undefined,
    selectionDiagnostics: input.selectionDiagnostics && typeof input.selectionDiagnostics === "object" ? {
      failures: (Array.isArray(input.selectionDiagnostics.failures) ? (input.selectionDiagnostics.failures as RawSignalDiagnosticFailure[]) : []).slice(0, 32)
        .filter((item) => Boolean(item) && ["history", "benchmark", "limit-pool", "universe", "watchlist-history"].includes(String(item.stage)) && (counter(item.count) ?? 0) > 0)
        .map((item) => ({ stage: String(item.stage), label: String(item.label || "原因未明确").slice(0, 80), count: counter(item.count)!, hint: String(item.hint || "数据恢复后重试").slice(0, 160) })),
      sources: (Array.isArray(input.selectionDiagnostics.sources) ? (input.selectionDiagnostics.sources as RawSignalDiagnosticSource[]) : []).slice(0, 16)
        .filter((item): item is RawSignalDiagnosticSource & { source: string } => Boolean(item) && typeof item.source === "string")
        .map((item) => ({ stage: String(item.stage || "history"), source: item.source.slice(0, 80), successes: counter(item.successes) ?? 0, failures: counter(item.failures) ?? 0, reason: String(item.reason || "").slice(0, 80) }))
    } : undefined,
    universeCoverage: input.universeCoverage && typeof input.universeCoverage === "object" ? {
      boards: (Array.isArray(input.universeCoverage.boards) ? (input.universeCoverage.boards as RawUniverseBoardCoverage[]) : []).slice(0, 8)
        .map((board) => ({ label: String(board?.label || "").slice(0, 20), expected: counter(board?.expected) ?? null, loaded: counter(board?.loaded) ?? 0, complete: board?.complete === true })),
      listed: counter(input.universeCoverage.listed), eligible: counter(input.universeCoverage.eligible), excludedRisk: counter(input.universeCoverage.excludedRisk),
      failed: counter(input.universeCoverage.failed),
      requestsComplete: typeof input.universeCoverage.requestsComplete === "boolean" ? input.universeCoverage.requestsComplete : undefined,
      complete: typeof input.universeCoverage.complete === "boolean" ? input.universeCoverage.complete : undefined
    } : undefined,
    dataQuality: input.dataQuality && typeof input.dataQuality === "object" ? {
      requested: counter(input.dataQuality.requested), processed: counter(input.dataQuality.processed), invalid: counter(input.dataQuality.invalid),
      stale: counter(input.dataQuality.stale), missing: counter(input.dataQuality.missing), excluded: counter(input.dataQuality.excluded),
      benchmarkReady: typeof input.dataQuality.benchmarkReady === "boolean" ? input.dataQuality.benchmarkReady : undefined,
      calendarState: typeof input.dataQuality.calendarState === "string" ? input.dataQuality.calendarState : undefined,
      reasons: Object.fromEntries(Object.entries((input.dataQuality.reasons as Record<string, unknown>) || {}).filter(([, value]) => counter(value) !== undefined).map(([key, value]) => [key, counter(value)!]))
    } : undefined,
    strategies: groups.map((group): StrategySignalGroup => ({
      id: String(group.id), name: String(group.name), type: text(group.type), family: text(group.family),
      detail: String(group.detail || group.description || ""), components: Array.isArray(group.components) ? (group.components as string[]) : [],
      version: text(group.version), componentNames: Array.isArray(group.componentNames) ? (group.componentNames as string[]) : undefined, parameters: (group.parameters && typeof group.parameters === "object" ? group.parameters as Record<string, number> : undefined),
      sources: Array.isArray(group.sources) ? (group.sources as Array<{ title: string; url: string }>) : undefined, adaptationNote: text(group.adaptationNote),
      conditions: textList(group.conditions), dataRequirements: textList(group.dataRequirements),
      scope: typeof group.scope === "string" ? group.scope : undefined, evidenceLevel: typeof group.evidenceLevel === "string" ? group.evidenceLevel : undefined,
      custom: group.custom === true || group.type === "custom", error: text(group.error), universeId: text(group.universeId), origin: text(group.origin),
      featured: group.featured === true,
      stocks: (Array.isArray(group.stocks) ? (group.stocks as RawSignalStock[]) : []).map((stock): StrategySignalStock => {
        const code = String(stock.code);
        return {
          code, name: String(stock.name || stock.code), industry: text(stock.industry),
          secid: typeof stock.secid === "string" && /^[01]\.\d{6}$/.test(stock.secid) ? stock.secid : inferSecid(code),
          latest: numeric(stock.latest ?? stock.quote?.latest), changePct: numeric(stock.changePct ?? stock.quote?.changePct),
          turnover: numeric(stock.turnover ?? stock.quote?.turnover), amount: numeric(stock.amount ?? stock.quote?.amount),
          limitDate: text(stock.limitDate), signalDate: text(stock.signalDate),
          signalStrength: numeric(stock.signalStrength ?? stock.signalScore),
          daysSinceLimit: counter(stock.daysSinceLimit) ?? null, consecutiveBoards: counter(stock.consecutiveBoards) ?? null,
          reasons: textList(stock.reasons), executionNotes: textList(stock.executionNotes),
          invalidationPrice: numeric(stock.invalidationPrice), overheatCount: counter(stock.overheatCount) ?? null,
          matchRate: numeric(stock.matchRate), needsConfirmation: stock.needsConfirmation === true, pendingConditions: textList(stock.pendingConditions)
        };
      }).sort((left: StrategySignalStock, right: StrategySignalStock) => (right.signalStrength ?? -1) - (left.signalStrength ?? -1) || left.code.localeCompare(right.code))
    }))
  };
};
/** 默认打开精选策略里本轮选出最多的一条；没有精选时按选出数量。 */
export const defaultStrategyId = (groups: StrategySignalGroup[]) => [...groups].sort((a, b) => Number(b.featured === true) - Number(a.featured === true) || b.stocks.length - a.stocks.length)[0]?.id || "";
export const filterSignalGroups = (groups: StrategySignalGroup[], query: string, sort: string, family: string, hideEmpty = false, keepId = "") => {
  const rows = groups.filter(group => (!hideEmpty || group.stocks.length > 0 || group.id === keepId) && (family === "all" || group.family === family) && [group.name, group.detail || "", ...(group.conditions || []), ...(group.componentNames || [])].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  if (sort === "picks") return [...rows].sort((a, b) => b.stocks.length - a.stocks.length);
  return rows;
};
export const strategyStockDisplayModel = (group?: StrategySignalGroup) => ({
  title: group?.stocks.length ? "本策略选出的股票" : "本轮未选出股票",
  subtitle: `按既定规则选出 ${group?.stocks.length || 0} 只，按排序分降序排列（排序分越高，信号当天越不过热；不是胜率）`,
  stocks: group?.stocks || []
});

export type StockSummaryRow = StrategySignalStock & { strategies: Array<{ id: string; name: string; family?: string | undefined; featured?: boolean | undefined }>; familyCount: number; featuredCount: number };
/**
 * One row per stock across all strategies; family count de-duplicates same-shape rules.
 * 排序：命中精选策略多的在前（精选是全A实测较强的规则），再按形态家族数、策略数、排序分。
 * 「AI 选股」的 40 只候选也按这个顺序取。
 */
export const summarizeStocksAcrossStrategies = (groups: StrategySignalGroup[]): StockSummaryRow[] => {
  const byCode = new Map<string, StockSummaryRow>();
  for (const group of groups) for (const stock of group.stocks) {
    const row = byCode.get(stock.code) || { ...stock, strategies: [], familyCount: 0, featuredCount: 0 };
    if ((stock.signalStrength ?? -1) > (row.signalStrength ?? -1)) Object.assign(row, { ...stock, strategies: row.strategies, familyCount: row.familyCount, featuredCount: row.featuredCount });
    row.strategies.push({ id: group.id, name: group.name, family: group.family, featured: group.featured === true });
    byCode.set(stock.code, row);
  }
  return [...byCode.values()].map(row => ({ ...row, familyCount: new Set(row.strategies.map(item => item.family || item.id)).size, featuredCount: row.strategies.filter(item => item.featured).length }))
    .sort((a, b) => b.featuredCount - a.featuredCount || b.familyCount - a.familyCount || b.strategies.length - a.strategies.length || (b.signalStrength ?? -1) - (a.signalStrength ?? -1) || a.code.localeCompare(b.code));
};
