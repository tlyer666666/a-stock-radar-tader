import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlarmClock, Crosshair, NotebookPen, X } from "lucide-react";
import { describeCondition, formatRemind, inspectReminder, mentionedStockCodes, parseConditions, REPEAT_LABELS, type NoteStock } from "./notesModel";
import type { NotesApi } from "./useNotes";

/**
 * 个股页的「记一笔」（1.6.66）：看盘时想到什么直接记进随心记，自动关联这只股票；
 * 文字里的时间和「跌破 / 涨到 / 涨幅超过」照样识别。
 */
export default function QuickNote({ api, stock }: { api: NotesApi; stock: NoteStock }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const [conditionChoice, setConditionChoice] = useState<number | null>(null);
  const interpreted = inspectReminder(text);
  const parsed = interpreted && "at" in interpreted ? interpreted : null;
  const conditions = useMemo(() => parseConditions(text), [text]);
  const otherStock = mentionedStockCodes(text, [stock]).some(code => code !== stock.code);
  const condition = conditions[conditionChoice ?? (conditions.length === 1 ? 0 : -1)] ?? null;
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  useEffect(() => { setOpen(false); setText(""); setConditionChoice(null); }, [stock.code]);
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(""), 4000); return () => window.clearTimeout(timer); }, [message]);
  const at = parsed?.at ?? null;
  const problem = otherStock ? "这条记录提到了其他股票，请在随心记里选择关联股票"
    : interpreted && "problem" in interpreted ? interpreted.problem
    : at !== null && at <= Date.now() ? "提醒时间已经过了，请改一个时间"
    : conditions.length > 1 && conditionChoice === null ? "请选择要盯的价格条件" : "";
  const save = () => {
    if (problem) return;
    const error = api.add({ text: text.includes(stock.code) ? text : `${stock.name} ${stock.code}：${text.trim()}`, remindAt: at, repeat: at ? parsed!.repeat : "none", stock, condition });
    if (error) { setMessage(error); return; }
    setText(""); setConditionChoice(null); setOpen(false); setMessage("已记到随心记");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (text.trim()) save(); }
    if (event.key === "Escape") setOpen(false);
  };
  return <span className="quick-note">
    <button type="button" className="secondary-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}><NotebookPen size={17} />{message || "记一笔"}</button>
    {open && <div className="quick-note-pop panel" role="dialog" aria-label={`记一笔：${stock.name}`}>
      <div className="quick-note-head"><b>记到随心记 · {stock.name}</b><button type="button" className="icon-btn" aria-label="关闭" onClick={() => setOpen(false)}><X size={14} /></button></div>
      <textarea ref={ref} rows={3} maxLength={2000} value={text} aria-label="记一笔内容" onChange={event => { setText(event.target.value); setConditionChoice(null); }} onKeyDown={onKeyDown}
        placeholder="想到什么就写，例如：明天开盘看是否高开；跌破 10.5 就减仓（回车保存）" />
      <div className="quick-note-foot">
        {at && !problem && <span className="notes-badge scheduled"><AlarmClock size={12} />{formatRemind(new Date(at).toISOString())}{parsed?.repeat && parsed.repeat !== "none" ? `（${REPEAT_LABELS[parsed.repeat]}）` : ""} 提醒</span>}
        {conditions.length > 1 && <label className="notes-repeat">盯盘条件
          <select aria-label="盯盘条件" value={conditionChoice ?? -1} onChange={event => setConditionChoice(Number(event.target.value) === -1 ? null : Number(event.target.value))}>
            <option value={-1}>请选择一项</option>
            {conditions.map((item, index) => <option key={describeCondition(item)} value={index}>{describeCondition(item)}</option>)}
            <option value={-2}>不盯盘</option>
          </select>
        </label>}
        {condition && <span className="notes-badge awaiting"><Crosshair size={12} />盘中{describeCondition(condition)}时提醒</span>}
        {problem && <span className="notes-warn" role="status">{problem}</span>}
        {!problem && !at && !condition && <small>没写时间和价格条件就只记录</small>}
        <button type="button" className="primary-btn" disabled={!text.trim() || Boolean(problem)} onClick={save}>记下来</button>
      </div>
    </div>}
  </span>;
}
