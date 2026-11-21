import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfirmDialogRequest } from "../../components/terminal/ConfirmDialog";
import { shanghaiDateTag } from "../../dateUtils";
import type { StrategyBacktestRequest } from "../../domain/strategySelectionReport";
import {
  buildSettingsByRiskProfile,
  clampNumber,
  initialSettings,
  normalizeRiskProfile,
  normalizeSettings,
  riskProfileLabel,
  riskProfilePresets
} from "../../domain/settings";
import { createServiceJobScope } from "../../serviceJobClient";
import type { WorkspaceView as View } from "../../workspaceView";
import type { InformationTab } from "../information/informationModel";
import type { AnalysisPayload } from "../market/analysisTypes";
import type { ExecutionDecisionLog, ExecutionDecisionSource } from "../paper-simulation/paperSimulationTypes";
import {
  DEFAULT_SINGLE_BACKTEST_BARS,
  MAX_SINGLE_BACKTEST_BARS,
  MIN_SINGLE_BACKTEST_BARS,
  defaultBacktestStartDate,
  normalizeBacktestDraft,
  normalizeBacktestStrategyContext,
  normalizeBacktestStrategyIds
} from "./backtestModel";
import {
  BACKTEST_HISTORY_LIMIT,
  buildBacktestHistoryRecord,
  hydrateBacktestHistory,
  loadBacktestHistory,
  saveBacktestHistory
} from "./backtestStorage";
import type {
  BacktestDraft,
  BacktestEntryContext,
  BacktestHistoryRecord,
  BacktestProfileComparisonReport,
  BacktestStrategyProfile
} from "./backtestTypes";
import {
  buildBacktestDeRiskProfile,
  buildBacktestProfileDiff,
  evaluateBacktestExecutionReadiness,
  toBacktestStrategyProfile,
  toSafeBacktestSettings
} from "./executionGovernance";
import { userErrorText } from "../../userErrorText";

export type BacktestOrigin = {
  view: View;
  label: string;
  node?: string;
  dashboardMode?: "pool" | "analysis";
  informationTab?: InformationTab;
};

type UseBacktestWorkspaceOptions = {
  view: View;
  dashboardMode: "pool" | "analysis";
  payload: AnalysisPayload | null;
  settings: Settings;
  persistSettings: (patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => Promise<unknown>;
  askConfirm: (request: ConfirmDialogRequest) => Promise<boolean>;
  showToast: (message: string) => void;
  appendExecutionDecisionLog: (entry: Omit<ExecutionDecisionLog, "id" | "createdAt">) => void;
  originForView: (sourceView?: View) => BacktestOrigin;
  onEnterBacktest: (origin: BacktestOrigin) => void;
};

const csvEscape = (value: unknown) => {
  const raw = String(value ?? "");
  const text = raw.replace(/\r?\n/g, " ");
  const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(raw) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

const backtestSourceLabel = (sourceView: View, dashboardMode: "pool" | "analysis") => {
  if (sourceView === "signals" || sourceView === "trend-screener") return "策略选股";
  if (sourceView === "favorites") return "自选监控";
  if (sourceView === "holdings") return "持仓板块";
  if (sourceView === "watchlist") return "十日观察池";
  if (sourceView === "compare") return "多股同列";
  if (sourceView === "review") return "专业复盘";
  if (sourceView === "sectors") return "板块强度";
  if (sourceView === "beijing") return "北交所";
  if (sourceView === "bonds") return "可转债";
  if (sourceView === "news" || sourceView === "announcements") return "资讯中心";
  if (sourceView === "dashboard" && dashboardMode === "analysis") return "个股复盘";
  if (sourceView === "backtest") return "回测中心";
  return "回测中心手工选择";
};

export function useBacktestWorkspace({
  view,
  dashboardMode,
  payload,
  settings,
  persistSettings,
  askConfirm,
  showToast,
  appendExecutionDecisionLog,
  originForView,
  onEnterBacktest
}: UseBacktestWorkspaceOptions) {
  const [backtestReturnMode, setBacktestReturnMode] = useState<"pool" | "analysis">("pool");
  const [backtestCenterMode, setBacktestCenterMode] = useState<"portfolio" | "single">("single");
  const [portfolioMounted, setPortfolioMounted] = useState(false);
  const portfolioActive = view === "backtest" && backtestCenterMode === "portfolio";

  const [backtestDraft, setBacktestDraft] = useState<BacktestDraft>({
    securityCode: "",
    startDate: defaultBacktestStartDate(),
    customEntryPrice: null,
    lookbackBars: DEFAULT_SINGLE_BACKTEST_BARS,
    benchmarks: 2,
    benchmark: "all",
    minSamples: 12,
    minProjectedNetEdgePercent: initialSettings.minProjectedNetEdgePercent ?? 0.2,
    minExpectancyPoints: initialSettings.minExpectancyPoints ?? 0.2,
    minTurnoverPercent: initialSettings.minTurnoverPercent ?? 0.4,
    minQuoteAmount: initialSettings.minQuoteAmount ?? 1_200_000,
    maxQuoteAgeSeconds: initialSettings.maxQuoteAgeSeconds ?? 480,
    commissionBps: initialSettings.commissionBps ?? 7,
    slippageBps: initialSettings.slippageBps ?? 2
  });
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestError, setBacktestError] = useState("");
  const [backtestRunRecord, setBacktestRunRecord] = useState<BacktestHistoryRecord | null>(null);
  const backtestResult = backtestRunRecord?.rawResult || null;
  const [backtestHistory, setBacktestHistory] = useState<BacktestHistoryRecord[]>(
    () => loadBacktestHistory(initialSettings)
  );
  const [backtestProfileComparisons, setBacktestProfileComparisons] = useState<BacktestProfileComparisonReport | null>(null);
  const [backtestEntryContext, setBacktestEntryContext] = useState<BacktestEntryContext | null>(null);

  const historySignatureRef = useRef<string | null>(null);
  const backtestJobs = useRef(createServiceJobScope());
  const comparisonJobs = useRef(createServiceJobScope());
  const backtestRequestId = useRef(0);
  const comparisonRequestId = useRef(0);

  useEffect(() => {
    if (portfolioActive) setPortfolioMounted(true);
  }, [portfolioActive]);

  useEffect(() => {
    let active = true;
    if (backtestHistory.length > 0) return undefined;
    void hydrateBacktestHistory(initialSettings).then((records) => {
      if (!active || !records.length) return;
      setBacktestHistory(current => current.length ? current : records);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const signature = JSON.stringify(backtestHistory);
    if (historySignatureRef.current === null) {
      historySignatureRef.current = signature;
      return;
    }
    if (signature === historySignatureRef.current) return;
    if (saveBacktestHistory(backtestHistory.slice(0, BACKTEST_HISTORY_LIMIT))) {
      historySignatureRef.current = signature;
    }
  }, [backtestHistory]);

  const invalidateBacktests = () => {
    void backtestJobs.current.cancelAll();
    void comparisonJobs.current.cancelAll();
    backtestRequestId.current += 1;
    comparisonRequestId.current += 1;
    setBacktestLoading(false);
    setBacktestProfileComparisons(current => current?.items.some(item => item.loading) ? null : current);
  };

  useEffect(() => () => {
    void backtestJobs.current.cancelAll();
    void comparisonJobs.current.cancelAll();
    backtestRequestId.current += 1;
    comparisonRequestId.current += 1;
  }, []);

  const runBacktestWithSettings = async (draft: BacktestDraft, profileSettings: Settings, jobs = backtestJobs.current) => {
    const safeSettings = structuredClone(normalizeSettings(profileSettings));
    const normalizedDraft = structuredClone(normalizeBacktestDraft(draft));
    const selectedStrategies = normalizedDraft.strategyContext?.strategyIds?.length
      ? normalizedDraft.strategyContext.strategyIds
      : safeSettings.selectedStrategies;
    const backtestSecurity = normalizedDraft.security?.code === normalizedDraft.securityCode
      ? normalizedDraft.security
      : normalizedDraft.securityCode;
    // Keep the exact submitted settings alongside the completed record. Neither
    // later draft edits nor global settings changes may rewrite this run.
    const runSettings = {
      ...toSafeBacktestSettings(safeSettings),
      selectedStrategies,
      minProjectedNetEdgePercent: clampNumber(normalizedDraft.minProjectedNetEdgePercent, -2, 10, safeSettings.minProjectedNetEdgePercent),
      minExpectancyPoints: clampNumber(normalizedDraft.minExpectancyPoints, -2, 8, safeSettings.minExpectancyPoints),
      minTurnoverPercent: clampNumber(normalizedDraft.minTurnoverPercent, 0, 20, safeSettings.minTurnoverPercent ?? 0.4),
      minQuoteAmount: clampNumber(normalizedDraft.minQuoteAmount, 0, 1_000_000_000, safeSettings.minQuoteAmount ?? 1200000),
      maxQuoteAgeSeconds: clampNumber(normalizedDraft.maxQuoteAgeSeconds, 30, 1800, safeSettings.maxQuoteAgeSeconds ?? 480),
      commissionBps: clampNumber(normalizedDraft.commissionBps, 0, 60, safeSettings.commissionBps),
      slippageBps: clampNumber(normalizedDraft.slippageBps, 0, 40, safeSettings.slippageBps)
    };
    const result = await jobs.run(requestId => window.stockApi.runBacktest(backtestSecurity, {
      requestId,
      startDate: normalizedDraft.startDate,
      customEntryPrice: normalizedDraft.customEntryPrice,
      lookbackBars: clampNumber(
        normalizedDraft.lookbackBars,
        MIN_SINGLE_BACKTEST_BARS,
        MAX_SINGLE_BACKTEST_BARS,
        DEFAULT_SINGLE_BACKTEST_BARS
      ),
      benchmarks: clampNumber(normalizedDraft.benchmarks, 1, 10, 2),
      benchmark: normalizedDraft.benchmark,
      minSamples: clampNumber(normalizedDraft.minSamples, 1, 300, 12),
      ...(normalizedDraft.strategyContext
        ? {
            strategyContext: normalizedDraft.strategyContext,
            signalStrategyIds: normalizedDraft.strategyContext.strategyIds
          }
        : {}),
      settings: runSettings
    }));
    return structuredClone({
      ...buildBacktestHistoryRecord(normalizedDraft, result, safeSettings),
      runSettings
    });
  };

  const runBacktest = async (draft: BacktestDraft) => {
    const code = String(draft.securityCode || "").trim();
    if (!code || !/^\d{6}$/.test(code)) {
      setBacktestError("请先选择股票名称或输入6位A股代码");
      return;
    }
    void backtestJobs.current.cancelAll();
    void comparisonJobs.current.cancelAll();
    const requestId = ++backtestRequestId.current;
    comparisonRequestId.current += 1;
    setBacktestLoading(true);
    setBacktestError("");
    setBacktestRunRecord(null);
    setBacktestProfileComparisons(null);
    try {
      const record = await runBacktestWithSettings(draft, settings);
      if (requestId !== backtestRequestId.current) return;
      setBacktestRunRecord(record);
      setBacktestHistory(current =>
        [record, ...current.filter(item => item.id !== record.id)].slice(0, BACKTEST_HISTORY_LIMIT)
      );
    } catch (reason) {
      if (requestId === backtestRequestId.current) setBacktestError(userErrorText(reason));
    } finally {
      if (requestId === backtestRequestId.current) setBacktestLoading(false);
    }
  };

  const runBacktestProfileComparisons = async (draft: BacktestDraft) => {
    const code = String(draft.securityCode || "").trim();
    if (!code || !/^\d{6}$/.test(code)) {
      setBacktestError("请先选择股票名称或输入6位A股代码，再运行风险档位对比");
      return;
    }
    void comparisonJobs.current.cancelAll();
    const requestId = ++comparisonRequestId.current;
    const normalizedDraft = normalizeBacktestDraft(draft);
    const seed = {
      sourceCode: code,
      comparedAt: new Date().toISOString(),
      items: riskProfilePresets.map(item => ({
        profile: item.id,
        loading: true,
        error: "",
        record: null
      }))
    };
    setBacktestProfileComparisons(seed);
    const baseSettings = normalizeSettings(settings);
    const nextItems: BacktestProfileComparisonReport["items"] = [];
    for (const preset of riskProfilePresets) {
      let nextItem: BacktestProfileComparisonReport["items"][number];
      try {
        const profileSettings = buildSettingsByRiskProfile(baseSettings, preset.id);
        const record = await runBacktestWithSettings(normalizedDraft, profileSettings, comparisonJobs.current);
        if (requestId !== comparisonRequestId.current) return;
        nextItem = { profile: preset.id, loading: false, error: "", record };
      } catch (error) {
        if (requestId !== comparisonRequestId.current) return;
        nextItem = {
          profile: preset.id,
          loading: false,
          error: userErrorText(error, "风险档位回测失败"),
          record: null
        };
      }
      nextItems.push(nextItem);
      setBacktestProfileComparisons(current => {
        if (!current || current.comparedAt !== seed.comparedAt) return current;
        return {
          ...current,
          items: current.items.map(item => item.profile === preset.id ? nextItem : item)
        };
      });
    }
    if (requestId !== comparisonRequestId.current) return;
    setBacktestProfileComparisons({ sourceCode: seed.sourceCode, comparedAt: seed.comparedAt, items: nextItems });
  };

  const exportBacktestPayload = (record: BacktestHistoryRecord, format: "csv" | "json") => {
    const baseName = `${record.securityCode || "backtest"}-${shanghaiDateTag(record.createdAt)}`;
    if (format === "json") {
      const payloadText = JSON.stringify(record, null, 2);
      const blob = new Blob([payloadText], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${baseName}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    }

    const csvCell = (value: unknown): string | number => (
      typeof value === "number" || typeof value === "string"
        ? value
        : value == null
          ? ""
          : String(value)
    );
    const metrics = record.metrics || {};
    const lines: Array<(string | number)[]> = [
      ["回测时间", "证券代码", "证券名称", "开始日期", "策略", "是否通过", "完成交易", "累计净收益%", "累计盈亏", "总信号", "有效样本", "平均单笔净收益", "胜率", "资金最大回撤", "样本外样本", "样本外净边际", "滚动窗口通过率", "过拟合风险", "训练外退化%", "BenchmarkR1", "BenchmarkR3", "BenchmarkR5"],
      [
        record.createdAt,
        /^\d{6}$/.test(String(record.securityCode || "")) ? `'${record.securityCode}` : record.securityCode,
        record.securityName,
        record.draft.startDate,
        record.draft.strategyContext?.strategyName || record.strategyProfile.selectedStrategies.join(" / "),
        record.accepted ? "PASS" : "REJECT",
        csvCell(metrics.tradeCount ?? record.rawResult?.profitSummary?.tradeCount),
        csvCell(metrics.totalNetReturnPercent ?? record.rawResult?.profitSummary?.totalNetReturnPercent),
        csvCell(metrics.totalProfitAmount ?? record.rawResult?.profitSummary?.totalProfitAmount),
        csvCell(metrics.totalSignals),
        csvCell(metrics.replayableSignals),
        csvCell(metrics.projectedNetEdge),
        csvCell(metrics.winRatePercent ?? metrics.winRate5),
        csvCell(metrics.accountMaxDrawdownPercent ?? metrics.worstMdd5),
        csvCell(metrics.oosSampleCount),
        csvCell(metrics.oosProjectedNetEdge),
        csvCell(metrics.walkForwardPassRate),
        csvCell(metrics.overfitRisk),
        csvCell(metrics.degradationPercent),
        csvCell(record.benchmarkReturns?.r1),
        csvCell(record.benchmarkReturns?.r3),
        csvCell(record.benchmarkReturns?.r5)
      ],
      [],
      ["策略参数"],
      ["开始日期", "买入价格规则", "同日最少命中策略数", "最小样本", "最小预期净收益%", "最小期望值", "佣金", "滑点", "风险档位", "策略列表", "取值标尺"],
      [
        record.draft.startDate,
        record.draft.customEntryPrice ? `自定义限价 ${record.draft.customEntryPrice}` : "次日开盘价",
        record.draft.strategyContext?.minimumVotes || 1,
        record.draft.minSamples,
        record.draft.minProjectedNetEdgePercent,
        record.draft.minExpectancyPoints,
        record.draft.commissionBps,
        record.draft.slippageBps,
        riskProfileLabel(record.strategyProfile.riskProfile),
        record.strategyProfile.selectedStrategies.join(" / "),
        record.draft.benchmarks
      ],
      ["仓位上限(%)", "单笔风险上限(%)", "止损ATR", "止盈ATR", "最长期限Bars", "最大持仓数", "日内最大风险(%)", "组合最大风险(%)", "行业仓位上限(%)", "最低成交率(%)"],
      [
        record.strategyProfile.maxPositionPercent,
        record.strategyProfile.maxRiskPerTradePercent,
        record.strategyProfile.stopLossATRMultiple,
        record.strategyProfile.takeProfitATRMultiple,
        record.strategyProfile.maxHoldingBars,
        record.strategyProfile.maxOpenPositions,
        record.strategyProfile.maxDailyRiskPercent,
        record.strategyProfile.maxPortfolioRiskPercent,
        record.strategyProfile.maxSectorExposurePercent,
        record.strategyProfile.minExecutionRatePercent
      ],
      ["追踪止损(%)", "减仓步幅(%)", "减仓下限(%)", "连续亏损熔断", "时间衰减(%)"],
      [
        record.strategyProfile.trailingStopPercent,
        record.strategyProfile.lossStepPercent,
        record.strategyProfile.lossFloorPercent,
        record.strategyProfile.maxConsecutiveLossesForStop,
        record.strategyProfile.timeDecayPerBarPercent
      ],
      [],
      ["完整回测快照JSON"]
    ];
    const trades = Array.isArray(record.rawResult?.trades) ? record.rawResult.trades : [];
    const strategyBreakdown = Array.isArray(record.rawResult?.strategyBreakdown)
      ? record.rawResult.strategyBreakdown
      : [];
    if (strategyBreakdown.length > 1) {
      lines.splice(
        lines.length - 2,
        0,
        ["各策略独立收益对比"],
        ["策略ID", "策略名称", "完成交易", "盈利", "亏损", "胜率%", "累计净收益%", "累计盈亏", "最大回撤%"],
        ...strategyBreakdown.map((item) => [
          csvCell(item.strategyId),
          csvCell(item.strategyName),
          csvCell(item.tradeCount),
          csvCell(item.profitableTrades),
          csvCell(item.losingTrades),
          csvCell(item.winRatePercent),
          csvCell(item.totalNetReturnPercent),
          csvCell(item.totalProfitAmount),
          csvCell(item.maxDrawdownPercent)
        ]),
        []
      );
    }
    if (trades.length) {
      lines.splice(
        lines.length - 2,
        0,
        ["逐笔交易"],
        ["序号", "命中策略", "信号日", "买入日", "买入价", "买入价格来源", "卖出日", "卖出价", "单笔毛收益%", "单笔净收益%", "单笔盈亏", "累计收益%", "期末资金"],
        ...trades.map((trade: Record<string, unknown>) => [
          csvCell(trade.sequence),
          Array.isArray(trade.strategyIds) ? trade.strategyIds.map(String).join(" / ") : "",
          csvCell(trade.signalDate),
          csvCell(trade.entryDate),
          csvCell(trade.entryPrice),
          trade.entryPriceSource === "custom_limit_price" ? "自定义限价" : "次日开盘",
          csvCell(trade.exitDate),
          csvCell(trade.exitPrice),
          csvCell(trade.grossReturnPercent),
          csvCell(trade.netReturnPercent),
          csvCell(trade.profitAmount),
          csvCell(trade.cumulativeReturnPercent),
          csvCell(trade.endingCapital)
        ]),
        []
      );
    }
    const rows = lines.map(row => (Array.isArray(row) ? row.map(csvEscape).join(",") : ""));
    rows.push(csvEscape(JSON.stringify(record.rawResult || {})));
    const csv = "\uFEFF" + rows.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${baseName}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const applyBacktestProfile = (record: BacktestHistoryRecord, profileOverride?: BacktestStrategyProfile) => {
    const profile = profileOverride || record.strategyProfile;
    const selectedStrategies = profile?.selectedStrategies?.length
      ? normalizeBacktestStrategyIds([...profile.selectedStrategies, "riskVeto"])
      : normalizeBacktestStrategyIds(settings.selectedStrategies);
    if (!selectedStrategies.includes("riskVeto")) {
      selectedStrategies.push("riskVeto");
    }
    if (!selectedStrategies.length) return;
    const next = normalizeSettings({
      ...settings,
      riskProfile: normalizeRiskProfile(profile.riskProfile),
      selectedStrategies,
      minProjectedNetEdgePercent: clampNumber(profile.minProjectedNetEdgePercent, -2, 10, settings.minProjectedNetEdgePercent),
      minExpectancyPoints: clampNumber(profile.minExpectancyPoints, -2, 8, settings.minExpectancyPoints),
      minTurnoverPercent: clampNumber(profile.minTurnoverPercent, 0, 20, settings.minTurnoverPercent ?? 0.4),
      minQuoteAmount: clampNumber(profile.minQuoteAmount, 0, 1_000_000_000, settings.minQuoteAmount ?? 1200000),
      maxQuoteAgeSeconds: clampNumber(profile.maxQuoteAgeSeconds, 30, 1800, settings.maxQuoteAgeSeconds ?? 480),
      commissionBps: clampNumber(profile.commissionBps, 0, 60, settings.commissionBps),
      slippageBps: clampNumber(profile.slippageBps, 0, 60, settings.slippageBps),
      maxPositionPercent: clampNumber(profile.maxPositionPercent, 5, 90, settings.maxPositionPercent),
      maxRiskPerTradePercent: clampNumber(profile.maxRiskPerTradePercent, 0.2, 5, settings.maxRiskPerTradePercent),
      stopLossATRMultiple: clampNumber(profile.stopLossATRMultiple, 0.8, 5, settings.stopLossATRMultiple),
      takeProfitATRMultiple: clampNumber(profile.takeProfitATRMultiple, 1, 10, settings.takeProfitATRMultiple),
      maxHoldingBars: Math.round(clampNumber(profile.maxHoldingBars, 3, 120, settings.maxHoldingBars)),
      maxOpenPositions: Math.round(clampNumber(profile.maxOpenPositions, 1, 10, settings.maxOpenPositions)),
      maxDailyRiskPercent: clampNumber(profile.maxDailyRiskPercent, 0.3, 12, settings.maxDailyRiskPercent ?? 3.2),
      maxPortfolioRiskPercent: clampNumber(profile.maxPortfolioRiskPercent, 10, 100, settings.maxPortfolioRiskPercent ?? 70),
      maxSectorExposurePercent: clampNumber(profile.maxSectorExposurePercent, 10, 100, settings.maxSectorExposurePercent ?? 45),
      minExecutionRatePercent: clampNumber(profile.minExecutionRatePercent, 40, 100, settings.minExecutionRatePercent ?? 90),
      trailingStopPercent: clampNumber(profile.trailingStopPercent, 0, 25, settings.trailingStopPercent ?? 3),
      lossStreakStepPercent: clampNumber(profile.lossStepPercent, 2, 60, settings.lossStreakStepPercent ?? 18),
      lossStreakFloorPercent: clampNumber(profile.lossFloorPercent, 10, 80, settings.lossStreakFloorPercent ?? 30),
      maxConsecutiveLossesForStop: Math.round(clampNumber(profile.maxConsecutiveLossesForStop, 2, 12, settings.maxConsecutiveLossesForStop ?? 4)),
      timeDecayPerBarPercent: clampNumber(profile.timeDecayPerBarPercent, 0, 1, settings.timeDecayPerBarPercent ?? 0.11)
    });
    void persistSettings(next).then(() => {
      showToast("已将回测参数同步到执行设置（已保存）");
    }).catch(() => {
      showToast("回测参数保存失败，仍使用上次成功保存的执行设置");
    });
  };

  const applyBacktestProfileWithGovernance = async (
    record: BacktestHistoryRecord,
    source: ExecutionDecisionSource,
    label: string
  ) => {
    const strategyProfile = record.strategyProfile;
    const securityCode = String(record.securityCode || "");
    const securityName = String(record.securityName || securityCode || "UNKNOWN");
    if (record.rawResult?.strategyEngine === "verified-signal-v2") {
      showToast("策略选股规则仅用于本次回放，不会写入设置页的执行因子");
      return;
    }
    if (record.metrics?.walkForwardAccepted !== true) {
      const reason = record.metrics?.walkForwardAvailable === false
        ? "缺少足够的滚动样本外验证"
        : "滚动样本外验证未通过";
      appendExecutionDecisionLog({
        source,
        result: "BLOCKED",
        level: "block",
        securityCode,
        securityName,
        summary: `${label}回测参数应用失败：${reason}`,
        score: 0,
        reasons: [reason]
      });
      showToast(`回测执行决策阻断：${reason}`);
      return;
    }
    const diff = buildBacktestProfileDiff(strategyProfile, toBacktestStrategyProfile(settings));
    const remoteReadiness = record.rawResult?.tradeExecutionReadiness || record.rawResult?.executionReadiness;
    const readiness = evaluateBacktestExecutionReadiness(record.metrics, diff, remoteReadiness);
    const waitDeRiskMessage = `${securityName} 回测执行评估为“等待条件确认”：${readiness.score} 分。`;

    if (readiness.level === "block") {
      appendExecutionDecisionLog({
        source,
        result: "BLOCKED",
        level: "block",
        securityCode,
        securityName,
        summary: `${label}回测参数应用失败：${readiness.recommendation}`,
        score: readiness.score,
        reasons: readiness.reasons
      });
      showToast(`回测执行决策阻断：${readiness.recommendation}`);
      return;
    }

    if (readiness.level === "wait") {
      const deRiskResult = buildBacktestDeRiskProfile(strategyProfile, readiness);
      const confirmed = await askConfirm({
        title: "回测参数需确认后应用",
        message: waitDeRiskMessage,
        details: [`建议：${readiness.recommendation}`, ...deRiskResult.adjustments],
        confirmLabel: "按保守档位应用",
        cancelLabel: "取消"
      });
      if (!confirmed) {
        appendExecutionDecisionLog({
          source,
          result: "REJECTED",
          level: "wait",
          securityCode,
          securityName,
          summary: `${label}回测参数应用已取消`,
          score: readiness.score,
          reasons: readiness.reasons
        });
        showToast("已取消应用回测参数");
        return;
      }
      applyBacktestProfile(record, deRiskResult.profile);
      appendExecutionDecisionLog({
        source,
        result: "APPROVED",
        level: "wait",
        securityCode,
        securityName,
        summary: `${label}回测参数已应用（等待确认降仓档位）`,
        score: readiness.score,
        reasons: [
          `等待确认风险评估：${readiness.recommendation}`,
          ...deRiskResult.adjustments,
          ...readiness.reasons
        ]
      });
      showToast("已按“等待确认”降仓档位应用回测参数");
      return;
    }

    applyBacktestProfile(record);
    appendExecutionDecisionLog({
      source,
      result: "APPROVED",
      level: readiness.level,
      securityCode,
      securityName,
      summary: `${label}回测参数已应用`,
      score: readiness.score,
      reasons: readiness.reasons
    });
  };

  // B2-02：清空历史是"不可撤销的破坏性操作"，走统一确认弹窗（默认聚焦取消），
  // 与删除自定义策略、移除持仓保持同一套 destructive 语义。
  const clearBacktestHistory = async () => {
    const confirmed = await askConfirm({
      title: "清空回测历史",
      message: "将永久删除本机保存的全部回测记录，且无法撤销。",
      details: ["历史记录用于对比不同参数的回测结果；清空后需要重新运行才能重建。"],
      confirmLabel: "清空历史",
      tone: "danger"
    });
    if (!confirmed) return;
    setBacktestHistory([]);
    showToast("已清空回测历史");
  };

  const applyCurrentBacktestToPaper = () => {
    if (!backtestRunRecord) {
      showToast("请先运行回测后再应用");
      return;
    }
    void applyBacktestProfileWithGovernance(backtestRunRecord, "BACKTEST_CURRENT", "当前");
  };

  const exportCurrentBacktest = (format: "csv" | "json") => {
    if (!backtestRunRecord) {
      showToast("请先运行回测后再导出");
      return;
    }
    exportBacktestPayload(backtestRunRecord, format);
  };

  const applyHistoryToSettings = (record: BacktestHistoryRecord) => {
    void applyBacktestProfileWithGovernance(record, "BACKTEST_HISTORY", "历史");
  };

  const loadBacktestRecord = (record: BacktestHistoryRecord) => {
    invalidateBacktests();
    const restoredDraft = normalizeBacktestDraft(record.draft);
    const restoredStrategyContext = normalizeBacktestStrategyContext(
      restoredDraft.strategyContext || record.rawResult?.strategyContext
    );
    setBacktestDraft({ ...restoredDraft, ...(restoredStrategyContext ? { strategyContext: restoredStrategyContext } : {}) });
    setBacktestRunRecord(structuredClone(record));
    setBacktestProfileComparisons(null);
    setBacktestError("");
    const restoredSecurity = record.rawResult?.security && typeof record.rawResult.security === "object"
      ? record.rawResult.security as Security
      : {
        code: record.securityCode,
        name: record.securityName || record.securityCode,
        secid: ""
      };
    setBacktestEntryContext({
      security: restoredSecurity,
      sourceView: "backtest",
      sourceLabel: "历史回测记录",
      strategyIds: restoredStrategyContext?.strategyIds || normalizeBacktestStrategyIds(record.strategyProfile?.selectedStrategies),
      strategyLabel: restoredStrategyContext?.strategyName || "记录内保存的策略快照",
      capturedAt: record.createdAt
    });
    showToast(`已恢复 ${record.securityName || record.securityCode} 的回测记录`);
  };

  const openBacktest = (
    security?: Security | string | null,
    strategyRequest?: StrategyBacktestRequest | null,
    draftOverrides?: {
      lookbackBars?: number;
      minProjectedNetEdgePercent?: number;
      minExpectancyPoints?: number;
      minTurnoverPercent?: number;
    } | null
  ) => {
    invalidateBacktests();
    const safeSettings = normalizeSettings(settings);
    setBacktestCenterMode(strategyRequest?.securities?.length ||
      (strategyRequest?.source === "optimized_portfolio" && !security && !strategyRequest.security) ? "portfolio" : "single");
    const strategyContext = normalizeBacktestStrategyContext(strategyRequest);
    const visiblePayloadSecurity =
      view === "dashboard" && dashboardMode === "analysis"
        ? payload?.security || null
        : null;
    const upstreamSecurity =
      security && typeof security === "object"
        ? security
        : visiblePayloadSecurity;
    const next = typeof security === "string"
      ? security
      : upstreamSecurity?.code || (view === "backtest" ? backtestDraft.securityCode : "");
    setBacktestDraft(current => normalizeBacktestDraft({
      ...current,
      securityCode: next || (view === "backtest" ? current.securityCode : ""),
      security:
        upstreamSecurity ||
        (typeof security === "string" && /^\d{6}$/.test(security)
          ? { code: security, name: security, secid: "" }
          : view === "backtest"
            ? current.security
            : undefined),
      strategyContext: strategyContext || (view === "backtest" ? current.strategyContext : undefined),
      startDate: current.startDate || defaultBacktestStartDate(),
      lookbackBars: draftOverrides?.lookbackBars ?? current.lookbackBars,
      minProjectedNetEdgePercent: draftOverrides?.minProjectedNetEdgePercent ?? safeSettings.minProjectedNetEdgePercent,
      minExpectancyPoints: draftOverrides?.minExpectancyPoints ?? safeSettings.minExpectancyPoints,
      minTurnoverPercent: draftOverrides?.minTurnoverPercent ?? safeSettings.minTurnoverPercent,
      minQuoteAmount: safeSettings.minQuoteAmount,
      maxQuoteAgeSeconds: safeSettings.maxQuoteAgeSeconds,
      commissionBps: safeSettings.commissionBps,
      slippageBps: safeSettings.slippageBps,
      benchmarks: current.benchmarks
    }));
    setBacktestEntryContext(current => ({
      security:
        upstreamSecurity ||
        (typeof security === "string" && /^\d{6}$/.test(security)
          ? { code: security, name: security, secid: "" }
          : view === "backtest"
            ? current?.security || null
            : null),
      sourceView: view,
      sourceLabel: strategyContext
        ? `策略选股 · ${strategyContext.strategyName}`
        : backtestSourceLabel(view, dashboardMode),
      strategyIds: strategyContext?.strategyIds || normalizeBacktestStrategyIds(settings.selectedStrategies),
      strategyLabel: strategyContext?.strategyName || "当前执行设置",
      capturedAt: new Date().toISOString()
    }));
    const returnMode = view === "dashboard" && dashboardMode === "analysis" ? "analysis" : "pool";
    setBacktestReturnMode(returnMode);
    setBacktestError("");
    setBacktestRunRecord(null);
    setBacktestProfileComparisons(null);
    onEnterBacktest({
      ...originForView(view),
      dashboardMode: view === "dashboard" ? dashboardMode : "pool"
    });
  };

  const updateBacktestTargetContext = (security: Security, sourceLabel: string) => {
    setBacktestEntryContext({
      security,
      sourceView: "backtest",
      sourceLabel: backtestDraft.strategyContext
        ? `策略选股 · ${backtestDraft.strategyContext.strategyName}`
        : sourceLabel,
      strategyIds: backtestDraft.strategyContext?.strategyIds || normalizeBacktestStrategyIds(settings.selectedStrategies),
      strategyLabel: backtestDraft.strategyContext?.strategyName || "当前执行设置",
      capturedAt: new Date().toISOString()
    });
  };

  const portfolioInitialSecurities = useMemo(() => backtestDraft.strategyContext?.securities?.length
    ? backtestDraft.strategyContext.securities
    : backtestEntryContext?.security ? [backtestEntryContext.security] : [], [backtestDraft.strategyContext, backtestEntryContext]);

  return {
    backtestReturnMode,
    backtestCenterMode,
    setBacktestCenterMode,
    portfolioMounted,
    portfolioActive,
    backtestDraft,
    setBacktestDraft,
    backtestLoading,
    backtestError,
    backtestResult,
    backtestRunRecord,
    backtestHistory,
    backtestProfileComparisons,
    backtestEntryContext,
    portfolioInitialSecurities,
    invalidateBacktests,
    runBacktest,
    runBacktestProfileComparisons,
    exportBacktestPayload,
    applyBacktestProfileWithGovernance,
    clearBacktestHistory,
    applyCurrentBacktestToPaper,
    exportCurrentBacktest,
    applyHistoryToSettings,
    loadBacktestRecord,
    openBacktest,
    updateBacktestTargetContext
  };
}
