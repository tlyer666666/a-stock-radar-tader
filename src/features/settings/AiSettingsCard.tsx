import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, LoaderCircle, Pencil, Plus, Scale, ShieldCheck, Trash2, Wifi, X } from "lucide-react";
import { PanelTitle } from "../../components/terminal/TerminalPrimitives";

/** 常用 AI 服务：只填地址和示例模型名，Key 需在对应平台申请。模型名可随意改成平台支持的任何模型。 */
export const AI_PRESETS = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k" },
  { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "本机 Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b" }
] as const;

export const AI_INSTRUCTION_EXAMPLES = {
  rank: "例如：更看重龙头地位和题材持续性；4 连板以上一律给“观望”；成交额不足 2 亿的减 10 分；看点里写清楚属于哪个题材。",
  summary: "例如：最后列出明天竞价要观察的 5 只股票和各自的观察价位；风险部分重点说退潮信号。"
};

type Editing = { id: string | null; name: string; baseUrl: string; model: string; apiKey: string; hasKey: boolean };
const blank = (): Editing => ({ id: null, name: "", baseUrl: "", model: "", apiKey: "", hasKey: false });
const cleanError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "");

/**
 * 设置 → AI 助手：多套模型配置（名称/地址/模型/Key，可随时切换）+ 自定义 AI 要求（打分偏好、总结格式）。
 * 模型配置单独保存并即时生效；自定义要求随设置一起保存。
 */
export function AiSettingsCard({ hidden, draft, setDraft, onSave, saving, saveError, loadState }: {
  hidden: boolean; draft: Settings; setDraft: (next: Settings) => void; onSave: () => void; saving: boolean; saveError: string; loadState: "loading" | "ready" | "failed";
}) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai;
  const [list, setList] = useState<AiProfileList | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const profileRevision = useRef(0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!api?.profiles) return;
    const current = ++profileRevision.current;
    try {
      const value = await api.profiles();
      if (profileRevision.current === current) setList(value);
    } catch (error) { if (profileRevision.current === current) setMessage({ ok: false, text: cleanError(error) }); }
  }, [api]);
  useEffect(() => {
    if (!hidden) void refresh();
    return () => { profileRevision.current += 1; };
  }, [hidden, refresh]);

  const acceptProfiles = (value: AiProfileList) => {
    profileRevision.current += 1; // An acknowledged mutation outranks an earlier list read.
    setList(value);
  };
  const act = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setMessage(null);
    try { await work(); } catch (error) { setMessage({ ok: false, text: cleanError(error) }); } finally { setBusy(false); }
  };
  const startEdit = (profile?: AiProfile) => {
    setMessage(null);
    setEditing(profile ? { id: profile.id, name: profile.name, baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.hasKey ? "••••••••••••" : "", hasKey: profile.hasKey }
      : { ...blank(), name: list?.profiles.length ? `配置 ${list.profiles.length + 1}` : "默认" });
  };
  const saveProfile = () => act(async () => {
    if (!api || !editing) return;
    const result = await api.saveProfile({ id: editing.id, name: editing.name, baseUrl: editing.baseUrl, model: editing.model, apiKey: editing.apiKey, activate: !list?.profiles.length });
    acceptProfiles(result); setEditing(null);
    setMessage({ ok: true, text: `已保存「${result.saved.name}」${result.activeId === result.saved.id ? "，正在使用" : ""}。` });
  });
  const testProfile = () => act(async () => {
    if (!api || !editing) return;
    const result = await api.test({ id: editing.id, baseUrl: editing.baseUrl, model: editing.model, apiKey: editing.apiKey });
    setMessage({ ok: true, text: `连接成功 · 模型 ${result.model} · ${result.latency} ms。记得点“保存这套配置”。` });
  });

  if (!api?.profiles) return <div className="panel settings-card" id="settings-ai" hidden={hidden}>
    <PanelTitle title="AI 助手" subtitle="桌面版可用" icon={Bot} /><p className="source-health-note">浏览器预览不调用 AI，请在桌面版设置。</p></div>;

  return <div className="panel settings-card ai-settings-card" id="settings-ai" hidden={hidden}>
    <PanelTitle title="AI 助手" subtitle="模型配置可存多套随时切换；AI 的打分和总结可以按你的要求来" icon={Bot} badge={list ? `${list.profiles.length} 套模型` : undefined} />

    <section className="ai-settings-section" aria-label="模型配置">
      <h3>模型配置</h3>
      <p className="source-health-note">支持所有兼容 OpenAI 接口格式的大模型。接口地址和模型名都可以自己填，用平台支持的任何模型都行（例如 deepseek-reasoner、qwen-max、gpt-4o），也可以填中转地址或本机 Ollama。Key 只加密保存在本机。</p>
      <ul className="ai-profile-list">{(list?.profiles || []).map(profile => {
        const active = list?.activeId === profile.id;
        return <li key={profile.id} className={active ? "active" : ""}>
          <div><b>{profile.name}</b>{active && <em className="ai-profile-active"><Check size={12} />使用中</em>}
            <small>{profile.model} · {profile.baseUrl}{profile.hasKey ? "" : " · 未填 Key"}</small></div>
          <span>
            {!active && <button type="button" className="secondary-btn" disabled={busy} onClick={() => act(async () => { acceptProfiles(await api.activateProfile(profile.id)); setMessage({ ok: true, text: `已切换到「${profile.name}」。` }); })}>设为使用</button>}
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => startEdit(profile)} aria-label={`编辑 ${profile.name}`}><Pencil size={14} />编辑</button>
            <button type="button" className="secondary-btn danger-btn" disabled={busy} onClick={() => act(async () => { acceptProfiles(await api.deleteProfile(profile.id)); if (editing?.id === profile.id) setEditing(null); })} aria-label={`删除 ${profile.name}`}><Trash2 size={14} /></button>
          </span>
        </li>;
      })}</ul>
      {list && !list.profiles.length && !editing && <p className="source-health-note">还没有模型配置，点“新增模型配置”添加第一套。</p>}
      {!editing && <button type="button" className="secondary-btn" onClick={() => startEdit()} disabled={busy || (list ? list.profiles.length >= list.max : false)}><Plus size={15} />新增模型配置</button>}

      {editing && <div className="ai-profile-editor" aria-label={editing.id ? "编辑模型配置" : "新增模型配置"}>
        <div className="ai-provider-presets" role="group" aria-label="常用 AI 服务（一键填入，可再修改）">
          {AI_PRESETS.map(preset => <button key={preset.label} type="button" className="secondary-btn" onClick={() => setEditing({ ...editing, baseUrl: preset.baseUrl, model: preset.model, name: editing.name && !AI_PRESETS.some(item => item.label === editing.name) && editing.name !== "默认" && !/^配置 \d+$/.test(editing.name) ? editing.name : preset.label })}>{preset.label}</button>)}
        </div>
        <label className="field"><span>配置名称</span><input value={editing.name} maxLength={20} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="例如：DeepSeek 便宜快" /></label>
        <label className="field"><span>接口地址</span><input value={editing.baseUrl} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" autoComplete="off" spellCheck={false} />
          <small>填到 /v1 之类的版本路径即可，软件会自动补 /chat/completions；只接受 https（本机 localhost 可用 http）。</small></label>
        <label className="field"><span>模型名称</span><input value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })} placeholder="deepseek-chat" autoComplete="off" spellCheck={false} />
          <small>任意填写平台支持的模型名，以平台文档为准。</small></label>
        <label className="field"><span>API Key</span><input type="password" value={editing.apiKey} onChange={e => setEditing({ ...editing, apiKey: e.target.value })} onFocus={e => { if (/^•+$/.test(editing.apiKey)) e.currentTarget.select(); }} placeholder="sk-…" autoComplete="off" />
          <small>{editing.hasKey ? "已保存 Key；不改就保持原样，清空后保存则删除 Key。" : "只加密保存在本机。"}发给 AI 的只有股票代码、名称、行业和规则指标，不含持仓、自选或账号信息。</small></label>
        <div className="settings-actions">
          <button type="button" className="secondary-btn" onClick={() => setEditing(null)} disabled={busy}><X size={15} />取消</button>
          <button type="button" className="secondary-btn" onClick={() => void testProfile()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Wifi size={16} />}测试连接</button>
          <button type="button" className="primary-btn" onClick={() => void saveProfile()} disabled={busy}><ShieldCheck size={16} />保存这套配置</button>
        </div>
      </div>}
      {message && <div className={`test-result ${message.ok ? "ok" : "fail"}`} role={message.ok ? "status" : "alert"}><span />{message.text}</div>}
    </section>

    <AiFrameworkSettings />

    <section className="ai-settings-section" aria-label="自定义 AI 要求">
      <h3>自定义 AI 要求</h3>
      <p className="source-health-note">写下你自己的选股偏好和格式要求，AI 打分和写总结时会照着做；不编造消息、分数 0–100、只评规则选出的股票这些底线不变。改了要求后，下次点“重新打分 / 重新总结”生效。</p>
      <label className="field"><span>打分与点评要求</span>
        <textarea rows={4} maxLength={1000} value={draft.aiRankInstructions || ""} onChange={e => setDraft({ ...draft, aiRankInstructions: e.target.value })} placeholder={AI_INSTRUCTION_EXAMPLES.rank} />
        <small>{[...(draft.aiRankInstructions || "")].length}/1000</small></label>
      <label className="field"><span>每日总结要求</span>
        <textarea rows={4} maxLength={1000} value={draft.aiSummaryInstructions || ""} onChange={e => setDraft({ ...draft, aiSummaryInstructions: e.target.value })} placeholder={AI_INSTRUCTION_EXAMPLES.summary} />
        <small>{[...(draft.aiSummaryInstructions || "")].length}/1000</small></label>
      <div className="settings-actions">
        <button className="primary-btn" onClick={onSave} disabled={saving || loadState !== "ready"}>{saving ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}{saving ? "正在保存" : "保存 AI 要求"}</button>
      </div>
      {saveError && <div className="test-result fail" role="alert"><span />{saveError}</div>}
    </section>
    <p className="source-health-note">AI 的点评和分数基于规则选股给出的数据，模型可能出错，仅供参考，不构成投资建议；股票是否入选仍由规则决定。</p>
  </div>;
}

/**
 * 设置 → AI 助手 → 分析框架：选择默认框架，编辑自定义框架（各维度权重、硬规则、补充说明）。
 * 框架决定软件怎么先算基础分；AI 只能在基础分上下 15 分内调整。
 */
function AiFrameworkSettings() {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai;
  const [catalog, setCatalog] = useState<AiFrameworkCatalog | null>(null);
  const [draft, setDraft] = useState<AiCustomFramework | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!api?.frameworks) return;
    let active = true;
    void api.frameworks().then(value => { if (active) { setCatalog(value); setDraft(structuredClone(value.custom)); } }).catch(() => {});
    return () => { active = false; };
  }, [api]);
  if (!api?.frameworks || !api.saveFramework || !catalog || !draft) return null;
  const save = async (input: { active?: AiFrameworkInfo["id"]; custom?: AiCustomFramework }, text: string) => {
    if (busy || !api.saveFramework) return;
    setBusy(true); setMessage(null);
    try { const next = await api.saveFramework(input); setCatalog(next); setDraft(structuredClone(next.custom)); setMessage({ ok: true, text }); }
    catch (error) { setMessage({ ok: false, text: cleanError(error) }); }
    finally { setBusy(false); }
  };
  const total = Object.values(draft.weights).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return <section className="ai-settings-section" aria-label="分析框架">
    <h3><Scale size={15} />分析框架</h3>
    <p className="source-health-note">默认「AI 自动编排」：软件先识别每只股票的情境（连板中、深跌底部、多头趋势、突破新高、缩量整理…），按 14 套策略各算一个基础分，AI 再按情境自主挑 1–3 套组合使用；每套策略和自动编排都叠加「实测胜率」——按 2021–2026 全A日线实测，追涨停次日买入、乖离大、短期涨幅大的平均跑输，深跌离 60 日线远的跑赢。也可以只用其中一套，或用自己的自定义框架。AI 只能在基础分上下 15 分内调整并写出理由；命中硬规则的最多给“观望”。换框架后已有结果不再适用，需要重新打分。</p>
    <div className="ai-framework-choices" role="radiogroup" aria-label="默认分析框架">{catalog.frameworks.map(item => <label key={item.id} className={`${catalog.active === item.id ? "active" : ""}${item.id === "auto" ? " recommended" : ""}`}>
      <input type="radio" name="ai-framework" checked={catalog.active === item.id} disabled={busy} onChange={() => void save({ active: item.id }, `已改用「${item.name}」。`)} />
      <span><b>{item.name}{item.id === "auto" ? "（推荐）" : ""}</b><small>{item.description}</small>
        {item.id !== "auto" && <small>{item.dimensions.map(dim => `${dim.label} ${dim.weight}`).join(" · ")}{item.caps.length ? ` ｜ 硬规则：${item.caps.map(cap => cap.label).join("；")}` : ""}</small>}</span></label>)}</div>
    <details className="ai-framework-editor">
      <summary>编辑自定义框架</summary>
      <label className="field"><span>框架名称</span><input value={draft.name} maxLength={12} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <div className="ai-framework-weights">{catalog.dimensions.map(dim => <label key={dim.id} className="field">
        <span>{dim.label}</span>
        <input type="number" min={0} max={100} step={5} value={draft.weights[dim.id] ?? 0} aria-label={`${dim.label}权重`}
          onChange={event => setDraft({ ...draft, weights: { ...draft.weights, [dim.id]: Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))) } })} />
        <small>{dim.detail}</small></label>)}</div>
      <p className="source-health-note">权重填 0 表示不看这个维度；权重会按总和自动折算（当前合计 {total}）。</p>
      <fieldset className="ai-framework-caps"><legend>硬规则（命中后最多“观望”）</legend>
        {catalog.caps.map(cap => <label key={cap.id}><input type="checkbox" checked={draft.caps.includes(cap.id)}
          onChange={event => setDraft({ ...draft, caps: event.target.checked ? [...draft.caps, cap.id] : draft.caps.filter(id => id !== cap.id) })} />{cap.label}</label>)}</fieldset>
      <label className="field"><span>补充说明（告诉 AI 这个框架看重什么，可选）</span>
        <textarea rows={3} maxLength={500} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} placeholder="例如：更看重回踩 20 日线不破、缩量企稳；对高位股严格扣分。" />
        <small>{[...draft.note].length}/500</small></label>
      <div className="settings-actions">
        <button type="button" className="secondary-btn" disabled={busy || total <= 0} onClick={() => void save({ custom: draft }, "已保存自定义框架。")}>保存</button>
        <button type="button" className="primary-btn" disabled={busy || total <= 0} onClick={() => void save({ custom: draft, active: "custom" }, "已保存并改用自定义框架。")}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}保存并使用</button>
      </div>
    </details>
    {message && <div className={`test-result ${message.ok ? "ok" : "fail"}`} role={message.ok ? "status" : "alert"}><span />{message.text}</div>}
  </section>;
}
