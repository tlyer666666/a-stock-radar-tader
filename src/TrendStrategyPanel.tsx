import { useMemo, useState } from "react";
import type { TrendScanStatus, TrendStrategyId } from "./trendScreenerTypes";
import {
  TREND_CONFIG_FIELDS,
  TREND_DEFAULT_COMPARISON_STRATEGIES,
  TREND_LIBRARY,
  TREND_QUALITY_PRESETS,
  TREND_STRATEGY_CHOICES,
  libraryDefinition,
  strategyName,
  qualityPresetName
} from "./trendStrategyConfig";

type Props = {
  mode: "single" | "multi"; onMode: (mode: "single" | "multi") => void;
  strategyId: TrendStrategyId; onStrategy: (id: TrendStrategyId) => void;
  selected: TrendStrategyId[]; onSelected: (ids: TrendStrategyId[]) => void;
  qualityDraft: Record<string, string>; onQuality: (draft: Record<string, string>) => void;
  scanReason: string; onReason: (value: string) => void;
  researchStart: string; researchEnd: string; onResearchStart: (value: string) => void; onResearchEnd: (value: string) => void;
  onExportJournal: () => void;
  forceRefresh: boolean; onRefresh: (value: boolean) => void; disabled: boolean; status: TrendScanStatus | null;
};

const coreIds = new Set<TrendStrategyId>(TREND_DEFAULT_COMPARISON_STRATEGIES);

export default function TrendStrategyPanel(p: Props) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const family = (id: string) => /macd|dmi|roc|cci/.test(id) ? "momentum" : /boll|donchian/.test(id) ? "breakout" : /obv|emv|mfi/.test(id) ? "volume" : "pullback";
  const extensions = useMemo(() => TREND_STRATEGY_CHOICES.filter(item => !coreIds.has(item.id)), []);
  const choices = useMemo(() => extensions.filter(item => (category === "all" || family(item.id) === category) && `${item.name} ${libraryDefinition(item.id)?.summary || ""}`.toLowerCase().includes(search.trim().toLowerCase())), [extensions, search, category]);
  const coreChoices = TREND_DEFAULT_COMPARISON_STRATEGIES.map(id => TREND_STRATEGY_CHOICES.find(item => item.id === id)).filter((item): item is typeof TREND_STRATEGY_CHOICES[number] => Boolean(item));
  const qualityPreset = qualityPresetName({ maxExtensionAtr: Number(p.qualityDraft.maxExtensionAtr), minCloseLocation: Number(p.qualityDraft.minCloseLocation), maxVolumeRatio: Number(p.qualityDraft.maxVolumeRatio) });
  const selected = p.mode === "single" ? [p.strategyId] : p.selected;
  const actual = p.status?.phase === "idle" ? [] : p.status?.strategies || (p.status?.strategy ? [p.status.strategy] : []);
  const toggle = (id: TrendStrategyId, checked: boolean) => p.onSelected(checked ? [...p.selected, id] : p.selected.filter(item => item !== id));
  const renderChoice = (item: typeof TREND_STRATEGY_CHOICES[number], role: string, summary: string) => (
    <label key={item.id} title={summary} className={`trend-library-choice ${selected.includes(item.id) ? "is-selected" : ""}`}>
      <input type="checkbox" checked={selected.includes(item.id)} disabled={p.disabled} onChange={event => toggle(item.id, event.target.checked)} />
      <span><b>{item.name}</b><small>{role}</small><p>{summary}</p></span>
    </label>
  );

  return <section className="trend-strategy-settings" aria-label="趋势策略参数">
    <div className="trend-strategy-settings-head">
      <div><h2>策略模型对照 <small className="strategy-catalog-count">默认 2 套基准对照</small></h2><p>原版趋势 v1 用作基准，趋势质量 v2 增加过滤条件。当前没有数据证明其中一套收益更高。</p></div>
      <label className="trend-check"><input type="checkbox" checked={p.forceRefresh} disabled={p.disabled} onChange={event => p.onRefresh(event.target.checked)} /><span>重新获取行情（跳过缓存）</span></label>
    </div>
    <div className="trend-strategy-mode" role="group" aria-label="扫描模式" data-trend-field="strategies" tabIndex={-1}>
      {(["multi", "single"] as const).map(mode => <button key={mode} className={`trend-btn ${p.mode === mode ? "trend-btn-accent" : ""}`} disabled={p.disabled} onClick={() => p.onMode(mode)} aria-pressed={p.mode === mode}>{mode === "multi" ? "对照扫描" : "单模型扫描"}</button>)}
      <span>{p.mode === "multi" ? `已选 ${selected.length} 套` : "每次只运行一套"}</span>
    </div>

    {p.mode === "single" ? <div className="trend-core-models">
      <label className="trend-strategy-select"><span>扫描模型</span><select aria-label="扫描策略" value={p.strategyId} disabled={p.disabled} onChange={event => p.onStrategy(event.target.value as TrendStrategyId)}>{TREND_STRATEGY_CHOICES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <p>扩展指标模型使用固定参数；选择前可在下方查看各自触发条件和来源。</p>
    </div> : <>
      <div className="trend-core-models">
        <div className="trend-library-grid">
          {coreChoices.map(item => item.id === "classic-v1"
            ? renderChoice(item, "基准模型 · A 回踩 / B 平台", "共同基础条件通过后，A 回踩转强或 B 平台突破命中其一，并通过市场与价格风险门槛。")
            : renderChoice(item, "基准模型 + 质量过滤", `沿用 A / B 形态，再检查相对强度、均线承接和昨日 ATR 等条件。当前参数：偏离 ≤ ${p.qualityDraft.maxExtensionAtr} ATR、收盘位置 ≥ ${Number(p.qualityDraft.minCloseLocation) * 100}%、量比 ≤ ${p.qualityDraft.maxVolumeRatio}。`))}
        </div>
      </div>
      <details className="trend-advanced-models">
        <summary>扩展指标模型（{TREND_LIBRARY.length} 套，默认不选）</summary>
        <p>这些模型有独立指标触发条件，但仍先经过共同基础筛选和风险门槛。参数固定，作用是研究比较；目前没有证据证明它们优于基准。</p>
        <div className="trend-library-tools"><label><span>查找扩展模型</span><input aria-label="查找趋势策略" placeholder="名称 / 指标 / 形态" value={search} onChange={event => setSearch(event.target.value)} /></label><div role="group" aria-label="策略类型">{[["all", "全部"], ["pullback", "回调承接"], ["momentum", "趋势动能"], ["breakout", "区间突破"], ["volume", "量价确认"]].map(([id, label]) => <button key={id} className={category === id ? "active" : ""} aria-pressed={category === id} onClick={() => setCategory(id || "all")}>{label}</button>)}</div></div>
        <div className="trend-library-grid">{choices.map(item => renderChoice(item, libraryDefinition(item.id)?.family || "扩展指标", libraryDefinition(item.id)?.summary || "独立指标触发条件"))}</div>
        {choices.length === 0 && <p className="trend-library-empty">没有匹配模型，试试更换关键词或类型。</p>}
      </details>
    </>}

    {selected.includes("quality-v2") && <details className="trend-quality-parameters"><summary>趋势质量 v2 参数与预设</summary><p>稳健 / 均衡预设已冻结；当前为 {qualityPreset === "custom-research" ? "自定义研究参数（扫描前需填写原因）" : qualityPreset === "robust" ? "稳健预设" : "均衡预设"}。预设不代表收益优化，调整另记日志，不改写旧快照。</p><div className="trend-strategy-controls"><div className="trend-presets"><span>选择质量参数预设</span><div>{(["robust", "balanced"] as const).map(preset => <button className="trend-btn trend-btn-small" disabled={p.disabled} key={preset} onClick={() => p.onQuality(Object.fromEntries(Object.entries(TREND_QUALITY_PRESETS[preset]).map(([key, value]) => [key, String(value)])))}>{preset === "robust" ? "稳健" : "均衡"}</button>)}</div></div>{TREND_CONFIG_FIELDS.map(field => <label className="trend-strategy-select" key={field.key}><span>{field.label}</span><input data-trend-field={field.key} type="number" aria-label={field.label} min={field.min} max={field.max} step={field.step} value={p.qualityDraft[field.key]} disabled={p.disabled} onChange={event => p.onQuality({ ...p.qualityDraft, [field.key]: event.target.value })} /><small>{field.min}—{field.max}</small></label>)}</div></details>}

    <details className="trend-library-reference"><summary>查看 {TREND_LIBRARY.length} 套扩展模型的触发规则、固定参数与来源</summary><p>扩展模型是技术指标规则，不是收益预测。信号会受历史长度、交易日历、市场门槛和入场风险约束；规则或来源说明不构成收益验证。</p><div>{TREND_LIBRARY.map(item => <article key={item.id}><strong>{item.name} · v{item.version}</strong><p>{item.summary}</p><code>{Object.entries(item.parameters).map(([key, value]) => `${key}=${value}`).join(" · ")}</code><span>{item.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</span></article>)}</div></details>

    <details className="trend-scan-journal"><summary>扫描原因、研究区间与本地日志</summary><p>实时选股仍扫描当前历史窗口；以下研究区间仅记录研究意图，不会伪装为回测。最近200次请求保存在本机，记录参数指纹、策略版本和演示标识。</p><div className="trend-strategy-controls">
      <label className="trend-strategy-select"><span>扫描 / 调参原因</span><input data-trend-field="scanReason" aria-label="扫描 / 调参原因" maxLength={1000} value={p.scanReason} disabled={p.disabled} placeholder="默认记录冻结预设；自定义参数需填原因" onChange={event => p.onReason(event.target.value)} /></label>
      <label className="trend-strategy-select"><span>研究起始（可选）</span><input data-trend-field="researchStart" type="date" aria-label="研究起始" value={p.researchStart} disabled={p.disabled} onChange={event => p.onResearchStart(event.target.value)} /></label>
      <label className="trend-strategy-select"><span>研究截止（可选）</span><input data-trend-field="researchEnd" type="date" aria-label="研究截止" value={p.researchEnd} disabled={p.disabled} onChange={event => p.onResearchEnd(event.target.value)} /></label>
      <button className="trend-btn trend-btn-small" onClick={p.onExportJournal}>导出扫描日志 CSV</button>
    </div></details>
    <div className="trend-strategy-current">本次扫描：<b>{p.status && p.status.phase !== "idle" ? actual.length ? `${actual.length} 套 · ${actual.map(strategyName).join(" / ")}` : "原版趋势 v1" : "尚未扫描"}</b>{actual.length === 1 && <span>v{actual[0]?.version} · 配置 {actual[0]?.configHash.slice(0, 10)}</span>}{actual.length > 1 && p.status?.strategySetHash && <span>组合 {p.status.strategySetHash.slice(0, 10)}</span>}</div>
    {p.status?.phase !== "idle" && !!p.status?.strategyStats?.length && <div className="trend-strategy-coverage" aria-label="各策略扫描覆盖">{p.status.strategyStats.map(stat => <div key={stat.strategy.id}><b>{strategyName(stat.strategy)}</b><span>{stat.candidateCount} 条候选 · 已处理 {stat.processed}</span><small className={stat.coverageComplete ? "is-complete" : ""}>{stat.coverageComplete ? "覆盖完整" : "覆盖未完成"} · 不可用 {stat.unavailable} · 失败 {stat.failed}</small></div>)}</div>}
  </section>;
}
