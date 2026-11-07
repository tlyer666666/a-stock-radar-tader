import { useMemo, useState } from "react";
import { Check, ChevronDown, Layers, PenLine, Plus, Trash2, X } from "lucide-react";
import { skillDraftProblem, toggleSkill, verdictTone } from "./agentModel";

type SkillInput = { id?: string | undefined; name: string; method: string; tools: string[] };

/**
 * 分析打法：在对话区上方选 0–3 种打法（不选 = AI 自己决定怎么分析），可以叠加；
 * 「我的打法」可以新建、修改、删除，保存在本机。
 */
export function SkillBar({ catalog, tools, selected, disabled, onChange, onSave, onRemove }: {
  catalog: AgentSkillCatalog; tools: { id: string; name: string }[]; selected: string[]; disabled: boolean;
  onChange: (ids: string[]) => void; onSave?: ((input: SkillInput) => Promise<string>) | undefined; onRemove?: ((id: string) => Promise<void>) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(catalog.skills.map(skill => [skill.id, skill])), [catalog]);
  const chosen = selected.map(id => byId.get(id)).filter((skill): skill is AgentSkill => Boolean(skill));
  const full = chosen.length >= catalog.maxSelected;
  return <div className="ai-agent-skillbar">
    <div className="ai-agent-skillbar-row">
      <span className="ai-agent-skillbar-label"><Layers size={14} />分析打法</span>
      {chosen.length ? chosen.map(skill => <span key={skill.id} className="ai-agent-skill-chip">{skill.name}
        <button type="button" aria-label={`不用「${skill.name}」`} disabled={disabled} onClick={() => onChange(selected.filter(id => id !== skill.id))}><X size={12} /></button></span>)
        : <span className="ai-agent-muted">自动（AI 自己决定怎么分析）</span>}
      <button type="button" className="link-btn ai-agent-skill-toggle" aria-expanded={open} aria-controls="ai-agent-skill-panel" onClick={() => setOpen(value => !value)}>
        {open ? "收起" : chosen.length ? "更换打法" : "选择打法"}<ChevronDown size={13} className={open ? "flip" : ""} /></button>
    </div>
    {open && <div className="ai-agent-skill-panel" id="ai-agent-skill-panel" role="group" aria-label="选择分析打法">
      <p className="ai-agent-muted">最多选 {catalog.maxSelected} 种，可以叠加（如「低吸回踩」+「风险收益比」）；AI 会先查齐每种打法要看的数据，逐条对照判断要点，并给出每种打法「符合 / 接近 / 不符合」的结论。
        {chosen.length > 0 && <button type="button" className="link-btn" disabled={disabled} onClick={() => onChange([])}>清空，改回自动</button>}</p>
      {catalog.groups.map(group => {
        const items = catalog.skills.filter(skill => skill.group === group);
        if (!items.length && group !== "我的打法") return null;
        return <section key={group} className="ai-agent-skill-group" aria-label={group}>
          <h4>{group}{group === "我的打法" && <small>（{items.length}/{catalog.maxCustom}）</small>}</h4>
          <div className="ai-agent-skill-grid">
            {items.map(skill => {
              const active = selected.includes(skill.id);
              return <div key={skill.id} className={`ai-agent-skill-option ${active ? "active" : ""}`}>
                <button type="button" className="ai-agent-skill-pick" aria-pressed={active} disabled={disabled || (!active && full)}
                  title={!active && full ? `最多选 ${catalog.maxSelected} 种` : skill.summary} onClick={() => onChange(toggleSkill(selected, skill.id, catalog.maxSelected))}>
                  <b>{active && <Check size={13} />}{skill.name}</b>
                  <span>{skill.summary || (skill.method ? skill.method.split(/\n/)[0] : "")}</span>
                  {skill.tools.length > 0 && <small>看：{skill.tools.join("、")}</small>}
                </button>
                {skill.custom && <CustomActions skill={skill} tools={tools} disabled={disabled} onSave={onSave} onRemove={onRemove} />}
              </div>;
            })}
            {group === "我的打法" && onSave && items.length < catalog.maxCustom && <NewSkill tools={tools} disabled={disabled} onSave={async input => {
              const id = await onSave(input);
              if (id && !full) onChange(toggleSkill(selected, id, catalog.maxSelected));
              return id;
            }} />}
          </div>
        </section>;
      })}
    </div>}
  </div>;
}

function CustomActions({ skill, tools, disabled, onSave, onRemove }: { skill: AgentSkill; tools: { id: string; name: string }[]; disabled: boolean;
  onSave?: ((input: SkillInput) => Promise<string>) | undefined; onRemove?: ((id: string) => Promise<void>) | undefined }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (editing && onSave) return <SkillEditor tools={tools} initial={{ id: skill.id, name: skill.name, method: skill.method || "", tools: skill.toolIds || [] }}
    onCancel={() => setEditing(false)} onSave={async input => { const id = await onSave(input); setEditing(false); return id; }} />;
  return <span className="ai-agent-skill-actions">
    {onSave && <button type="button" className="link-btn" disabled={disabled} onClick={() => setEditing(true)} aria-label={`修改「${skill.name}」`}><PenLine size={12} />修改</button>}
    {onRemove && <button type="button" className={`link-btn ${confirm ? "danger" : ""}`} disabled={disabled} aria-label={confirm ? `确认删除「${skill.name}」` : `删除「${skill.name}」`}
      onClick={() => { if (!confirm) { setConfirm(true); return; } void onRemove(skill.id); }}><Trash2 size={12} />{confirm ? "确认删除" : "删除"}</button>}
  </span>;
}

function NewSkill({ tools, disabled, onSave }: { tools: { id: string; name: string }[]; disabled: boolean; onSave: (input: SkillInput) => Promise<string> }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="ai-agent-skill-new" disabled={disabled} onClick={() => setOpen(true)}><Plus size={15} />新建我的打法</button>;
  return <div className="ai-agent-skill-option editing"><SkillEditor tools={tools} initial={{ name: "", method: "", tools: ["kline", "intraday"] }}
    onCancel={() => setOpen(false)} onSave={async input => { const id = await onSave(input); setOpen(false); return id; }} /></div>;
}

function SkillEditor({ tools, initial, onCancel, onSave }: { tools: { id: string; name: string }[]; initial: SkillInput; onCancel: () => void; onSave: (input: SkillInput) => Promise<string> }) {
  const [name, setName] = useState(initial.name);
  const [method, setMethod] = useState(initial.method);
  const [picked, setPicked] = useState<string[]>(initial.tools);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const choices = tools.filter(tool => tool.id !== "search_stock");
  const save = async () => {
    const problem = skillDraftProblem({ name, method, tools: picked });
    if (problem) { setError(problem); return; }
    setSaving(true); setError("");
    try { await onSave({ ...(initial.id ? { id: initial.id } : {}), name: name.trim(), method: method.trim(), tools: picked }); }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "").replace(/^\[[A-Z_]+\]\s*/, "")); }
    finally { setSaving(false); }
  };
  return <form className="ai-agent-skill-editor" aria-label={initial.id ? "修改我的打法" : "新建我的打法"} onSubmit={event => { event.preventDefault(); void save(); }}>
    <label><span>名称</span><input value={name} maxLength={12} placeholder="例如：尾盘低吸" aria-label="打法名称" onChange={event => setName(event.target.value)} /></label>
    <label><span>判断要点</span><textarea rows={4} maxLength={600} value={method} aria-label="打法判断要点"
      placeholder={"一行一条，例如：\n尾盘 14:30 后缩量回踩分时均价线\n当日涨幅在 0–3% 之间，不追高\n次日冲高 3% 以上卖出，跌破当日最低价止损"} onChange={event => setMethod(event.target.value)} /></label>
    <fieldset><legend>要看的数据（最多 6 项）</legend>
      {choices.map(tool => <label key={tool.id} className="ai-agent-skill-tool"><input type="checkbox" checked={picked.includes(tool.id)}
        disabled={!picked.includes(tool.id) && picked.length >= 6} onChange={event => setPicked(current => event.target.checked ? [...current, tool.id] : current.filter(id => id !== tool.id))} />{tool.name}</label>)}
    </fieldset>
    {error && <p className="ai-agent-skill-error" role="alert">{error}</p>}
    <div className="ai-agent-skill-editor-actions"><button type="submit" className="primary-btn" disabled={saving}>{saving ? "保存中…" : "保存打法"}</button>
      <button type="button" className="secondary-btn" onClick={onCancel}>取消</button></div>
  </form>;
}

/** 回答上方：每种打法的结论（符合 / 接近 / 不符合 / 不适用）和一句依据。 */
export function SkillVerdicts({ verdicts }: { verdicts: AgentSkillVerdict[] }) {
  return <ul className="ai-agent-verdicts" aria-label="按打法的结论">{verdicts.map(item => <li key={item.id}>
    <b>{item.skill}</b><span className={`ai-agent-verdict ${verdictTone(item.verdict)}`}>{item.verdict}</span>{item.reason && <small>{item.reason}</small>}
  </li>)}</ul>;
}

export function SkillTags({ skills }: { skills: AgentSkillTag[] }) {
  return <p className="ai-agent-muted ai-agent-skill-tags">按打法分析：{skills.map(skill => skill.name).join("、")}</p>;
}
