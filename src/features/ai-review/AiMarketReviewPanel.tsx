import { useEffect, useRef, useState } from "react";
import { Bot, History, LoaderCircle, RefreshCw, Sparkles, Wrench } from "lucide-react";
import { aiErrorMessage } from "../strategy-selection/aiSelectionModel";

const stamp = (value: AiStamp) => `${value.model} · ${new Date(value.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}${value.cached ? " · 本机已保存" : ""}`;
const VERDICT_TONE: Record<string, string> = { 兑现: "strong", 部分兑现: "good", 未兑现: "weak", 无法判断: "" };

/**
 * 专业复盘 → 市场复盘的「AI 复盘」：用复盘页同一份数据写盘后复盘，并能回看上一次 AI 复盘的判断是否兑现。
 * 打开时只读本机已保存的结果；点按钮才调用模型（用「总结用」的那套模型）。
 */
/** AI 复盘的分析过程：每一轮的思路和调用了哪些复盘技能（默认收起）。 */
function SkillSteps({ steps }: { steps: AiSkillStep[] }) {
  const calls = steps.flatMap(step => step.calls);
  return <details className="ai-skill-steps">
    <summary><Wrench size={14} />分析过程 · {steps.filter(step => step.calls.length).length} 轮，调用了 {calls.length} 次技能（{[...new Set(calls.map(call => call.name))].join("、") || "无"}）</summary>
    <ol>{steps.map((step, index) => <li key={index}>
      {step.thought && <p>{step.thought}</p>}
      {step.calls.map((call, callIndex) => <div key={callIndex} className={`ai-skill-call${call.ok ? "" : " failed"}`}>
        <b>{call.name}</b>{call.args && call.args !== "{}" && <code>{call.args}</code>}<small>{call.summary}</small></div>)}
      {!step.calls.length && <small>信息足够，写出复盘结论。</small>}
    </li>)}</ol>
  </details>;
}

export function AiMarketReviewPanel({ asOfDate, onReview }: { asOfDate: string; onReview?: ((review: AiMarketReview | null) => void) | undefined }) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai;
  const [review, setReview] = useState<AiMarketReview | null>(null);
  const [lookback, setLookback] = useState<AiLookback | null>(null);
  const [previousDate, setPreviousDate] = useState("");
  const [busy, setBusy] = useState<"" | "review" | "lookback">("");
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState(true);
  const generation = useRef(0);
  const cacheRevision = useRef({ review: 0, lookback: 0 });
  const report = useRef(onReview);
  report.current = onReview;

  useEffect(() => {
    const current = ++generation.current;
    const cachedAt = { ...cacheRevision.current };
    const stop = () => { generation.current += 1; };
    setReview(null); setLookback(null); setPreviousDate(""); setBusy(""); setError(""); report.current?.(null);
    if (!api?.cachedMarketReview) return stop;
    void api.status().then(value => { if (generation.current === current) setConfigured(value.configured); }).catch(() => {});
    void api.cachedMarketReview(asOfDate).then(value => {
      if (generation.current !== current) return;
      setPreviousDate(value.previousDate);
      if (cacheRevision.current.review === cachedAt.review) { setReview(value.review); report.current?.(value.review); }
      if (cacheRevision.current.lookback === cachedAt.lookback) setLookback(value.lookback);
    }).catch(() => {});
    return stop;
  }, [api, asOfDate]);

  if (!api?.marketReview || !api.lookback) return null;
  const run = async (kind: "review" | "lookback") => {
    if (busy) return;
    const current = generation.current;
    cacheRevision.current[kind] += 1; // A fresh review and a saved lookback have independent ownership.
    setBusy(kind); setError("");
    try {
      if (kind === "review") { const value = await api.marketReview!({ force: Boolean(review) }); if (generation.current === current) { setReview(value); report.current?.(value); } }
      else { const value = await api.lookback!({ force: Boolean(lookback) }); if (generation.current === current) setLookback(value); }
    } catch (reason) { if (generation.current === current) setError(aiErrorMessage(reason)); }
    finally { if (generation.current === current) setBusy(""); }
  };

  return <section className="panel ai-market-review" aria-label="AI 市场复盘">
    <header className="ai-stock-review-head">
      <div><Bot size={18} /><span><b>AI 复盘</b><small>{configured ? `AI 先看本页概况，再自主调用复盘技能（板块强度、涨停原因、连板梯队、炸板跌停、热股、龙虎榜、异动、板块成分、个股体检、历次复盘）补数据，最后写复盘${previousDate ? `；可回看 ${previousDate} 的判断` : "；次日可回看兑现情况"}` : "未配置模型：到「设置 → AI 助手」添加模型配置"}</small></span></div>
      <div className="ai-selection-actions">
        <button type="button" className="secondary-btn" onClick={() => void run("lookback")} disabled={!configured || Boolean(busy) || !previousDate} title={previousDate ? "" : "还没有更早的 AI 复盘"}>
          {busy === "lookback" ? <LoaderCircle size={15} className="spin" /> : <History size={15} />}{busy === "lookback" ? "回看中…" : lookback ? "重新回看" : "回看上次判断"}</button>
        <button type="button" className="primary-btn" onClick={() => void run("review")} disabled={!configured || Boolean(busy)}>
          {busy === "review" ? <LoaderCircle size={15} className="spin" /> : review ? <RefreshCw size={15} /> : <Sparkles size={15} />}{busy === "review" ? "AI 调用技能分析中…" : review ? "重新复盘" : "AI 复盘"}</button>
      </div>
    </header>
    {error && <div className="test-result fail" role="alert"><span />{error}</div>}
    {review && <article className="ai-summary ai-market-review-body">
      <h3>{review.headline || "盘后复盘"}<small>数据日 {review.asOfDate} · {stamp(review)} · 把握：{review.confidence}</small></h3>
      <div className="ai-cycle"><em>{review.cycle.phase}</em><span>{review.cycle.reason}{review.softwareRegime ? `（软件判断：${review.softwareRegime}）` : ""}</span></div>
      {review.market && <p>{review.market}</p>}
      {!!review.mainlines.length && <div className="ai-summary-row"><b>主线方向</b><ul>{review.mainlines.map(item => <li key={item.name}><em>{item.name}</em>：{item.comment}</li>)}</ul></div>}
      {review.ladder && <div className="ai-summary-row"><b>连板梯队</b><p>{review.ladder}</p></div>}
      {review.indices && <div className="ai-summary-row"><b>指数结构</b><p>{review.indices}</p></div>}
      <div className="ai-summary-row"><b>次日策略</b><ul>
        {review.nextDay.posture && <li><em>{review.nextDay.posture}</em></li>}
        {review.nextDay.focus.map((item, index) => <li key={`f${index}`}>关注：{item}</li>)}
        {review.nextDay.avoid.map((item, index) => <li key={`a${index}`}>回避：{item}</li>)}</ul></div>
      {!!review.risks.length && <div className="ai-summary-row"><b>风险提示</b><ul>{review.risks.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      {!!review.steps?.length && <SkillSteps steps={review.steps} />}
    </article>}
    {lookback && <article className="ai-lookback" aria-label="回看上次判断">
      <h3>回看 {lookback.previousDate} 的判断{lookback.hitRatePct !== null ? <span className="ai-hit-rate">兑现度 {lookback.hitRatePct}%（{lookback.judged} 条可验证）</span> : null}<small>{stamp(lookback)}</small></h3>
      {lookback.previousHeadline && <p className="ai-selection-note">当时结论：{lookback.previousHeadline}</p>}
      {lookback.summary && <p>{lookback.summary}</p>}
      <ul className="ai-verdicts">{lookback.verdicts.map((item, index) => <li key={index}><em className={VERDICT_TONE[item.result] || ""}>{item.result}</em><span><b>{item.claim}</b><small>{item.evidence}</small></span></li>)}</ul>
      {!!lookback.lessons.length && <div className="ai-summary-row"><b>下次注意</b><ul>{lookback.lessons.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    </article>}
    {(review || lookback) && <p className="ai-selection-note">AI 只依据本页的公开行情统计判断，可能出错，仅供参考，不构成投资建议；保存复盘档案时会一并记下 AI 结论。</p>}
  </section>;
}
