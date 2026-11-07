import { SelectionKline } from "./features/strategy-selection/SelectionKline";
import { AlertTriangle, ArrowDownRight, ArrowRight, Bookmark, BookmarkCheck, Calculator, Check, ChevronDown, ChevronRight, CircleHelp, ClipboardCheck, Download, Layers3, ListFilter, LoaderCircle, Play, RefreshCw, Search, ShieldCheck, Square, Target, Trash2, TrendingUp, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { TrendCandidate, TrendScanStatus, TrendStrategyId, TrendQualityConfig, TrendStrategySelection, TrendExecutionCheck } from "./trendScreenerTypes";
import { indexTrendCandidates, createSavedTrendPlan, readTrendPlans, reviewSavedTrendPlan, trendCandidatesCsv, trendPlanId, writeTrendPlans, type SavedTrendPlan, type TrendReviewDraft, appendTrendScanJournal, readTrendScanJournal, trendScanJournalCsv } from "./trendWorkspace";
import { calculateTrendPosition, evaluateTrendExit } from "./trendPlan";
import { TREND_CONFIG_FIELDS, TREND_STRATEGY_CHOICES, strategyName, validQualityConfig, qualityPresetName } from "./trendStrategyConfig";
import { currentTrendExecution, requestTrendExecution, trendBoardQuantity, TREND_EXECUTION_TTL_MS } from "./trendExecution";
import { whenVisible } from "./visiblePolling";
import TrendStrategyPanel from "./TrendStrategyPanel";
import TrendScanDiagnostics from "./TrendScanDiagnostics";
import TrendResearchTools from "./TrendResearchTools";
import { readTrendViewPreferences, saveTrendViewPreferences, type TrendViewPreferences } from "./trendViewPreferences";

type Filter = "all" | "signal" | "A" | "B" | "watch";
type Action = "start" | "cancel" | null;
type ScanFailure = { message: string; action: "status" | Exclude<Action, null> };
const RESULT_PAGE_SIZE = 50;
const EMPTY_CANDIDATES: TrendCandidate[] = [];
type RowWorkspace = {
  expanded: boolean; evidenceExpanded: boolean; calculatorOpen: boolean;
  calculatorTab: "entry" | "exit"; entryRequested: boolean; exitRequested: boolean;
  draft: TrendReviewDraft; executionCheck: TrendExecutionCheck | null;
};
type RowWorkspaceChange = (patch: Partial<RowWorkspace>) => void;
const initialRowWorkspace = (saved?: SavedTrendPlan): RowWorkspace => ({
  expanded: false, evidenceExpanded: false, calculatorOpen: false, calculatorTab: "entry", entryRequested: false, exitRequested: false, executionCheck: null,
  draft: { fields: saved ? saved.reviewDraft?.fields || {} : { commission: "0.03", minimumCommission: "5", tax: "0.05", slippage: "0.1", gap: "3", portfolioRiskCap: "3", participation: "1" }, checks: { held: Boolean(saved?.reviewDraft?.checks.held) } }
});
const boardNames: Record<string, string> = { main: "沪深主板", growth: "创业板", star: "科创板", beijing: "北交所" };
const running = (phase?: TrendScanStatus["phase"]) => phase === "loading-universe" || phase === "scanning";
const number = (value: number, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "—";
const count = (value: number) => Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
const inputNumber = (value: string) => value.trim() ? Number(value) : Number.NaN;
const dateTime = (value?: string) => {
  if (!value) return "未记录";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
};
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const filterLabels: Record<Filter, string> = { all: "全部候选", signal: "有效信号", A: "A 回踩转强", B: "B 平台突破", watch: "趋势观察" };

const exampleCandidate: TrendCandidate = {
  security: { code: "EXAMPLE", name: "虚构方案算例", secid: "example.plan" }, board: "main",
  asOf: "虚构信号日", limitDate: "虚构涨停日", daysSinceLimit: 5, patterns: ["A"], stage: "signal", limitEvidence: "calculated",
  metrics: { close: 10, ma20: 9.7, ma60: 9, avgAmount20: 200000000, deviationPercent: 3.09, relativeStrength20: null, atr14: 0.2 },
  plan: { stop: 9.5, maxEntry: 10.3, maxRiskPercent: 7.77, holdingDays: "10–30 个交易日" }, evidence: [], warnings: ["虚构公式算例，不是真实证券"]
};

function PlanCalculator({ candidate, marketGate, draft, onDraftChange, synthetic = false, defaultOpen = false, workspace, onWorkspaceChange }: { workspace?: RowWorkspace; onWorkspaceChange?: RowWorkspaceChange; candidate: TrendCandidate; marketGate: TrendScanStatus["marketGate"]; draft: TrendReviewDraft; onDraftChange: (draft: TrendReviewDraft) => void; synthetic?: boolean; defaultOpen?: boolean }) {
  const [localTab, setLocalTab] = useState<"entry" | "exit">("entry");
  const [localEntryRequested, setLocalEntryRequested] = useState(false);
  const [localExitRequested, setLocalExitRequested] = useState(false);
  const tab = workspace?.calculatorTab ?? localTab;
  const entryRequested = workspace?.entryRequested ?? localEntryRequested;
  const exitRequested = workspace?.exitRequested ?? localExitRequested;
  const setTab = (value: "entry" | "exit") => onWorkspaceChange ? onWorkspaceChange({ calculatorTab: value }) : setLocalTab(value);
  const setEntryRequested = (value: boolean) => onWorkspaceChange ? onWorkspaceChange({ entryRequested: value }) : setLocalEntryRequested(value);
  const setExitRequested = (value: boolean) => onWorkspaceChange ? onWorkspaceChange({ exitRequested: value }) : setLocalExitRequested(value);
  const { fields, checks } = draft;
  const [localExecutionCheck, setLocalExecutionCheck] = useState<TrendExecutionCheck | null>(null);
  const executionCheck = workspace ? workspace.executionCheck : localExecutionCheck;
  const setExecutionCheck = (value: TrendExecutionCheck | null) => onWorkspaceChange ? onWorkspaceChange({ executionCheck: value }) : setLocalExecutionCheck(value);
  const [checking, setChecking] = useState(false);
  const [, setClockRevision] = useState(0);
  const executionRevision = useRef(0);
  const executionMounted = useRef(false);
  const executionPending = useRef(false);
  useEffect(() => {
    executionMounted.current = true;
    executionRevision.current += 1;
    executionPending.current = false;
    setLocalExecutionCheck(null); setChecking(false); setLocalEntryRequested(false);
    return () => { executionMounted.current = false; executionRevision.current += 1; };
  }, [candidate.security.secid, candidate.asOf, candidate.strategy?.configHash]);
  useEffect(() => {
    if (!executionCheck) return;
    const refreshClock = () => setClockRevision(current => current + 1);
    const deadline = Math.min(Date.parse(executionCheck.checkedAt) + TREND_EXECUTION_TTL_MS,
      executionCheck.quoteAt ? Date.parse(executionCheck.quoteAt) + TREND_EXECUTION_TTL_MS : Infinity,
      Date.parse(`${executionCheck.executionDate}T09:35:00+08:00`),
      executionCheck.validUntil ? Date.parse(executionCheck.validUntil) : Infinity);
    const timer = window.setTimeout(refreshClock, Math.max(0, deadline - Date.now()) + 1);
    document.addEventListener("visibilitychange", refreshClock);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", refreshClock); };
  }, [executionCheck]);
  const refreshExecution = async () => {
    if (synthetic || executionPending.current) return;
    const revision = ++executionRevision.current;
    executionPending.current = true; setChecking(true); setExecutionCheck(null);
    const next = await requestTrendExecution(window.stockApi, { security: candidate.security, signalDate: candidate.asOf });
    if (executionMounted.current && executionRevision.current === revision) {
      setExecutionCheck(next); setChecking(false); executionPending.current = false;
    }
  };
  const readiness = currentTrendExecution(executionCheck, candidate.asOf);
  const boardQuantity = trendBoardQuantity(candidate.board);

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
    minimumBuyQuantity: synthetic ? value("minimum") : executionCheck?.minimumBuyQuantity || boardQuantity.minimumBuyQuantity,
    quantityStep: synthetic ? value("step") : executionCheck?.quantityStep || boardQuantity.quantityStep,
    ...(!synthetic ? { commissionRate: value("commission") / 100, minimumCommission: value("minimumCommission"),
      sellTaxRate: value("tax") / 100, slippageRate: value("slippage") / 100, gapStressRatio: value("gap") / 100,
      portfolioRiskUsed: value("portfolioRiskUsed"), portfolioRiskCapRatio: value("portfolioRiskCap") / 100,
      medianAmount20: candidate.metrics.medianAmount20 ?? NaN, maxParticipationRatio: value("participation") / 100 } : {}),
    alreadyHeld: Boolean(checks.held),
    permissionVerified: Boolean(checks.permission), announcementVerified: Boolean(checks.announcement),
    corporateActionAligned: Boolean(checks.aligned), marketGate: synthetic ? "open" : marketGate
  }) : null;
  const exit = exitRequested ? evaluateTrendExit({ stopPrice: plan.stop, holdingTradingDays: value("days"),
    close: value("close"), ma20: value("ma20"),
    ...(fields.previousClose?.trim() ? { previousClose: value("previousClose") } : {}),
    ...(fields.previousMa20?.trim() ? { previousMa20: value("previousMa20") } : {}),
    corporateActionAligned: Boolean(checks.exitAligned)
  }) : null;

  const entryEligible = Boolean(sizing?.eligible && (synthetic || (readiness.state === "ready" && checks.costs && !checking)));
  return <details className="trend-calculator" open={workspace ? workspace.calculatorOpen : defaultOpen || undefined} onToggle={event => { if (workspace && event.currentTarget.open !== workspace.calculatorOpen) onWorkspaceChange?.({ calculatorOpen: event.currentTarget.open }); }}>
    <summary><Calculator size={15} /><span>计划测算与复核</span><small>填写实际账户与价格</small><ChevronDown size={15} /></summary>
    <div className="trend-calc-content">
      <div className="trend-calc-tabs" role="group" aria-label={`${candidate.security.name}计划计算类型`}><button onClick={() => setTab("entry")} aria-pressed={tab === "entry"}>入场仓位</button><button onClick={() => setTab("exit")} aria-pressed={tab === "exit"}>持有 / 退出复核</button></div>
      <p className="trend-calc-description">冻结参考止损 S = <b>{number(plan.stop)}</b>{plan.minEntry !== undefined && <> · 最低入场 <b>{number(plan.minEntry)}</b></>} · 数据截止 {candidate.asOf}。测算不建立真实持仓，也不会自动下单或退出。</p>
      {tab === "entry" ? <>
        <div className="trend-form-grid">
          {field("nav", "账户净资产", "必填", "元")}{field("entry", "拟成交价 P", `≤ ${number(plan.maxEntry)}`, "元")}{field("cash", "可用现金", "实际可用", "元")}
          {field("industry", "已有同业仓位", "无持仓填 0", "%")}{field("portfolio", "已有总仓位", "无持仓填 0", "%")}{field("positions", "已有持仓数量", "无持仓填 0", "只")}
          {field("fees", "预留费用", "额外现金预留", "元")}
          {synthetic ? <>{field("minimum", "该股最低买入数量", "虚构假设", "股")}{field("step", "该股申报递增单位", "虚构假设", "股")}</> : <>
            {field("commission", "单边佣金率", "按券商核对", "%")}{field("minimumCommission", "单边最低佣金", "按券商核对", "元")}
            {field("tax", "卖出税费率", "模型假设，核对适用费率", "%")}{field("slippage", "单边滑点", "模型假设", "%")}{field("gap", "止损下方跳空压力", "0 表示不加压力", "%")}
            {field("portfolioRiskUsed", "组合已占用风险", "包括持仓与待成交计划", "元")}{field("portfolioRiskCap", "组合风险总额度", "净资产比例", "%")}{field("participation", "成交额最大参与比例", "相对20日中位数", "%")}
          </>}

        </div>
        {synthetic ? <p className="trend-execution-check">DEMO / 虚构公式测算，市场与交易状态是假设，不能生成真实执行计划。</p> : <div className="trend-execution-check" role="status">
          <button className="trend-btn trend-btn-small" disabled={checking} onClick={() => void refreshExecution()}>{checking ? "执行检查中…" : "刷新执行检查"}</button>
          <p><b>执行状态：{{ ready: "当前可复核", blocked: "阻止入场", unknown: "未知", expired: "已过期" }[readiness.state]}</b> · 数量规则：最低 {executionCheck?.minimumBuyQuantity || boardQuantity.minimumBuyQuantity} 股，递增 {executionCheck?.quantityStep || boardQuantity.quantityStep} 股（按板块自动确定）</p>
          {executionCheck && <p>检查 {dateTime(executionCheck.checkedAt)} · 信号 {executionCheck.signalDate} · 执行日 {executionCheck.executionDate || "未知"}<br />最新 {executionCheck.latest === null ? "未知" : number(executionCheck.latest)} · 上 / 下限 {executionCheck.upperLimit === null ? "未知" : number(executionCheck.upperLimit)} / {executionCheck.lowerLimit === null ? "未知" : number(executionCheck.lowerLimit)} · 报价日 {executionCheck.priceDate || "未知"} · 停牌 {executionCheck.suspended === null ? "未知" : executionCheck.suspended ? "是" : "否"}<br />来源：{executionCheck.source}；公开源报告值仍须对照券商核实。</p>}
          {readiness.reasons.map((reason, index) => <p key={`${reason}-${index}`}>{reason}</p>)}
          <small>仅信号下一交易日 09:25—09:35 窗口内复核；检查最多保留60秒。缺失数据与过期检查会阻止执行计划。</small>
        </div>}
        <div className="trend-checks">
          {!synthetic && check("costs", "已核对费用与滑点、跳空压力假设和组合剩余风险（包含待成交计划）")}
          {check("permission", "已核实板块权限、交易状态和申报数量规则")}
          {check("announcement", "已复核最新公告与次日可成交性")}
          {check("aligned", "已确认价格、止损与除权除息口径一致")}
          {check("held", "当前账户已持有该股（本策略禁止重复加仓）")}
        </div>
        <div className="trend-calc-foot"><button className="trend-btn trend-btn-accent" onClick={() => setEntryRequested(true)}><Calculator size={14} />计算参考股数</button><span>0.5% 风险预算 · 单股 15% · 同业 25% · 总仓 60% · 最多 6 只</span></div>
        {sizing && <div className={`trend-calculation-result ${entryEligible ? "is-eligible" : ""}`} role="status">
          <strong>{entryEligible ? synthetic ? "虚构算例满足输入约束（不可执行）" : "满足当前输入下的计划约束" : "暂不生成可执行仓位"}</strong>
          {entryEligible && <div className="trend-sizing-values"><div><small>参考数量</small><b>{count(sizing.shares)} 股</b></div><div><small>买入金额</small><b>{number(sizing.cost)} 元</b></div><div><small>计划亏损 / 账户</small><b>{number(sizing.plannedLoss)} / {number(sizing.riskRatio * 100)}%</b></div><div><small>压力亏损 / 双边费用</small><b>{number(sizing.stressLoss)} / {number(sizing.roundTripCosts)} 元</b></div><div><small>现金需求 / 剩余风险</small><b>{number(sizing.totalCashRequired)} / {number(sizing.remainingPortfolioRisk)} 元</b></div><div><small>新增仓位</small><b>{number(sizing.positionRatio * 100)}%</b></div></div>}
          {!synthetic && readiness.state !== "ready" && <p>尚无当前有效执行检查；手工勾选不能替代交易日与实时交易状态验证。</p>}
          {!synthetic && !checks.costs && <p>请核对费用、滑点、跳空压力与组合剩余风险假设。</p>}
          {sizing.reasons.length > 0 && <ul>{sizing.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
          <small>冻结 S 不随普通价格波动调整，公司行为另行核验；压力情景已纳入当前假设的仓位上限，实际跳空、停牌和成交偏差仍可能超过压力亏损；这不是实际亏损保证。申报前须再次核对当日信号。</small>
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

function CandidateCard({ candidate, isPreview, saved, onSave, onRemove, onOpen, marketGate, latestCandidate, latestAsOf, verificationAvailable = true, onDraftChange, workspace, onWorkspaceChange, onArchive }: {
  workspace: RowWorkspace; onWorkspaceChange: RowWorkspaceChange; onArchive?: () => void;
  candidate: TrendCandidate; isPreview: boolean; saved?: SavedTrendPlan; onSave?: (draft: TrendReviewDraft) => void; onRemove?: () => void; onDraftChange?: (draft: TrendReviewDraft) => void;
  onOpen: (security: Security) => void; marketGate: TrendScanStatus["marketGate"]; latestCandidate?: TrendCandidate; latestAsOf?: string; verificationAvailable?: boolean;
}) {
  const expanded = workspace.evidenceExpanded;
  const { draft } = workspace;
  const changeDraft = (next: TrendReviewDraft) => { onWorkspaceChange({ draft: next }); onDraftChange?.(next); };
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
        {candidate.limitDate ? <div className="trend-event"><span>最近收盘涨停</span><b>{candidate.limitDate}</b><small>距截止日 {candidate.daysSinceLimit} 个交易日</small></div>
          : <div className="trend-event"><span>近期涨停</span><b>无</b><small>本策略不要求近期涨停</small></div>}
        <div className="trend-reasons">{highlights.map((item, index) => <span key={`${item.label}-${index}`}><Check size={12} /><b>{item.label}</b><span>{item.value}</span></span>)}</div>
        <div className="trend-market-metrics"><div><small>收盘</small><strong>{number(candidate.metrics.close)}</strong></div><div><small>MA20 / MA60</small><strong>{number(candidate.metrics.ma20)} <i>/</i> {number(candidate.metrics.ma60)}</strong></div><div><small>距 MA20</small><strong>{number(candidate.metrics.deviationPercent, 1)}%</strong></div><div><small>20日平均成交额</small><strong>{number(candidate.metrics.avgAmount20 / 100000000, 2)} 亿</strong></div><div><small>20日成交额中位数</small><strong>{candidate.metrics.medianAmount20 === undefined ? "未知" : `${number(candidate.metrics.medianAmount20 / 100000000, 2)} 亿`}</strong></div></div>
      </div>
      <div className={`trend-reference-plan ${candidate.plan ? "" : "is-pending"}`}>
        <span className="trend-kicker">{saved ? "冻结计划 · 保存时价格" : "次日参考 · 收盘后计算"}</span>
        {candidate.plan ? <><div className="trend-plan-prices"><div><small>止损参考 S</small><strong>{number(candidate.plan.stop)}</strong></div><ArrowRight size={17} /><div><small>最高入场 Pmax</small><strong>{number(candidate.plan.maxEntry)}</strong></div></div><p>{candidate.plan.minEntry !== undefined ? <>入场参考 <b>{number(candidate.plan.minEntry)} ≤ P ≤ {number(candidate.plan.maxEntry)}</b><br />{candidate.plan.entryType === "close-confirmation" ? "收盘确认模型，无次日必须高开的条件；仍须处于入场参考区间" : "跌回突破下限时取消入场"}</> : <>仅在 <b>S &lt; 实际 P ≤ Pmax</b> 时复核入场</>}</p><span className="trend-risk-caption">Pmax 下计划价差风险 {number(candidate.plan.maxRiskPercent)}%<br />需另计费用；实际风险受跳空与成交影响</span></> : <><strong>{candidate.setup ? `等待${candidate.setup.label}确认` : "等待完整 A / B 信号"}</strong><p>趋势入选不代表可以买入。市场门槛、形态或价格风险仍有条件待满足。</p><span className="trend-risk-caption">暂不生成 S / Pmax 入场区间</span></>}
      </div>
    </div>
    {candidate.technical && <div className="trend-quality-metrics">{Object.entries(candidate.technical.indicators).map(([key, value]) => <span key={key}>{key} <b>{number(value)}</b></span>)}</div>}
    {candidate.quality && <div className="trend-quality-metrics"><span>昨日 ATR <b>{number(candidate.quality.atr14Previous)}</b></span><span>均线偏离 <b>{number(candidate.quality.extensionAtr)} ATR</b></span><span>收盘位置 <b>{number(candidate.quality.closeLocation * 100, 0)}%</b></span><span>五日量比 <b>{number(candidate.quality.volumeRatio)}</b></span><span>止损引用 <b>{candidate.primaryPattern || "待确认"}</b></span></div>}
    <div className="trend-candidate-actions"><button className="trend-text-button" onClick={() => onWorkspaceChange({ evidenceExpanded: !expanded })} aria-expanded={expanded} aria-label={`${candidate.security.name}规则依据`}><ListFilter size={14} />规则依据 <span>{candidate.evidence.length}</span><ChevronDown size={14} className={expanded ? "trend-rotate" : ""} /></button><span className="trend-limit-note">{!candidate.limitDate ? "技术指标策略 · 不依赖涨停" : candidate.limitEvidence === "calculated" ? "涨停价待官方核验" : "涨停价为源端报告值，待券商核验"}</span><div><button className="trend-btn trend-btn-small" onClick={() => onOpen(candidate.security)} disabled={isPreview} title={isPreview ? "虚构演示证券无法打开真实分析" : undefined}>个股分析<ChevronRight size={13} /></button>{onArchive && <button className="trend-btn trend-btn-small" onClick={onArchive}>{saved?.archivedAt ? "恢复计划" : "归档计划"}</button>}{onRemove ? <button className="trend-btn trend-btn-small" onClick={onRemove} aria-label={`移除${candidate.security.name}的计划`}><Trash2 size={13} />移除</button> : <button className={`trend-btn trend-btn-small ${saved ? "is-saved" : "trend-btn-accent"}`} onClick={() => onSave?.(draft)} disabled={Boolean(saved) || !onSave}>{saved ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}{saved ? "已保存快照" : "加入我的计划"}</button>}</div></div>
    {expanded && <div className="trend-evidence"><div className="trend-evidence-grid">{candidate.evidence.map((item, index) => <div
      key={`${item.label}-${index}`}
      className={[
        item.passed ? "" : "trend-evidence-pending",
        // group=summary 是复合判定的总括项，group=detail 是它的分项。
        // 视觉上区分，避免把 A/B 形态的分项误读成额外命中的独立条件。
        (item as { group?: string }).group === "detail" ? "trend-evidence-detail" : "",
        (item as { group?: string }).group === "summary" ? "trend-evidence-summary" : ""
      ].filter(Boolean).join(" ")}
    ><b>{item.passed ? "✓" : "·"} {item.label}</b><span>{item.value}</span><small>{item.rule}</small></div>)}</div>{candidate.warnings.length > 0 && <p><AlertTriangle size={14} />{candidate.warnings.join("；")}</p>}</div>}
    {candidate.plan && <PlanCalculator candidate={candidate} synthetic={isPreview} marketGate={hasNewerScan || (saved && (!verificationAvailable || !latestCandidate || latestCandidate.stage !== "signal" || JSON.stringify(latestCandidate.plan) !== JSON.stringify(candidate.plan))) ? "unknown" : marketGate} draft={draft} onDraftChange={changeDraft} workspace={workspace} onWorkspaceChange={onWorkspaceChange} />}
  </article>;
}

function CandidateRow({ candidate, isPreview, saved, workspace, onWorkspaceChange, children }: {
  candidate: TrendCandidate; isPreview: boolean; saved?: boolean; workspace: RowWorkspace; onWorkspaceChange: RowWorkspaceChange; children: ReactNode;
}) {
  const { expanded } = workspace;
  const detailId = useId();
  return <>
    <tr className="trend-result-row">
      <th scope="row"><b>{candidate.security.name}</b><small>{candidate.security.code}{isPreview ? " · DEMO" : ""}{saved ? " · 已保存" : ""}</small></th>
      <td>{strategyName(candidate.strategy)}</td>
      <td>{candidate.stage === "signal" ? candidate.setup?.label || candidate.patterns.map(pattern => filterLabels[pattern]).join(" / ") || "有效信号" : "趋势观察"}</td>
      <td>{candidate.asOf}</td>
      <td className="trend-numeric">{number(candidate.metrics.close)}</td>
      <td className="trend-numeric">{candidate.plan ? number(candidate.plan.stop) : "—"}</td>
      <td className="trend-numeric">{candidate.plan ? number(candidate.plan.maxEntry) : "—"}</td>
      <td>{isPreview ? <span>演示数据不请求真实行情</span> : <SelectionKline security={candidate.security} signalDate={candidate.stage === "signal" ? candidate.asOf : undefined} />}</td>
      <td><button className="trend-text-button" aria-expanded={expanded} aria-controls={detailId} aria-label={`${expanded ? "收起" : "详情与计划"}：${candidate.security.name}`} onClick={() => onWorkspaceChange({ expanded: !expanded })}>{expanded ? "收起" : "详情 / 计划"}<ChevronDown size={14} className={expanded ? "trend-rotate" : ""} /></button></td>
    </tr>
    {expanded && <tr id={detailId} className="trend-result-details"><td colSpan={9}>{children}</td></tr>}
  </>;
}

export default function TrendScreenerView({ onOpen, embedded = false, focusStrategyId }: { onOpen: (security: Security) => void; embedded?: boolean; focusStrategyId?: TrendStrategyId | undefined }) {
  const [viewPreferences] = useState(readTrendViewPreferences);
  const [status, setStatus] = useState<TrendScanStatus | null>(null);
  const statusRef = useRef<TrendScanStatus | null>(null);
  const acceptStatus = useCallback((next: TrendScanStatus) => { statusRef.current = next; setStatus(next); }, []);
  const rowWorkspaces = useRef(new Map<string, RowWorkspace>());
  const [, setWorkspaceRevision] = useState(0);
  const rowWorkspace = (id: string, saved?: SavedTrendPlan) => {
    const existing = rowWorkspaces.current.get(id);
    if (existing) return existing;
    const initial = initialRowWorkspace(saved);
    rowWorkspaces.current.set(id, initial);
    return initial;
  };
  const changeRowWorkspace = (id: string, patch: Partial<RowWorkspace>) => {
    const previous = rowWorkspaces.current.get(id);
    if (!previous) return;
    rowWorkspaces.current.set(id, { ...previous, ...patch });
    setWorkspaceRevision(value => value + 1);
  };
  const [resultPage, setResultPage] = useState(1);
  const [planArchive, setPlanArchive] = useState<"active" | "archived">("active");
  const [scanMode, setScanMode] = useState<"single" | "multi">(viewPreferences.scanMode);
  const [selectedStrategies, setSelectedStrategies] = useState<TrendStrategyId[]>(viewPreferences.selectedStrategies);
  const [strategyFilter, setStrategyFilter] = useState<"all" | TrendStrategyId>(viewPreferences.strategyFilter);
  const [strategyId, setStrategyId] = useState<TrendStrategyId>(viewPreferences.strategyId);
  const [qualityDraft, setQualityDraft] = useState(viewPreferences.qualityDraft);
  const [forceRefresh, setForceRefresh] = useState(viewPreferences.forceRefresh);
  const [scanReason, setScanReason] = useState(viewPreferences.scanReason);
  const [researchStart, setResearchStart] = useState(viewPreferences.researchStart);
  const [researchEnd, setResearchEnd] = useState(viewPreferences.researchEnd);
  const [filter, setFilter] = useState<Filter>(viewPreferences.filter);
  const [tab, setTab] = useState<"candidates" | "plans">(viewPreferences.tab);
  // Inside 策略选股 the library picks the model: include it in the next scan and show its results.
  useEffect(() => {
    if (!focusStrategyId) return;
    setStrategyFilter(focusStrategyId);
    setStrategyId(focusStrategyId);
    setSelectedStrategies(current => current.includes(focusStrategyId) ? current : [...current, focusStrategyId]);
  }, [focusStrategyId]);
  const [query, setQuery] = useState(viewPreferences.query);
  const [showExample, setShowExample] = useState(false);
  const [showPrinciple, setShowPrinciple] = useState(false);
  const [exampleDraft, setExampleDraft] = useState<TrendReviewDraft>({ fields: { nav: "100000", entry: "10", cash: "100000", industry: "0", portfolio: "0", positions: "0", fees: "0", minimum: "100", step: "100" }, checks: {} });
  const [action, setAction] = useState<Action>(null);
  const [failure, setFailure] = useState<ScanFailure | null>(null);
  const [storage, setStorage] = useState(() => {
    try { return readTrendPlans(window.localStorage); }
    catch { return { plans: [] as SavedTrendPlan[], error: "无法读取本地计划，请检查存储权限。" }; }
  });
  const [saveNotice, setSaveNotice] = useState("");
  const mounted = useRef(false);
  const requestId = useRef(0);
  const pollPending = useRef(false);
  const actionPending = useRef(false);
  const configuration = useRef<HTMLDetailsElement>(null);

  const preferences = useMemo<TrendViewPreferences>(() => ({ scanMode, selectedStrategies, strategyFilter, strategyId, qualityDraft, forceRefresh, scanReason, researchStart, researchEnd, filter, tab, query }), [scanMode, selectedStrategies, strategyFilter, strategyId, qualityDraft, forceRefresh, scanReason, researchStart, researchEnd, filter, tab, query]);
  const latestPreferences = useRef(preferences);
  useEffect(() => {
    latestPreferences.current = preferences;
    const timer = window.setTimeout(() => saveTrendViewPreferences(preferences), 400);
    return () => window.clearTimeout(timer);
  }, [preferences]);
  useEffect(() => {
    const flush = () => { saveTrendViewPreferences(latestPreferences.current); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, []);

  const readStatus = useCallback(async () => {
    if (actionPending.current) return;
    const id = ++requestId.current;
    try {
      const previous = statusRef.current;
      const cursor = previous?.candidateEpoch && previous.candidateRevision !== undefined ? {
        candidateEpoch: previous.candidateEpoch, jobId: previous.jobId, candidateRevision: previous.candidateRevision
      } : null;
      const snapshot = cursor ? await window.stockApi.getTrendScan(cursor) : await window.stockApi.getTrendScan();
      // Omitted candidates are usable only against the exact acknowledged collection.
      const reuse = previous && cursor && snapshot.candidateEpoch === cursor.candidateEpoch &&
        snapshot.jobId === cursor.jobId && snapshot.candidateRevision === cursor.candidateRevision;
      const next: TrendScanStatus = snapshot.candidates ? { ...snapshot, candidates: snapshot.candidates } : reuse ?
        { ...snapshot, candidates: previous.candidates } : await window.stockApi.getTrendScan();
      if (mounted.current && id === requestId.current) { acceptStatus(next); setFailure(previous => previous?.action === "status" ? null : previous); }
    } catch (reason) {
      if (mounted.current && id === requestId.current) setFailure(previous => previous && previous.action !== "status" ? previous : { message: `读取扫描状态失败：${errorText(reason)}`, action: "status" });
    }
  }, [acceptStatus]);
  useEffect(() => {
    mounted.current = true;
    const readWhenVisible = whenVisible(() => {
      if (pollPending.current) return;
      pollPending.current = true;
      void readStatus().finally(() => { pollPending.current = false; });
    });
    readWhenVisible();
    document.addEventListener("visibilitychange", readWhenVisible);
    return () => {
      mounted.current = false;
      requestId.current += 1;
      document.removeEventListener("visibilitychange", readWhenVisible);
    };
  }, [readStatus]);
  useEffect(() => {
    if (!running(status?.phase)) return;
    const timer = window.setInterval(whenVisible(() => {
      if (pollPending.current) return;
      pollPending.current = true;
      void readStatus().finally(() => { pollPending.current = false; });
    }), 1000);
    return () => window.clearInterval(timer);
  }, [readStatus, status?.phase]);
  const invoke = async (kind: Exclude<Action, null>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    const id = ++requestId.current;
    setAction(kind); setFailure(null);
    let invalidField = "";
    try {
      const config = Object.fromEntries(TREND_CONFIG_FIELDS.map(({ key }) => [key, inputNumber(qualityDraft[key] || "")])) as unknown as TrendQualityConfig;
      const selected = scanMode === "multi" ? selectedStrategies : [strategyId];
      if (kind === "start" && !selected.length) { invalidField = "strategies"; throw new Error("请至少选择一个扫描策略"); }
      if (kind === "start" && selected.includes("quality-v2") && !validQualityConfig(config)) {
        const field = TREND_CONFIG_FIELDS.find(({ key, min, max }) => !Number.isFinite(config[key]) || config[key] < min || config[key] > max)!;
        invalidField = field.key;
        throw new Error(`请填写有效的${field.label}（${field.min}—${field.max}）`);
      }
      const selections: TrendStrategySelection[] = selected.map(id => ({ strategyId: id, ...(id === "quality-v2" ? { config: { ...config } } : {}) }));
      if (kind === "start" && selected.includes("quality-v2") && qualityPresetName(config) === "custom-research" && !scanReason.trim()) { invalidField = "scanReason"; throw new Error("自定义研究参数须填写扫描 / 调参原因，保留尝试记录"); }
      if (kind === "start" && (Boolean(researchStart) !== Boolean(researchEnd) || (researchStart && researchStart > researchEnd))) { invalidField = !researchStart ? "researchStart" : "researchEnd"; throw new Error("研究区间须同时填写起始、截止且起始不晚于截止"); }
      const scanRequest = scanMode === "multi" ? { strategies: selections, forceRefresh } : { ...selections[0], forceRefresh };
      const requestedAt = new Date().toISOString();
      const next = kind === "start" ? await window.stockApi.startTrendScan(scanRequest) : await window.stockApi.cancelTrendScan();
      if (mounted.current && id === requestId.current) acceptStatus(next);
      if (kind === "start") {
        try {
          await appendTrendScanJournal(window.localStorage, { request: scanRequest,
            reason: scanReason.trim() || `实时扫描 / ${selected.includes("quality-v2") ? qualityPresetName(config) : "固定策略参数"}`,
            range: { start: researchStart || null, end: researchEnd || null }, requestedAt,
            asOf: next.asOf || null, isPreview: Boolean(next.isPreview),
            strategies: next.strategies || (next.strategy ? [next.strategy] : []) });
        } catch (reason) {
          if (mounted.current && id === requestId.current) setSaveNotice(`扫描已启动，本地日志写入失败：${errorText(reason)}`);
        }
      }
    } catch (reason) {
      if (mounted.current && id === requestId.current) {
        setFailure({ message: `${kind === "start" ? "启动" : "取消"}扫描失败：${errorText(reason)}`, action: kind });
        if (invalidField && configuration.current) {
          configuration.current.open = true;
          const field = configuration.current.querySelector<HTMLElement>(`[data-trend-field="${invalidField}"]`);
          const disclosure = field?.closest("details");
          if (disclosure) disclosure.open = true;
          field?.focus();
        }
      }
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
    if (planIndex.has(snapshot.id)) return;
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
  const candidates = status?.candidates || EMPTY_CANDIDATES;
  const planIndex = useMemo(() => new Map(storage.plans.map(plan => [plan.id, plan])), [storage.plans]);
  const candidateIndex = useMemo(() => indexTrendCandidates(candidates), [candidates]);
  const candidateIds = useMemo(() => new Set(candidates.map(candidate => trendPlanId(candidate, Boolean(status?.isPreview)))), [candidates, status?.isPreview]);
  useEffect(() => {
    // Retain state only for current candidates or user-owned snapshots, never prior scan history.
    for (const id of rowWorkspaces.current.keys()) if (!planIndex.has(id) && !candidateIds.has(id)) rowWorkspaces.current.delete(id);
  }, [candidateIds, planIndex]);
  useEffect(() => { setResultPage(1); }, [filter, query, strategyFilter, tab, planArchive]);
  const searchText = query.trim().toLocaleLowerCase();
  const matchesQuery = (candidate: TrendCandidate) => `${candidate.security.code} ${candidate.security.name}`.toLocaleLowerCase().includes(searchText);
  const matchesStrategy = (candidate: TrendCandidate) => strategyFilter === "all" || (candidate.strategy?.id || "classic-v1") === strategyFilter;
  const filtered = useMemo(() => candidates.filter((candidate) => {
    const matchesFilter = filter === "watch" ? candidate.stage === "watch" : filter === "signal" ? candidate.stage === "signal" : filter === "A" || filter === "B" ? candidate.stage === "signal" && candidate.patterns.includes(filter) : true;
    return matchesFilter && matchesStrategy(candidate) && `${candidate.security.code} ${candidate.security.name}`.toLocaleLowerCase().includes(searchText);
  }), [candidates, filter, searchText, strategyFilter]);
  const filteredStockCount = useMemo(() => new Set(filtered.map(item => item.security.secid)).size, [filtered]);
  const archivedPlanCount = useMemo(() => storage.plans.reduce((total, plan) => total + Number(Boolean(plan.archivedAt)), 0), [storage.plans]);
  const plansInArchive = useMemo(() => storage.plans.filter(plan => Boolean(plan.archivedAt) === (planArchive === "archived")), [storage.plans, planArchive]);
  const plansFiltered = useMemo(() => plansInArchive.filter(plan => matchesQuery(plan.candidate) && matchesStrategy(plan.candidate)), [plansInArchive, searchText, strategyFilter]);
  const totals = useMemo(() => {
    const counts: Record<Filter, number> = { all: 0, signal: 0, watch: 0, A: 0, B: 0 };
    for (const candidate of candidates) {
      if (!matchesStrategy(candidate)) continue;
      counts.all += 1; counts[candidate.stage] += 1;
      if (candidate.stage === "signal") { if (candidate.patterns.includes("A")) counts.A += 1; if (candidate.patterns.includes("B")) counts.B += 1; }
    }
    return counts;
  }, [candidates, strategyFilter]);
  const phase = status?.phase || "idle";
  const active = running(phase);
  const complete = status?.coverageComplete === true && phase === "completed";
  const coverageText = complete ? "全市场覆盖完整" : status && phase !== "idle" ? "覆盖未完成 / 待核验" : "等待首次扫描";
  const phaseText: Record<TrendScanStatus["phase"], string> = { idle: "尚未扫描", "loading-universe": "载入全市场名单", scanning: "分析历史日线", completed: "扫描结束", cancelled: "扫描已取消", failed: "扫描失败" };
  const progress = status?.universeLoaded ? Math.min(100, status.processed / status.universeLoaded * 100) : 0;
  const marketGate = status?.freshness?.state === "current" ? status.marketGate : "unknown";
  const gateTitle = marketGate === "blocked" ? "暂停新开仓" : marketGate === "open" ? "市场门槛通过" : "市场门槛待确认";
  const gateText = marketGate === "blocked" ? "中证全指收盘低于 MA60，保留观察，暂停新开仓计划。" : marketGate === "open" ? "中证全指收盘不低于 MA60。仍需复核个股信号与次日交易状态。" : "缺少可验证的指数数据，暂不能形成开仓结论。";
  const visibleCount = tab === "candidates" ? filtered.length : plansFiltered.length;
  const pageCount = Math.max(1, Math.ceil(visibleCount / RESULT_PAGE_SIZE));
  const currentPage = Math.min(resultPage, pageCount);
  const pageStart = (currentPage - 1) * RESULT_PAGE_SIZE;
  const candidateWindow = tab === "candidates" ? filtered.slice(pageStart, pageStart + RESULT_PAGE_SIZE) : EMPTY_CANDIDATES;
  const planWindow = tab === "plans" ? plansFiltered.slice(pageStart, pageStart + RESULT_PAGE_SIZE) : [];
  const sourceCount = tab === "plans" ? plansInArchive.length : candidates.length;
  const hiddenByFilters = sourceCount > 0 && visibleCount === 0;
  const clearFilters = () => { setQuery(""); setFilter("all"); setStrategyFilter("all"); };
  const exportJournal = () => {
    try {
      const rows = readTrendScanJournal(window.localStorage);
      if (!rows.length) { setSaveNotice("本机尚无扫描日志，启动扫描后记录。"); return; }
      const url = URL.createObjectURL(new Blob([trendScanJournalCsv(rows)], { type: "text/csv;charset=utf-8;" }));
      const link = document.createElement("a"); link.href = url; link.download = "趋势扫描日志.csv";
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSaveNotice(`已导出本地 ${rows.length} 条扫描日志，日志不构成收益验证。`);
    } catch (reason) { setSaveNotice(`日志导出失败：${errorText(reason)}`); }
  };
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
    <header className="trend-header"><div>{embedded ? <h2 className="trend-embedded-title">趋势模型 · {TREND_STRATEGY_CHOICES.find(item => item.id === focusStrategyId)?.name || "全部模型"}</h2> : <h1>趋势筛选</h1>}</div><div className="trend-header-actions"><button className="trend-btn" onClick={() => setShowPrinciple(current => !current)} aria-expanded={showPrinciple} aria-controls="trend-principle"><CircleHelp size={15} />完整规则</button><button className="trend-btn" onClick={() => setShowExample((current) => !current)} aria-expanded={showExample}><Calculator size={15} />方案算例</button><button className="trend-btn" onClick={() => void readStatus()} disabled={Boolean(action)} aria-label="刷新扫描状态"><RefreshCw size={15} />刷新状态</button>{active ? <button className="trend-btn" onClick={() => void invoke("cancel")} disabled={Boolean(action)}><Square size={14} />{action === "cancel" ? "取消中…" : "取消扫描"}</button> : <button className="trend-btn trend-btn-accent" onClick={() => void invoke("start")} disabled={Boolean(action)}><Play size={14} />{action === "start" ? "启动中…" : "扫描全 A 股"}</button>}</div></header>
    {(() => { const overview = <section className="trend-logic-overview" aria-label="趋势筛选逻辑速读">
      <div className="trend-logic-heading"><div><span className="trend-kicker">规则模型 · 非收益预测</span><h2>先筛基础趋势，再等回踩或突破</h2><p>有效信号要依次通过基础条件、形态、市场和价格风险门槛。基础条件通过但信号条件未齐的列为“趋势观察”；行情缺失会标为不可用，不会当成未命中。</p></div><span className="trend-logic-default">默认对照：原版趋势 v1 + 趋势质量 v2</span></div>
      <p className="trend-logic-plain-language"><strong>白话理解：</strong>先找最近涨停后趋势仍强、成交额足够的股票；再等“回踩均线后转强”或“缩量横盘后放量突破”；最后检查大盘环境和价格风险，不满足就不列为有效信号。</p>
      <div className="trend-logic-steps">
        <article><b><i>1</i> 建立基础池</b><p>排除 ST / 退市；有效日线至少 250 根。近 15 个交易日有收盘涨停；收盘 &gt; MA20 &gt; MA60，MA20 高于 5 日前；20 日均额 ≥ 2 亿元；涨停后收盘未破涨停日最低价。</p></article>
        <article><b><i>2</i> 等一种形态</b><p><strong>A 回踩转强：</strong>第 4–14 日，近三日内至少一日低点触及 MA20±2%，三日均量≤涨停日 70%；信号日收盘过昨日高点且量≥前五日均量。<br /><strong>B 平台突破：</strong>第 4–11 日，涨停后整理 3–10 根、区间≤10%、整理均量≤涨停日 80%；收盘过平台高点且量≥前五日均量 1.2 倍。A、B 命中其一即可。</p></article>
        <article><b><i>3</i> 再过风控</b><p>基础版要求收盘距 MA20≤10%、入场价 P 高于止损 S，且最高入场价不超过信号收盘的 103% 和 S÷0.92 两者中的较低值；中证全指收盘需≥MA60。质量版在此基础上增加强弱、波动、收盘位置、量比和承接过滤。</p></article>
      </div>
      <details className="trend-model-boundaries"><summary>策略模型怎么比较、目前能得出什么结论</summary><div><p><strong>原版趋势 v1</strong>是对照基线，按 A / B 两种形态筛选；<strong>趋势质量 v2</strong>在同一基础上加严条件（默认：距 MA20 ≤ 2 倍昨日 ATR、收盘位置 ≥ 70%、当日量不超过前五日均量 3 倍）。参数更严只说明候选更少，不代表收益更高。</p><p><strong>扩展指标策略</strong>（MACD、布林、DMI、OBV、KDJ、均线、RSI、CCI、ROC、EMV、MFI、唐奇安）有各自的触发条件，默认不参与扫描；它们是固定参数的研究模型，当前没有证据证明优于基线。真实收益优越性尚未验证。</p><p>要继续优化，应冻结策略版本、证券范围、成本和成交假设，再用同一历史区间比较，并保留未见过的样本外区间；不要反复用同一段数据调参后称为样本外验证。</p></div></details>
    </section>; return embedded ? <details className="trend-logic-fold"><summary>规则说明 · 先筛基础趋势，再等回踩或突破</summary>{overview}</details> : overview; })()}
    <details ref={configuration} className="research-disclosure trend-scan-configuration"><summary><span>扫描配置</span><small>{scanMode === "multi" ? `多策略 · 已选 ${selectedStrategies.length} 项` : "单策略扫描"} · 策略库 / 质量参数 / 规则来源</small></summary>
      <TrendStrategyPanel mode={scanMode} onMode={setScanMode} strategyId={strategyId} onStrategy={setStrategyId} selected={selectedStrategies} onSelected={setSelectedStrategies} qualityDraft={qualityDraft} onQuality={setQualityDraft} forceRefresh={forceRefresh} onRefresh={setForceRefresh} scanReason={scanReason} onReason={setScanReason} researchStart={researchStart} researchEnd={researchEnd} onResearchStart={setResearchStart} onResearchEnd={setResearchEnd} onExportJournal={exportJournal} disabled={active || Boolean(action)} status={status} />
    </details>
    <TrendResearchTools qualityConfig={{ maxExtensionAtr: inputNumber(qualityDraft.maxExtensionAtr || ""), minCloseLocation: inputNumber(qualityDraft.minCloseLocation || ""), maxVolumeRatio: inputNumber(qualityDraft.maxVolumeRatio || "") }} />
    {status?.isPreview && <div className="trend-notice"><AlertTriangle size={16} /><div><strong>DEMO / 演示工作台 · 全部证券均为虚构</strong><span>以下行情、市场门槛与覆盖数仅供操作演示，不能用于真实交易；演示快照和导出会保留 DEMO 标识。</span></div></div>}
    {failure && <div className="trend-error" role="alert"><AlertTriangle size={16} />{failure.message}<button disabled={Boolean(action)} onClick={() => void (failure.action === "status" ? readStatus() : invoke(failure.action))}>重试</button></div>}

    {showPrinciple && <section id="trend-principle" className="trend-rule-note" aria-label="策略与执行纪律"><div className="trend-rule-heading"><h2>完整筛选与执行规则</h2><button className="trend-btn trend-btn-small" onClick={() => setShowPrinciple(false)}>收起</button></div><p className="trend-principle-intro">这是按固定条件逐项判断的规则模型，不是训练出的机器学习预测器。先按证券状态、行情完整度、涨停、趋势和成交额建立基础池，再检查 A / B 形态、指数门槛与参考风险区间；各项结果可在候选的“规则依据”中逐条核对。</p><div className="trend-rule-grid"><article><span>01 / 信号</span><h3>两条形态路线</h3><p>A：涨停后第 4–14 个交易日，近三日低点触及各自 MA20 的 98%–102%，三日均量不超过涨停日的 70%，信号日收盘过昨日高点且量不低于前五日均量。B：第 4–11 日，涨停后整理 3–10 根，整理区间不超过 10%、均量不超过涨停日的 80%，信号日收盘过平台高点且量达到前五日均量 1.2 倍。</p></article><article><span>02 / 入场</span><h3>等确认，不追高</h3><p>基础版需要 A 或 B 命中、收盘距 MA20 不超过 10%、市场门槛通过和有效风险区间。止损 S 由涨停日低点及形态低点计算；最高入场 Pmax=min(1.03×C,S÷0.92)，只在 S&lt;P≤Pmax 时复核。质量版还要求最低入场越过突破位，并收紧最高入场。</p></article><article><span>03 / 仓位与退出</span><h3>先算风险，逐日复核</h3><p>单笔计划亏损 ≤ 净资产 0.5%；单股 ≤ 15%、同业 ≤ 25%、总仓 ≤ 60%，最多 6 只。收盘跌破冻结 S，或连续两日收盘低于 MA20，安排下一可交易日退出；买入日为第 1 日，第 29 日收盘安排第 30 日开盘退出。</p></article></div><p className="trend-strategy-explainer">质量 v2 默认追加昨日 ATR 偏离、收盘位置、量比、MA60 方向、相对强度、三日 MA20 承接和止损距离等约束。扩展指标策略各自独立触发，不要求 A / B，但仍受共用基础池和市场风险门槛约束。它们均为研究筛选，不代表买入建议或已验证的收益优势。</p><div className="trend-playbook-foot"><CircleHelp size={14} />涨停价优先使用源端报告限价，公开源数值仍待券商核验；缺失时按板块常规规则估算并标记。保存计划后仍须核验最新限价、公告、复权口径和次日可成交性。</div></section>}
    <div className="research-command-bar" aria-label="研究状态摘要"><strong>{gateTitle}</strong><span>{phaseText[phase]} · {status ? count(status.processed) : "—"} / {status?.universeLoaded ? count(status.universeLoaded) : "待载入"}</span><span>{coverageText}</span><span title={status?.freshness?.reason || "尚未验证预期交易日"}>新鲜度：{status?.freshness?.state === "current" ? "当前" : status?.freshness?.state === "stale" ? "陈旧" : "未知"} · 预期 {status?.freshness?.expectedDate || "未知"}</span><span>数据截止 {status?.asOf || "尚未取得数据"}</span>{Boolean(status?.failed) && <span>请求失败 {status!.failed}</span>}</div>
    <div className="trend-terminal-layout">
      <div className="trend-primary-column">
    {showExample && <section className="trend-example" aria-label="虚构方案算例"><div><span className="trend-demo-tag">DEMO / 虚构算例</span><h2>10 万元账户，如何落实这套纪律？</h2><p>这不是股票或选股结果。仅用虚构 P = 10、S = 9.50 演示公式，100 股的最低数量与递增单位也是假定值。市场门槛在算例中假定通过；实际使用须逐项核实。</p></div><PlanCalculator candidate={exampleCandidate} synthetic marketGate="open" draft={exampleDraft} onDraftChange={setExampleDraft} defaultOpen /></section>}
    <section className="trend-workbench" aria-label="研究候选与我的计划"><div className="trend-workbench-head"><div className="trend-main-tabs" role="group" aria-label="工作台视图"><button className={tab === "candidates" ? "active" : ""} aria-pressed={tab === "candidates"} onClick={() => setTab("candidates")}><Target size={17} />研究候选<span>{candidates.length}</span></button><button className={tab === "plans" ? "active" : ""} aria-pressed={tab === "plans"} onClick={() => setTab("plans")}><Bookmark size={16} />我的计划<span>{storage.plans.length}</span></button></div><button className="trend-btn trend-btn-small" onClick={exportCsv} disabled={!visibleCount}><Download size={14} />导出{tab === "plans" ? "计划" : "当前结果"} CSV</button></div>
      {saveNotice && <div className="trend-save-notice" role="status">{saveNotice}<button aria-label="关闭提示" onClick={() => setSaveNotice("")}><X size={13} /></button></div>}
      {storage.error && <div className="trend-error" role="alert">{storage.error}</div>}
      <div className="trend-results-toolbar"><label className="trend-strategy-select trend-result-strategy"><span>结果策略</span><select aria-label="结果策略" value={strategyFilter} onChange={e => setStrategyFilter(e.target.value as "all" | TrendStrategyId)}><option value="all">全部策略</option>{TREND_STRATEGY_CHOICES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{tab === "candidates" ? <div className="trend-filters" role="group" aria-label="筛选形态">{(["all", "signal", "A", "B", "watch"] as const).map((key) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)} aria-pressed={filter === key}>{filterLabels[key]}<b>{totals[key]}</b></button>)}</div> : <p className="trend-plan-intro">保存在本机的研究快照，<b>不等于实际持仓</b>。价格冻结；数字输入与已持有标记保存在本机，重新打开后须重做核验勾选。归档保留快照与输入，可随时恢复；CSV 导出当前列表的全部筛选快照。</p>}<label className="trend-search"><Search size={15} /><input aria-label="搜索代码或名称" placeholder="搜索代码 / 名称" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button onClick={() => setQuery("")} aria-label="清空候选搜索"><X size={13} /></button>}</label></div>
      {tab === "plans" && <div className="trend-filters" role="group" aria-label="计划归档状态"><button className={planArchive === "active" ? "active" : ""} aria-pressed={planArchive === "active"} onClick={() => setPlanArchive("active")}>使用中 {storage.plans.length - archivedPlanCount}</button><button className={planArchive === "archived" ? "active" : ""} aria-pressed={planArchive === "archived"} onClick={() => setPlanArchive("archived")}>已归档 {archivedPlanCount}</button></div>}
      <div className="trend-results-context"><span>{tab === "candidates" ? `${filterLabels[filter]} · ${filtered.length} 条结果 / ${filteredStockCount} 只股票` : `${planArchive === "archived" ? "已归档" : "使用中"}快照 · ${plansFiltered.length} 条`}</span><p>{tab === "plans" ? "先复核最新信号，再检查冻结止损与退出条件。" : phase === "idle" ? "启动扫描后显示真实筛选结果。" : !complete ? "当前覆盖不完整；无候选不代表全市场没有机会。" : "同股可命中多个策略；候选条数与去重股票数分别统计。"}</p></div>
      {visibleCount > 0 && <nav className="trend-results-toolbar" aria-label="研究结果分页"><span>第 {currentPage} / {pageCount} 页 · {pageStart + 1}–{Math.min(pageStart + RESULT_PAGE_SIZE, visibleCount)} / {visibleCount} 条，每页最多 {RESULT_PAGE_SIZE} 条</span><button className="trend-btn trend-btn-small" disabled={currentPage === 1} onClick={() => setResultPage(currentPage - 1)}>上一页</button><button className="trend-btn trend-btn-small" disabled={currentPage === pageCount} onClick={() => setResultPage(currentPage + 1)}>下一页</button></nav>}
      <div className="trend-candidate-list"><div className="trend-result-scroll" tabIndex={0} role="region" aria-label="研究结果表格"><table className="trend-result-table"><thead><tr><th scope="col">股票 / 代码</th><th scope="col">策略</th><th scope="col">信号 / 形态</th><th scope="col">数据截止</th><th scope="col">收盘</th><th scope="col">止损 S</th><th scope="col">最高入场 Pmax</th><th scope="col">日K走势</th><th scope="col">操作</th></tr></thead><tbody>{candidateWindow.map((candidate) => {
        const id = trendPlanId(candidate, Boolean(status?.isPreview));
        const saved = planIndex.get(id);
        const review = saved ? reviewSavedTrendPlan(saved, status, candidateIndex) : { latestCandidate: candidate, ...(status?.asOf ? { latestAsOf: status.asOf } : {}), marketGate };
        const workspace = rowWorkspace(id, saved);
        const onWorkspaceChange: RowWorkspaceChange = patch => changeRowWorkspace(id, patch);
        return <CandidateRow key={id} candidate={saved?.candidate || candidate} isPreview={Boolean(status?.isPreview)} saved={Boolean(saved)} workspace={workspace} onWorkspaceChange={onWorkspaceChange}><CandidateCard workspace={workspace} onWorkspaceChange={onWorkspaceChange} candidate={saved?.candidate || candidate} {...review} marketGate={marketGate} isPreview={Boolean(status?.isPreview)} {...(saved ? { saved, onDraftChange: (draft: TrendReviewDraft) => updateDraft(saved.id, draft) } : {})} {...(!storage.error ? { onSave: (draft: TrendReviewDraft) => saveCandidate(candidate, draft) } : {})} onOpen={onOpen} /></CandidateRow>;
      })}{planWindow.map((plan) => {
        const workspace = rowWorkspace(plan.id, plan);
        const onWorkspaceChange: RowWorkspaceChange = patch => changeRowWorkspace(plan.id, patch);
        return <CandidateRow key={plan.id} candidate={plan.candidate} isPreview={plan.isPreview} saved workspace={workspace} onWorkspaceChange={onWorkspaceChange}><CandidateCard workspace={workspace} onWorkspaceChange={onWorkspaceChange} candidate={plan.candidate} isPreview={plan.isPreview} saved={plan} onDraftChange={(draft) => updateDraft(plan.id, draft)} onArchive={() => updatePlans(storage.plans.map(item => { if (item.id !== plan.id) return item; const { archivedAt, ...snapshot } = item; return archivedAt ? snapshot : { ...snapshot, archivedAt: new Date().toISOString() }; }), plan.archivedAt ? "计划已恢复到使用中列表。" : "计划已归档，快照和复核输入仍保存在本机，可在已归档列表恢复。")} onRemove={() => updatePlans(storage.plans.filter((item) => item.id !== plan.id), `已移除 ${plan.candidate.security.name} 的计划快照。`)} onOpen={onOpen} {...reviewSavedTrendPlan(plan, status, candidateIndex)} marketGate={marketGate} /></CandidateRow>;
      })}</tbody></table></div>{visibleCount === 0 && <div className="trend-empty"><div>{tab === "plans" ? <Bookmark size={27} /> : <TrendingUp size={27} />}</div>
        <strong>{hiddenByFilters ? "当前筛选没有匹配结果" : tab === "plans" ? planArchive === "archived" ? "尚无归档的计划" : "把值得跟踪的候选，留成下一步计划" : active ? "正在逐只检验趋势与涨停形态" : phase === "idle" ? "从一次全 A 股扫描开始" : "目前没有可展示的研究候选"}</strong>
        <p>{hiddenByFilters ? `已有 ${sourceCount} 条${tab === "plans" ? "计划" : "研究候选"}，当前搜索、${tab === "candidates" ? "形态或" : ""}结果策略筛选没有匹配。清除筛选可查看全部记录。` : tab === "plans" ? planArchive === "archived" ? "在使用中列表展开计划并点击归档，原快照与复核输入会保留，可随时恢复。" : "在候选卡片点击“加入我的计划”，保存截止日、规则依据和参考价。" : active ? "候选会随扫描更新。请先关注市场门槛和板块覆盖。" : !complete ? "先完成扫描并查看失败明细；缺失数据不会被当作未命中。" : "当前规则下没有候选，等待新的收盘信号。"}</p>
        {hiddenByFilters ? <button className="trend-btn" onClick={clearFilters}>清除筛选</button> : tab === "plans" ? planArchive === "archived" ? <button className="trend-btn" onClick={() => setPlanArchive("active")}>查看使用中计划</button> : <button className="trend-btn" onClick={() => setTab("candidates")}>去研究候选<ArrowRight size={14} /></button> : !active && <button className="trend-btn" onClick={() => void invoke("start")} disabled={Boolean(action)}><Play size={14} />扫描全 A 股</button>}
      </div>}</div>
    </section>

      </div>
      <details className="research-disclosure trend-audit-disclosure"><summary><span>市场门槛与扫描详情</span><small>{gateTitle} · {coverageText}</small></summary><aside className="trend-support-column">
      <TrendScanDiagnostics status={status} />
      <section className="trend-status-card" aria-label="交易日新鲜度"><h2>交易日新鲜度：{status?.freshness?.state === "current" ? "当前" : status?.freshness?.state === "stale" ? "陈旧" : "未知"}</h2><p>预期最近完整交易日 {status?.freshness?.expectedDate || "未知"} · 实际源日期 {status?.freshness?.actualDate || "未知"}</p><p>{status?.freshness?.reason || "尚未由交易日历验证源日期；覆盖完整不代表数据为最新。"}</p></section>
      <section className={`trend-gate is-${marketGate}`} aria-label="市场开仓门槛"><div className="trend-gate-icon"><ShieldCheck size={25} /></div><h2>{gateTitle}</h2><p>{gateText}</p><div><span>共同市场代理</span><b>中证全指 / MA60</b></div><small>截至 {status?.asOf || "尚未取得数据"} · 北交所仍需单独复核</small></section>
      <section className="trend-status-card" aria-label="扫描状态"><div className="trend-status-head"><div><h2>{active ? <LoaderCircle size={17} className="trend-spin" /> : <Layers3 size={17} />}{phaseText[phase]}</h2></div><span className={`trend-status-badge ${complete ? "is-complete" : ""}`}>{coverageText}</span></div><div className="trend-scan-numbers"><strong>{status && phase !== "idle" ? count(status.processed) : "—"}<small> / {status?.universeLoaded ? count(status.universeLoaded) : "待载入"}</small></strong><span>已处理证券 / 已载入名单</span><b>{active ? `${number(progress, 0)}%` : status?.asOf ? `数据截止 ${status.asOf}` : "手动启动扫描"}</b></div><div className="trend-progress" role="progressbar" aria-label="已载入名单处理进度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div><div className="trend-health-counts"><span>源端总数 <b>{status?.universeExpected == null ? "未知" : count(status.universeExpected)}</b></span><span>规则排除 <b>{status ? count(status.excluded) : "—"}</b></span><span>数据不可用 <b>{status ? count(status.unavailable) : "—"}</b></span><span>请求失败 <b>{status ? count(status.failed) : "—"}</b></span></div>{status?.performance && <div className="trend-performance"><span>原始 / 复权请求 <b>{status.performance.rawRequests} / {status.performance.adjustedRequests}</b></span><span>缓存命中 <b>{status.performance.cacheHits}</b></span><span>预筛排除 <b>{status.performance.prefilterExcluded}</b></span><span>扫描耗时 <b>{number(status.performance.elapsedMs / 1000, 1)} 秒</b></span></div>}<details className="trend-coverage-details"><summary>板块覆盖与扫描详情<ChevronDown size={14} /></summary><p>{status?.note || "点击“扫描全 A 股”载入名单与历史日线；首次扫描可能需要较长时间。"}</p><div className="trend-board-list">{status?.boards.length ? status.boards.map((board) => <div key={board.id} className="trend-board"><b>{board.label || boardNames[board.id] || board.id}</b><span>{count(board.loaded)} / {board.expected == null ? "未知" : count(board.expected)}</span><em className={board.complete ? "is-complete" : ""}>{board.complete ? "完整" : "部分"}</em>{board.error && <small>{board.error}</small>}</div>) : <p>尚无板块覆盖信息。</p>}</div><div className="trend-status-meta"><span>任务更新 {dateTime(status?.updatedAt)}</span><span>任务编号 {status?.jobId || "—"}</span><span>{status?.isPreview ? "数据性质：DEMO 虚构演示" : "数据由独立扫描服务返回；以失败明细与覆盖情况核验可用性。"}</span></div></details>{status && (status.errors.length > 0 || status.failed > 0) && <details className="trend-failures"><summary><AlertTriangle size={13} />扫描问题与失败明细（{status.errors.length} 条）</summary><ul>{status.errors.map((item, index) => <li key={`${item.stage}-${item.code || index}`}><b>{item.stage}{item.code ? ` · ${item.code}` : ""}</b> {item.message}</li>)}</ul></details>}</section>

      </aside></details>
    </div>
  </div>;
}
