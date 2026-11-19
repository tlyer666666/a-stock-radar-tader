import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Briefcase, Eye, LoaderCircle, Plus, RefreshCw, Search, Settings, Sparkles, Target, Trash2 } from "lucide-react";
import { ConfirmDialog, type ConfirmDialogRequest } from "../../components/terminal/ConfirmDialog";
import { saveQuickObservationPlansBatch } from "../../trendWorkspace";
import { useSelectionQuotes } from "../strategy-selection/useSelectionQuotes";
import { SelectionQuoteControls, SelectionQuotePrice } from "../strategy-selection/SelectionQuoteCells";
import { SelectionKline } from "../strategy-selection/SelectionKline";
import { aiErrorMessage, buildAiBoardRows, ratingTone, secidFor } from "../strategy-selection/aiSelectionModel";
import { AI_CUSTOM_MAX, applyCustomListMutation, mergeNotice, profileFacts } from "./aiCustomModel";
import { AiDimChips, AiScoreCell } from "./AiFrameworkParts";
import { AiScoringCoverage, AiSelectAllHeader, AiSelectCell, AiSelectionBar, scoreAction, scoringCoverage, useRowSelection } from "./AiRowSelection";
import { AiCommentRow } from "./AiCommentRow";

const RATING_FILTERS = ["全部", "重点关注", "关注", "观望", "回避"] as const;
const PAGE_SIZE = 20;
const toSecurity = (row: { code: string; name: string }): Security => ({ code: row.code, name: row.name, secid: secidFor(row.code), assetType: "stock" });
const stamp = (value: AiRanking) => `${value.model} · 数据日 ${value.asOfDate || "--"} · ${new Date(value.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}${value.cached ? " · 本机已保存" : ""}`;

/**
 * 「AI 选股 → 我的股票」：任意股票都能交给 AI 一起打分排名。
 * 清单可搜索添加，或一键导入自选板块 / 观察池 / 持仓（最多 40 只，只存代码和名称）。
 * 打分时软件先用日线给每只算体检数据，再交给勾选的几个模型一起打分。
 */
export function AiCustomBoard({ configured, reload, expectedModels = 1, historyRanking, historyDate, onOpen, onOpenSettings, onShowToast, onChanged, live = true, quoteRefreshSeconds = 15 }: {
  configured: boolean; reload: number; expectedModels?: number; historyRanking?: AiRanking | null | undefined; historyDate?: string | undefined;
  onOpen?: ((security: Security) => void) | undefined; onOpenSettings?: (() => void) | undefined; onShowToast?: ((message: string) => void) | undefined; onChanged?: (() => void) | undefined; live?: boolean; quoteRefreshSeconds?: number;
}) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai;
  const [list, setList] = useState<AiCustomStock[]>([]);
  const listRef = useRef<AiCustomStock[]>([]);
  const listReady = useRef(false);
  const mutationRevision = useRef(0);
  const pendingWrites = useRef(0);
  const writeTail = useRef<Promise<unknown>>(Promise.resolve());
  const [ranking, setRanking] = useState<AiRanking | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const cacheRevision = useRef(0);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Security[]>([]);
  const [suggestionQuery, setSuggestionQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState<{ request: ConfirmDialogRequest; codes: string[] } | null>(null);
  const [filter, setFilter] = useState<(typeof RATING_FILTERS)[number]>("全部");
  const [page, setPage] = useState(1);
  const searchSeq = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const composingRef = useRef(false);
  const isHistory = Boolean(historyDate);

  useEffect(() => {
    const current = ++generation.current;
    const cachedAt = cacheRevision.current;
    let active = true;
    const stop = () => { active = false; generation.current += 1; };
    setRanking(null); setFailed([]); setBusy(false); setError("");
    if (!api?.customList) return stop;
    const revision = mutationRevision.current;
    // An acknowledged write is authoritative. A reload started before it must
    // not replace that collection with an older snapshot.
    if (pendingWrites.current === 0) void api.customList().then(value => {
      if (active && revision === mutationRevision.current && pendingWrites.current === 0) {
        listRef.current = value; listReady.current = true; setList(value);
        setReadError("");
      }
    }).catch(reason => {
      if (active && revision === mutationRevision.current) setReadError(`清单读取失败：${aiErrorMessage(reason)}`);
    });
    void api.cachedCustom?.().then(value => { if (generation.current === current && cacheRevision.current === cachedAt) setRanking(value); }).catch(() => undefined /* optional cached custom ranking */);
    return stop;
  }, [api, reload]);

  useEffect(() => {
    const text = query.trim();
    const current = ++searchSeq.current;
    setSuggestions([]);
    setSuggestionQuery("");
    if (!text) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.stockApi.search(text).then(items => {
        if (cancelled || searchSeq.current !== current || queryRef.current.trim() !== text) return;
        setSuggestions((Array.isArray(items) ? items : []).filter(item => /^\d{6}$/.test(item.code) && (!item.assetType || item.assetType === "stock")).slice(0, 8));
        setSuggestionQuery(text);
      }).catch(() => {
        if (!cancelled && searchSeq.current === current) {
          setSuggestions([]);
          setSuggestionQuery("");
        }
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);
  useEffect(() => { setPage(1); }, [filter, historyDate, ranking]);

  const save = async (operation: AiCustomListMutation, describe: (result: AiCustomListMutationResult) => string) => {
    const mutate = api?.mutateCustomList;
    const replace = api?.saveCustomList;
    if (!mutate && !replace) return;
    if (!listReady.current) { setReadError("清单尚未读取完成，请稍后重试"); return; }
    mutationRevision.current++;
    pendingWrites.current++;
    const pending = writeTail.current.then(async () => {
      let result: AiCustomListMutationResult;
      if (mutate) result = await mutate(operation);
      else {
        result = applyCustomListMutation(listRef.current, operation);
        if (result.added || result.removed.length) result.list = await replace!(result.list);
      }
      listRef.current = result.list;
      setList(result.list);
      return result;
    });
    writeTail.current = pending.catch(() => undefined);
    try {
      const result = await pending;
      setNotice(describe(result)); setError(""); setReadError("");
    }
    catch (reason) { setError(aiErrorMessage(reason)); }
    finally { pendingWrites.current--; }
  };
  const add = (items: Array<{ code: string; name?: string | undefined }>, source: string) => {
    void save({ kind: "add", items }, result => mergeNotice(source, result));
  };
  const importFrom = async (kind: "favorites" | "watchlist" | "holdings") => {
    try {
      if (kind === "holdings") { add(await window.stockApi.getHoldings(), "持仓"); return; }
      const items: WatchItem[] = await window.stockApi.getWatchlist();
      add(kind === "favorites" ? items.filter(item => item.favorite || !item.autoAdded) : items, kind === "favorites" ? "自选监控" : "观察池");
    } catch (reason) { setError(aiErrorMessage(reason)); }
  };
  const run = async (force: boolean, codes?: string[]) => {
    if (!api?.rankCustom || busy || !list.length) return;
    const current = generation.current;
    cacheRevision.current += 1;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await api.rankCustom({ force, ...(codes?.length ? { codes } : {}) });
      if (generation.current !== current) return;
      setRanking(value); setFailed(value.failed || []);
      if (force && codes?.length) selection.clear();
      onChanged?.();
    } catch (reason) { if (generation.current === current) setError(aiErrorMessage(reason)); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const remove = (codes: string[], clearSelection = false) => {
    void save({ kind: "remove", codes }, result => result.removed.length === 1
      ? `已删除 ${result.removed[0]!.name}。` : `已删除 ${result.removed.length} 只。`);
    if (clearSelection) selection.clear();
  };

  const shown = isHistory ? historyRanking || null : ranking;
  const profileByCode = useMemo(() => new Map((shown?.profiles || []).map(item => [item.code, item])), [shown]);
  const sources = useMemo(() => isHistory ? [] : list, [isHistory, list]);
  const rows = useMemo(() => buildAiBoardRows(sources, shown, filter, !isHistory), [sources, shown, filter, isHistory]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const securities = useMemo(() => pageRows.map(toSecurity), [pageRows]);
  const quotes = useSelectionQuotes(securities, live && !isHistory, quoteRefreshSeconds);
  const seenQuotesRef = useRef<Record<string, number>>({});
  for (const [code, entry] of Object.entries(quotes.entries)) {
    const p = Number(entry?.quote?.latest);
    if (Number.isFinite(p) && p > 0) seenQuotesRef.current[code] = p;
  }
  const multi = (shown?.models?.length || 0) > 1;
  const hasDims = Boolean(shown?.items.some(item => item.dims?.length));
  const failedModels = (shown?.models || []).filter(item => !item.ok);
  const partialModels = (shown?.models || []).filter(item => item.ok && item.missed);
  const listCodes = useMemo(() => list.map(item => item.code), [list]);
  const selection = useRowSelection(isHistory ? [] : listCodes);
  const coverage = scoringCoverage(ranking, listCodes, expectedModels);
  const action = scoreAction({ selected: selection.list, scored: coverage.complete, total: listCodes, answered: coverage.answered });
  if (!api?.customList) return null;

  const visibleSuggestions = suggestionQuery === query.trim() ? suggestions : [];
  const selectSuggestion = (security: Security) => {
    add([security], "搜索");
    setQuery("");
    setSuggestions([]);
    setSuggestionQuery("");
  };
  const batchAddPlans = () => {
    if (typeof window === "undefined" || !window.localStorage || !selection.list.length) return;
    const itemByCode = new Map((shown?.items || []).map(item => [item.code, item]));
    const stockByCode = new Map(list.map(item => [item.code, item]));
    const inputs = selection.list.map(code => {
      const stock = stockByCode.get(code);
      const livePrice = Number(quotes.entries[code]?.quote?.latest);
      const cachedQuote = seenQuotesRef.current[code] ?? 0;
      const refPrice = Number.isFinite(livePrice) && livePrice > 0
        ? livePrice
        : cachedQuote > 0
          ? cachedQuote
          : profileByCode.get(code)?.latest;
      const aiItem = itemByCode.get(code);
      return {
        code,
        name: stock?.name || aiItem?.name || code,
        secid: secidFor(code),
        referencePrice: refPrice,
        asOf: shown?.asOfDate,
        reason: aiItem?.highlights || (aiItem ? `AI评分 ${aiItem.score} (${aiItem.rating})` : "我的股票关注")
      };
    });
    const res = saveQuickObservationPlansBatch(window.localStorage, inputs);
    if (res.created.length + res.existing.length > 0) selection.clear();
    if (res.storageError) {
      setNotice(res.storageError);
      onShowToast?.(res.storageError);
      return;
    }
    const parts = [
      res.created.length ? `新增 ${res.created.length} 只观察计划` : "",
      res.existing.length ? `${res.existing.length} 只已在计划中` : "",
      res.missingPrice.length ? `${res.missingPrice.length} 只暂缺参考价` : ""
    ].filter(Boolean);
    const msg = parts.length ? `批量流转完成：${parts.join("，")}。` : "未生成新的观察计划。";
    setNotice(msg);
    onShowToast?.(msg);
  };

  return <>
    {!isHistory && <section className="panel ai-custom-editor" aria-label="我的股票清单">
      <div className="ai-custom-editor-head">
        <span><b>我的股票</b><small>{list.length} / {AI_CUSTOM_MAX} 只 · 任意股票都能加，打分时软件先用日线算体检数据再交给 AI</small></span>
        <div className="ai-selection-actions">
          <button type="button" className="secondary-btn" onClick={() => void importFrom("favorites")}><Bookmark size={15} />导入自选监控</button>
          <button type="button" className="secondary-btn" onClick={() => void importFrom("watchlist")}><Eye size={15} />导入观察池</button>
          <button type="button" className="secondary-btn" onClick={() => void importFrom("holdings")}><Briefcase size={15} />导入持仓</button>
          {!!list.length && <button type="button" className="secondary-btn danger-btn" disabled={busy} onClick={() => setConfirmClear({
            codes: listCodes,
            request: {
              title: `清空「我的股票」清单里的 ${list.length} 只股票？`,
              message: "清空后需要重新搜索或导入股票；已保存的历史打分记录不受影响。",
              confirmLabel: "清空清单",
              tone: "danger"
            }
          })}><Trash2 size={15} />清空</button>}
          {!configured && onOpenSettings && <button type="button" className="secondary-btn" onClick={onOpenSettings}><Settings size={15} />前往 AI 设置</button>}
          <button type="button" className="primary-btn" onClick={() => void run(action.force, action.only)} disabled={!configured || busy || !list.length}>
            {busy ? <LoaderCircle size={15} className="spin" /> : action.force && !action.only ? <RefreshCw size={15} /> : <Sparkles size={15} />}{busy ? "读取日线并打分…" : action.label}</button>
        </div>
      </div>
      <div className="ai-custom-search">
        <label><Search size={15} /><input aria-label="搜索股票加入清单" placeholder="输入代码、名称或拼音，回车加入第一只" value={query}
          onChange={event => { searchSeq.current += 1; setQuery(event.target.value); setSuggestions([]); setSuggestionQuery(""); }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={event => {
            if (event.key !== "Enter") return;
            if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (suggestionQuery === query.trim() && visibleSuggestions[0]) {
              event.preventDefault();
              selectSuggestion(visibleSuggestions[0]);
            }
          }} /></label>
        {!!visibleSuggestions.length && <ul role="listbox" aria-label="搜索结果">{visibleSuggestions.map(item => <li key={item.code}>
          <button type="button" role="option" aria-selected={false} onClick={() => selectSuggestion(item)}><Plus size={14} /><b>{item.name}</b><small>{item.code}</small></button></li>)}</ul>}
      </div>
      {!list.length && <p className="ai-selection-note">清单是空的：搜索添加股票，或一键导入自选监控、观察池、持仓。</p>}
      {notice && <p className="ai-selection-note" role="status">{notice}</p>}
      {(error || readError) && <div className="test-result fail" role="alert"><span />{error || readError}{error && onOpenSettings && <> <button type="button" className="link-btn" onClick={onOpenSettings}>前往 AI 设置</button></>}</div>}
      {failed.length > 0 && <div className="test-result fail" role="alert"><span />{failed.join("、")} 的日线没读到，这次没有参与打分。</div>}
    </section>}

    <section className="panel ai-ranking ai-picks-board" aria-label="我的股票 AI 打分榜">
      <div className="ai-ranking-head"><span><b>我的股票 · AI 打分榜</b>{shown ? ` · ${multi ? "多模型评分" : "单模型评分"} · AI 已返回 ${shown.evaluated} 只 · ${stamp(shown)}` : isHistory ? " · 这一天没有保存「我的股票」打分" : " · 还没打分"}
        {shown?.outcomeSummary && <em className="ai-disagreement" title={`基于本机已缓存日线核对 ${shown.outcomeSummary.evaluatedCount} 只`}>
          {[
            `后验(${shown.outcomeSummary.evaluatedCount}只)`,
            shown.outcomeSummary.t1 ? `T+1胜率${shown.outcomeSummary.t1.winRatePct}%` : "",
            shown.outcomeSummary.t5 ? `T+5胜率${shown.outcomeSummary.t5.winRatePct}%` : "",
            shown.outcomeSummary.avgDrawdownPct !== null && shown.outcomeSummary.avgDrawdownPct !== undefined ? `均回撤${shown.outcomeSummary.avgDrawdownPct}%` : ""
          ].filter(Boolean).join(" · ")}
        </em>}</span>
        {shown && <div role="group" aria-label="按评级筛选">{RATING_FILTERS.map(item => <button key={item} type="button" className={filter === item ? "active" : ""} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}{item !== "全部" ? ` ${shown.items.filter(row => !row.fallback && row.rating === item).length}` : ""}</button>)}</div>}</div>
      {!isHistory && ranking && <AiScoringCoverage coverage={coverage} expectedModels={expectedModels} />}
      {partialModels.length > 0 && <div className="test-result fail" role="status"><span />{partialModels.map(item => `${item.name} 有 ${item.missed} 只这一批没有返回`).join("；")}，这些股票按基础分显示或暂缺 AI 点评，可点「重新打分」再试。</div>}
      {failedModels.length > 0 && <div className="test-result fail" role="alert"><span />{failedModels.map(item => `${item.name} 打分失败：${item.error || "未知原因"}`).join("；")}{onOpenSettings && <> <button type="button" className="link-btn" onClick={onOpenSettings}>前往 AI 设置</button></>}</div>}
      <div className="ai-board-toolbar">
      {!isHistory && !!list.length && <AiSelectionBar selection={selection} removeLabel="删除" hint="勾选几只可以只给它们打分；点行首 × 从清单删除"
        onRemoveSelected={() => remove(selection.list, true)} />}
      {!isHistory && selection.list.length > 0 && <button type="button" className="secondary-btn" disabled={busy} onClick={batchAddPlans}><Target size={14} />批量+观察计划（{selection.list.length} 只）</button>}
      {!isHistory && !!pageRows.length && <SelectionQuoteControls total={pageRows.length} loading={quotes.loading} live={live} seconds={quotes.refreshSeconds} failed={Object.values(quotes.entries).filter(entry => entry.error).length} onRefresh={quotes.refresh} />}
      </div>
      {!!pageRows.length && <div className="strategy-stock-table" tabIndex={0} role="region" aria-label="我的股票打分表格，可横向滚动">
        <table className="ai-ranking-table ai-picks-table"><thead><tr>
          {!isHistory && <AiSelectAllHeader selection={selection} pageCodes={pageRows.map(row => row.code)} />}
          <th scope="col">{multi ? "综合分" : "AI 分"}</th>{multi && <th scope="col">各模型</th>}<th scope="col">股票</th><th scope="col">日K</th>{!isHistory && <th scope="col">现价</th>}{hasDims && <th scope="col">各维度</th>}</tr></thead>
          <tbody>{pageRows.map(row => {
            const profile = profileByCode.get(row.code);
            const selected = selection.selected.has(row.code);
            const facts = profile ? profileFacts(profile).join(" · ") : "";
            return <Fragment key={row.code}><tr className={`${onOpen ? "clickable" : ""}${selected ? " selected" : ""}${row.ai || facts ? " has-comment" : ""}`} onClick={() => onOpen?.(toSecurity(row))}>
              {!isHistory && <AiSelectCell selection={selection} code={row.code} name={row.name} removeLabel="从清单删除" onRemove={() => remove([row.code])} />}
              <td>{row.ai ? <AiScoreCell item={row.ai} expectedModels={isHistory ? (shown?.models?.length || 1) : expectedModels} /> : <small>未打分</small>}</td>
              {multi && <td className="ai-model-scores">{(row.ai?.scores || []).map(score => <span key={score.id} className={ratingTone(score.rating)}>{score.name} <b>{score.score}</b></span>)}
                {row.ai?.disagreement && <em className="ai-disagreement" title={`各模型分差 ${row.ai.spread} 分`}>模型分歧</em>}</td>}
              <th scope="row" className="strategy-stock-name">{onOpen ? <button type="button" className="strategy-security-link" onClick={event => { event.stopPropagation(); onOpen(toSecurity(row)); }} aria-label={`查看 ${row.name} ${row.code} 个股分析`}><b>{row.name}</b><small>{row.code}{profile?.industry ? ` · ${profile.industry}` : ""}</small></button> : <><b>{row.name}</b><small>{row.code}{profile?.industry ? ` · ${profile.industry}` : ""}</small></>}</th>
              <td><SelectionKline security={toSecurity(row)} /></td>
              {!isHistory && <td className="strategy-stock-quote"><SelectionQuotePrice entry={quotes.entries[row.code]} selectionClose={profile?.latest ?? null} /></td>}
              {hasDims && <td className="ai-dims-cell"><AiDimChips dims={row.ai?.dims} /></td>}
            </tr>
            <AiCommentRow ai={row.ai} colSpan={(isHistory ? 0 : 2) + (multi ? 1 : 0) + (hasDims ? 1 : 0) + 3} extra={facts ? { label: "体检数据", text: facts } : undefined} selected={selected}
              onOpen={onOpen ? () => onOpen(toSecurity(row)) : undefined} /></Fragment>;
          })}</tbody></table>
      </div>}
      {!pageRows.length && <p className="ai-selection-note">{shown && filter !== "全部" ? `没有评级为「${filter}」的股票。` : isHistory ? "这一天没有保存「我的股票」打分。" : "清单里还没有股票。"}</p>}
      {rows.length > PAGE_SIZE && <div className="strategy-stock-pagination" aria-label="我的股票分页"><span role="status" aria-live="polite">共 {rows.length} 只 · 第 {currentPage} / {totalPages} 页</span>
        <button type="button" className="secondary-btn" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <button type="button" className="secondary-btn" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}
      <p className="ai-selection-note">「选股收盘」列显示的是打分时日线最后一根的收盘价。发给 AI 的只有代码、名称、行业、行情指标和公开的公司公告标题，不含持仓数量或成本。</p>
    </section>
    <ConfirmDialog request={confirmClear?.request || null} onResolve={confirmed => {
      setConfirmClear(null);
      if (confirmed && confirmClear) void save({ kind: "remove", codes: confirmClear.codes }, result => result.list.length
        ? `已删除 ${result.removed.length} 只，清单还剩 ${result.list.length} 只。` : "已清空清单。");
    }} />
  </>;
}
