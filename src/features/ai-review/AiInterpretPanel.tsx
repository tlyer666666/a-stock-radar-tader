import { useEffect, useRef, useState } from "react";
import { Bot, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { aiErrorMessage } from "../strategy-selection/aiSelectionModel";

/**
 * 页面上的「AI 解读」（涨停生态、炸板观察、板块强度）：把本页已有的数据交给 AI 写要点、风险和观察点。
 * 打开时只读本机已保存的解读；点按钮才调用模型。
 */
export function AiInterpretPanel({ kind, asOfDate, getData, compact = false, disabled = false }: {
  kind: AiInterpretKind; asOfDate?: string | undefined; getData: () => unknown; compact?: boolean;
  /** 页面数据还没加载好时按钮不可用（面板照常占位，避免数据到达时页面跳动）。 */
  disabled?: boolean;
}) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai;
  const [value, setValue] = useState<AiInterpretation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState(true);
  const generation = useRef(0);
  const cacheRevision = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const cachedAt = cacheRevision.current;
    const stop = () => { generation.current += 1; };
    setValue(null); setBusy(false); setError("");
    if (!api?.cachedInterpret) return stop;
    void api.status().then(status => { if (generation.current === current) setConfigured(status.configured); }).catch(() => {});
    void api.cachedInterpret({ kind, ...(asOfDate ? { asOfDate } : {}) }).then(result => { if (generation.current === current && cacheRevision.current === cachedAt) setValue(result); }).catch(() => {});
    return stop;
  }, [api, kind, asOfDate]);

  if (!api?.interpret) return null;
  const run = async () => {
    if (busy || !api.interpret) return;
    const current = generation.current;
    cacheRevision.current += 1; // An initial cache read must not overwrite this explicit request.
    setBusy(true); setError("");
    try {
      const result = await api.interpret({ kind, data: getData(), ...(asOfDate ? { asOfDate } : {}), force: Boolean(value) });
      if (generation.current === current) setValue(result);
    } catch (reason) { if (generation.current === current) setError(aiErrorMessage(reason)); }
    finally { if (generation.current === current) setBusy(false); }
  };

  return <section className={`panel ai-interpret ${compact ? "compact" : ""}`} aria-label="AI 解读">
    <header className="ai-stock-review-head">
      <div><Bot size={17} /><span><b>AI 解读</b><small>{!configured ? "未配置模型：到「设置 → AI 助手」添加模型配置" : disabled ? "本页数据加载后可用" : "把本页数据交给 AI 写要点、风险和接下来要观察的地方"}</small></span></div>
      <button type="button" className="secondary-btn" onClick={() => void run()} disabled={!configured || busy || disabled}>
        {busy ? <LoaderCircle size={15} className="spin" /> : value ? <RefreshCw size={15} /> : <Sparkles size={15} />}{busy ? "解读中…" : value ? "重新解读" : "AI 解读"}</button>
    </header>
    {error && <div className="test-result fail" role="alert"><span />{error}</div>}
    {value && <article className="ai-summary">
      <h3>{value.headline || `${value.title}解读`}{kind !== "sectors" && <small>{value.asOfDate ? `数据日 ${value.asOfDate} · ` : ""}{value.model} · {new Date(value.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}{value.cached ? " · 本机已保存" : ""}</small>}</h3>
      {!!value.points.length && <div className="ai-summary-row"><b>要点</b><ul>{value.points.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      {!!value.risks.length && <div className="ai-summary-row"><b>风险</b><ul>{value.risks.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      {!!value.watch.length && <div className="ai-summary-row"><b>接下来看</b><ul>{value.watch.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      <p className="ai-selection-note">AI 只依据本页数据判断，可能出错，仅供参考，不构成投资建议。</p>
    </article>}
  </section>;
}
