import { useEffect, useId, useRef, useState } from "react";
import {
  BarChart3, CheckCircle2, ChevronLeft, CircleDot, Database, Download, LineChart,
  LoaderCircle, Search, Target
} from "lucide-react";
import { ErrorState, PageHeading, PanelTitle } from "../../components/terminal/TerminalPrimitives";
import { fmt } from "../../domain/formatters";
import { clampNumber, riskProfileLabel, strategyOptions } from "../../domain/settings";
import { executionStatusLabel, tradeSignalLabel } from "../../domain/executionLabels";
import { shanghaiDateTag as todayTag } from "../../dateUtils";
import { normalizeBacktestDraft, normalizeBacktestStrategyIds, normalizeBacktestStrategyProfile } from "./backtestModel";
import { overfitRiskLabel } from "./backtestLabels";
import type { BacktestExecutionReadiness } from "../../domain/executionReadiness";
import type { BacktestBenchmark, BacktestDraft, BacktestHistoryRecord, BacktestViewProps } from "./backtestTypes";

export function BacktestView({
  draft,
  loading,
  error,
  result,
  runRecord = null,
  history,
  profileComparisons,
  onDraftChange,
  onInvalidateRun,
  onRun,
  onRunProfileComparisons,
  onApplyProfileComparison,
  onLoadHistory,
  onExportHistory,
  onExportCurrent,
  onApplyCurrent,
  onApplyHistory,
  onClearHistory,
  onBack,
  backLabel,
  entryContext,
  onTargetChange,
  currentSettings,
  executionProfile,
  profileDiff,
  evaluateBacktestExecutionReadiness,
  buildBacktestExecutionPlan,
  onOpenPortfolio
}: BacktestViewProps & { runRecord?: BacktestHistoryRecord | null }) {
  const resultDraft = runRecord?.draft || draft;
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const metrics = result?.metrics && typeof result.metrics === "object" ? result.metrics : null;
  const walkForwardValidation = result?.walkForwardValidation && typeof result.walkForwardValidation === "object"
    ? result.walkForwardValidation
    : null;
  const strategyIds = Array.isArray(result?.strategyIds) ? result.strategyIds : [];
  const benchmark = result?.benchmarkReturns && typeof result.benchmarkReturns === "object" ? result.benchmarkReturns : null;
  const historicalSamplePath = result?.historicalSamplePath && typeof result.historicalSamplePath === "object"
    ? result.historicalSamplePath
    : null;
  const historicalSamplePoints = Array.isArray(historicalSamplePath?.points)
    ? historicalSamplePath.points
    : [];
  const tradeLedger = Array.isArray(result?.trades) ? result.trades : [];
  const profitSummary = result?.profitSummary && typeof result.profitSummary === "object"
    ? result.profitSummary
    : null;
  const strategyBreakdown = Array.isArray(result?.strategyBreakdown)
    ? result.strategyBreakdown
    : [];
  const backtestRange = result?.range && typeof result.range === "object"
    ? result.range
    : null;
  const contextStrategyIds = normalizeBacktestStrategyIds(
    draft.strategyContext?.strategyIds || entryContext?.strategyIds
  );
  const contextProfile = contextStrategyIds.length
    ? normalizeBacktestStrategyProfile(
      { selectedStrategies: contextStrategyIds },
      currentSettings,
      draft,
      contextStrategyIds
    )
    : executionProfile;
  const resultProfile = runRecord?.strategyProfile || (result?.strategyProfile
    ? normalizeBacktestStrategyProfile(
      result.strategyProfile,
      currentSettings,
      draft,
      normalizeBacktestStrategyIds(result.strategyIds || executionProfile.selectedStrategies)
    )
    : contextProfile);
  const profileDiffs = result ? profileDiff(resultProfile) : [];
  const executionReadiness = evaluateBacktestExecutionReadiness(
    metrics,
    profileDiffs,
    result?.tradeExecutionReadiness || result?.executionReadiness
  );
  const executionPlan = buildBacktestExecutionPlan(metrics, executionReadiness, resultProfile);
  const isVerifiedStrategyBacktest =
    result?.strategyEngine === "verified-signal-v2" ||
    resultDraft.strategyContext?.strategyEngine === "verified-signal-v2";
  const canApplyCurrent =
    Boolean(result) &&
    executionReadiness.level !== "block" &&
    !isVerifiedStrategyBacktest;
  const comparisonRunning = Boolean(profileComparisons?.items.some((item) => item.loading));
  const readinessPriority = (level?: BacktestExecutionReadiness["level"]) =>
    level === "pass" ? 3 : level === "wait" ? 2 : level === "block" ? 1 : 0;
  const comparisonRows = [...(profileComparisons?.items || [])]
    .map((item) => {
      const recordMetrics = item.record?.metrics && typeof item.record.metrics === "object"
        ? item.record.metrics
        : null;
      const readiness = item.record
        ? evaluateBacktestExecutionReadiness(
          recordMetrics,
          profileDiff(item.record.strategyProfile),
          item.record.rawResult?.tradeExecutionReadiness || item.record.rawResult?.executionReadiness
        )
        : null;
      const projectedNetEdge = Number(recordMetrics?.projectedNetEdge);
      return {
        ...item,
        readiness,
        projectedNetEdge: Number.isFinite(projectedNetEdge) ? projectedNetEdge : Number.NEGATIVE_INFINITY
      };
    })
    .sort((left, right) => {
      if (left.loading !== right.loading) return left.loading ? 1 : -1;
      const readinessDiff =
        readinessPriority(right.readiness?.level) -
        readinessPriority(left.readiness?.level);
      if (readinessDiff) return readinessDiff;
      if (Boolean(left.record?.accepted) !== Boolean(right.record?.accepted)) {
        return left.record?.accepted ? -1 : 1;
      }
      return right.projectedNetEdge - left.projectedNetEdge;
    });
  const contextSecurity =
    entryContext?.security?.code === draft.securityCode
      ? entryContext.security
      : null;
  const resultSecurity =
    result?.security?.code === draft.securityCode
      ? result.security as Security
      : null;
  const initialSecurity = resultSecurity || contextSecurity;
  const formatSecurityInput = (security?: Security | null, fallbackCode = "") =>
    security?.code
      ? `${security.name && security.name !== security.code ? `${security.name} · ` : ""}${security.code}`
      : fallbackCode;
  const [securityInput, setSecurityInput] = useState(() =>
    formatSecurityInput(initialSecurity, draft.securityCode)
  );
  const [selectedSecurity, setSelectedSecurity] = useState<Security | null>(initialSecurity || null);
  const [securitySuggestions, setSecuritySuggestions] = useState<Security[]>([]);
  const [securitySearching, setSecuritySearching] = useState(false);
  const [securitySuggestionOpen, setSecuritySuggestionOpen] = useState(false);
  const [activeSecurityIndex, setActiveSecurityIndex] = useState(-1);
  const [securityInputError, setSecurityInputError] = useState("");
  const [securitySearchError, setSecuritySearchError] = useState("");
  const [securitySearchCompleted, setSecuritySearchCompleted] = useState(false);
  const [securitySearchAttempt, setSecuritySearchAttempt] = useState(0);
  const [resolvingSecurity, setResolvingSecurity] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ startDate?: string; customEntryPrice?: string }>({});
  const [customEntryPriceInput, setCustomEntryPriceInput] = useState(() => draft.customEntryPrice === null ? "" : String(draft.customEntryPrice));
  const securityInputRef = useRef<HTMLInputElement>(null);
  const startDateRef = useRef<HTMLInputElement>(null);
  const customEntryPriceRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const securityListId = `${inputId}-securities`;
  const securityComposing = useRef(false);
  const securityResolutionId = useRef(0);
  const securitySearchId = useRef(0);
  const securitySuggestionsDismissed = useRef(false);
  useEffect(() => () => { securityResolutionId.current += 1; }, []);
  useEffect(() => { securityResolutionId.current += 1; setResolvingSecurity(false); }, [draft]);
  useEffect(() => {
    setCustomEntryPriceInput((current) => {
      const value = current.trim() === "" ? null : Number(current);
      return Object.is(value, draft.customEntryPrice)
        ? current
        : draft.customEntryPrice === null ? "" : String(draft.customEntryPrice);
    });
  }, [draft.customEntryPrice]);
  const [verifiedStrategies, setVerifiedStrategies] = useState<any[]>([]);
  const [strategyDefinitionError, setStrategyDefinitionError] = useState("");

  useEffect(() => {
    let active = true;
    window.stockApi.getStrategyDefinitions()
      .then((value) => {
        if (!active) return;
        const rows = Array.isArray(value)
          ? value
          : Array.isArray(value?.strategies)
            ? value.strategies
            : Array.isArray(value?.definitions)
              ? value.definitions
              : [];
        // 已从策略选股下线的策略仍可回测复核，名称后标注「已下线」。
        const definitions = rows.filter((item: any) => item?.id && item?.name).map((item: any) => item.retired === true ? { ...item, name: `${item.name}（已下线）` } : item);
        setVerifiedStrategies(definitions);
        setStrategyDefinitionError(definitions.length ? "" : "未取得可回放策略定义");
        if (!latestDraft.current.strategyContext && definitions[0]) {
          const first = definitions[0];
          onDraftChange((current) => current.strategyContext ? current : ({
            ...current,
            strategyContext: {
              source: "single_strategy",
              strategyEngine: "verified-signal-v2",
              strategyId: String(first.id),
              strategyName: String(first.name),
              strategyVersion: "robust-v2",
              strategyIds: [String(first.id)],
              minimumVotes: 1
            }
          }));
        }
      })
      .catch((error) => {
        if (active) setStrategyDefinitionError(error instanceof Error ? error.message : "策略定义加载失败");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    securityResolutionId.current += 1;
    setResolvingSecurity(false);
    const nextSecurity = resultSecurity || contextSecurity;
    setSelectedSecurity(nextSecurity || null);
    setSecurityInput(formatSecurityInput(nextSecurity, draft.securityCode));
    setSecuritySuggestions([]);
    setSecuritySuggestionOpen(false);
    setActiveSecurityIndex(-1);
    setSecurityInputError("");
    setSecuritySearchError("");
    setSecuritySearchCompleted(false);
  }, [
    draft.securityCode,
    contextSecurity?.code,
    contextSecurity?.name,
    resultSecurity?.code,
    resultSecurity?.name
  ]);

  useEffect(() => {
    const request = ++securitySearchId.current;
    const keyword = securityInput.trim();
    const selectedText = formatSecurityInput(selectedSecurity, selectedSecurity?.code || "");
    if (keyword.length < 2 || (selectedSecurity && keyword === selectedText)) {
      setSecuritySuggestions([]);
      setSecuritySearching(false);
      setSecuritySearchCompleted(false);
      return;
    }
    let active = true;
    setSecuritySearching(true);
    setSecuritySearchError("");
    setSecuritySearchCompleted(false);
    const timer = window.setTimeout(async () => {
      try {
        const rows = await window.stockApi.search(keyword);
        if (!active || request !== securitySearchId.current) return;
        if (!Array.isArray(rows)) throw new Error("搜索响应无效");
        const suggestions = rows
            .filter((item) => /^\d{6}$/.test(String(item?.code || "")))
            .filter((item) => !item.assetType || item.assetType === "stock")
            .slice(0, 8);
        setSecuritySuggestions(suggestions);
        setActiveSecurityIndex(suggestions.length ? 0 : -1);
        setSecuritySearchCompleted(true);
        setSecuritySuggestionOpen(!securitySuggestionsDismissed.current);
      } catch {
        if (active && request === securitySearchId.current) {
          setSecuritySuggestions([]);
          setActiveSecurityIndex(-1);
          setSecuritySearchError("股票搜索失败，请检查网络后重试");
        }
      } finally {
        if (active && request === securitySearchId.current) setSecuritySearching(false);
      }
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [securityInput, selectedSecurity?.code, selectedSecurity?.name, securitySearchAttempt]);

  const chooseSecurity = (security: Security, sourceLabel = "回测中心搜索") => {
    securityResolutionId.current += 1;
    securitySearchId.current += 1;
    setResolvingSecurity(false);
    setSecuritySearching(false);
    const normalized: Security = {
      ...security,
      code: String(security.code || ""),
      name: String(security.name || security.code || ""),
      secid: String(security.secid || "")
    };
    setSelectedSecurity(normalized);
    setSecurityInput(formatSecurityInput(normalized, normalized.code));
    setSecuritySuggestions([]);
    setSecuritySuggestionOpen(false);
    setActiveSecurityIndex(-1);
    setSecurityInputError("");
    setSecuritySearchError("");
    setSecuritySearchCompleted(false);
    onDraftChange((current) => ({
      ...current,
      securityCode: normalized.code,
      security: normalized
    }));
    onTargetChange(normalized, sourceLabel);
    return normalized;
  };

  const resolveSecurityInput = async (intent: number) => {
    const keyword = securityInput.trim();
    if (!keyword) {
      setSecurityInputError("请输入股票名称或6位代码");
      return null;
    }
    const selectedText = formatSecurityInput(selectedSecurity, selectedSecurity?.code || "");
    if (selectedSecurity && keyword === selectedText) return selectedSecurity;
    const embeddedCode = keyword.match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1] || "";
    let candidates = securitySuggestions;
    try {
      if (!candidates.length || embeddedCode) {
        const rows = await window.stockApi.search(embeddedCode || keyword);
        if (!Array.isArray(rows)) throw new Error("搜索响应无效");
        candidates = rows
          .filter((item) => /^\d{6}$/.test(String(item?.code || "")))
          .filter((item) => !item.assetType || item.assetType === "stock");
      }
    } catch {
      if (intent === securityResolutionId.current) {
        setSecuritySuggestions([]);
        setActiveSecurityIndex(-1);
        setSecurityInputError("");
        setSecuritySearchCompleted(false);
        setSecuritySearchError("股票搜索失败，请检查网络后重试");
      }
      return null;
    }
    if (intent !== securityResolutionId.current) return null;
    const exact = candidates.find((item) => item.code === embeddedCode) ||
      candidates.find((item) => item.name === keyword) ||
      (candidates.length === 1 ? candidates[0] : null);
    if (exact) return exact;
    setSecuritySuggestions(candidates.slice(0, 8));
    setActiveSecurityIndex(candidates.length ? 0 : -1);
    setSecuritySearchCompleted(true);
    setSecuritySearchError("");
    setSecuritySuggestionOpen(true);
    setSecurityInputError(
      candidates.length
        ? "找到多只股票，请从候选列表选择"
        : "未找到对应A股，请检查名称或代码"
    );
    return null;
  };

  const runWithResolvedSecurity = async (runner: (next: BacktestDraft) => void) => {
    if (resolvingSecurity || loading || comparisonRunning) return;
    const errors: typeof fieldErrors = {};
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(draft.startDate)
      ? new Date(`${draft.startDate}T00:00:00Z`)
      : null;
    if (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== draft.startDate) {
      errors.startDate = "请选择有效的开始日期";
    } else if (draft.startDate < "2010-01-01" || draft.startDate > todayTag()) {
      errors.startDate = `开始日期须在2010-01-01至${todayTag()}之间`;
    }
    const priceText = customEntryPriceInput.trim();
    const isDecimalPrice = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(priceText);
    if (draft.customEntryPrice !== null && (!isDecimalPrice || !Number.isFinite(draft.customEntryPrice) || draft.customEntryPrice < 0.001 || draft.customEntryPrice > 1_000_000)) {
      errors.customEntryPrice = "自定义买入价须在0.001至1000000元之间，或留空使用历史次日开盘价";
    }
    setFieldErrors(errors);
    if (errors.startDate || errors.customEntryPrice) {
      (errors.startDate ? startDateRef : customEntryPriceRef).current?.focus();
      return;
    }
    const intent = ++securityResolutionId.current;
    securitySearchId.current += 1;
    setSecuritySearching(false);
    setResolvingSecurity(true);
    try {
      const security = await resolveSecurityInput(intent);
      if (intent !== securityResolutionId.current) return;
      if (!security) {
        securityInputRef.current?.focus();
        return;
      }
      let strategyContext = draft.strategyContext;
      if (!strategyContext) {
        const definition = verifiedStrategies[0];
        if (!definition) {
          setSecurityInputError(strategyDefinitionError || "请先选择一套策略");
          return;
        }
        strategyContext = {
          source: "single_strategy",
          strategyEngine: "verified-signal-v2",
          strategyId: String(definition.id),
          strategyName: String(definition.name),
          strategyVersion: "robust-v2",
          strategyIds: [String(definition.id)],
          minimumVotes: 1
        };
      }
      chooseSecurity(security);
      const next = {
        ...draft,
        securityCode: security.code,
        security,
        strategyContext
      };
      onDraftChange(() => next);
      runner(next);
    } finally {
      if (intent === securityResolutionId.current) setResolvingSecurity(false);
    }
  };

  const effectiveStrategyIds = normalizeBacktestStrategyIds(
    runRecord?.strategyIds.length
      ? runRecord.strategyIds
      : strategyIds.length
      ? strategyIds
      : contextStrategyIds.length
        ? contextStrategyIds
        : executionProfile.selectedStrategies
  );
  const strategyNameById = new Map(strategyOptions.map((item) => [item.id, item.name]));
  const verifiedStrategyNameById = new Map(
    verifiedStrategies.map((item) => [String(item.id), String(item.name)])
  );
  const selectedVerifiedStrategyIds = normalizeBacktestStrategyIds(
    draft.strategyContext?.strategyIds
  );
  const updateVerifiedStrategySelection = (
    strategyIds: string[],
    requestedMinimumVotes?: number
  ) => {
    const allowedIds = new Set(verifiedStrategies.map((item) => String(item.id)));
    const nextIds = normalizeBacktestStrategyIds(strategyIds).filter((id) => allowedIds.has(id));
    if (!nextIds.length) return;
    const names = nextIds.map((id) => verifiedStrategyNameById.get(id) || id);
    const minimumVotes = clampNumber(
      requestedMinimumVotes ?? draft.strategyContext?.minimumVotes,
      1,
      nextIds.length,
      1
    );
    onDraftChange((current) => ({
      ...current,
      strategyContext: {
        source: "single_strategy",
        strategyEngine: "verified-signal-v2",
        strategyId: nextIds.length > 1 ? "custom_strategy_vote" : String(nextIds[0]),
        strategyName: nextIds.length > 1 ? `多策略组合（${nextIds.length}套）` : String(names[0]),
        strategyVersion: "robust-v2",
        strategyIds: nextIds,
        minimumVotes
      }
    }));
  };
  const toggleVerifiedStrategy = (strategyId: string) => {
    const selected = new Set(selectedVerifiedStrategyIds);
    if (selected.has(strategyId)) {
      if (selected.size === 1) return;
      selected.delete(strategyId);
    } else {
      selected.add(strategyId);
    }
    updateVerifiedStrategySelection([...selected]);
  };
  const setMinimumStrategyVotes = (value: number) => {
    updateVerifiedStrategySelection(selectedVerifiedStrategyIds, value);
  };
  const verifiedComponentNames: string[] = Array.isArray(result?.strategyContext?.componentNames)
    ? result.strategyContext.componentNames.map(String).filter(Boolean)
    : [];
  const effectiveStrategyNames = isVerifiedStrategyBacktest
    ? verifiedComponentNames.length
      ? verifiedComponentNames
      : effectiveStrategyIds.length === 1 && resultDraft.strategyContext?.strategyName
        ? [resultDraft.strategyContext.strategyName]
        : effectiveStrategyIds.map((id) => verifiedStrategyNameById.get(id) || id)
    : effectiveStrategyIds.map((id) => strategyNameById.get(id) || id);
  const displayedSecurity = selectedSecurity || resultSecurity || contextSecurity;
  const resultSetupChanged = Boolean(result && runRecord) && (
    JSON.stringify(normalizeBacktestDraft(draft)) !== JSON.stringify(normalizeBacktestDraft(runRecord!.draft)) ||
    securityInput.trim() !== formatSecurityInput(selectedSecurity, draft.securityCode)
  );
  const format = (value: unknown, digits = 2) => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "--";
  };

  const setNumber = (key: keyof BacktestDraft, value: number) => {
    if (!Number.isFinite(value)) return;
    onDraftChange((current) => ({ ...current, [key]: value }));
  };
  const canExport = Boolean(result);

  return (
    <>
      <PageHeading
        eyebrow="HISTORY BACKTEST"
        title="策略单股回测"
        description="选择一套或多套策略、一只股票和起始日期，逐笔回放历史买卖，并直接对比各策略与组合收益。"
        actions={
          <>
            <button className="secondary-btn" onClick={onBack}>
              <ChevronLeft size={17} />
              {backLabel}
            </button>
            <button className="secondary-btn" onClick={onOpenPortfolio}>
              <BarChart3 size={17} />
              多股组合回测
            </button>
            <button
              className="primary-btn"
              disabled={loading || comparisonRunning || resolvingSecurity}
              onClick={() => runWithResolvedSecurity(onRun)}
            >
              {loading || resolvingSecurity ? <LoaderCircle className="spin" size={17} /> : <LineChart size={17} />}
              {resolvingSecurity ? "确认股票" : "从所选日期开始回测"}
            </button>
            {loading && <button className="secondary-btn" onClick={onInvalidateRun}>取消回测</button>}
            <button className="secondary-btn" disabled={!canExport} onClick={() => onExportCurrent("csv")}>
              <Download size={17} />
              导出CSV
            </button>
            <button className="secondary-btn" disabled={!canExport} onClick={() => onExportCurrent("json")}>
              <Download size={17} />
              导出JSON
            </button>
            <button
              className="secondary-btn"
              disabled={!canApplyCurrent}
              title={
                isVerifiedStrategyBacktest
                  ? "策略信号规则与设置页执行因子属于不同口径，不会写入全局执行设置"
                  : executionReadiness.level === "block"
                  ? executionReadiness.recommendation
                  : executionReadiness.level === "wait"
                    ? "建议先执行纸面验证后再应用"
                    : "应用当前回测的参数快照到执行设置"
              }
              onClick={() => onApplyCurrent()}
            >
              <Target size={17} />
              {isVerifiedStrategyBacktest
                ? "策略规则仅本次使用"
                : executionReadiness.level === "wait"
                  ? "应用到执行（需确认）"
                  : "应用到执行策略"}
            </button>
          </>
        }
      />
      <details className="backtest-context-disclosure"><summary>本次回放上下文与口径</summary><section className="panel backtest-context-panel">
        <div className="backtest-context-head">
          <div>
            <Target size={18} />
            <span><b>本次回放上下文</b><small>先确认股票和策略口径，再解释回测结果</small></span>
          </div>
          <em>{entryContext?.sourceLabel || "回测中心手工选择"}</em>
        </div>
        <div className="backtest-context-grid">
          <div>
            <span>回测对象</span>
            <b>{runRecord?.securityName || displayedSecurity?.name || "待选择股票"}</b>
            <small>{runRecord?.securityCode || displayedSecurity?.code || "支持股票名称 / 6位代码"}</small>
          </div>
          <div>
            <span>实际策略快照</span>
            <b>
              {isVerifiedStrategyBacktest
                ? result?.strategyContext?.strategyName || resultDraft.strategyContext?.strategyName || "已验证策略"
                : `${effectiveStrategyIds.length} 个执行因子`}
            </b>
            <small>
              {isVerifiedStrategyBacktest
                ? `${effectiveStrategyIds.length} 套冻结规则 · 至少 ${result?.minimumVotes || resultDraft.strategyContext?.minimumVotes || 1} 票`
                : `${riskProfileLabel(resultProfile.riskProfile)} · 风险否决始终启用`}
            </small>
          </div>
          <div>
            <span>验证对象</span>
            <b>单只股票历史事件</b>
            <small>不是全市场横截面策略排名</small>
          </div>
          <div>
            <span>回测区间</span>
            <b>{resultDraft.startDate} 至最新交易日</b>
            <small>起始日前数据只用于指标预热，不计入收益</small>
          </div>
        </div>
        <div className="backtest-context-strategies">
          <span>参与回放</span>
          <div>
            {effectiveStrategyNames.slice(0, 9).map((name) => <em key={name}>{name}</em>)}
            {effectiveStrategyNames.length > 9 && <em>+{effectiveStrategyNames.length - 9}</em>}
            {!effectiveStrategyNames.length && <em className="missing">尚未配置执行因子</em>}
          </div>
        </div>
        <p className="backtest-context-note">
          {isVerifiedStrategyBacktest
            ? `当前回放严格复用策略信号引擎 robust-v2 的 ${effectiveStrategyIds.length} 套已选规则；同日达到至少 ${resultDraft.strategyContext?.minimumVotes || 1} 票才形成组合信号。默认次日开盘入场；填写自定义买入价后，仅在次日价格区间触达时成交。固定持有五日并扣除佣金/滑点，不会污染全局设置。`
            : "当前回放使用设置页保存的执行因子组合与成本参数：普通因子按组合门槛判定，风险否决必须通过。若要比较不同策略谁更优，应使用策略选股页的全市场样本外验证，而不是用单只股票结果代替。"}
        </p>
      </section></details>
      <div className="backtest-layout">
        <section className="panel backtest-setup-panel">
          <PanelTitle title="回测条件" subtitle="多选策略后设置共振门槛，再选择股票、日期和买入方式" icon={LineChart} />
          <div className="backtest-form-grid" data-single-stock-backtest>
            <div className="field backtest-primary-field backtest-strategy-picker" data-backtest-strategy-picker>
              <div className="backtest-strategy-picker-head">
                <span>1. 回测策略 <b>已选 {selectedVerifiedStrategyIds.length} 套</b></span>
                <div>
                  <button
                    type="button"
                    onClick={() => updateVerifiedStrategySelection(
                      verifiedStrategies.map((item) => String(item.id)),
                      draft.strategyContext?.minimumVotes || 1
                    )}
                    disabled={!verifiedStrategies.length || selectedVerifiedStrategyIds.length === verifiedStrategies.length}
                  >全选</button>
                  <button
                    type="button"
                    onClick={() => updateVerifiedStrategySelection([
                      selectedVerifiedStrategyIds[0] || String(verifiedStrategies[0]?.id || "")
                    ], 1)}
                    disabled={selectedVerifiedStrategyIds.length <= 1}
                  >仅保留一套</button>
                </div>
              </div>
              <div className="backtest-strategy-options">
                {verifiedStrategies.map((item) => {
                  const strategyId = String(item.id);
                  const checked = selectedVerifiedStrategyIds.includes(strategyId);
                  return (
                    <label key={strategyId} className={checked ? "selected" : ""}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={checked && selectedVerifiedStrategyIds.length === 1}
                        data-strategy-id={strategyId}
                        onChange={() => toggleVerifiedStrategy(strategyId)}
                      />
                      <span><b>{String(item.name)}</b><small>{String(item.detail || "同策略中心冻结规则")}</small></span>
                    </label>
                  );
                })}
              </div>
              <div className="backtest-vote-control">
                <span>同一交易日最少命中</span>
                <input
                  type="number"
                  min="1"
                  max={Math.max(1, selectedVerifiedStrategyIds.length)}
                  value={draft.strategyContext?.minimumVotes || 1}
                  data-backtest-minimum-votes
                  onChange={(event) => setMinimumStrategyVotes(Number(event.target.value))}
                />
                <b>/ {selectedVerifiedStrategyIds.length || 1} 套</b>
                <small>设为1表示任一已选策略命中即可买入；提高票数表示只测同日共振。</small>
              </div>
              {strategyDefinitionError && <small className="field-error">{strategyDefinitionError}</small>}
            </div>
            <label className="field backtest-security-field">
              <span>2. 回测股票 <b>{displayedSecurity?.code || draft.securityCode || "未选择"}</b></span>
              <div className={`backtest-security-search ${securityInputError || securitySearchError ? "invalid" : ""}`}>
                <Search size={16} />
                <input
                  ref={securityInputRef}
                  type="text"
                  maxLength={40}
                  autoComplete="off"
                  role="combobox"
                  aria-label="回测股票"
                  aria-autocomplete="list"
                  aria-expanded={securitySuggestionOpen && securitySuggestions.length > 0}
                  aria-controls={securityListId}
                  aria-activedescendant={securitySuggestionOpen && activeSecurityIndex >= 0 && securitySuggestions[activeSecurityIndex]
                    ? `${securityListId}-${activeSecurityIndex}` : undefined}
                  aria-invalid={Boolean(securityInputError || securitySearchError)}
                  aria-describedby={`${inputId}-security-help`}
                  value={securityInput}
                  onCompositionStart={() => { securityComposing.current = true; }}
                  onCompositionEnd={() => { securityComposing.current = false; }}
                  onFocus={() => {
                    securitySuggestionsDismissed.current = false;
                    setSecuritySuggestionOpen(Boolean(securitySuggestions.length));
                  }}
                  onChange={(event) => {
                    securityResolutionId.current += 1;
                    securitySearchId.current += 1;
                    securitySuggestionsDismissed.current = false;
                    setResolvingSecurity(false);
                    onInvalidateRun();
                    setSecurityInput(event.target.value);
                    setSelectedSecurity(null);
                    setSecuritySuggestions([]);
                    setActiveSecurityIndex(-1);
                    setSecurityInputError("");
                    setSecuritySearchError("");
                    setSecuritySearchCompleted(false);
                    setSecuritySuggestionOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (securityComposing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Escape") {
                      event.preventDefault();
                      securitySuggestionsDismissed.current = true;
                      setSecuritySuggestionOpen(false);
                      setActiveSecurityIndex(-1);
                      return;
                    }
                    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && securitySuggestions.length) {
                      event.preventDefault();
                      securitySuggestionsDismissed.current = false;
                      setSecuritySuggestionOpen(true);
                      const direction = event.key === "ArrowDown" ? 1 : -1;
                      setActiveSecurityIndex((current) => current < 0
                        ? direction > 0 ? 0 : securitySuggestions.length - 1
                        : (current + direction + securitySuggestions.length) % securitySuggestions.length);
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (securitySuggestionOpen && securitySuggestions.length) {
                        const active = securitySuggestions[Math.max(0, activeSecurityIndex)];
                        if (active) chooseSecurity(active);
                        return;
                      }
                      runWithResolvedSecurity(onRun);
                    }
                  }}
                  placeholder="输入股票名称或6位代码，例如 贵州茅台 / 600519"
                />
                {securitySearching && <LoaderCircle className="spin" size={15} />}
                {securitySuggestionOpen && securitySuggestions.length > 0 && (
                  <div className="backtest-security-suggestions" id={securityListId} role="listbox" aria-label="股票候选">
                    {securitySuggestions.map((item, index) => (
                      <button
                        type="button"
                        key={`${item.code}-${item.secid}`}
                        id={`${securityListId}-${index}`}
                        role="option"
                        aria-selected={activeSecurityIndex === index}
                        tabIndex={-1}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveSecurityIndex(index)}
                        onClick={() => chooseSecurity(item)}
                      >
                        <span><b>{item.name}</b><small>{item.code}</small></span>
                        <em>{item.marketName || item.thscode?.split(".")[1] || "A股"}</em>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <small id={`${inputId}-security-help`} className={securityInputError || securitySearchError ? "field-error" : ""} aria-live="polite">
                {securitySearchError || securityInputError || (securitySearching ? "正在搜索股票…" : securitySuggestionOpen && securitySearchCompleted && !securitySuggestions.length
                  ? "未找到对应A股，请检查名称或代码" : entryContext?.security?.code === draft.securityCode
                  ? `已沿用${entryContext.sourceLabel}选择的股票，可直接运行`
                  : "支持中文名称、简称或6位代码；名称有重名时请从候选中选择")}
              </small>
              {securitySearchError && (
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={securitySearching || resolvingSecurity}
                  onClick={() => {
                    securityResolutionId.current += 1;
                    securitySuggestionsDismissed.current = false;
                    setSecurityInputError("");
                    setSecuritySearchError("");
                    setSecuritySuggestionOpen(true);
                    setSecuritySearchAttempt((current) => current + 1);
                    securityInputRef.current?.focus();
                  }}
                >重试搜索</button>
              )}
            </label>
            <label className="field backtest-primary-field">
              <span>3. 开始日期 <b>{draft.startDate}</b></span>
              <input
                ref={startDateRef}
                type="date"
                min="2010-01-01"
                max={todayTag()}
                value={draft.startDate}
                data-backtest-start-date
                aria-invalid={Boolean(fieldErrors.startDate)}
                aria-describedby={`${inputId}-date-help`}
                onChange={(event) => {
                  setFieldErrors((current) => ({ ...current, startDate: "" }));
                  onDraftChange((current) => ({ ...current, startDate: event.target.value }));
                }}
              />
              <small id={`${inputId}-date-help`} className={fieldErrors.startDate ? "field-error" : ""} aria-live="polite">
                {fieldErrors.startDate || "只统计该日期及之后产生的策略信号；系统会自动多取预热行情"}
              </small>
            </label>
            <label className="field backtest-primary-field">
              <span>4. 自定义买入价 <b>{fieldErrors.customEntryPrice ? "请修正买入价" : customEntryPriceInput.trim() ? `${customEntryPriceInput} 元` : "按次日开盘"}</b></span>
              <input
                ref={customEntryPriceRef}
                type="text"
                maxLength={40}
                inputMode="decimal"
                value={customEntryPriceInput}
                data-backtest-custom-entry-price
                aria-invalid={Boolean(fieldErrors.customEntryPrice)}
                aria-describedby={`${inputId}-price-help`}
                placeholder="留空则按历史次日开盘价"
                onChange={(event) => {
                  setCustomEntryPriceInput(event.target.value);
                  setFieldErrors((current) => ({ ...current, customEntryPrice: "" }));
                  onDraftChange((current) => ({ ...current, customEntryPrice: event.target.value.trim() === "" ? null : Number(event.target.value) }));
                }}
              />
              <small id={`${inputId}-price-help`} className={fieldErrors.customEntryPrice ? "field-error" : ""} aria-live="polite">
                {fieldErrors.customEntryPrice || "填写后按限价成交：下一交易日价格区间触达才买入，未触达不计收益"}
              </small>
            </label>
            <details className="backtest-advanced-options">
              <summary>高级参数（成本、基准和准入条件）</summary>
              <div className="backtest-form-grid">
              <label className="field">
              <span>取值标尺（最近几次基准） <b>{draft.benchmarks}</b></span>
              <input
                type="number"
                min="1"
                max="10"
                value={draft.benchmarks}
                onChange={(event) => setNumber("benchmarks", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>基准指数 <b>{draft.benchmark}</b></span>
              <select
                value={draft.benchmark}
                onChange={(event) => onDraftChange((current) => ({
                  ...current,
                  benchmark: event.target.value as BacktestBenchmark
                }))}
                className="backtest-select"
              >
                <option value="all">中证全指</option>
                <option value="szzs">上证指数</option>
                <option value="hs300">沪深300</option>
              </select>
            </label>
            <label className="field">
              <span>最小样本数 <b>{draft.minSamples}</b></span>
              <input
                type="number"
                min="1"
                max="300"
                value={draft.minSamples}
                onChange={(event) => setNumber("minSamples", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>最小预期净收益% <b>{draft.minProjectedNetEdgePercent}</b></span>
              <input
                type="number"
                min="-2"
                max="10"
                step="0.05"
                value={draft.minProjectedNetEdgePercent}
                onChange={(event) => setNumber("minProjectedNetEdgePercent", Number(event.target.value))}
              />
            </label>
          <label className="field">
            <span>最小期望值 <b>{draft.minExpectancyPoints}</b></span>
            <input
              type="number"
                min="-2"
                max="8"
                step="0.05"
                value={draft.minExpectancyPoints}
              onChange={(event) => setNumber("minExpectancyPoints", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>最小成交额(元) <b>{draft.minQuoteAmount}</b></span>
            <input
              type="number"
              min="0"
              max="8000000"
              step="100000"
              value={draft.minQuoteAmount}
              onChange={(event) => setNumber("minQuoteAmount", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>最小换手率(%) <b>{draft.minTurnoverPercent}</b></span>
            <input
              type="number"
              min="0"
              max="10"
              step="0.05"
              value={draft.minTurnoverPercent}
              onChange={(event) => setNumber("minTurnoverPercent", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>行情新鲜度上限(秒) <b>{draft.maxQuoteAgeSeconds}</b></span>
            <input
              type="number"
              min="30"
              max="1800"
              step="15"
              value={draft.maxQuoteAgeSeconds}
              onChange={(event) => setNumber("maxQuoteAgeSeconds", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>佣金 BPS <b>{draft.commissionBps}</b></span>
            <input
                type="number"
                min="0"
                max="60"
                step="0.1"
                value={draft.commissionBps}
                onChange={(event) => setNumber("commissionBps", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>滑点 BPS <b>{draft.slippageBps}</b></span>
              <input
                type="number"
                min="0"
                max="60"
                step="0.1"
                value={draft.slippageBps}
                onChange={(event) => setNumber("slippageBps", Number(event.target.value))}
              />
            </label>
              </div>
            </details>
          </div>
        </section>

        <section className="panel backtest-result-panel">
          <PanelTitle
            title="回测结果"
            subtitle={result
              ? `标的 ${result.security?.name || runRecord?.securityName || resultDraft.securityCode || "--"}`
              : "运行后展示样本与收益判断"}
            icon={LineChart}
            badge={result?.metrics?.accepted ? "预检通过" : result ? "预检未通过" : "等待运行"}
          />
          {error && <ErrorState message={error} />}
          {resultSetupChanged && <div className="warning-banner" role="status">回测条件已更改，当前显示和导出的仍是上次完成的运行快照；应用参数也使用该快照。请重新运行以计算新条件。</div>}
          {!result && !error && (
            <div className="backtest-empty-result" data-backtest-empty-result>
              <div className="backtest-empty-result-title">
                <LineChart size={22} />
                <div>
                  <b>等待生成单股回测结果</b>
                  <small>按左侧条件运行后，这里会先展示收益，再展示逐笔交易和策略拆分。</small>
                </div>
              </div>
              <ol>
                <li><span>策略</span><b>已选 {selectedVerifiedStrategyIds.length} 套 · 至少命中 {draft.strategyContext?.minimumVotes || 1} 套</b></li>
                <li><span>标的</span><b>{displayedSecurity?.name || securityInput || "请选择一只股票"}</b></li>
                <li><span>买入</span><b>{draft.customEntryPrice ? `${draft.customEntryPrice} 元触达成交` : "信号次日开盘成交"}</b></li>
              </ol>
            </div>
          )}
          {result && metrics && (
            <>
              <div className="backtest-profit-overview" data-backtest-profit-overview>
                <div className="backtest-profit-range">
                  <span>实际回测区间</span>
                  <b>{backtestRange?.signalFrom || resultDraft.startDate} 至 {backtestRange?.signalTo || "最新交易日"}</b>
                  <small>
                    历史行情 {backtestRange?.historyBars ?? result.lookbackBars ?? "--"} 根 · 起始资金 {fmt(profitSummary?.startingCapital)} 元 · 单次仓位 {format(profitSummary?.positionPercent)}% · {result.entryPriceMode === "custom_limit_price" ? `自定义买入价 ${format(result.customEntryPrice, 3)} 元` : "次日开盘买入"}
                  </small>
                </div>
                <div className="backtest-profit-grid">
                  <div>
                    <span>累计净收益</span>
                    <b className={Number(profitSummary?.totalNetReturnPercent) >= 0 ? "red" : "green"}>
                      {format(profitSummary?.totalNetReturnPercent)}%
                    </b>
                  </div>
                  <div>
                    <span>累计盈亏</span>
                    <b className={Number(profitSummary?.totalProfitAmount) >= 0 ? "red" : "green"}>
                      {fmt(profitSummary?.totalProfitAmount)} 元
                    </b>
                  </div>
                  <div><span>完成交易</span><b>{profitSummary?.tradeCount ?? 0} 笔</b></div>
                  <div><span>盈利 / 亏损</span><b>{profitSummary?.profitableTrades ?? 0} / {profitSummary?.losingTrades ?? 0}</b></div>
                  <div><span>交易胜率</span><b>{format(profitSummary?.winRatePercent)}%</b></div>
                  <div><span>资金最大回撤</span><b className="green">{format(profitSummary?.maxDrawdownPercent)}%</b></div>
                </div>
              </div>
              {strategyBreakdown.length > 1 && (
                <div className="backtest-strategy-breakdown" data-backtest-strategy-breakdown>
                  <div className="backtest-trade-ledger-head">
                    <div><strong>各策略独立收益对比</strong><small>每套策略单独运行，便于判断是哪一套策略贡献或拖累收益；下方逐笔账本是按所设票数形成的组合结果。</small></div>
                    <em>{strategyBreakdown.length} 套</em>
                  </div>
                  <div className="backtest-trade-table-wrap">
                    <table className="backtest-trade-table backtest-strategy-table">
                      <thead><tr><th>策略</th><th>完成交易</th><th>盈利 / 亏损</th><th>胜率</th><th>累计净收益</th><th>累计盈亏</th><th>最大回撤</th></tr></thead>
                      <tbody>
                        {strategyBreakdown.map((item: any) => (
                          <tr key={String(item.strategyId)}>
                            <td>{item.strategyName}<small>{item.strategyId}</small></td>
                            <td>{item.tradeCount ?? 0} 笔</td>
                            <td>{item.profitableTrades ?? 0} / {item.losingTrades ?? 0}</td>
                            <td>{format(item.winRatePercent)}%</td>
                            <td className={Number(item.totalNetReturnPercent) >= 0 ? "red" : "green"}>{format(item.totalNetReturnPercent)}%</td>
                            <td className={Number(item.totalProfitAmount) >= 0 ? "red" : "green"}>{fmt(item.totalProfitAmount)}</td>
                            <td className="green">{format(item.maxDrawdownPercent)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="backtest-trade-ledger" data-backtest-trade-ledger>
                <div className="backtest-trade-ledger-head">
                  <div><strong>组合逐笔买卖与收益</strong><small>{result.entryPriceMode === "custom_limit_price" ? "策略命中后，下一交易日触达自定义买入价才成交" : "策略命中后下一交易日开盘买入"}；固定持有五个交易日卖出，收益已扣除佣金与滑点。</small></div>
                  <em>{tradeLedger.length} 笔</em>
                </div>
                {tradeLedger.length ? (
                  <div className="backtest-trade-table-wrap">
                    <table className="backtest-trade-table">
                      <thead>
                        <tr><th>序号</th><th>命中策略</th><th>信号日</th><th>买入日 / 价</th><th>卖出日 / 价</th><th>单笔净收益</th><th>单笔盈亏</th><th>累计收益</th></tr>
                      </thead>
                      <tbody>
                        {tradeLedger.map((trade: any) => (
                          <tr key={`${trade.sequence}-${trade.signalDate}-${trade.entryDate}`}>
                            <td>{trade.sequence}</td>
                            <td>
                              {(Array.isArray(trade.strategyIds) ? trade.strategyIds : [])
                                .slice(0, 2)
                                .map((id: string) => verifiedStrategyNameById.get(id) || id)
                                .join("、") || "组合信号"}
                              {Array.isArray(trade.strategyIds) && trade.strategyIds.length > 2
                                ? <small>+{trade.strategyIds.length - 2} 套</small>
                                : null}
                            </td>
                            <td>{trade.signalDate}</td>
                            <td>{trade.entryDate}<small>{format(trade.entryPrice, 3)}</small></td>
                            <td>{trade.exitDate}<small>{format(trade.exitPrice, 3)}</small></td>
                            <td className={Number(trade.netReturnPercent) >= 0 ? "red" : "green"}>{format(trade.netReturnPercent)}%</td>
                            <td className={Number(trade.profitAmount) >= 0 ? "red" : "green"}>{fmt(trade.profitAmount)}</td>
                            <td className={Number(trade.cumulativeReturnPercent) >= 0 ? "red" : "green"}>{format(trade.cumulativeReturnPercent)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-inline">所选策略在这只股票的所选日期范围内没有形成可完成的买卖，累计收益为 0。</div>
                )}
              </div>
              <details className="backtest-diagnostics">
                <summary>专业验证与风控诊断</summary>
                <div className="backtest-diagnostics-body">
              <div className={`qualification-strip ${metrics.accepted ? "qualified" : "waiting"}`}>
                {metrics.accepted ? <CheckCircle2 size={18} /> : <CircleDot size={18} />}
                <div>
                  <b>{metrics.accepted ? "回测通过预检" : "回测未通过预检"}</b>
                  <small>{metrics.passReason || "参数未满足全部过滤条件"}</small>
                </div>
              </div>
              <div className={`backtest-quality-card walk-forward-card ${walkForwardValidation?.accepted ? "pass" : "block"}`}>
                <div className="execution-readiness-header">
                  <strong>滚动样本外验证</strong>
                  <span className={`history-state ${walkForwardValidation?.accepted ? "ok" : "bad"}`}>
                    {walkForwardValidation?.accepted ? "样本外验证通过" : "样本外验证未通过"}
                  </span>
                </div>
                <small>{walkForwardValidation?.reason || "该回测没有可核验的样本外结果，禁止应用到执行策略。"}</small>
                <div className="backtest-walk-forward-metrics">
                  <div><span>样本外样本</span><b>{walkForwardValidation?.oosSampleCount ?? "--"}</b></div>
                  <div><span>窗口通过率</span><b>{walkForwardValidation ? `${format(Number(walkForwardValidation.foldPassRate) * 100, 0)}%` : "--"}</b></div>
                  <div><span>样本外净边际</span><b>{walkForwardValidation ? `${format(walkForwardValidation.oosProjectedNetEdge)}%` : "--"}</b></div>
                  <div><span>样本外胜率</span><b>{walkForwardValidation ? `${format(walkForwardValidation.oosWinRate5)}%` : "--"}</b></div>
                  <div><span>训练外退化</span><b>{walkForwardValidation ? `${format(walkForwardValidation.degradationPercent, 0)}%` : "--"}</b></div>
                  <div><span>过拟合风险</span><b>{overfitRiskLabel(walkForwardValidation?.overfitRisk)}</b></div>
                </div>
                {!!walkForwardValidation?.folds?.length && (
                  <div className="backtest-walk-forward-folds">
                    {walkForwardValidation.folds.map((fold: any) => (
                      <div key={fold.fold}>
                        <span>窗口 {fold.fold} · {fold.testStart || "--"} 至 {fold.testEnd || "--"}</span>
                        <b className={fold.accepted ? "red" : "green"}>
                          {fold.accepted ? "通过" : "未通过"} · 净边际 {format(fold.oosProjectedNetEdge)}%
                        </b>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className={`backtest-quality-card execution-readiness ${executionReadiness.level}`}>
                <div className="execution-readiness-header">
                  <strong>执行决策评分</strong>
                  <span className={`history-state ${executionReadiness.level === "pass" ? "ok" : executionReadiness.level === "wait" ? "wait" : "bad"}`}>
                    {executionStatusLabel(executionReadiness.status)}
                  </span>
                </div>
                <small>{executionReadiness.recommendation}</small>
                <div className="execution-score-meter">
                  <b>{executionReadiness.score}</b>
                  <div className="execution-score-bar"><em style={{ width: `${executionReadiness.score}%` }} /></div>
                </div>
                <div className="execution-reasons">
                  {executionReadiness.reasons.slice(0, 2).map((item) => (
                    <small key={item}>{item}</small>
                  ))}
                  {executionReadiness.reasons.length > 2 ? <small>...</small> : null}
                </div>
              </div>
              <div className={`backtest-quality-card backtest-trade-plan ${executionReadiness.level}`}>
                <div className="execution-readiness-header">
                  <strong>执行交易计划</strong>
                  <span className={`history-state ${executionPlan.canExecute ? "ok" : executionReadiness.level === "wait" ? "wait" : "bad"}`}>
                    {executionPlan.canExecute ? "可执行" : "暂停"}
                  </span>
                </div>
                <small>基于回测回撤与样本统计的执行参数建议，仅供仿真与风控演练使用。</small>
                <div className="backtest-trade-plan-grid">
                  <div className="backtest-kv"><span>建议信号</span><b>{tradeSignalLabel(executionPlan.signal)}</b></div>
                  <div className="backtest-kv"><span>建议仓位</span><b>{executionPlan.positionSizePercent}%</b></div>
                  <div className="backtest-kv"><span>止损距离</span><b>{executionPlan.stopLossPercent}%</b></div>
                  <div className="backtest-kv"><span>止盈距离</span><b>{executionPlan.takeProfitPercent}%</b></div>
                  <div className="backtest-kv"><span>风险收益比</span><b>{executionPlan.riskRewardRatio.toFixed(1)}</b></div>
                  <div className="backtest-kv"><span>预计持仓期</span><b>{executionPlan.estimatedHoldingBars} 根</b></div>
                  <div className="backtest-kv"><span>预期净收益</span><b>{fmt(executionPlan.expectedNetEdge)}%</b></div>
                  <div className="backtest-kv"><span>执行置信度</span><b>{executionPlan.confidence}</b></div>
                </div>
                <div className="execution-reasons">
                  {executionPlan.rationale.slice(0, 3).map((item) => (
                    <small key={item}>{item}</small>
                  ))}
                  {executionPlan.rationale.length > 3 ? <small>...</small> : null}
                </div>
              </div>
              <div className="backtest-metric-grid">
                <div className="backtest-kv"><span>总事件</span><b>{format(metrics.totalSignals)}</b></div>
                <div className="backtest-kv"><span>有效样本</span><b>{format(metrics.replayableSignals, 0)}</b></div>
                <div className="backtest-kv"><span>平均R5</span><b>{format(metrics.averageR5)}</b></div>
                <div className="backtest-kv"><span>中位R5</span><b>{format(metrics.medianR5)}</b></div>
                <div className="backtest-kv"><span>盈亏期望值</span><b>{format(metrics.expectancy5)}</b></div>
                <div className="backtest-kv"><span>净收益率</span><b>{format(metrics.projectedNetEdge)}</b></div>
                <div className="backtest-kv"><span>胜率5</span><b>{format(metrics.winRate5)}</b></div>
                <div className="backtest-kv"><span>最大回撤5</span><b>{format(metrics.worstMdd5)}</b></div>
                <div className="backtest-kv"><span>基准回测1日</span><b>{format(benchmark?.r1, 2)}</b></div>
                <div className="backtest-kv"><span>基准回测3日</span><b>{format(benchmark?.r3, 2)}</b></div>
                <div className="backtest-kv"><span>基准回测5日</span><b>{format(benchmark?.r5, 2)}</b></div>
                <div className="backtest-kv">
                  <span>非重叠结算样本</span>
                  <b>{historicalSamplePoints.length ? `${historicalSamplePoints.length} 笔` : "--"}</b>
                </div>
              </div>
              {strategyIds.length > 0 && (
                <div className="backtest-strategy-list">
                  <span>执行策略</span>
                  <small>{strategyIds.join(" / ")}</small>
                </div>
              )}
              <div className="backtest-strategy-list">
                <span>回测参数对齐</span>
                {isVerifiedStrategyBacktest ? (
                  <small>
                    策略信号规则采用独立的 robust-v2 命名空间，仅用于本次诊断；
                    不会覆盖设置页的分析因子组合。
                  </small>
                ) : profileDiffs.length ? (
                  <>
                    <small>
                      当前执行设置与回测快照存在 {profileDiffs.length} 项差异，
                      点击“应用到执行策略”可自动对齐关键风控参数
                    </small>
                    <div className="backtest-diff-list">
                      {profileDiffs.slice(0, 3).map((item) => (
                        <small key={item.label}>
                          {item.label}：{item.sourceValue} → {item.targetValue}
                        </small>
                      ))}
                      {profileDiffs.length > 3 ? <small>...更多参数差异请在历史记录展开查看</small> : null}
                    </div>
                  </>
                ) : (
                  <small>回测快照与当前执行设置一致，可直接沿用</small>
                )}
              </div>
              {historicalSamplePoints.length > 0 && (
                <div className="backtest-summary-card">
                  <span>真实历史样本结算轨迹（按入场日顺序，重叠信号不重复计入）</span>
                  <small>
                    起始资金 {fmt(historicalSamplePath?.startingCapital)} · 单笔上限 {format(historicalSamplePath?.positionPercent)}% · 往返成本 {format(historicalSamplePath?.roundTripCostPercent)}%
                  </small>
                  <ol>
                    {historicalSamplePoints.slice(-10).map((item: any) => (
                      <li key={`${item.entryDate}-${item.exitDate}-${item.node}`}>
                        {item.entryDate} → {item.exitDate}：净 {format(item.netReturnPercent)}% · 资金 {fmt(item.capital)}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
                </div>
              </details>
            </>
          )}
          <details
            className="backtest-profile-comparison"
            open={comparisonRunning || Boolean(profileComparisons) ? true : undefined}
          >
            <summary>
              <span><strong>三档风险参数对比（可选）</strong><small>展开后比较保守、平衡、激进三档</small></span>
              <em>{profileComparisons ? "已有结果" : "按需展开"}</em>
            </summary>
            <div className="backtest-profile-comparison-body">
              <div className="backtest-profile-comparison-head">
                <div>
                  <strong>固定标的与成本，仅切换风险档位</strong>
                  <small>通过准入且净边际更高的结果优先；不会改变上方单股回测的策略选择。</small>
                </div>
              {(comparisonRunning || loading) && <button className="secondary-btn" onClick={onInvalidateRun}>取消任务</button>}
              <button
                className="secondary-btn"
                disabled={comparisonRunning || loading || resolvingSecurity}
                onClick={() => runWithResolvedSecurity(onRunProfileComparisons)}
              >
                {comparisonRunning || resolvingSecurity ? <LoaderCircle className="spin" size={16} /> : <LineChart size={16} />}
                {comparisonRunning ? "对比运行中" : resolvingSecurity ? "确认股票" : "运行三档对比"}
              </button>
              </div>
              {!profileComparisons && (
                <div className="empty-inline">运行三档对比后，可在同一组成本与样本约束下选择更合适的执行档位。</div>
              )}
              {!!profileComparisons && (
                <div className="backtest-profile-comparison-list">
                  {comparisonRows.map((item) => {
                    const record = item.record;
                    const rowMetrics = record?.metrics;
                    const readiness = item.readiness;
                    return (
                      <article className="backtest-profile-comparison-row" key={item.profile}>
                        <div className="backtest-profile-comparison-meta">
                          <div>
                            <strong>{riskProfileLabel(item.profile)}</strong>
                            <small>{item.loading ? "正在回放历史样本" : item.error || readiness?.recommendation || "等待结果"}</small>
                          </div>
                          {item.loading ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <span className={`history-state ${readiness?.level === "pass" ? "ok" : readiness?.level === "wait" ? "wait" : "bad"}`}>
                              {readiness ? executionStatusLabel(readiness.status) : "回放失败"}
                            </span>
                          )}
                        </div>
                        {record && readiness && (
                          <>
                            <div className="backtest-profile-comparison-metrics">
                              <div><span>净边际</span><b>{format(rowMetrics?.projectedNetEdge)}%</b></div>
                              <div><span>胜率</span><b>{format(rowMetrics?.winRate5)}%</b></div>
                              <div><span>最大回撤</span><b>{format(rowMetrics?.worstMdd5)}%</b></div>
                              <div><span>可回放样本</span><b>{rowMetrics?.replayableSignals ?? "--"}</b></div>
                            </div>
                            <button
                              className="secondary-btn"
                              disabled={readiness.level === "block" || isVerifiedStrategyBacktest}
                              title={isVerifiedStrategyBacktest
                                ? "已验证策略规则仅用于本次回放，不写入设置页"
                                : readiness.level === "block"
                                  ? readiness.recommendation
                                  : "通过执行治理后应用该档位参数"}
                              onClick={() => onApplyProfileComparison(record)}
                            >
                              <Target size={15} />
                              {readiness.level === "wait" ? "审慎应用此档" : "应用此档参数"}
                            </button>
                          </>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </details>
        </section>
        <section className="panel backtest-history-panel">
          <PanelTitle
            title="历史回测记录"
            subtitle="本地保存的回测记录，可一键恢复参数并导出"
            icon={Database}
            badge={`${history.length} 条`}
          />
          {!history.length && <div className="empty-inline">暂无历史回测记录，运行一次回测后会自动保存</div>}
          {!!history.length && (
            <div className="backtest-history-list">
              {history.map((record) => (
                <article key={record.id} className="backtest-history-item">
                  {(() => {
                    const recordIsVerified = record.rawResult?.strategyEngine === "verified-signal-v2";
                    const recordReadiness = evaluateBacktestExecutionReadiness(
                      record.metrics && typeof record.metrics === "object" ? record.metrics : null,
                      profileDiff(record.strategyProfile),
                      record.rawResult?.tradeExecutionReadiness || record.rawResult?.executionReadiness
                    );
                    return (
                      <>
                        <div className="backtest-history-meta">
                          <div>
                            <b>{record.securityCode || "--"}</b>
                            <small>{record.securityName}</small>
                          </div>
                          <span className={`history-state ${record.accepted ? "ok" : "bad"}`}>
                            {record.accepted ? "预检通过" : "预检未通过"}
                          </span>
                          <span className={`history-state ${recordReadiness.level === "pass" ? "ok" : recordReadiness.level === "wait" ? "wait" : "bad"}`}>
                            {executionStatusLabel(recordReadiness.status)}
                          </span>
                        </div>
                        <p>执行评分：{recordReadiness.score} / 100</p>
                        <p>{recordReadiness.recommendation}</p>
                        <p>
                          回测时间：{new Date(record.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} |
                          净收益：{fmt(record.metrics?.projectedNetEdge)} | 样本：{record.metrics?.replayableSignals ?? "--"}
                        </p>
                        <p>
                          策略：{record.rawResult?.strategyContext?.strategyName || record.strategyProfile?.selectedStrategies?.slice(0, 6).join(" / ") || "--"}
                        </p>
                        <p>风险档位：{riskProfileLabel(record.strategyProfile.riskProfile)}</p>
                        <p>
                          样本外：{record.metrics?.oosSampleCount ?? "--"} 条 |
                          净边际：{fmt(record.metrics?.oosProjectedNetEdge)}% |
                          过拟合风险：{overfitRiskLabel(record.metrics?.overfitRisk)}
                        </p>
                        {(() => {
                          const hot = recordReadiness.reasons.slice(0, 2).join(" / ");
                          return <p>{`关键风险：${hot}${recordReadiness.reasons.length > 2 ? " ..." : ""}`}</p>;
                        })()}
                        <div className="backtest-history-actions">
                          <button className="secondary-btn" onClick={() => onLoadHistory(record)}>载入</button>
                          <button className="secondary-btn" onClick={() => onExportHistory(record, "csv")}>CSV</button>
                          <button className="secondary-btn" onClick={() => onExportHistory(record, "json")}>JSON</button>
                          <button
                            className="secondary-btn"
                            disabled={
                              recordIsVerified ||
                              recordReadiness.level === "block" ||
                              record.metrics?.walkForwardAccepted !== true
                            }
                            title={
                              recordIsVerified
                                ? "策略信号规则仅用于该记录回放，不写入设置页"
                                : record.metrics?.walkForwardAccepted !== true
                                ? "滚动样本外验证未通过，不能应用到执行设置"
                                : recordReadiness.level === "block"
                                ? recordReadiness.recommendation
                                : recordReadiness.level === "wait"
                                  ? "建议先纸面验证后再应用历史参数"
                                  : "应用该记录参数到执行设置"
                            }
                            onClick={() => onApplyHistory(record)}
                          >
                            {recordIsVerified
                              ? "策略规则仅本次使用"
                              : recordReadiness.level === "wait"
                                ? "应用到执行（请谨慎）"
                                : "应用到执行"}
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </article>
              ))}
            </div>
          )}
          {!!history.length && (
            <div className="backtest-history-actions">
              <button className="secondary-btn" onClick={onClearHistory}>清空历史</button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

