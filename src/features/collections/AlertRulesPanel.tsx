import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BellRing, FlaskConical, Play, Plus, Trash2 } from "lucide-react";
import { userErrorText } from "../../userErrorText";
import {
  ALERT_TYPE_OPTIONS, HISTORY_STATUS_LABEL, SCOPE_LABEL, alertTime, defaultParams, validateAlertRuleDraft,
  type AlertRule, type AlertRuleParams, type AlertRuleScope, type AlertRuleType, type AlertRulesRequest, type AlertRulesState
} from "./alertRulesModel";

const EMPTY: AlertRulesState = { rules: [], history: [], lastRunAt: "", types: {} };

/** 展示用（纯渲染，便于测试）。 */
export function AlertRulesView({ state, busy, message, error = "", onRequest }: {
  state: AlertRulesState;
  busy: boolean;
  message: string;
  error?: string;
  onRequest: (request: AlertRulesRequest) => void;
}) {
  const [type, setType] = useState<AlertRuleType>("ma_cross");
  const [scope, setScope] = useState<AlertRuleScope>("watchlist");
  const [code, setCode] = useState("");
  const [params, setParams] = useState<AlertRuleParams>(defaultParams("ma_cross"));
  const [windowDraft, setWindowDraft] = useState("20");
  const [periodDraft, setPeriodDraft] = useState("14");
  const [thresholdDraft, setThresholdDraft] = useState("0");
  const [cooldown, setCooldown] = useState("24");
  const [historyOpen, setHistoryOpen] = useState(state.history.length > 0);
  const prevHistoryLenRef = useRef(state.history.length);
  useEffect(() => {
    if (prevHistoryLenRef.current === 0 && state.history.length > 0) {
      setHistoryOpen(true);
    }
    prevHistoryLenRef.current = state.history.length;
  }, [state.history.length]);

  const option = ALERT_TYPE_OPTIONS.find(item => item.id === type)!;
  const market = type === "market_light";
  const codeBad = !market && scope === "symbol" && !/^\d{6}$/.test(code.trim());
  const patch = (next: AlertRuleParams) => setParams(current => ({ ...current, ...next }));
  const selectType = (next: AlertRuleType) => {
    const defaults = defaultParams(next);
    setType(next);
    setParams(defaults);
    if (defaults.window !== undefined) setWindowDraft(String(defaults.window));
    if (defaults.period !== undefined) setPeriodDraft(String(defaults.period));
    if (defaults.threshold !== undefined) setThresholdDraft(String(defaults.threshold));
  };
  const draft = useMemo(
    () => validateAlertRuleDraft({
      type,
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
      ...(params.statuses !== undefined ? { statuses: params.statuses } : {}),
      windowDraft,
      periodDraft,
      thresholdDraft,
      cooldownDraft: cooldown
    }),
    [type, params.direction, params.statuses, windowDraft, periodDraft, thresholdDraft, cooldown]
  );
  const submit = () => {
    if (codeBad || !draft.ok) return;
    onRequest({ op: "save", rule: { type, scope: market ? "market" : scope, code: code.trim(), params: draft.params, cooldownHours: draft.cooldownHours, enabled: true } });
  };
  return <section className="panel alert-rules" aria-label="指标预警">
    <header className="alert-rules-head">
      <div><BellRing size={17} /><h3>指标预警</h3><span>{state.rules.length} 条规则</span></div>
      <small>按已收盘的日线判断，指标「刚发生」的那一天提醒一次；一条规则可以套用到全部自选或全部持仓。每个交易日 15:10 后自动评估{state.lastRunAt ? `，上次 ${alertTime(state.lastRunAt)}` : ""}。</small>
      <button type="button" className="secondary-btn" disabled={busy || !state.rules.length} onClick={() => onRequest({ op: "run" })}><Play size={14} />{busy ? "评估中…" : "现在评估"}</button>
    </header>
    <div className="alert-rules-form" role="group" aria-label="新增指标预警">
      <label>类型<select value={type} onChange={event => selectType(event.target.value as AlertRuleType)}>
        {ALERT_TYPE_OPTIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {!market && <label>范围<select value={scope} onChange={event => setScope(event.target.value as AlertRuleScope)}>
        {(["watchlist", "holdings", "symbol"] as const).map(item => <option key={item} value={item}>{SCOPE_LABEL[item]}</option>)}</select></label>}
      {!market && scope === "symbol" && <label>代码<input value={code} inputMode="numeric" maxLength={6} placeholder="6 位代码" aria-invalid={codeBad && code !== ""} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></label>}
      {option.directions.length > 0 && <label>方向<select value={params.direction} onChange={event => patch({ direction: event.target.value })}>
        {option.directions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
      {type === "ma_cross" && <label>均线<input className="alert-num-input" type="text" inputMode="numeric" value={windowDraft} aria-invalid={!draft.ok} onChange={event => setWindowDraft(event.target.value)} />日</label>}
      {(type === "rsi" || type === "cci") && <>
        <label>周期<input className="alert-num-input" type="text" inputMode="numeric" value={periodDraft} aria-invalid={!draft.ok} onChange={event => setPeriodDraft(event.target.value)} /></label>
        <label>阈值<input className="alert-num-input" type="text" inputMode="decimal" value={thresholdDraft} aria-invalid={!draft.ok} onChange={event => setThresholdDraft(event.target.value)} /></label>
      </>}
      {market && <label>提醒时机<select value={(params.statuses || []).join(",")} onChange={event => patch({ statuses: event.target.value.split(",") })}>
        <option value="red,yellow">转红灯或黄灯</option><option value="red">只在转红灯</option></select></label>}
      <label title="同一条规则对同一只股票触发后，这段时间内不重复提醒">冷却<input className="alert-num-input" type="text" inputMode="numeric" value={cooldown} aria-invalid={!draft.ok} onChange={event => setCooldown(event.target.value)} />小时</label>
      <button type="button" className="primary-btn" disabled={busy || codeBad || !draft.ok} onClick={submit}><Plus size={14} />添加</button>
      {!draft.ok ? <small className="alert-rules-error" role="alert">{draft.error}</small> : <small>{option.hint}</small>}
    </div>
    {error && <p className="alert-rules-message error" role="alert">{error}</p>}
    {message && <p className="alert-rules-message" role="status">{message}</p>}
    {state.rules.length > 0 && <ul className="alert-rules-list">
      {state.rules.map(rule => <RuleRow key={rule.id} rule={rule} busy={busy} onRequest={onRequest} />)}
    </ul>}
    {state.dry && <div className="alert-rules-dry" role="region" aria-label="试跑结果">
      <b>试跑结果（不发通知、不记历史）</b>
      {state.dry.length ? state.dry.map((item, index) => <span key={`${item.code}-${index}`} className={item.status}>{item.target}：{HISTORY_STATUS_LABEL[item.status]} · {item.detail}</span>) : <span>没有可评估的对象</span>}
    </div>}
    <div className="alert-rules-history-wrap">
      <details className="alert-rules-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
        <summary>触发历史（{state.history.length}）</summary>
        {state.history.length === 0 ? <p className="alert-rules-empty">还没有记录。正常没触发不会记在这里，只记触发和数据不足。</p>
          : <ul>{state.history.slice(0, 60).map(item => <li key={item.id} className={item.status}>
            <time>{alertTime(item.at)}</time><b>{item.target}{item.code ? ` ${item.code}` : ""}</b><em>{HISTORY_STATUS_LABEL[item.status]}</em><span>{item.detail}</span><small>{item.ruleText}</small></li>)}</ul>}
      </details>
      {state.history.length > 0 && <button type="button" className="link-btn alert-rules-clear" disabled={busy} onClick={() => onRequest({ op: "clear" })}>清空</button>}
    </div>
  </section>;
}

function RuleRow({ rule, busy, onRequest }: { rule: AlertRule; busy: boolean; onRequest: (request: AlertRulesRequest) => void }) {
  const label = rule.text || rule.type;
  return <li className={rule.enabled ? "" : "paused"}>
    <label title={rule.enabled ? "暂停这条规则" : "启用这条规则"}><input type="checkbox" aria-label={`${rule.enabled ? "暂停" : "启用"}规则：${label}`} checked={rule.enabled} disabled={busy} onChange={event => onRequest({ op: "save", rule: { ...rule, enabled: event.target.checked } })} /></label>
    <span>{label}</span>
    <small>冷却 {rule.cooldownHours} 小时</small>
    <button type="button" className="link-btn" disabled={busy} title="用最新日线试跑一次，不发通知" onClick={() => onRequest({ op: "dry", id: rule.id })}><FlaskConical size={13} />试跑</button>
    <button type="button" className="link-btn danger" disabled={busy} aria-label="删除这条规则" onClick={() => onRequest({ op: "remove", id: rule.id })}><Trash2 size={13} /></button>
  </li>;
}

/** 指标预警面板：放在「决策中心」页，按已收盘日线自动或手动评估技术指标条件。 */
export default function AlertRulesPanel({ active = true }: { active?: boolean } = {}) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.alertRules;
  const [state, setState] = useState<AlertRulesState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const silentInFlightRef = useRef(false);
  const lastSilentRefreshRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightRef.current = false;
      silentInFlightRef.current = false;
    };
  }, []);
  const request = useCallback((input: AlertRulesRequest) => {
    if (typeof api !== "function") return;
    const seq = ++seqRef.current;
    inFlightRef.current = true;
    setBusy(true); setMessage(""); setError("");
    void api(input).then(next => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setState(next);
      if (next.run) setMessage(`评估了 ${next.run.evaluated} 项，${next.run.triggered ? `${next.run.triggered} 条触发` : "没有新触发"}`);
    }).catch(reason => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setError(userErrorText(reason, "操作失败"));
    }).finally(() => {
      if (seq === seqRef.current) {
        inFlightRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    });
  }, [api]);
  useEffect(() => { request({ op: "list" }); }, [request]);
  useEffect(() => {
    if (active === false || typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (inFlightRef.current || silentInFlightRef.current || typeof api !== "function") return;
      const now = Date.now();
      if (now - lastSilentRefreshRef.current <= 1500) return;
      lastSilentRefreshRef.current = now;
      silentInFlightRef.current = true;
      const seqBefore = seqRef.current;
      void api({ op: "list" }).then(next => {
        if (!mountedRef.current || seqRef.current !== seqBefore) return;
        setState(current => ({
          ...current,
          rules: next.rules,
          history: next.history,
          lastRunAt: next.lastRunAt,
          types: next.types
        }));
      }).catch(() => undefined).finally(() => {
        silentInFlightRef.current = false;
      });
    };
    window.addEventListener("focus", refresh);
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", refresh);
    }
    return () => {
      window.removeEventListener("focus", refresh);
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", refresh);
      }
    };
  }, [active, api]);
  if (typeof api !== "function") return null;
  return <AlertRulesView state={state} busy={busy} message={message} error={error} onRequest={request} />;
}
