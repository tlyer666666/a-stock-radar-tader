import { useState } from "react";
import { ArrowDownUp, BellRing, Bot, Check, Crosshair, Loader2, MessageSquareText, Star, X } from "lucide-react";
import { formatRemind, mentionedStockCodes, type Note, type NoteCondition, type NoteStock } from "./notesModel";
import { AgentMarkdown } from "../ai-agent/AnswerMarkdown";
import { stanceTone } from "../ai-agent/agentModel";
import { openAgentConversation } from "../ai-agent/useAgentConversation";
import type { NotesApi } from "./useNotes";

export const securityOf = (stock: NoteStock): Security => ({ code: stock.code, name: stock.name, secid: stock.secid, assetType: "stock" });

export function AiButton({ note, api, primary = false }: { note: Note; api: NotesApi; primary?: boolean }) {
  if (!window.stockApi?.ai?.agent) return null;
  const running = note.ai?.status === "running";
  return <button type="button" className={primary ? "secondary-btn" : "link-btn"} disabled={running} title="让 AI 读取实时行情，判断这件事现在该怎么做"
    onClick={() => void api.askAi(note.id)}>{running ? <Loader2 size={13} className="spin" /> : <Bot size={13} />}{running ? "AI 在看…" : note.ai ? "再问一次 AI" : "让 AI 看看"}</button>;
}

const AI_SETTINGS_ERROR_RE = /Key|密钥|鉴权|401|402|403|404|余额|模型|配置/i;

/** AI 的判断：结论、时间，正文默认收起一部分；可以去 AI 问股接着追问或查看个股。 */
export function AiResult({ note, api, now, compact = false, onOpenStock }: { note: Note; api: NotesApi; now: number; compact?: boolean; onOpenStock?: ((security: Security) => void) | undefined }) {
  const ai = note.ai!;
  const [open, setOpen] = useState(!compact);
  const tone = stanceTone((ai.stance || undefined) as AgentStance | undefined);
  const canContinue = ai.status !== "running" && !["pending", "none"].includes(ai.conversationId);
  const canJumpAi = typeof window !== "undefined" && typeof window.__aStockOpenSettings === "function";
  return <div className={`notes-ai ${ai.status}`} aria-label="AI 的看法">
    <div className="notes-ai-head">
      <Bot size={14} /><b>{ai.status === "running" ? "AI 正在读行情、想办法…" : ai.status === "error" ? "AI 没看成" : "AI 的看法"}</b>
      {ai.status === "done" && ai.stance && ai.stance !== "不适用" && <span className={`agent-stance ${tone}`}>{ai.stance}</span>}
      {ai.status !== "running" && <small>{ai.trigger === "auto" ? "到点自动 · " : ""}{formatRemind(ai.at, now)}</small>}
      <span className="notes-card-actions">
        {ai.status === "done" && <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起" : "展开"}</button>}
        {note.stock && onOpenStock && <button type="button" className="link-btn" onClick={() => onOpenStock(securityOf(note.stock!))}>看个股</button>}
        {canContinue && <button type="button" className="link-btn" onClick={() => openAgentConversation(ai.conversationId)}><MessageSquareText size={13} />去 AI 问股追问</button>}
        {ai.status !== "running" && !compact && <button type="button" className="link-btn" aria-label="清除 AI 的看法" onClick={() => api.clearAi(note.id)}><X size={13} /></button>}
      </span>
    </div>
    {ai.status === "error" && (
      <p className="notes-ai-error">
        {ai.answer}
        {canJumpAi && AI_SETTINGS_ERROR_RE.test(ai.answer) && (
          <> <button type="button" className="link-btn" onClick={() => window.__aStockOpenSettings?.("ai")}>前往 AI 设置</button></>
        )}
      </p>
    )}
    {ai.status === "done" && <div className={open ? "notes-ai-body" : "notes-ai-body clipped"}><AgentMarkdown text={ai.answer} /></div>}
  </div>;
}

import { inferSecid } from "../../domain/securityIdentifiers";

const stockTargetOf = (note: Note): Security | null => {
  if (note.stock) return securityOf(note.stock);
  const code = mentionedStockCodes(note.text, [])[0];
  if (!code) return null;
  const secid = inferSecid(code);
  return { code, name: code, secid, assetType: "stock" };
};

/** 到点的提醒卡片：浮在右下角，在任何页面都会出现，处理完才消失。 */
export function NoteReminderStack({
  api,
  onOpenNotes,
  onOpenStock,
  onAddMonitor,
  onAddToT,
  onAddFavorite,
  favoriteCodes
}: {
  api: NotesApi;
  onOpenNotes: () => void;
  onOpenStock: (security: Security) => void;
  onAddMonitor?: ((stock: Security, condition?: NoteCondition | null) => void) | undefined;
  onAddToT?: ((stock: Security) => void) | undefined;
  onAddFavorite?: ((stock: Security) => void) | undefined;
  favoriteCodes?: ReadonlySet<string> | undefined;
}) {
  const notes = api.popupNotes;
  if (!notes.length) return null;
  return <aside className="notes-popup-stack" aria-label="随心记提醒" role="alert">
    {notes.length > 1 && <div className="notes-popup-head"><BellRing size={14} />{notes.length} 条提醒<button type="button" className="link-btn" onClick={() => api.dismiss()}>全部收起</button></div>}
    {notes.map(({ note, kind }) => {
      const byCondition = kind === "condition" && Boolean(note.conditionHit);
      const displayRemindAt = note.lastFiredAt || note.firedFor || note.remindAt;
      const targetStock = stockTargetOf(note);
      const isFav = targetStock ? Boolean(favoriteCodes?.has(targetStock.code)) : false;
      return <div key={note.id} className="notes-popup">
        <div className="notes-popup-top">{byCondition ? <Crosshair size={15} /> : <BellRing size={15} />}<b>{byCondition ? "价格条件到了" : "随心记提醒"}</b>
          <small>{byCondition ? formatRemind(note.conditionHit!.at) : displayRemindAt ? formatRemind(displayRemindAt) : ""}</small>
          <button type="button" className="icon-btn" aria-label="收起这条提醒" onClick={() => api.dismiss(note.id)}><X size={14} /></button></div>
        {byCondition && <p className="notes-popup-detail">{note.conditionHit!.detail}</p>}
        <p>{note.text}</p>
        {note.ai && <AiResult note={note} api={api} now={Date.now()} compact onOpenStock={onOpenStock} />}
        <div className="notes-popup-actions">
          {note.repeat === "none" || byCondition ? <>
            <button type="button" className="primary-btn" onClick={() => api.update(note.id, { done: true })}><Check size={14} />完成</button>
            <button type="button" className="secondary-btn" onClick={() => api.later(note.id, Date.now() + 600_000)}>10 分钟后</button>
            <button type="button" className="secondary-btn" onClick={() => api.later(note.id, Date.now() + 3600_000)}>1 小时后</button>
          </> : <button type="button" className="primary-btn" onClick={() => api.dismiss(note.id)}><Check size={14} />知道了（{note.remindAt ? `下次 ${formatRemind(note.remindAt)}` : "不再重复"}）</button>}
          {!note.ai && <AiButton note={note} api={api} primary />}
          {targetStock && (
            <>
              {onAddMonitor && note.condition && (
                <button type="button" className="link-btn" onClick={() => onAddMonitor(targetStock, note.condition)}>
                  <Crosshair size={13} />同步盯盘
                </button>
              )}
              {onAddToT && (
                <button type="button" className="link-btn" onClick={() => onAddToT(targetStock)}>
                  <ArrowDownUp size={13} />加入做T
                </button>
              )}
              {onAddFavorite && !isFav && (
                <button type="button" className="link-btn" onClick={() => onAddFavorite(targetStock)}>
                  <Star size={13} />加自选
                </button>
              )}
              <button type="button" className="link-btn" onClick={() => { onOpenStock(targetStock); api.dismiss(note.id); }}>看 {targetStock.name}</button>
            </>
          )}
          <button type="button" className="link-btn" onClick={() => { onOpenNotes(); api.dismiss(note.id); }}>打开随心记</button>
        </div>
      </div>;
    })}
  </aside>;
}
