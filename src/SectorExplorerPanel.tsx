import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, Layers3, RefreshCw, Search, X } from 'lucide-react';
import type { SectorExplorerApi, SectorExplorerCatalog, SectorExplorerDetail, SectorExplorerEntry, SectorExplorerMember } from './sectorExplorerTypes';
import { eligibleSignalTestStocks } from './signalTestRequest';
import './sector-explorer.css';
type Filter = 'all' | SectorExplorerEntry['kind'];
const tabs: {
    id: Filter;
    label: string;
}[] = [{ id: 'all', label: '全部' }, { id: 'classification', label: '行业分类' }, { id: 'industry', label: '行业行情' }, { id: 'concept', label: '概念板块' }];
const statusName = { ready: '已获取', partial: '部分资料', unavailable: '来源不可用', stale: '旧资料' };
const numberText = (value: number | null, suffix = '') => value !== null && Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : '—';
const amountText = (value: number | null) => value === null ? '—' : value >= 1e8 ? `${(value / 1e8).toFixed(2)} 亿` : `${(value / 1e4).toFixed(2)} 万`;
const localTime = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未提供';
function openSource(url: string) { if (typeof window !== 'undefined')
    void window.stockApi?.openExternal(url); }
function toSecurity(member: SectorExplorerMember): Security { return { code: member.code, name: member.name, secid: member.secid, thscode: `${member.code}.${member.secid.startsWith('1.') ? 'SH' : /^[489]/.test(member.code) ? 'BJ' : 'SZ'}`, assetType: 'stock' }; }
export function filterSectorEntries(entries: SectorExplorerEntry[], query: string, kind: Filter) {
    const needle = query.trim().toLowerCase();
    const order = { classification: 0, industry: 1, concept: 2, research: 3 };
    return entries.filter(entry => entry.kind !== 'research' && (kind === 'all' || entry.kind === kind) && `${entry.name} ${entry.path.join(' ')} ${entry.code}`.toLowerCase().includes(needle))
        .sort((a, b) => order[a.kind] - order[b.kind] || (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
}
export function SectorExplorerDetailView({ detail, onOpenStock, onClassifications }: {
    detail: SectorExplorerDetail;
    onOpenStock: (stock: Security) => void;
    onClassifications?: (code: string) => void;
}) {
    const [memberQuery, setMemberQuery] = useState('');
    const [limit, setLimit] = useState(50);
    const rows = detail.members.filter(row => `${row.code} ${row.name}`.includes(memberQuery.trim()));
    return <div className="sector-explorer-detail">
    <div className="sector-explorer-detail-title"><div><h3>{detail.entry.name}</h3>{detail.entry.path.length > 1 && <p>{detail.entry.path.join(' › ')}</p>}</div><span className={`sector-explorer-status ${detail.status}`}>{statusName[detail.status]}</span></div>
    <div className="sector-explorer-date"><span>{detail.asOf ? `行情日期：${detail.asOf}` : '行情日期未提供'}</span>{detail.reportDate && <span>同行对比报告期：{detail.reportDate}</span>}</div>
    {detail.metrics && <div className="sector-explorer-metrics" aria-label="源页板块快照">
      <div><span>源页板块涨幅</span><strong className={detail.metrics.changePercent === null ? '' : detail.metrics.changePercent >= 0 ? 'rise' : 'fall'}>{numberText(detail.metrics.changePercent, '%')}</strong></div>
      <div><span>源页成交额</span><strong>{amountText(detail.metrics.amount)}</strong></div>
      <div><span>上涨 / 下跌家数</span><strong>{detail.metrics.rising ?? '—'} / {detail.metrics.falling ?? '—'}</strong></div>
    </div>}
    <div className="sector-explorer-coverage"><strong>已载入 {detail.coverage.loaded} 只</strong><span>{detail.coverage.complete ? '源页分页已取齐' : '数据不完整'}</span></div>
    <div className="sector-explorer-member-heading"><h4>{detail.entry.kind === 'classification' ? '报告期同行名单' : detail.entry.kind === 'research' ? '代表性公司' : '已获取成分'}</h4><input aria-label="筛选成分股" placeholder="名称 / 代码" value={memberQuery} onChange={event => { setMemberQuery(event.target.value); setLimit(50); }}/></div>
    <div className="sector-explorer-table-wrap"><table><thead><tr><th>股票</th><th>源页现价</th><th>涨跌幅</th><th>成交额</th><th>换手率</th></tr></thead><tbody>{rows.slice(0, limit).map(row => <tr key={row.code}><td><button type="button" onClick={() => onOpenStock(toSecurity(row))}><strong>{row.name}</strong><code>{row.code}</code><ChevronRight size={12}/></button>{onClassifications && <button className="sector-explorer-peer-link" type="button" onClick={() => onClassifications(row.code)} aria-label={`查看${row.name}行业分类`}>查行业</button>}</td><td>{numberText(row.latest)}</td><td className={row.changePercent === null ? '' : row.changePercent >= 0 ? 'rise' : 'fall'}>{numberText(row.changePercent, '%')}</td><td>{amountText(row.amount)}</td><td>{numberText(row.turnover, '%')}</td></tr>)}</tbody></table>{!rows.length && <p className="sector-explorer-empty">{detail.status === 'unavailable' ? '来源暂不可用，可打开源页或稍后刷新。' : '没有可显示的匹配股票。'}</p>}</div>
    {rows.length > limit && <button type="button" className="sector-explorer-more" onClick={() => setLimit(value => value + 50)}>再显示 50 只（共 {rows.length} 只）</button>}
    <details className="sector-explorer-data-details"><summary>来源与覆盖</summary>
      <div className="sector-explorer-source"><button type="button" onClick={() => openSource(detail.entry.sourceUrl)}>打开原始来源 <ArrowUpRight size={14}/></button><span>抓取时间：{localTime(detail.fetchedAt)}</span></div>
      <p>{detail.entry.classification}</p>
      <div className="sector-explorer-coverage"><span>{detail.coverage.declared !== null ? `源页声明 ${detail.coverage.declared} 家` : '成分总数未提供'}</span><span>页面 {detail.coverage.pagesLoaded} / {detail.coverage.pagesTotal ?? '未知'}</span>{detail.coverage.excluded > 0 && <span>ST / 非 A 股剔除 {detail.coverage.excluded}</span>}{detail.coverage.invalid > 0 && <span>无效或冲突 {detail.coverage.invalid}</span>}</div>
      {detail.coverage.scope && <p>{detail.coverage.scope}</p>}
      {detail.warnings.length > 0 && <div className="sector-explorer-notes" role="note">{detail.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>}
      {detail.evidence.length > 0 && <section className="sector-explorer-evidence"><h4>资料依据</h4>{detail.evidence.map(item => <div key={item.url}><button type="button" onClick={() => openSource(item.url)}>{item.title}<ArrowUpRight size={14}/></button><time>{item.date}</time><p>{item.summary}</p></div>)}</section>}
    </details>
  </div>;
}
export default function SectorExplorerPanel({ onOpenStock }: {
    onOpenStock: (stock: Security) => void;
}) {
    const [catalog, setCatalog] = useState<SectorExplorerCatalog | null>(null);
    const [discoveredEntries, setDiscoveredEntries] = useState<SectorExplorerEntry[]>([]);
    const [detail, setDetail] = useState<SectorExplorerDetail | null>(null);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [selected, setSelected] = useState('');
    const [stockQuery, setStockQuery] = useState('');
    const [stock, setStock] = useState<Security | null>(null);
    const [stockChoices, setStockChoices] = useState<Security[]>([]);
    const [stockSearchBusy, setStockSearchBusy] = useState(false);
    const [stockSearchError, setStockSearchError] = useState('');
    const [stockSearched, setStockSearched] = useState(false);
    const [stockExpanded, setStockExpanded] = useState(false);
    const [stockCursor, setStockCursor] = useState(-1);
    const [composing, setComposing] = useState(false);
    const [classificationBusy, setClassificationBusy] = useState(false);
    const [catalogBusy, setCatalogBusy] = useState(false);
    const [detailBusy, setDetailBusy] = useState(false);
    const [error, setError] = useState('');
    const [listLimit, setListLimit] = useState(60);
    const stockApi = typeof window === 'undefined' ? null : window.stockApi;
    const api = stockApi as unknown as SectorExplorerApi | null;
    const current = useRef({ catalog: '', detail: '', classification: '', alive: true });
    const sequence = useRef(0);
    const stockSearchGeneration = useRef(0);
    const stockListId = useId();
    const stockInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const generation = ++stockSearchGeneration.current;
        const needle = stockQuery.trim();
        if (!needle || stock || composing || !stockExpanded) {
            setStockSearchBusy(false);
            return;
        }
        setStockSearchBusy(true);
        setStockSearchError('');
        setStockSearched(false);
        const timer = window.setTimeout(() => {
            Promise.resolve().then(() => {
                if (!stockApi?.search) throw new Error('当前连接未提供股票搜索接口。');
                return stockApi.search(needle);
            }).then(rows => {
                if (generation !== stockSearchGeneration.current) return;
                setStockChoices(eligibleSignalTestStocks(rows));
                setStockSearched(true);
            }).catch(reason => {
                if (generation !== stockSearchGeneration.current) return;
                setStockChoices([]);
                setStockSearchError(reason instanceof Error ? reason.message : String(reason));
            }).finally(() => {
                if (generation === stockSearchGeneration.current) setStockSearchBusy(false);
            });
        }, 250);
        return () => { window.clearTimeout(timer); stockSearchGeneration.current += 1; };
    }, [stockApi, stockQuery, stock, composing, stockExpanded]);
    const closeStockSearch = () => {
        stockSearchGeneration.current += 1;
        setStockExpanded(false);
        setStockSearchBusy(false);
        setStockCursor(-1);
    };
    const selectStock = (security: Security) => {
        closeStockSearch();
        setStock(security);
        setStockQuery(`${security.name} ${security.code}`);
        setStockChoices([]);
        setStockSearchError('');
        setStockSearched(false);
        setError('');
    };
    const loadCatalog = useCallback(async (forceRefresh = false) => {
        if (!api?.getSectorCatalog) {
            setError('当前连接未提供细分板块接口。');
            return;
        }
        const state = current.current;
        if (state.catalog)
            void api.cancelSectorRequest(state.catalog).catch(() => { });
        const requestId = `sector-catalog-${Date.now()}-${++sequence.current}`;
        state.catalog = requestId;
        setCatalogBusy(true);
        setError('');
        try {
            const value = await api.getSectorCatalog({ requestId, forceRefresh });
            if (state.alive && state.catalog === requestId)
                setCatalog(value);
        }
        catch (e) {
            if (state.alive && state.catalog === requestId)
                setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            if (state.alive && state.catalog === requestId) {
                state.catalog = '';
                setCatalogBusy(false);
            }
        }
    }, [api]);
    useEffect(() => { current.current.alive = true; void loadCatalog(); const state = current.current; return () => { state.alive = false; if (api)
        for (const id of [state.catalog, state.detail, state.classification])
            if (id)
                void api.cancelSectorRequest(id).catch(() => { }); }; }, [api, loadCatalog]);
    const invalidateClassification = () => {
        const state = current.current;
        const id = state.classification;
        state.classification = '';
        setClassificationBusy(false);
        if (id && api) void api.cancelSectorRequest(id).catch(() => {});
    };
    const loadDetail = async (entry: SectorExplorerEntry, forceRefresh = false) => {
        invalidateClassification();
        closeStockSearch();
        if (!api)
            return;
        const state = current.current;
        if (state.detail)
            void api.cancelSectorRequest(state.detail).catch(() => { });
        const requestId = `sector-detail-${Date.now()}-${++sequence.current}`;
        state.detail = requestId;
        setSelected(entry.id);
        setDetail(null);
        setDetailBusy(true);
        setError('');
        try {
            const value = await api.getSectorDetail({ id: entry.id, forceRefresh, requestId });
            if (state.alive && state.detail === requestId)
                setDetail(value);
        }
        catch (e) {
            if (state.alive && state.detail === requestId)
                setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            if (state.alive && state.detail === requestId) {
                state.detail = '';
                setDetailBusy(false);
            }
        }
    };
    const discover = async (code: string) => {
        if (!api?.getSectorClassifications) {
            setError('当前连接未提供证券行业查询接口。');
            return;
        }
        if (!/^\d{6}$/.test(code)) {
            setError('请从搜索结果中选择股票。');
            return;
        }
        closeStockSearch();
        const state = current.current;
        if (state.classification)
            void api.cancelSectorRequest(state.classification).catch(() => { });
        const requestId = `sector-classification-${Date.now()}-${++sequence.current}`;
        state.classification = requestId;
        setClassificationBusy(true);
        setError('');
        try {
            const value = await api.getSectorClassifications({ code, requestId });
            if (!state.alive || state.classification !== requestId)
                return;
            if (!value.entries.length) {
                setError(value.warnings.join('；') || '该证券行业字段暂不可用。');
                return;
            }
            setDiscoveredEntries(previous => {
                const merged = new Map(previous.map(entry => [entry.id, entry]));
                for (const entry of value.entries)
                    merged.set(entry.id, entry);
                return [...merged.values()];
            });
            setFilter('classification');
            setQuery('');
            setListLimit(60);
            const deepest = [...value.entries].sort((a, b) => (b.level ?? 0) - (a.level ?? 0))[0];
            if (deepest)
                void loadDetail(deepest);
        }
        catch (e) {
            if (state.alive && state.classification === requestId)
                setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            if (state.alive && state.classification === requestId) {
                state.classification = '';
                setClassificationBusy(false);
            }
        }
    };
    // Single-stock discoveries supplement navigation; public-directory coverage
    // remains scoped to the provider response and is never rewritten by this merge.
    const entries = useMemo(() => {
        const merged = new Map(discoveredEntries.map(entry => [entry.id, entry]));
        for (const entry of catalog?.entries || []) merged.set(entry.id, entry);
        return [...merged.values()];
    }, [catalog, discoveredEntries]);
    const filtered = useMemo(() => filterSectorEntries(entries, query, filter), [entries, query, filter]);
    const changeStockQuery = (value: string) => {
        invalidateClassification();
        stockSearchGeneration.current += 1;
        setStockQuery(value);
        setStock(null);
        setStockChoices([]);
        setStockCursor(-1);
        setStockSearchError('');
        setStockSearched(false);
        setStockExpanded(true);
        setError('');
    };
    const selectedEntry = entries.find(entry => entry.id === selected) || detail?.entry;
    return <section className="sector-explorer" aria-label="细分板块资料浏览器">
    <header className="sector-explorer-heading"><h2><Layers3 size={22}/>同花顺板块</h2><div className="sector-explorer-actions"><button type="button" onClick={() => void loadCatalog(true)} disabled={catalogBusy}><RefreshCw size={16}/>{catalogBusy ? '读取目录…' : '刷新目录'}</button>{(catalogBusy || detailBusy || classificationBusy) && <button type="button" onClick={() => { closeStockSearch(); const state = current.current; for (const id of [state.catalog, state.detail, state.classification])
        if (id)
            void api?.cancelSectorRequest(id).catch(() => {}); state.catalog = ''; state.detail = ''; state.classification = ''; setCatalogBusy(false); setDetailBusy(false); setClassificationBusy(false); }}><X size={16}/>取消</button>}</div></header>
    {error && <p role="alert" className="sector-explorer-error">{error}</p>}
    <div className="sector-explorer-layout"><aside className="sector-explorer-directory"><div className="sector-directory-tools">    <div className="sector-explorer-toolbar"><label><Search size={17}/><input aria-label="搜索细分板块" placeholder="搜索行业或概念名称" value={query} onChange={event => { invalidateClassification(); closeStockSearch(); setQuery(event.target.value); setFilter('all'); setListLimit(60); }}/>{query && <button type="button" aria-label="清空搜索" onClick={() => { invalidateClassification(); setQuery(''); }}><X size={16}/></button>}</label><div className="sector-explorer-tabs" aria-label="板块来源分类">{tabs.map(tab => <button type="button" key={tab.id} aria-pressed={filter === tab.id} onClick={() => { invalidateClassification(); closeStockSearch(); setFilter(tab.id); setListLimit(60); }}>{tab.label}</button>)}</div></div>
    <form className="sector-explorer-discover" onSubmit={event => { event.preventDefault(); if (!composing) void discover(stock?.code || stockQuery.trim()); }}>
      <label htmlFor="sector-stock-code">股票查行业</label>
      <div className="sector-explorer-stock-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) closeStockSearch(); }}>
        <div className="sector-explorer-stock-input"><input ref={stockInput} id="sector-stock-code" role="combobox" aria-label="股票名称或代码" autoComplete="off" placeholder="股票名称或代码" value={stockQuery}
          aria-autocomplete="list" aria-controls={stockListId} aria-expanded={stockExpanded && stockChoices.length > 0}
          aria-activedescendant={stockExpanded && stockCursor >= 0 && stockChoices[stockCursor] ? `${stockListId}-${stockCursor}` : undefined}
          onFocus={() => setStockExpanded(true)} onChange={event => changeStockQuery(event.target.value)}
          onCompositionStart={() => { stockSearchGeneration.current += 1; setComposing(true); setStockChoices([]); }} onCompositionEnd={() => setComposing(false)}
          onKeyDown={event => {
            if (composing || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
            if (event.key === 'Escape') { event.preventDefault(); closeStockSearch(); }
            if (event.key === 'ArrowDown' && stockChoices.length) { event.preventDefault(); setStockExpanded(true); setStockCursor(value => (value + 1) % stockChoices.length); }
            if (event.key === 'ArrowUp' && stockChoices.length) { event.preventDefault(); setStockExpanded(true); setStockCursor(value => value <= 0 ? stockChoices.length - 1 : value - 1); }
            if (event.key === 'Enter' && stockExpanded && stockChoices.length) { event.preventDefault(); const choice = stockChoices[Math.max(0, stockCursor)]; if (choice) selectStock(choice); }
          }}/>{stockQuery && <button type="button" aria-label="清空股票查询" onClick={() => changeStockQuery('')}><X size={16}/></button>}</div>
        {stockExpanded && stockChoices.length > 0 && <div id={stockListId} className="sector-explorer-stock-options" role="listbox" aria-label="股票搜索结果">{stockChoices.map((security, index) => <button type="button" role="option" id={`${stockListId}-${index}`} aria-selected={stockCursor === index} key={security.secid} onMouseDown={event => event.preventDefault()} onClick={() => selectStock(security)}><strong>{security.name}</strong><code>{security.code}</code></button>)}</div>}
      </div>
      <button type="submit" disabled={classificationBusy || composing || !stockQuery.trim()}>{classificationBusy ? '查询中…' : '查行业'}</button>
      {(stockSearchBusy || stockSearchError || (stockSearched && !stockChoices.length && !stock)) && <span role="status" className="sector-explorer-search-status">{stockSearchBusy ? '搜索中…' : stockSearchError ? `搜索失败：${stockSearchError}` : '没有匹配的 A 股股票。'}</span>}
    </form>
</div><div className="sector-directory-list"><div className="sector-explorer-list-meta"><span>{filtered.length} 个板块</span><span>{catalog ? statusName[catalog.status] : catalogBusy ? '正在连接来源' : '尚未获取'}</span></div>{filtered.slice(0, listLimit).map(entry => <button type="button" className="sector-explorer-entry" key={entry.id} aria-pressed={selected === entry.id} onClick={() => void loadDetail(entry)}><strong>{entry.name}</strong><ChevronRight size={16}/></button>)}{!filtered.length && <div className="sector-explorer-empty">{catalogBusy ? '正在读取目录…' : filter === 'classification' && !query.trim() ? <button type="button" className="sector-explorer-lookup-prompt" onClick={() => stockInput.current?.focus()}>输入股票名称查询行业分类</button> : '没有匹配的板块。'}</div>}{filtered.length > listLimit && <button type="button" className="sector-explorer-more" onClick={() => setListLimit(value => value + 60)}>再显示 60 个</button>}</div></aside><main className="sector-explorer-content">{detailBusy ? <div className="sector-explorer-empty">正在读取成分…</div> : detail ? <><div className="sector-explorer-detail-refresh"><button type="button" onClick={() => selectedEntry && void loadDetail(selectedEntry, true)}><RefreshCw size={16}/>刷新当前资料</button></div><SectorExplorerDetailView key={detail.entry.id} detail={detail} onOpenStock={onOpenStock} onClassifications={code => { setStock(null); setStockQuery(code); void discover(code); }}/></> : <div className="sector-explorer-welcome"><Layers3 size={28}/><h3>选择板块查看成分</h3></div>}</main></div>
    {catalog && <details className="sector-explorer-catalog-sources"><summary>目录来源与覆盖 · {catalog.sources.filter(source => source.status === 'ready').length} / {catalog.sources.length} 来源可用 · {localTime(catalog.fetchedAt)}</summary><p className="sector-explorer-catalog-coverage">{catalog.coverage.scope} · 已载入 {catalog.coverage.loaded}{catalog.coverage.total != null ? ` / ${catalog.coverage.total}` : ' · 总数未提供'}</p>{catalog.warnings.map((warning, i) => <p key={i}>{warning}</p>)}{catalog.sources.map(source => <div key={source.url}><button type="button" onClick={() => openSource(source.url)}>{source.name}<ArrowUpRight size={12}/></button><span>{statusName[source.status]} · {source.message}</span></div>)}</details>}
  </section>;
}
