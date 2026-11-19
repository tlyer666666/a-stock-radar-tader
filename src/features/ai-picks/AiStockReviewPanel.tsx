import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ListPlus, LoaderCircle, MessagesSquare, RefreshCw, Sparkles } from "lucide-react";
import { canOpenAgent, openAgentFor } from "../ai-agent/agentModel";
import { aiErrorMessage, ratingTone } from "../strategy-selection/aiSelectionModel";
import { AI_CUSTOM_MAX, mergeCustomStocks, profileFacts } from "./aiCustomModel";
import { AiDimBreakdown, AiFrameworkPicker, useAiFrameworks } from "./AiFrameworkParts";

const stamp = (value: AiRanking) => `${value.model} · 数据日 ${value.asOfDate || "--"} · ${new Date(value.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}${value.cached ? " · 本机已保存" : ""}`;

/**
 * 个股页「AI 点评」：任意一只 A 股都能让 AI 打分点评（勾选的几个模型一起打分）。
 * 打开时只读本机已保存的点评，点按钮才调用模型。价位由软件按均线和区间高低点算出，AI 只引用。
 */
export function AiStockReviewPanel({ security, context, agentContext }: {
  security: { code: string; name: string };
  context?: string[] | undefined;
  agentContext?: Record<string, unknown> | undefined;
}) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai;
  const [review, setReview] = useState<AiRanking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState(true);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const cacheRevision = useRef(0);
  const adding = useRef(false);
  const [reload, setReload] = useState(0);
  const frameworks = useAiFrameworks(useCallback(() => setReload(value => value + 1), []));

  useEffect(() => {
    const current = ++generation.current;
    const cachedAt = cacheRevision.current;
    const stop = () => { generation.current += 1; };
    setReview(null); setBusy(false); setError(""); setNotice("");
    if (!api?.cachedReview) return stop;
    void api.status().then(value => { if (generation.current === current) setConfigured(value.configured); }).catch(() => undefined /* optional AI status */);
    void api.cachedReview(security.code).then(value => { if (generation.current === current && cacheRevision.current === cachedAt) setReview(value); }).catch(() => undefined /* optional AI cache */);
    return stop;
  }, [api, security.code, reload]);

  if (!api?.review) return null;
  const run = async () => {
    if (busy || !api.review) return;
    const current = generation.current;
    cacheRevision.current += 1; // An initial cache read must not overwrite this explicit request.
    setBusy(true); setError("");
    try {
      const value = await api.review({ security: { code: security.code, name: security.name }, force: Boolean(review), ...(context?.length ? { context } : {}) });
      if (generation.current === current) setReview(value);
    } catch (reason) {
      if (generation.current === current) setError(aiErrorMessage(reason));
    } finally { if (generation.current === current) setBusy(false); }
  };
  const addToList = async () => {
    if ((!api.mutateCustomList && !(api.customList && api.saveCustomList)) || adding.current) return;
    adding.current = true;
    const current = generation.current;
    const say = (text: string) => { if (generation.current === current) setNotice(text); };
    try {
      const items = [{ code: security.code, name: security.name }];
      const result = api.mutateCustomList
        ? await api.mutateCustomList({ kind: "add", items })
        : mergeCustomStocks(await api.customList!(), items);
      if (result.duplicate) say("已在「AI 选股 → 我的股票」清单里。");
      else if (result.overflow) say(`「我的股票」清单已满 ${AI_CUSTOM_MAX} 只，请先在 AI 选股页删掉一些。`);
      else if (result.added) {
        if (!api.mutateCustomList) await api.saveCustomList!(result.list);
        say("已加入「AI 选股 → 我的股票」清单，可在那里和其他股票一起打分排名。");
      } else say("请选择一只 A 股股票。");
    } catch (reason) { say(aiErrorMessage(reason)); }
    finally { adding.current = false; }
  };
  const item = review?.items[0];
  const profile = review?.profile;
  const multi = (review?.models?.length || 0) > 1;
  const failed = (review?.models || []).filter(model => !model.ok);

  const canJumpAi = typeof window !== "undefined" && typeof window.__aStockOpenSettings === "function";
  return <section className="panel ai-stock-review" aria-label="AI 点评">
    <header className="ai-stock-review-head">
      <div><Bot size={18} /><span><b>AI 点评</b><small>{!configured ? "未配置模型：到「设置 → AI 助手」添加模型配置" : item ? "按日线体检数据和分析框架打分" : "按日线体检数据和分析框架打分点评；点一次调用一次模型，同一数据日的结果保存在本机"}</small></span></div>
      <div className="ai-selection-actions">
        {!configured && canJumpAi && <button type="button" className="secondary-btn" onClick={() => window.__aStockOpenSettings?.("ai")}>去配置 AI</button>}
        {frameworks.available && <AiFrameworkPicker inline catalog={frameworks.catalog} onChoose={id => void frameworks.choose(id)} disabled={busy} />}
        {(api.mutateCustomList || (api.customList && api.saveCustomList)) && <button type="button" className="secondary-btn" onClick={() => void addToList()}><ListPlus size={15} />加入我的股票</button>}
        {api.agent && canOpenAgent() && <button type="button" className="secondary-btn" disabled={!configured} title="打开 AI 问股，让 AI 自己查数据做全面分析，可以继续追问"
          onClick={() => openAgentFor({ code: security.code, name: security.name }, "full", agentContext)}><MessagesSquare size={15} />AI 问股深入分析</button>}
        <button type="button" className="primary-btn" onClick={() => void run()} disabled={busy || !configured}>
          {busy ? <LoaderCircle size={15} className="spin" /> : review ? <RefreshCw size={15} /> : <Sparkles size={15} />}{busy ? "AI 点评中…" : review ? "重新点评" : "AI 点评"}</button>
      </div>
    </header>
    {notice && <p className="ai-selection-note" role="status">{notice}</p>}
    {error && <div className="test-result fail" role="alert"><span />{error}{canJumpAi && /Key|密钥|鉴权|401|402|403|404|余额|模型|配置/i.test(error) && <button type="button" className="link-btn" onClick={() => window.__aStockOpenSettings?.("ai")}>前往 AI 设置</button>}</div>}
    {failed.length > 0 && item && <div className="test-result fail" role="alert"><span />{failed.map(model => `${model.name} 点评失败：${model.error || "未知原因"}`).join("；")}</div>}
    {item && review && <div className="ai-stock-review-body">
      <div className="ai-stock-review-score">
        <span className={`ai-score-badge large ${item.fallback ? "" : ratingTone(item.rating)}`}>{item.score}</span>
        <b>{item.fallback ? "仅基础分 · AI 待补" : item.rating}</b>
        {multi && <span className="ai-model-scores">{(item.scores || []).map(score => <span key={score.id} className={ratingTone(score.rating)}>{score.name} <b>{score.score}</b></span>)}</span>}
        {item.disagreement && <em className="ai-disagreement" title={`各模型分差 ${item.spread} 分`}>模型分歧</em>}
        <small>{stamp(review)}</small>
      </div>
      <AiDimBreakdown item={item} />
      {item.disagreement && item.disagreementDetail && (
        <div className="ai-debate-panel standalone" role="region" aria-label={`多空分歧辩论（差${item.disagreementDetail.spread}分）`}>
          <div className="ai-debate-head">多空辩论（模型分差 {item.disagreementDetail.spread} 分）</div>
          <div className="ai-debate-sides">
            <div className="ai-debate-side bull">
              <b>看多 · {item.disagreementDetail.highest.model} ({item.disagreementDetail.highest.score}分{item.disagreementDetail.highest.rating ? `/${item.disagreementDetail.highest.rating}` : ""})</b>
              <span>{item.disagreementDetail.highest.thesis || item.disagreementDetail.highest.highlights}</span>
            </div>
            <div className="ai-debate-side bear">
              <b>谨慎 · {item.disagreementDetail.lowest.model} ({item.disagreementDetail.lowest.score}分{item.disagreementDetail.lowest.rating ? `/${item.disagreementDetail.lowest.rating}` : ""})</b>
              <span>{item.disagreementDetail.lowest.thesis || item.disagreementDetail.lowest.risks}</span>
            </div>
          </div>
          {item.disagreementDetail.verificationPoint && <div className="ai-debate-trigger">{item.disagreementDetail.verificationPoint}</div>}
        </div>
      )}
      <dl className="ai-stock-review-text">
        {item.trend && <><dt>趋势位置</dt><dd>{item.trend}</dd></>}
        {item.volume && <><dt>量能</dt><dd>{item.volume}</dd></>}
        <dt>看点</dt><dd>{item.highlights || "--"}</dd>
        <dt>风险</dt><dd>{item.risks || "--"}</dd>
        <dt>次日关注</dt><dd>{item.nextDay || "--"}</dd>
        {item.keyLevels && <><dt>关键价位</dt><dd>{item.keyLevels}</dd></>}
      </dl>
      {profile && <div className="ai-stock-review-facts">
        <span>{profileFacts(profile).join(" · ")}</span>
        {!!profile.support?.length && <span>支撑：{profile.support.map(level => `${level.label} ${level.price.toFixed(2)}`).join("、")}</span>}
        {!!profile.resistance?.length && <span>压力：{profile.resistance.map(level => `${level.label} ${level.price.toFixed(2)}`).join("、")}</span>}
        {!!profile.announcements?.length && <ul className="ai-notice-list" aria-label="近30天公告">{profile.announcements.map((notice, index) => <li key={`${notice.date}:${index}`}>
          <em className={notice.risk >= 3 ? "weak" : notice.direction === "利好" ? "strong" : notice.direction === "中性" ? "" : "weak"}>{notice.risk >= 3 ? "重大风险" : notice.direction}</em>{notice.date} {notice.title}</li>)}</ul>}
      </div>}
    </div>}
    {item && <p className="ai-selection-note">AI 只依据行情数据判断，可能出错，仅供参考，不构成投资建议；发给 AI 的只有代码、名称、行业、行情指标和公开的公司公告标题，不含持仓数量或成本。</p>}
  </section>;
}
