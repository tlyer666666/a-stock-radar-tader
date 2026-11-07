import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { createServiceJobScope } from "./serviceJobClient";
import { TREND_QUALITY_PRESETS, TREND_STRATEGY_CHOICES, validQualityConfig } from "./trendStrategyConfig";
import type { TrendQualityConfig, TrendStrategyId } from "./trendScreenerTypes";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const MAX_DATASET_BYTES = 16 * 1024 * 1024;

function validateDataset(value: unknown): asserts value is JsonRecord {
  if (!record(value) || value.schemaVersion !== 1 || !["real", "synthetic"].includes(String(value.sourceClass)) ||
      typeof value.source !== "string" || !value.source.trim() || !["point-in-time", "current-survivors", "selected"].includes(String(value.universeMode)) ||
      !Array.isArray(value.calendar) || !value.calendar.length || !Array.isArray(value.benchmarkRows) || !Array.isArray(value.securities) || !value.securities.length) {
    throw new Error("数据集需为 schemaVersion=1 的 JSON 对象，包含 sourceClass/source/universeMode、calendar、benchmarkRows 与 securities；不会自动补入演示数据。");
  }
}

export function validateTrendResearchInput(input: { dataset: unknown; from: string; to: string; splitDate: string }): void {
  if (!input.dataset) throw new Error("尚未导入数据集，研究证据未知；请先选择 JSON 文件。");
  validateDataset(input.dataset);
  if (![input.from, input.to, input.splitDate].every(date) || input.from > input.splitDate || input.splitDate > input.to) {
    throw new Error("请明确填写有效日期，并满足研究起始 ≤ 开发 / 检验分界 ≤ 研究截止。");
  }
}

export async function readTrendResearchFile(file: Pick<File, "size" | "text">): Promise<JsonRecord> {
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_DATASET_BYTES) throw new Error("JSON 文件大小须在 1 字节至 16 MiB 之间。");
  const text = await file.text();
  if (new TextEncoder().encode(text).byteLength > MAX_DATASET_BYTES) throw new Error("JSON 文件超过 16 MiB。");
  let dataset: unknown;
  try { dataset = JSON.parse(text); } catch { throw new Error("无法解析 JSON 数据集；仅接受数据，不执行脚本。"); }
  validateDataset(dataset);
  return dataset;
}

type AccountSummary = { closed: number | null; censored: number | null; unresolved: number | null; pending: number | null; complete: boolean | null };
function accountSummary(value: unknown): AccountSummary {
  const account = record(value) && record(value.sharedAccount) ? value.sharedAccount : {};
  const metrics = record(account.metrics) ? account.metrics : {};
  const count = (key: string) => typeof metrics[key] === "number" && Number.isSafeInteger(metrics[key]) && Number(metrics[key]) >= 0 ? Number(metrics[key]) : null;
  return { closed: count("closed"), censored: count("censored"), unresolved: count("unresolved"), pending: count("pending"), complete: typeof metrics.completeEquityEvidence === "boolean" ? metrics.completeEquityEvidence : null };
}

export function trendResearchReportSummary(value: unknown) {
  const report = record(value) ? value : {};
  const qualification = record(report.qualification) ? report.qualification : {};
  return { qualification: typeof qualification.status === "string" ? qualification.status : "UNKNOWN", superiorityVerified: false as const,
    baseline: accountSummary(report.baseline), advanced: accountSummary(report.advanced),
    limitations: Array.isArray(qualification.limitations) ? qualification.limitations.filter((item): item is string => typeof item === "string").slice(0, 20) : [] };
}

type EvaluationInput = { requestId: string; dataset: JsonRecord; from: string; to: string; splitDate: string; advancedStrategyId: TrendStrategyId; advancedConfig?: Record<string, number> };
type ResearchBridge = { evaluateTrendResearch?: (input: EvaluationInput) => Promise<unknown>; cancelServiceJob?: (requestId: string) => Promise<unknown> };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const display = (value: number | null) => value === null ? "未知" : value.toLocaleString("zh-CN");

export default function TrendResearchTools({ qualityConfig = TREND_QUALITY_PRESETS.robust }: { qualityConfig?: TrendQualityConfig }) {
  const [dataset, setDataset] = useState<JsonRecord | null>(null);
  const [filename, setFilename] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [splitDate, setSplitDate] = useState("");
  const [strategyId, setStrategyId] = useState<TrendStrategyId>("quality-v2");
  const [report, setReport] = useState<JsonRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const revision = useRef(0);
  const pending = useRef(false);
  const [scope] = useState(() => createServiceJobScope(id => {
    const bridge = window.stockApi as unknown as ResearchBridge;
    return bridge.cancelServiceJob ? bridge.cancelServiceJob(id) : Promise.resolve(false);
  }));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; revision.current++; void scope.cancelAll(); };
  }, [scope]);
  const qualityKey = `${qualityConfig.maxExtensionAtr}/${qualityConfig.minCloseLocation}/${qualityConfig.maxVolumeRatio}`;
  const previousQualityKey = useRef(qualityKey);
  useEffect(() => {
    if (previousQualityKey.current === qualityKey) return;
    previousQualityKey.current = qualityKey;
    if (strategyId !== "quality-v2") return;
    if (pending.current) { revision.current++; pending.current = false; setBusy(false); void scope.cancelAll(); }
    setReport(null); setError("");
    setNotice("当前质量参数已变化，请重新运行研究复核。");
  }, [qualityKey, scope, strategyId]);
  const changed = () => { revision.current++; setReport(null); setError(""); setNotice(""); };
  const importDataset = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || pending.current) return;
    event.target.value = "";
    const current = ++revision.current;
    setDataset(null); setReport(null); setFilename(""); setError(""); setNotice(""); setReading(true);
    try {
      const next = await readTrendResearchFile(file);
      if (mounted.current && revision.current === current) { setDataset(next); setFilename(file.name); }
    } catch (reason) {
      if (mounted.current && revision.current === current) setError(message(reason));
    } finally {
      if (mounted.current && revision.current === current) setReading(false);
    }
  };
  const evaluate = async () => {
    if (pending.current || reading) return;
    const current = ++revision.current;
    setReport(null); setError(""); setNotice("");
    try {
      validateTrendResearchInput({ dataset, from, to, splitDate });
      if (strategyId === "quality-v2" && !validQualityConfig(qualityConfig)) throw new Error("上方质量参数无效，请先修正再运行研究复核。");
      const bridge = window.stockApi as unknown as ResearchBridge;
      if (typeof bridge.evaluateTrendResearch !== "function" || typeof bridge.cancelServiceJob !== "function") throw new Error("当前运行环境不支持研究评估或取消，请更新软件后重试。");
      pending.current = true; setBusy(true);
      const evaluateResearch = bridge.evaluateTrendResearch.bind(bridge);
      const next = await scope.run(requestId => evaluateResearch({ requestId, dataset: dataset!, from, to, splitDate, advancedStrategyId: strategyId,
        ...(strategyId === "quality-v2" ? { advancedConfig: { ...qualityConfig } } : {}) }));
      if (mounted.current && revision.current === current) {
        if (!record(next) || !record(next.qualification) || !record(next.baseline) || !record(next.advanced)) throw new Error("研究报告不完整，证据状态未知，不能形成研究结论。");
        setReport(next); setNotice("描述性研究复核完成。请同时检查删失、未解决样本和数据资格。");
      }
    } catch (reason) {
      if (mounted.current && revision.current === current) setError(message(reason));
    } finally {
      if (mounted.current && revision.current === current) { pending.current = false; setBusy(false); }
    }
  };
  const cancel = () => {
    revision.current++; pending.current = false; setBusy(false); setReport(null); setNotice("已请求取消研究评估；迟到结果会被忽略。");
    void scope.cancelAll();
  };
  const exportReport = () => {
    if (!report) return;
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `趋势研究复核-${from}-${to}.json`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(`导出失败：${message(reason)}`); }
  };
  const summary = trendResearchReportSummary(report);
  const qualifications: Record<string, string> = { SYNTHETIC_MECHANICS_ONLY: "合成数据 · 仅验证机制", REAL_DIAGNOSTIC: "真实数据 · 描述性诊断", UNKNOWN: "未知" };
  return <details className="research-disclosure trend-research-tools" aria-label="研究复核工具">
    <summary><span>研究复核工具</span><small>导入历史数据 · 共享资金评估 · 报告导出</small></summary>
    <section className="trend-status-card">
      <p>按自行提供的数据比较原版趋势 v1 与一个策略，包含共享资金、同股去重、费用和仓位约束。仅作描述性机制评估，任何结果都不证明收益优越，也不解锁最终留出或改写生产参数。</p>
      <p>数据需包含原始 / 复权 OHLCV、交易日历、指数和来源说明；历史限价、停牌、证券池及状态证据不完整会保留为未解决或不完整，不能以缺失值补成零。</p>
      <div className="trend-form-grid">
        <label className="trend-input-field"><span>研究数据集 JSON（最多16 MiB）</span><input aria-label="研究数据集 JSON" type="file" accept=".json,application/json" disabled={busy || reading} onChange={event => void importDataset(event)} /></label>
        <label className="trend-input-field"><span>研究起始日期</span><input aria-label="研究起始日期" type="date" value={from} disabled={busy || reading} onChange={event => { changed(); setFrom(event.target.value); }} /></label>
        <label className="trend-input-field"><span>研究截止日期</span><input aria-label="研究截止日期" type="date" value={to} disabled={busy || reading} onChange={event => { changed(); setTo(event.target.value); }} /></label>
        <label className="trend-input-field"><span>开发 / 检验分界日期</span><input aria-label="开发 / 检验分界日期" type="date" value={splitDate} disabled={busy || reading} onChange={event => { changed(); setSplitDate(event.target.value); }} /></label>
        <label className="trend-strategy-select"><span>对照策略（基准为原版 v1）</span><select aria-label="研究对照策略" value={strategyId} disabled={busy || reading} onChange={event => { changed(); setStrategyId(event.target.value as TrendStrategyId); }}>{TREND_STRATEGY_CHOICES.filter(item => item.id !== "classic-v1").map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      </div>
      <p role="status">{reading ? "正在读取 JSON…" : dataset ? `已导入 ${filename} · 来源：${String(dataset.source)} · ${dataset.sourceClass === "synthetic" ? "合成数据（非投资证据）" : "真实数据声明（仍待完整性核验）"}` : "尚未导入数据集，研究证据未知；不会自动运行演示数据。"}</p>
      {strategyId === "quality-v2" && <p>质量版使用上方当前参数：{Object.entries(qualityConfig).map(([key, value]) => `${key}=${value}`).join(" · ")}。执行假设、策略版本及数据指纹保存在导出的报告中。</p>}
      <div className="trend-calc-foot"><button className="trend-btn trend-btn-accent" disabled={busy || reading} onClick={() => void evaluate()}>{busy ? "研究评估中…" : "运行研究复核"}</button><button className="trend-btn" disabled={!busy} onClick={cancel}>取消研究评估</button><button className="trend-btn" disabled={!report || busy} onClick={exportReport}>导出研究报告 JSON</button></div>
      {error && <p className="trend-error" role="alert">{error}</p>}{notice && <p className="trend-save-notice" role="status">{notice}</p>}
      {report && <div className="trend-research-report" aria-label="研究复核报告">
        <h2>数据资格：{qualifications[summary.qualification] || "未知（检查原始报告）"}</h2><p>收益优越结论：未验证。完整模型权益也不代表历史真实可成交或未来收益。</p>
        <div className="trend-result-scroll" tabIndex={0} role="region" aria-label="共享资金完整性"><table className="trend-result-table"><thead><tr><th>共享资金账户</th><th>权益数据证据</th><th>已闭合</th><th>期末删失</th><th>未解决</th><th>待入场</th></tr></thead><tbody>{([["原版 v1", summary.baseline], ["对照策略", summary.advanced]] as const).map(([label, row]) => <tr key={label}><th>{label}</th><td>{row.complete === null ? "未知" : row.complete ? "完整模型证据" : "不完整"}</td><td>{display(row.closed)}</td><td>{display(row.censored)}</td><td>{display(row.unresolved)}</td><td>{display(row.pending)}</td></tr>)}</tbody></table></div>
        <p>闭合收益统计不能代替组合权益；期末删失表示仍未结束，未解决样本不能当作零收益。请导出完整报告查看账户持仓、拒绝原因、费用及独立信号统计。</p>
        {!!summary.limitations.length && <ul>{summary.limitations.map((item, index) => <li key={index}>{item.slice(0, 2000)}</li>)}</ul>}
      </div>}
    </section>
  </details>;
}
