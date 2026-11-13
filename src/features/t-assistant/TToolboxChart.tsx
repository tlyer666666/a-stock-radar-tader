import { useEffect, useId, useRef, useState } from 'react';
import type { TAnchor, TChartData, TDrawing, TIndicators, TOverlay, TPane } from './tToolboxModel';

export type TTool = 'cursor' | 'horizontal' | 'trend' | 'measure';
export const chartNumber = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
const quantity = (v: number | null) => v === null ? '—' : v >= 1e8 ? `${(v / 1e8).toFixed(2)}亿` : v >= 1e4 ? `${(v / 1e4).toFixed(2)}万` : v.toFixed(0);

type Props = { data: TChartData; indicators: TIndicators; overlays: TOverlay[]; panes: TPane[]; tool: TTool;
  drawings: TDrawing[]; selectedDrawing: string; onSelect: (id: string) => void; onDraw: (value: Omit<TDrawing, 'id'>) => void };
export default function TToolboxChart({ data, indicators, overlays, panes, tool, drawings, selectedDrawing, onSelect, onDraw }: Props) {
  const [range, setRange] = useState(60), [offset, setOffset] = useState(0);
  const [hover, setHover] = useState<TAnchor | null>(null), [pending, setPending] = useState<TAnchor | null>(null);
  const clip = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; offset: number; count: number; width: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { setPending(null); }, [tool]);
  const all = data.rows;
  const count = range === 0 ? all.length : Math.min(range, all.length), safeOffset = Math.min(offset, all.length - count);
  const end = all.length - safeOffset, start = end - count, rows = all.slice(start, end);
  const width = 1000, left = 62, right = 20, top = 30, bottom = 310, paneHeight = 105;
  const height = 345 + panes.length * paneHeight;
  const step = (width - left - right) / rows.length;
  const x = (i: number) => left + (i + .5) * step;
  const series: { label: string; values: (number | null)[]; className: string }[] = [];
  if (overlays.includes('MA')) for (const period of [5, 10, 20, 60] as const) series.push({ label: `MA${period}`, values: indicators[`ma${period}`], className: `toolbox-line-${period}` });
  if (overlays.includes('BOLL')) for (const [label, values] of [['BOLL中', indicators.ma20], ['BOLL上', indicators.upper], ['BOLL下', indicators.lower]] as const) series.push({ label, values, className: 'toolbox-line-boll' });
  const prices = rows.flatMap(r => [r.high, r.low]);
  series.forEach(s => prices.push(...s.values.slice(start, end).filter((v): v is number => v !== null)));
  const lo = Math.min(...prices), hi = Math.max(...prices), pad = Math.max((hi - lo) * .08, hi * .005);
  const min = lo - pad, max = hi + pad;
  const y = (price: number) => top + (max - price) / (max - min) * (bottom - top);
  const hovered = rows.findIndex(row => row.date === hover?.date);
  const selected = hovered < 0 ? rows.length - 1 : hovered;
  const row = rows[selected]!, absolute = start + selected;
  const linePath = (values: (number | null)[], scale: (v: number) => number) => values.slice(start, end).map((v, i, list) => v === null ? '' : `${i > 0 && list[i - 1] !== null ? 'L' : 'M'}${x(i)},${scale(v)}`).join(' ');
  const anchorX = (point: TAnchor) => {
    const index = all.findIndex(r => r.date === point.date);
    return index < 0 ? null : x(index - start);
  };
  const pointer = (event: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width * width, py = (event.clientY - rect.top) / rect.height * height;
    const index = Math.max(0, Math.min(rows.length - 1, Math.floor((px - left) / step)));
    return { point: { date: rows[index]!.date, price: Math.max(.001, max - (py - top) / (bottom - top) * (max - min)) }, inside: px >= left && px <= width - right && py >= top && py <= bottom };
  };
  const minimum = Math.min(10, all.length);
  const reset = () => { setRange(60); setOffset(0); setHover(null); setPending(null); };
  const zoom = (factor: number, fraction = 1) => {
    const next = Math.max(minimum, Math.min(all.length, Math.round(count * factor)));
    const anchor = start + fraction * count;
    setRange(next);
    setOffset(Math.max(0, Math.min(all.length - next, Math.round(all.length - anchor - (1 - fraction) * next))));
    setHover(null);
  };
  // React wheel handlers are passive in Chromium. Attach explicitly so a chart
  // gesture changes the viewport without scrolling the enclosing workbench.
  useEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (drag.current) return;
      const rect = node.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / (width - left - right)));
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey) {
        setOffset(Math.max(0, Math.min(all.length - count, safeOffset + Math.round(event.deltaX * unit / rect.width * count))));
        return;
      }
      if (!event.deltaY) return;
      const scaled = Math.round(count * Math.exp(Math.max(-.5, Math.min(.5, event.deltaY * unit * .003))));
      const next = Math.max(minimum, Math.min(all.length, scaled === count ? count + Math.sign(event.deltaY) : scaled));
      const anchor = start + fraction * count;
      setRange(next);
      setOffset(Math.max(0, Math.min(all.length - next, Math.round(all.length - anchor - (1 - fraction) * next))));
      setHover(null);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [all.length, count, minimum, safeOffset, start]);
  const endDrag = () => { drag.current = null; setDragging(false); };
  const add = (point: TAnchor) => {
    if (tool === 'cursor') { onSelect(''); return; }
    if (tool === 'horizontal') { onDraw({ kind: 'horizontal', a: point }); return; }
    if (!pending) setPending(point);
    else { onDraw({ kind: tool, a: pending, b: point }); setPending(null); }
  };
  return <div className="t-toolbox-chart-wrap">
    <div className="t-toolbox-window" role="group" aria-label="K线显示范围">
      <button type="button" aria-label="放大K线" disabled={count <= minimum} onClick={() => zoom(.8)}>＋ 放大</button>
      <button type="button" aria-label="缩小K线" disabled={count >= all.length} onClick={() => zoom(1.25)}>− 缩小</button>
      <button type="button" onClick={reset}>复位</button>
      {[30, 60, 120, 0].map(n => <button key={n} type="button" aria-pressed={range === n} onClick={() => { setRange(n); setOffset(0); }}>{n === 0 ? '全部' : `${n}根`}</button>)}
      <button type="button" disabled={safeOffset >= all.length - count} onClick={() => setOffset(Math.min(all.length - count, safeOffset + Math.ceil(count / 2)))}>← 更早</button>
      <button type="button" disabled={!safeOffset} onClick={() => setOffset(Math.max(0, safeOffset - Math.ceil(count / 2)))}>较新 →</button>
      <button type="button" disabled={!safeOffset} onClick={() => setOffset(0)}>回到最新</button>
      <span>{rows[0]!.date} — {rows.at(-1)!.date} · {rows.length}/{all.length} 根</span>
    </div>
    <div className="toolbox-quote"><b>{row.date}</b><span>开 {chartNumber(row.open)}</span><span>高 {chartNumber(row.high)}</span><span>低 {chartNumber(row.low)}</span><span>收 {chartNumber(row.close)}</span><span>量 {quantity(row.volume)} {row.volumeUnit}</span></div>
    <div className="toolbox-legend">{series.map(s => <span key={s.label} className={s.className}>{s.label} {chartNumber(s.values[absolute])}</span>)}</div>
    <svg ref={svgRef} className={`t-toolbox-chart ${tool === 'cursor' ? 'can-pan' : ''} ${dragging ? 'is-dragging' : ''}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="个股K线工具图，滚轮缩放，拖动平移，双击复位，左右键读数，加减键缩放；选择画线工具后点击，Escape取消" tabIndex={0}
      onPointerDown={event => {
        suppressClick.current = false;
        if (tool !== 'cursor' || event.button !== 0) return;
        drag.current = { x: event.clientX, offset: safeOffset, count, width: event.currentTarget.getBoundingClientRect().width * (width - left - right) / width, moved: false };
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (active) {
          const distance = event.clientX - active.x;
          if (Math.abs(distance) > 4 && !active.moved) { active.moved = true; suppressClick.current = true; setDragging(true); event.currentTarget.setPointerCapture(event.pointerId); }
          if (active.moved) { setOffset(Math.max(0, Math.min(all.length - active.count, active.offset + Math.round(distance / active.width * active.count)))); setHover(null); return; }
        }
        setHover(pointer(event).point);
      }}
      onPointerUp={event => { endDrag(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag} onPointerLeave={() => { if (!drag.current) setHover(null); }}
      onDoubleClick={() => { if (tool === 'cursor') reset(); }}
      onClick={event => { if (suppressClick.current) { suppressClick.current = false; return; } const hit = pointer(event); if (hit.inside) add(hit.point); }}
      onKeyDown={event => {
        if (['+', '=', '-', '0', 'PageUp', 'PageDown'].includes(event.key)) {
          event.preventDefault();
          if (event.key === '0') reset();
          else if (event.key === 'PageUp' || event.key === 'PageDown') setOffset(Math.max(0, Math.min(all.length - count, safeOffset + (event.key === 'PageUp' ? 1 : -1) * Math.ceil(count / 2))));
          else zoom(event.key === '-' ? 1.25 : .8);
          return;
        }
        if (event.key === 'Escape') { setPending(null); onSelect(''); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const i = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, selected + (event.key === 'ArrowLeft' ? -1 : 1)));
        setHover({ date: rows[i]!.date, price: rows[i]!.close });
      }}>
      <defs><clipPath id={clip}><rect x={left} y={top} width={width - left - right} height={bottom - top} /></clipPath></defs>
      {[0, .25, .5, .75, 1].map(f => <g key={f}><line className="toolbox-grid" x1={left} x2={width - right} y1={y(min + f * (max - min))} y2={y(min + f * (max - min))} /><text x={left - 7} y={y(min + f * (max - min)) + 4} textAnchor="end">{chartNumber(min + f * (max - min))}</text></g>)}
      <g clipPath={`url(#${clip})`}>
        {rows.map((r, i) => <g key={r.date} className={`toolbox-candle ${r.close >= r.open ? 'is-up' : 'is-down'}`}><line x1={x(i)} x2={x(i)} y1={y(r.high)} y2={y(r.low)} /><rect x={x(i) - step * .3} y={Math.min(y(r.open), y(r.close))} width={Math.max(.6, step * .6)} height={Math.max(1, Math.abs(y(r.open) - y(r.close)))} /></g>)}
        {series.map(s => <path key={s.label} className={`toolbox-series ${s.className}`} d={linePath(s.values, y)} />)}
        {drawings.map(drawing => {
          const aX = anchorX(drawing.a), bX = drawing.b ? anchorX(drawing.b) : null;
          if (drawing.kind !== 'horizontal' && (aX === null || bX === null)) return null;
          const horizontal = drawing.kind === 'horizontal';
          const x1 = horizontal ? left : aX!, x2 = horizontal ? width - right : bX!;
          const y1 = y(drawing.a.price), y2 = y(drawing.b?.price ?? drawing.a.price);
          return <g key={drawing.id} className={`toolbox-drawing ${selectedDrawing === drawing.id ? 'is-selected' : ''}`} onClick={event => { if (tool === 'cursor' && !suppressClick.current) { event.stopPropagation(); onSelect(drawing.id); } }}>
            <line className="toolbox-hit-line" x1={x1} x2={x2} y1={y1} y2={horizontal ? y1 : y2} />
            <line x1={x1} x2={x2} y1={y1} y2={horizontal ? y1 : y2} />
            {drawing.kind === 'measure' && <rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.max(1, Math.abs(x2 - x1))} height={Math.max(1, Math.abs(y2 - y1))} />}
            <text x={Math.max(left + 4, Math.min(width - 180, x1 + 4))} y={Math.max(top + 14, y1 - 6)}>{horizontal ? chartNumber(drawing.a.price) : drawing.kind === 'measure' ? `${((drawing.b!.price / drawing.a.price - 1) * 100).toFixed(2)}% · ${Math.abs(all.findIndex(r => r.date === drawing.b!.date) - all.findIndex(r => r.date === drawing.a.date))} 根` : '趋势线'}</text>
          </g>;
        })}
        {pending && hover && anchorX(pending) !== null && <line className="toolbox-pending" x1={anchorX(pending)!} x2={x(selected)} y1={y(pending.price)} y2={y(hover.price)} />}
      </g>
      {panes.map((pane, paneIndex) => {
        const ptop = 345 + paneIndex * paneHeight, pbottom = ptop + 77;
        const curves = pane === 'VOL' ? [{ name: 'MA5', values: indicators.volumeMa5, cls: 'toolbox-line-5' }]
          : pane === 'MACD' ? [{ name: 'DIF', values: indicators.dif, cls: 'toolbox-line-5' }, { name: 'DEA', values: indicators.dea, cls: 'toolbox-line-10' }]
          : pane === 'KDJ' ? [{ name: 'K', values: indicators.k, cls: 'toolbox-line-5' }, { name: 'D', values: indicators.d, cls: 'toolbox-line-10' }, { name: 'J', values: indicators.j, cls: 'toolbox-line-20' }]
          : [{ name: 'RSI14', values: indicators.rsi, cls: 'toolbox-line-20' }];
        const bars = pane === 'VOL' ? all.map(r => r.volume) : pane === 'MACD' ? indicators.macd : null;
        const values = [...curves.flatMap(c => c.values.slice(start, end)), ...(bars?.slice(start, end) || [])].filter((v): v is number => v !== null);
        const vmin = Math.min(0, ...values), vmax = Math.max(pane === 'RSI' || pane === 'KDJ' ? 100 : .001, ...values);
        const py = (v: number) => ptop + 18 + (vmax - v) / Math.max(.001, vmax - vmin) * (pbottom - ptop - 18);
        return <g key={pane} className="toolbox-indicator-pane"><line className="toolbox-grid" x1={left} x2={width - right} y1={pbottom} y2={pbottom} />
          <text x={left} y={ptop + 10}>{pane}{pane === 'VOL' ? `（${row.volumeUnit}） ${quantity(row.volume)}` : ''} {curves.map(c => `${c.name} ${chartNumber(c.values[absolute])}`).join('  ')}{pane === 'MACD' ? `  柱 ${chartNumber(indicators.macd[absolute])}` : ''}</text>
          {bars && bars.slice(start, end).map((v, i) => v === null ? null : <rect key={rows[i]!.date} className={`toolbox-bar ${(pane === 'VOL' ? rows[i]!.close >= rows[i]!.open : v >= 0) ? 'is-up' : 'is-down'}`} x={x(i) - step * .3} width={Math.max(.6, step * .6)} y={Math.min(py(v), py(0))} height={Math.max(.5, Math.abs(py(v) - py(0)))} />)}
          {curves.map(c => <path key={c.name} className={`toolbox-series ${c.cls}`} d={linePath(c.values, py)} />)}
          {(pane === 'RSI' ? [30, 70] : pane === 'KDJ' ? [20, 80] : [0]).map(v => <g key={v}><line className="toolbox-grid" x1={left} x2={width - right} y1={py(v)} y2={py(v)} /><text x={left - 7} y={py(v) + 4} textAnchor="end">{v}</text></g>)}
          {!values.length && <text x={width / 2} y={ptop + 45}>样本不足 / 数据暂缺</text>}
        </g>;
      })}
      <line className="toolbox-crosshair" x1={x(selected)} x2={x(selected)} y1={top} y2={height - 20} />
      <text x={left} y={height - 5}>{rows[0]!.date}</text><text x={width - right} y={height - 5} textAnchor="end">{rows.at(-1)!.date}</text>
    </svg>
    <p className="toolbox-help" role="status">{pending ? '已选起点，再点击终点完成；Esc 取消。' : tool === 'cursor' ? '滚轮缩放 · 拖动平移 · 双击复位；← → 读数，＋/− 缩放，PageUp/PageDown 翻页。' : tool === 'horizontal' ? '在价格区点击放置水平线，也可输入精确价格。' : '在价格区依次点击起点和终点。'}{drawings.some(d => d.kind !== 'horizontal' && (anchorX(d.a) === null || !d.b || anchorX(d.b) === null)) ? ' 部分画线锚点不在已加载历史中，暂不绘制。' : ''}</p>
  </div>;
}
