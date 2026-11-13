import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronRight, CircleAlert, History, ListChecks, LoaderCircle, RefreshCw, Sparkles, Target, Wand2 } from "lucide-react";
import { AiCustomBoard } from "./AiCustomBoard";
import { PageHeading } from "../../components/terminal/TerminalPrimitives";
import { AiDimChips, AiFrameworkPicker, AiScoreCell, useAiFrameworks } from "./AiFrameworkParts";
import { AiScoringCoverage, AiSelectAllHeader, AiSelectCell, AiSelectionBar, scoreAction, scoringCoverage, useRowSelection } from "./AiRowSelection";
import { AiCommentRow } from "./AiCommentRow";
import { normalizeSignalReport, summarizeStocksAcrossStrategies, type StockSummaryRow, type StrategySignalReport } from "../../StrategySignalsView";
import { createServiceJobScope } from "../../serviceJobClient";
import { selectionSummaryDataState } from "../../strategySelectionDataState";
import { whenVisible } from "../../visiblePolling";
import { useSelectionQuotes } from "../strategy-selection/useSelectionQuotes";
import { SelectionQuoteControls, SelectionQuotePrice } from "../strategy-selection/SelectionQuoteCells";
import { SelectionKline } from "../strategy-selection/SelectionKline";
import { AI_MAX_PICKS, aiErrorMessage, buildAiBoardRows, buildAiPicks, ratingTone, secidFor } from "../strategy-selection/aiSelectionModel";
import { getSelectionReport, setPendingStrategyText, setSelectionReport, subscribeSelectionReport } from "../strategy-selection/selectionReportStore";

const RATING_FILTERS = ["全部", "重点关注", "关注", "观望", "回避"] as const;
const PAGE_SIZE = 20;
type HistoryDay = { asOfDate: string; rankModels: string[]; customModels?: string[] | undefined; hasSummary: boolean; savedAt: string };
type Tab = "strategy" | "custom";
let rememberedTab: Tab = "strategy";
type Viewing = { kind: "current" } | { kind: "history"; asOfDate: string };

// 从策略候选里移除的股票：按数据日记在本机（只是不交给 AI，不影响策略选股结果）。
const EXCLUDED_KEY = "ai-picks-excluded";
function readExcluded(asOfDate: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(EXCLUDED_KEY) || "null") as { asOfDate?: string; codes?: unknown } | null;
    return value && value.asOfDate === asOfDate && Array.isArray(value.codes) ? value.codes.filter((code): code is string => typeof code === "string" && /^\d{6}$/.test(code)) : [];
  } catch { return []; }
}
function writeExcluded(asOfDate: string, codes: string[]) {
  try { window.localStorage.setItem(EXCLUDED_KEY, JSON.stringify({ asOfDate, codes })); } catch { /* 存不了只影响下次打开 */ }
}

const toSecurity = (row: { code: string; name: string; secid?: string | undefined }): Security => ({ code: row.code, name: row.name, secid: row.secid || secidFor(row.code), assetType: "stock" });
const stamp = (value: { model: string; generatedAt: string; cached?: boolean | undefined }) =>
  `${value.model} · ${new Date(value.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}${value.cached ? " · 本机已保存" : ""}`;

/**
 * AI 选股（独立板块）：读取最新一轮「策略选股」结果，取汇总排名前 40 只交给 AI。
 * 1. 顶部控制条：数据日、一起打分的模型、总结用的模型、AI 打分 / AI 总结；
 * 2. AI 每日总结；3. AI 打分榜（综合分、各模型分、分歧、日 K、现价）；
 * 4. 历史记录（按数据日回看之前的打分和总结）；5. 用大白话建策略（交给「我的策略」编辑器确认保存）。
 * 打开页面只读本机已保存的结果，不会自动调用模型。
 */
export default function AiPicksView({ onOpen, onOpenStrategies, live = true, quoteRefreshSeconds = 15 }: {
  onOpen?: ((security: Security) => void) | undefined; onOpenStrategies?: (() => void) | undefined; live?: boolean; quoteRefreshSeconds?: number;
}) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai;
  const [report, setReport] = useState<StrategySignalReport | null>(() => getSelectionReport<StrategySignalReport>());
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const jobs = useRef(createServiceJobScope());
  const scanRevision = useRef(0);

  const [status, setStatus] = useState<{ configured: boolean; model: string; profile?: string; rankModels?: string[] } | null>(null);
  const [profiles, setProfiles] = useState<AiProfileList | null>(null);
  const [reload, setReload] = useState(0);
  const [ranking, setRanking] = useState<AiRanking | null>(null);
  const [summary, setSummary] = useState<AiSummary | null>(null);
  const [busy, setBusy] = useState<"" | "rank" | "summary">("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<(typeof RATING_FILTERS)[number]>("全部");
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<HistoryDay[]>([]);
  const [viewing, setViewing] = useState<Viewing>({ kind: "current" });
  const [historyDay, setHistoryDay] = useState<{ asOfDate: string; rank: AiRanking | null; custom?: AiRanking | null | undefined; summary: AiSummary | null } | null>(null);
  const [tab, setTab] = useState<Tab>(rememberedTab);
  const switchTab = (next: Tab) => { rememberedTab = next; setTab(next); };
  const bumpReload = useCallback(() => setReload(value => value + 1), []);
  const frameworks = useAiFrameworks(bumpReload);
  const [strategyText, setStrategyText] = useState("");
  const generation = useRef(0);
  const cacheRevision = useRef({ rank: 0, summary: 0 });

  // 最新一轮选股结果：与「策略选股」页共用；还没有就按缓存读取（有缓存时很快，没有才会全市场计算）。
  useEffect(() => subscribeSelectionReport(() => setReport(getSelectionReport<StrategySignalReport>())), []);
  const scan = useCallback(async (refresh = false) => {
    void jobs.current.cancelAll();
    const current = ++scanRevision.current;
    setScanning(true); setScanError(""); setElapsed(0);
    try {
      const raw = await jobs.current.run(requestId => window.stockApi.scanStrategySignals({ requestId, strategyIds: [], maxUniverse: 300, refresh }));
      if (scanRevision.current !== current) return;
      const next = normalizeSignalReport(raw);
      setSelectionReport(next); setReport(next);
    } catch (reason) {
      if (scanRevision.current === current) setScanError(aiErrorMessage(reason));
    } finally { if (scanRevision.current === current) setScanning(false); }
  }, []);
  useEffect(() => {
    if (!getSelectionReport()) void scan(false);
    return () => { scanRevision.current += 1; void jobs.current.cancelAll(); };
  }, [scan]);
  useEffect(() => {
    if (!scanning) return;
    const started = Date.now();
    const timer = window.setInterval(whenVisible(() => setElapsed(Math.floor((Date.now() - started) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [scanning]);

  const rows = useMemo<StockSummaryRow[]>(() => report ? summarizeStocksAcrossStrategies(report.strategies.filter(group => !group.error)) : [], [report]);
  const asOfDate = report?.asOfDate || "";
  const [excluded, setExcluded] = useState<string[]>([]);
  useEffect(() => { setExcluded(readExcluded(asOfDate)); }, [asOfDate]);
  const updateExcluded = (codes: string[]) => { const next = [...new Set(codes)]; setExcluded(next); writeExcluded(asOfDate, next); };
  const topRows = useMemo(() => rows.slice(0, AI_MAX_PICKS), [rows]);
  const candidates = useMemo(() => { const removed = new Set(excluded); return topRows.filter(row => !removed.has(row.code)); }, [topRows, excluded]);
  const removedCount = topRows.length - candidates.length;
  const dataState = selectionSummaryDataState(report, rows.length > 0);
  const coverageNotice = dataState.state === "unavailable" ? "行情暂不可用，尚不能完成选股。可刷新候选重试。"
    : dataState.state === "partial" ? "部分行情未取到，本轮候选仅覆盖已成功读取的数据。"
      : dataState.state === "empty-universe" ? "当前股票池为空，可刷新候选核对数据。" : "";
  const picks = useMemo(() => buildAiPicks(candidates), [candidates]);
  const strategyCounts = useMemo(() => (report?.strategies || []).filter(group => group.stocks.length).map(group => ({ name: group.name, count: group.stocks.length })), [report]);
  const input = useMemo<AiSelectionInput>(() => ({ asOfDate, picks, strategyCounts }), [asOfDate, picks, strategyCounts]);

  const loadHistory = useCallback(() => {
    if (!api?.history) return;
    void api.history().then(setHistory).catch(() => {});
  }, [api]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    const current = ++generation.current;
    const cachedAt = { ...cacheRevision.current };
    const stop = () => { generation.current += 1; };
    setRanking(null); setSummary(null); setBusy(""); setError("");
    if (!api) return stop;
    void api.status().then(value => { if (generation.current === current) setStatus(value); }).catch(() => {});
    if (api.profiles) void api.profiles().then(value => { if (generation.current === current) setProfiles(value); }).catch(() => {});
    if (!picks.length) return stop;
    void api.cached(input).then(value => {
      if (generation.current !== current) return;
      if (cacheRevision.current.rank === cachedAt.rank) setRanking(value.rank);
      if (cacheRevision.current.summary === cachedAt.summary) setSummary(value.summary);
    }).catch(() => {});
    return stop;
  }, [api, input, picks.length, reload]);

  useEffect(() => {
    if (viewing.kind !== "history" || !api?.historyDay) { setHistoryDay(null); return; }
    let active = true;
    setHistoryDay(null);
    void api.historyDay(viewing.asOfDate).then(value => { if (active) setHistoryDay(value); }).catch(reason => { if (active) setError(aiErrorMessage(reason)); });
    return () => { active = false; };
  }, [api, viewing]);
  useEffect(() => { setPage(1); }, [filter, viewing, ranking]);

  const run = async (kind: "rank" | "summary", force = false, only?: string[]) => {
    if (!api || busy || scanning || !picks.length) return;
    const current = generation.current;
    cacheRevision.current[kind] += 1; // Preserve the independent result from the initial cache read.
    setBusy(kind); setError("");
    try {
      if (kind === "rank") {
        const value = await api.rank({ ...input, force, ...(only?.length ? { only } : {}) });
        if (generation.current === current) { setRanking(value); if (force && only?.length) selection.clear(); }
      }
      else { const value = await api.summary({ ...input, force }); if (generation.current === current) setSummary(value); }
      if (generation.current === current) loadHistory();
    } catch (reason) {
      if (generation.current === current) setError(aiErrorMessage(reason));
    } finally { if (generation.current === current) setBusy(""); }
  };
  const toggleRankModel = async (id: string) => {
    if (!api?.setRankModels || busy || !profiles) return;
    const current = profiles.rankIds || [profiles.activeId];
    const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
    if (!next.length) { setError("至少选择一套模型参与打分"); return; }
    if (next.length > 4) { setError("最多同时用 4 套模型打分"); return; }
    try { setProfiles(await api.setRankModels(next)); setReload(value => value + 1); } catch (reason) { setError(aiErrorMessage(reason)); }
  };
  const switchProfile = async (id: string) => {
    if (!api?.activateProfile || busy || id === profiles?.activeId) return;
    try { setProfiles(await api.activateProfile(id)); setReload(value => value + 1); } catch (reason) { setError(aiErrorMessage(reason)); }
  };
  const sendStrategy = () => {
    const text = strategyText.trim();
    if (!text || !onOpenStrategies) return;
    setPendingStrategyText(text);
    onOpenStrategies();
  };

  const isHistory = viewing.kind === "history" && (tab === "custom" || viewing.asOfDate !== asOfDate);
  const custom = tab === "custom";
  const shownRanking = isHistory ? historyDay?.rank || null : ranking;
  const shownSummary = isHistory ? historyDay?.summary || null : summary;
  const boardRows = useMemo(() => buildAiBoardRows(isHistory ? [] : candidates, shownRanking, filter, !isHistory), [isHistory, candidates, shownRanking, filter]);
  const totalPages = Math.max(1, Math.ceil(boardRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = boardRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const securities = useMemo(() => pageRows.map(row => toSecurity({ code: row.code, name: row.name, secid: row.source?.secid })), [pageRows]);
  const quotes = useSelectionQuotes(securities, live && !isHistory, quoteRefreshSeconds);
  const multi = (shownRanking?.models?.length || 0) > 1;
  const hasDims = Boolean(shownRanking?.items.some(item => item.dims?.length));
  const failedModels = (shownRanking?.models || []).filter(item => !item.ok);
  const partialModels = (shownRanking?.models || []).filter(item => item.ok && item.missed);
  const rankIds = profiles?.rankIds || (profiles ? [profiles.activeId] : []);
  const configured = status?.configured !== false;
  const pastDays = history.filter(day => custom || day.asOfDate !== asOfDate);
  const open = (row: { code: string; name: string; secid?: string | undefined }) => onOpen?.(toSecurity(row));
  const candidateCodes = useMemo(() => candidates.map(row => row.code), [candidates]);
  const selection = useRowSelection(isHistory ? [] : candidateCodes);
  const expectedModels = rankIds.length || status?.rankModels?.length || 1;
  const coverage = scoringCoverage(ranking, candidateCodes, expectedModels);
  const action = scoreAction({ selected: selection.list, scored: coverage.complete, total: candidateCodes, answered: coverage.answered });
  const selectable = !isHistory;

  if (!api) return <div className="ai-picks-view"><div className="page-heading"><div><h1>AI 选股</h1><p>AI 打分、每日复盘和大白话建策略需要在桌面版使用。</p></div></div>
    <div className="panel strategy-stock-empty"><Bot size={28} /><b>浏览器预览不调用 AI</b><p>请在桌面版「设置 → AI 助手」添加模型配置后使用。</p></div></div>;

  return <div className="ai-picks-view">
    <PageHeading title="AI 选股" description="让 AI 给「策略选股」选出的股票、或你自己挑的任意股票逐只打分点评，写每日复盘；也可以用大白话让 AI 帮你配选股条件。打分时软件先按分析框架算基础分，AI 只在基础分上下 15 分内调整。" actions={<>
        <label className="ai-history-select"><History size={15} /><span>查看</span>
          <select aria-label="查看哪一天的 AI 结果" value={isHistory ? viewing.asOfDate : "current"} onChange={event => setViewing(event.target.value === "current" ? { kind: "current" } : { kind: "history", asOfDate: event.target.value })}>
            <option value="current">{custom ? "最新" : asOfDate ? `本轮（数据日 ${asOfDate}）` : "本轮"}</option>
            {pastDays.map(day => <option key={day.asOfDate} value={day.asOfDate}>{day.asOfDate} · {[day.rankModels.length ? `策略候选：${day.rankModels.join("+")}` : "", day.customModels?.length ? `我的股票：${day.customModels.join("+")}` : "", day.hasSummary ? "有总结" : ""].filter(Boolean).join(" · ")}</option>)}
          </select></label>
        {onOpenStrategies && <button type="button" className="secondary-btn" onClick={onOpenStrategies}><Target size={15} />去策略选股</button>}
      </>} />

    <div className="ai-picks-tabs" role="tablist" aria-label="AI 打分范围">
      <button type="button" role="tab" aria-selected={!custom} className={!custom ? "active" : ""} onClick={() => switchTab("strategy")}><Target size={15} />策略候选<small>规则选出的前 {AI_MAX_PICKS} 只</small></button>
      <button type="button" role="tab" aria-selected={custom} className={custom ? "active" : ""} onClick={() => switchTab("custom")}><ListChecks size={15} />我的股票<small>任意股票都能打分</small></button>
    </div>

    {!custom && scanning && <div className="signal-test-status" role="status">{report ? "正在刷新策略候选…" : "正在读取最新一轮策略选股结果…"} 已耗时 {elapsed} 秒。没有可用缓存时会全市场计算，可能需要数分钟。
      <button type="button" className="secondary-btn" onClick={() => { scanRevision.current += 1; void jobs.current.cancelAll(); setScanning(false); setScanError("已取消读取选股结果。"); }}>取消</button></div>}
    {!custom && !isHistory && scanError && <div className="warning-banner" role="alert"><CircleAlert size={17} />{scanError}<button type="button" className="secondary-btn" onClick={() => void scan(Boolean(report))}>重试</button></div>}
    {!custom && !report && !scanning && !scanError && <div className="panel strategy-stock-empty"><Target size={28} /><b>还没有本轮选股结果</b><p>AI 只评估规则选出的股票，请先完成一轮策略选股。</p>
      <button type="button" className="primary-btn" onClick={() => void scan(false)}>开始选股</button></div>}

    {isHistory && <div className="strategy-picks-banner" role="status"><History size={17} /><span>正在查看 {viewing.asOfDate} 的历史结果（只读）。<button type="button" className="link-btn" onClick={() => setViewing({ kind: "current" })}>{custom ? "回到最新" : "回到本轮"}</button></span></div>}

    {(report || isHistory || custom) && <section className="panel ai-picks-controls" aria-label="AI 控制条">
      <div className="ai-picks-status"><Bot size={18} /><span>
        <b>{isHistory ? `数据日 ${viewing.asOfDate}` : custom ? "我的股票 · 任意股票 AI 打分" : `数据日 ${asOfDate || "未提供"} · 候选 ${candidates.length} 只`}</b>
        <small>{!configured ? "未配置模型：到「设置 → AI 助手」添加模型配置" : isHistory ? "历史结果来自本机保存的记录" : custom ? "下方添加股票后点「AI 打分」；在表格里勾选几只可以只给它们打分" : `本轮规则共选出 ${rows.length} 只（去重），命中精选策略的优先、再按命中策略数取前 ${AI_MAX_PICKS} 只${removedCount ? `，已移除 ${removedCount} 只` : ""}；在表格里勾选几只可以只给它们打分`}</small></span></div>
      {!isHistory && <div className="ai-selection-actions">
        {frameworks.available && <AiFrameworkPicker inline catalog={frameworks.catalog} onChoose={id => void frameworks.choose(id)} disabled={Boolean(busy)} />}
        {!custom && profiles && profiles.profiles.length > 1 && <label className="ai-profile-select"><span>总结用</span><select aria-label="每日总结使用的模型" value={profiles.activeId} disabled={Boolean(busy)} onChange={event => void switchProfile(event.target.value)}>
          {profiles.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {!custom && <><button type="button" className="secondary-btn" onClick={() => void scan(true)} disabled={scanning || Boolean(busy)}>
          <RefreshCw size={15} />刷新候选</button><button type="button" className="primary-btn" onClick={() => void run("rank", action.force, action.only)} disabled={!configured || scanning || Boolean(busy) || !picks.length}>
          {busy === "rank" ? <LoaderCircle size={15} className="spin" /> : action.force && !action.only ? <RefreshCw size={15} /> : <Sparkles size={15} />}{busy === "rank" ? "AI 打分中…" : action.label}</button>
        <button type="button" className="secondary-btn" onClick={() => void run("summary", Boolean(summary))} disabled={!configured || scanning || Boolean(busy) || !picks.length}>
          {busy === "summary" ? <LoaderCircle size={15} className="spin" /> : summary ? <RefreshCw size={15} /> : <Sparkles size={15} />}{busy === "summary" ? "AI 总结中…" : summary ? "重新总结" : "AI 总结"}</button></>}
      </div>}
      {!custom && !isHistory && report && coverageNotice && <div className="test-result fail" role="status"><span />{coverageNotice}</div>}
      {!custom && !isHistory && ranking && <AiScoringCoverage coverage={coverage} expectedModels={expectedModels} />}
      {frameworks.error && <div className="test-result fail" role="alert"><span />{frameworks.error}</div>}
      {!isHistory && profiles && profiles.profiles.length > 1 && <div className="ai-rank-models" role="group" aria-label="一起打分的模型">
        <span title="选多套时各模型分别打分，综合分取平均；分差 ≥ 20 分标为“模型分歧”。每套各调用一次（各自计费）。">一起打分的模型</span>
        {profiles.profiles.map(item => <label key={item.id} className={rankIds.includes(item.id) ? "active" : ""}>
          <input type="checkbox" checked={rankIds.includes(item.id)} disabled={Boolean(busy)} onChange={() => void toggleRankModel(item.id)} />{item.name}<small>{item.model}</small></label>)}
        <small>综合分取平均，分差 ≥ 20 标“模型分歧”；每套各计费</small>
      </div>}
      {error && <div className="test-result fail" role="alert"><span />{error}</div>}
    </section>}

    {custom && <AiCustomBoard configured={configured} reload={reload} expectedModels={expectedModels} historyRanking={historyDay?.custom} historyDate={isHistory ? viewing.asOfDate : undefined}
      onOpen={onOpen} onChanged={loadHistory} live={live} quoteRefreshSeconds={quoteRefreshSeconds} />}

    {!custom && shownSummary && <article className="panel ai-summary" aria-label="AI 每日总结">
      <h3>{shownSummary.headline || "本轮选股总结"}<small>{shownSummary.asOfDate ? `数据日 ${shownSummary.asOfDate} · ` : ""}{stamp(shownSummary)}</small></h3>
      {shownSummary.market && <p>{shownSummary.market}</p>}
      {!!shownSummary.themes.length && <div className="ai-summary-row"><b>集中方向</b><ul>{shownSummary.themes.map(theme => <li key={theme.name}><em>{theme.name}</em>{theme.stocks.length ? `：${theme.stocks.join("、")}` : ""}</li>)}</ul></div>}
      {!!shownSummary.focus.length && <div className="ai-summary-row"><b>重点跟踪</b><ul>{shownSummary.focus.map(item => <li key={item.code}>{onOpen ? <button type="button" onClick={() => open(item)}>{item.name}</button> : <em>{item.name}</em>}：{item.reason}</li>)}</ul></div>}
      {!!shownSummary.risks.length && <div className="ai-summary-row"><b>风险提示</b><ul>{shownSummary.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></div>}
    </article>}

    {!custom && (report || isHistory) && <section className="panel ai-ranking ai-picks-board" aria-label="AI 打分榜">
      <div className="ai-ranking-head"><span><b>AI 打分榜</b>{shownRanking ? ` · ${multi ? "多模型评分" : "单模型评分"} · AI 已返回 ${shownRanking.evaluated} 只 · ${stamp(shownRanking)}` : isHistory ? " · 这一天没有保存打分" : " · 还没打分，下表是候选股"}</span>
        {shownRanking && <div role="group" aria-label="按评级筛选">{RATING_FILTERS.map(item => <button key={item} type="button" className={filter === item ? "active" : ""} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}{item !== "全部" ? ` ${shownRanking.items.filter(row => !row.fallback && row.rating === item).length}` : ""}</button>)}</div>}</div>
      {!!shownRanking?.failed?.length && <div className="test-result fail" role="status"><span />{shownRanking.failed.join("、")} 的日线没读到，这次没有参与打分，可稍后再点「AI 打分」补上。</div>}
      {partialModels.length > 0 && <div className="test-result fail" role="status"><span />{partialModels.map(item => `${item.name} 有 ${item.missed} 只这一批没有返回`).join("；")}，这些股票按基础分显示或暂缺 AI 点评，可点「重新打分」再试。</div>}
      {failedModels.length > 0 && <div className="test-result fail" role="alert"><span />{failedModels.map(item => `${item.name} 打分失败：${item.error || "未知原因"}`).join("；")}{shownRanking?.items.length ? "。请核对模型完成情况。" : ""}</div>}
      <div className="ai-board-toolbar">
      {selectable && (!!candidates.length || removedCount > 0) && <AiSelectionBar selection={selection} removeLabel="移除" removeDisabled={Boolean(busy)} hint="勾选几只可以只给它们打分；点行首 × 把股票从候选里移除（不影响策略选股结果）"
        onRemoveSelected={() => { if (busy) return; updateExcluded([...excluded, ...selection.list]); selection.clear(); }} removedCount={removedCount} onRestore={() => { if (!busy) updateExcluded([]); }} />}
      {!isHistory && !!pageRows.length && <SelectionQuoteControls total={pageRows.length} loading={quotes.loading} live={live} seconds={quotes.refreshSeconds} failed={Object.values(quotes.entries).filter(entry => entry.error).length} onRefresh={quotes.refresh} />}
      </div>
      <div className="strategy-stock-table" tabIndex={0} role="region" aria-label="AI 打分榜表格，可横向滚动">
        <table className="ai-ranking-table ai-picks-table"><thead><tr>
          {selectable && <AiSelectAllHeader selection={selection} pageCodes={pageRows.map(row => row.code)} />}
          <th scope="col">{multi ? "综合分" : "AI 分"}</th>{multi && <th scope="col">各模型</th>}<th scope="col">股票</th><th scope="col">日K</th>{!isHistory && <th scope="col">现价</th>}{hasDims && <th scope="col">各维度</th>}</tr></thead>
          <tbody>{pageRows.map(row => <Fragment key={row.code}><tr className={`${onOpen ? "clickable" : ""}${selection.selected.has(row.code) ? " selected" : ""}${row.ai ? " has-comment" : ""}`} onClick={() => open({ code: row.code, name: row.name, secid: row.source?.secid })}>
            {selectable && <AiSelectCell selection={selection} code={row.code} name={row.name} removeLabel="从候选移除" removeDisabled={Boolean(busy)} onRemove={() => { if (!busy) updateExcluded([...excluded, row.code]); }} />}
            <td>{row.ai ? <AiScoreCell item={row.ai} expectedModels={isHistory ? 1 : expectedModels} /> : <small>未打分</small>}</td>
            {multi && <td className="ai-model-scores">{(row.ai?.scores || []).map(score => <span key={score.id} className={ratingTone(score.rating)}>{score.name} <b>{score.score}</b></span>)}
              {row.ai?.disagreement && <em className="ai-disagreement" title={`各模型分差 ${row.ai.spread} 分`}>模型分歧</em>}</td>}
            <th scope="row" className="strategy-stock-name"><b>{row.name}</b><small>{row.code}</small>{row.source && <small className="strategy-stock-reasons">{row.source.strategies.map(item => item.name).slice(0, 3).join(" · ")}{row.source.strategies.length > 3 ? ` 等 ${row.source.strategies.length} 个策略` : ""}</small>}</th>
            <td><SelectionKline security={toSecurity({ code: row.code, name: row.name, secid: row.source?.secid })} signalDate={row.source?.signalDate} /></td>
            {!isHistory && <td className="strategy-stock-quote"><SelectionQuotePrice entry={quotes.entries[row.code]} selectionClose={row.source?.latest} /></td>}
            {hasDims && <td className="ai-dims-cell"><AiDimChips dims={row.ai?.dims} /></td>}
          </tr>
          <AiCommentRow ai={row.ai} colSpan={(selectable ? 1 : 0) + (multi ? 1 : 0) + (isHistory ? 0 : 1) + (hasDims ? 1 : 0) + 3} selected={selection.selected.has(row.code)}
            onOpen={onOpen ? () => open({ code: row.code, name: row.name, secid: row.source?.secid }) : undefined} /></Fragment>)}</tbody></table>
        {!pageRows.length && <p className="ai-selection-note">{shownRanking && filter !== "全部" ? `没有评级为「${filter}」的股票。` : isHistory ? "这一天没有保存打分结果。" : removedCount ? "候选股都已移除，点上方「恢复」放回来。" : dataState.state === "unavailable" ? "候选数据暂不可用，可刷新候选重试。" : "本轮没有选出股票，暂无可供 AI 评估的内容。"}</p>}
      </div>
      {boardRows.length > PAGE_SIZE && <div className="strategy-stock-pagination" aria-label="AI 打分榜分页"><span role="status" aria-live="polite">共 {boardRows.length} 只 · 第 {currentPage} / {totalPages} 页</span>
        <button type="button" className="secondary-btn" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <button type="button" className="secondary-btn" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}
      {!shownRanking && !isHistory && configured && !!picks.length && <p className="ai-selection-note">点「AI 打分」让 AI 给这些股票逐只打分并写看点、风险和次日关注点；打完后「策略选股」页的表格里也会显示 AI 分。每次生成调用一次模型（按量计费），结果按数据日保存在本机。</p>}
    </section>}

    {!custom && onOpenStrategies && <section className="panel ai-picks-draft" aria-label="用大白话建策略">
      <label><span><b><Wand2 size={15} />用大白话建策略</b><small>描述想要的选股条件，例如“近一周首板、回踩不破涨停低点、缩量，成交额至少 3 亿，不要北交所”。会打开「策略选股 → 我的策略」编辑器，由 AI 用条件库里已有的条件配好，你检查后再保存。</small></span>
        <textarea aria-label="用大白话描述选股条件" rows={2} maxLength={400} value={strategyText} onChange={event => setStrategyText(event.target.value)} placeholder="描述你想要的选股条件…" /></label>
      <button type="button" className="secondary-btn" disabled={!configured || !strategyText.trim()} onClick={sendStrategy}><Sparkles size={15} />让 AI 配条件<ChevronRight size={15} /></button>
    </section>}

    <p className="ai-selection-note">AI 根据规则给出的数据判断，可能出错，仅供参考，不构成投资建议；股票是否入选仍由规则决定。</p>
  </div>;
}
