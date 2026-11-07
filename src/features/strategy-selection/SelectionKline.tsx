import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, X } from 'lucide-react';
import { calculatePriceMovingAverages } from '../../priceChartSeries';
import { whenVisible } from '../../visiblePolling';
import { subscribeSelectionChart, type SelectionChart, type SelectionCandle } from './selectionChartData';

const number = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(2);
const volume = (value: number | null) => value === null ? '未提供' : value >= 1e8 ? `${(value / 1e8).toFixed(2)}亿` : value >= 1e4 ? `${(value / 1e4).toFixed(2)}万` : String(value);
const todayCN = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function sessionNote(date: string) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  return date === todayCN() && time < '15:00' ? '今日K线未收盘' : '以行情源最后更新为准';
}
function Chart({ data, compact = false, signalDate, sessions = 120 }: { data: SelectionChart; compact?: boolean; signalDate?: string | undefined; sessions?: number }) {
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [keyboardDate, setKeyboardDate] = useState<string | null>(null);
  const full = data.rows;
  const rows = full.slice(compact ? -30 : -sessions);
  const offset = full.length - rows.length;
  const averages = useMemo(() => compact ? null : calculatePriceMovingAverages(full), [compact, full]);
  const width = compact ? 174 : 840, height = compact ? 56 : 360;
  const left = compact ? 2 : 52, right = compact ? 2 : 12, top = compact ? 3 : 26;
  const bottom = compact ? 53 : 263;
  const maSeries = averages ? [averages.ma5, averages.ma10, averages.ma20] : [];
  const values = rows.flatMap(row => [row.high, row.low]);
  if (!compact) maSeries.forEach(series => values.push(...series.slice(offset).filter(Number.isFinite)));
  const min = Math.min(...values), max = Math.max(...values), spread = Math.max(max - min, max * 0.006);
  const lower = min - spread * 0.06, upper = max + spread * 0.06;
  const y = (price: number) => top + (upper - price) / (upper - lower) * (bottom - top);
  const step = (width - left - right) / rows.length;
  const x = (index: number) => left + (index + 0.5) * step;
  const maxVolume = Math.max(1, ...rows.map(row => row.volume ?? 0));
  const selectedDate = hoverDate || keyboardDate;
  const dateIndex = selectedDate === null ? -1 : rows.findIndex(row => row.date === selectedDate);
  const selectedIndex = dateIndex >= 0 ? dateIndex : rows.length - 1;
  const selectIndex = (index: number, source: "pointer" | "keyboard" = "pointer") => {
    const date = rows[Math.max(0, Math.min(rows.length - 1, index))]?.date;
    if (source === "keyboard") { setKeyboardDate(date || null); setHoverDate(null); }
    else setHoverDate(date || null);
  };
  const selected = rows[selectedIndex]!;
  const previous = full[offset + selectedIndex - 1];
  const pct = previous ? (selected.close / previous.close - 1) * 100 : null;
  const signalIndex = rows.findIndex(row => row.date === signalDate);
  const candleTitle = (row: SelectionCandle) => `${row.date} 开${number(row.open)} 高${number(row.high)} 低${number(row.low)} 收${number(row.close)}`;
  return <div className={`selection-chart ${compact ? 'is-mini' : ''}`}>
    {!compact && <>
      <div className="selection-chart-quote" aria-live="polite"><b>{selected.date}</b><span>开 {number(selected.open)}</span><span>高 {number(selected.high)}</span><span>低 {number(selected.low)}</span><span>收 {number(selected.close)}</span><span>涨跌 {pct === null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}</span><span>量 {volume(selected.volume)}（{selected.volumeUnit}）</span></div>
      <div className="selection-chart-legend">{[5, 10, 20].map((period, i) => <span key={period} className={`ma-${period}`}>MA{period} {number(maSeries[i]?.[offset + selectedIndex])}</span>)}<span>红涨 / 绿跌（收盘与开盘比较）</span></div>
    </>}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={compact ? `近${rows.length}个交易日日K线，${rows[0]?.date}至${rows.at(-1)?.date}` : '日K线与成交量，使用左右方向键逐日查看，Home和End跳到首尾'} tabIndex={compact ? undefined : 0}
      onPointerMove={compact ? undefined : event => { const box = event.currentTarget.getBoundingClientRect(); selectIndex(Math.floor(((event.clientX - box.left) / box.width * width - left) / step)); }}
      onPointerLeave={() => setHoverDate(null)} onKeyDown={compact ? undefined : event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); selectIndex(event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1), 'keyboard');
      }}>
      {!compact && [0, 0.5, 1].map(fraction => { const value = lower + (upper - lower) * fraction; return <g key={fraction}><line className="chart-grid" x1={left} x2={width - right} y1={y(value)} y2={y(value)} /><text x={left - 5} y={y(value) + 4} textAnchor="end">{number(value)}</text></g>; })}
      {rows.map((row, i) => {
        const prevBar = full[offset + i - 1];
        const isUp = row.close > row.open || (row.close === row.open && (prevBar ? row.close >= prevBar.close : true));
        return <g key={row.date} className={isUp ? 'candle-up' : 'candle-down'}><title>{candleTitle(row)}</title>
          <line x1={x(i)} x2={x(i)} y1={y(row.high)} y2={y(row.low)} />
          <rect x={x(i) - step * 0.31} y={Math.min(y(row.open), y(row.close))} width={Math.max(0.8, step * 0.62)} height={Math.max(1, Math.abs(y(row.open) - y(row.close)))} />
          {!compact && row.volume !== null && <rect x={x(i) - step * 0.31} y={331 - row.volume / maxVolume * 48} width={Math.max(0.8, step * 0.62)} height={Math.max(0.5, row.volume / maxVolume * 48)} />}
        </g>;
      })}
      {!compact && maSeries.map((series, index) => <path key={index} className={`ma-line ma-${[5, 10, 20][index]}`} d={series.slice(offset).map((value, i, list) => Number.isFinite(value) ? `${i > 0 && Number.isFinite(list[i - 1]) ? 'L' : 'M'}${x(i)},${y(value)}` : '').join(' ')} />)}
      {signalIndex >= 0 && <g className="signal-marker"><line x1={x(signalIndex)} x2={x(signalIndex)} y1={top} y2={bottom} />{!compact && <text x={Math.max(80, Math.min(width - 65, x(signalIndex)))} y={15} textAnchor="middle">策略信号</text>}</g>}
      {!compact && <><line className="chart-crosshair" x1={x(selectedIndex)} x2={x(selectedIndex)} y1={top} y2={333} /><text x={left} y={282}>成交量（{selected.volumeUnit}）</text><text x={left} y={351}>{rows[0]?.date}</text><text x={width - right} y={351} textAnchor="end">{rows.at(-1)?.date}</text></>}
    </svg>
    {!compact && <p className="selection-chart-hint">{rows.length} 个交易日 · {signalDate ? signalIndex >= 0 ? `信号日 ${signalDate} 已标注` : `信号日 ${signalDate} 不在当前窗口内` : '本条结果未提供信号日期'} · 悬停或聚焦图表后按 ← → 查看</p>}
  </div>;
}
function Detail({ security, signalDate, data, error, loading, refresh, close }: { security: Security; signalDate?: string | undefined; data: SelectionChart | null; error: string; loading: boolean; refresh: () => void; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [sessions, setSessions] = useState(120);
  const behindSignal = Boolean(data && signalDate && data.rows.at(-1)!.date < signalDate);
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={ref} className="selection-kline-dialog" aria-labelledby={title} onMouseDown={event => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    }} onCancel={event => { event.preventDefault(); close(); }} onClick={event => event.stopPropagation()}>
    <header><div><small>策略选股 · K线详情</small><h2 id={title}>{security.name} <span>{security.code}</span></h2></div><button type="button" className="secondary-btn" aria-label="关闭K线详情" onClick={close} autoFocus><X size={18} /></button></header>
    <div className="selection-chart-toolbar"><div className="selection-chart-ranges" role="group" aria-label="日K显示范围">{[30,60,120].map(count => <button key={count} type="button" aria-pressed={sessions === count} onClick={() => setSessions(count)}>近{count}日</button>)}</div><button type="button" className="secondary-btn" disabled={loading} onClick={refresh}><RefreshCw size={14} />{loading ? '刷新中…' : '刷新K线'}</button></div>
    {behindSignal && <p className="selection-chart-error" role="status">日K行情早于信号日，请刷新后核对。</p>}
    {error && <p className="selection-chart-error" role="alert">{error}{data ? '；保留上次图表。' : '，请点击刷新K线重试。'}</p>}
    {data ? <><Chart data={data} signalDate={signalDate} sessions={sessions} /><div className="selection-chart-meta"><p>{data.source} · {data.adjustment}</p><p>行情截至 {data.rows.at(-1)?.date} · {sessionNote(data.rows.at(-1)!.date)}</p><p>获取时间 {Number.isFinite(Date.parse(data.updatedAt)) ? new Date(data.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未提供'}（北京时间）</p><p>图表为最新行情，与选股快照分别更新。显示期间每60秒检查更新；隐藏页面暂停。历史不足所选范围时按实际数量展示。{data.note}</p></div></> : !error && <p role="status">正在加载日K线…</p>}
  </dialog>, document.body);
}
export function SelectionKline({ security, signalDate }: { security: Security; signalDate?: string | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const pendingForce = useRef(false);
  const [state, setState] = useState<{ key: string; data: SelectionChart | null; error: string; loading: boolean }>({ key: '', data: null, error: '', loading: false });
  const key = `${security.secid}|${security.code}`;
  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : '';
  const loading = state.key !== key || state.loading;
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(Boolean(entries[0]?.isIntersecting)));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible && !open) return;
    let dispose = () => {};
    const load = whenVisible(() => {
      dispose();
      setState(old => ({ key, data: old.key === key ? old.data : null, error: '', loading: !old.data || old.key !== key || pendingForce.current }));
      const forceRefresh = pendingForce.current;
      pendingForce.current = false;
      dispose = subscribeSelectionChart(security, (next, message) => setState(old => ({ key, data: next || (old.key === key ? old.data : null), error: message, loading: false })), forceRefresh);
    });
    load();
    const timer = window.setInterval(load, 60_000);
    document.addEventListener('visibilitychange', load);
    return () => { dispose(); clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [key, visible, open, revision, security.code, security.secid, security.name]);
  return <div ref={ref} className="selection-kline-cell" onClick={event => event.stopPropagation()}>
    <button type="button" className={`selection-kline-trigger ${error && data ? "has-stale-data" : ""}`} aria-busy={loading && (visible || open)} aria-label={`查看${security.name} ${security.code} K线`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      {data ? <Chart data={data} compact signalDate={signalDate} /> : <span>{error ? 'K线暂不可用 · 点击重试' : visible ? '日K加载中…' : '查看日K线'}</span>}
      <small>{data ? `${error ? "更新失败·旧图 · " : loading ? "更新中 · " : ""}近${Math.min(30, data.rows.length)}日 · ${data.rows.at(-1)?.date.slice(5)} · 展开` : '近30日日K'}</small>
    </button>
    {open && <Detail security={security} signalDate={signalDate} data={data} error={error} loading={loading} refresh={() => { pendingForce.current = true; setRevision(value => value + 1); }} close={() => setOpen(false)} />}
  </div>;
}
