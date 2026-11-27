import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { inferSecid } from "../../domain/securityIdentifiers";
import { userErrorText } from "../../userErrorText";
import {
  ACTION_LABEL, HORIZON_LABEL, STATUS_LABEL, actionTone, outcomeText, planText, shortDate, summaryText,
  type DecisionSignal, type DecisionSignalList, type MessageDecision, type SignalStatus
} from "./decisionSignalModel";

/** 问股回答下面的「已记入 AI 建议」卡片。 */
export function DecisionCard({ decision, onOpen }: { decision: MessageDecision; onOpen?: (() => void) | undefined }) {
  const plan = planText(decision);
  return <div className={`agent-decision tone-${actionTone(decision.action)}`} aria-label="已记入 AI 建议">
    <b>{decision.actionLabel}</b>
    <span>管 {decision.horizonLabel}</span>
    {plan && <span>{plan}</span>}
    {decision.invalidation && <span>失效：{decision.invalidation}</span>}
    {decision.guardrail && <em title="软件的护栏把这条建议降级了">{decision.guardrail}</em>}
    <small>已记入 AI 建议，1/3/5/10 个交易日后自动核对对错{onOpen ? <button type="button" className="link-btn" onClick={onOpen}>查看全部建议</button> : null}</small>
  </div>;
}

const FILTERS: Array<{ id: "" | SignalStatus; label: string }> = [
  { id: "", label: "全部" }, { id: "active", label: "生效中" }, { id: "expired", label: "已过期" }, { id: "invalidated", label: "已失效" }, { id: "closed", label: "已关闭" }
];

/** 展示用（纯渲染，便于测试）。 */
export function DecisionSignalsTable({ data, busy, filter, onFilter, onRefresh, onUpdate, onOpenStock }: {
  data: DecisionSignalList;
  busy: boolean;
  filter: "" | SignalStatus;
  onFilter: (value: "" | SignalStatus) => void;
  onRefresh: () => void;
  onUpdate: (input: { id: string; status?: "closed" | "invalidated"; feedback?: "useful" | "not_useful" | null; remove?: boolean }) => void;
  onOpenStock?: ((security: Security) => void) | undefined;
}) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const rows = useMemo(() => filter ? data.signals.filter(item => item.status === filter) : data.signals, [data.signals, filter]);
  const stats = data.stats;
  const totalCount = stats?.total ?? data.signals.length;
  const listCapped = Boolean(stats && stats.total > data.signals.length);
  const activeTabId = `agent-signals-tab-${filter || "all"}`;
  return <section className="panel agent-signals" aria-label="AI 建议">
    <header className="agent-signals-head">
      <div>
        <h3>AI 建议</h3>
        <small>AI 问股对个股、ETF 给出的每条明确建议都记在这里；之后第 1、3、5、10 个交易日收盘自动核对（涨跌超过 {stats?.hitPct ?? 1}% 才算对或错，期间跌破止损算错）。只记录和核对，不下单。</small>
      </div>
      <button type="button" className="secondary-btn" disabled={busy} onClick={onRefresh}><RefreshCw size={14} className={busy ? "spin" : ""} />{busy ? "核对中…" : "核对最新结果"}</button>
    </header>
    {stats && <div className="agent-signals-stats">
      {(["1", "3", "5", "10"] as const).map(days => {
        const summary = stats.byDays[days];
        const headline = summary?.enough
          ? (summary.hit + summary.miss === 0 ? "全持平" : Number.isFinite(summary.hitRatePct) ? `${summary.hitRatePct}%` : "--")
          : "--";
        return <div key={days} className={summary?.enough ? "" : "thin"}>
          <span>{days} 日后</span>
          <strong>{headline}</strong>
          <small>{summaryText(summary)}</small>
        </div>;
      })}
    </div>}
    {data.evaluation && data.evaluation.failed < 0 && <p className="warning-banner" role="alert">事后验证未能完成，请稍后重试。</p>}
    {data.evaluation && data.evaluation.failed > 0 && <p className="ai-agent-muted" role="status">有 {data.evaluation.failed} 只股票的日线没读到，这些建议下次再核对。</p>}
    <div className="agent-signals-filter" role="tablist" aria-label="建议状态">
      {FILTERS.map(item => <button key={item.id || "all"} id={`agent-signals-tab-${item.id || "all"}`} type="button" role="tab" aria-selected={filter === item.id} aria-controls="agent-signals-tabpanel" className={filter === item.id ? "active" : ""} onClick={() => { setConfirmDeleteId(null); onFilter(item.id); }}>
        {item.label}{item.id === "" ? ` ${totalCount}` : item.id === "active" && stats ? ` ${stats.active}` : ""}</button>)}
    </div>
    <div id="agent-signals-tabpanel" role="tabpanel" aria-labelledby={activeTabId}>
      {listCapped && <p className="ai-agent-muted">列表最多展示最近 {data.signals.length} 条，共 {stats!.total} 条记录。</p>}
      {rows.length === 0
        ? <p className="ai-agent-muted">{data.signals.length ? "这个状态下没有建议。" : "还没有建议。在 AI 问股里分析一只股票或 ETF，AI 给出明确态度后会自动记到这里。"}</p>
        : <div className="bond-table-wrap" role="region" aria-label="AI 建议列表" tabIndex={0}>
          <table className="bond-table agent-signals-table">
            <thead><tr><th scope="col">时间</th><th scope="col">股票</th><th scope="col">建议</th><th scope="col">计划</th><th scope="col">1 日</th><th scope="col">3 日</th><th scope="col">5 日</th><th scope="col">10 日</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
            <tbody>{rows.map(signal => <SignalRow key={signal.id} signal={signal} confirmDelete={confirmDeleteId === signal.id} onRequestDelete={() => setConfirmDeleteId(signal.id)} onCancelDelete={() => setConfirmDeleteId(null)} onUpdate={input => { if (input.remove) setConfirmDeleteId(null); onUpdate(input); }} onOpenStock={onOpenStock} />)}</tbody>
          </table>
        </div>}
    </div>
  </section>;
}

function SignalRow({ signal, confirmDelete, onRequestDelete, onCancelDelete, onUpdate, onOpenStock }: {
  signal: DecisionSignal;
  confirmDelete: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onUpdate: (input: { id: string; status?: "closed" | "invalidated"; feedback?: "useful" | "not_useful" | null; remove?: boolean }) => void;
  onOpenStock?: ((security: Security) => void) | undefined;
}) {
  const plan = planText(signal);
  return <tr className={`status-${signal.status}`}>
    <td>{shortDate(signal.createdAt)}{signal.referencePrice !== null && Number.isFinite(signal.referencePrice) && <small>当时 {signal.referencePrice}</small>}</td>
    <td>{onOpenStock
      ? <button type="button" className="bond-identity" onClick={() => onOpenStock({ code: signal.code, name: signal.name, secid: inferSecid(signal.code), assetType: signal.assetType })}><b>{signal.name}</b><code>{signal.code}</code></button>
      : <span className="bond-identity"><b>{signal.name}</b><code>{signal.code}</code></span>}</td>
    <td><span className={`agent-signal-action tone-${actionTone(signal.action)}`}>{ACTION_LABEL[signal.action]}</span><small>管 {HORIZON_LABEL[signal.horizon]}{signal.confidence ? ` · 把握${signal.confidence}` : ""}</small></td>
    <td className="agent-signal-plan" title={[signal.reason, signal.invalidation ? `失效条件：${signal.invalidation}` : "", ...signal.watch.map(item => `盯：${item}`), signal.guardrail].filter(Boolean).join("\n")}>
      {plan || "--"}{signal.invalidation && <small>失效：{signal.invalidation}</small>}{signal.guardrail && <small className="warn">{signal.guardrail}</small>}</td>
    {(["1", "3", "5", "10"] as const).map(days => { const result = outcomeText(signal.outcomes?.[days]); return <td key={days} className={`agent-signal-outcome ${result.tone}`}>{result.text}</td>; })}
    <td>{STATUS_LABEL[signal.status]}{signal.endedReason && <small>{signal.endedReason}</small>}</td>
    <td className="agent-signal-ops">
      <button type="button" className={`link-btn${signal.feedback === "useful" ? " active" : ""}`} aria-label="这条建议有用" aria-pressed={signal.feedback === "useful"} onClick={() => onUpdate({ id: signal.id, feedback: signal.feedback === "useful" ? null : "useful" })}><ThumbsUp size={13} /></button>
      <button type="button" className={`link-btn${signal.feedback === "not_useful" ? " active" : ""}`} aria-label="这条建议没用" aria-pressed={signal.feedback === "not_useful"} onClick={() => onUpdate({ id: signal.id, feedback: signal.feedback === "not_useful" ? null : "not_useful" })}><ThumbsDown size={13} /></button>
      {signal.status === "active" && <button type="button" className="link-btn" title="不再跟踪这条建议（仍会核对对错）" onClick={() => onUpdate({ id: signal.id, status: "closed" })}><X size={13} />关闭</button>}
      {confirmDelete
        ? <>
            <button type="button" className="link-btn danger" onClick={() => onUpdate({ id: signal.id, remove: true })}>确认删除</button>
            <button type="button" className="link-btn" onClick={onCancelDelete}>取消</button>
          </>
        : <button type="button" className="link-btn danger" aria-label="删除这条建议" onClick={onRequestDelete}><Trash2 size={13} /></button>}
    </td>
  </tr>;
}

const EMPTY_SIGNALS: DecisionSignalList = { signals: [], stats: null, evaluation: null };
const SIGNAL_EVAL_TTL_MS = 60_000;
const signalsCache: {
  filter: "" | SignalStatus;
  data: DecisionSignalList;
  evaluatedAt: number;
} = {
  filter: "",
  data: EMPTY_SIGNALS,
  evaluatedAt: 0
};

/** 测试辅助：重置模块级 AI 建议缓存。 */
export function resetDecisionSignalsCache() {
  signalsCache.filter = "";
  signalsCache.data = EMPTY_SIGNALS;
  signalsCache.evaluatedAt = 0;
}

/** AI 建议页：读取建议池，点进个股再返回直接恢复筛选与列表，60 秒内不重复做全量事后核对（手动点「核对最新结果」始终核对）。 */
export default function DecisionSignalsPanel({ onOpenStock }: { onOpenStock?: ((security: Security) => void) | undefined }) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai?.agent;
  const [data, setDataState] = useState<DecisionSignalList>(() => signalsCache.data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilterState] = useState<"" | SignalStatus>(() => signalsCache.filter);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  // 操作（反馈、关闭、删除）用自己的计数：不能让它把正在进行的「核对」判成过期，否则按钮会一直停在「核对中…」。
  const updateSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const setFilter = useCallback((next: "" | SignalStatus) => {
    signalsCache.filter = next;
    setFilterState(next);
  }, []);

  const load = useCallback(async (evaluate: boolean) => {
    if (typeof api?.signals !== "function") return;
    const seq = ++seqRef.current;
    const mutationSeq = updateSeqRef.current;
    setBusy(true); setError("");
    try {
      const next = await api.signals({ evaluate });
      if (!mountedRef.current || seq !== seqRef.current) return;
      if (updateSeqRef.current !== mutationSeq) return;
      signalsCache.data = next;
      if (evaluate) signalsCache.evaluatedAt = Date.now();
      setDataState(next);
    } catch (reason) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setError(userErrorText(reason, "AI 建议读取失败"));
    } finally {
      // 只要还挂载着、这是最新的一次读取，就解除「核对中」。
      if (mountedRef.current && seq === seqRef.current) setBusy(false);
    }
  }, [api]);
  useEffect(() => {
    const recentlyEvaluated = signalsCache.evaluatedAt > 0 && Date.now() - signalsCache.evaluatedAt < SIGNAL_EVAL_TTL_MS;
    void load(!recentlyEvaluated);
  }, [load]);

  const update = useCallback((input: { id: string; status?: "closed" | "invalidated"; feedback?: "useful" | "not_useful" | null; remove?: boolean }) => {
    if (typeof api?.updateSignal !== "function") return;
    const seq = ++updateSeqRef.current;
    setError("");
    void api.updateSignal(input).then(next => {
      if (!mountedRef.current || seq !== updateSeqRef.current) return;
      signalsCache.data = next;
      setDataState(next);
      setError("");
    }).catch(reason => {
      if (!mountedRef.current || seq !== updateSeqRef.current) return;
      setError(userErrorText(reason, "操作失败"));
    });
  }, [api]);

  if (typeof api?.signals !== "function") return <p className="ai-agent-muted">当前连接没有 AI 建议接口，请使用桌面版。</p>;
  return <>
    {error && <div className="warning-banner" role="alert">{error}</div>}
    <DecisionSignalsTable data={data} busy={busy} filter={filter} onFilter={setFilter} onRefresh={() => void load(true)} onUpdate={update} onOpenStock={onOpenStock} />
  </>;
}
