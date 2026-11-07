import { memo, useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Activity, Bookmark, Search, Sparkles } from 'lucide-react';
import { PanelTitle } from '../../components/terminal/TerminalPrimitives';
import { fmt, fmtMoney, nullableNumber } from '../../domain/formatters';
import { loadSafeLocalJson, saveSafeLocalJson } from '../../safeStorage';
import { LIMIT_COLUMNS, limitPoolWindow, limitUpMarketAnalysis, normalizeColumnPreferences, selectLimitUpRows, type LimitPoolSort, type LimitUpStock } from './limitUpPoolModel';

const STORAGE_KEY = 'a-stock-radar:limit-pool-columns:v3';
const percent = (value: unknown, signed = false) => {
  const n = nullableNumber(value);
  return n === null ? '--' : `${signed && n > 0 ? '+' : ''}${fmt(n)}%`;
};

const SHRINKABLE_LIMIT_COLUMNS = new Set(['name', 'quality', 'industry', 'limitReason', 'status']);
/** 所有单元格单行显示（折行会让行高参差、第二行被截）；文字列放不下时省略，悬停看全文。 */
const TITLE_LIMIT_COLUMNS = new Set(['name', 'quality', 'status', 'industry', 'limitReason']);
/**
 * 按内容定的最小宽度（含左右内边距），保证「10.25%」「1860.78万」「11.80%」「强势封板 · 100分」、
 * 五个字的股票名不被截断、不换行（2026-11-06 实机问题）；放不下时整表横向滚动，「操作」列固定在右侧。
 */
const CONTENT_MIN_WIDTH: Record<string, number> = { name: 84, latest: 60, changePct: 66, turnover: 66, amount: 88, firstSealTime: 76, sealFloatRatio: 70, quality: 114, sealedAmount: 88, status: 72 };
// 数字列内容短，可再收窄 15%。
const COMPACT_LIMIT_COLUMNS = new Set(['latest', 'turnover', 'amount', 'firstSealTime', 'lastSealTime', 'openBoardCount', 'consecutiveBoards']);

export default memo(function LimitUpPool({ items, meta, onOpen, onAdd, isFavorite }: {
  items: LimitUpStock[]; meta?: { dataDate?: string } | null;
  onOpen: (stock: LimitUpStock) => void; onAdd: (stock: LimitUpStock) => void;
  /** 已在自选里的股票显示「已监控」，不会再点一次就取消。 */
  isFavorite?: ((code: string) => boolean) | undefined;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LimitPoolSort>({ key: 'changePct', direction: 'desc' });
  const [preferences, setPreferences] = useState(() => normalizeColumnPreferences(loadSafeLocalJson(STORAGE_KEY, {})));
  const [selectedCode, setSelectedCode] = useState('');
  const [storageError, setStorageError] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({top: 0, height: 480, rowHeight: 28});
  const measureViewport = useCallback(() => {
    const node = scroll.current;
    if (!node) return;
    const box = { top: node.scrollTop, height: node.clientHeight, rowHeight: head.current?.getBoundingClientRect().height || 28 };
    setViewport(previous => previous.top === box.top && previous.height === box.height && previous.rowHeight === box.rowHeight ? previous : box);
  }, []);
  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    if (!scroll.current || !head.current) return;
    const observer = new ResizeObserver(measureViewport);
    observer.observe(scroll.current);
    observer.observe(head.current);
    measureViewport();
    return () => observer.disconnect();
  }, [hasItems, measureViewport]);
  const resize = useRef<{ key: string; start: number; width: number } | null>(null);
  const latestPreferences = useRef(preferences);
  const rowPrefix = useId();
  const insights = useMemo(() => new Map(items.map(item => [item.code, limitUpMarketAnalysis(item)])), [items]);
  const { filtered, visible } = useMemo(() => selectLimitUpRows(items, { query, sort, insights }), [items, query, sort, insights]);
  const columns = useMemo(() => LIMIT_COLUMNS.filter(column => preferences.visible.includes(column.key)), [preferences.visible]);
  const windowRows = limitPoolWindow(visible.length, viewport.top, viewport.height, viewport.rowHeight);
  const selected = visible.find(item => item.code === selectedCode) || visible[0];
  const selectedIndex = visible.indexOf(selected!);
  const mountedSelection = selectedIndex >= windowRows.start && selectedIndex < windowRows.end;
  const selectIndex = (index: number) => {
    const item = visible[index], node = scroll.current;
    if (!item || !node) return;
    const top = index * viewport.rowHeight;
    const bottom = top + viewport.rowHeight * 2; // Keep the sticky header above the selected row.
    if (top < node.scrollTop) node.scrollTop = top;
    else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight;
    measureViewport(); setSelectedCode(item.code);
  };
  useEffect(() => {
    latestPreferences.current = preferences;
    const timer = window.setTimeout(() => setStorageError(!saveSafeLocalJson(STORAGE_KEY, preferences)), 250);
    return () => window.clearTimeout(timer);
  }, [preferences]);
  useEffect(() => () => { saveSafeLocalJson(STORAGE_KEY, latestPreferences.current); }, []);


  const widthFor = (key: string) => preferences.widths[key] ?? LIMIT_COLUMNS.find(column => column.key === key)?.width ?? 80;
  const setWidth = (key: string, width: number) => setPreferences(current => normalizeColumnPreferences({ ...current, widths: { ...current.widths, [key]: width } }));
  const beginResize = (event: PointerEvent<HTMLSpanElement>, key: string) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    resize.current = { key, start: event.clientX, width: widthFor(key) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const endResize = (event: PointerEvent<HTMLSpanElement>) => {
    resize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  // 1.6.47：各列按设定宽度成比例伸缩（最窄到 82%），常见窗口宽度下「操作」列不再被截掉；更窄时才出现横向滚动。
  // 数字列保持设定宽度；名称、质量、板块等文字列最窄到 70%（单行，放不下省略），且不小于 CONTENT_MIN_WIDTH。
  const minColumn = (key: string) => Math.max(CONTENT_MIN_WIDTH[key] ?? 0, SHRINKABLE_LIMIT_COLUMNS.has(key) ? Math.max(56, Math.round(widthFor(key) * 0.7))
    : COMPACT_LIMIT_COLUMNS.has(key) ? Math.max(44, Math.round(widthFor(key) * 0.85)) : widthFor(key));
  const template = [...columns.map(column => `minmax(${minColumn(column.key)}px, ${widthFor(column.key)}fr)`), '122px'].join(' ');
  const minWidth = columns.reduce((sum, column) => sum + minColumn(column.key), 122);
  const cell = (item: LimitUpStock, key: string) => {
    const insight = insights.get(item.code)!;
    const value = nullableNumber(item[key]);
    switch (key) {
      case 'code': case 'name': return <button className="limit-stock-link" onClick={() => onOpen(item)}>{String(item[key] || '--')}</button>;
      case 'latest': return fmt(value);
      case 'changePct': return <em className={value === null || value === 0 ? '' : value > 0 ? 'up' : 'down'}>{percent(value, true)}</em>;
      case 'turnover': return percent(value);
      case 'sealFloatRatio': return percent(value === null ? null : value * 100);
      case 'amount': case 'sealedAmount': return value === null ? '--' : fmtMoney(value);
      case 'consecutiveBoards': return value === null ? '--' : <b className={`board-tag ${value >= 3 ? 'high' : ''}`}>{value === 1 ? '首板' : `${value}板`}</b>;
      case 'quality': return insight.qualityScore === null ? `${insight.state} · ${insight.coreFieldCount}/3` : `${insight.state} · ${insight.qualityScore}分`;
      case 'status': return insight.state;
      case 'openBoardCount': return value === null ? '--' : value;
      default: return String(item[key] || '--');
    }
  };
  const cellTitle = (item: LimitUpStock, key: string) => {
    const insight = insights.get(item.code)!;
    if (key === 'quality') return insight.qualityScore === null ? `${insight.state} · 核心字段 ${insight.coreFieldCount}/3` : `${insight.state} · ${insight.qualityScore}分`;
    if (key === 'status') return insight.state;
    return String(item[key] || '');
  };
  if (!items.length) return null;
  return <section className="panel discover-panel discover-panel-top compact-limit-pool">
    <PanelTitle title="涨停池" subtitle={meta?.dataDate ? `完整涨停名单 · 数据日 ${meta.dataDate}` : '最近交易日完整涨停名单'} icon={Sparkles} badge={`${items.length} 只`} />
    <div className="limit-pool-tools">
      <label className="limit-pool-search"><Search size={14} /><input aria-label="筛选涨停池" value={query} onChange={event => {setQuery(event.target.value); if (scroll.current) scroll.current.scrollTop = 0;}} placeholder="筛选股票、代码、板块或原因" />{query && <button aria-label="清除涨停池筛选" onClick={() => setQuery('')}>×</button>}</label>
      <span className="limit-keyboard-hint">↑↓ / Home / End 选择 · 回车打开 · {query.trim() ? `匹配 ${filtered.length}` : `显示 ${visible.length} / ${items.length}`} 只</span>
      <details className="limit-columns-settings" onKeyDown={event => {
        if (event.key !== 'Escape' || !event.currentTarget.open) return;
        event.preventDefault(); event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }}><summary>列设置</summary><div className="limit-columns-panel" role="group" aria-label="列显示设置">
        {LIMIT_COLUMNS.map(column => <label key={column.key}><input type="checkbox" checked={preferences.visible.includes(column.key)} disabled={['code', 'name'].includes(column.key)} onChange={() => setPreferences(current => normalizeColumnPreferences({ ...current, visible: current.visible.includes(column.key) ? current.visible.filter(key => key !== column.key) : [...current.visible, column.key] }))} />{column.label}</label>)}
        <button className="secondary-btn" onClick={() => setPreferences(normalizeColumnPreferences(null))}>恢复默认列设置</button>
      </div></details>
      {storageError && <small role="status">列设置未能保存，当前会话仍可使用。</small>}
    </div>
    <div className="limit-grid-scroll" ref={scroll} onScroll={measureViewport}>
      <div className="limit-analysis-table compact-limit-grid" ref={grid} tabIndex={0} role="grid" aria-label="涨停池表格：方向键选择，回车打开个股复盘" aria-rowcount={filtered.length + 1} aria-colcount={columns.length + 1} aria-activedescendant={selected && mountedSelection ? `${rowPrefix}-${selected.code}` : undefined} style={{ minWidth }} onKeyDown={event => {
        if (event.target !== event.currentTarget || !visible.length) return;
        const index = mountedSelection ? selectedIndex : Math.min(visible.length - 1, Math.floor(viewport.top / viewport.rowHeight));
        const next = event.key === 'ArrowDown' ? Math.min(index + 1, visible.length - 1) : event.key === 'ArrowUp' ? Math.max(index - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : null;
        if (next !== null) { event.preventDefault(); selectIndex(next); }
        else if (event.key === 'Enter' && visible[index]) { event.preventDefault(); onOpen(visible[index]!); }
      }}>
        <div className="limit-analysis-row limit-analysis-head" ref={head} role="row" style={{ gridTemplateColumns: template }}>
          {columns.map(column => <div role="columnheader" className={'numeric' in column ? 'num' : ''} key={column.key} aria-sort={sort.key === column.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
            <button onClick={() => setSort(current => ({ key: column.key, direction: current.key === column.key && current.direction === 'desc' ? 'asc' : 'desc' }))}>{column.label}{sort.key === column.key ? sort.direction === 'asc' ? ' ▴' : ' ▾' : ''}</button>
            <span className="limit-column-resize" role="separator" aria-orientation="vertical" aria-label={`调整${column.label}列宽`} aria-valuemin={48} aria-valuemax={480} aria-valuenow={widthFor(column.key)} tabIndex={0} onPointerDown={event => beginResize(event, column.key)} onPointerMove={event => { if (resize.current?.key === column.key) setWidth(column.key, resize.current.width + event.clientX - resize.current.start); }} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={() => { resize.current = null; }} onDoubleClick={() => setWidth(column.key, column.width)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) { event.preventDefault(); setWidth(column.key, event.key === 'Home' ? column.width : widthFor(column.key) + (event.key === 'ArrowRight' ? 8 : -8)); } }} />
          </div>)}<div role="columnheader">操作</div>
        </div>
        {windowRows.start > 0 && <div aria-hidden="true" style={{height: windowRows.start * viewport.rowHeight}} />}
        {visible.slice(windowRows.start, windowRows.end).map((item, index) => <div key={item.code} id={`${rowPrefix}-${item.code}`} role="row" aria-rowindex={windowRows.start + index + 2} aria-selected={selected?.code === item.code} className="limit-analysis-row" style={{ gridTemplateColumns: template }} onClick={event => { setSelectedCode(item.code); if (!(event.target as HTMLElement).closest('button')) grid.current?.focus({ preventScroll: true }); }} onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button')) onOpen(item); }}>
          {columns.map(column => <div role="gridcell" key={column.key} className={('numeric' in column) ? 'num' : undefined} title={TITLE_LIMIT_COLUMNS.has(column.key) ? cellTitle(item, column.key) : undefined}>{cell(item, column.key)}</div>)}
          <div role="gridcell" className="limit-row-actions"><button className="table-action" aria-label={`分析${item.name}`} onClick={() => onOpen(item)}><Activity size={12} />分析</button>{isFavorite?.(item.code) ? <button className="table-action" disabled aria-label={`${item.name}已在监控`}><Bookmark size={12} />已监控</button>
            : <button className="table-action" aria-label={`监控${item.name}`} onClick={() => onAdd(item)}><Bookmark size={12} />监控</button>}</div>
        </div>)}
        {windowRows.end < visible.length && <div aria-hidden="true" style={{height: (visible.length - windowRows.end) * viewport.rowHeight}} />}
        {!visible.length && <div className="empty-inline">没有匹配的涨停股。</div>}
      </div>
    </div>
  </section>;
});
