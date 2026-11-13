import type { ReactNode } from "react";

type AiComment = { fallback?: boolean | undefined; highlights?: string | undefined; risks?: string | undefined; nextDay?: string | undefined; reason?: string | undefined } | null | undefined;

/**
 * AI 点评整行展示（1.6.47）：看点 / 风险 / 次日关注放在股票行下面、横跨整张表，
 * 不再挤成三列被横向滚动截掉。
 */
export function AiCommentRow({ ai, colSpan, extra, selected, onOpen }: { ai: AiComment; colSpan: number; extra?: { label: string; text: ReactNode } | undefined; selected?: boolean; onOpen?: (() => void) | undefined }) {
  const blocks: Array<{ key: string; label: string; text: ReactNode; note?: string | undefined; tone?: string | undefined }> = [];
  if (extra) blocks.push({ key: "extra", label: extra.label, text: extra.text, tone: "muted" });
  if (ai?.fallback) blocks.push({ key: "pending", label: "AI 待补", text: "模型尚未返回点评", tone: "muted" });
  else if (ai) {
    blocks.push({ key: "highlights", label: "看点", text: ai.highlights || "--", note: ai.reason ? `AI 调分：${ai.reason}` : undefined });
    blocks.push({ key: "risks", label: "风险", text: ai.risks || "--", tone: "risk" });
    blocks.push({ key: "nextDay", label: "次日关注", text: ai.nextDay || "--" });
  }
  if (!blocks.length) return null;
  return <tr className={`ai-comment-row${onOpen ? " clickable" : ""}${selected ? " selected" : ""}`} onClick={onOpen}>
    <td colSpan={colSpan}>
      <div className="ai-comment-grid">
        {blocks.map(block => <div key={block.key} className={`ai-comment-block${block.tone ? ` ${block.tone}` : ""}`}>
          <b>{block.label}</b>
          <p>{block.text}</p>
          {block.note && <small className="ai-reason">{block.note}</small>}
        </div>)}
      </div>
    </td>
  </tr>;
}
