import { AlertTriangle, ArrowDownRight, ArrowRight, Bookmark, BookmarkCheck, Calculator, Check, ChevronDown, ChevronRight, CircleHelp, ClipboardCheck, Download, Layers3, ListFilter, LoaderCircle, Play, RefreshCw, Search, ShieldCheck, Square, Target, Trash2, TrendingUp, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { TrendCandidate, TrendScanStatus, TrendStrategyId, TrendQualityConfig, TrendStrategySelection } from "./trendScreenerTypes";
import { createSavedTrendPlan, readTrendPlans, reviewSavedTrendPlan, trendCandidatesCsv, trendPlanId, writeTrendPlans, type SavedTrendPlan, type TrendReviewDraft } from "./trendWorkspace";
import { calculateTrendPosition, evaluateTrendExit } from "./trendPlan";
import { TREND_CONFIG_FIELDS, TREND_QUALITY_PRESETS, TREND_STRATEGY_CHOICES, strategyName, validQualityConfig } from "./trendStrategyConfig";
import "./trend-screener.css";
import TrendStrategyPanel from "./TrendStrategyPanel";
import TrendScanDiagnostics from "./TrendScanDiagnostics";

type Filter = "all" | "signal" | "A" | "B" | "watch";
type Action = "start" | "cancel" | null;
const boardNames: Record<string, string> = { main: "沪深主板", growth: "创业板", star: "科创板", beijing: "北交所" };
const running = (phase?: TrendScanStatus["phase"]) => phase === "loading-universe" || phase === "scanning";
const number = (value: number, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "—";
const count = (value: number) => Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
const inputNumber = (value: string) => value.trim() ? Number(value) : Number.NaN;
const dateTime = (value?: string) => {
  if (!value) return "未记录";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { hour12: false });
};
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const filterLabels: Record<Filter, string> = { all: "全部候选", signal: "有效信号", A: "A 回踩转强", B: "B 平台突破", watch: "趋势观察" };

const exampleCandidate: TrendCandidate = {
  security: { code: "EXAMPLE", name: "虚构方案算例", secid: "example.plan" }, board: "main",
  asOf: "虚构信号日", limitDate: "虚构涨停日", daysSinceLimit: 5, patterns: ["A"], stage: "signal", limitEvidence: "calculated",
  metrics: { close: 10, ma20: 9.7, ma60: 9, avgAmount20: 200000000, deviationPercent: 3.09, relativeStrength20: null, atr14: 0.2 },
  plan: { stop: 9.5, maxEntry: 10.3, maxRiskPercent: 7.77, holdingDays: "10–30 个交易日" }, evidence: [], warnings: ["虚构公式算例，不是真实证券"]
};

function PlanCalculator({ candidate, marketGate, draft, onDraftChange, defaultOpen = false }: { candidate: TrendCandidate; marketGate: TrendScanStatus["marketGate"]; draft: TrendReviewDraft; onDraftChange: (draft: TrendReviewDraft) => void; defaultOpen?: boolean }) {
  const [tab, setTab] = useState<"entry" | "exit">("entry");
  const { fields, checks } = draft;
  const [entryRequested, setEntryRequested] = useState(false);
  const [exitRequested, setExitRequested] = useState(false);
  const value = (key: string) => inputNumber(fields[key] || "");
  const field = (key: string, label: string, placeholder: string, extra?: string) => <label className="trend-input-field" key={key}><span>{label}</span><div><input type="number" aria-label={label} min="0" step="any" value={fields[key] || ""} placeholder={placeholder} onChange={(event) => onDraftChange({ fields: { ...fields, [key]: event.target.value }, checks })} />{extra && <i>{extra}</i>}</div></label>;
  const check = (key: string, label: string) => <label className="trend-check" key={key}><input type="checkbox" checked={Boolean(checks[key])} onChange={(event) => onDraftChange({ fields, checks: { ...checks, [key]: event.target.checked } })} /><span>{label}</span></label>;
  const plan = candidate.plan;
  if (!plan) return null;
  const sizing = entryRequested ? calculateTrendPosition({
    ...(plan.minEntry !== undefined ? { minEntryPrice: plan.minEntry } : {}),
    netAssetValue: value("nav"), entryPrice: value("entry"), stopPrice: plan.stop, maxEntryPrice: plan.maxEntry,
    industryExposureRatio: value("industry") / 100, portfolioExposureRatio: value("portfolio") / 100,
    openPositions: value("positions"), cashAvailable: value("cash"), feeReserve: value("fees"),
    minimumBuyQuantity: value("minimum"), quantityStep: value("step"), alreadyHeld: Boolean(checks.held),
    permissionVerified: Boolean(checks.permission), announcementVerified: Boolean(checks.announcement),
    corporateActionAligned: Boolean(checks.aligned), marketGate
  }) : null;
  const exit = exitRequested ? evaluateTrendExit({ stopPrice: plan.stop, holdingTradingDays: value("days"),
    close: value("close"), ma20: value("ma20"),
    ...(fields.previousClose?.trim() ? { previousClose: value("previousClose") } : {}),
    ...(fields.previousMa20?.trim() ? { previousMa20: value("previousMa20") } : {}),
    corporateActionAligned: Boolean(checks.exitAligned)
  }) : null;

  const entryEligible = Boolean(sizing?.eligible && checks.session);
  return <details className="trend-calculator" open={defaultOpen || undefined}>
    <summary><Calculator size={15} /><span>计划测算与复核</span><small>填写实际账户与价格</small><ChevronDown size={15} /></summary>
    <div className="trend-calc-content">
      <div className="trend-calc-tabs" role="group" aria-label={`${candidate.security.name}计划计算类型`}><button onClick={() => setTab("entry")} aria-pressed={tab === "entry"}>入场仓位</button><button onClick={() => setTab("exit")} aria-pressed={tab === "exit"}>持有 / 退出复核</button></div>
      <p className="trend-calc-description">冻结参考止损 S = <b>{number(plan.stop)}</b>{plan.minEntry !== undefined && <> · 最低入场 <b>{number(plan.minEntry)}</b></>} · 数据截止 {candidate.asOf}。测算不建立真实持仓，也不会自动下单或退出。</p>
      {tab === "entry" ? <>
        <div className="trend-form-grid">
          {field("nav", "账户净资产", "必填", "元")}{field("entry", "拟成交价 P", `≤ ${number(plan.maxEntry)}`, "元")}{field("cash", "可用现金", "实际可用", "元")}
          {field("industry", "已有同业仓位", "无持仓填 0", "%")}{field("portfolio", "已有总仓位", "无持仓填 0", "%")}{field("positions", "已有持仓数量", "无持仓填 0", "只")}
          {field("fees", "预留费用", "自行核对", "元")}{field("minimum", "该股最低买入数量", "核验后填写", "股")}{field("step", "该股申报递增单位", "核验后填写", "股")}
        </div>
        <div className="trend-checks">
          {check("session", "已确认本快照仍为上一交易日信号，拟于其下一交易日开盘窗口复核入场")}
          {check("permission", "已核实板块权限、交易状态和申报数量规则")}
          {check("announcement", "已复核最新公告与次日可成交性")}
          {check("aligned", "已确认价格、止损与除权除息口径一致")}
          {check("held", "当前账户已持有该股（本策略禁止重复加仓）")}
        </div>
        <div className="trend-calc-foot"><button className="trend-btn trend-btn-accent" onClick={() => setEntryRequested(true)}><Calculator size={14} />计算参考股数</button><span>0.5% 风险预算 · 单股 15% · 同业 25% · 总仓 60% · 最多 6 只</span></div>
        {sizing && <div className={`trend-calculation-result ${entryEligible ? "is-eligible" : ""}`} role="status">
          <strong>{entryEligible ? "满足当前输入下的计划约束" : "暂不生成可执行仓位"}</strong>
          {entryEligible && <div className="trend-sizing-values"><div><small>参考数量</small><b>{count(sizing.shares)} 股</b></div><div><small>买入金额</small><b>{number(sizing.cost)} 元</b></div><div><small>计划亏损 / 账户</small><b>{number(sizing.plannedLoss)} / {number(sizing.riskRatio * 100)}%</b></div><div><small>新增仓位</small><b>{number(sizing.positionRatio * 100)}%</b></div></div>}
          {!checks.session && <p>请确认这是信号的下一交易日开盘窗口；过期快照只能用于复核，不能沿用为新入场计划。</p>}
          {sizing.reasons.length > 0 && <ul>{sizing.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
          <small>冻结 S 不随普通价格波动调整，公司行为另行核验；成交价、费用、跳空和停牌会影响实际风险。申报前须再次核对当日信号。</small>
        </div>}
      </> : <>
        <div className="trend-form-grid">
          {field("days", "实际持有交易日", "买入日记为第 1 日", "日")}{field("close", "本日收盘", "同一价格口径", "元")}{field("ma20", "本日 MA20", "同一价格口径", "元")}
          {field("previousClose", "前一交易日收盘", "判断连续跌破时填写", "元")}{field("previousMa20", "前一交易日 MA20", "判断连续跌破时填写", "元")}
        </div>
        <div className="trend-checks">{check("exitAligned", "以上为持有期内的实际交易日数据，已核对价格、冻结止损与除权除息口径")}</div>
        <div className="trend-calc-foot"><button className="trend-btn trend-btn-accent" onClick={() => setExitRequested(true)}><ClipboardCheck size={14} />复核退出条件</button><span>按真实交易日计数，停牌与节假日不可按自然日估算。</span></div>
        {exit && <div className={`trend-calculation-result ${exit.action === "hold" ? "is-eligible" : ""}`} role="status"><strong>{exit.action === "exit-next-open" ? "规则触发：安排下一可交易日退出" : exit.action === "needs-data" ? "数据不足，暂不能判定" : "当前输入未触发退出条件"}</strong><ul>{exit.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><small>这里只复核填写的数据，不监控实际持仓，也不发送交易指令。</small></div>}
      </>}
    </div>
  </details>;
}

function CandidateCard({ candidate, isPreview, saved, onSave, onRemove, onOpen, marketGate, latestCandidate, latestAsOf, verificationAvailable = true, onDraftChange }: {
  candidate: TrendCandidate; isPreview: boolean; saved?: SavedTrendPlan; onSave?: (draft: TrendReviewDraft) => void; onRemove?: () => void; onDraftChange?: (draft: TrendReviewDraft) => void;
  onOpen: (security: Security) => void; marketGate: TrendScanStatus["marketGate"]; latestCandidate?: TrendCandidate; latestAsOf?: string; verificationAvailable?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<TrendReviewDraft>(() => ({ fields: saved?.reviewDraft?.fields || {}, checks: { held: Boolean(saved?.reviewDraft?.checks.held) } }));
  const changeDraft = (next: TrendReviewDraft) => { setDraft(next); onDraftChange?.(next); };
  const isSignal = candidate.stage === "signal" && Boolean(candidate.plan);
  const highlights = candidate.evidence.filter((item) => item.passed && !/时间窗|缩量$|市场门槛/.test(item.label)).slice(0, 3);
  const hasNewerScan = Boolean(latestAsOf && latestAsOf > candidate.asOf);
  const frozenStopBroken = Boolean(saved && latestCandidate && latestCandidate.asOf >= candidate.asOf && candidate.plan && latestCandidate.metrics.close < candidate.plan.stop);
  return <article className={`trend-candidate ${isSignal ? "is-signal" : "is-watch"}`} data-code={candidate.security.code} data-strategy-id={candidate.strategy?.id || "classic-v1"}>
    <div className="trend-candidate-top">
      <div className="trend-security"><div className="trend-security-name"><h3>{candidate.security.name}</h3><code>{candidate.security.code}</code>{isPreview && <span className="trend-demo-tag">DEMO</span>}</div><p>{boardNames[candidate.board] || candidate.board}{candidate.security.industry ? ` · ${candidate.security.industry}` : ""}<span>数据截止 {candidate.asOf}</span></p></div>
      <div className="trend-shape-tags"><span className="trend-strategy-badge">{strategyName(candidate.strategy)}</span>{isSignal && candidate.setup ? <span className="trend-shape-tag pattern-B"><TrendingUp size={13} />{candidate.setup.label}</span> : isSignal ? candidate.patterns.map((pattern) => <span className={`trend-shape-tag pattern-${pattern}`} key={pattern}>{pattern === "A" ? <ArrowDownRight size={13} /> : <TrendingUp size={13} />}{filterLabels[pattern]}</span>) : <span className="trend-shape-tag pattern-watch"><CircleHelp size={13} />趋势观察</span>}</div>
    </div>
    {saved && <div className={`trend-snapshot-notice ${frozenStopBroken ? "is-triggered" : ""}`}><BookmarkCheck size={14} /><div><strong>保存于 {dateTime(saved.savedAt)} · 历史快照 / 人工复核</strong><span>{frozenStopBroken ? `最新候选收盘 ${number(latestCandidate!.metrics.close)} 已低于冻结 S ${number(candidate.plan!.stop)}；若已持有，请核实价格口径并安排退出复核。` : hasNewerScan ? latestCandidate ? `已有 ${latestCandidate.asOf} 新快照；${latestCandidate.stage === "signal" ? "仍在信号候选中" : "已转为趋势观察"}，以下价格保留原保存值。` : "最新扫描中未找到该股。未入选不等于触发退出，请手动复核最新日线与持仓。" : !verificationAvailable ? "本次未验证：该策略未参与扫描、参数不同或扫描覆盖尚不完整；保存的计划保持原值。" : "暂无更新交易日的候选快照，不能据此判断当前是否仍可入场。"}</span></div></div>}
    <div className="trend-candidate-body">
      <div className="trend-candidate-research">
        <div className="trend-event"><span>最近收盘涨停</span><b>{candidate.limitDate}</b><small>距截止日 {candidate.daysSinceLimit} 个交易日</small></div>
        <div className="trend-reasons">{highlights.map((item, index) => <span key={`${item.label}-${index}`}><Check size={12} /><b>{item.label}</b><span>{item.value}</span></span>)}</div>
        <div className="trend-market-metrics"><div><small>收盘</small><strong>{number(candidate.metrics.close)}</strong></div><div><small>MA20 / MA60</small><strong>{number(candidate.metrics.ma20)} <i>/</i> {number(candidate.metrics.ma60)}</strong></div><div><small>距 MA20</small><strong>{number(candidate.metrics.deviationPercent, 1)}%</strong></div><div><small>20日平均成交额</small><strong>{number(candidate.metrics.avgAmount20 / 100000000, 2)} 亿</strong></div></div>
      </div>
      <div className={`trend-reference-plan ${candidate.plan ? "" : "is-pending"}`}>
        <span className="trend-kicker">{saved ? "冻结计划 · 保存时价格" : "次日参考 · 收盘后计算"}</span>
        {candidate.plan ? <><div className="trend-plan-prices"><div><small>止损参考 S</small><strong>{number(candidate.plan.stop)}</strong></div><ArrowRight size={17} /><div><small>最高入场 Pmax</small><strong>{number(candidate.plan.maxEntry)}</strong></div></div><p>{candidate.plan.minEntry !== undefined ? <>入场参考 <b>{number(candidate.plan.minEntry)} ≤ P ≤ {number(candidate.plan.maxEntry)}</b><br />跌回突破下限时取消入场</> : <>仅在 <b>S &lt; 实际 P ≤ Pmax</b> 时复核入场</>}</p><span className="trend-risk-caption">Pmax 下计划价差风险 {number(candidate.plan.maxRiskPercent)}%<br />需另计费用；实际风险受跳空与成交影响</span></> : <><strong>{candidate.setup ? `等待${candidate.setup.label}确认` : "等待完整 A / B 信号"}</strong><p>趋势入选不代表可以买入。市场门槛、形态或价格风险仍有条件待满足。</p><span className="trend-risk-caption">暂不生成 S / Pmax 入场区间</span></>}
      </div>
    </div>
    {candidate.technical && <div className="trend-quality-metrics">{Object.entries(candidate.technical.indicators).map(([key, value]) => <span key={key}>{key} <b>{number(value)}</b></span>)}</div>}
    {candidate.quality && <div className="trend-quality-metrics"><span>昨日 ATR <b>{number(candidate.quality.atr14Previous)}</b></span><span>均线偏离 <b>{number(candidate.quality.extensionAtr)} ATR</b></span><span>收盘位置 <b>{number(candidate.quality.closeLocation * 100, 0)}%</b></span><span>五日量比 <b>{number(candidate.quality.volumeRatio)}</b></span><span>止损引用 <b>{candidate.primaryPattern || "待确认"}</b></span></div>}
    <div className="trend-candidate-actions"><button className="trend-text-button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded} aria-label={`${candidate.security.name}规则依据`}><ListFilter size={14} />规则依据 <span>{candidate.evidence.length}</span><ChevronDown size={14} className={expanded ? "trend-rotate" : ""} /></button><span className="trend-limit-note">{candidate.limitEvidence === "calculated" ? "涨停价待官方核验" : "涨停价已按官方数据核验"}</span><div><button className="trend-btn trend-btn-small" onClick={() => onOpen(candidate.security)} disabled={isPreview} title={isPreview ? "虚构演示证券无法打开真实分析" : undefined}>个股分析<ChevronRight size={13} /></button>{onRemove ? <button className="trend-btn trend-btn-small" onClick={onRemove} aria-label={`移除${candidate.security.name}的计划`}><Trash2 size={13} />移除</button> : <button className={`trend-btn trend-btn-small ${saved ? "is-saved" : "trend-btn-accent"}`} onClick={() => onSave?.(draft)} disabled={Boolean(saved) || !onSave}>{saved ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}{saved ? "已保存快照" : "加入我的计划"}</button>}</div></div>
    {expanded && <div className="trend-evidence"><div className="trend-evidence-grid">{candidate.evidence.map((item, index) => <div key={`${item.label}-${index}`} className={item.passed ? "" : "trend-evidence-pending"}><b>{item.passed ? "✓" : "·"} {item.label}</b><span>{item.value}</span><small>{item.rule}</small></div>)}</div>{candidate.warnings.length > 0 && <p><AlertTriangle size={14} />{candidate.warnings.join("；")}</p>}</div>}
    {candidate.plan && <PlanCalculator candidate={candidate} marketGate={hasNewerScan || (saved && (!verificationAvailable || !latestCandidate || latestCandidate.stage !== "signal" || JSON.stringify(latestCandidate.plan) !== JSON.stringify(candidate.plan))) ? "unknown" : marketGate} draft={draft} onDraftChange={changeDraft} />}
  </article>;
}

function CandidateRow({ candidate, isPreview, saved, visible, children }: {
  candidate: TrendCandidate; isPreview: boolean; saved?: boolean; visible: boolean; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const [hasOpened, setHasOpened] = useState(false);
  return <>
    <tr className="trend-result-row" hidden={!visible}>
      <th scope="row"><b>{candidate.security.name}</b><small>{candidate.security.code}{isPreview ? " · DEMO" : ""}{saved ? " · 已保存" : ""}</small></th>
      <td>{strategyName(candidate.strategy)}</td>
      <td>{candidate.stage === "signal" ? candidate.setup?.label || candidate.patterns.map(pattern => filterLabels[pattern]).join(" / ") || "有效信号" : "趋势观察"}</td>
      <td>{candidate.asOf}</td>
      <td className="trend-numeric">{number(candidate.metrics.close)}</td>
      <td className="trend-numeric">{candidate.plan ? number(candidate.plan.stop) : "—"}</td>
      <td className="trend-numeric">{candidate.plan ? number(candidate.plan.maxEntry) : "—"}</td>
      <td><button className="trend-text-button" aria-expanded={expanded} aria-controls={detailId} aria-label={`${expanded ? "收起" : "详情与计划"}：${candidate.security.name}`} onClick={() => { setHasOpened(true); setExpanded(current => !current); }}>{expanded ? "收起" : "详情 / 计划"}<ChevronDown size={14} className={expanded ? "trend-rotate" : ""} /></button></td>
    </tr>
    <tr id={detailId} className="trend-result-details" hidden={!visible || !expanded}><td colSpan={8}>{hasOpened ? children : null}</td></tr>
  </>;
}

export default function TrendScreenerView({ onOpen }: { onOpen: (security: Security) => void }) {
  const [status, setStatus] = useState<TrendScanStatus | null>(null);
  const [scanMode, setScanMode] = useState<"single" | "multi">("multi");
  const [selectedStrategies, setSelectedStrategies] = useState<TrendStrategyId[]>(TREND_STRATEGY_CHOICES.filter(item => item.id !== "classic-v1").map(item => item.id));
  const [strategyFilter, setStrategyFilter] = useState<"all" | TrendStrategyId>("all");
  const [strategyId, setStrategyId] = useState<TrendStrategyId>("quality-v2");
  const [qualityDraft, setQualityDraft] = useState(() => Object.fromEntries(Object.entries(TREND_QUALITY_PRESETS.robust).map(([key, value]) => [key, String(value)])));
  const [forceRefresh, setForceRefresh] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [tab, setTab] = useState<"candidates" | "plans">("candidates");
  const [query, setQuery] = useState("");
  const [showExample, setShowExample] = useState(false);
  const [showPrinciple, setShowPrinciple] = useState(false);
  const [exampleDraft, setExampleDraft] = useState<TrendReviewDraft>({ fields: { nav: "100000", entry: "10", cash: "100000", industry: "0", portfolio: "0", positions: "0", fees: "0", minimum: "100", step: "100" }, checks: {} });
  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState("");
  const [storage, setStorage] = useState(() => {
    try { return readTrendPlans(window.localStorage); }
    catch { return { plans: [] as SavedTrendPlan[], error: "无法读取本地计划，请检查存储权限。" }; }
  });
  const [saveNotice, setSaveNotice] = useState("");
  const mounted = useRef(false);
  const requestId = useRef(0);
  const pollPending = useRef(false);
  const actionPending = useRef(false);

  const readStatus = useCallback(async () => {
    if (actionPending.current) return;
    const id = ++requestId.current;
    try {
      const next = await window.stockApi.getTrendScan();
      if (mounted.current && id === requestId.current) { setStatus(next); setError(""); }
    } catch (reason) {
      if (mounted.current && id === requestId.current) setError(`读取扫描状态失败：${errorText(reason)}`);
    }
  }, []);
  useEffect(() => { mounted.current = true; void readStatus(); return () => { mounted.current = false; requestId.current += 1; }; }, [readStatus]);
  useEffect(() => {
    if (!running(status?.phase)) return;
    const timer = window.setInterval(() => {
      if (pollPending.current) return;
      pollPending.current = true;
      void readStatus().finally(() => { pollPending.current = false; });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [readStatus, status?.phase]);
  const invoke = async (kind: Exclude<Action, null>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    const id = ++requestId.current;
    setAction(kind); setError("");
    try {
      const config = Object.fromEntries(TREND_CONFIG_FIELDS.map(({ key }) => [key, inputNumber(qualityDraft[key] || "")])) as unknown as TrendQualityConfig;
      const selected = scanMode === "multi" ? selectedStrategies : [strategyId];
      if (kind === "start" && !selected.length) throw new Error("请至少选择一个扫描策略");
      if (kind === "start" && selected.includes("quality-v2") && !validQualityConfig(config)) throw new Error("请在显示范围内填写三个有效参数");
      const selections: TrendStrategySelection[] = selected.map(id => ({ strategyId: id, ...(id === "quality-v2" ? { config: { ...config } } : {}) }));
      const next = kind === "start" ? await window.stockApi.startTrendScan(scanMode === "multi" ? { strategies: selections, forceRefresh } : { ...selections[0], forceRefresh }) : await window.stockApi.cancelTrendScan();
      if (mounted.current && id === requestId.current) setStatus(next);
    } catch (reason) {
      if (mounted.current && id === requestId.current) setError(`${kind === "start" ? "启动" : "取消"}扫描失败：${errorText(reason)}`);
    } finally {
      actionPending.current = false;
      if (mounted.current && id === requestId.current) setAction(null);
    }
  };
  const updatePlans = (plans: SavedTrendPlan[], message: string) => {
    if (storage.error) { setSaveNotice(storage.error); return; }
    try {
      if (!writeTrendPlans(window.localStorage, plans)) { setSaveNotice("计划保存失败：本地存储不可写或空间不足，当前记录未更改。"); return; }
      setStorage({ plans, error: "" }); setSaveNotice(message);
    } catch { setSaveNotice("本地存储不可用，当前记录未更改。"); }
  };
  const saveCandidate = (candidate: TrendCandidate, reviewDraft: TrendReviewDraft) => {
    if (!status) return;
    const snapshot = { ...createSavedTrendPlan(candidate, status), reviewDraft };
    if (storage.plans.some((plan) => plan.id === snapshot.id)) return;
    updatePlans([snapshot, ...storage.plans], `已保存 ${candidate.security.name} 的 ${candidate.asOf} 快照，可在“我的计划”复核。`);
  };

  const updateDraft = (id: string, reviewDraft: TrendReviewDraft) => {
    if (storage.error) return;
    const plans = storage.plans.map((plan) => plan.id === id ? { ...plan, reviewDraft } : plan);
    try {
      if (writeTrendPlans(window.localStorage, plans)) setStorage({ plans, error: "" });
      else setSaveNotice("复核输入未保存：本地存储不可写或空间不足。请导出并检查存储权限。");
    } catch { setSaveNotice("复核输入未保存：本地存储不可用。"); }
  };
  const candidates = status?.candidates || [];
  const searchText = query.trim().toLocaleLowerCase();
  const matchesQuery = (candidate: TrendCandidate) => `${candidate.security.code} ${candidate.security.name}`.toLocaleLowerCase().includes(searchText);
  const matchesStrategy = (candidate: TrendCandidate) => strategyFilter === "all" || (candidate.strategy?.id || "classic-v1") === strategyFilter;
  const filtered = useMemo(() => candidates.filter((candidate) => {
    const matchesFilter = filter === "watch" ? candidate.stage === "watch" : filter === "signal" ? candidate.stage === "signal" : filter === "A" || filter === "B" ? candidate.stage === "signal" && candidate.patterns.includes(filter) : true;
    return matchesFilter && matchesStrategy(candidate) && `${candidate.security.code} ${candidate.security.name}`.toLocaleLowerCase().includes(searchText);
  }), [candidates, filter, searchText, strategyFilter]);
  const plansFiltered = storage.plans.filter((plan) => matchesQuery(plan.candidate) && matchesStrategy(plan.candidate));
  const strategyCandidates = candidates.filter(matchesStrategy);
  const totals: Record<Filter, number> = { all: strategyCandidates.length, signal: strategyCandidates.filter(candidate => candidate.stage === "signal").length, watch: strategyCandidates.filter((candidate) => candidate.stage === "watch").length, A: strategyCandidates.filter((candidate) => candidate.stage === "signal" && candidate.patterns.includes("A")).length, B: strategyCandidates.filter((candidate) => candidate.stage === "signal" && candidate.patterns.includes("B")).length };
  const phase = status?.phase || "idle";
  const active = running(phase);
  const complete = status?.coverageComplete === true && phase === "completed";
  const coverageText = complete ? "全市场覆盖完整" : status && phase !== "idle" ? "覆盖未完成 / 待核验" : "等待首次扫描";
  const phaseText: Record<TrendScanStatus["phase"], string> = { idle: "尚未扫描", "loading-universe": "载入全市场名单", scanning: "分析历史日线", completed: "扫描结束", cancelled: "扫描已取消", failed: "扫描失败" };
  const progress = status?.universeLoaded ? Math.min(100, status.processed / status.universeLoaded * 100) : 0;
  const marketGate = status?.marketGate || "unknown";
  const gateTitle = marketGate === "blocked" ? "暂停新开仓" : marketGate === "open" ? "市场门槛通过" : "市场门槛待确认";
  const gateText = marketGate === "blocked" ? "中证全指收盘低于 MA60，保留观察，暂停新开仓计划。" : marketGate === "open" ? "中证全指收盘不低于 MA60。仍需复核个股信号与次日交易状态。" : "缺少可验证的指数数据，暂不能形成开仓结论。";
  const visibleCount = tab === "candidates" ? filtered.length : plansFiltered.length;
  const visibleCandidates = new Set(filtered);
  const visiblePlans = new Set(plansFiltered);
  const exportCsv = () => {
    const rows = tab === "plans" ? plansFiltered : filtered.map((candidate) => ({ candidate, isPreview: Boolean(status?.isPreview), coverageComplete: complete, marketGate }));
    if (!rows.length) return;
    try {
      const url = URL.createObjectURL(new Blob([trendCandidatesCsv(rows)], { type: "text/csv;charset=utf-8;" }));
      const link = document.createElement("a");
      link.href = url; link.download = `涨停趋势-${tab === "plans" ? "我的计划" : "候选"}-${status?.asOf || "未扫描"}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSaveNotice(`已导出 ${rows.length} 条${tab === "plans" ? "计划快照" : "筛选候选"}，CSV 内保留数据日期与演示标识。`);
    } catch (reason) { setSaveNotice(`导出失败：${errorText(reason)}`); }
  };

  return <div className="trend-screener page">
    <header className="trend-header"><div><h1>趋势筛选</h1></div><div className="trend-header-actions"><button className="trend-btn" onClick={() => setShowPrinciple(current => !current)} aria-expanded={showPrinciple} aria-controls="trend-principle"><CircleHelp size={15} />筛选原理</button><button className="trend-btn" onClick={() => setShowExample((current) => !current)} aria-expanded={showExample}><Calculator size={15} />方案算例</button><button className="trend-btn" onClick={() => void readStatus()} disabled={Boolean(action)} aria-label="刷新扫描状态"><RefreshCw size={15} />刷新状态</button>{active ? <button className="trend-btn" onClick={() => void invoke("cancel")} disabled={Boolean(action)}><Square size={14} />{action === "cancel" ? "取消中…" : "取消扫描"}</button> : <button className="trend-btn trend-btn-accent" onClick={() => void invoke("start")} disabled={Boolean(action)}><Play size={14} />{action === "start" ? "启动中…" : "扫描全 A 股"}</button>}</div></header>
    <details className="research-disclosure trend-scan-configuration"><summary><span>扫描配置</span><small>{scanMode === "multi" ? `多策略 · 已选 ${selectedStrategies.length} 项` : "单策略扫描"} · 策略库 / 质量参数 / 规则来源</small></summary>
      <TrendStrategyPanel mode={scanMode} onMode={setScanMode} strategyId={strategyId} onStrategy={setStrategyId} selected={selectedStrategies} onSelected={setSelectedStrategies} qualityDraft={qualityDraft} onQuality={setQualityDraft} forceRefresh={forceRefresh} onRefresh={setForceRefresh} disabled={active || Boolean(action)} status={status} />
    </details>
    {status?.isPreview && <div className="trend-notice"><AlertTriangle size={16} /><div><strong>DEMO / 演示工作台 · 全部证券均为虚构</strong><span>以下行情、市场门槛与覆盖数仅供操作演示，不能用于真实交易；演示快照和导出会保留 DEMO 标识。</span></div></div>}
    {error && <div className="trend-error" role="alert"><AlertTriangle size={16} />{error}<button onClick={() => void readStatus()}>重试</button></div>}

    {showPrinciple && <section id="trend-principle" className="trend-rule-note" aria-label="策略与执行纪律"><div className="trend-rule-heading"><h2>筛选原理与执行规则</h2><button className="trend-btn trend-btn-small" onClick={() => setShowPrinciple(false)}>收起</button></div><p className="trend-principle-intro">用一次涨停寻找资金关注，再用均线确认趋势仍在，最后等待回踩转强、放量突破或指标共振。扫描依次核对真实日线、近 15 日涨停、上涨趋势、所选形态和止损距离；只通过趋势的放入观察，形态与风险同时通过才生成计划。近期涨停本身不是买入理由。</p><div className="trend-rule-grid"><article><span>01 / 入场</span><h3>等形态，不追高</h3><p>最近 15 个交易日收盘涨停；收盘 &gt; MA20 &gt; MA60，MA20 上升，20 日均额 ≥ 2 亿元。A 回踩转强或 B 平台突破确认后，按 S &lt; P ≤ min(1.03C, S/0.92) 复核。</p></article><article><span>02 / 仓位</span><h3>先算能亏多少</h3><p>单笔计划亏损 ≤ 净资产 0.5%；单股 ≤ 15%、同业 ≤ 25%、总仓 ≤ 60%，最多 6 只。按实际成交价、费用和板块申报数量规则向下取可买数量；不加杠杆、不重复加仓。</p></article><article><span>03 / 退出</span><h3>止损冻结，逐日检查</h3><p>收盘跌破冻结 S，或持有后连续两日收盘低于 MA20，安排下一可交易日退出。买入日为第 1 日，第 29 日收盘安排第 30 日开盘退出；停牌、跳空可能扩大损失。</p></article></div><p className="trend-strategy-explainer">质量 v2 在上述原版规则之上追加质量约束，且使用卡片内冻结的最低入场价与收紧后的 Pmax。A / B 同时命中时，按 A 的止损与突破位复核；质量条件未通过时只保留观察。各指标策略独立判断各自的技术触发，不要求先出现 A / B；共同价格区间以卡片显示为准。</p><div className="trend-playbook-foot"><CircleHelp size={14} />涨停价可能按板块规则推算。保存计划后仍须核验官方限价、最新公告、复权口径和次日可成交性。</div></section>}
    <div className="research-command-bar" aria-label="研究状态摘要"><strong>{gateTitle}</strong><span>{phaseText[phase]} · {status ? count(status.processed) : "—"} / {status?.universeLoaded ? count(status.universeLoaded) : "待载入"}</span><span>{coverageText}</span><span>数据截止 {status?.asOf || "尚未取得数据"}</span>{Boolean(status?.failed) && <span>请求失败 {status!.failed}</span>}</div>
    <div className="trend-terminal-layout">
      <div className="trend-primary-column">
    {showExample && <section className="trend-example" aria-label="虚构方案算例"><div><span className="trend-demo-tag">DEMO / 虚构算例</span><h2>10 万元账户，如何落实这套纪律？</h2><p>这不是股票或选股结果。仅用虚构 P = 10、S = 9.50 演示公式，100 股的最低数量与递增单位也是假定值。市场门槛在算例中假定通过；实际使用须逐项核实。</p></div><PlanCalculator candidate={exampleCandidate} marketGate="open" draft={exampleDraft} onDraftChange={setExampleDraft} defaultOpen /></section>}
    <section className="trend-workbench" aria-label="研究候选与我的计划"><div className="trend-workbench-head"><div className="trend-main-tabs" role="group" aria-label="工作台视图"><button className={tab === "candidates" ? "active" : ""} aria-pressed={tab === "candidates"} onClick={() => setTab("candidates")}><Target size={17} />研究候选<span>{candidates.length}</span></button><button className={tab === "plans" ? "active" : ""} aria-pressed={tab === "plans"} onClick={() => setTab("plans")}><Bookmark size={16} />我的计划<span>{storage.plans.length}</span></button></div><button className="trend-btn trend-btn-small" onClick={exportCsv} disabled={!visibleCount}><Download size={14} />导出{tab === "plans" ? "计划" : "当前结果"} CSV</button></div>
      {saveNotice && <div className="trend-save-notice" role="status">{saveNotice}<button aria-label="关闭提示" onClick={() => setSaveNotice("")}><X size={13} /></button></div>}
      {storage.error && <div className="trend-error" role="alert">{storage.error}</div>}
      <div className="trend-results-toolbar"><label className="trend-strategy-select trend-result-strategy"><span>结果策略</span><select aria-label="结果策略" value={strategyFilter} onChange={e => setStrategyFilter(e.target.value as "all" | TrendStrategyId)}><option value="all">全部策略</option>{TREND_STRATEGY_CHOICES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{tab === "candidates" ? <div className="trend-filters" role="group" aria-label="筛选形态">{(["all", "signal", "A", "B", "watch"] as const).map((key) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)} aria-pressed={filter === key}>{filterLabels[key]}<b>{totals[key]}</b></button>)}</div> : <p className="trend-plan-intro">保存在本机的研究快照，<b>不等于实际持仓</b>。价格冻结；数字输入与已持有标记保存在本机，重新打开后须重做核验勾选。CSV 导出候选快照。</p>}<label className="trend-search"><Search size={15} /><input aria-label="搜索代码或名称" placeholder="搜索代码 / 名称" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button onClick={() => setQuery("")} aria-label="清空候选搜索"><X size={13} /></button>}</label></div>
      <div className="trend-results-context"><span>{tab === "candidates" ? `${filterLabels[filter]} · ${filtered.length} 条结果 / ${new Set(filtered.map(item => item.security.secid)).size} 只股票` : `已保存快照 · ${plansFiltered.length} 条`}</span><p>{tab === "plans" ? "先复核最新信号，再检查冻结止损与退出条件。" : phase === "idle" ? "启动扫描后显示真实筛选结果。" : !complete ? "当前覆盖不完整；无候选不代表全市场没有机会。" : "同股可命中多个策略；候选条数与去重股票数分别统计。"}</p></div>
      <div className="trend-candidate-list"><div className="trend-result-scroll" tabIndex={0} role="region" aria-label="研究结果表格"><table className="trend-result-table"><thead><tr><th scope="col">股票 / 代码</th><th scope="col">策略</th><th scope="col">信号 / 形态</th><th scope="col">数据截止</th><th scope="col">收盘</th><th scope="col">止损 S</th><th scope="col">最高入场 Pmax</th><th scope="col">操作</th></tr></thead><tbody>{candidates.map((candidate) => {
        const saved = storage.plans.find((plan) => plan.id === trendPlanId(candidate, Boolean(status?.isPreview)));
        const review = saved ? reviewSavedTrendPlan(saved, status) : { latestCandidate: candidate, ...(status?.asOf ? { latestAsOf: status.asOf } : {}), marketGate };
        return <CandidateRow key={`candidate-${trendPlanId(candidate, Boolean(status?.isPreview))}`} candidate={saved?.candidate || candidate} isPreview={Boolean(status?.isPreview)} saved={Boolean(saved)} visible={tab === "candidates" && visibleCandidates.has(candidate)}><CandidateCard candidate={saved?.candidate || candidate} {...review} isPreview={Boolean(status?.isPreview)} {...(saved ? { saved, onDraftChange: (draft: TrendReviewDraft) => updateDraft(saved.id, draft) } : {})} {...(!storage.error ? { onSave: (draft: TrendReviewDraft) => saveCandidate(candidate, draft) } : {})} onOpen={onOpen} /></CandidateRow>;
      })}{storage.plans.map((plan) => {
        return <CandidateRow key={`plan-${plan.id}`} candidate={plan.candidate} isPreview={plan.isPreview} saved visible={tab === "plans" && visiblePlans.has(plan)}><CandidateCard candidate={plan.candidate} isPreview={plan.isPreview} saved={plan} onDraftChange={(draft) => updateDraft(plan.id, draft)} onRemove={() => updatePlans(storage.plans.filter((item) => item.id !== plan.id), `已移除 ${plan.candidate.security.name} 的计划快照。`)} onOpen={onOpen} {...reviewSavedTrendPlan(plan, status)} /></CandidateRow>;
      })}</tbody></table></div>{visibleCount === 0 && <div className="trend-empty"><div>{tab === "plans" ? <Bookmark size={27} /> : <TrendingUp size={27} />}</div><strong>{query ? "未找到匹配的代码或名称" : tab === "plans" ? "把值得跟踪的候选，留成下一步计划" : active ? "正在逐只检验趋势与涨停形态" : filter !== "all" ? "当前没有这一类形态" : phase === "idle" ? "从一次全 A 股扫描开始" : "目前没有可展示的研究候选"}</strong><p>{query ? "试试完整证券代码、名称片段，或清空搜索。" : tab === "plans" ? "在候选卡片点击“加入我的计划”，保存截止日、规则依据和参考价。" : active ? "候选会随扫描更新。请先关注市场门槛和板块覆盖。" : !complete ? "先完成扫描并查看失败明细；缺失数据不会被当作未命中。" : "当前规则下没有候选，等待新的收盘信号或切换形态。"}</p>{query ? <button className="trend-btn" onClick={() => setQuery("")}>清空搜索</button> : tab === "plans" ? <button className="trend-btn" onClick={() => setTab("candidates")}>去研究候选<ArrowRight size={14} /></button> : !active && <button className="trend-btn" onClick={() => void invoke("start")} disabled={Boolean(action)}><Play size={14} />扫描全 A 股</button>}</div>}</div>
    </section>

      </div>
      <details className="research-disclosure trend-audit-disclosure"><summary><span>市场门槛与扫描详情</span><small>{gateTitle} · {coverageText}</small></summary><aside className="trend-support-column">
      <TrendScanDiagnostics status={status} />
      <section className={`trend-gate is-${marketGate}`} aria-label="市场开仓门槛"><div className="trend-gate-icon"><ShieldCheck size={25} /></div><h2>{gateTitle}</h2><p>{gateText}</p><div><span>共同市场代理</span><b>中证全指 / MA60</b></div><small>截至 {status?.asOf || "尚未取得数据"} · 北交所仍需单独复核</small></section>
      <section className="trend-status-card" aria-label="扫描状态"><div className="trend-status-head"><div><h2>{active ? <LoaderCircle size={17} className="trend-spin" /> : <Layers3 size={17} />}{phaseText[phase]}</h2></div><span className={`trend-status-badge ${complete ? "is-complete" : ""}`}>{coverageText}</span></div><div className="trend-scan-numbers"><strong>{status && phase !== "idle" ? count(status.processed) : "—"}<small> / {status?.universeLoaded ? count(status.universeLoaded) : "待载入"}</small></strong><span>已处理证券 / 已载入名单</span><b>{active ? `${number(progress, 0)}%` : status?.asOf ? `数据截止 ${status.asOf}` : "手动启动扫描"}</b></div><div className="trend-progress" role="progressbar" aria-label="已载入名单处理进度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div><div className="trend-health-counts"><span>源端总数 <b>{status?.universeExpected == null ? "未知" : count(status.universeExpected)}</b></span><span>规则排除 <b>{status ? count(status.excluded) : "—"}</b></span><span>数据不可用 <b>{status ? count(status.unavailable) : "—"}</b></span><span>请求失败 <b>{status ? count(status.failed) : "—"}</b></span></div>{status?.performance && <div className="trend-performance"><span>原始 / 复权请求 <b>{status.performance.rawRequests} / {status.performance.adjustedRequests}</b></span><span>缓存命中 <b>{status.performance.cacheHits}</b></span><span>预筛排除 <b>{status.performance.prefilterExcluded}</b></span><span>扫描耗时 <b>{number(status.performance.elapsedMs / 1000, 1)} 秒</b></span></div>}<details className="trend-coverage-details"><summary>板块覆盖与扫描详情<ChevronDown size={14} /></summary><p>{status?.note || "点击“扫描全 A 股”载入名单与历史日线；首次扫描可能需要较长时间。"}</p><div className="trend-board-list">{status?.boards.length ? status.boards.map((board) => <div key={board.id} className="trend-board"><b>{board.label || boardNames[board.id] || board.id}</b><span>{count(board.loaded)} / {board.expected == null ? "未知" : count(board.expected)}</span><em className={board.complete ? "is-complete" : ""}>{board.complete ? "完整" : "部分"}</em>{board.error && <small>{board.error}</small>}</div>) : <p>尚无板块覆盖信息。</p>}</div><div className="trend-status-meta"><span>任务更新 {dateTime(status?.updatedAt)}</span><span>任务编号 {status?.jobId || "—"}</span><span>{status?.isPreview ? "数据性质：DEMO 虚构演示" : "数据由独立扫描服务返回；以失败明细与覆盖情况核验可用性。"}</span></div></details>{status && (status.errors.length > 0 || status.failed > 0) && <details className="trend-failures"><summary><AlertTriangle size={13} />扫描问题与失败明细（{status.errors.length} 条）</summary><ul>{status.errors.map((item, index) => <li key={`${item.stage}-${item.code || index}`}><b>{item.stage}{item.code ? ` · ${item.code}` : ""}</b> {item.message}</li>)}</ul></details>}</section>

      </aside></details>
    </div>
  </div>;
}
