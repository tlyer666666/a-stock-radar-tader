import { useMemo, useState } from "react";
import type { TrendScanStatus, TrendStrategyId } from './trendScreenerTypes';
import { TREND_CONFIG_FIELDS, TREND_LIBRARY, TREND_QUALITY_PRESETS, TREND_STRATEGY_CHOICES, libraryDefinition, strategyName } from './trendStrategyConfig';

type Props = {
  mode: 'single' | 'multi'; onMode: (mode: 'single' | 'multi') => void;
  strategyId: TrendStrategyId; onStrategy: (id: TrendStrategyId) => void;
  selected: TrendStrategyId[]; onSelected: (ids: TrendStrategyId[]) => void;
  qualityDraft: Record<string, string>; onQuality: (draft: Record<string, string>) => void;
  forceRefresh: boolean; onRefresh: (value: boolean) => void; disabled: boolean; status: TrendScanStatus | null;
};
export default function TrendStrategyPanel(p: Props) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [expanded, setExpanded] = useState(true);
  const family = (id: string) => /macd|dmi|roc|cci/.test(id) ? 'momentum' : /boll|donchian/.test(id) ? 'breakout' : /obv|emv|mfi/.test(id) ? 'volume' : 'pullback';
  const choices = useMemo(() => TREND_STRATEGY_CHOICES.filter(item => (category === 'all' || family(item.id) === category) && `${item.name} ${libraryDefinition(item.id)?.summary || ''}`.toLowerCase().includes(search.trim().toLowerCase())), [search, category]);
  const selected = p.mode === 'single' ? [p.strategyId] : p.selected;
  const actual = p.status?.phase === 'idle' ? [] : p.status?.strategies || (p.status?.strategy ? [p.status.strategy] : []);
  return <section className="trend-strategy-settings" aria-label="趋势策略参数">
    <div className="trend-strategy-settings-head"><div><h2>扫描策略 <small className="strategy-catalog-count">{TREND_STRATEGY_CHOICES.length} 项</small></h2></div><label className="trend-check"><input type="checkbox" checked={p.forceRefresh} disabled={p.disabled} onChange={e => p.onRefresh(e.target.checked)} /><span>重新获取行情（跳过缓存）</span></label></div>
    <div className="trend-strategy-mode" role="group" aria-label="扫描模式">{(['multi', 'single'] as const).map(mode => <button key={mode} className={`trend-btn ${p.mode === mode ? 'trend-btn-accent' : ''}`} disabled={p.disabled} onClick={() => p.onMode(mode)} aria-pressed={p.mode === mode}>{mode === 'multi' ? '多策略联合扫描' : '单策略扫描'}</button>)}<span>已选 {selected.length} 项</span><button className="trend-btn trend-btn-small trend-library-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起策略" : "展开策略"}</button></div>
    <div className="trend-library-content" hidden={!expanded}>
    <div className="trend-library-tools"><label><span>查找策略</span><input aria-label="查找趋势策略" placeholder="名称 / 指标 / 形态" value={search} onChange={e => setSearch(e.target.value)} /></label><div role="group" aria-label="策略类型">{[['all','全部'],['pullback','回调承接'],['momentum','趋势动能'],['breakout','区间突破'],['volume','量价确认']].map(([id,label]) => <button key={id} className={category === id ? 'active' : ''} aria-pressed={category === id} onClick={() => setCategory(id || "all")}>{label}</button>)}</div></div>
    {p.mode === 'single' ? <label className="trend-strategy-select"><span>扫描策略</span><select aria-label="扫描策略" value={p.strategyId} disabled={p.disabled} onChange={e => p.onStrategy(e.target.value as TrendStrategyId)}>{TREND_STRATEGY_CHOICES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <div className="trend-library-grid">{choices.map(item => {
      const definition = libraryDefinition(item.id);
      return <label key={item.id} title={definition?.summary || (item.id === 'quality-v2' ? '在原版形态上加入强度、波动和收盘质量约束。' : '保留原版回踩转强与平台突破，供同数据对照。')} className={`trend-library-choice ${selected.includes(item.id) ? 'is-selected' : ''}`}><input type="checkbox" checked={selected.includes(item.id)} disabled={p.disabled} onChange={e => p.onSelected(e.target.checked ? [...p.selected, item.id] : p.selected.filter(id => id !== item.id))} /><span><b>{item.name}</b><small>{definition?.family || (item.id === 'quality-v2' ? '质量增强 · A / B' : '原版对照 · A / B')}</small><p>{definition?.summary || (item.id === 'quality-v2' ? '在原版形态上加入强度、波动和收盘质量约束。' : '保留原版回踩转强与平台突破，供同数据对照。')}</p></span></label>;
    })}</div>}
    {choices.length === 0 && <p className="trend-library-empty">没有匹配策略，试试更换关键词或类型。</p>}
    {selected.includes('quality-v2') && <details className="trend-quality-parameters"><summary>质量增强参数</summary><div className="trend-strategy-controls"><div className="trend-presets"><span>趋势质量 v2 参数预设</span><div>{(['robust', 'balanced'] as const).map(preset => <button className="trend-btn trend-btn-small" disabled={p.disabled} key={preset} onClick={() => p.onQuality(Object.fromEntries(Object.entries(TREND_QUALITY_PRESETS[preset]).map(([key, value]) => [key, String(value)])))}>{preset === 'robust' ? '稳健' : '均衡'}</button>)}</div></div>{TREND_CONFIG_FIELDS.map(field => <label className="trend-strategy-select" key={field.key}><span>{field.label}</span><input type="number" aria-label={field.label} min={field.min} max={field.max} step={field.step} value={p.qualityDraft[field.key]} disabled={p.disabled} onChange={e => p.onQuality({ ...p.qualityDraft, [field.key]: e.target.value })} /><small>{field.min}—{field.max}</small></label>)}</div></details>}
    <details className="trend-library-reference"><summary>查看 {TREND_LIBRARY.length} 种指标策略的规则、参数与来源</summary><p>下列指标构成独立触发条件，不要求先命中原版 A / B。共同保留近期涨停、趋势、流动性、相对强度和价格风险约束；本版本参数固定。</p><div>{TREND_LIBRARY.map(item => <article key={item.id}><strong>{item.name} · v{item.version}</strong><p>{item.summary}</p><code>{Object.entries(item.parameters).map(([key, value]) => `${key}=${value}`).join(' · ')}</code><span>{item.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</span></article>)}</div></details>

    </div>
    <div className="trend-strategy-current">当前结果：<b>{p.status && p.status.phase !== 'idle' ? actual.length ? `${actual.length} 个策略 · ${actual.map(strategyName).join(' / ')}` : '原版趋势 v1' : '尚未扫描'}</b>{actual.length === 1 && <span>v{actual[0]?.version} · 配置 {actual[0]?.configHash.slice(0, 10)}</span>}{actual.length > 1 && p.status?.strategySetHash && <span>组合 {p.status.strategySetHash.slice(0, 10)}</span>}</div>
    {p.status?.phase !== 'idle' && !!p.status?.strategyStats?.length && <div className="trend-strategy-coverage" aria-label="各策略扫描覆盖">{p.status.strategyStats.map(stat => <div key={stat.strategy.id}><b>{strategyName(stat.strategy)}</b><span>{stat.candidateCount} 条候选 · 已处理 {stat.processed}</span><small className={stat.coverageComplete ? 'is-complete' : ''}>{stat.coverageComplete ? '覆盖完整' : '覆盖未完成'} · 不可用 {stat.unavailable} · 失败 {stat.failed}</small></div>)}</div>}
  </section>;
}
