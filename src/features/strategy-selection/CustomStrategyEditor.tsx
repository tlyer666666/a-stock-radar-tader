import { LoaderCircle, Plus, Save, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CUSTOM_CATALOG, conditionLabel, isExternalRef, isGateRef, validateCustomStrategy,
  type CustomStrategy, type CustomStrategyFilters, type CustomUniverse, type PatternOption
} from "./customStrategyModel";

const familyNames: Record<string, string> = { bottom_trend: "底部趋势", first_board: "首板", relay: "接力", breakout: "突破", pullback: "回踩", contraction: "收缩", repair: "修复" };

/**
 * Create / edit a user strategy. A strategy is a declarative condition set:
 * required conditions must all hold, "至少满足其一" needs one of a group, and
 * the share of all (non-gate) conditions met must reach the match percentage.
 */
export function CustomStrategyEditor({ initial, initialAiText = "", patterns, others, saving, error, onSave, onCancel, onImportSettings }: {
  initial: CustomStrategy; initialAiText?: string | undefined; patterns: PatternOption[]; others: CustomStrategy[]; saving: boolean; error: string;
  onSave: (strategy: CustomStrategy) => void; onCancel: () => void; onImportSettings?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState<CustomStrategy>(() => structuredClone(initial));
  const [attempted, setAttempted] = useState(false);
  const [patternQuery, setPatternQuery] = useState("");
  const [aiText, setAiText] = useState(initialAiText);
  const autoDrafted = useRef(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<{ ok: boolean; text: string } | null>(null);
  const aiApi = typeof window === "undefined" ? undefined : window.stockApi?.ai;
  const draftWithAi = async (text = aiText) => {
    if (!aiApi || aiBusy || !text.trim()) return;
    setAiBusy(true); setAiNote(null);
    try {
      const result = await aiApi.draftStrategy({ text: text.trim(), patterns: patterns.map(item => ({ id: item.id, name: item.name, detail: item.detail })) });
      const next = result.strategy as CustomStrategy;
      setDraft(current => ({ ...current, name: next.name, description: next.description, universe: next.universe, conditions: next.conditions,
        requiredAnyGroups: next.requiredAnyGroups || [], minMatchPercent: next.minMatchPercent, filters: next.filters || {} }));
      setAttempted(false);
      setAiNote({ ok: true, text: `AI 已按你的描述配好 ${next.conditions.length} 个条件，请检查后再保存。${result.notes ? `说明：${result.notes}` : ""}` });
    } catch (error) {
      setAiNote({ ok: false, text: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "") });
    } finally { setAiBusy(false); }
  };
  // 从「AI 选股」页带来的描述：等策略目录加载好后自动让 AI 配一次条件。
  useEffect(() => {
    if (autoDrafted.current || !initialAiText.trim() || !patterns.length) return;
    autoDrafted.current = true;
    void draftWithAi(initialAiText);
  }, [initialAiText, patterns.length]);
  const issues = useMemo(() => validateCustomStrategy(draft, patterns, others), [draft, patterns, others]);
  const issueFor = (field: string) => attempted ? issues.find(item => item.field === field || item.field.startsWith(`${field}.`))?.message : undefined;
  const selected = new Map(draft.conditions.map(item => [item.ref, item]));
  const anyGroup = draft.requiredAnyGroups[0] || [];
  const toggle = (ref: string) => setDraft(current => {
    if (current.conditions.some(item => item.ref === ref)) {
      return { ...current, conditions: current.conditions.filter(item => item.ref !== ref),
        requiredAnyGroups: current.requiredAnyGroups.map(group => group.filter(item => item !== ref)).filter(group => group.length) };
    }
    return { ...current, conditions: [...current.conditions, { ref, required: false }] };
  });
  const setRequired = (ref: string, required: boolean) => setDraft(current => ({ ...current,
    conditions: current.conditions.map(item => item.ref === ref ? { ...item, required } : item),
    requiredAnyGroups: required ? current.requiredAnyGroups.map(group => group.filter(item => item !== ref)).filter(group => group.length) : current.requiredAnyGroups }));
  const setInGroup = (ref: string, inGroup: boolean) => setDraft(current => {
    const [first = [], ...rest] = current.requiredAnyGroups;
    const next = inGroup ? [...new Set([...first, ref])] : first.filter(item => item !== ref);
    return { ...current, requiredAnyGroups: next.length ? [next, ...rest] : rest };
  });
  const setFilter = <K extends keyof CustomStrategyFilters>(key: K, value: CustomStrategyFilters[K] | undefined) => setDraft(current => {
    const filters = { ...current.filters };
    if (value === undefined || value === "" as unknown) delete filters[key]; else filters[key] = value;
    return { ...current, filters };
  });
  const boards = draft.filters.boards || CUSTOM_CATALOG.boards.map(item => item.id);
  const toggleBoard = (id: string) => {
    const next = boards.includes(id) ? boards.filter(item => item !== id) : [...boards, id];
    setFilter("boards", next.length === CUSTOM_CATALOG.boards.length ? undefined : next);
  };
  const submit = () => {
    setAttempted(true);
    // A single-member "至少满足其一" group is meaningless; drop it rather than block saving.
    const cleaned = { ...draft, name: draft.name.trim(), description: draft.description.trim(), requiredAnyGroups: draft.requiredAnyGroups.filter(group => group.length >= 2) };
    if (validateCustomStrategy(cleaned, patterns, others).length) return;
    onSave(cleaned);
  };
  const visiblePatterns = patterns.filter(item => !patternQuery.trim() || `${item.name} ${item.detail || ""}`.toLowerCase().includes(patternQuery.trim().toLowerCase()));
  const factor = (group: "daily" | "external") => CUSTOM_CATALOG.factors.filter(item => item.group === group);
  const checkbox = (ref: string, label: string, detail: string) => <label key={ref} className={`custom-condition-option ${selected.has(ref) ? "selected" : ""}`} title={detail}>
    <input type="checkbox" checked={selected.has(ref)} onChange={() => toggle(ref)} aria-label={label} /><span><b>{label}</b><small>{detail}</small></span>
  </label>;
  const numberInput = (spec: (typeof CUSTOM_CATALOG.filters)[number]) => <label key={spec.key} className="custom-filter-field">
    <span>{spec.label}</span>
    <span className="custom-filter-input"><input type="number" inputMode="decimal" aria-label={spec.label} min={spec.min} max={spec.max} step={spec.step} placeholder="不限"
      value={draft.filters[spec.key] === undefined ? "" : String(draft.filters[spec.key])}
      onChange={event => setFilter(spec.key, event.target.value === "" ? undefined : Number(event.target.value) as never)} /><em>{spec.unit}</em></span>
  </label>;

  return <section className="panel custom-strategy-editor" aria-label={draft.id ? "编辑自定义策略" : "新建自定义策略"}>
    <header className="custom-editor-head">
      <div><h2>{draft.id ? "编辑策略" : "新建策略"}</h2><p>选择条件并设定匹配规则；保存后立即参与选股，并生成同口径的历史参考。</p></div>
      <div className="custom-editor-actions">
        {!draft.id && onImportSettings && <button type="button" className="secondary-btn" onClick={onImportSettings} disabled={saving}>从设置的自主组合导入</button>}
        <button type="button" className="secondary-btn" onClick={onCancel} disabled={saving}><X size={15} />取消</button>
        <button type="button" className="primary-btn" onClick={submit} disabled={saving}><Save size={15} />{saving ? "保存中…" : "保存并选股"}</button>
      </div>
    </header>
    {aiApi && <div className="custom-ai-draft">
      <label><span><b><Sparkles size={15} />用大白话描述，AI 帮你配条件</b><small>例如：“近一周首板、回踩不破涨停低点、缩量，成交额至少 3 亿，不要北交所”。AI 只会用下方条件库里已有的条件，配好后你可以再改。</small></span>
        <textarea aria-label="用大白话描述选股条件" rows={2} maxLength={400} value={aiText} onChange={event => setAiText(event.target.value)} placeholder="描述你想要的选股条件…" /></label>
      <button type="button" className="secondary-btn" onClick={() => void draftWithAi()} disabled={aiBusy || saving || !aiText.trim()}>{aiBusy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{aiBusy ? "AI 配置中…" : "AI 帮我配置"}</button>
      {aiNote && <p className={aiNote.ok ? "custom-ai-note" : "field-error"} role={aiNote.ok ? "status" : "alert"}>{aiNote.text}</p>}
    </div>}
    {(error || (attempted && issues.length > 0)) && <div className="warning-banner" role="alert">{error || `请先修正 ${issues.length} 处问题：${issues[0]!.message}`}</div>}

    <div className="custom-editor-grid">
      <fieldset className="custom-editor-section">
        <legend>基本信息</legend>
        <label className="custom-field"><span>策略名称</span><input aria-label="策略名称" maxLength={CUSTOM_CATALOG.limits.nameMax + 10} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} aria-invalid={Boolean(issueFor("name"))} />{issueFor("name") && <small className="field-error">{issueFor("name")}</small>}</label>
        <label className="custom-field"><span>策略说明（选填）</span><textarea aria-label="策略说明" rows={2} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} />{issueFor("description") && <small className="field-error">{issueFor("description")}</small>}</label>
        <div className="custom-field" role="radiogroup" aria-label="选股范围"><span>选股范围</span>
          {CUSTOM_CATALOG.universes.map(item => <label key={item.id} className="custom-radio"><input type="radio" name="custom-universe" checked={draft.universe === item.id} onChange={() => setDraft({ ...draft, universe: item.id as CustomUniverse })} /><span><b>{item.label}</b><small>{item.detail}</small></span></label>)}
        </div>
      </fieldset>

      <fieldset className="custom-editor-section">
        <legend>已选条件（{draft.conditions.length}）</legend>
        {issueFor("conditions") && <small className="field-error">{issueFor("conditions")}</small>}
        {!draft.conditions.length && <p className="custom-empty">从下方条件库勾选。必要条件须全部满足；其余条件按匹配比例计算。</p>}
        <ul className="custom-selected-list">{draft.conditions.map(item => {
          const gate = isGateRef(item.ref), external = isExternalRef(item.ref), label = conditionLabel(item.ref, patterns);
          return <li key={item.ref} className={external ? "external" : ""}>
            <b>{label}</b>{external && <em className="custom-pending-tag">选股时待确认</em>}{gate && <em className="custom-gate-tag">门槛</em>}
            <span className="custom-selected-controls">
              {!gate && <label><input type="checkbox" checked={item.required === true} onChange={event => setRequired(item.ref, event.target.checked)} aria-label={`${label} 设为必要条件`} />必要</label>}
              {!gate && !item.required && <label><input type="checkbox" checked={anyGroup.includes(item.ref)} onChange={event => setInGroup(item.ref, event.target.checked)} aria-label={`${label} 加入至少满足其一`} />至少其一</label>}
              <button type="button" className="icon-btn" onClick={() => toggle(item.ref)} aria-label={`移除 ${label}`}><Trash2 size={14} /></button>
            </span>
          </li>;
        })}</ul>
        {anyGroup.length === 1 && <small className="custom-hint">“至少其一”需要勾选两个以上条件才会生效。</small>}
        {draft.requiredAnyGroups.length > 1 && <small className="custom-hint">另有 {draft.requiredAnyGroups.length - 1} 组“至少满足其一”来自迁移，保存时保留。</small>}
        <label className="custom-field custom-match"><span>最低匹配比例</span>
          <span className="custom-filter-input"><input type="number" aria-label="最低匹配比例" min={0} max={100} step={5} value={draft.minMatchPercent} onChange={event => setDraft({ ...draft, minMatchPercent: Number(event.target.value) })} /><em>%</em></span>
          <small>全部条件（不含门槛）中至少满足的比例；设置页原有组合为 70%。{issueFor("minMatchPercent")}</small></label>
        <p className="custom-veto"><ShieldCheck size={15} />风险否决始终启用：跌破涨停日低点、量能超过前五日2倍、放量跌破均价或放量弱收盘时排除。</p>
      </fieldset>
    </div>

    <fieldset className="custom-editor-section custom-library">
      <legend>条件库</legend>
      <div className="custom-group"><h3>日线因子 <small>与个股分析同一算法</small></h3>
        <div className="custom-option-grid">{factor("daily").map(item => checkbox(`factor:${item.id}`, item.label, item.detail))}</div></div>
      <div className="custom-group"><h3>涨停形态规则 <small>引用内置规则作为条件</small></h3>
        <input className="custom-pattern-search" aria-label="查找形态规则" placeholder="查找规则名称或说明" value={patternQuery} onChange={event => setPatternQuery(event.target.value)} />
        <div className="custom-option-grid">{visiblePatterns.map(item => checkbox(`pattern:${item.id}`, item.name, `${familyNames[item.family || ""] || "形态"} · ${item.detail || ""}`))}</div></div>
      <div className="custom-group"><h3>需个股数据 <small>批量选股时不逐只取数，标为“待确认”，在个股分析中核对</small></h3>
        <div className="custom-option-grid">{factor("external").map(item => checkbox(`factor:${item.id}`, item.label, item.detail))}</div></div>
    </fieldset>

    <fieldset className="custom-editor-section custom-filters">
      <legend>数值门槛（留空为不限）</legend>
      <div className="custom-filter-grid">{CUSTOM_CATALOG.filters.map(numberInput)}</div>
      {(issueFor("filters")) && <small className="field-error">{issueFor("filters")}</small>}
      <label className="custom-check"><input type="checkbox" checked={draft.filters.excludeOnePriceToday === true} onChange={event => setFilter("excludeOnePriceToday", event.target.checked ? true : undefined)} />排除当日一字涨停（次日大概率买不到）</label>
      <div className="custom-boards" role="group" aria-label="板块范围"><span>板块范围</span>{CUSTOM_CATALOG.boards.map(item => <label key={item.id} className="custom-check"><input type="checkbox" checked={boards.includes(item.id)} onChange={() => toggleBoard(item.id)} />{item.label}</label>)}</div>
    </fieldset>
    <footer className="custom-editor-foot"><button type="button" className="secondary-btn" onClick={onCancel} disabled={saving}>取消</button><button type="button" className="primary-btn" onClick={submit} disabled={saving}><Plus size={15} />{saving ? "保存中…" : "保存并选股"}</button></footer>
  </section>;
}
