import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { loadSafeLocalJson, saveSafeLocalJson } from '../../safeStorage';
import { DRAWINGS_KEY, T_FRAMES, T_OVERLAYS, T_PANES, drawingKey, drawingReferences, drawingReferenceStatus, normalizeDrawings, summarizeToolbox, toolboxIndicators, toolboxHistoryNote, type TChartData, type TChartPreferences, type TDrawing, type TDrawingReference, type TOverlay, type TPane } from './tToolboxModel';
import TToolboxChart, { chartNumber, type TTool } from './TToolboxChart';
import { useTToolbox } from './useTToolbox';
import type { TAnalysis } from './tEngine';

type DrawingEntry = { lines: TDrawing[]; references: TDrawingReference[]; basis?: TDrawingReference | null };
const validStore = (v: unknown) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const storedEntries = () => loadSafeLocalJson<Record<string, DrawingEntry>>(DRAWINGS_KEY, {}, validStore);
function persistDrawingEntry(contextKey: string, next: DrawingEntry) {
  const retained = Object.fromEntries(Object.entries(storedEntries()).filter(([key]) => key !== contextKey).slice(-59));
  return saveSafeLocalJson(DRAWINGS_KEY, { ...retained, [contextKey]: next }, validStore);
}
const toolLabels: { id: TTool; label: string }[] = [{ id: 'cursor', label: '十字光标' }, { id: 'horizontal', label: '水平线' }, { id: 'trend', label: '趋势线' }, { id: 'measure', label: '区间测量' }];

function DrawingWorkspace({ data, contextKey, overlays, panes }: { data: TChartData; contextKey: string; overlays: TOverlay[]; panes: TPane[] }) {
  const [entry, setEntry] = useState<DrawingEntry>(() => {
    const saved = storedEntries()[contextKey];
    const basis = saved?.basis && typeof saved.basis.date === 'string' && Number.isFinite(saved.basis.close) ? saved.basis : null;
    const references = (Array.isArray(saved?.references) ? saved.references : basis ? [basis] : []).filter(ref => ref && typeof ref.date === 'string' && Number.isFinite(ref.close) && ref.close > 0).slice(-3);
    return { lines: normalizeDrawings(saved?.lines), references };
  });
  const [tool, setTool] = useState<TTool>('cursor'), [selected, setSelected] = useState('');
  const [price, setPrice] = useState(''), [message, setMessage] = useState('');
  const indicators = useMemo(() => toolboxIndicators(data.rows), [data.rows]);
  const referenceStatus = drawingReferenceStatus(entry.references, data.rows);
  const rebased = entry.lines.length > 0 && referenceStatus !== 'valid';
  // Verify overlapping closed candles before moving the basis forward. The
  // first bar is deliberately not the basis: minute feeds roll it out routinely.
  useEffect(() => {
    if (!entry.lines.length || referenceStatus !== 'valid') return;
    const references = drawingReferences(data.rows);
    if (!references.length || JSON.stringify(references) === JSON.stringify(entry.references)) return;
    const next = { ...entry, references };
    setEntry(next);
    if (!persistDrawingEntry(contextKey, next)) setMessage('画线未能保存到本机，请保留当前窗口并重试保存');
  }, [data.rows, referenceStatus, entry, contextKey]);
  const save = (lines: TDrawing[]) => {
    const next: DrawingEntry = { lines, references: lines.length && entry.lines.length ? entry.references : drawingReferences(data.rows) };
    setEntry(next);
    const ok = persistDrawingEntry(contextKey, next);
    setMessage(ok ? '' : '画线未能保存到本机，请保留当前窗口并重试保存');
  };
  const add = (drawing: Omit<TDrawing, 'id'>) => {
    if (rebased) { setMessage('历史价格已修订，请先清空本周期旧画线再重新标记'); return; }
    if (entry.lines.length >= 50) { setMessage('本周期已保存50个图形，请先删除不需要的标记'); return; }
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    save([...entry.lines, { ...drawing, id }]); setSelected(id);
  };
  return <>
    <div className="toolbox-draw-toolbar" role="group" aria-label="画线工具箱">
      {toolLabels.map(t => <button key={t.id} type="button" aria-pressed={tool === t.id} onClick={() => setTool(t.id)}>{t.label}</button>)}
      <label>价格 <input aria-label="水平线价格" type="number" min="0.001" step="0.01" value={price} onChange={e => setPrice(e.target.value)} /></label>
      <button type="button" onClick={() => {
        const value = Number(price);
        if (!Number.isFinite(value) || value <= 0 || value > 1e7) { setMessage('请输入有效的正数价格'); return; }
        add({ kind: 'horizontal', a: { date: data.rows.at(-1)!.date, price: value } }); setPrice('');
      }}>添加水平线</button>
      <button type="button" disabled={!entry.lines.length || rebased} onClick={() => { save(entry.lines.slice(0, -1)); setSelected(''); }}>撤销画线</button>
      <button type="button" disabled={!selected || rebased} onClick={() => { save(entry.lines.filter(line => line.id !== selected)); setSelected(''); }}>删除选中</button>
      <button type="button" disabled={!entry.lines.length} onClick={() => { save([]); setSelected(''); }}>清空本周期</button>
    </div>
    {(message || rebased) && <p role="alert" className="toolbox-warning">{message || '历史价格已修订或基准K线已不在加载范围，旧画线已暂停显示；清空本周期后重新标记。'}{message.includes('未能保存') && <button type="button" onClick={() => save(entry.lines)}>重试保存</button>}</p>}
    <TToolboxChart data={data} indicators={indicators} overlays={overlays} panes={panes} tool={tool} drawings={rebased ? [] : entry.lines} selectedDrawing={selected} onSelect={setSelected} onDraw={add} />
    {!!entry.lines.length && <div className="toolbox-drawing-list" aria-label="已保存画线">{entry.lines.map((line, index) => <button key={line.id} type="button" aria-pressed={selected === line.id} onClick={() => setSelected(line.id)}>{index + 1}. {toolLabels.find(t => t.id === line.kind)?.label} {chartNumber(line.a.price)}{line.b ? ` → ${chartNumber(line.b.price)}` : ''}</button>)}<span>按股票、周期与复权口径在本机保存</span></div>}
  </>;
}

export type TToolboxDisplay = {
  preferences: TChartPreferences;
  setPreferences: Dispatch<SetStateAction<TChartPreferences>>;
};

export default function TToolbox({ security, live, analysis, display }: {
  security: Security; live: boolean; analysis: TAnalysis | null; display: TToolboxDisplay;
}) {
  const { preferences, setPreferences } = display;
  const { frame, dailyAdjustment, overlays, panes } = preferences;
  const toggleOverlay = (id: TOverlay) => setPreferences(current => ({
    ...current, overlays: current.overlays.includes(id) ? current.overlays.filter(overlay => overlay !== id) : [...current.overlays, id]
  }));
  const togglePane = (id: TPane) => setPreferences(current => ({
    ...current, panes: current.panes.includes(id) ? current.panes.filter(pane => pane !== id) : [...current.panes, id]
  }));
  const adjustment = Number(frame) < 100 ? 'none' : dailyAdjustment;
  const { selected, daily, refresh } = useTToolbox(security, frame, adjustment, live);
  const current = useMemo(() => selected.data ? summarizeToolbox(selected.data.rows) : null, [selected.data]);
  const history = useMemo(() => daily.data ? summarizeToolbox(daily.data.rows) : null, [daily.data]);
  const label = T_FRAMES.find(f => f.id === frame)!.label;
  const last = selected.data?.rows.at(-1), historyDate = daily.data?.rows.at(-1)?.date;
  const sharedDaily = frame === '101' && adjustment === 'front';
  const historyAdjustmentWarning = daily.data && daily.data.adjustment !== '前复权' ? `日线背景实际为${daily.data.adjustment}，未确认前复权口径，暂停跨周期趋势判断` : '';
  const warnings = [selected.error, daily.error && !sharedDaily ? `日线背景：${daily.error}` : '', historyAdjustmentWarning, toolboxHistoryNote(selected.data, frame)].filter(Boolean);
  const momentum = current?.macd == null ? '动能样本不足' : current.macd >= 0 ? 'MACD柱在零轴上方' : 'MACD柱在零轴下方';
  const plan = !history ? '正在读取历史日线背景，暂不作多周期判断。'
    : history.trend === '空头排列' ? `日线处于空头排列，${label}${momentum}。低吸存在逆趋势风险，先观察历史支撑附近的承接与量能变化。`
    : history.trend === '多头排列' ? `日线处于多头排列，${label}${momentum}。高抛需关注卖飞风险，结合压力附近量价变化与分时拐点观察。`
    : history.trend.startsWith('弱势反弹') ? `日线${history.trend}，${label}${momentum}。反弹到 MA60 附近容易遇压，低吸后接近压力要舍得卖，不追高。`
    : history.trend.startsWith('强势回调') ? `日线${history.trend}，${label}${momentum}。回到 MA20/MA60 附近有承接时可考虑低吸，跌破 MA60 再降低预期。`
    : `日线${history.trend}，${label}${momentum}。先划定支撑压力区间，再核对分时是否企稳或转弱。`;
  return <section className="panel t-toolbox" aria-label={`${security.name} 个股分析工具箱`}>
    <header className="toolbox-heading"><div><h3>个股分析工具箱</h3><p>历史定结构 · K线看量价 · 分时找时机</p></div><button type="button" className="secondary-btn" disabled={selected.loading || daily.loading} onClick={refresh}>{selected.loading || daily.loading ? '读取K线…' : '刷新K线'}</button></header>
    <div className="toolbox-timeframes" role="group" aria-label="K线周期">{T_FRAMES.map(f => <button key={f.id} type="button" aria-pressed={frame === f.id} onClick={() => setPreferences(current => ({ ...current, frame: f.id }))}>{f.label}</button>)}
      {Number(frame) >= 100 && <label>复权 <select aria-label="K线复权方式" value={dailyAdjustment} onChange={e => { const dailyAdjustment = e.target.value === 'none' ? 'none' : 'front'; setPreferences(current => ({ ...current, dailyAdjustment })); }}><option value="front">前复权</option><option value="none">不复权</option></select></label>}
    </div>
    <div className="toolbox-summary">
      <div><span>日线背景</span><b>{daily.error || historyAdjustmentWarning ? '数据待核对' : history?.trend || '读取中'}</b><small>{historyDate || '历史日线'} · {daily.data?.adjustment || '待确认口径'}</small></div>
      <div><span>历史支撑 / 压力</span><b>{chartNumber(history?.support)} / {chartNumber(history?.resistance)}</b><small>前20根日K低点 / 高点，排除最新根</small></div>
      <div><span>{label}量能对比</span><b>{current?.volumeRatio == null ? '—' : `${current.volumeRatio.toFixed(2)} 倍`}</b><small>本根成交量 ÷ 前20根均量，非实时量比</small></div>
      <div><span>{label}动能 RSI14</span><b>{chartNumber(current?.rsi)}</b><small>{momentum}</small></div>
      <div><span>{label}波动 ATR14</span><b>{chartNumber(current?.atr)}</b><small>{current?.atr != null && last ? `约为现价的 ${(current.atr / last.close * 100).toFixed(2)}%` : '样本不足时不推算'}</small></div>
    </div>
    <div className="toolbox-reading"><b>多周期观察</b><p>{warnings.length ? '行情时效或口径待核对，暂停当前多周期判断；图表保留供历史参考。' : plan}</p>{analysis && <small>分时模块：{analysis.signal.title} · {analysis.time}。历史关键位与分钟动能用于核对该触发的背景，指标不代表成交或胜率。</small>}</div>
    <div className="toolbox-indicators" role="group" aria-label="技术指标">
      {T_OVERLAYS.map(id => <button key={id} type="button" aria-pressed={overlays.includes(id)} onClick={() => toggleOverlay(id)}>{id}</button>)}
      {T_PANES.map(id => <button key={id} type="button" aria-pressed={panes.includes(id)} onClick={() => togglePane(id)}>{id === 'VOL' ? '成交量' : id}</button>)}
    </div>
    {warnings.map(w => <p className="toolbox-warning" role="alert" key={w}>{w}</p>)}
    {selected.data ? <DrawingWorkspace key={drawingKey(security.code, frame, selected.data.adjustment)} contextKey={drawingKey(security.code, frame, selected.data.adjustment)} data={selected.data} overlays={overlays} panes={panes} />
      : <p className="toolbox-empty" role="status">{selected.loading ? '正在读取历史K线…' : '暂无可用K线，可点击刷新重试。分时失败不影响工具箱独立读取历史。'}</p>}
    <div className="toolbox-meta">{selected.data && <span>{selected.data.source} · {selected.data.adjustment} · 行情截至 {last?.date} · {selected.data.rows.length} 根{selected.loading ? ' · 正在更新' : ''}</span>}<span>最后一根K线可能尚未收盘，量能与指标会随行情变化；窗口可见且实时开启时，交易时段每30秒检查更新。</span>{selected.data?.note && <span>{selected.data.note}</span>}</div>
    <details className="toolbox-formulas"><summary>指标口径与画线说明</summary><p>MA5/10/20/60为收盘均线；BOLL为20周期均值±2倍总体标准差；MACD采用EMA12−EMA26、DEA9，柱为2×(DIF−DEA)；KDJ为9周期RSV，K、D按1/3平滑、初值50；RSI14与ATR14采用Wilder平滑。计算使用全部已加载历史，缩放不重置指标，预热不足显示“—”。</p><p>画线以K线时间和价格为锚点，独立保存不同股票、周期及复权口径。历史价格修订时暂停显示旧线。支撑压力是历史区间极值参考，不保证有效；当前量柱未走完时不能直接与整根历史量柱比较。</p></details>
  </section>;
}
