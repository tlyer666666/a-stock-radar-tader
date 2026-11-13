import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlarmClock, BellRing, Bot, Check, CircleAlert, Clock3, Crosshair, Loader2, MessageSquareText, NotebookPen, Pencil, Repeat2, RotateCcw, Search, Sparkles, Trash2, Volume2, VolumeX, X } from "lucide-react";
import {
  REPEAT_LABELS, cnParts, cnTime, describeCondition, formatRemind, inspectReminder, isAwaiting, mentionedStockCodes, nextTradingDay, normalizeCondition, parseConditions, parseNoteClock, presetTimes, sortNotes,
  tradingDayOnOrAfter, type Note, type NoteCondition, type NoteRepeat, type NoteStock
} from "./notesModel";
import { AgentMarkdown } from "../ai-agent/AnswerMarkdown";
import { stanceTone } from "../ai-agent/agentModel";
import { openAgentConversation } from "../ai-agent/useAgentConversation";
import { aiErrorMessage } from "../strategy-selection/aiSelectionModel";
import type { NotesApi } from "./useNotes";
import { ConfirmDialog, type ConfirmDialogRequest } from "../../components/terminal/ConfirmDialog";

type Filter = "active" | "awaiting" | "scheduled" | "plain" | "done" | "all";
const FILTERS: Array<[Filter, string]> = [["active", "进行中"], ["awaiting", "到点待处理"], ["scheduled", "待提醒"], ["plain", "随手记"], ["done", "已完成"], ["all", "全部"]];
const toLocalInput = (ms: number) => { const { date, minutes } = cnParts(ms); return `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; };
const fromLocalInput = parseNoteClock;
const stateOf = (note: Note) => note.done ? "done" : isAwaiting(note) ? "awaiting" : note.remindAt || (note.condition && note.stock) ? "scheduled" : "plain";
const secidOf = (code: string) => `${code.startsWith("6") || code.startsWith("9") ? "1" : "0"}.${code}`;

/** 稍后提醒的几个常用选项。 */
function laterOptions(now = Date.now()) {
  const next = nextTradingDay(cnParts(now).date);
  return [
    { label: "10 分钟后", at: now + 600_000 },
    { label: "1 小时后", at: now + 3600_000 },
    { label: "下个交易日开盘前", at: cnTime(next, 9 * 60 + 15) },
    { label: "下个交易日尾盘", at: cnTime(next, 14 * 60 + 45) }
  ];
}

export default function NotesView({ api, onOpenStock, holdings = [], watchlist = [] }: {
  api: NotesApi;
  onOpenStock: (security: Security) => void;
  holdings?: readonly Pick<NoteStock, "code" | "name">[];
  watchlist?: readonly Pick<NoteStock, "code" | "name">[];
}) {
  const { store } = api;
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());
  const [confirm, setConfirm] = useState<{ request: ConfirmDialogRequest; run: () => void } | null>(null);
  const ask = (request: ConfirmDialogRequest, run: () => void) => setConfirm({ request, run });
  useEffect(() => { const timer = window.setInterval(() => setTick(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);

  const counts = useMemo(() => {
    const result: Record<Filter, number> = { active: 0, awaiting: 0, scheduled: 0, plain: 0, done: 0, all: store.notes.length };
    for (const note of store.notes) { const state = stateOf(note); result[state] += 1; if (state !== "done") result.active += 1; }
    return result;
  }, [store.notes]);
  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return sortNotes(store.notes).filter(note => {
      const state = stateOf(note);
      if (filter === "active" ? state === "done" : filter !== "all" && state !== filter) return false;
      return !text || note.text.toLowerCase().includes(text) || Boolean(note.stock && (note.stock.code.includes(text) || note.stock.name.toLowerCase().includes(text)));
    });
  }, [store.notes, filter, query]);

  return <div className="notes-view">
    <header className="panel notes-head">
      <div className="notes-title">
        <h2><NotebookPen size={18} />随心记</h2>
        <p>写一句话，自动识别提醒时间、重复和价格条件。保存前可核对，复杂内容可用 AI 整理。笔记保存在本机。</p>
        <WatchStatus api={api} />
      </div>
      <div className="notes-actions">
        <button type="button" className="secondary-btn" aria-pressed={store.voice} onClick={() => api.setVoice(!store.voice)}>{store.voice ? <Volume2 size={15} /> : <VolumeX size={15} />}{store.voice ? "语音播报开" : "语音播报关"}</button>
        <button type="button" className="secondary-btn" aria-pressed={store.systemNotify} onClick={() => api.setSystemNotify(!store.systemNotify)}><BellRing size={15} />{store.systemNotify ? "系统通知开" : "系统通知关"}</button>
        <button type="button" className="secondary-btn" aria-pressed={store.aiAuto} title="关联了股票的提醒到点（或价格条件触发）时，自动让 AI 结合实时行情先看一遍；会消耗 AI 额度"
          onClick={() => api.setAiAuto(!store.aiAuto)}><Bot size={15} />{store.aiAuto ? "到点自动让 AI 先看：开" : "到点自动让 AI 先看：关"}</button>
      </div>
      {api.saveError && <p className="notes-warn" role="alert"><CircleAlert size={14} />本地保存失败，刚才的修改可能没存上</p>}
    </header>

    <Composer api={api} now={tick} knownStocks={[...holdings, ...watchlist, ...store.notes.flatMap(note => note.stock ? [note.stock] : [])]} />

    <section className="panel notes-list-panel" aria-label="随心记列表">
      <div className="notes-toolbar">
        <div className="notes-filters" role="tablist" aria-label="筛选">
          {FILTERS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
            {label}<em>{counts[id]}</em>
          </button>)}
        </div>
        <label className="notes-search"><Search size={14} /><input value={query} placeholder="搜索内容或股票" aria-label="搜索随心记" onChange={event => setQuery(event.target.value)} /></label>
        {counts.done > 0 && filter === "done" && <button type="button" className="link-btn danger" onClick={() => ask({ title: `删除全部 ${counts.done} 条已完成的记录？`, message: "删除后不能恢复。", confirmLabel: "删除", tone: "danger" }, api.clearDone)}>清空已完成</button>}
      </div>
      {!visible.length ? <div className="notes-empty">
        <NotebookPen size={26} />
        <b>{store.notes.length ? "这里没有记录" : "还没有记录"}</b>
        <p>{store.notes.length ? "换个筛选看看。" : "在上面输入框写下你的想法，回车或点「记下来」。"}</p>
      </div> : <ul className="notes-list">
        {visible.map(note => editing === note.id
          ? <li key={note.id}><NoteEditor note={note} now={tick} onCancel={() => setEditing(null)} onSave={patch => { api.update(note.id, patch); setEditing(null); }} /></li>
          : <li key={note.id}><NoteCard note={note} now={tick} api={api} onEdit={() => setEditing(note.id)} onOpenStock={onOpenStock}
            onDelete={() => ask({ title: "删除这条记录？", message: note.text.slice(0, 80), confirmLabel: "删除", tone: "danger" }, () => api.remove(note.id))} /></li>)}
      </ul>}
    </section>
    <ConfirmDialog request={confirm?.request || null} onResolve={confirmed => { const run = confirm?.run; setConfirm(null); if (confirmed) run?.(); }} />
  </div>;
}

function useStockLookup(code: string | null) {
  const [stock, setStock] = useState<NoteStock | null>(null);
  useEffect(() => {
    if (!code) { setStock(null); return; }
    let cancelled = false;
    setStock({ code, name: code, secid: secidOf(code) });
    void window.stockApi?.search?.(code).then(rows => {
      const hit = (rows || []).find(row => row.code === code);
      if (!cancelled && hit) setStock({ code, name: hit.name || code, secid: hit.secid || secidOf(code) });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [code]);
  return code ? stock?.code === code ? stock : { code, name: code, secid: secidOf(code) } : null;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** 发给「AI 整理」的当前时间和接下来的交易日。 */
function aiClock(now: number) {
  const { date, minutes, weekday } = cnParts(now);
  const days: string[] = [];
  let day = tradingDayOnOrAfter(date);
  for (let i = 0; i < 10; i += 1) { days.push(day); day = nextTradingDay(day); }
  return { now: `${date} ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} ${WEEKDAYS[weekday]}`, tradingDays: days };
}
const errorText = (reason: unknown) => aiErrorMessage(reason).replace(/^\[[A-Z_]+\]\s*/, "").replace(/（可重试）$/, "");

/** 确认当前草稿推导出的提醒，手选时间和重复规则优先。 */
function Composer({ api, now, knownStocks }: {
  api: NotesApi;
  now: number;
  knownStocks: readonly Pick<NoteStock, "code" | "name">[];
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("auto");
  const [custom, setCustom] = useState("");
  const [preset, setPreset] = useState<ReturnType<typeof presetTimes>[number] | null>(null);
  const [repeatOverride, setRepeatOverride] = useState<NoteRepeat | null>(null);
  const [stockChoice, setStockChoice] = useState<string | null>(null);
  const [conditionChoice, setConditionChoice] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [ai, setAi] = useState<{ code: string | null; condition: NoteCondition | null; note: string; undo: () => void } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const draftRevision = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const interpreted = useMemo(() => inspectReminder(text, now), [text, now]);
  const parsed = interpreted && "at" in interpreted ? interpreted : null;
  const timeProblem = mode === "auto" && interpreted && "problem" in interpreted ? interpreted.problem : "";
  const presets = useMemo(() => presetTimes(now), [now]);
  const codes = ai ? ai.code ? [ai.code] : [] : mentionedStockCodes(text, knownStocks);
  const code = stockChoice ?? (codes.length === 1 ? codes[0]! : "");
  const stock = useStockLookup(code || null);
  const knownName = knownStocks.find(item => item.code === code && item.name !== code)?.name;
  const linkedStock = stock && knownName && stock.name === stock.code ? { ...stock, name: knownName } : stock;
  const localConditions = useMemo(() => parseConditions(text), [text]);
  const conditions = ai ? ai.condition ? [ai.condition] : [] : localConditions;
  const condition = linkedStock ? conditions[conditionChoice ?? (conditions.length === 1 ? 0 : -1)] ?? null : null;
  const stockUnclear = codes.length > 1 && stockChoice === null;
  const conditionUnclear = Boolean(linkedStock && conditions.length > 1 && conditionChoice === null);
  const canAi = Boolean(window.stockApi?.ai?.parseNote);

  const repeat = repeatOverride ?? (mode === "auto" ? parsed?.repeat : null) ?? "none";
  const remindAt = mode === "auto" ? parsed?.at ?? null : mode === "custom" ? fromLocalInput(custom) : preset?.at ?? null;
  const past = remindAt !== null && remindAt <= Date.now();
  const plan = [
    remindAt === null ? "" : `${formatRemind(new Date(remindAt).toISOString(), now)}${repeat !== "none" ? `（${REPEAT_LABELS[repeat]}）` : ""} 提醒`,
    condition ? `盘中${describeCondition(condition)}时提醒` : ""
  ].filter(Boolean);
  const changeDraft = () => { draftRevision.current += 1; setMessage(""); };
  const save = () => {
    if (!text.trim()) return;
    if (timeProblem || past || (mode === "custom" && remindAt === null)) {
      setMessage(timeProblem || (past ? "提醒时间已经过了，换一个时间" : "请填写有效的自选提醒时间"));
      return;
    }
    if (stockUnclear || conditionUnclear) {
      setMessage(stockUnclear ? "请先选这条记录关联的股票" : "请先选这条记录要盯的价格条件");
      return;
    }
    const error = api.add({ text, remindAt, repeat: remindAt ? repeat : "none", stock: linkedStock, condition });
    if (error) { setMessage(error); return; }
    changeDraft();
    setText(""); setMode("auto"); setCustom(""); setPreset(null); setRepeatOverride(null);
    setStockChoice(null); setConditionChoice(null); setAi(null);
    setMessage(plan.length ? `已记下，将${plan.join("；")}` : "已记下");
    inputRef.current?.focus();
  };
  const tidy = async () => {
    const parse = window.stockApi?.ai?.parseNote;
    if (!parse || !text.trim() || aiBusy) return;
    if (codes.length > 1 || localConditions.length > 1) {
      setMessage("这段话含多个股票或条件，建议拆成多条记录，或直接选择本条要盯的对象");
      return;
    }
    const revision = draftRevision.current;
    const undo = ai?.undo ?? (() => {
      setText(text); setMode(mode); setCustom(custom); setPreset(preset); setRepeatOverride(repeatOverride);
      setStockChoice(stockChoice); setConditionChoice(conditionChoice);
    });
    setAiBusy(true); setMessage("");
    try {
      const result = await parse({ text, ...aiClock(Date.now()) });
      if (draftRevision.current !== revision) return;
      if (result.text) setText(result.text);
      const at = result.when ? parseNoteClock(result.when) : null;
      if (result.when) {
        setMode("custom");
        setCustom(at === null ? "" : toLocalInput(at));
        setRepeatOverride(result.repeat);
      }
      setStockChoice(null); setConditionChoice(null);
      setAi({ code: result.code, condition: normalizeCondition(result.condition), note: result.note, undo });
      setMessage(result.when && (at === null || at <= Date.now())
        ? "AI 建议的时间无效或已过，请核对提醒时间"
        : "AI 整理好了，确认没问题再点「记下来」");
    } catch (reason) {
      if (draftRevision.current === revision) setMessage(`AI 整理失败：${errorText(reason)}`);
    } finally { setAiBusy(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save();
    }
  };
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(""), 6000); return () => window.clearTimeout(timer); }, [message]);

  return <section className="panel notes-composer" aria-label="记一条">
    <textarea ref={inputRef} value={text} rows={3} maxLength={2000} aria-label="随心记内容"
      placeholder="例如：每个交易日开盘前半小时看 600519，或 002594 跌破 280 时提醒我（回车保存，Shift+回车换行）"
      onChange={event => {
        changeDraft();
        if (ai) { ai.undo(); setAi(null); }
        setText(event.target.value); setStockChoice(null); setConditionChoice(null);
      }} onKeyDown={onKeyDown} />
    <div className="notes-remind-row">
      <span className="notes-remind-label"><AlarmClock size={14} />提醒</span>
      <div className="notes-chips" role="radiogroup" aria-label="提醒时间">
        <button type="button" role="radio" aria-checked={mode === "auto"} className={mode === "auto" ? "active" : ""} onClick={() => { changeDraft(); setMode("auto"); setPreset(null); setRepeatOverride(null); }}>
          {parsed ? `识别到：${formatRemind(new Date(parsed.at).toISOString(), now)}` : "自动识别"}
        </button>
        <button type="button" role="radio" aria-checked={mode === "none"} className={mode === "none" ? "active" : ""} onClick={() => { changeDraft(); setMode("none"); setPreset(null); }}>不按时间提醒</button>
        {(preset && !presets.some(item => item.id === preset.id) ? [...presets, preset] : presets).map(item => <button key={item.id} type="button" role="radio" aria-checked={mode === item.id} className={mode === item.id ? "active" : ""} onClick={() => { changeDraft(); setMode(item.id); setPreset(item); }}>{item.label}</button>)}
        <button type="button" role="radio" aria-checked={mode === "custom"} className={mode === "custom" ? "active" : ""} onClick={() => { changeDraft(); setPreset(null); setMode("custom"); if (!custom) setCustom(toLocalInput(Date.now() + 3600_000)); }}>自选时间</button>
        {mode === "custom" && <input type="datetime-local" value={custom} aria-label="自选提醒时间（北京时间）" onChange={event => { changeDraft(); setCustom(event.target.value); }} />}
      </div>
    </div>
    <div className="notes-composer-foot">
      {remindAt !== null && <label className="notes-repeat"><Repeat2 size={14} />
        <select value={repeat} aria-label="重复" onChange={event => { changeDraft(); setRepeatOverride(event.target.value as NoteRepeat); }}>
          {(Object.keys(REPEAT_LABELS) as NoteRepeat[]).map(key => <option key={key} value={key}>{REPEAT_LABELS[key]}</option>)}
        </select>
      </label>}
      {codes.length > 1 ? <label className="notes-repeat">关联股票
        <select aria-label="关联股票" value={stockChoice ?? "choose"} onChange={event => { changeDraft(); setStockChoice(event.target.value === "choose" ? null : event.target.value); setConditionChoice(null); }}>
          <option value="choose">请选择股票</option>
          {codes.map(item => <option key={item} value={item}>{knownStocks.find(stock => stock.code === item && stock.name !== item)?.name || ""} {item}</option>)}
          <option value="">不关联</option>
        </select>
      </label> : linkedStock && <span className="notes-stock-chip">关联 {linkedStock.name}{linkedStock.name !== linkedStock.code ? ` ${linkedStock.code}` : ""}
        <button type="button" aria-label="不关联这只股票" onClick={() => { changeDraft(); setStockChoice(""); }}><X size={12} /></button></span>}
      {linkedStock && conditions.length > 1 ? <label className="notes-repeat">盯盘条件
        <select aria-label="盯盘条件" value={conditionChoice ?? -1} onChange={event => { changeDraft(); setConditionChoice(Number(event.target.value) === -1 ? null : Number(event.target.value)); }}>
          <option value={-1}>请选择一项</option>
          {conditions.map((item, index) => <option key={describeCondition(item)} value={index}>{describeCondition(item)}</option>)}
          <option value={-2}>不盯盘</option>
        </select>
      </label> : condition && <span className="notes-stock-chip notes-condition-chip"><Crosshair size={12} />盯盘：{describeCondition(condition)}
        <button type="button" aria-label="不盯这个价格条件" onClick={() => { changeDraft(); setConditionChoice(-2); }}><X size={12} /></button></span>}
      {!linkedStock && conditions.length > 0 && stockChoice === null && !stockUnclear && <span className="notes-hint">关联股票后才能盯价格</span>}
      {Boolean(timeProblem || past || stockUnclear || conditionUnclear || (mode === "custom" && remindAt === null)) && <span className="notes-warn"><CircleAlert size={13} />
        {timeProblem || (past ? "这个时间已经过了" : stockUnclear ? "识别到多只股票，请选择一只" : conditionUnclear ? "识别到多个价格条件，请选择一项" : "请填写有效的自选提醒时间")}</span>}
      <span className="notes-hint" role="status">{message ? `${message}${ai && plan.length ? `｜将${plan.join("；")}` : ""}` : plan.length ? `将${plan.join("；")}` : timeProblem || stockUnclear || conditionUnclear ? "提醒设置待确认" : "只记录，不提醒"}{!message && ai?.note ? `｜AI：${ai.note}` : ""}</span>
      {ai && <button type="button" className="link-btn" onClick={() => { changeDraft(); ai.undo(); setAi(null); setMessage("已恢复原文和提醒设置"); }}>撤销 AI 整理</button>}
      {canAi && <button type="button" className="secondary-btn" disabled={!text.trim() || aiBusy} title="让 AI 识别时间、股票和价格条件，并整理成一句待办" onClick={() => void tidy()}>
        {aiBusy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}{aiBusy ? "AI 整理中…" : "AI 整理"}</button>}
      <button type="button" className="primary-btn" disabled={!text.trim() || Boolean(timeProblem || past || stockUnclear || conditionUnclear || (mode === "custom" && remindAt === null))} onClick={save}>记下来</button>
    </div>
  </section>;
}

/** 价格条件在主进程盯：显示在盯几个、现在是不是交易时段。 */
function WatchStatus({ api }: { api: NotesApi }) {
  const count = api.store.notes.filter(note => !note.done && note.condition && note.stock && !note.conditionHit).length;
  if (!count) return null;
  return <p className="notes-watch-status" role="status"><Crosshair size={13} />
    {api.watch.session ? `盘中盯着 ${count} 个价格条件，每 15 秒看一次报价` : `${count} 个价格条件：现在不是交易时段，开盘后（9:30–11:30、13:00–15:00）自动盯`}
    {api.watch.error && <span className="notes-warn">报价暂时取不到：{api.watch.error}</span>}</p>;
}

const securityOf = (stock: NoteStock): Security => ({ code: stock.code, name: stock.name, secid: stock.secid, assetType: "stock" });

function NoteCard({ note, now, api, onEdit, onDelete, onOpenStock }: { note: Note; now: number; api: NotesApi; onEdit: () => void; onDelete: () => void; onOpenStock: (security: Security) => void }) {
  const state = stateOf(note);
  const [later, setLater] = useState(false);
  const timeFired = Boolean(note.remindAt && note.firedFor === note.remindAt);
  return <article className={`notes-card ${state}`}>
    <p className="notes-text">{note.text}</p>
    <div className="notes-meta">
      {note.remindAt && <span className={`notes-badge ${timeFired ? "awaiting" : state === "done" ? "done" : "scheduled"}`}>{timeFired ? <BellRing size={12} /> : <Clock3 size={12} />}
        {timeFired ? `${formatRemind(note.remindAt, now)} 已提醒` : `${formatRemind(note.remindAt, now)} 提醒`}
        {note.repeat !== "none" && ` · ${REPEAT_LABELS[note.repeat]}`}</span>}
      {note.condition && note.stock && <span className={`notes-badge ${note.conditionHit ? "awaiting" : state === "done" ? "done" : "scheduled"}`}><Crosshair size={12} />
        {note.conditionHit ? `条件已触发：${note.conditionHit.detail}` : `盯盘：${describeCondition(note.condition)}`}</span>}
      {note.stock && <button type="button" className="notes-stock-link" onClick={() => onOpenStock(securityOf(note.stock!))}>{note.stock.name} {note.stock.code}</button>}
      <small>记于 {formatRemind(note.createdAt, now)}</small>
      <span className="notes-card-actions">
        {!note.done && <AiButton note={note} api={api} />}
        {!note.done && note.conditionHit && <button type="button" className="link-btn" title="价格条件重新开始盯" onClick={() => api.rearm(note.id)}><Crosshair size={13} />重新盯</button>}
        {!note.done && (note.remindAt || note.conditionHit) && note.repeat === "none" && <span className="notes-later">
          <button type="button" className="link-btn" aria-expanded={later} onClick={() => setLater(value => !value)}><AlarmClock size={13} />稍后提醒</button>
          {later && <span className="notes-later-menu">{laterOptions().map(option => <button key={option.label} type="button" onClick={() => { api.later(note.id, option.at); setLater(false); }}>{option.label}</button>)}</span>}
        </span>}
        {note.done
          ? <button type="button" className="link-btn" onClick={() => api.update(note.id, { done: false })}><RotateCcw size={13} />恢复</button>
          : <button type="button" className="link-btn" onClick={() => api.update(note.id, { done: true })}><Check size={13} />完成</button>}
        <button type="button" className="link-btn" onClick={onEdit}><Pencil size={13} />编辑</button>
        <button type="button" className="link-btn danger" aria-label="删除这条" onClick={onDelete}><Trash2 size={13} /></button>
      </span>
    </div>
    {note.ai && <AiResult note={note} api={api} now={now} />}
  </article>;
}

function AiButton({ note, api, primary = false }: { note: Note; api: NotesApi; primary?: boolean }) {
  if (!window.stockApi?.ai?.agent) return null;
  const running = note.ai?.status === "running";
  return <button type="button" className={primary ? "secondary-btn" : "link-btn"} disabled={running} title="让 AI 读取实时行情，判断这件事现在该怎么做"
    onClick={() => void api.askAi(note.id)}>{running ? <Loader2 size={13} className="spin" /> : <Bot size={13} />}{running ? "AI 在看…" : note.ai ? "再问一次 AI" : "让 AI 看看"}</button>;
}

/** AI 的判断：结论、时间，正文默认收起一部分；可以去 AI 问股接着追问。 */
function AiResult({ note, api, now, compact = false }: { note: Note; api: NotesApi; now: number; compact?: boolean }) {
  const ai = note.ai!;
  const [open, setOpen] = useState(!compact);
  const tone = stanceTone((ai.stance || undefined) as AgentStance | undefined);
  const canContinue = ai.status !== "running" && !["pending", "none"].includes(ai.conversationId);
  return <div className={`notes-ai ${ai.status}`} aria-label="AI 的看法">
    <div className="notes-ai-head">
      <Bot size={14} /><b>{ai.status === "running" ? "AI 正在读行情、想办法…" : ai.status === "error" ? "AI 没看成" : "AI 的看法"}</b>
      {ai.status === "done" && ai.stance && ai.stance !== "不适用" && <span className={`agent-stance ${tone}`}>{ai.stance}</span>}
      {ai.status !== "running" && <small>{ai.trigger === "auto" ? "到点自动 · " : ""}{formatRemind(ai.at, now)}</small>}
      <span className="notes-card-actions">
        {ai.status === "done" && <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起" : "展开"}</button>}
        {canContinue && <button type="button" className="link-btn" onClick={() => openAgentConversation(ai.conversationId)}><MessageSquareText size={13} />去 AI 问股追问</button>}
        {ai.status !== "running" && !compact && <button type="button" className="link-btn" aria-label="清除 AI 的看法" onClick={() => api.clearAi(note.id)}><X size={13} /></button>}
      </span>
    </div>
    {ai.status === "error" && <p className="notes-ai-error">{ai.answer}</p>}
    {ai.status === "done" && <div className={open ? "notes-ai-body" : "notes-ai-body clipped"}><AgentMarkdown text={ai.answer} /></div>}
  </div>;
}

function NoteEditor({ note, now, onSave, onCancel }: { note: Note; now: number; onSave: (patch: Partial<Note>) => void; onCancel: () => void }) {
  const [text, setText] = useState(note.text);
  const [time, setTime] = useState(note.remindAt ? toLocalInput(Date.parse(note.remindAt)) : "");
  const [repeat, setRepeat] = useState<NoteRepeat>(note.repeat);
  const [field, setField] = useState<NoteCondition["field"]>(note.condition?.field || "latest");
  const [op, setOp] = useState<NoteCondition["op"]>(note.condition?.op || "lte");
  const [value, setValue] = useState(note.condition ? String(note.condition.field === "changePct" ? Math.abs(note.condition.value) : note.condition.value) : "");
  const at = time ? fromLocalInput(time) : null;
  const changedTime = (note.remindAt ? Date.parse(note.remindAt) : null) !== at;
  const past = at !== null && changedTime && at <= Date.now();
  const number = Number(value);
  const condition = value.trim() && Number.isFinite(number) ? normalizeCondition({ field, op, value: field === "changePct" ? (op === "gte" ? Math.abs(number) : -Math.abs(number)) : number }) : null;
  const badCondition = Boolean(value.trim()) && !condition;
  const sameCondition = JSON.stringify(condition) === JSON.stringify(note.condition);
  return <form className="notes-card editing" onSubmit={event => {
    event.preventDefault();
    if (!text.trim() || past || badCondition) return;
    onSave({ text: text.trim(), ...(changedTime ? { remindAt: at ? new Date(at).toISOString() : null } : {}), repeat: at ? repeat : "none", ...(sameCondition ? {} : { condition }) });
  }}>
    <textarea value={text} rows={3} maxLength={2000} aria-label="编辑内容" onChange={event => setText(event.target.value)} />
    <div className="notes-meta">
      <label className="notes-repeat"><AlarmClock size={14} /><input type="datetime-local" value={time} aria-label="提醒时间（北京时间）" onChange={event => setTime(event.target.value)} /></label>
      {time && <button type="button" className="link-btn" onClick={() => setTime("")}>不按时间提醒</button>}
      {at !== null && <label className="notes-repeat"><Repeat2 size={14} /><select value={repeat} aria-label="重复" onChange={event => setRepeat(event.target.value as NoteRepeat)}>
        {(Object.keys(REPEAT_LABELS) as NoteRepeat[]).map(key => <option key={key} value={key}>{REPEAT_LABELS[key]}</option>)}
      </select></label>}
      {past && <span className="notes-warn"><CircleAlert size={13} />这个时间已经过了</span>}
      {at !== null && !past && <small>{formatRemind(new Date(at).toISOString(), now)} 提醒</small>}
    </div>
    {note.stock && <div className="notes-meta notes-condition-edit">
      <span className="notes-remind-label"><Crosshair size={14} />盯盘 {note.stock.name}</span>
      <select value={field} aria-label="条件类型" onChange={event => setField(event.target.value as NoteCondition["field"])}><option value="latest">价格</option><option value="changePct">涨跌幅</option></select>
      <select value={op} aria-label="条件方向" onChange={event => setOp(event.target.value as NoteCondition["op"])}>
        {field === "latest" ? <><option value="lte">跌到（≤）</option><option value="gte">涨到（≥）</option></> : <><option value="gte">涨超（%）</option><option value="lte">跌超（%）</option></>}
      </select>
      <input type="number" step="any" min="0" value={value} aria-label="条件数值" placeholder={field === "latest" ? "价格，留空不盯" : "百分比，留空不盯"} onChange={event => setValue(event.target.value)} />
      {badCondition && <span className="notes-warn"><CircleAlert size={13} />数值不对</span>}
      {condition && !sameCondition && <small>保存后重新开始盯：{describeCondition(condition)}</small>}
    </div>}
    <div className="notes-meta">
      <span className="notes-card-actions">
        <button type="submit" className="primary-btn" disabled={!text.trim() || past || badCondition}>保存</button>
        <button type="button" className="secondary-btn" onClick={onCancel}>取消</button>
      </span>
    </div>
  </form>;
}

/** 到点的提醒卡片：浮在右下角，在任何页面都会出现，处理完才消失。 */
export function NoteReminderStack({ api, onOpenNotes, onOpenStock }: { api: NotesApi; onOpenNotes: () => void; onOpenStock: (security: Security) => void }) {
  const notes = api.popupNotes;
  if (!notes.length) return null;
  return <aside className="notes-popup-stack" aria-label="随心记提醒" role="alert">
    {notes.length > 1 && <div className="notes-popup-head"><BellRing size={14} />{notes.length} 条提醒<button type="button" className="link-btn" onClick={() => api.dismiss()}>全部收起</button></div>}
    {notes.map(note => {
      const byCondition = Boolean(note.conditionHit) && !(note.remindAt && note.firedFor === note.remindAt);
      return <div key={note.id} className="notes-popup">
        <div className="notes-popup-top">{byCondition ? <Crosshair size={15} /> : <BellRing size={15} />}<b>{byCondition ? "价格条件到了" : "随心记提醒"}</b>
          <small>{byCondition ? formatRemind(note.conditionHit!.at) : note.remindAt ? formatRemind(note.firedFor || note.remindAt) : ""}</small>
          <button type="button" className="icon-btn" aria-label="收起这条提醒" onClick={() => api.dismiss(note.id)}><X size={14} /></button></div>
        {byCondition && <p className="notes-popup-detail">{note.conditionHit!.detail}</p>}
        <p>{note.text}</p>
        {note.ai && <AiResult note={note} api={api} now={Date.now()} compact />}
        <div className="notes-popup-actions">
          {note.repeat === "none" || byCondition ? <>
            <button type="button" className="primary-btn" onClick={() => api.update(note.id, { done: true })}><Check size={14} />完成</button>
            <button type="button" className="secondary-btn" onClick={() => api.later(note.id, Date.now() + 600_000)}>10 分钟后</button>
            <button type="button" className="secondary-btn" onClick={() => api.later(note.id, Date.now() + 3600_000)}>1 小时后</button>
          </> : <button type="button" className="primary-btn" onClick={() => api.dismiss(note.id)}><Check size={14} />知道了（{note.remindAt ? `下次 ${formatRemind(note.remindAt)}` : "不再重复"}）</button>}
          {!note.ai && <AiButton note={note} api={api} primary />}
          {note.stock && <button type="button" className="link-btn" onClick={() => { onOpenStock(securityOf(note.stock!)); api.dismiss(note.id); }}>看 {note.stock.name}</button>}
          <button type="button" className="link-btn" onClick={() => { onOpenNotes(); api.dismiss(note.id); }}>打开随心记</button>
        </div>
      </div>;
    })}
  </aside>;
}
