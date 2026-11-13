import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Scale } from "lucide-react";
import { ratingTone } from "../strategy-selection/aiSelectionModel";

const dimTone = (score: number) => score >= 75 ? "strong" : score >= 60 ? "good" : score >= 40 ? "neutral" : "weak";

/** 读取分析框架目录，切换当前框架。切换后回调 onChanged（重新读取本机结果：换框架后旧结果不再适用）。 */
export function useAiFrameworks(onChanged?: () => void) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai;
  const [catalog, setCatalog] = useState<AiFrameworkCatalog | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!api?.frameworks) return;
    let active = true;
    void api.frameworks().then(value => { if (active) setCatalog(value); }).catch(() => {});
    return () => { active = false; };
  }, [api]);
  const choose = useCallback(async (id: AiFrameworkInfo["id"]) => {
    if (!api?.saveFramework) return;
    try { setCatalog(await api.saveFramework({ active: id })); setError(""); onChanged?.(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [api, onChanged]);
  return { catalog, choose, error, available: Boolean(api?.frameworks) };
}

/** 分析框架选择 + 展开看维度权重和硬规则。 */
export function AiFrameworkPicker({ catalog, onChoose, disabled = false, inline = false }: { catalog: AiFrameworkCatalog | null; onChoose: (id: AiFrameworkInfo["id"]) => void; disabled?: boolean; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!catalog) return null;
  const current = catalog.frameworks.find(item => item.id === catalog.active) || catalog.frameworks[0]!;
  const auto = catalog.frameworks.find(item => item.id === "auto");
  const playbooks = catalog.frameworks.filter(item => item.id !== "auto" && item.id !== "custom");
  const custom = catalog.frameworks.find(item => item.id === "custom");
  return <div className={`ai-framework-picker${inline ? " inline" : ""}`}>
    <label className="ai-profile-select"><Scale size={15} /><span>分析框架</span>
      <select aria-label="分析框架" value={catalog.active} disabled={disabled} onChange={event => onChoose(event.target.value as AiFrameworkInfo["id"])}>
        {auto && <option value="auto">{auto.name}（推荐）</option>}
        {!!playbooks.length && <optgroup label={`只用一套策略（共 ${playbooks.length} 套）`}>{playbooks.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}
        {custom && <option value="custom">{custom.name}（自定义）</option>}</select></label>
    <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起说明" : "怎么打分"}<ChevronDown size={13} className={open ? "ai-rotate" : ""} /></button>
    {open && <div className="ai-framework-detail">
      {current.id === "auto" ? <>
        <p>{current.description}基础分按 AI 选的策略和权重加权；命中所选策略的硬规则时最多给“观望”；AI 没有返回时由软件按适配度最高的两套组合。</p>
        <ul className="ai-playbook-list">{playbooks.map(item => <li key={item.id}><b>{item.name}</b><small>{item.description}</small></li>)}</ul>
      </> : <>
        <p>{current.description}{current.guidance ? ` ${current.guidance}` : ""}</p>
        <ul>{current.dimensions.map(dim => <li key={dim.id}><b>{dim.label}</b><em>{dim.weight}</em><small>{dim.detail}</small></li>)}</ul>
        {!!current.caps.length && <p>硬规则（命中后最多“观望”）：{current.caps.map(cap => cap.label).join("；")}</p>}
      </>}
      <p>软件先按维度打分、加权得到基础分，AI 只能在基础分上下 15 分内调整，并写出理由。换框架后要重新打分；自定义框架在「设置 → AI 助手」里改。</p>
    </div>}
  </div>;
}

/** 表格里的分数格：最终分、评级、基础分和 AI 调整。 */
export function AiScoreCell({ item, expectedModels = 1 }: { item: AiRankItem; expectedModels?: number }) {
  const title = item.dims?.length ? [`${item.framework || "分析框架"} 基础分 ${item.base}`, item.situation?.length ? `情境：${item.situation.join("、")}` : "",
    item.orchestration ? `编排理由：${item.orchestration}` : "", ...(item.plays || []).map(play => `${play.name} ${play.weight}%：该策略基础分 ${play.base}`),
    ...item.dims.map(dim => `${dim.label}（权重 ${dim.weight}）${dim.score} 分：${dim.note}`), ...(item.caps || []).map(cap => `硬规则：${cap}`), item.reason ? `AI 调整：${item.reason}` : ""].filter(Boolean).join("\n") : undefined;
  if (item.fallback) return <span className="ai-score-cell" title={title}>
    <b>{item.score}</b><small>仅基础分</small><small>AI 待补</small>
  </span>;
  const answered = item.scores?.length ?? 1;
  return <span className="ai-score-cell" title={title}>
    <span className={`ai-score-badge ${ratingTone(item.rating)}`}>{item.score}</span><small>{item.rating}</small>
    {expectedModels > answered && <small>模型已返回 {answered}/{expectedModels}</small>}
    {typeof item.base === "number" && <small className="ai-score-base">基础 {item.base}{item.adjust ? ` · AI ${item.adjust > 0 ? "+" : ""}${item.adjust}` : ""}</small>}
    {!!item.plays?.length && <small className="ai-score-plays">{item.plays.map(play => item.plays!.length > 1 ? `${play.name}${play.weight}` : play.name).join("+")}</small>}
    {!!item.caps?.length && <small className="ai-score-cap">触发硬规则</small>}
  </span>;
}

/** 各维度得分小标签。 */
export function AiDimChips({ dims }: { dims?: AiDimScore[] | undefined }) {
  if (!dims?.length) return <>--</>;
  return <span className="ai-dim-chips">{dims.map(dim => <span key={dim.id} className={dimTone(dim.score)} title={`${dim.label}（权重 ${dim.weight}）：${dim.note}`}>{dim.label} <b>{dim.score}</b></span>)}</span>;
}

/** 个股点评里的维度明细：分数条 + 依据。 */
export function AiDimBreakdown({ item }: { item: AiRankItem }) {
  if (!item.dims?.length) return null;
  const plays = item.plays || [];
  return <div className="ai-dim-breakdown" aria-label="各维度得分">
    <p><b>{item.framework || "分析框架"}</b> 基础分 {item.base}{item.adjust ? `，AI ${item.adjust > 0 ? "+" : ""}${item.adjust}` : "，AI 未调整"}{item.reason ? `：${item.reason}` : ""}</p>
    {!!plays.length && <div className="ai-orchestration">
      {!!item.situation?.length && <span className="ai-situation">{item.situation.map(tag => <em key={tag}>{tag}</em>)}</span>}
      <span>{plays.map(play => <span key={play.id} className="ai-play"><b>{play.name}</b>{plays.length > 1 && <small>{play.weight}%</small>}<small>基础 {play.base}</small></span>)}</span>
      {item.orchestration && <small>编排理由：{item.orchestration}</small>}
      {plays.length > 0 && <small>下面是权重最大的「{[...plays].sort((a, b) => b.weight - a.weight)[0]!.name}」各维度得分</small>}
    </div>}
    <ul>{item.dims.map(dim => <li key={dim.id}>
      <span>{dim.label}<small>权重 {dim.weight}</small></span>
      <span className="ai-dim-bar"><i className={dimTone(dim.score)} style={{ width: `${Math.max(2, Math.min(100, dim.score))}%` }} /></span>
      <b>{dim.score}</b><small>{dim.note}</small></li>)}</ul>
    {!!item.caps?.length && <p className="ai-score-cap">触发硬规则：{item.caps.join("；")}（最终分最多 59）</p>}
  </div>;
}
