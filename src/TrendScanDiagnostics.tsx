import { ChevronDown } from "lucide-react";
import type { TrendScanStatus } from "./trendScreenerTypes";

const stages = [
  ["universeEligible", "可选名单"], ["rawValidated", "日线可用"],
  ["recentLimitPassed", "近期涨停"], ["trendPassed", "上涨趋势"],
  ["technicalTriggered", "形态触发"], ["riskPassed", "风险通过"]
] as const;
const sourceStages: Record<string, string> = { universe: "股票名单", benchmark: "市场指数", raw: "原始日线", adjusted: "前复权日线" };
export default function TrendScanDiagnostics({ status }: { status: TrendScanStatus | null }) {
  if (!status || status.phase === "idle") return null;
  const diagnostic = status.diagnostics;
  if (!diagnostic) return <p className="trend-diagnostic-legacy">本次快照未记录分层诊断，重新扫描后可查看。</p>;
  const active = status.phase === "loading-universe" || status.phase === "scanning";
  return <section className="trend-diagnostics" aria-label="筛选过程与数据来源">
    <div className="trend-diagnostics-head"><h2>筛选过程</h2><span>{active ? "扫描中 · 累计通过" : status.coverageComplete ? "本次扫描统计" : "部分数据 · 待补全"} · 去重股票数</span></div>
    <ol className="trend-funnel">{stages.map(([key, label], index) => <li key={key} data-funnel-stage={key}><span><i>{index + 1}</i>{label}</span><b>{diagnostic.funnel[key].toLocaleString("zh-CN")}</b></li>)}</ol>
    <details className="trend-source-details"><summary>数据来源与未通过原因<ChevronDown size={14} /></summary>
      <div className="trend-source-grid">{diagnostic.sources.map((source, index) => <article key={`${source.stage}-${source.source}-${index}`} className={source.status === "error" ? "is-error" : ""}><strong>{sourceStages[source.stage] || source.stage} · {source.source}</strong><span>成功 {source.successes} / 失败 {source.failures}{source.latestDate ? ` · 最新 ${source.latestDate}` : ""}</span><p>{source.detail}</p>{source.crossCheckedRows > 0 && <small>交叉核对 {source.crossCheckedRows} 行</small>}</article>)}</div>
      {diagnostic.reasons.length > 0 && <ul className="trend-reason-list">{diagnostic.reasons.map((item, index) => <li key={`${item.stage}-${index}`}><span>{item.reason}</span><b>{item.count}</b></li>)}</ul>}
      <p className="trend-diagnostic-caption">数据未取得或不可验证的股票不计为策略不合格。同股命中多个策略只计一只；规则明细以候选卡片为准。</p>
    </details>
  </section>;
}
