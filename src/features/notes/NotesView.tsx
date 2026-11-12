import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlarmClock, BellRing, Check, CircleAlert, Clock3, NotebookPen, Pencil, Repeat2, RotateCcw, Search, Trash2, Volume2, VolumeX, X } from "lucide-react";
import {
  REPEAT_LABELS, cnParts, cnTime, detectStockCode, formatRemind, nextTradingDay, parseRemind, presetTimes, sortNotes,
  type Note, type NoteRepeat, type NoteStock
} from "./notesModel";
import type { NotesApi } from "./useNotes";
import { ConfirmDialog, type ConfirmDialogRequest } from "../../components/terminal/ConfirmDialog";

type Filter = "active" | "awaiting" | "scheduled" | "plain" | "done" | "all";
const FILTERS: Array<[Filter, string]> = [["active", "进行中"], ["awaiting", "到点待处理"], ["scheduled", "待提醒"], ["plain", "随手记"], ["done", "已完成"], ["all", "全部"]];
const toLocalInput = (ms: number) => { const { date, minutes } = cnParts(ms); return `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; };
const fromLocalInput = (value: string) => { const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/); return m ? cnTime(m[1]!, Number(m[2]) * 60 + Number(m[3])) : null; };
const stateOf = (note: Note) => note.done ? "done" : note.remindAt && note.firedFor === note.remindAt ? "awaiting" : note.remindAt ? "scheduled" : "plain";
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

export default function NotesView({ api, onOpenStock }: { api: NotesApi; onOpenStock: (security: Security) => void }) {
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
        <p>想到什么就记下来；写上「明天开盘前」「周五尾盘」「下个交易日竞价」「30分钟后」「每个交易日 14:45」这类时间，到点会提醒你。只保存在本机。</p>
      </div>
      <div className="notes-actions">
        <button type="button" className="secondary-btn" aria-pressed={store.voice} onClick={() => api.setVoice(!store.voice)}>{store.voice ? <Volume2 size={15} /> : <VolumeX size={15} />}{store.voice ? "语音播报开" : "语音播报关"}</button>
        <button type="button" className="secondary-btn" aria-pressed={store.systemNotify} onClick={() => api.setSystemNotify(!store.systemNotify)}><BellRing size={15} />{store.systemNotify ? "系统通知开" : "系统通知关"}</button>
      </div>
      {api.saveError && <p className="notes-warn" role="alert"><CircleAlert size={14} />本地保存失败，刚才的修改可能没存上</p>}
    </header>

    <Composer api={api} now={tick} />

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
  return stock;
}

/** 输入框 + 提醒时间：自动识别文字里的时间，也可以点快捷时间或自己选。 */
function Composer({ api, now }: { api: NotesApi; now: number }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"auto" | "none" | "custom" | string>("auto");
  const [custom, setCustom] = useState("");
  const [repeat, setRepeat] = useState<NoteRepeat>("none");
  const [stockOff, setStockOff] = useState(false);
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const parsed = useMemo(() => parseRemind(text, now), [text, now]);
  const presets = useMemo(() => presetTimes(now), [now]);
  const code = stockOff ? null : detectStockCode(text);
  const stock = useStockLookup(code);
  useEffect(() => { if (parsed?.repeat && parsed.repeat !== "none" && mode === "auto") setRepeat(parsed.repeat); }, [parsed?.repeat, mode]);

  const remindAt = mode === "none" ? null : mode === "auto" ? parsed?.at ?? null : mode === "custom" ? fromLocalInput(custom) : presets.find(item => item.id === mode)?.at ?? null;
  const past = remindAt !== null && remindAt <= Date.now();
  const save = () => {
    if (past) { setMessage("提醒时间已经过了，换一个时间"); return; }
    const error = api.add({ text, remindAt, repeat: remindAt ? repeat : "none", stock });
    if (error) { setMessage(error); return; }
    setText(""); setMode("auto"); setCustom(""); setRepeat("none"); setStockOff(false);
    setMessage(remindAt ? `已记下，${formatRemind(new Date(remindAt).toISOString())} 提醒你` : "已记下");
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); save(); }
  };
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(""), 4000); return () => window.clearTimeout(timer); }, [message]);

  return <section className="panel notes-composer" aria-label="记一条">
    <textarea ref={inputRef} value={text} rows={3} maxLength={2000} aria-label="随心记内容"
      placeholder="例如：明天开盘前看 600519 是否高开，高开 3% 以上先卖一半（回车保存，Shift+回车换行）"
      onChange={event => { setText(event.target.value); setMessage(""); }} onKeyDown={onKeyDown} />
    <div className="notes-remind-row">
      <span className="notes-remind-label"><AlarmClock size={14} />提醒</span>
      <div className="notes-chips" role="radiogroup" aria-label="提醒时间">
        <button type="button" role="radio" aria-checked={mode === "auto"} className={mode === "auto" ? "active" : ""} onClick={() => setMode("auto")}>
          {parsed ? `识别到：${formatRemind(new Date(parsed.at).toISOString(), now)}` : "自动识别（没写时间就不提醒）"}
        </button>
        <button type="button" role="radio" aria-checked={mode === "none"} className={mode === "none" ? "active" : ""} onClick={() => setMode("none")}>不提醒</button>
        {presets.map(item => <button key={item.id} type="button" role="radio" aria-checked={mode === item.id} className={mode === item.id ? "active" : ""} onClick={() => setMode(item.id)}>{item.label}</button>)}
        <button type="button" role="radio" aria-checked={mode === "custom"} className={mode === "custom" ? "active" : ""} onClick={() => { setMode("custom"); if (!custom) setCustom(toLocalInput(Date.now() + 3600_000)); }}>自选时间</button>
        {mode === "custom" && <input type="datetime-local" value={custom} aria-label="自选提醒时间（北京时间）" onChange={event => setCustom(event.target.value)} />}
      </div>
    </div>
    <div className="notes-composer-foot">
      {remindAt !== null && <label className="notes-repeat"><Repeat2 size={14} />
        <select value={repeat} aria-label="重复" onChange={event => setRepeat(event.target.value as NoteRepeat)}>
          {(Object.keys(REPEAT_LABELS) as NoteRepeat[]).map(key => <option key={key} value={key}>{REPEAT_LABELS[key]}</option>)}
        </select>
      </label>}
      {stock && <span className="notes-stock-chip">关联 {stock.name}{stock.name !== stock.code ? ` ${stock.code}` : ""}<button type="button" aria-label="不关联这只股票" onClick={() => setStockOff(true)}><X size={12} /></button></span>}
      {past && <span className="notes-warn"><CircleAlert size={13} />这个时间已经过了</span>}
      <span className="notes-hint" role="status">{message || (remindAt ? `将在 ${formatRemind(new Date(remindAt).toISOString(), now)}${repeat !== "none" ? `（${REPEAT_LABELS[repeat]}）` : ""} 提醒` : "只记录，不提醒")}</span>
      <button type="button" className="primary-btn" disabled={!text.trim()} onClick={save}>记下来</button>
    </div>
  </section>;
}

function NoteCard({ note, now, api, onEdit, onDelete, onOpenStock }: { note: Note; now: number; api: NotesApi; onEdit: () => void; onDelete: () => void; onOpenStock: (security: Security) => void }) {
  const state = stateOf(note);
  const [later, setLater] = useState(false);
  return <article className={`notes-card ${state}`}>
    <p className="notes-text">{note.text}</p>
    <div className="notes-meta">
      {note.remindAt && <span className={`notes-badge ${state}`}>{state === "awaiting" ? <BellRing size={12} /> : <Clock3 size={12} />}
        {state === "awaiting" ? `${formatRemind(note.remindAt, now)} 已提醒` : `${formatRemind(note.remindAt, now)} 提醒`}
        {note.repeat !== "none" && ` · ${REPEAT_LABELS[note.repeat]}`}</span>}
      {note.stock && <button type="button" className="notes-stock-link" onClick={() => onOpenStock({ code: note.stock!.code, name: note.stock!.name, secid: note.stock!.secid, assetType: "stock" })}>{note.stock.name} {note.stock.code}</button>}
      <small>记于 {formatRemind(note.createdAt, now)}</small>
      <span className="notes-card-actions">
        {!note.done && note.remindAt && note.repeat === "none" && <span className="notes-later">
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
  </article>;
}

function NoteEditor({ note, now, onSave, onCancel }: { note: Note; now: number; onSave: (patch: Partial<Note>) => void; onCancel: () => void }) {
  const [text, setText] = useState(note.text);
  const [time, setTime] = useState(note.remindAt ? toLocalInput(Date.parse(note.remindAt)) : "");
  const [repeat, setRepeat] = useState<NoteRepeat>(note.repeat);
  const at = time ? fromLocalInput(time) : null;
  const changedTime = (note.remindAt ? Date.parse(note.remindAt) : null) !== at;
  const past = at !== null && changedTime && at <= Date.now();
  return <form className="notes-card editing" onSubmit={event => {
    event.preventDefault();
    if (!text.trim() || past) return;
    onSave({ text: text.trim(), ...(changedTime ? { remindAt: at ? new Date(at).toISOString() : null } : {}), repeat: at ? repeat : "none" });
  }}>
    <textarea value={text} rows={3} maxLength={2000} aria-label="编辑内容" onChange={event => setText(event.target.value)} />
    <div className="notes-meta">
      <label className="notes-repeat"><AlarmClock size={14} /><input type="datetime-local" value={time} aria-label="提醒时间（北京时间）" onChange={event => setTime(event.target.value)} /></label>
      {time && <button type="button" className="link-btn" onClick={() => setTime("")}>不提醒</button>}
      {at !== null && <label className="notes-repeat"><Repeat2 size={14} /><select value={repeat} aria-label="重复" onChange={event => setRepeat(event.target.value as NoteRepeat)}>
        {(Object.keys(REPEAT_LABELS) as NoteRepeat[]).map(key => <option key={key} value={key}>{REPEAT_LABELS[key]}</option>)}
      </select></label>}
      {past && <span className="notes-warn"><CircleAlert size={13} />这个时间已经过了</span>}
      {at !== null && !past && <small>{formatRemind(new Date(at).toISOString(), now)} 提醒</small>}
      <span className="notes-card-actions">
        <button type="submit" className="primary-btn" disabled={!text.trim() || past}>保存</button>
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
    {notes.map(note => <div key={note.id} className="notes-popup">
      <div className="notes-popup-top"><BellRing size={15} /><b>随心记提醒</b><small>{note.remindAt ? formatRemind(note.firedFor || note.remindAt) : ""}</small>
        <button type="button" className="icon-btn" aria-label="收起这条提醒" onClick={() => api.dismiss(note.id)}><X size={14} /></button></div>
      <p>{note.text}</p>
      <div className="notes-popup-actions">
        {note.repeat === "none" ? <>
          <button type="button" className="primary-btn" onClick={() => api.update(note.id, { done: true })}><Check size={14} />完成</button>
          <button type="button" className="secondary-btn" onClick={() => api.later(note.id, Date.now() + 600_000)}>10 分钟后</button>
          <button type="button" className="secondary-btn" onClick={() => api.later(note.id, Date.now() + 3600_000)}>1 小时后</button>
        </> : <button type="button" className="primary-btn" onClick={() => api.dismiss(note.id)}><Check size={14} />知道了（{note.remindAt ? `下次 ${formatRemind(note.remindAt)}` : "不再重复"}）</button>}
        {note.stock && <button type="button" className="link-btn" onClick={() => { onOpenStock({ code: note.stock!.code, name: note.stock!.name, secid: note.stock!.secid, assetType: "stock" }); api.dismiss(note.id); }}>看 {note.stock.name}</button>}
        <button type="button" className="link-btn" onClick={() => { onOpenNotes(); api.dismiss(note.id); }}>打开随心记</button>
      </div>
    </div>)}
  </aside>;
}
