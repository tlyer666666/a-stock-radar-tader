import { useSelectionQuotes } from "./features/strategy-selection/useSelectionQuotes";
import { SelectionQuotePrice, SelectionQuoteLiquidity, SelectionQuoteControls } from "./features/strategy-selection/SelectionQuoteCells";
import { SelectionKline } from "./features/strategy-selection/SelectionKline";
import { Activity, Bot, Check, ChevronRight, CircleAlert, Clock3, Copy, Layers, LoaderCircle, Pencil, Plus, RefreshCw, Target, Trash2 } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, type ConfirmDialogRequest } from "./components/terminal/ConfirmDialog";
import { CustomStrategyEditor } from "./features/strategy-selection/CustomStrategyEditor";
import { CUSTOM_CATALOG, copyCustomStrategy, describeCustomStrategy, emptyCustomStrategy, ipcMessage, type CustomStrategy, type PatternOption } from "./features/strategy-selection/customStrategyModel";
import { TREND_STRATEGY_CHOICES } from "./trendStrategyConfig";
import type { TrendStrategyId } from "./trendScreenerTypes";
import { createServiceJobScope } from "./serviceJobClient";
import { selectionDataState, selectionSummaryDataState, type SelectionDataState } from "./strategySelectionDataState";
import { whenVisible } from "./visiblePolling";
import { formatShanghaiDateTime } from "./dateUtils";
import { aiScoreMap, buildAiPicks, ratingTone, sortByAiScore } from "./features/strategy-selection/aiSelectionModel";
import { getSelectionReport, setSelectionReport, takePendingStrategyText } from "./features/strategy-selection/selectionReportStore";
export type { StrategyBacktestRequest } from "./features/backtest/backtestTypes";

export type StrategySignalStock = Pick<Security, "code" | "name"> & {
  secid?: string; industry?: string; latest?: number | null; changePct?: number | null;
  turnover?: number | null; amount?: number | null; limitDate?: string; signalDate?: string; signalStrength?: number | null;
  daysSinceLimit?: number | null; consecutiveBoards?: number | null; reasons?: string[]; executionNotes?: string[];
  invalidationPrice?: number | null; overheatCount?: number | null;
  matchRate?: number | null; needsConfirmation?: boolean; pendingConditions?: string[];
};
export type StrategySignalGroup = {
  id: string; name: string; type?: string; family?: string; detail?: string; components?: string[];
  version?: string; componentNames?: string[]; parameters?: Record<string, number>;
  sources?: Array<{ title: string; url: string }>; adaptationNote?: string;
  conditions?: string[]; dataRequirements?: string[]; scope?: string; evidenceLevel?: string;
  custom?: boolean; error?: string | undefined; universeId?: string | undefined; origin?: string | undefined;
  /** 精选：按全A历史实测挑出的较强策略，排在策略库最前面。 */
  featured?: boolean;
  stocks: StrategySignalStock[];
};
export type StrategySignalReport = {
  cacheValidUntil?: number | null | undefined;
  generatedAt?: string; asOfDate?: string | undefined; source?: string; warning?: string; universeSize?: number | undefined;
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
const composite = (group: StrategySignalGroup) => group.type === "composite" || Boolean(group.components?.length);
const families = [["all", "全部"], ["bottom_trend", "底部趋势"], ["youzi", "游资打法"], ["first_board", "首板"], ["relay", "接力"], ["breakout", "突破"], ["pullback", "回踩"], ["contraction", "收缩"], ["repair", "修复"]];
const familyLabel = { ...Object.fromEntries(families), custom: "我的策略" } as Record<string, string>;
const rememberedPages = new Map<string, number>();
let rememberedStrategyId = "";
let rememberedMode: "strategy" | "stock" = "strategy";
let rememberedHideEmpty = true;
let rememberedFeaturedOnly = true;

/** 复制本列表全部股票代码（每行一个），方便粘贴到同花顺等软件的自选股。 */
export function CopyCodesButton({ codes }: { codes: string[] }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => { if (state === "idle") return; const timer = window.setTimeout(() => setState("idle"), 2000); return () => window.clearTimeout(timer); }, [state]);
  if (!codes.length) return null;
  const copy = async () => {
    const text = codes.join("\n");
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else { const area = document.createElement("textarea"); area.value = text; document.body.appendChild(area); area.select(); const ok = document.execCommand("copy"); area.remove(); if (!ok) throw new Error("copy failed"); }
      setState("done");
    } catch { setState("failed"); }
  };
  return <button type="button" className="secondary-btn strategy-copy-codes" onClick={() => void copy()} title="复制全部股票代码（每行一个），可粘贴到同花顺等软件导入自选">
    {state === "done" ? <Check size={15} /> : <Copy size={15} />}{state === "done" ? `已复制 ${codes.length} 只` : state === "failed" ? "复制失败" : `复制代码（${codes.length}）`}</button>;
}

// Keep only selection fields at the renderer boundary. Strategies are for picking
// stocks: legacy audit or historical statistics in a payload are not rendered.
export const normalizeSignalReport = (input: any): StrategySignalReport => {
  const groups = Array.isArray(input?.strategies) ? input.strategies : Array.isArray(input?.groups) ? input.groups : Array.isArray(input?.auditedStrategies) ? input.auditedStrategies : [];
  return {
    generatedAt: input?.generatedAt, asOfDate: dateOnly(input?.asOfDate), source: input?.source, warning: input?.warning,
    universeSize: numeric(input?.universeSize) ?? undefined,
    availableUniverseSize: numeric(input?.availableUniverseSize) ?? undefined,
    processed: numeric(input?.processed) ?? undefined, failed: numeric(input?.failed) ?? undefined,
    notes: textList(input?.notes),
    cacheValidUntil: input?.cacheValidUntil === null ? null : typeof input?.cacheValidUntil === "number" && Number.isFinite(new Date(input.cacheValidUntil).getTime()) && input.cacheValidUntil > 0 ? input.cacheValidUntil : undefined,
    watchlistCoverage: input?.watchlistCoverage && typeof input.watchlistCoverage === "object" ? {
      requested: counter(input.watchlistCoverage.requested), processed: counter(input.watchlistCoverage.processed),
      failed: counter(input.watchlistCoverage.failed), invalid: counter(input.watchlistCoverage.invalid),
      stale: counter(input.watchlistCoverage.stale), missing: counter(input.watchlistCoverage.missing),
      benchmarkReady: typeof input.watchlistCoverage.benchmarkReady === "boolean" ? input.watchlistCoverage.benchmarkReady : undefined, note: text(input.watchlistCoverage.note)
    } : undefined,
    selectionDiagnostics: input?.selectionDiagnostics && typeof input.selectionDiagnostics === "object" ? {
      failures: (Array.isArray(input.selectionDiagnostics.failures) ? input.selectionDiagnostics.failures : []).slice(0, 32)
        .filter((item: any) => item && ["history", "benchmark", "limit-pool", "universe", "watchlist-history"].includes(item.stage) && (counter(item.count) ?? 0) > 0)
        .map((item: any) => ({ stage: String(item.stage), label: String(item.label || "原因未明确").slice(0, 80), count: counter(item.count)!, hint: String(item.hint || "数据恢复后重试").slice(0, 160) })),
      sources: (Array.isArray(input.selectionDiagnostics.sources) ? input.selectionDiagnostics.sources : []).slice(0, 16)
        .filter((item: any) => item && typeof item.source === "string")
        .map((item: any) => ({ stage: String(item.stage || "history"), source: item.source.slice(0, 80), successes: counter(item.successes) ?? 0, failures: counter(item.failures) ?? 0, reason: String(item.reason || "").slice(0, 80) }))
    } : undefined,
    universeCoverage: input?.universeCoverage && typeof input.universeCoverage === "object" ? {
      boards: (Array.isArray(input.universeCoverage.boards) ? input.universeCoverage.boards : []).slice(0, 8)
        .map((board: any) => ({ label: String(board?.label || "").slice(0, 20), expected: counter(board?.expected) ?? null, loaded: counter(board?.loaded) ?? 0, complete: board?.complete === true })),
      listed: counter(input.universeCoverage.listed), eligible: counter(input.universeCoverage.eligible), excludedRisk: counter(input.universeCoverage.excludedRisk),
      failed: counter(input.universeCoverage.failed),
      requestsComplete: typeof input.universeCoverage.requestsComplete === "boolean" ? input.universeCoverage.requestsComplete : undefined,
      complete: typeof input.universeCoverage.complete === "boolean" ? input.universeCoverage.complete : undefined
    } : undefined,
    dataQuality: input?.dataQuality && typeof input.dataQuality === "object" ? {
      requested: counter(input.dataQuality.requested), processed: counter(input.dataQuality.processed), invalid: counter(input.dataQuality.invalid),
      stale: counter(input.dataQuality.stale), missing: counter(input.dataQuality.missing), excluded: counter(input.dataQuality.excluded),
      benchmarkReady: typeof input.dataQuality.benchmarkReady === "boolean" ? input.dataQuality.benchmarkReady : undefined,
      calendarState: typeof input.dataQuality.calendarState === "string" ? input.dataQuality.calendarState : undefined,
      reasons: Object.fromEntries(Object.entries(input.dataQuality.reasons || {}).filter(([, value]) => counter(value) !== undefined).map(([key, value]) => [key, counter(value)!]))
    } : undefined,
    strategies: groups.map((group: any): StrategySignalGroup => ({
      id: String(group.id), name: String(group.name), type: group.type, family: group.family,
      detail: String(group.detail || group.description || ""), components: group.components || [],
      version: group.version, componentNames: group.componentNames, parameters: group.parameters,
      sources: group.sources, adaptationNote: group.adaptationNote,
      conditions: textList(group.conditions), dataRequirements: textList(group.dataRequirements),
      scope: typeof group.scope === "string" ? group.scope : undefined, evidenceLevel: typeof group.evidenceLevel === "string" ? group.evidenceLevel : undefined,
      custom: group.custom === true || group.type === "custom", error: text(group.error), universeId: text(group.universeId), origin: text(group.origin),
      featured: group.featured === true,
      stocks: (Array.isArray(group.stocks) ? group.stocks : []).map((stock: any): StrategySignalStock => {
        const code = String(stock.code);
        return {
          code, name: String(stock.name || stock.code), industry: stock.industry,
          secid: typeof stock.secid === "string" && /^[01]\.\d{6}$/.test(stock.secid) ? stock.secid : `${code.startsWith("6") ? "1" : "0"}.${code}`,
          latest: numeric(stock.latest ?? stock.quote?.latest), changePct: numeric(stock.changePct ?? stock.quote?.changePct),
          turnover: numeric(stock.turnover ?? stock.quote?.turnover), amount: numeric(stock.amount ?? stock.quote?.amount),
          limitDate: stock.limitDate, signalDate: stock.signalDate,
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

const toSecurity = (stock: StrategySignalStock): Security => ({ code: stock.code, name: stock.name, secid: stock.secid || `${stock.code.startsWith("6") ? "1" : "0"}.${stock.code}`, assetType: "stock" });
const invalidation = (stock: StrategySignalStock) => {
  if (!stock.invalidationPrice) return null;
  const distance = stock.latest ? (stock.invalidationPrice / stock.latest - 1) * 100 : null;
  return `失效位 ${stock.invalidationPrice.toFixed(2)}${distance === null ? "" : `（较选股收盘 ${distance.toFixed(1)}%）`}`;
};
const stockNotes = (stock: StrategySignalStock) => [
  ...(stock.pendingConditions?.length ? [`${stock.needsConfirmation ? "待确认" : "另需核对"}：${stock.pendingConditions.join("、")}`] : []),
  ...(stock.executionNotes || [])];
const limitAge = (stock: StrategySignalStock) => stock.limitDate ? `${stock.limitDate}${stock.daysSinceLimit !== null && stock.daysSinceLimit !== undefined ? ` · T+${stock.daysSinceLimit}` : ""}` : stock.signalDate || "--";

export function StrategyRuleSources({ group }: { group: Pick<StrategySignalGroup, "version" | "sources" | "parameters" | "adaptationNote"> }) {
  const labels: Record<string, string> = {
    marketCalendarLookback: "指数日期对齐", recentLimitSessions: "涨停回看", maFast: "短均线", maMiddle: "承接均线",
    maTrend: "趋势均线", maLong: "长均线", maxMa20ExtensionPercent: "MA20最大偏离(%)",
    fastPeriod: "MACD快周期", slowPeriod: "MACD慢周期", signalPeriod: "MACD信号周期",
    bollPeriod: "布林周期", bollMultiplier: "标准差倍数", widthLookback: "带宽回看",
    breakoutPeriod: "突破回看", dmiPeriod: "DMI周期", adxPeriod: "ADX均值周期", adxThreshold: "ADX门槛",
    rsvPeriod: "RSV周期", kPeriod: "K平滑周期", dPeriod: "D平滑周期", maxK: "K上限",
    minVolumeRatio: "最低量比", maxVolumeRatio: "最高量比"
  };
  return <>
    {!!group.sources?.length && <div className="strategy-rule-field conditions">
      <span>公式来源与适配 · {group.version}</span>
      <div>
        {group.sources.map(source => <button key={source.url} className="secondary-btn" type="button"
          onClick={() => void window.stockApi.openExternal(source.url)} title={source.url}>{source.title}</button>)}
        <p>{group.adaptationNote}</p>
      </div>
    </div>}
    {!!Object.keys(group.parameters || {}).length && <div className="strategy-rule-field components">
      <span>固定参数</span>
      <div>{Object.entries(group.parameters || {}).map(([key, value]) => <em key={key}>{labels[key] || key}：{value}</em>)}</div>
    </div>}
  </>;
}

export function StrategySelectionRules({ group }: { group: StrategySignalGroup }) {
  return <details className="panel signal-rule-details"><summary>选股条件</summary>
    <div className={`strategy-rule-panel ${composite(group) ? "composite" : ""}`}>
      <div className="strategy-rule-field conditions"><span>必要条件 · v{group.version || "版本未提供"}</span>
        {group.conditions?.length ? <ul>{group.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul> : <p>{group.detail || "条件说明未提供"}</p>}</div>
      <div className="strategy-rule-field conditions"><span>数据要求</span>
        {group.dataRequirements?.length ? <ul>{group.dataRequirements.map((requirement, index) => <li key={index}>{requirement}</li>)}</ul> : <p>按本策略必要行情窗口计算</p>}</div>
      <div className="strategy-rule-field"><span>筛选范围</span><p>{group.scope || "全市场A股（剔除ST，含北交所）"}</p></div>
      {group.evidenceLevel && <div className="strategy-rule-field"><span>规则属性</span><p>{group.evidenceLevel}</p></div>}
      <StrategyRuleSources group={group} />
    </div>
  </details>;
}

export function StrategySelectionCoverage({ report, previous = false }: { report: StrategySignalReport; previous?: boolean }) {
  const coverage = report.universeCoverage, quality = report.dataQuality;
  // excluded 是已确认的资格排除；无效/陈旧/缺失日线须明确提示覆盖缺口。
  const issues = [quality?.invalid ? `${quality.invalid} 只股票日线无效` : "",
    quality?.stale ? `${quality.stale} 只股票日线陈旧` : "", quality?.missing ? `${quality.missing} 只股票日线缺失` : "",
    quality?.benchmarkReady === false ? "基准行情未就绪" : "",
    quality?.calendarState === "unknown" ? "完整交易日未知" : "", coverage?.complete === false ? "部分板块股票名单读取不完整" : "",
    report.failed ? `${report.failed} 只股票日线读取失败` : ""].filter(Boolean);
  const disclosures = [...(report.notes || [])].filter(Boolean);
  const boards = coverage?.boards?.length ? coverage.boards.map(board => `${board.label} ${board.loaded}${board.complete ? "" : "（不完整）"}`).join("、") : "";
  const updated = report.generatedAt && Number.isFinite(Date.parse(report.generatedAt)) ? new Date(report.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "未提供";
  return <>
    {!!issues.length && <div className="warning-banner" role="status"><CircleAlert size={17} /><span>{issues.join("；")}。异常或陈旧证券不计入本轮新命中。</span></div>}
    <div className="strategy-method-note"><Clock3 size={16} /><span>
      {previous ? "上轮数据日" : "数据日"}：{report.asOfDate || "未提供"}；更新时间：{updated}。
      选股范围：全市场A股（剔除 ST、*ST 与退市整理，含北交所），共 {report.universeSize ?? "--"} 只，已完成计算 {report.processed ?? "--"} 只。
      {boards ? `名单：${boards}。` : ""}
      {report.watchlistCoverage && <>自选与持仓股票池：已处理 {report.watchlistCoverage.processed ?? "--"} / {report.watchlistCoverage.requested ?? "--"} 只，读取失败 {report.watchlistCoverage.failed ?? 0} 只。{report.watchlistCoverage.note || ""}</>}
      数据：{report.source || "公开行情"}。
      {!!disclosures.length && <span className="strategy-data-notes">数据说明：{disclosures.join(" ")}</span>}
    </span></div>
    {!!report.selectionDiagnostics?.failures.length && <details className="panel strategy-selection-diagnostics">
      <summary>行情失败诊断 · {previous ? "上轮" : "本轮"}请求</summary>
      <p>以下为本轮请求的失败分类，次数可能跨阶段重复；未明确的原因保持未知，不将失败记作策略未命中。</p>
      <div role="region" tabIndex={0} aria-label="行情失败分类表，可横向滚动"><table>
        <thead><tr><th scope="col">阶段</th><th scope="col">原因分类</th><th scope="col">次数</th><th scope="col">处理建议</th></tr></thead>
        <tbody>{report.selectionDiagnostics.failures.map((item, index) => <tr key={`${item.stage}:${item.label}:${index}`}><th scope="row">{{ "limit-pool": "涨停池", universe: "全市场名单", history: "个股日线", benchmark: "基准指数", "watchlist-history": "自选与持仓日线" }[item.stage] || "行情"}</th><td>{item.label}</td><td>{item.count}</td><td>{item.hint}</td></tr>)}</tbody>
      </table></div>
      {!!report.selectionDiagnostics.sources.length && <ul>{report.selectionDiagnostics.sources.map((item, index) => <li key={`${item.source}:${index}`}>{item.source} · {item.stage === "benchmark" ? "基准指数" : "日线"}：成功 {item.successes} 次，失败 {item.failures} 次{item.reason ? `；最近失败分类：${item.reason}` : ""}</li>)}</ul>}
    </details>}
  </>;
}

function usePage(key: string, total: number) {
  const [requestedPage, setPage] = useState(() => rememberedPages.get(key) || 1);
  const totalPages = Math.max(1, Math.ceil(total / 20));
  const page = Math.min(requestedPage, totalPages);
  // 结果变少时把页码真正收回到末页，避免之后结果变多时又跳回已失效的旧页码。
  useEffect(() => { if (requestedPage > totalPages) { rememberedPages.set(key, totalPages); setPage(totalPages); } }, [key, requestedPage, totalPages]);
  const go = (next: number) => { rememberedPages.set(key, next); setPage(next); };
  return { page, totalPages, go };
}

function Pagination({ total, page, totalPages, go, label }: { total: number; page: number; totalPages: number; go: (page: number) => void; label: string }) {
  return <div className="strategy-stock-pagination" aria-label={label}><span role="status" aria-live="polite">共 {total} 只 · 每页 20 只 · 第 {page} / {totalPages} 页</span><button className="secondary-btn" disabled={page === 1} onClick={() => go(page - 1)}>上一页</button><button className="secondary-btn" disabled={page === totalPages} onClick={() => go(page + 1)}>下一页</button></div>;
}

const stockIdentity = (stock: StrategySignalStock, onOpen?: (security: Security) => void) => <>
  {onOpen ? <button type="button" className="strategy-security-link" onClick={event => { event.stopPropagation(); onOpen(toSecurity(stock)); }} aria-label={`查看 ${stock.name} ${stock.code} 个股分析`}><b>{stock.name}</b><small>{stock.code}</small></button> : <><b>{stock.name}</b><small>{stock.code}</small></>}
</>;

const aiBadge = (item: AiRankItem | undefined) => item ? <span className={`ai-score-badge ${ratingTone(item.rating)}`} title={[item.scores && item.scores.length > 1 ? `各模型：${item.scores.map(score => `${score.name} ${score.score}`).join("、")}` : "", item.highlights && `看点：${item.highlights}`, item.risks && `风险：${item.risks}`, item.nextDay && `次日：${item.nextDay}`].filter(Boolean).join("\n")}>AI {item.score} · {item.rating}{item.disagreement ? " · 分歧" : ""}</span> : null;

const signalTableColumns = ["股票 / 命中依据", "日K走势", "行情 / 换手 / 成交额", "涨停日 / 失效位", "排序分"];
const summaryTableColumns = ["股票", "日K走势", "行情 / 换手 / 成交额", "涨停日 / 天数", "形态家族 / 命中策略"];

/** 次日注意（1.6.47）：放在股票行下方横跨整张表，文字完整显示，不再被横向滚动截掉。 */
function StockNotesRow({ notes, pending, colSpan, onClick }: { notes: string[]; pending?: boolean | undefined; colSpan: number; onClick?: (() => void) | undefined }) {
  if (!notes.length) return null;
  return <tr className={`strategy-notes-row${onClick ? " clickable" : ""}`} onClick={onClick}><td colSpan={colSpan} className={`strategy-stock-notes ${pending ? "pending" : ""}`}><b>次日注意</b>{notes.join("；")}</td></tr>;
}
function StrategyTableHead({ columns }: { columns: string[] }) {
  return <><colgroup>{columns.map((label, index) => <col key={label} className={`strategy-result-col-${index}`} />)}</colgroup><thead><tr>{columns.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead></>;
}

export const StrategyStockPanel = memo(function StrategyStockPanel({ group, onOpen, dataState, live = true, quoteRefreshSeconds = 15, aiScores }: { live?: boolean; quoteRefreshSeconds?: number; group: StrategySignalGroup; onOpen?: ((security: Security) => void) | undefined; dataState?: SelectionDataState | undefined; aiScores?: Map<string, AiRankItem> | undefined }) {
  const stocks = group.stocks;
  const { page, totalPages, go } = usePage(`strategy:${group.id}`, stocks.length);
  const pageStocks = stocks.slice((page - 1) * 20, page * 20);
  const quotes = useSelectionQuotes(pageStocks.map(toSecurity), live, quoteRefreshSeconds);
  const display = strategyStockDisplayModel(group);
  const blocked = !stocks.length && (dataState?.state === "unavailable" || dataState?.state === "empty-universe");
  return <section className="panel strategy-stock-panel" aria-label="策略股票候选">
    <div className="strategy-stock-panel-title"><div><Target size={18} /><span><b>{blocked ? dataState.title : display.title}</b><small>{!stocks.length && dataState ? dataState.description : display.subtitle}{onOpen && stocks.length ? "；点击股票查看个股分析" : ""}</small></span></div><span className="strategy-stock-panel-tools"><CopyCodesButton codes={stocks.map(stock => stock.code)} /><em>{blocked ? "待完成" : `${stocks.length} 只`}</em></span></div>
    <SelectionQuoteControls total={pageStocks.length} loading={quotes.loading} live={live} seconds={quotes.refreshSeconds} failed={Object.values(quotes.entries).filter(entry => entry.error).length} onRefresh={quotes.refresh} />
    <div className="strategy-stock-table" tabIndex={0} role="region" aria-label="策略候选表格，可横向滚动">
      <table className="strategy-result-table" aria-label={`${group.name}选股结果`}>
        <StrategyTableHead columns={group.custom ? signalTableColumns.map(label => label === "排序分" ? "匹配度" : label) : signalTableColumns} />
        {pageStocks.map(stock => { const notes = stockNotes(stock); const openStock = onOpen ? () => onOpen(toSecurity(stock)) : undefined; return <tbody key={stock.code} className="strategy-stock-group"><tr className={`${onOpen ? "clickable" : ""}${notes.length ? " has-notes" : ""}`} onClick={openStock}>
          <th scope="row" className="strategy-stock-name">{stockIdentity(stock, onOpen)}{aiBadge(aiScores?.get(stock.code))}{!!stock.reasons?.length && <small className="strategy-stock-reasons">{stock.reasons.join(" · ")}</small>}</th>
          <td><SelectionKline security={toSecurity(stock)} signalDate={stock.signalDate} /></td>
          <td className="strategy-stock-quote"><SelectionQuotePrice entry={quotes.entries[stock.code]} selectionClose={stock.latest} /><div className="strategy-stock-liquidity"><SelectionQuoteLiquidity entry={quotes.entries[stock.code]} /></div></td>
          <td className="strategy-stock-limit">{limitAge(stock)}{invalidation(stock) && <small className="strategy-stock-reasons" title="依据本策略的支撑规则计算；具体失效条件见右侧“次日注意”">{invalidation(stock)}</small>}</td>
          <td>{stock.matchRate !== null && stock.matchRate !== undefined ? <>{stock.matchRate}%<small className="strategy-stock-reasons">排序分 {stock.signalStrength ?? "--"}</small></> : <>{stock.signalStrength ?? "--"}{stock.overheatCount !== null && stock.overheatCount !== undefined && <small className="strategy-stock-reasons">过热 {stock.overheatCount} 项</small>}</>}</td>
        </tr><StockNotesRow notes={notes} pending={stock.needsConfirmation} colSpan={5} onClick={openStock} /></tbody>; })}
      </table>
      {!stocks.length && <div className="strategy-stock-empty"><Target size={28} /><b>{dataState?.title || "本轮未选出股票"}</b><p>{dataState?.description || "全市场（剔除ST）中当前没有股票同时满足本策略条件。"}</p></div>}
    </div>
    {!!stocks.length && <Pagination total={stocks.length} page={page} totalPages={totalPages} go={go} label="策略候选分页" />}
  </section>;
});

let rememberedAiSort = true;
export const StrategyStockSummaryPanel = memo(function StrategyStockSummaryPanel({ groups, onOpen, onStrategy, dataState, live = true, quoteRefreshSeconds = 15, aiScores }: { live?: boolean; quoteRefreshSeconds?: number; groups: StrategySignalGroup[]; onOpen?: ((security: Security) => void) | undefined; onStrategy?: ((id: string) => void) | undefined; dataState?: SelectionDataState | undefined; aiScores?: Map<string, AiRankItem> | undefined }) {
  const [aiSort, setAiSort] = useState(rememberedAiSort);
  const [featuredOnly, setFeaturedOnly] = useState(rememberedFeaturedOnly);
  const hasAi = Boolean(aiScores?.size);
  // 默认只汇总精选策略（加上我的策略），避免较弱策略的候选把列表撑长；可切换为全部策略。
  const hasFeatured = groups.some(group => group.featured);
  const shownGroups = useMemo(() => featuredOnly && hasFeatured ? groups.filter(group => group.featured || group.custom) : groups, [groups, featuredOnly, hasFeatured]);
  const baseRows = useMemo(() => summarizeStocksAcrossStrategies(shownGroups), [shownGroups]);
  const rows = useMemo(() => hasAi && aiSort && aiScores ? sortByAiScore(baseRows, aiScores) : baseRows, [baseRows, hasAi, aiSort, aiScores]);
  const { page, totalPages, go } = usePage("summary", rows.length);
  const pageStocks = rows.slice((page - 1) * 20, page * 20);
  const quotes = useSelectionQuotes(pageStocks.map(toSecurity), live, quoteRefreshSeconds);
  return <section className="panel strategy-stock-panel strategy-stock-summary" aria-label="按股票汇总">
    <div className="strategy-stock-panel-title"><div><Layers size={18} /><span><b>按股票汇总</b><small>{hasAi && aiSort ? "按 AI 分降序（未评估的股票排在后面）" : "命中精选策略的在前；同一形态家族的多条策略只算一类，再按命中家族数、策略数、排序分降序"}</small></span></div><span className="strategy-stock-panel-tools">{hasFeatured && <span className="strategy-scope-switch" role="group" aria-label="汇总范围"><button type="button" aria-pressed={featuredOnly} onClick={() => { rememberedFeaturedOnly = true; setFeaturedOnly(true); }}>精选策略</button><button type="button" aria-pressed={!featuredOnly} onClick={() => { rememberedFeaturedOnly = false; setFeaturedOnly(false); }}>全部策略</button></span>}{hasAi && <button type="button" className="secondary-btn ai-sort-toggle" aria-pressed={aiSort} onClick={() => { rememberedAiSort = !aiSort; setAiSort(!aiSort); }}>{aiSort ? "改按命中数排序" : "按 AI 分排序"}</button>}<CopyCodesButton codes={rows.map(stock => stock.code)} /><em>{!rows.length && dataState?.state === "unavailable" ? "待完成" : `${rows.length} 只`}</em></span></div>
    <SelectionQuoteControls total={pageStocks.length} loading={quotes.loading} live={live} seconds={quotes.refreshSeconds} failed={Object.values(quotes.entries).filter(entry => entry.error).length} onRefresh={quotes.refresh} />
    <div className="strategy-stock-table" tabIndex={0} role="region" aria-label="股票汇总表格，可横向滚动">
      <table className="strategy-result-table strategy-summary-table" aria-label="各策略选股按股票汇总">
        <StrategyTableHead columns={summaryTableColumns} />
        {pageStocks.map(stock => { const notes = stockNotes(stock); const openStock = onOpen ? () => onOpen(toSecurity(stock)) : undefined; return <tbody key={stock.code} className="strategy-stock-group"><tr className={`${onOpen ? "clickable" : ""}${notes.length ? " has-notes" : ""}`} onClick={openStock}>
          <th scope="row" className="strategy-stock-name">{stockIdentity(stock, onOpen)}{aiBadge(aiScores?.get(stock.code))}</th>
          <td><SelectionKline security={toSecurity(stock)} signalDate={stock.signalDate} /></td>
          <td className="strategy-stock-quote"><SelectionQuotePrice entry={quotes.entries[stock.code]} selectionClose={stock.latest} /><div className="strategy-stock-liquidity"><SelectionQuoteLiquidity entry={quotes.entries[stock.code]} /></div></td>
          <td>{limitAge(stock)}</td>
          <td><small className="strategy-stock-reasons strategy-family-line">{stock.familyCount} 类：{[...new Set(stock.strategies.map(item => familyLabel[item.family || ""] || "其他"))].join("、")}</small><div className="strategy-hit-chips">{stock.strategies.slice(0, 3).map(item => onStrategy ? <button key={item.id} type="button" className="strategy-hit-chip" onClick={event => { event.stopPropagation(); onStrategy(item.id); }}>{item.name}</button> : <span key={item.id}>{item.name}</span>)}{stock.strategies.length > 3 && <small>+{stock.strategies.length - 3}</small>}</div></td>
        </tr><StockNotesRow notes={notes} colSpan={5} onClick={openStock} /></tbody>; })}
      </table>
      {!rows.length && <div className="strategy-stock-empty"><Target size={28} /><b>{dataState?.title || "本轮未选出股票"}</b>{dataState && <p>{dataState.description}</p>}</div>}
    </div>
    {!!rows.length && <Pagination total={rows.length} page={page} totalPages={totalPages} go={go} label="汇总分页" />}
  </section>;
});

/** Custom strategy rules: the user's own conditions in plain language. */
export function CustomStrategyRules({ strategy, group, patterns }: { strategy: CustomStrategy; group?: StrategySignalGroup | undefined; patterns: PatternOption[] }) {
  const summary = describeCustomStrategy(strategy, patterns);
  return <details className="panel signal-rule-details custom-rule-details" open><summary>策略条件 · 第 {strategy.revision || 1} 版</summary>
    <div className="strategy-rule-panel">
      <div className="strategy-rule-field conditions"><span>条件与规则</span>
        {group?.conditions?.length ? <ul>{group.conditions.map((line, index) => <li key={index}>{line}</li>)}</ul>
          : <ul>{summary.required.length > 0 && <li>必要条件：{summary.required.join("、")}</li>}{summary.optional.length > 0 && <li>其他条件：{summary.optional.join("、")}</li>}<li>匹配规则：全部条件（不含门槛）中至少满足 {strategy.minMatchPercent}%</li><li>风险否决：始终启用</li></ul>}</div>
      <div className="strategy-rule-field"><span>选股范围</span><p>{summary.universe}</p></div>
      <div className="strategy-rule-field"><span>来源</span><p>{strategy.origin === "legacy-settings" ? "由设置页“自主策略组合”迁移或导入；设置中的组合仍用于个股分析与预警" : strategy.origin === "copy" ? "复制自另一套策略" : "用户创建"}{strategy.updatedAt ? ` · 最近保存 ${new Date(strategy.updatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}` : ""}</p></div>
    </div>
  </details>;
}

const TrendScreenerView = lazy(() => import("./TrendScreenerView"));
type Focus = { kind: "pattern" | "custom" | "trend"; id: string };
let rememberedFocus: Focus | null = null;

/**
 * 策略选股：策略驱动的统一选股工作台。左侧策略库（我的策略 / 涨停形态 / 趋势模型），
 * 选择策略后右侧只展示该策略选出的股票；自定义策略可新建、编辑、复制、删除，保存后立即参与选股。
 */
export default function StrategySignalsView({ onOpen, onOpenAiPicks, initialFocus, live = true, quoteRefreshSeconds = 15 }: { live?: boolean; quoteRefreshSeconds?: number; onOpen?: ((security: Security) => void) | undefined; onOpenAiPicks?: (() => void) | undefined; initialFocus?: "trend" | undefined } = {}) {
  const [report, setReport] = useState<StrategySignalReport | null>(() => getSelectionReport<StrategySignalReport>());
  const [catalog, setCatalog] = useState<StrategySignalGroup[]>([]);
  // 已下线的策略（retired）不进策略库、不参与选股；只留给「我的策略」编辑器显示已引用的条件。
  const [retiredCatalog, setRetiredCatalog] = useState<StrategySignalGroup[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [activeId, setActiveId] = useState(rememberedStrategyId);
  const [focus, setFocus] = useState<Focus | null>(() => initialFocus === "trend" ? { kind: "trend", id: TREND_STRATEGY_CHOICES[0]!.id } : rememberedFocus);
  const [mode, setMode] = useState<"strategy" | "stock">(rememberedMode);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("catalog");
  const [family, setFamily] = useState("all");
  const [hideEmpty, setHideEmptyState] = useState(rememberedHideEmpty);
  const setHideEmpty = (value: boolean) => { rememberedHideEmpty = value; setHideEmptyState(value); };
  const [loading, setLoading] = useState(true);
  const [loadStartedAt, setLoadStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState("");
  const [customStrategies, setCustomStrategies] = useState<CustomStrategy[]>([]);
  const [customError, setCustomError] = useState("");
  const [editor, setEditor] = useState<CustomStrategy | null>(null);
  const [editorSession, setEditorSession] = useState(0);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [deleteRequest, setDeleteRequest] = useState<{ strategy: CustomStrategy; request: ConfirmDialogRequest } | null>(null);
  const [notice, setNotice] = useState("");
  const [aiRanking, setAiRanking] = useState<AiRanking | null>(null);
  const [editorAiText, setEditorAiText] = useState("");
  const jobs = useRef(createServiceJobScope());
  const revision = useRef(0);
  const customApi = typeof window.stockApi.listCustomStrategies === "function";
  const loadCatalog = useCallback(() => {
    let active = true;
    setCatalogError("");
    window.stockApi.getStrategyDefinitions().then(input => {
      if (!active) return;
      const definitions: any[] = Array.isArray(input) ? input : input.strategies || input.definitions || [];
      setCatalog(normalizeSignalReport({ strategies: definitions.filter(item => item?.retired !== true).map(item => ({ ...item, stocks: [] })) }).strategies);
      setRetiredCatalog(normalizeSignalReport({ strategies: definitions.filter(item => item?.retired === true).map(item => ({ ...item, name: `${item.name}（已下线）`, stocks: [] })) }).strategies);
    }).catch(reason => { if (active) setCatalogError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, []);
  const loadCustom = useCallback(async () => {
    if (!window.stockApi.listCustomStrategies) return;
    try { setCustomStrategies(await window.stockApi.listCustomStrategies()); setCustomError(""); }
    catch (reason) { setCustomError(ipcMessage(reason)); }
  }, []);
  useEffect(() => loadCatalog(), [loadCatalog]);
  useEffect(() => { void loadCustom(); }, [loadCustom]);
  // 保存/导入/删除策略的回调在 await 之后才重新选股：页面已切走时不再启动新的全市场选股。
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async (refresh = false) => {
    void jobs.current.cancelAll();
    const current = ++revision.current;
    setLoading(true); setLoadStartedAt(Date.now()); setElapsedSeconds(0); setError("");
    try {
      const raw = await jobs.current.run(requestId => window.stockApi.scanStrategySignals({ requestId, strategyIds: [], maxUniverse: 300, refresh }));
      if (revision.current !== current) return;
      const next = normalizeSignalReport(raw);
      setSelectionReport(next); setReport(next);
      setActiveId(previous => next.strategies.some(group => group.id === previous && !group.custom) ? previous : defaultStrategyId(next.strategies.filter(group => !group.custom)));
    } catch (reason) {
      if (revision.current === current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (revision.current === current) setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    return () => { revision.current += 1; void jobs.current.cancelAll(); };
  }, [load]);
  useEffect(() => {
    if (!loading || loadStartedAt === null) return;
    const timer = window.setInterval(whenVisible(() => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - loadStartedAt) / 1000)))), 1000);
    return () => window.clearInterval(timer);
  }, [loading, loadStartedAt]);
  const strategies = report?.strategies || catalog;
  const patternGroups = useMemo(() => strategies.filter(group => !group.custom), [strategies]);
  const customGroups = useMemo(() => new Map((report?.strategies || []).filter(group => group.custom).map(group => [group.id, group])), [report]);
  const patterns = useMemo<PatternOption[]>(() => [...(catalog.length ? catalog : patternGroups), ...retiredCatalog].map(group => ({ id: group.id, name: group.name, family: group.family, detail: group.detail })), [catalog, patternGroups, retiredCatalog]);
  const filtered = useMemo(() => filterSignalGroups(patternGroups, query, sort, family, Boolean(report) && hideEmpty, activeId), [patternGroups, query, sort, family, report, hideEmpty, activeId]);
  // 家族下拉只列在用策略里还有的家族（游资打法等整族下线后不再出现空选项）。
  const familyOptions = useMemo(() => { const present = new Set(patternGroups.map(group => group.family)); return families.filter(([id]) => id === "all" || present.has(id)); }, [patternGroups]);
  useEffect(() => { if (family !== "all" && !familyOptions.some(([id]) => id === family)) setFamily("all"); }, [family, familyOptions]);
  const filteredCustom = customStrategies.filter(item => !query.trim() || `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const emptyCount = report ? patternGroups.filter(group => !group.stocks.length).length : 0;
  const active = filtered.find(group => group.id === activeId) || filtered.find(group => group.id === defaultStrategyId(filtered));
  const previous = Boolean(report && (loading || error));
  const uniqueCount = new Set(strategies.flatMap(group => group.stocks.map(stock => stock.code))).size;
  const aiScores = useMemo(() => aiScoreMap(aiRanking), [aiRanking]);
  const summaryRows = useMemo(() => summarizeStocksAcrossStrategies(strategies.filter(group => !group.error)), [strategies]);
  // 表里的「AI 分」小标签：只读本机已保存的 AI 打分（在「AI 选股」页生成），不在这里调用模型。
  useEffect(() => {
    const api = window.stockApi?.ai;
    setAiRanking(null);
    if (!api || !report?.asOfDate || !summaryRows.length) return;
    let active = true;
    void api.cached({ asOfDate: report.asOfDate, picks: buildAiPicks(summaryRows), strategyCounts: [] })
      .then(value => { if (active) setAiRanking(value.rank); }).catch(() => {});
    return () => { active = false; };
  }, [report?.asOfDate, summaryRows]);
  const poolDataState = selectionDataState(report);
  const personalDataState = selectionDataState(report, "watchlist");
  const summaryDataState = selectionSummaryDataState(report, uniqueCount > 0);
  const overallUnavailable = summaryDataState.state === "unavailable";
  const focused: Focus = focus && (focus.kind !== "custom" || customStrategies.some(item => item.id === focus.id)) ? focus : { kind: "pattern", id: active?.id || "" };
  const focusedCustom = focused.kind === "custom" ? customStrategies.find(item => item.id === focused.id) : undefined;
  const choose = (next: Focus) => { rememberedFocus = next; setFocus(next); rememberedMode = "strategy"; setMode("strategy"); setEditor(null); setNotice(""); };
  const activate = (id: string) => {
    if (customStrategies.some(item => item.id === id)) { choose({ kind: "custom", id }); return; }
    rememberedStrategyId = id; setActiveId(id); choose({ kind: "pattern", id });
    if (!filtered.some(group => group.id === id)) { setQuery(""); setFamily("all"); setHideEmpty(false); }
  };
  const switchMode = (next: "strategy" | "stock") => { rememberedMode = next; setMode(next); setEditor(null); };
  const openEditor = (strategy: CustomStrategy, aiText = "") => { if (saving) return; setEditorSession(current => current + 1); setEditorError(""); setEditorAiText(aiText); setEditor(strategy); setNotice(""); };
  // 从「AI 选股」页带过来的大白话描述：打开新建策略编辑器，由 AI 配好条件后用户确认保存。
  useEffect(() => {
    const text = takePendingStrategyText();
    if (text && customApi) { setEditorSession(current => current + 1); setEditorAiText(text); setEditor(emptyCustomStrategy()); }
  }, [customApi]);
  const saveStrategy = async (strategy: CustomStrategy) => {
    if (!window.stockApi.saveCustomStrategy) return;
    setSaving(true); setEditorError("");
    try {
      const result = await window.stockApi.saveCustomStrategy(strategy);
      setCustomStrategies(result.strategies); setEditor(null);
      choose({ kind: "custom", id: result.strategy.id || "" });
      setNotice(`已保存「${result.strategy.name}」，正在按新条件选股…`);
      if (mounted.current) void load(false);
    } catch (reason) { setEditorError(ipcMessage(reason)); }
    finally { setSaving(false); }
  };
  const importSettings = async () => {
    if (!window.stockApi.importSettingsStrategy) return;
    setSaving(true); setEditorError("");
    try {
      const result = await window.stockApi.importSettingsStrategy();
      setCustomStrategies(result.strategies); setEditor(null);
      choose({ kind: "custom", id: result.strategy.id || "" });
      setNotice(`已从设置导入「${result.strategy.name}」，可继续编辑。`);
      if (mounted.current) void load(false);
    } catch (reason) { setEditorError(ipcMessage(reason)); }
    finally { setSaving(false); }
  };
  const resolveDelete = async (confirmed: boolean) => {
    const pending = deleteRequest; setDeleteRequest(null);
    if (!confirmed || !pending?.strategy.id || !window.stockApi.deleteCustomStrategy) return;
    try {
      const result = await window.stockApi.deleteCustomStrategy(pending.strategy.id);
      setCustomStrategies(result.strategies); setFocus(null); rememberedFocus = null;
      setNotice(`已删除「${pending.strategy.name}」。`);
      if (mounted.current) void load(false);
    } catch (reason) { setCustomError(ipcMessage(reason)); }
  };
  const selectionStatus = (group: StrategySignalGroup | undefined, data: SelectionDataState) => {
    if (group?.error) return "规则需修正";
    if (!report || !group) return loading ? "选股中…" : error ? "选股未完成" : "待选股";
    const round = previous ? "上轮" : "本轮";
    if (group.stocks.length) return `${round}选出 ${group.stocks.length} 只股票${data.state === "partial" ? "（部分行情未齐）" : ""}`;
    if (data.state === "unavailable") return `${round}行情暂不可用`;
    if (data.state === "empty-universe") return `${round}股票池为空`;
    return `${round}${data.state === "partial" ? "可用数据中" : ""}未命中`;
  };
  const strategyButton = (group: StrategySignalGroup, kind: "featured" | "composite" | "base") => {
    const selected = mode === "strategy" && !editor && focused.kind === "pattern" && active?.id === group.id;
    const isComposite = composite(group);
    return <button key={group.id} className={`${selected ? "active" : ""} type-${kind === "featured" ? "featured" : isComposite ? "composite" : "base"}`} aria-pressed={selected} onClick={() => activate(group.id)}><span><span className="strategy-signal-tab-name"><b>{group.name}</b></span><small className="strategy-signal-tab-audit">{selectionStatus(group, poolDataState)}</small></span><ChevronRight size={15} /></button>;
  };
  const hasFeatured = patternGroups.some(group => group.featured);
  const renderTabs = (isComposite: boolean) => {
    // 精选策略单列在最上面；这里只列其余策略。
    const groups = filtered.filter(group => composite(group) === isComposite && !(hasFeatured && group.featured));
    if (!groups.length) return null;
    return <><div className={`strategy-signal-tab-section ${isComposite ? "composite" : "base"}`}><span>{hasFeatured ? `更多策略 · ${isComposite ? "组合共振" : "基础"}` : isComposite ? "组合共振策略" : "基础策略"}</span><b>{groups.length}</b></div>{groups.map(group => strategyButton(group, isComposite ? "composite" : "base"))}</>;
  };
  const renderFeatured = () => {
    const groups = filtered.filter(group => group.featured);
    if (!groups.length) return null;
    return <><div className="strategy-signal-tab-section featured" title="按 2021–2026 全A日线回放挑出的较强策略，排在最前面"><span>精选策略</span><b>{groups.length}</b></div>{groups.map(group => strategyButton(group, "featured"))}</>;
  };
  const customItem = (strategy: CustomStrategy) => {
    const group = customGroups.get(strategy.id || "");
    const selected = mode === "strategy" && !editor && focused.kind === "custom" && focused.id === strategy.id;
    const customData = strategy.universe === "watchlist" ? personalDataState : poolDataState;
    const status = selectionStatus(group, customData);
    return <button key={strategy.id} className={`strategy-library-item custom ${selected ? "active" : ""}`} aria-pressed={selected} onClick={() => choose({ kind: "custom", id: strategy.id || "" })}>
      <span><span className="strategy-signal-tab-name"><b>{strategy.name}</b>{strategy.universe === "watchlist" && <em className="strategy-universe-tag">自选</em>}</span>
        <small className="strategy-signal-tab-audit">{status}</small></span><ChevronRight size={15} /></button>;
  };
  const trendItem = (item: { id: TrendStrategyId; name: string }) => {
    const selected = mode === "strategy" && !editor && focused.kind === "trend" && focused.id === item.id;
    return <button key={item.id} className={`strategy-library-item trend ${selected ? "active" : ""}`} aria-pressed={selected} onClick={() => choose({ kind: "trend", id: item.id })}>
      <span><span className="strategy-signal-tab-name"><b>{item.name}</b></span><small className="strategy-signal-tab-audit">全市场扫描 · 分钟级</small></span><ChevronRight size={15} /></button>;
  };
  const customGroupFor = (strategy: CustomStrategy): StrategySignalGroup => customGroups.get(strategy.id || "") || { id: strategy.id || "", name: strategy.name, custom: true, family: "custom", stocks: [] };
  const renderMain = () => {
    if (editor) return <CustomStrategyEditor key={`${editor.id || "new"}:${editorSession}`} initial={editor} initialAiText={editorAiText} patterns={patterns} others={customStrategies} saving={saving} error={editorError}
      onSave={strategy => void saveStrategy(strategy)} onCancel={() => { setEditor(null); setEditorError(""); }} onImportSettings={editor.id ? undefined : () => void importSettings()} />;
    if (mode === "stock" && report) return <StrategyStockSummaryPanel live={live} quoteRefreshSeconds={quoteRefreshSeconds} groups={strategies} onOpen={onOpen} onStrategy={activate} dataState={summaryDataState} aiScores={aiScores} />;
    if (focused.kind === "trend") return <Suspense fallback={<div className="panel strategy-stock-empty"><LoaderCircle className="spin" size={24} /><b>正在载入趋势模型…</b></div>}>
      <TrendScreenerView embedded focusStrategyId={focused.id as TrendStrategyId} onOpen={security => onOpen?.(security)} /></Suspense>;
    if (focusedCustom) {
      const group = customGroupFor(focusedCustom);
      const summary = describeCustomStrategy(focusedCustom, patterns);
      return <>
        <section className="panel strategy-signal-group-head"><div className="strategy-signal-group-copy"><div className="strategy-signal-title-line"><h2>{focusedCustom.name}</h2><i className="strategy-type-badge custom">我的策略</i>{focusedCustom.universe === "watchlist" && <i className="strategy-type-badge base">自选与持仓</i>}</div>
          <p>{focusedCustom.description || `${summary.count} 个条件${summary.required.length ? `，必要：${summary.required.join("、")}` : ""}；至少满足 ${focusedCustom.minMatchPercent}%`}</p></div>
          <div className="custom-strategy-actions"><button type="button" className="secondary-btn" onClick={() => openEditor(structuredClone(focusedCustom))}><Pencil size={15} />编辑</button>
            <button type="button" className="secondary-btn" onClick={() => openEditor(copyCustomStrategy(focusedCustom))}><Copy size={15} />复制</button>
            <button type="button" className="secondary-btn danger-btn" onClick={() => setDeleteRequest({ strategy: focusedCustom, request: { title: `删除「${focusedCustom.name}」？`, message: "删除后不可恢复；设置页的自主策略组合不受影响。", confirmLabel: "删除", tone: "danger" } })}><Trash2 size={15} />删除</button></div></section>
        {group.error && <div className="warning-banner" role="alert"><CircleAlert size={17} />本策略未参与本轮选股：{group.error}</div>}
        {summary.external.length > 0 && <div className="strategy-pending-note" role="note"><CircleAlert size={16} />含 {summary.external.join("、")} 等需个股数据的条件：批量选股时按“待确认”处理，列表中标出依赖它们的股票，点开个股分析即可核对。</div>}
        {report ? <StrategyStockPanel live={live} quoteRefreshSeconds={quoteRefreshSeconds} key={`custom:${group.id}`} group={group} onOpen={onOpen} aiScores={aiScores} dataState={focusedCustom.universe === "watchlist" ? personalDataState : poolDataState} /> : <div className="panel strategy-stock-empty"><Target size={28} /><b>{loading ? "正在选股…" : "尚无选股结果"}</b></div>}
        <CustomStrategyRules strategy={focusedCustom} group={group} patterns={patterns} />
      </>;
    }
    if (!active) return null;
    return <><section className="panel strategy-signal-group-head"><div className="strategy-signal-group-copy"><div className="strategy-signal-title-line"><h2>{active.name}</h2><i className={`strategy-type-badge ${composite(active) ? "composite" : "base"}`}>{composite(active) ? "组合共振" : "基础策略"}</i>{active.featured && <i className="strategy-type-badge featured" title="按 2021–2026 全A日线回放挑出的较强策略">精选</i>}</div><p>{active.detail}</p></div>
      {customApi && <div className="custom-strategy-actions"><button type="button" className="secondary-btn" onClick={() => openEditor({ ...emptyCustomStrategy(), name: `${active.name.slice(0, 24)}·我的版本`, conditions: [{ ref: `pattern:${active.id}`, required: true }] })}><Plus size={15} />以此为基础新建</button></div>}</section>
      {report ? <StrategyStockPanel live={live} quoteRefreshSeconds={quoteRefreshSeconds} key={active.id} group={active} onOpen={onOpen} aiScores={aiScores} dataState={poolDataState} /> : <div className="panel strategy-stock-empty"><Target size={28} /><b>{loading ? "正在选股…" : "尚无选股结果"}</b></div>}
      <StrategySelectionRules key={`${active.id}:rules`} group={active} /></>;
  };
  return <div className="strategy-signals-view strategy-selection-only strategy-selection-workspace">
    <div className="page-heading"><div><h1>策略选股</h1><p>先选策略，再看按该策略选出的股票；可新建自己的条件组合，保存后立即参与选股。</p></div><div className="heading-actions">
      {report && <div className="strategy-mode-switch" role="group" aria-label="查看方式"><button className={mode === "strategy" ? "active" : ""} aria-pressed={mode === "strategy"} onClick={() => switchMode("strategy")}>按策略</button><button className={mode === "stock" ? "active" : ""} aria-pressed={mode === "stock"} onClick={() => switchMode("stock")}>按股票汇总</button></div>}
      {loading && <button className="secondary-btn" onClick={() => { revision.current += 1; void jobs.current.cancelAll(); setLoading(false); setError("本轮选股已取消，点击重新选股可重试。"); }}>取消</button>}
      <button className="primary-btn" disabled={loading} onClick={() => void load(true)}>{loading ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}{loading ? "正在选股" : "重新选股"}</button>
    </div></div>
    {loading && <div className="signal-test-status"><span role="status">{strategies.length ? `正在按 ${patternGroups.length + customStrategies.length} 套策略规则选股` : "正在获取策略规则并选股"}{report ? `，列表为上轮结果，数据日 ${report.asOfDate || "未提供"}` : ""}。</span>{" "}<span role="timer" aria-live="off">已耗时 {elapsedSeconds < 60 ? `${elapsedSeconds} 秒` : `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`}。</span>{" "}<span>全市场逐只读取日线，首次建库可能需要数分钟，最长等待25分钟；可随时取消，已缓存日线会供下次选股复用。</span></div>}
    {error && <div className="warning-banner" role="alert"><CircleAlert size={17} />{error}{report ? ` 当前显示上轮结果，数据日 ${report.asOfDate || "未提供"}。` : ""}</div>}
    {catalogError && !report && <div className="warning-banner" role="alert"><CircleAlert size={17} />策略目录加载失败：{catalogError}<button className="secondary-btn" onClick={() => loadCatalog()}>重试</button></div>}
    {customError && <div className="warning-banner" role="alert"><CircleAlert size={17} />我的策略读取失败：{customError}<button className="secondary-btn" onClick={() => void loadCustom()}>重试</button></div>}
    {notice && <div className="strategy-picks-banner" role="status"><Check size={17} /><span>{notice}</span></div>}
    {report?.warning && focused.kind !== "trend" && <div className="warning-banner"><CircleAlert size={17} />{report.warning}</div>}
    {report && focused.kind !== "trend" && <div className="strategy-picks-banner" role="status"><Target size={17} /><span>{previous ? "上轮" : "本轮"}{overallUnavailable ? "历史行情暂不可用，尚不能完成选股判断" : <>共选出 <b>{uniqueCount}</b> 只股票（去重）</>} · 数据日 {report.asOfDate || "未提供"}（收盘快照） · 全市场 {report.universeSize ?? "--"} 只（剔除ST、含北交所），已计算 {report.processed ?? "--"} 只{report.failed ? ` · ${report.failed} 只日线读取失败` : ""}。表内行情独立刷新，选股依据保持为上述收盘快照。</span>
      {!editor && onOpenAiPicks && window.stockApi?.ai && <button type="button" className="secondary-btn strategy-ai-link" onClick={onOpenAiPicks} title={aiRanking ? `已有 AI 打分（${aiRanking.model}），表里的「AI 分」标签可悬停查看点评` : "让 AI 给本轮选出的股票打分点评、写每日复盘"}><Bot size={15} />{aiRanking ? "AI 打分详情" : "AI 选股"}<ChevronRight size={14} /></button>}</div>}
    <div className="terminal-strategy-workspace"><div className="terminal-strategy-primary"><section className="strategy-signal-layout">
      <aside className="panel strategy-signal-tabs"><header><Activity size={18} /><div><b>策略库</b><small>选策略，看它选出的股票</small></div></header>
        <div className="signal-catalog-filter"><input aria-label="搜索信号策略" placeholder="查找策略名称或条件" value={query} onChange={event => setQuery(event.target.value)} /><div><select aria-label="策略家族" value={family} onChange={event => setFamily(event.target.value)}>{familyOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="策略排序" value={sort} onChange={event => setSort(event.target.value)}><option value="catalog">默认排序</option><option value="picks">按选出股票数</option></select></div>
          {report && <label className="signal-hide-empty"><input type="checkbox" checked={hideEmpty} onChange={event => setHideEmpty(event.target.checked)} />隐藏本轮无结果策略{emptyCount ? `（${emptyCount}）` : ""}</label>}</div>
        <div className="strategy-library-scroll">
        {customApi && <section className="strategy-library-section custom" aria-label="我的策略"><div className="strategy-library-heading"><span>我的策略</span><b>{customStrategies.length}</b>
          <button type="button" className="secondary-btn strategy-library-new" onClick={() => openEditor(emptyCustomStrategy())} disabled={saving || customStrategies.length >= CUSTOM_CATALOG.limits.maxStrategies}><Plus size={14} />新建</button></div>
          <div className="strategy-library-list">{filteredCustom.map(customItem)}{!customStrategies.length && <p className="strategy-library-empty">还没有自己的策略。点“新建”组合条件，或在任一内置策略上“以此为基础新建”。</p>}</div></section>}
        <div className="strategy-library-heading pattern"><span>涨停形态</span><b>{patternGroups.length}</b><small>全市场 · 剔除ST</small></div>
        <div className="strategy-signal-tab-list">{renderFeatured()}{renderTabs(true)}{renderTabs(false)}{!filtered.length && <div className="signal-catalog-empty"><p>没有符合条件的策略。</p>{(query.trim() || family !== "all" || hideEmpty) && <button className="secondary-btn" onClick={() => { setQuery(""); setFamily("all"); setHideEmpty(false); }}>清除筛选</button>}</div>}</div>
        <section className="strategy-library-section trend" aria-label="趋势模型"><div className="strategy-library-heading"><span>趋势模型</span><b>{TREND_STRATEGY_CHOICES.length}</b><small>全市场 · 单独扫描</small></div>
          <div className="strategy-library-list">{TREND_STRATEGY_CHOICES.filter(item => !query.trim() || item.name.toLowerCase().includes(query.trim().toLowerCase())).map(trendItem)}</div></section>
        </div>
        <footer><Clock3 size={15} />{!report ? "完成选股后显示本轮缓存有效期。" : report.cacheValidUntil === null || summaryDataState.state === "partial" || summaryDataState.state === "unavailable" ? "本轮仅短暂缓存；来源恢复后点击“重新选股”立即重试。" : report.cacheValidUntil ? `本轮结果缓存至 ${formatShanghaiDateTime(new Date(report.cacheValidUntil).toISOString())}；点击“重新选股”强制刷新。` : "缓存有效期未提供；点击“重新选股”获取最新结果。"}</footer>
      </aside>
      <div className="strategy-signal-main">{renderMain()}</div>
    </section></div></div>
    {report && focused.kind !== "trend" && <StrategySelectionCoverage report={report} previous={previous} />}
    <ConfirmDialog request={deleteRequest?.request || null} onResolve={confirmed => void resolveDelete(confirmed)} />
  </div>;
}
