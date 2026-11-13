import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  Bot, Check, ChevronDown, CircleAlert, CircleStop, Copy, ExternalLink, LoaderCircle, MessagesSquare, PenLine, Plus, RotateCcw, Search, SendHorizontal, Settings, Trash2, Wrench, X
} from "lucide-react";
import { SkillBar, SkillTags, SkillVerdicts } from "./AgentSkills";
import { PageHeading } from "../../components/terminal/TerminalPrimitives";
import { whenVisible } from "../../visiblePolling";
import { aiErrorMessage } from "../strategy-selection/aiSelectionModel";
import { useAgentConversation } from "./useAgentConversation";
import { AgentMarkdown } from "./AnswerMarkdown";
import { markdownToPlainText } from "./agentMarkdown";
import { QUICK_TASKS, focusFromSecurity, formatDuration, questionBefore, shortTime, stanceTone, stepsSummary, type QuickTask } from "./agentModel";

const errorText = (reason: unknown) => aiErrorMessage(reason).replace(/^\[[A-Z_]+\]\s*/, "").replace(/（可重试）$/, "");
const secidFor = (code: string) => `${code.startsWith("6") ? "1" : "0"}.${code}`;
const toSecurity = (focus: AgentFocus): Security => ({ code: focus.code, name: focus.name, secid: secidFor(focus.code), assetType: "stock" });

/**
 * AI 问股：像 OpenClaw 一样单独和 AI 对话分析个股。AI 自己决定查哪些数据（行情、日线体检、K线、分时、策略信号、
 * 框架打分、软件研判、涨停与龙虎榜、板块、公告、资讯、市场情绪），查完再写分析；可以连续追问。
 * 对话保存在本机；打开页面不会调用模型，发问题才调用。
 */
export default function AiAgentView({ onOpenStock, onOpenSettings, embeddedFocus }: {
  onOpenStock?: ((security: Security) => void) | undefined; onOpenSettings?: (() => void) | undefined; embeddedFocus?: AgentFocus;
}) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai?.agent;
  const { state, setState, loadError, refreshState, activeId, thread, focus, setFocus, draft, setDraft, hasDraft, run, error, setError, sending, saving,
    persistenceError, retryPersistence, confirmDelete, skillIds, setSkillIds, openConversation, send, stop, remove, running } = useAgentConversation(api, embeddedFocus);
  const streamRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // 分析进行中跟着进度滚到底部；新回答出来时滚到这次提问的位置，从回答开头读。
  const stepCount = run?.steps.reduce((sum, step) => sum + step.calls.length + 1, 0) || 0;
  const messageCount = thread?.messages.length || 0;
  const lastRole = thread?.messages[messageCount - 1]?.role;
  useEffect(() => {
    const node = streamRef.current;
    if (!node) return;
    if (lastRole === "assistant" && !running) {
      const questions = node.querySelectorAll<HTMLElement>(".ai-agent-msg.user");
      const question = questions[questions.length - 1];
      if (question) { node.scrollTop = Math.max(0, node.scrollTop + question.getBoundingClientRect().top - node.getBoundingClientRect().top - 12); return; }
    }
    node.scrollTop = node.scrollHeight;
  }, [messageCount, lastRole, stepCount, running]);

  const chooseSkills = (ids: string[]) => {
    setSkillIds(ids);
    if (api) void api.settings({ skillIds: ids }).then(value => setState(value)).catch(reason => setError(errorText(reason)));
  };
  const chooseProfile = async (profileId: string) => {
    if (!api) return;
    try { setState(await api.settings({ profileId })); } catch (reason) { setError(errorText(reason)); }
  };
  const useTask = (task: QuickTask) => {
    const text = task.prompt(focus);
    if (task.send) { void send(text, { title: task.label }); return; }
    setDraft(text);
    window.requestAnimationFrame(() => {
      const node = composerRef.current;
      if (!node) return;
      node.focus();
      const caret = text.indexOf(" 元");
      if (caret > 0) node.setSelectionRange(caret, caret);
    });
  };

  if (!api) return <div className="ai-agent-view"><PageHeading title="AI 问股" />
    <div className="panel strategy-stock-empty"><Bot size={28} /><b>浏览器预览不调用 AI</b><p>请在桌面版「数据源设置 → AI 助手」添加模型配置后使用。</p></div></div>;

  const messages = thread?.messages || [];
  const lastAnswer = [...messages].reverse().find(item => item.role === "assistant");

  return <div className={`ai-agent-view${embeddedFocus ? " ai-agent-embedded" : ""}`}>
    {embeddedFocus ? <div className="ai-agent-chat-head"><b>{embeddedFocus.name} · AI做T分析</b>{state && <ModelPicker state={state} onChoose={chooseProfile} />}</div> : <PageHeading title="AI 问股" description="单独和 AI 聊个股：它会先自己查数据（实时行情、日线体检、K线、分时、策略信号、框架打分、软件研判、涨停与龙虎榜、所属板块、公告、资讯、市场情绪），再给出结论、关键价位和操作思路，可以连续追问。发给模型的只有公开行情数据和你写的问题，不含持仓和密钥；对话只保存在本机。"
      actions={state && <ModelPicker state={state} onChoose={chooseProfile} onOpenSettings={onOpenSettings} />} />}
    {loadError && <div className="warning-banner" role="alert"><CircleAlert size={17} />{loadError}<button type="button" className="secondary-btn" onClick={() => void refreshState()}>重试</button></div>}
    {persistenceError && <div className="warning-banner" role="alert"><CircleAlert size={17} /><span>{persistenceError}。回答仍在本次运行中，关闭软件前请重试保存。</span>
      <button type="button" className="secondary-btn" disabled={saving} onClick={() => void retryPersistence()}>{saving ? "保存中…" : "重试保存"}</button></div>}
    {state && !state.configured && <div className="warning-banner" role="alert"><CircleAlert size={17} /><span>还没有可用的 AI 模型配置：请先在「数据源设置 → AI 助手」填写接口地址、模型名和 API Key。</span>
      {onOpenSettings && <button type="button" className="secondary-btn" onClick={onOpenSettings}><Settings size={15} />去设置</button>}</div>}

    <div className="ai-agent-layout">
      {!embeddedFocus && <aside className="panel ai-agent-sidebar" aria-label="对话列表">
        <button type="button" className="primary-btn ai-agent-new" onClick={() => void openConversation(null)}><Plus size={16} />新对话</button>
        <div className="ai-agent-threads" role="list">
          {!state?.conversations.length && <p className="ai-agent-muted">还没有对话。选一只股票，点下面的快捷问题或直接提问。</p>}
          {state?.conversations.map(item => <div role="listitem" key={item.id} className={`ai-agent-thread ${item.id === activeId ? "active" : ""}`}>
            <button type="button" className="ai-agent-thread-open" aria-current={item.id === activeId ? "true" : undefined} onClick={() => void openConversation(item.id)} title={item.title}>
              <span className="ai-agent-thread-title">{item.running && <LoaderCircle size={13} className="spin" aria-label="分析中" />}{item.title}</span>
              <small>{item.focus ? `${item.focus.code} · ` : ""}{item.turns} 问 · {shortTime(item.updatedAt)}{hasDraft(item.id) && " · 有草稿"}{item.stance && item.stance !== "不适用" && <em className={`agent-stance-dot ${stanceTone(item.stance)}`}>{item.stance}</em>}</small>
            </button>
            <button type="button" className={`ai-agent-thread-delete ${confirmDelete === item.id ? "confirm" : ""}`} aria-label={confirmDelete === item.id ? `确认删除「${item.title}」` : `删除「${item.title}」`}
              title={confirmDelete === item.id ? "再点一次确认删除" : "删除对话"} onClick={() => void remove(item.id)}>{confirmDelete === item.id ? "确认" : <Trash2 size={14} />}</button>
          </div>)}
        </div>
        {state && <MemoryEditor value={state.memory} onSave={async memory => { try { setState(await api.settings({ memory })); return true; } catch (reason) { setError(errorText(reason)); return false; } }} />}
      </aside>}

      <section className="panel ai-agent-chat" aria-label="AI 问股对话">
        {!embeddedFocus && <div className="ai-agent-chat-head">
          <StockPicker focus={focus} onChange={setFocus} disabled={running || sending} />
          {focus && onOpenStock && <button type="button" className="link-btn ai-agent-open-stock" onClick={() => onOpenStock(toSecurity(focus))}><ExternalLink size={14} />看个股详情</button>}
        </div>}

        {state?.skills && <SkillBar catalog={state.skills} tools={state.tools} selected={skillIds || []} disabled={running} onChange={chooseSkills}
          onSave={api.saveSkill ? async input => { const value = await api.saveSkill!(input); setState(value); return value.savedSkillId || ""; } : undefined}
          onRemove={api.removeSkill ? async id => { const value = await api.removeSkill!(id); setState(value); setSkillIds(current => (current || []).filter(item => item !== id)); } : undefined} />}

        <div className="ai-agent-stream" ref={streamRef} aria-live="polite">
          {!messages.length && !running && <Welcome focus={focus} tools={state?.tools || []} disabled={!state?.configured || sending} onTask={useTask}
            skills={(skillIds || []).map(id => state?.skills?.skills.find(skill => skill.id === id)?.name).filter((name): name is string => Boolean(name))} />}
          {messages.map(message => message.role === "user"
            ? <div className="ai-agent-msg user" key={message.id}><div className="ai-agent-bubble">{message.content}</div>
              <small>{[message.focus ? `${message.focus.name} ${message.focus.code}` : "", message.skills?.length ? `打法：${message.skills.map(skill => skill.name).join("、")}` : ""].filter(Boolean).join(" · ")}</small></div>
            : <AnswerCard key={message.id} message={message} latest={message.id === lastAnswer?.id && !running} disabled={running || sending || !state?.configured}
              onFollowUp={text => void send(text)} onRetry={() => { const question = questionBefore(messages, message.id); if (question) void send(question.content, { focus: question.focus || focus }); }} />)}
          {running && run && <RunCard run={run} onStop={() => void stop()} />}
        </div>

        {error && <div className="warning-banner ai-agent-error" role="alert"><CircleAlert size={16} />{error}<button type="button" className="link-btn" onClick={() => setError("")}>关闭</button></div>}
        {messages.length > 0 && !running && <div className="ai-agent-quick" aria-label="快捷问题">
          {QUICK_TASKS.filter(task => task.id !== "full" || !lastAnswer || lastAnswer.focus?.code !== focus?.code).slice(0, 6).map(task => <button type="button" key={task.id} className="ai-agent-chip"
            disabled={(task.needsStock && !focus) || !state?.configured || sending} title={task.hint} onClick={() => useTask(task)}>{task.label}</button>)}
        </div>}
        <Composer refEl={composerRef} value={draft} onChange={setDraft} focus={focus} running={running} sending={sending} disabled={!state?.configured}
          onSend={() => void send(draft, { fromDraft: true })} onStop={() => void stop()} />
      </section>
    </div>
  </div>;
}

function ModelPicker({ state, onChoose, onOpenSettings }: { state: AgentState; onChoose: (id: string) => void; onOpenSettings?: (() => void) | undefined }) {
  if (!state.profiles.length) return onOpenSettings ? <button type="button" className="secondary-btn" onClick={onOpenSettings}><Settings size={15} />配置模型</button> : null;
  const selected = state.profileId || state.activeProfileId;
  return <label className="ai-history-select ai-agent-model"><Bot size={15} /><span>模型</span>
    <select aria-label="AI 问股使用的模型" value={selected} onChange={event => onChoose(event.target.value === state.activeProfileId ? "" : event.target.value)}>
      {state.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.model && profile.model !== profile.name ? `（${profile.model}）` : ""}{profile.id === state.activeProfileId ? " · 默认" : ""}</option>)}
    </select></label>;
}

function Welcome({ focus, tools, disabled, onTask, skills }: { focus: AgentFocus | null; tools: { id: string; name: string }[]; disabled: boolean; onTask: (task: QuickTask) => void; skills: string[] }) {
  return <div className="ai-agent-welcome">
    <div className="ai-agent-welcome-head"><MessagesSquare size={26} /><div><h2>{focus ? `想了解 ${focus.name} 的什么？` : "先选一只股票，或直接问"}</h2>
      <p>{focus ? "点一个快捷问题，或在下面输入你自己的问题。" : "在上方输入代码、名称或拼音选股票；也可以直接问「今天市场怎么样」「宁德时代能不能买」。"}
        {skills.length ? ` 这次按${skills.map(name => `「${name}」`).join("")}的打法分析。` : " 想按某种打法分析，在上方「分析打法」里选。"}</p></div></div>
    <div className="ai-agent-tasks">
      {QUICK_TASKS.map(task => <button type="button" key={task.id} className="ai-agent-task" disabled={disabled || (task.needsStock && !focus)} onClick={() => onTask(task)}>
        <b>{task.label}{!task.send && <PenLine size={13} aria-label="填入输入框" />}</b><small>{task.hint}</small></button>)}
    </div>
    {tools.length > 0 && <p className="ai-agent-tools"><Wrench size={13} />AI 能查的数据：{tools.map(tool => tool.name).join("、")}</p>}
  </div>;
}

function StepList({ steps, live }: { steps: AgentStep[]; live: boolean }) {
  return <ol className="ai-agent-steps">{steps.map((step, index) => <li key={index}>
    {step.thought && <p className="ai-agent-thought">{step.kind === "prefetch" ? "软件先读：" : step.kind === "answer" ? "结论：" : "思路："}{step.thought}</p>}
    {step.calls.length > 0 && <ul>{step.calls.map((call, row) => <li key={row} className={`ai-agent-call ${call.status}`}>
      {call.status === "running" ? <LoaderCircle size={13} className={live ? "spin" : ""} aria-label="查询中" /> : call.status === "ok" ? <Check size={13} aria-label="已取到" /> : <X size={13} aria-label="没取到" />}
      <b>{call.name || call.tool}</b>{call.args && <code>{call.args}</code>}{call.summary && <span>{call.summary}</span>}
    </li>)}</ul>}
  </li>)}</ol>;
}

function RunCard({ run, onStop }: { run: AgentRun; onStop: () => void }) {
  const calls = run.steps.flatMap(step => step.calls);
  const phase = !run.steps.length ? "正在准备数据…" : calls.some(call => call.status === "running") ? "正在查数据…" : "AI 正在看数据，决定再查什么或直接写回答…";
  return <article className="ai-agent-msg assistant running" aria-busy="true">
    <header><span className="ai-agent-running"><LoaderCircle size={15} className="spin" />{phase}</span><small>{[run.model, formatDuration(run.elapsedMs)].filter(Boolean).join(" · ")}</small>
      <button type="button" className="secondary-btn" onClick={onStop}><CircleStop size={14} />停止</button></header>
    {run.steps.length > 0 && <StepList steps={run.steps} live />}
  </article>;
}

function AnswerCard({ message, latest, disabled, onFollowUp, onRetry }: { message: AgentMessage; latest: boolean; disabled: boolean; onFollowUp: (text: string) => void; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const steps = message.steps || [];
  const summary = stepsSummary(steps);
  const copy = async () => {
    try { await navigator.clipboard.writeText(markdownToPlainText(message.content)); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { /* 剪贴板不可用 */ }
  };
  if (message.error) return <article className="ai-agent-msg assistant failed">
    <header><span className="ai-agent-failed"><CircleAlert size={15} />{message.cancelled ? "已停止" : "这次没有完成"}</span><small>{message.model}</small></header>
    {!message.cancelled && <p>{message.content}</p>}
    {steps.length > 0 && <details className="ai-agent-steps-box"><summary>{summary}</summary><StepList steps={steps} live={false} /></details>}
    {latest && <button type="button" className="secondary-btn" disabled={disabled} onClick={onRetry}><RotateCcw size={14} />重试</button>}
  </article>;
  const tone = stanceTone(message.stance);
  return <article className="ai-agent-msg assistant">
    <header>
      {message.stance && message.stance !== "不适用" && <span className={`agent-stance ${tone}`}>{message.stance}</span>}
      {message.confidence && message.stance !== "不适用" && <span className="agent-confidence">把握{message.confidence}</span>}
      <small>{[message.focus ? `${message.focus.name} ${message.focus.code}` : "", message.model, formatDuration(message.durationMs) ? `用时 ${formatDuration(message.durationMs)}` : "", shortTime(message.at)].filter(Boolean).join(" · ")}</small>
      <button type="button" className="link-btn ai-agent-copy" onClick={() => void copy()} aria-label="复制回答">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制"}</button>
    </header>
    {summary && <details className="ai-agent-steps-box"><summary><Wrench size={13} />{summary}<ChevronDown size={13} /></summary><StepList steps={steps} live={false} /></details>}
    {message.skillVerdicts?.length ? <SkillVerdicts verdicts={message.skillVerdicts} /> : message.skills?.length ? <SkillTags skills={message.skills} /> : null}
    <AgentMarkdown text={message.content} />
    {message.fallback && <p className="ai-agent-muted">模型没有按约定格式回答，这段是用已查到的数据直接写的。</p>}
    {latest && (message.followUps?.length || 0) > 0 && <div className="ai-agent-followups" aria-label="接着问">
      {message.followUps!.map(text => <button type="button" key={text} className="ai-agent-chip" disabled={disabled} onClick={() => onFollowUp(text)}>{text}</button>)}
    </div>}
    <p className="ai-agent-disclaimer">AI 根据软件取到的数据生成，仅供研究参考，不构成投资建议。</p>
  </article>;
}

function Composer({ refEl, value, onChange, focus, running, sending, disabled, onSend, onStop }: {
  refEl: RefObject<HTMLTextAreaElement | null>; value: string; onChange: (text: string) => void; focus: AgentFocus | null;
  running: boolean; sending: boolean; disabled: boolean; onSend: () => void; onStop: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running) onSend(); }
  };
  const rows = Math.min(6, Math.max(2, value.split("\n").length));
  return <div className="ai-agent-composer">
    <textarea ref={refEl} rows={rows} value={value} maxLength={2000} disabled={disabled} aria-label="向 AI 提问"
      placeholder={disabled ? "先在设置里添加 AI 模型配置" : focus ? `问问 ${focus.name}…（Enter 发送，Shift+Enter 换行）` : "输入问题，例如：宁德时代现在能买吗？（Enter 发送，Shift+Enter 换行）"}
      onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} />
    {running
      ? <button type="button" className="secondary-btn ai-agent-send" onClick={onStop}><CircleStop size={16} />停止</button>
      : <button type="button" className="primary-btn ai-agent-send" disabled={disabled || sending || !value.trim()} onClick={onSend}>{sending ? <LoaderCircle size={16} className="spin" /> : <SendHorizontal size={16} />}发送</button>}
  </div>;
}

function MemoryEditor({ value, onSave }: { value: string; onSave: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setText(value); }, [value]);
  const dirty = text.trim() !== value.trim();
  return <details className="ai-agent-memory">
    <summary>我的分析偏好{value ? " · 已设置" : ""}</summary>
    <p className="ai-agent-muted">写下你的风格和习惯，AI 每次分析都会参考，例如：做短线打板、单笔止损 5%、只看主板。</p>
    <textarea rows={4} maxLength={800} value={text} aria-label="我的分析偏好" placeholder="例如：我做短线，偏好低吸，持股 1–5 天，单笔亏损 5% 止损。" onChange={event => { setText(event.target.value); setSaved(false); }} />
    <button type="button" className="secondary-btn" disabled={!dirty} onClick={() => void onSave(text).then(ok => setSaved(ok))}>{saved && !dirty ? <><Check size={14} />已保存</> : "保存偏好"}</button>
  </details>;
}

/** 选股票：输入代码、名称或拼音，从下拉里选；只列 A 股。 */
function StockPicker({ focus, onChange, disabled }: { focus: AgentFocus | null; onChange: (focus: AgentFocus | null) => void; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Security[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [quote, setQuote] = useState<{ latest: number | null; changePct: number | null } | null>(null);
  const search = typeof window === "undefined" ? undefined : window.stockApi?.search;
  const quoteApi = typeof window === "undefined" ? undefined : window.stockApi?.getQuoteSnapshot;

  useEffect(() => {
    const text = query.trim();
    if (!text || !search) { setOptions([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void search(text).then(rows => { if (!cancelled) { setOptions((rows || []).filter(row => !row.assetType || row.assetType === "stock").slice(0, 8)); setActive(0); } }).catch(() => { if (!cancelled) setOptions([]); });
    }, 220);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, search]);

  // 选中股票的现价：选中时读一次，之后每 30 秒（页面可见时）刷新。
  useEffect(() => {
    setQuote(null);
    if (!focus || !quoteApi) return;
    let cancelled = false;
    const load = whenVisible(() => quoteApi(toSecurity(focus)).then(value => {
      const latest = Number(value?.quote?.latest), changePct = Number(value?.quote?.changePct);
      if (!cancelled) setQuote({ latest: Number.isFinite(latest) && latest > 0 ? latest : null, changePct: Number.isFinite(changePct) ? changePct : null });
    }).catch(() => {}));
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [focus, quoteApi]);

  const choose = (security: Security | undefined) => {
    const next = focusFromSecurity(security);
    if (!next) return;
    onChange(next); setQuery(""); setOptions([]); setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(options[active] || options[0]); }
    else if (event.key === "Escape") { setOpen(false); }
  };
  const tone = quote?.changePct === null || quote?.changePct === undefined || quote.changePct === 0 ? "" : quote.changePct > 0 ? "up" : "down";
  return <div className="ai-agent-picker">
    {focus && <span className="ai-agent-focus" aria-label={`当前股票 ${focus.name} ${focus.code}`}>
      <b>{focus.name}</b><small>{focus.code}</small>
      {quote?.latest != null && <em className={tone}>{quote.latest.toFixed(2)}{quote.changePct != null ? ` ${quote.changePct > 0 ? "+" : ""}${quote.changePct.toFixed(2)}%` : ""}</em>}
      <button type="button" aria-label="不针对某只股票" disabled={disabled} onClick={() => onChange(null)}><X size={13} /></button>
    </span>}
    <div className="ai-agent-search" role="combobox" aria-expanded={open && options.length > 0} aria-haspopup="listbox">
      <Search size={15} />
      <input value={query} disabled={disabled} aria-label="选择要分析的股票" placeholder={focus ? "换一只：代码 / 名称 / 拼音" : "选择股票：代码 / 名称 / 拼音"}
        onChange={event => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} onKeyDown={onKeyDown} />
      {open && options.length > 0 && <ul role="listbox" className="ai-agent-options">{options.map((option, index) => <li key={option.code} role="option" aria-selected={index === active}>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}><b>{option.name}</b><small>{option.code}{option.marketName ? ` · ${option.marketName}` : ""}</small></button>
      </li>)}</ul>}
    </div>
  </div>;
}

