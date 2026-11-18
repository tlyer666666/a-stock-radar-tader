import type { ReactNode } from "react";

type AiComment = {
  fallback?: boolean | undefined;
  highlights?: string | undefined;
  risks?: string | undefined;
  nextDay?: string | undefined;
  reason?: string | undefined;
  disagreement?: boolean | undefined;
  disagreementDetail?: AiDisagreementDetail | undefined;
  outcome?: AiStockOutcome | undefined;
} | null | undefined;

const signedOutcome = (label: string, value: number | null) =>
  value === null ? "" : `${label} ${value > 0 ? "+" : ""}${value.toFixed(1)}%`;

/**
 * AI 点评整行展示（1.6.47）：看点 / 风险 / 次日关注 / 多空分歧 / 后验收益放在股票行下面、横跨整张表，
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
    if (ai.disagreement && ai.disagreementDetail?.summary) {
      const detail = ai.disagreementDetail;
      const hasSides = Boolean(detail.highest?.model && detail.lowest?.model);
      blocks.push({
        key: "disagreement",
        label: `多空分歧（差${detail.spread}分）`,
        tone: "risk",
        text: hasSides ? (
          <div className="ai-debate-panel">
            <div className="ai-debate-sides">
              <div className="ai-debate-side bull">
                <b>看多 · {detail.highest.model} ({detail.highest.score}分{detail.highest.rating ? `/${detail.highest.rating}` : ""})</b>
                <span>{detail.highest.thesis || detail.highest.highlights}</span>
              </div>
              <div className="ai-debate-side bear">
                <b>谨慎 · {detail.lowest.model} ({detail.lowest.score}分{detail.lowest.rating ? `/${detail.lowest.rating}` : ""})</b>
                <span>{detail.lowest.thesis || detail.lowest.risks}</span>
              </div>
            </div>
            {detail.verificationPoint && <div className="ai-debate-trigger">{detail.verificationPoint}</div>}
          </div>
        ) : detail.summary
      });
    }
    if (ai.outcome) {
      const parts = [
        signedOutcome("T+1", ai.outcome.t1),
        signedOutcome("T+3", ai.outcome.t3),
        signedOutcome("T+5", ai.outcome.t5),
        ai.outcome.maxDrawdownPct !== null && ai.outcome.maxDrawdownPct !== undefined
          ? `5日最大回撤 ${ai.outcome.maxDrawdownPct.toFixed(1)}%${ai.outcome.stopHit ? "(触-7%止损)" : ""}`
          : ""
      ].filter(Boolean);
      if (parts.length) {
        blocks.push({ key: "outcome", label: "后验走势", text: parts.join(" · "), ...(ai.outcome.latestDate ? { note: `截至 ${ai.outcome.latestDate}` } : {}) });
      }
    }
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
