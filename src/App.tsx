import { paperLifetimeMetrics } from "./features/paper-simulation/paperClosedHistory";
import { marketCapitalization } from "./domain/marketCapitalization";
import { createServiceJobScope } from "./serviceJobClient";
import { LoadingState } from "./components/terminal/TerminalPrimitives";
import { ConfirmDialog, type ConfirmDialogRequest } from "./components/terminal/ConfirmDialog";
import { informationTabs, resolveInformationCenterRoute, type InformationTab } from "./features/information/informationModel";
import type { AnalysisPayload } from "./features/market/analysisTypes";
import type { WorkspaceView as View } from "./workspaceView";
import { simpleAnalysisOrigin, canRefreshAnalysis } from "./workspaceExperience";
import type {
  BacktestDraft, BacktestEntryContext, BacktestExecutionPlan,
  BacktestHistoryRecord, BacktestProfileComparisonReport, BacktestStrategyProfile,
  StrategyBacktestRequest
} from "./features/backtest/backtestTypes";
import {
  DEFAULT_SINGLE_BACKTEST_BARS, MAX_SINGLE_BACKTEST_BARS, MIN_SINGLE_BACKTEST_BARS,
  defaultBacktestStartDate, normalizeBacktestDraft, normalizeBacktestStrategyContext,
  normalizeBacktestStrategyIds
} from "./features/backtest/backtestModel";
import { executionStatusLabel } from "./domain/executionLabels";
import type { PaperClosedPosition } from "./domain/paperSimulationTypes";
import type {
  ExecutionDecisionLog, ExecutionDecisionResult, ExecutionDecisionSource,
  PaperSimulationState, PaperStrategyGovernance, PaperStrategyStage, PaperTradeAction
} from "./features/paper-simulation/paperSimulationTypes";
import {
  BACKTEST_HISTORY_KEY, BACKTEST_HISTORY_LIMIT, buildBacktestHistoryRecord, loadBacktestHistory
} from "./features/backtest/backtestStorage";
import {
  EXECUTION_DECISION_LOG_KEY, EXECUTION_DECISION_LOG_LIMIT, buildExecutionDecisionLogEntry,
  loadExecutionDecisionLog, loadPaperState, PAPER_SIM_STATE_KEY
} from "./features/paper-simulation/paperSimulationPersistence";
import { normalizePaperState, settlePaperPosition } from "./features/paper-simulation/paperSimulationState";
import {
  advancePaperSimulationByQuote, closePaperAllSimulationByCode, closePaperSimulationByCode, estimatePaperOrderExecutionModel,
  evaluatePaperExecutionReadiness, evaluatePaperKillSwitch, evaluatePaperStrategyGovernance,
  getPaperAccountMetrics, getPaperDailyTradeSignal, getPaperLossStreakState, getPaperSectorExposurePercent,
  getPaperSectorExposureValue, getSectorOfPayload, mergeReasonArrays, openPaperPositionFromSignal
} from "./features/paper-simulation/paperSimulationEngine";
import { limitPoolProviderLabel } from "./features/market/marketLabels";
import { describeSourceHealth } from "./features/market/marketSourceHealth";
export { resolveInformationCenterRoute };
import useStockMonitors from "./useStockMonitors";
import {
  Activity,
  BarChart3,
  Bell,
  BookOpenCheck,
  Bookmark,
  CircleAlert,
  Layers3,
  LayoutDashboard,
  Landmark,
  Coins,
  ArrowLeftRight,
  ArrowDownUp,
  Bot,
  LineChart,
  MessagesSquare,
  LoaderCircle,
  Minus,
  Monitor,
  Moon,
  Newspaper,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Star,
  Sun,
  TrendingUp,
  Volume2,
  VolumeX,
  WalletCards,
  X
} from "lucide-react";
import { FormEvent, lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiInterpretPanel } from "./features/ai-review/AiInterpretPanel";
import { registerAgentOpener } from "./features/ai-agent/agentModel";
import { useTAssistant } from "./features/t-assistant/useTAssistant";
import WorkspaceNavigation from "./WorkspaceNavigation";
import DisplayDensityControl from "./components/terminal/DisplayDensityControl";
import PreviousLimitUpFailedBoards from "./PreviousLimitUpFailedBoards";
import { createLatestSettingsWriter } from "./latestSettingsWriter";
import { createCollectionWriter } from "./collectionWriter";
import { saveSafeLocalJson } from "./safeStorage";
import { isBacktestHistoryCollection, isExecutionLogCollection, isPaperState } from "./researchStorage";
import { shanghaiDateTag } from "./dateUtils";
import { whenVisible } from "./visiblePolling";
import { mergeObservationPool } from "./observationPool";
import {
  buildSettingsByRiskProfile,
  clampNumber,
  initialSettings,
  normalizeRiskProfile,
  normalizeSettings,
  riskProfileLabel,
  riskProfilePresets,
  safeNumber,
  sameStrategySet,
} from "./domain/settings";
import {
  normalizeBacktestExecutionReadiness,
  normalizePaperExecutionReadiness,
  type BacktestExecutionReadiness
} from "./domain/executionReadiness";

export {
  advancePaperSimulationByQuote, buildBacktestHistoryRecord, buildExecutionDecisionLogEntry,
  closePaperSimulationByCode, evaluatePaperExecutionReadiness, evaluatePaperKillSwitch,
  evaluatePaperStrategyGovernance, getPaperDailyTradeSignal, getPaperLossStreakState,
  getPaperSectorExposurePercent, getPaperSectorExposureValue, loadBacktestHistory,
  loadExecutionDecisionLog, loadPaperState, mergeReasonArrays, normalizePaperState,
  openPaperPositionFromSignal, settlePaperPosition
};
export type {
  ExecutionDecisionLog, ExecutionDecisionResult, ExecutionDecisionSource,
  PaperSimulationState, PaperStrategyGovernance, PaperStrategyStage, PaperTradeAction
};

/**
 * B2-01：「一键平掉所有当前标的」的真实入口。
 *
 * 组件内的 closeAllPaperTrades 只负责 commit + toast，平仓逻辑收敛到这里，
 * 这样在没有 DOM 的 node 测试里也能直接断言“多只持仓全部进入已平仓”（本仓库测试用
 * react-dom/server + 纯函数断言，没有 jsdom/testing-library，无法派发真实点击）。
 * 使用的是引擎里既有的全平实现，含 T+1 / 跌停等卖出阻断保护。
 */
export const closeAllPaperTradesAction = (
  state: PaperSimulationState,
  reason: PaperClosedPosition["closeReason"] = "MANUAL",
  settings: Settings = initialSettings
) => closePaperAllSimulationByCode(state, reason, normalizeSettings(settings));

const MultiStockCompareView = lazy(() => import("./MultiStockCompareView"));
// 两个常驻（hidden keep-alive）的大视图用 memo：根组件每次行情轮询更新时，props 未变就不重渲染。
const PortfolioBacktestView = lazy(() => import("./PortfolioBacktestView").then((module) => ({ default: memo(module.default) })));
const BacktestView = lazy(() =>
  import("./features/backtest/BacktestView").then((module) => ({ default: module.BacktestView }))
);
const ProfessionalReview = lazy(() => import("./ProfessionalReview").then((module) => ({ default: memo(module.default) })));
const StrategySignalsView = lazy(() => import("./StrategySignalsView"));
const SectorExplorerPanel = lazy(() => import("./SectorExplorerPanel"));
const LazyNewsView = lazy(() => import("./features/information/NewsView").then(module => ({ default: module.NewsView })));
const SettingsView = lazy(() => import("./features/settings/SettingsView").then(module => ({ default: module.SettingsView })));
const Dashboard = lazy(() => import("./features/market/MarketWorkspace").then(module => ({ default: module.Dashboard })));
const SectorView = lazy(() => import("./features/sectors/SectorView").then(module => ({ default: module.SectorView })));
const ConvertibleBondView = lazy(() => import("./features/bonds/ConvertibleBondView"));
const HsgtWebView = lazy(() => import("./features/hsgt/HsgtWebView"));
const AiPicksView = lazy(() => import("./features/ai-picks/AiPicksView"));
const AiAgentView = lazy(() => import("./features/ai-agent/AiAgentView"));
const TAssistantView = lazy(() => import("./features/t-assistant/TAssistantView"));

/** 交给 AI 解读的板块强度榜：每个板块只留数字和文字字段，成分股只留前 3 个名称。 */
function sectorsForAi(rows: any[], extra?: SectorStrengthExtra | null) {
  const industries = rows.slice(0, 20).map(row => ({ name: row?.name, changePct: row?.returns?.r1 ?? row?.memberAverageReturn ?? null, limitUps: row?.poolLimitUps ?? row?.limitUps ?? null,
    netInflow: row?.netInflow ?? null, memberCount: row?.memberCount ?? null, leader: row?.leaderName || "", limitUpStocks: (row?.leaders || []).slice(0, 3).map((item: any) => item?.name).filter(Boolean) }));
  if (!extra) return industries;
  const concepts = [...extra.concepts].sort((a, b) => (b.limitUps ?? 0) - (a.limitUps ?? 0) || b.changePct - a.changePct).slice(0, 15)
    .map(row => ({ name: row.name, changePct: row.changePct, limitUps: row.limitUps, netInflow: row.netInflow, limitUpStocks: row.limitUpStocks.slice(0, 3).map(item => item.name) }));
  return { industries, concepts, themes: extra.themes.slice(0, 10).map(theme => ({ reason: theme.reason, count: theme.count, stocks: theme.stocks.slice(0, 4).map(item => item.name) })) };
}
type SectorStrengthExtra = Pick<SectorStrengthBoard, "concepts" | "themes" | "warnings" | "conceptLimitUpSource" | "limitUpTotal" | "fetchedAt">;
const LazyFavoritesView = lazy(() => import("./features/collections/CollectionViews").then(module => ({ default: module.FavoritesView })));
const LazyHoldingsView = lazy(() => import("./features/collections/CollectionViews").then(module => ({ default: module.HoldingsView })));
const LazyWatchlistView = lazy(() => import("./features/collections/CollectionViews").then(module => ({ default: module.WatchlistView })));


export function FavoritesView(props: any) {
  return <Suspense fallback={<LoadingState />}><LazyFavoritesView {...props} /></Suspense>;
}

function HoldingsView(props: any) {
  return <Suspense fallback={<LoadingState />}><LazyHoldingsView {...props} /></Suspense>;
}

export function WatchlistView(props: any) {
  return <Suspense fallback={<LoadingState />}><LazyWatchlistView {...props} /></Suspense>;
}

export function NewsView(props: any) {
  return <Suspense fallback={<LoadingState />}><LazyNewsView {...props} /></Suspense>;
}

type AnalysisOrigin = {
  view: View;
  label: string;
  node?: string;
  dashboardMode?: "pool" | "analysis";
  informationTab?: InformationTab;
};
type LimitPoolMeta = {
  dataDate: string;
  fetchedAt: string;
  checkedAt: string;
  providers: string[];
  count: number;
  trigger: "startup" | "auto" | "manual";
};


const themeOptions = [
  { id: "light" as const, label: "白天", icon: Sun },
  { id: "dark" as const, label: "黑夜", icon: Moon },
  { id: "system" as const, label: "跟随系统", icon: Monitor }
];

const observationReturnLabel = (node: string) =>
  node === "all" ? "返回全部十日观察池" : `返回 ${node} 观察池`;

const limitPoolSignature = (rows: any[] = [], dataDate = "") => [
  String(dataDate || ""),
  ...rows
    .filter((item) => item && typeof item === "object")
    .slice()
    .sort((left, right) => String(left?.code || "").localeCompare(String(right?.code || "")))
    .map((item) => JSON.stringify([
      item?.code ?? "",
      item?.name ?? "",
      item?.industry ?? "",
      item?.limitReason ?? "",
      item?.latest ?? null,
      item?.changePct ?? null,
      item?.turnover ?? null,
      item?.amount ?? null,
      item?.firstSealTime ?? "",
      item?.lastSealTime ?? "",
      item?.sealedAmount ?? null,
      item?.sealFloatRatio ?? null,
      item?.openBoardCount ?? null,
      item?.consecutiveBoards ?? null
    ]))
].join("|");

export const computeExecutionProjection = (analysis: any, quote: any, settings: Settings) => {
  const safe = normalizeSettings(settings);
  const src = analysis || {};
  const latest = clampNumber(quote?.latest, 0.01, Number.MAX_SAFE_INTEGER, 0);
  const executionModel = estimatePaperOrderExecutionModel({ analysis: src, quote } as any, safe);
  const mrs = clampNumber(src.mrs, 50, 100, 50);
  const stopRatio = clampNumber(src.stopLossDistancePercent, 0.8, 22, 0);
  const marketCap = marketCapitalization(quote, src.marketCap);
  const qualityIndex = clampNumber(
    0.6 * mrs + 0.4 * clampNumber(src.strategyMatchRate, 0, 100, 50) - clampNumber(src.maxDrawdown, 0, 20, 0) - clampNumber(src.riskPenalty, 0, 10, 0),
    0,
    100,
    0
  );
  // R-01 修复：服务端 analysis.historicalEdge 是**对象**
  // （{ passed, sampleCount, winRate5, average5, worstMdd5, penalty, reasons }），
  // 不是数字。原实现用 `Number.isFinite(src.historicalEdge) ? … : clampNumber((src.historicalEdge || …))`，
  // 对象为真值 → `||` 短路 → clampNumber(对象) → **恒等于 0**，
  // 导致「历史边界」永远显示 0%，与同屏「历史通过/未通过」自相矛盾。
  //
  // 正确用法在项目里已有范本（ProfessionalReview.tsx:544 / MultiStockCompareView.tsx:498）：
  // 取 average5（平均 5 日收益%）作为展示数值，passed 取对象的权威判定。
  const edgeObject = src.historicalEdge && typeof src.historicalEdge === "object" ? src.historicalEdge : null;
  const historicalEdge = edgeObject
    ? clampNumber(edgeObject.average5 ?? edgeObject.winRate5 ?? 0, -20, 80, 0)
    : Number.isFinite(src.historicalEdge)
      ? (src.historicalEdge as number)
      : clampNumber((src.edge || src.marketScore || 0), -20, 80, 0);
  const historicalEdgePassed = src.qualification?.historicalEdgePassed === true
    ? true
    : edgeObject && typeof edgeObject.passed === "boolean"
      ? edgeObject.passed
      : historicalEdge >= 2;
  const minMarketCap = clampNumber(safe.minMarketCap, 0, 100000, 0);
  const marketCapPassed = minMarketCap <= 0 || (marketCap !== null && marketCap >= minMarketCap * 1e8);
  const strictGatePassed = safe.strictGate
    ? historicalEdgePassed && Boolean(auditStrategyFit(src.qualification, src.strategyMatched, src.strategyTotal))
    : true;
  const minProjectedEdge = clampNumber(safe.minProjectedNetEdgePercent ?? 0.2, -2, 10, 0.2);
  const minExpectancyPoints = clampNumber(safe.minExpectancyPoints ?? 0.2, -2, 5, 0.2);
  const effectiveAlertScore = Math.max(safe.alertScore, 60);
  const qualifiesForEntry = src.alertQualified !== false && qualityIndex >= effectiveAlertScore && historicalEdgePassed && marketCapPassed && strictGatePassed;
  const signal = qualifiesForEntry && strictGatePassed ? "BUY" : "WAIT";
  const stopDistancePercent = clampNumber(src.stopLossDistancePercent, 0.4, 20, stopRatio || 2.8);
  const rrRatio = clampNumber(
    safe.takeProfitATRMultiple / Math.max(safe.stopLossATRMultiple, 0.2),
    1.1,
    8,
    1.8
  );
  const rrSafety = clampNumber(rrRatio * (qualityIndex / 100), 0.1, 5, 1.0);
  const takeDistancePercent = clampNumber(stopDistancePercent * rrRatio, stopDistancePercent + 0.2, 40, 3.6);
  const tpBaseRate = clampNumber(
    18 + (qualityIndex - 40) * 0.7 + (signal === "BUY" ? 12 : 4),
    2,
    85,
    18
  );
  const slBaseRate = clampNumber(40 - (qualityIndex - 40) * 0.45 + (signal === "BUY" ? -2 : 0), 8, 75, 28);
  const tpProbability = signal === "BUY" ? clampNumber(tpBaseRate, 6, 85, 18) : 6;
  const slProbability = signal === "BUY" ? clampNumber(slBaseRate, 4, 80, 18) : 2;
  const timeoutProbability = clampNumber(100 - tpProbability - slProbability, 1, 100, 60);
  const quoteTurnover = clampNumber(quote?.turnover, 0, 20, 0.5);
  const relativeTurnover = clampNumber(Number(src.relativeTurnover || src.volumeRatio || 0), 0, 10, 0);
  const intradayShock = clampNumber(Math.abs(clampNumber(quote?.changePct, -20, 20, 0)), 0, 20, 0);
  const qualityExecutionFillRatePercent = clampNumber(
    18 +
      qualityIndex * 0.9 +
      Math.min(16, quoteTurnover * 2.2) +
      Math.min(12, relativeTurnover * 2.8) -
      intradayShock * 0.8 -
      Math.min(12, Math.max(0, Number(src.riskPenalty || 0)) * 1.2),
    1,
    100,
    80
  );
  const executionFillRatePercent = clampNumber(
    qualityExecutionFillRatePercent * 0.62 + executionModel.fillRatePercent * 0.38,
    1,
    100,
    executionModel.fillRatePercent
  );
  const estimatedSlippageBps = clampNumber(
    (safe.slippageBps + executionModel.executionSlipBps) / 2,
    0,
    80,
    executionModel.executionSlipBps
  );
  const minExecutionRatePercent = clampNumber(safe.minExecutionRatePercent, 40, 100, 90);
  const expectedReturnPercent = tpProbability / 100 * takeDistancePercent - slProbability / 100 * stopDistancePercent - ((safe.commissionBps + estimatedSlippageBps) / 100);
  const kellyWinRate = tpProbability / 100;
  const kellyLoseRate = 1 - kellyWinRate;
  const kellyRaw = clampNumber((kellyWinRate * rrRatio - kellyLoseRate) / rrRatio, -0.5, 1, 0);
  const halfKelly = clampNumber(kellyRaw / 2, 0, 0.5, 0);
  const qualitySignalScale = clampNumber(qualityIndex / 100, 0.25, 1, 0.75);
  const positionSizePercent = clampNumber(
    safe.maxPositionPercent * halfKelly * (0.5 + 0.5 * qualitySignalScale),
    0,
    safe.maxPositionPercent,
    0
  );
  const kellyPositionPercent = clampNumber(safe.maxPositionPercent * halfKelly, 0, safe.maxPositionPercent, 0);
  const atRiskPercent = clampNumber(positionSizePercent * (stopDistancePercent / 100), 0, safe.maxRiskPerTradePercent, 0);
  const projectedCommissionPercent = clampNumber(
    (safe.commissionBps + estimatedSlippageBps) / 100,
    0,
    5,
    0.09
  );
  const expectancyPoints = expectedReturnPercent * (positionSizePercent / Math.max(safe.maxPositionPercent, 1));
  const decay = clampNumber(safe.timeDecayPerBarPercent, 0, 1, 0.11);
  const estimatedHoldingBars = Math.max(1, Math.round(safe.maxHoldingBars * (1 - timeoutProbability / 100) * (1 - decay / 100) * (qualityIndex / 100)));
  const riskReward = Number((takeDistancePercent / Math.max(stopDistancePercent, 0.01)).toFixed(2));
  const projectedNetEdge = expectedReturnPercent;
  const projectedNetEdgeAfterDecay = projectedNetEdge - qualityIndex * 0.002;
  const killSwitchReasons = (() => {
    const reasons: string[] = [];
    if (signal !== "BUY") reasons.push("未触发买入信号");
    if (qualityIndex < effectiveAlertScore) reasons.push("质量评分不足");
    if (projectedNetEdgeAfterDecay < minProjectedEdge) reasons.push("预期净收益不足");
    if (expectancyPoints < minExpectancyPoints) reasons.push("期望值不足");
    if (rrSafety < 1.1) reasons.push("风险收益比不足");
    if (tpProbability < 30) reasons.push("TP概率偏低");
    if (slProbability > 65) reasons.push("SL概率偏高");
    if (executionFillRatePercent < minExecutionRatePercent) reasons.push("成交率不足");
    if (!marketCapPassed) reasons.push(marketCap === null ? "未取得市值，无法核对阈值" : "市值未达阈值");
    if (stopDistancePercent >= 16) reasons.push("止损过宽");
    return reasons;
  })();
  const killSwitchTriggered = signal === "BUY" && killSwitchReasons.length > 0;
  const tradePlan = {
    signal,
    maxPositionPercent: +positionSizePercent.toFixed(2),
    positionSizePercent: +positionSizePercent.toFixed(2),
    kellyPositionPercent: +kellyPositionPercent.toFixed(2),
    halfKellyFraction: +halfKelly.toFixed(3),
    atRiskPercent: +atRiskPercent.toFixed(3),
    riskReward,
    stopLossPrice: latest * (1 - stopDistancePercent / 100),
    takeProfitPrice: latest * (1 + takeDistancePercent / 100),
    stopLossDistancePercent: +stopDistancePercent.toFixed(2),
    takeProfitDistancePercent: +takeDistancePercent.toFixed(2),
    projectedCommissionPercent: +projectedCommissionPercent.toFixed(3),
    executionFillRatePercent: +executionFillRatePercent.toFixed(2),
    qualificationNote: signal === "BUY" ? "符合执行条件" : "未通过执行条件",
    killSwitchTriggered,
    killSwitchReasons
  };
  const tradeProjection = {
    strategyLabel: `${src.trendLabel || "趋势策略"} (${src.grade || "A"}-${src.infoScore ?? "N/A"})`,
    expectedReturnPercent: +expectedReturnPercent.toFixed(2),
    expectancyPoints: +expectancyPoints.toFixed(2),
    projectedNetEdge: +projectedNetEdge.toFixed(2),
    executionFillRatePercent: +executionFillRatePercent.toFixed(2),
    rrSafety: +rrSafety.toFixed(2),
    estimatedSlippageBps: +estimatedSlippageBps.toFixed(2),
    kellyPositionPercent: +kellyPositionPercent.toFixed(2),
    kellyHalfFraction: +halfKelly.toFixed(3),
    probabilityTakeProfit: +tpProbability.toFixed(2),
    probabilityStopLoss: +slProbability.toFixed(2),
    probabilityTimeExit: +timeoutProbability.toFixed(2),
    estimatedHoldingBars
  };
  return {
    qualityIndex,
    historicalEdge,
    historicalEdgePassed,
    marketCap,
    marketCapPassed,
    tradePlan,
    tradeProjection,
    executionPolicy: {
      riskProfile: safe.riskProfile,
      maxDailyRiskPercent: safe.maxDailyRiskPercent,
      maxHoldingBars: safe.maxHoldingBars,
      maxOpenPositions: safe.maxOpenPositions,
      timeDecayPerBarPercent: decay,
      minProjectedNetEdgePercent: minProjectedEdge,
      minExpectancyPoints,
      minExecutionRatePercent,
      trailingStopPercent: safe.trailingStopPercent,
      maxConsecutiveLossesForStop: safe.maxConsecutiveLossesForStop,
      lossStreakStepPercent: safe.lossStreakStepPercent,
      lossStreakFloorPercent: safe.lossStreakFloorPercent,
      expectedCostBps: projectedCommissionPercent * 100,
      estimatedExecutionSlipBps: estimatedSlippageBps,
      killSwitchTriggered: tradePlan.killSwitchTriggered,
      maxPortfolioRiskPercent: safeNumber(safe.maxPortfolioRiskPercent, 70),
      maxSectorExposurePercent: safe.maxSectorExposurePercent
    }
  };
};

const auditStrategyFit = (qualification: any, matched = 0, total = 0) => {
  if (qualification && typeof qualification === "object") {
    if (qualification.vetoReasons?.length) return false;
    if (typeof qualification.strength === "number" && qualification.strength < 0.5) return false;
  }
  if (Number.isFinite(total) && Number.isFinite(matched)) {
    return matched / Math.max(total, 1) >= 0.35;
  }
  return true;
};

// 服务端原始的交易计划/执行字段。快速刷新行情时要用它重新合并，而不是用上次合并后的结果（否则按旧价算的计划会被冻结）。
type ServerExecutionParts = { tradePlan: any; tradeProjection: any; executionPolicy: any };
const serverExecutionParts = new WeakMap<object, ServerExecutionParts>();

const enrichAnalysisWithExecution = (payload: AnalysisPayload, settings: Settings): AnalysisPayload => {
  const enriched: any = payload?.analysis || {};
  if (!enriched || typeof enriched !== "object") return payload;
  const raw = serverExecutionParts.get(enriched) || { tradePlan: enriched.tradePlan, tradeProjection: enriched.tradeProjection, executionPolicy: enriched.executionPolicy };
  const analysis: any = { ...enriched, tradePlan: raw.tradePlan, tradeProjection: raw.tradeProjection, executionPolicy: raw.executionPolicy };
  const safeSettings = normalizeSettings(settings);
  const {
    qualityIndex,
    historicalEdge,
    historicalEdgePassed,
    marketCapPassed,
    marketCap,
    tradePlan,
    tradeProjection,
    executionPolicy
  } = computeExecutionProjection(analysis, payload.quote, safeSettings);
  const tradeExecutionReadiness = normalizePaperExecutionReadiness(analysis.tradeExecutionReadiness) ||
    normalizePaperExecutionReadiness(analysis.executionReadiness);
  const next: AnalysisPayload = {
    ...payload,
    analysis: {
      ...analysis,
      qualityIndex,
      historicalEdge,
      historicalEdgePassed,
      marketCapPassed,
      marketCap,
      tradePlan: {
        ...tradePlan,
        ...(analysis.tradePlan || {})
      },
      tradeProjection: {
        ...tradeProjection,
        ...analysis.tradeProjection,
        projection: {
          ...tradeProjection,
          ...(analysis.tradeProjection?.projection || {})
        }
      },
      executionPolicy: {
        ...executionPolicy,
        ...(analysis.executionPolicy || {})
      },
      tradeExecutionReadiness: tradeExecutionReadiness
    }
  };
  serverExecutionParts.set(next.analysis, raw);
  return next;
};

type WindowControlAction = "minimize" | "toggle-maximize" | "close";

function WindowTitleBar() {
  const [maximized, setMaximized] = useState(false);
  const platform = window.stockApi.getPlatform?.() || "win32";

  const runControl = async (action: WindowControlAction) => {
    try {
      const result = await window.stockApi.controlWindow(action);
      if (action === "toggle-maximize" && result.ok) setMaximized(result.maximized);
    } catch {
      // Window chrome must remain independent from market data and navigation.
    }
  };

  return (
    <div
      className="window-dragbar"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("[data-window-controls]")) return;
        void runControl("toggle-maximize");
      }}
    >
      <span className={platform === "darwin" ? "window-title-macos" : undefined}>A股雷达</span>
      {platform !== "darwin" && <div className="window-controls" data-window-controls>
        <button
          type="button"
          className="window-control window-control-minimize"
          onClick={() => void runControl("minimize")}
          data-window-action="minimize"
          title="最小化"
          aria-label="最小化窗口"
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`window-control window-control-toggle-maximize ${maximized ? "is-maximized" : ""}`}
          onClick={() => void runControl("toggle-maximize")}
          data-window-action="toggle-maximize"
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
        >
          <Square aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-control window-control-close"
          onClick={() => void runControl("close")}
          data-window-action="close"
          title="关闭"
          aria-label="关闭窗口"
        >
          <X aria-hidden="true" />
        </button>
      </div>}
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>("signals");
  // 策略选股（含旧「涨停趋势」路由）是研究页：不启动行情轮询与旧版市场工具。
  const researchView = view === "signals" || view === "trend-screener";
  const [informationTab, setInformationTab] = useState<InformationTab>("all");
  const legacyBootstrapped = useRef(false);
  const [dashboardMode, setDashboardMode] = useState<"pool" | "analysis">("pool");
  const [watchlistNode, setWatchlistNode] = useState("all");
  const [analysisOrigin, setAnalysisOrigin] = useState<AnalysisOrigin | null>(null);
  // 个股页「AI 问股深入分析」：带上股票打开 AI 问股（只在主窗口注册，复盘独立窗口里不显示这个按钮）。
  useEffect(() => {
    registerAgentOpener(() => { setAnalysisOrigin(null); setView("ai-agent"); });
    return () => registerAgentOpener(null);
  }, []);
  const [backtestReturnMode, setBacktestReturnMode] = useState<"pool" | "analysis">("pool");
  const [backtestCenterMode, setBacktestCenterMode] = useState<"portfolio" | "single">("single");
  const [portfolioMounted, setPortfolioMounted] = useState(false);
  const portfolioActive = view === "backtest" && backtestCenterMode === "portfolio";
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Security[]>([]);
  const searchBoxRef = useRef<HTMLFormElement>(null);
  const [searchComposing, setSearchComposing] = useState(false);
  const searchComposingRef = useRef(false);
  const searchEditVersion = useRef(0);
  const [payload, setPayload] = useState<AnalysisPayload | null>(null);
  const [analysisTarget, setAnalysisTarget] = useState<Security | string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchComplete, setSearchComplete] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [confirmRequest, setConfirmRequest] = useState<ConfirmDialogRequest | null>(null);
  // 关闭的是「某一次故障」的提示：记录被关闭的故障 key，新故障出现时会重新提示。
  const [providerBannerDismissed, setProviderBannerDismissed] = useState("");
  const [sourceHealth, setSourceHealth] = useState<MarketSourceHealth | null>(null);
  const confirmResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const askConfirm = useCallback((request: ConfirmDialogRequest): Promise<boolean> => {
    // 同时只保留一个挂起确认：旧请求以「取消」结束，避免 Promise 永久悬空。
    confirmResolver.current?.(false);
    return new Promise<boolean>(resolve => {
      confirmResolver.current = resolve;
      setConfirmRequest(request);
    });
  }, []);
  const resolveConfirm = useCallback((confirmed: boolean) => {
    setConfirmRequest(null);
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    resolve?.(confirmed);
  }, []);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [live, setLive] = useState(true);
  // matchMedia is absent in some embedded/test renderers; default to an expanded navigation there.
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => typeof window.matchMedia === "function" && window.matchMedia('(max-width: 1100px)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia('(max-width: 1100px)');
    const onWidthChange = () => setNavigationCollapsed(media.matches);
    media.addEventListener('change', onWidthChange);
    return () => media.removeEventListener('change', onWidthChange);
  }, []);
  const [limitUps, setLimitUps] = useState<any[]>([]);
  const [limitPoolMeta, setLimitPoolMeta] = useState<LimitPoolMeta>({
    dataDate: "",
    fetchedAt: "",
    checkedAt: "",
    providers: [],
    count: 0,
    trigger: "startup"
  });
  const [previousLimitUpFailedSnapshot, setPreviousLimitUpFailedSnapshot] = useState<PreviousLimitUpFailedBoardSnapshot | null>(null);
  const [discovering, setDiscovering] = useState(false);
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
  const [sectorLegacyOpen, setSectorLegacyOpen] = useState(false);
  const [sectorBoard, setSectorBoard] = useState<any[]>([]);
  const [sectorBoardLoading, setSectorBoardLoading] = useState(false);
  const [sectorBoardLoaded, setSectorBoardLoaded] = useState(false);
  const [sectorBoardError, setSectorBoardError] = useState("");
  const [sectorExtra, setSectorExtra] = useState<SectorStrengthExtra | null>(null);
  const [reviewMounted, setReviewMounted] = useState(false);
  const [version, setVersion] = useState("0.1.0");
  const [paperState, setPaperState] = useState<PaperSimulationState>(loadPaperState);
  const paperStateRef = useRef(paperState);
  paperStateRef.current = paperState;
  const [paperActionSaveError, setPaperActionSaveError] = useState(false);
  const [paperSnapshotSaveError, setPaperSnapshotSaveError] = useState(false);
  const [paperSaveRetry, setPaperSaveRetry] = useState(0);
  const [executionDecisionLog, setExecutionDecisionLog] = useState<ExecutionDecisionLog[]>(loadExecutionDecisionLog);
  const savedResearch = useRef<{ paper: string; log: string; history: string } | null>(null);
  const researchSignatures = savedResearch.current ??= { paper: JSON.stringify(normalizePaperState(paperState)), log: JSON.stringify(executionDecisionLog), history: JSON.stringify(backtestHistory) };
  const searchTimer = useRef<number | undefined>(undefined);
  const searchRequestId = useRef(0);
  const latestAnalysis = useRef(payload);
  latestAnalysis.current = payload;
  const analysisRequestId = useRef(0);
  const backtestJobs = useRef(createServiceJobScope());
  const comparisonJobs = useRef(createServiceJobScope());
  const backtestRequestId = useRef(0);
  const comparisonRequestId = useRef(0);
  const limitPoolRequestId = useRef(0);
  const limitPoolSignatureRef = useRef("");
  // B-01：15s 轮询每次都会拿到一个新数组。若内容完全一致仍替换状态引用，依赖
  // limitUps 的页面（资讯中心）会把"引用变了"当成"股票池变了"，于是清空列表并重载，
  // 表现为每 15 秒闪一次。用内容快照比较，只有内容真的变化才更新引用。
  const limitPoolRowsJsonRef = useRef("");
  const limitPoolManualRefresh = useRef(false);
  const sectorBoardRequestId = useRef(0);
  const sectorBoardBusy = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);
  const watchlistRef = useRef<WatchItem[]>([]);
  const holdingsRef = useRef<HoldingItem[]>([]);
  const watchlistLoaded = useRef(false);
  const watchlistReady = useRef<Promise<boolean>>(Promise.resolve(false));
  const holdingsLoaded = useRef(false);
  const watchlistWriter = useRef<ReturnType<typeof createCollectionWriter<WatchItem>> | null>(null);
  const holdingsWriter = useRef<ReturnType<typeof createCollectionWriter<HoldingItem>> | null>(null);
  if (!watchlistWriter.current) watchlistWriter.current = createCollectionWriter<WatchItem>({
    read: () => watchlistRef.current,
    persist: next => window.stockApi.saveWatchlist(next),
    accept: saved => { watchlistRef.current = saved; setWatchlist(saved); }
  });
  if (!holdingsWriter.current) holdingsWriter.current = createCollectionWriter<HoldingItem>({
    read: () => holdingsRef.current,
    persist: next => window.stockApi.saveHoldings(next),
    accept: saved => { holdingsRef.current = saved; setHoldings(saved); }
  });
  const voiceSeenIds = useRef<Set<string>>(new Set());
  const voiceFeedSeeded = useRef(false);
  const settingsRef = useRef<Settings>(normalizeSettings(initialSettings));
  const settingsLoaded = useRef(false);
  const [settingsLoadState, setSettingsLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const settingsWriterRef = useRef<ReturnType<typeof createLatestSettingsWriter<Settings>> | null>(null);
  if (!settingsWriterRef.current) settingsWriterRef.current = createLatestSettingsWriter<Settings>({
    read: () => settingsRef.current,
    normalize: normalizeSettings,
    persist: next => window.stockApi.saveSettings(next),
    accept: saved => { settingsRef.current = saved; setSettings(saved); }
  });
  const persistSettings = (patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => {
    if (!settingsLoaded.current) return Promise.reject(new Error("本地设置尚未成功读取，请重新加载后再保存，原配置未更改。"));
    return settingsWriterRef.current!(patch);
  };


  const showToast = (message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  };

  const commitPaperAction = (next: PaperSimulationState) => {
    const normalized = normalizePaperState(next);
    if (!saveSafeLocalJson(PAPER_SIM_STATE_KEY, normalized, isPaperState)) {
      setPaperActionSaveError(true);
      showToast("纸面账户保存失败，本次操作未生效");
      return false;
    }
    // Commit the signature before rendering, so the effect never repeats this write.
    researchSignatures.paper = JSON.stringify(normalized);
    setPaperActionSaveError(false);
    setPaperSnapshotSaveError(false);
    paperStateRef.current = normalized;
    setPaperState(normalized);
    return true;
  };

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const commitLimitUpPool = useCallback((snapshot: any, requestId: number, trigger: LimitPoolMeta["trigger"]) => {
    if (requestId !== limitPoolRequestId.current) return null;
    if (!Array.isArray(snapshot) && !Array.isArray(snapshot?.rows)) {
      throw new Error("涨停池响应结构异常，已保留上次有效数据");
    }
    const rows = Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    const responseMeta = !Array.isArray(snapshot) && snapshot?.meta && typeof snapshot.meta === "object"
      ? snapshot.meta
      : {};
    const dataDate = String(responseMeta.dataDate || rows[0]?.limitDate || "");
    const signature = limitPoolSignature(rows, dataDate);
    const previousSignature = limitPoolSignatureRef.current;
    const providers = Array.isArray(responseMeta.providers)
      ? responseMeta.providers.map(String)
      : [...new Set(rows.map((item: any) => String(item?.dataProvider || "")).filter(Boolean))];
    const nextMeta: LimitPoolMeta = {
      dataDate,
      fetchedAt: String(responseMeta.fetchedAt || new Date().toISOString()),
      checkedAt: new Date().toISOString(),
      providers,
      count: rows.length,
      trigger
    };
    limitPoolSignatureRef.current = signature;
    const rowsJson = JSON.stringify(rows);
    const rowsChanged = rowsJson !== limitPoolRowsJsonRef.current;
    limitPoolRowsJsonRef.current = rowsJson;
    if (rowsChanged) setLimitUps(rows);
    setLimitPoolMeta(nextMeta);
    return {
      changed: signature !== previousSignature,
      meta: nextMeta,
      rows
    };
  }, []);

  const appendExecutionDecisionLog = (entry: Omit<ExecutionDecisionLog, "id" | "createdAt">) => {
    const next = buildExecutionDecisionLogEntry(entry);
    setExecutionDecisionLog((current) => [next, ...current].slice(0, EXECUTION_DECISION_LOG_LIMIT));
  };
  const clearExecutionDecisionLog = () => {
    setExecutionDecisionLog([]);
  };

  useEffect(() => {
    const mode = settings.theme || "system";
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = mode;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    if (mode === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);

  useEffect(() => {
    settingsRef.current = normalizeSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (view === "review") setReviewMounted(true);
  }, [view]);

  useEffect(() => {
    if (portfolioActive) setPortfolioMounted(true);
  }, [portfolioActive]);

  useEffect(() => {
    const next = normalizePaperState(paperState);
    const signature = JSON.stringify(next);
    if (signature === researchSignatures.paper) return;
    if (saveSafeLocalJson(PAPER_SIM_STATE_KEY, next, isPaperState)) {
      researchSignatures.paper = signature;
      setPaperSnapshotSaveError(false);
    } else {
      setPaperSnapshotSaveError(true);
    }
  }, [paperState, paperSaveRetry]);

  useEffect(() => {
    const signature = JSON.stringify(executionDecisionLog);
    if (signature === researchSignatures.log) return;
    if (saveSafeLocalJson(
      EXECUTION_DECISION_LOG_KEY,
      executionDecisionLog.slice(0, EXECUTION_DECISION_LOG_LIMIT), isExecutionLogCollection
    )) {
      researchSignatures.log = signature;
    }
  }, [executionDecisionLog]);

  useEffect(() => {
    const signature = JSON.stringify(backtestHistory);
    if (signature === researchSignatures.history) return;
    if (saveSafeLocalJson(
      BACKTEST_HISTORY_KEY,
      backtestHistory.slice(0, BACKTEST_HISTORY_LIMIT), isBacktestHistoryCollection
    )) {
      researchSignatures.history = signature;
    }
  }, [backtestHistory]);

  useEffect(() => {
    document.querySelector<HTMLElement>(".page")?.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

  const toSafeBacktestSettings = (nextSettings: Settings) => {
  const safe = normalizeSettings(nextSettings);
  return {
    selectedStrategies: safe.selectedStrategies,
    riskProfile: safe.riskProfile,
    minProjectedNetEdgePercent: safe.minProjectedNetEdgePercent,
    minExpectancyPoints: safe.minExpectancyPoints,
    minTurnoverPercent: safe.minTurnoverPercent,
    minQuoteAmount: safe.minQuoteAmount,
    maxQuoteAgeSeconds: safe.maxQuoteAgeSeconds,
    commissionBps: safe.commissionBps,
    slippageBps: safe.slippageBps,
    maxPositionPercent: safe.maxPositionPercent,
      maxRiskPerTradePercent: safe.maxRiskPerTradePercent,
      stopLossATRMultiple: safe.stopLossATRMultiple,
      takeProfitATRMultiple: safe.takeProfitATRMultiple,
      maxHoldingBars: safe.maxHoldingBars,
      maxOpenPositions: safe.maxOpenPositions,
      maxDailyRiskPercent: safe.maxDailyRiskPercent,
      maxPortfolioRiskPercent: safe.maxPortfolioRiskPercent,
      maxSectorExposurePercent: safe.maxSectorExposurePercent,
      minExecutionRatePercent: safe.minExecutionRatePercent,
      trailingStopPercent: safe.trailingStopPercent,
      maxConsecutiveLossesForStop: safe.maxConsecutiveLossesForStop,
      lossStreakStepPercent: safe.lossStreakStepPercent,
      lossStreakFloorPercent: safe.lossStreakFloorPercent,
      timeDecayPerBarPercent: safe.timeDecayPerBarPercent,
      minPaperWinRatePercent: safe.minPaperWinRatePercent,
      minPaperRiskRewardRatio: safe.minPaperRiskRewardRatio
    };
  };

  const toBacktestStrategyProfile = (nextSettings: Settings): BacktestStrategyProfile => {
    const safe = normalizeSettings(nextSettings);
    return {
      selectedStrategies: normalizeBacktestStrategyIds(safe.selectedStrategies),
      riskProfile: safe.riskProfile,
      minProjectedNetEdgePercent: safe.minProjectedNetEdgePercent,
      minExpectancyPoints: safe.minExpectancyPoints,
      minTurnoverPercent: safe.minTurnoverPercent,
      minQuoteAmount: safe.minQuoteAmount,
      maxQuoteAgeSeconds: safe.maxQuoteAgeSeconds,
      commissionBps: safe.commissionBps,
      slippageBps: safe.slippageBps,
      maxPositionPercent: safe.maxPositionPercent,
      maxRiskPerTradePercent: safe.maxRiskPerTradePercent,
      stopLossATRMultiple: safe.stopLossATRMultiple,
      takeProfitATRMultiple: safe.takeProfitATRMultiple,
      maxHoldingBars: safe.maxHoldingBars,
      maxOpenPositions: safe.maxOpenPositions,
      maxDailyRiskPercent: safe.maxDailyRiskPercent,
      maxPortfolioRiskPercent: safe.maxPortfolioRiskPercent,
      maxSectorExposurePercent: safe.maxSectorExposurePercent,
      minExecutionRatePercent: safe.minExecutionRatePercent,
      trailingStopPercent: safe.trailingStopPercent,
      lossStepPercent: safe.lossStreakStepPercent,
      lossFloorPercent: safe.lossStreakFloorPercent,
      maxConsecutiveLossesForStop: safe.maxConsecutiveLossesForStop,
      timeDecayPerBarPercent: safe.timeDecayPerBarPercent
    };
  };

  const formatStrategyDiffValue = (value: string[]) => {
    if (!value.length) return "未设置";
    const normalized = [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
    const visible = normalized.slice(0, 5).join(" / ");
    return normalized.length > 5 ? `${visible} 等${normalized.length}项` : visible;
  };

  const buildBacktestProfileDiff = (
    source: BacktestStrategyProfile,
    target: BacktestStrategyProfile
  ) => {
    const diff = [] as Array<{ label: string; sourceValue: string; targetValue: string }>;
    const addTextDiff = (label: string, left: string, right: string) => {
      if (left === right) return;
      diff.push({ label, sourceValue: left, targetValue: right });
    };
  const addNumberDiff = (
    label: string,
    left: number,
    right: number,
    precision = 0.01,
    suffix = ""
  ) => {
      if (!Number.isFinite(left) || !Number.isFinite(right)) return;
    if (Math.abs(left - right) <= precision) return;
    const format = (value: number) => `${value.toFixed(2)}${suffix}`;
    addTextDiff(label, format(left), format(right));
  };

  addTextDiff("风险档位", riskProfileLabel(source.riskProfile), riskProfileLabel(target.riskProfile));
  if (!sameStrategySet(source.selectedStrategies, target.selectedStrategies)) {
      diff.push({
        label: "策略组合",
        sourceValue: formatStrategyDiffValue(source.selectedStrategies),
        targetValue: formatStrategyDiffValue(target.selectedStrategies)
      });
    }

  addNumberDiff("最小预期净收益", source.minProjectedNetEdgePercent, target.minProjectedNetEdgePercent, 0.01, "%");
  addNumberDiff("最小期望值", source.minExpectancyPoints, target.minExpectancyPoints, 0.01, "");
  addNumberDiff("最低成交额", source.minQuoteAmount, target.minQuoteAmount, 10000, "元");
  addNumberDiff("最低换手率", source.minTurnoverPercent, target.minTurnoverPercent, 0.05, "%");
  addNumberDiff("最大行情时延", source.maxQuoteAgeSeconds, target.maxQuoteAgeSeconds, 5, "秒");
  addNumberDiff("佣金", source.commissionBps, target.commissionBps, 0.01, "BPS");
    addNumberDiff("滑点", source.slippageBps, target.slippageBps, 0.01, "BPS");
    addNumberDiff("最大仓位", source.maxPositionPercent, target.maxPositionPercent, 0.1, "%");
    addNumberDiff("单笔风险上限", source.maxRiskPerTradePercent, target.maxRiskPerTradePercent, 0.01, "%");
    addNumberDiff("止损ATR", source.stopLossATRMultiple, target.stopLossATRMultiple, 0.01, "x");
    addNumberDiff("止盈ATR", source.takeProfitATRMultiple, target.takeProfitATRMultiple, 0.01, "x");
    addNumberDiff("最大持仓Bars", source.maxHoldingBars, target.maxHoldingBars, 1, " 根");
    addNumberDiff("最大持仓数", source.maxOpenPositions, target.maxOpenPositions, 1);
    addNumberDiff("日内最大风险", source.maxDailyRiskPercent, target.maxDailyRiskPercent, 0.01, "%");
    addNumberDiff("组合仓位上限", source.maxPortfolioRiskPercent, target.maxPortfolioRiskPercent, 0.01, "%");
    addNumberDiff("行业仓位上限", source.maxSectorExposurePercent, target.maxSectorExposurePercent, 0.01, "%");
    addNumberDiff("最小成交率", source.minExecutionRatePercent, target.minExecutionRatePercent, 0.5, "%");
    addNumberDiff("追踪止损", source.trailingStopPercent, target.trailingStopPercent, 0.01, "%");
    addNumberDiff("减仓步幅", source.lossStepPercent, target.lossStepPercent, 0.5, "%");
    addNumberDiff("减仓下限", source.lossFloorPercent, target.lossFloorPercent, 0.5, "%");
    addNumberDiff("连续亏损停手", source.maxConsecutiveLossesForStop, target.maxConsecutiveLossesForStop, 1);
    addNumberDiff("时间衰减", source.timeDecayPerBarPercent, target.timeDecayPerBarPercent, 0.01, "%");

    return diff;
  };


type BacktestDeRiskProfileResult = {
  profile: BacktestStrategyProfile;
  adjustments: string[];
};

const buildBacktestDeRiskProfile = (
  source: BacktestStrategyProfile,
  readiness: BacktestExecutionReadiness
): BacktestDeRiskProfileResult => {
  const score = clampNumber(readiness.score, 0, 100, 60);
  const riskScale = score >= 72
    ? 0.72
    : score >= 62
      ? 0.64
      : 0.56;

  const next: BacktestStrategyProfile = {
    ...source,
    maxPositionPercent: clampNumber(source.maxPositionPercent * riskScale, 5, 90, source.maxPositionPercent),
    maxRiskPerTradePercent: clampNumber(source.maxRiskPerTradePercent * riskScale, 0.2, 5, source.maxRiskPerTradePercent),
    stopLossATRMultiple: clampNumber(source.stopLossATRMultiple * 0.9, 0.8, 5, source.stopLossATRMultiple),
    maxHoldingBars: clampNumber(Math.round(source.maxHoldingBars * 0.82), 3, 120, source.maxHoldingBars),
    maxOpenPositions: clampNumber(Math.max(1, Math.round(source.maxOpenPositions * 0.66)), 1, 10, source.maxOpenPositions),
    maxDailyRiskPercent: clampNumber(source.maxDailyRiskPercent * 0.75, 0.3, 12, source.maxDailyRiskPercent),
    maxPortfolioRiskPercent: clampNumber(source.maxPortfolioRiskPercent * 0.8, 10, 100, source.maxPortfolioRiskPercent),
    maxSectorExposurePercent: clampNumber(source.maxSectorExposurePercent * 0.9, 10, 100, source.maxSectorExposurePercent),
    minExecutionRatePercent: clampNumber(Math.min(source.minExecutionRatePercent + 6, 100), 40, 100, source.minExecutionRatePercent),
    trailingStopPercent: clampNumber(source.trailingStopPercent * 1.18, 0, 25, source.trailingStopPercent),
    lossStepPercent: clampNumber(source.lossStepPercent * 1.15, 2, 60, source.lossStepPercent),
    lossFloorPercent: clampNumber(source.lossFloorPercent * 0.9, 10, 80, source.lossFloorPercent),
    maxConsecutiveLossesForStop: clampNumber(
      Math.max(2, source.maxConsecutiveLossesForStop - 1),
      2,
      12,
      source.maxConsecutiveLossesForStop
    ),
    timeDecayPerBarPercent: clampNumber(source.timeDecayPerBarPercent * 1.18, 0, 1, source.timeDecayPerBarPercent)
  };

  next.takeProfitATRMultiple = clampNumber(
    Math.max(source.takeProfitATRMultiple * 0.9, next.stopLossATRMultiple * 1.2),
    1,
    10,
    source.takeProfitATRMultiple
  );

  const adjustments: string[] = [];
  const addDiff = (label: string, left: number, right: number, suffix = "") => {
    if (Math.abs(left - right) < 0.02) return;
    adjustments.push(`${label}：${left.toFixed(2)}${suffix} -> ${right.toFixed(2)}${suffix}`);
  };
  addDiff("最大仓位", source.maxPositionPercent, next.maxPositionPercent, "%");
  addDiff("单笔风险", source.maxRiskPerTradePercent, next.maxRiskPerTradePercent, "%");
  addDiff("止损ATR", source.stopLossATRMultiple, next.stopLossATRMultiple, "x");
  addDiff("止盈ATR", source.takeProfitATRMultiple, next.takeProfitATRMultiple, "x");
  addDiff("最大持仓Bars", source.maxHoldingBars, next.maxHoldingBars, " 根");
  addDiff("最大并行仓位", source.maxOpenPositions, next.maxOpenPositions);
  addDiff("日内最大风险", source.maxDailyRiskPercent, next.maxDailyRiskPercent, "%");
  addDiff("组合仓位上限", source.maxPortfolioRiskPercent, next.maxPortfolioRiskPercent, "%");
  addDiff("行业仓位上限", source.maxSectorExposurePercent, next.maxSectorExposurePercent, "%");
  addDiff("减仓步幅", source.lossStepPercent, next.lossStepPercent, "%");
  addDiff("减仓下限", source.lossFloorPercent, next.lossFloorPercent, "%");
  addDiff("连续亏损熔断", source.maxConsecutiveLossesForStop, next.maxConsecutiveLossesForStop, " 次");

  return {
    profile: next,
    adjustments: adjustments.length
      ? adjustments
      : ["已触发“等待确认”风控兜底，自动收紧仓位与持仓约束"]
  };
};

const evaluateBacktestExecutionReadiness = (
  metrics: Record<string, any> | null,
  profileDiffs: Array<{ label: string; sourceValue: string; targetValue: string }>,
  executionReadinessInput?: any
): BacktestExecutionReadiness => {
  const remote = normalizeBacktestExecutionReadiness(executionReadinessInput);
  if (!metrics || typeof metrics !== "object") {
    if (remote) {
      return remote;
    }
    return {
      score: 0,
      level: "block",
      status: "BLOCK",
      recommendation: "请先完成回测后再评估执行。",
      reasons: ["当前缺少完整回测指标。"],
      canRunLive: false
    };
  }

  const replayableSignals = Number(metrics.replayableSignals);
  const accepted = Boolean(metrics.accepted);
  const projectedNetEdge = Number(metrics.projectedNetEdge);
  const expectancy5 = Number(metrics.expectancy5);
  const winRate5 = Number(metrics.winRate5);
  const worstMdd5 = Number(metrics.worstMdd5);
  const averageExcess5 = Number(metrics.avgExcess5);

  const sampleScore = clampNumber(Number.isFinite(replayableSignals) ? Math.min(30, replayableSignals / 4) : 0, 0, 30);
  const edgeScore = clampNumber(
    Number.isFinite(projectedNetEdge) ? Math.min(22, (projectedNetEdge + 2) * 5) : 0,
    0,
    22
  );
  const expectancyScore = clampNumber(
    Number.isFinite(expectancy5) ? Math.min(20, (expectancy5 + 3) * 5) : 0,
    0,
    20
  );
  const winRateScore = clampNumber(
    Number.isFinite(winRate5) ? Math.min(18, winRate5 / 6) : 0,
    0,
    18
  );
  const drawdownScore = clampNumber(
    Number.isFinite(worstMdd5) ? Math.min(16, 16 - Math.max(0, -worstMdd5) * 1.4) : 0,
    0,
    16
  );
  const excessScore = clampNumber(
    Number.isFinite(averageExcess5) ? Math.min(10, Math.max(0, (averageExcess5 + 1) * 3)) : 0,
    0,
    10
  );
  const diffPenalty = clampNumber(profileDiffs.length * 2.5, 0, 24);
  const rawScore = sampleScore + edgeScore + expectancyScore + winRateScore + drawdownScore + excessScore - diffPenalty;
  const score = clampNumber(Math.round(rawScore - (accepted ? 0 : 28)), 0, 100);

  const reasons: string[] = [];
  if (!accepted) reasons.push(`预检未通过：${metrics.passReason || "参数门槛未满足"}`);
  if (!Number.isFinite(replayableSignals) || replayableSignals < 18) reasons.push(`样本偏少：${Number.isFinite(replayableSignals) ? replayableSignals.toFixed(0) : "--"} 条`);
  if (Number.isFinite(projectedNetEdge) && projectedNetEdge < 0.5) reasons.push(`净收益率偏低：${projectedNetEdge.toFixed(2)}%`);
  if (Number.isFinite(expectancy5) && expectancy5 < 0.6) reasons.push(`期望值偏低：${expectancy5.toFixed(2)}`);
  if (Number.isFinite(winRate5) && winRate5 < 52) reasons.push(`5 日胜率不足：${winRate5.toFixed(1)}%`);
  if (Number.isFinite(worstMdd5) && worstMdd5 <= -7.5) reasons.push(`回撤偏深：${worstMdd5.toFixed(2)}%`);
  if (Number.isFinite(averageExcess5) && averageExcess5 < 0) reasons.push(`历史样本5日平均超额为负：${averageExcess5.toFixed(2)}%`);
  if (profileDiffs.length > 0) reasons.push(`执行参数与回测快照差异 ${profileDiffs.length} 项`);

  let level: BacktestExecutionReadiness["level"] = "block";
  if (score >= 75 && accepted && profileDiffs.length <= 2 && worstMdd5 > -8 && replayableSignals >= 18) {
    level = "pass";
  } else if (score >= 58 && accepted && profileDiffs.length <= 5 && replayableSignals >= 12) {
    level = "wait";
  }

  const local: BacktestExecutionReadiness = {
    score,
    level,
    status: level === "pass" ? "PASS" : level === "wait" ? "WAIT" : "BLOCK",
    recommendation:
      level === "pass"
        ? "可进入执行评估：先小规模纸面试跑，再逐步放大。"
        : level === "wait"
          ? "建议先进行纸面模拟 + 进一步参数对齐，等待更稳定信号。"
          : "不建议执行：先补齐样本、优化边界后再评估。",
    reasons: reasons.length ? reasons : ["当前回测指标结构完整，执行可尝试推进。"],
    canRunLive: level === "pass"
  };

  if (!remote) return local;
  if (remote.level === "block" || local.level === "block") {
    return {
      score: Math.min(remote.score, local.score),
      level: "block",
      status: "BLOCK",
      recommendation: remote.level === "block"
        ? remote.recommendation
        : local.recommendation,
      reasons: mergeReasonArrays(remote.reasons, local.reasons),
      canRunLive: false
    };
  }
  if (remote.level === "wait" || local.level === "wait") {
    return {
      score: Math.min(remote.score, local.score),
      level: "wait",
      status: "WAIT",
      recommendation: remote.recommendation || local.recommendation,
      reasons: mergeReasonArrays(remote.reasons, local.reasons),
      canRunLive: false
    };
  }
  return {
    ...remote,
    score: Math.min(remote.score, local.score),
    reasons: mergeReasonArrays(remote.reasons, local.reasons),
    recommendation: remote.recommendation || local.recommendation,
    canRunLive: remote.canRunLive && local.canRunLive
  };
};

const buildBacktestExecutionPlan = (
  metrics: Record<string, any> | null,
  readiness: BacktestExecutionReadiness,
  profile: BacktestStrategyProfile
): BacktestExecutionPlan => {
  if (!metrics || typeof metrics !== "object") {
    return {
      canExecute: false,
      confidence: 0,
      signal: "WAIT",
      positionSizePercent: 0,
      stopLossPercent: 2,
      takeProfitPercent: 3,
      riskRewardRatio: 1.5,
      estimatedHoldingBars: Number.isFinite(Number(profile.maxHoldingBars)) ? Number(profile.maxHoldingBars) : 10,
      expectedNetEdge: 0,
      rationale: ["缺少回测指标，无法产出交易计划。"]
    };
  }

  const accepted = Boolean(metrics.accepted);
  const replayableSignals = Number(metrics.replayableSignals);
  const projectedNetEdge = Number(metrics.projectedNetEdge);
  const expectancy5 = Number(metrics.expectancy5);
  const winRate5 = Number(metrics.winRate5);
  const worstMdd5 = Number(metrics.worstMdd5);

  const basePosition = clampNumber(Number(profile.maxPositionPercent), 1, 100, 30);
  const stopLossPercent = clampNumber((Number(profile.stopLossATRMultiple) || 2) * 1.8, 0.5, 7, 2);
  const takeProfitBase = clampNumber((Number(profile.takeProfitATRMultiple) || 4) * 1.45, 1, 12, 4);
  const sampleFactor = clampNumber(Number.isFinite(replayableSignals) ? replayableSignals / 16 : 1, 0.4, 1.4, 0.9);
  const edgeFactor = clampNumber(
    Number.isFinite(projectedNetEdge) ? (projectedNetEdge + 2) / 6 : 1,
    0.45,
    1.4,
    1
  );
  const expectancyFactor = clampNumber(
    Number.isFinite(expectancy5) ? (expectancy5 + 2.5) / 4.5 : 1,
    0.5,
    1.35,
    1
  );
  const drawdownPenalty = clampNumber(
    Number.isFinite(worstMdd5) ? Math.min(0.45, Math.max(0, -worstMdd5) / 18) : 0.15,
    0,
    0.45,
    0.12
  );
  const qualityFactor = clampNumber(readiness.score / 100, 0.25, 1, 0.4);

  const dynamicPosition = clampNumber(
    basePosition * sampleFactor * edgeFactor * expectancyFactor * (1 - drawdownPenalty) * qualityFactor,
    1,
    basePosition,
    clampNumber(basePosition * 0.35, 1, 100, 5)
  );
  const dynamicTake = clampNumber(takeProfitBase * (0.75 + edgeFactor * 0.5) * (readiness.level === "pass" ? 1 : 0.86), stopLossPercent + 0.2, 12, 4);
  const expectedEdge = Number.isFinite(projectedNetEdge) ? projectedNetEdge : 0;
  const estimatedHoldingBars = clampNumber(
    Number.isFinite(Number(profile.maxHoldingBars)) ? Number(profile.maxHoldingBars) : 12,
    1,
    120,
    12
  );

  const rationale = [
    `信号质量评分 ${readiness.score}，当前执行评估为“${executionStatusLabel(readiness.status)}”。`
  ];
  if (!accepted) rationale.push("回测预检未通过，仅支持复核评估。");
  if (readiness.level === "wait") rationale.push("当前仍需等待条件确认，建议先纸面演练再考虑执行。");
  if (!Number.isFinite(replayableSignals) || replayableSignals < 18) rationale.push(`样本量偏少：${Number.isFinite(replayableSignals) ? replayableSignals.toFixed(0) : "--"} 条`);
  if (Number.isFinite(winRate5) && winRate5 < 52) rationale.push(`最近期胜率偏弱：${winRate5.toFixed(1)}%`);
  if (Number.isFinite(projectedNetEdge) && projectedNetEdge < 0.8) rationale.push(`预期收益偏弱：${projectedNetEdge.toFixed(2)}%`);

  return {
    canExecute: readiness.level !== "block",
    confidence: Math.round(qualityFactor * 100),
    signal: accepted && readiness.level !== "block" ? "BUY" : "WAIT",
    positionSizePercent: Math.round(dynamicPosition * 10) / 10,
    stopLossPercent: Math.round(stopLossPercent * 10) / 10,
    takeProfitPercent: Math.round(dynamicTake * 10) / 10,
    riskRewardRatio: Math.round((dynamicTake / Math.max(stopLossPercent, 0.01)) * 10) / 10,
    estimatedHoldingBars: Math.round(estimatedHoldingBars),
    expectedNetEdge: Math.round(expectedEdge * 100) / 100,
    rationale: rationale.length ? rationale : ["依据回测指标生成的保守执行方案"]
  };
};

  const setThemeMode = async (theme: Settings["theme"]) => {
    try { await persistSettings({ theme }); }
    catch { showToast("主题保存失败"); }
  };

  const activeAnalysisLoads = useRef(0);
  const loadSecurity = useCallback(async (
    security: Security | string,
    silent = false,
    forceRefresh = false
  ) => {
    activeAnalysisLoads.current++;
    const requestId = ++analysisRequestId.current;
    const submittedSearchVersion = searchEditVersion.current;
    if (!silent) {
      setAnalysisTarget(security);
      setPayload(null);
      setLoading(true);
      setError("");
      searchRequestId.current += 1;
      window.clearTimeout(searchTimer.current);
      setSuggestions([]);
      setSearching(false);
      setSearchError("");
      setSearchComplete(false);
    }
    try {
      const next = await window.stockApi.analyze(security, { forceRefresh });
      if (requestId !== analysisRequestId.current) return;
      const nextPayload = enrichAnalysisWithExecution(next, settingsRef.current);
      setPayload(nextPayload);
      setAnalysisTarget(nextPayload.security);
      setPaperState((current) => {
        const updated = advancePaperSimulationByQuote(current, nextPayload, settingsRef.current);
        return updated.state;
      });
      if (!silent && searchEditVersion.current === submittedSearchVersion) setQuery("");
      if (next.warning) showToast(next.warning);
    } catch (e) {
      if (requestId !== analysisRequestId.current) return;
      if (silent) showToast("刷新失败，继续显示上次有效行情");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      activeAnalysisLoads.current--;
      if (requestId === analysisRequestId.current) setLoading(false);
    }
  }, []);

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
      setBacktestHistory((current) =>
        [record, ...current.filter((item) => item.id !== record.id)].slice(0, BACKTEST_HISTORY_LIMIT)
      );
    } catch (reason) {
      if (requestId === backtestRequestId.current) setBacktestError(reason instanceof Error ? reason.message : String(reason));
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
      items: riskProfilePresets.map((item) => ({
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
        nextItem = {
          profile: preset.id,
          loading: false,
          error: "",
          record
        };
      } catch (error) {
        if (requestId !== comparisonRequestId.current) return;
        nextItem = {
          profile: preset.id,
          loading: false,
          error: error instanceof Error ? error.message : "风险档位回测失败",
          record: null
        };
      }
      nextItems.push(nextItem);
      setBacktestProfileComparisons((current) => {
        if (!current || current.comparedAt !== seed.comparedAt) return current;
        return {
          ...current,
          items: current.items.map((item) => item.profile === preset.id ? nextItem : item)
        };
      });
    }
    if (requestId !== comparisonRequestId.current) return;
    setBacktestProfileComparisons({
      sourceCode: seed.sourceCode,
      comparedAt: seed.comparedAt,
      items: nextItems
    });
  };

  const csvEscape = (value: unknown) => {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  };

  const exportBacktestPayload = (record: BacktestHistoryRecord, format: "csv" | "json") => {
    const baseName = `${record.securityCode || "backtest"}-${shanghaiDateTag(record.createdAt)}`;
    if (format === "json") {
      const payload = JSON.stringify(record, null, 2);
      const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${baseName}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    }

    const metrics = record.metrics || {};
    const lines: Array<(string | number)[]> = [
      ["回测时间", "证券代码", "证券名称", "开始日期", "策略", "是否通过", "完成交易", "累计净收益%", "累计盈亏", "总信号", "有效样本", "平均单笔净收益", "胜率", "资金最大回撤", "样本外样本", "样本外净边际", "滚动窗口通过率", "过拟合风险", "训练外退化%", "BenchmarkR1", "BenchmarkR3", "BenchmarkR5"],
      [
        record.createdAt,
        record.securityCode,
        record.securityName,
        record.draft.startDate,
        record.draft.strategyContext?.strategyName || record.strategyProfile.selectedStrategies.join(" / "),
        record.accepted ? "PASS" : "REJECT",
        metrics.tradeCount ?? record.rawResult?.profitSummary?.tradeCount ?? "",
        metrics.totalNetReturnPercent ?? record.rawResult?.profitSummary?.totalNetReturnPercent ?? "",
        metrics.totalProfitAmount ?? record.rawResult?.profitSummary?.totalProfitAmount ?? "",
        metrics.totalSignals ?? "",
        metrics.replayableSignals ?? "",
        metrics.projectedNetEdge ?? "",
        metrics.winRatePercent ?? metrics.winRate5 ?? "",
        metrics.accountMaxDrawdownPercent ?? metrics.worstMdd5 ?? "",
        metrics.oosSampleCount ?? "",
        metrics.oosProjectedNetEdge ?? "",
        metrics.walkForwardPassRate ?? "",
        metrics.overfitRisk ?? "",
        metrics.degradationPercent ?? "",
        record.benchmarkReturns?.r1 ?? "",
        record.benchmarkReturns?.r3 ?? "",
        record.benchmarkReturns?.r5 ?? ""
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
        ...strategyBreakdown.map((item: any) => [
          item.strategyId ?? "",
          item.strategyName ?? "",
          item.tradeCount ?? "",
          item.profitableTrades ?? "",
          item.losingTrades ?? "",
          item.winRatePercent ?? "",
          item.totalNetReturnPercent ?? "",
          item.totalProfitAmount ?? "",
          item.maxDrawdownPercent ?? ""
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
        ...trades.map((trade: any) => [
          trade.sequence ?? "",
          Array.isArray(trade.strategyIds) ? trade.strategyIds.join(" / ") : "",
          trade.signalDate ?? "",
          trade.entryDate ?? "",
          trade.entryPrice ?? "",
          trade.entryPriceSource === "custom_limit_price" ? "自定义限价" : "次日开盘",
          trade.exitDate ?? "",
          trade.exitPrice ?? "",
          trade.grossReturnPercent ?? "",
          trade.netReturnPercent ?? "",
          trade.profitAmount ?? "",
          trade.cumulativeReturnPercent ?? "",
          trade.endingCapital ?? ""
        ]),
        []
      );
    }
    const rows = lines.map((row) => {
      if (!Array.isArray(row)) return "";
      return row.map(csvEscape).join(",");
    });
    rows.push(csvEscape(JSON.stringify(record.rawResult || {})));
    const csv = rows.join("\n");
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
    applyBacktestProfileWithGovernance(backtestRunRecord, "BACKTEST_CURRENT", "当前");
  };

  const exportCurrentBacktest = (format: "csv" | "json") => {
    if (!backtestRunRecord) {
      showToast("请先运行回测后再导出");
      return;
    }
    exportBacktestPayload(backtestRunRecord, format);
  };

  const applyHistoryToSettings = (record: BacktestHistoryRecord) => {
    applyBacktestProfileWithGovernance(record, "BACKTEST_HISTORY", "历史");
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

  const originForView = (sourceView: View = view): AnalysisOrigin => {
    if (sourceView === "watchlist") {
      return {
        view: "watchlist",
        node: watchlistNode,
        label: observationReturnLabel(watchlistNode)
      };
    }
    if (sourceView === "news" || sourceView === "announcements") {
      const route = resolveInformationCenterRoute(sourceView, informationTab);
      return { ...route, label: `返回资讯中心 · ${informationTabs.find(tab => tab.id === route.informationTab)?.label}` };
    }
    const simple = simpleAnalysisOrigin(sourceView);
    if (simple) return simple;
    return { view: "dashboard", label: "返回涨停池" };
  };

  const openAnalysis = (security: Security | string, origin?: AnalysisOrigin | null) => {
    setAnalysisOrigin(origin || analysisOrigin || originForView());
    setDashboardMode("analysis");
    setView("dashboard");
    loadSecurity(security);
  };

  const backtestSourceLabel = (sourceView: View) => {
    if (sourceView === "signals" || sourceView === "trend-screener") return "策略选股";
    if (sourceView === "favorites") return "自选板块";
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

  const openBacktest = (
    security?: Security | string | null,
    strategyRequest?: StrategyBacktestRequest | null
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
    setBacktestDraft((current) => normalizeBacktestDraft({
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
      lookbackBars: current.lookbackBars,
      minProjectedNetEdgePercent: safeSettings.minProjectedNetEdgePercent,
      minExpectancyPoints: safeSettings.minExpectancyPoints,
      minTurnoverPercent: safeSettings.minTurnoverPercent,
      minQuoteAmount: safeSettings.minQuoteAmount,
      maxQuoteAgeSeconds: safeSettings.maxQuoteAgeSeconds,
      commissionBps: safeSettings.commissionBps,
      slippageBps: safeSettings.slippageBps,
      benchmarks: current.benchmarks
    }));
    setBacktestEntryContext((current) => ({
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
        : backtestSourceLabel(view),
      strategyIds: strategyContext?.strategyIds || normalizeBacktestStrategyIds(settings.selectedStrategies),
      strategyLabel: strategyContext?.strategyName || "当前执行设置",
      capturedAt: new Date().toISOString()
    }));
    setAnalysisOrigin({
      ...originForView(view),
      dashboardMode: view === "dashboard" ? dashboardMode : "pool"
    });
    setBacktestReturnMode(view === "dashboard" && dashboardMode === "analysis" ? "analysis" : "pool");
    setBacktestError("");
    setBacktestRunRecord(null);
    setBacktestProfileComparisons(null);
    setView("backtest");
  };

  const navigateTo = (next: View) => {
    if (next === "sectors" && view !== "sectors") setSectorBoardError("");
    if (next === "news" || next === "announcements") {
      const route = resolveInformationCenterRoute(next, informationTab);
      setInformationTab(route.informationTab);
      setView(route.view);
    } else setView(next);
    setAnalysisOrigin(null);
    if (next === "dashboard") setDashboardMode("pool");
  };

  const returnFromAnalysis = () => {
    if (analysisOrigin) {
      if (analysisOrigin.node) setWatchlistNode(analysisOrigin.node);
      if (analysisOrigin.view === "news" || analysisOrigin.view === "announcements") {
        const route = resolveInformationCenterRoute(analysisOrigin.view, analysisOrigin.informationTab);
        setInformationTab(route.informationTab);
        setView(route.view);
      } else setView(analysisOrigin.view);
      if (analysisOrigin.view === "dashboard") {
        setDashboardMode(analysisOrigin.dashboardMode || backtestReturnMode);
      }
    } else {
      setDashboardMode("pool");
      setView("dashboard");
    }
    setAnalysisOrigin(null);
  };

  const toggleNewsVoice = async () => {
    const enabled = settingsRef.current.newsVoiceEnabled === false;
    if (!enabled) window.speechSynthesis?.cancel();
    try {
      await persistSettings({ newsVoiceEnabled: enabled });
      showToast(enabled ? "重大资讯自动播报已开启" : "重大资讯自动播报已关闭");
    } catch { showToast("语音播报设置保存失败"); }
  };

  const executePaperTrade = async () => {
    if (!payload) {
      showToast("请先在分析页选择标的");
      return;
    }
    let readiness = evaluatePaperExecutionReadiness(paperStateRef.current, payload, settingsRef.current);
    if (readiness.level === "block") {
      appendExecutionDecisionLog({
        source: "PAPER_TRADE",
        result: "BLOCKED",
        level: "block",
        securityCode: String(payload.security?.code || ""),
        securityName: String(payload.security?.name || payload.security?.code || "UNKNOWN"),
        summary: readiness.summary,
        score: readiness.score,
        reasons: readiness.reasons
      });
      showToast(`${readiness.summary}，${readiness.recommendation}`);
      return;
    }
    if (readiness.level === "wait") {
      const confirmed = await askConfirm({
        title: "模拟下单需确认",
        message: readiness.summary,
        details: [readiness.recommendation, ...readiness.reasons],
        confirmLabel: "继续模拟下单",
        cancelLabel: "取消"
      });
      if (!confirmed) {
        appendExecutionDecisionLog({
          source: "PAPER_TRADE",
          result: "REJECTED",
          level: "wait",
          securityCode: String(payload.security?.code || ""),
          securityName: String(payload.security?.name || payload.security?.code || "UNKNOWN"),
          summary: "用户取消执行",
          score: readiness.score,
          reasons: readiness.reasons
        });
        showToast("已取消本次模拟下单");
        return;
      }
    }
    // The confirmation is asynchronous: quotes and the paper account may change
    // while it is open. Re-evaluate against current data before any local write.
    const currentPayload = latestAnalysis.current;
    if (!currentPayload || currentPayload.security.code !== payload.security.code) {
      showToast("分析标的已变化，请重新查看后再模拟下单");
      return;
    }
    const currentPaperState = paperStateRef.current;
    readiness = evaluatePaperExecutionReadiness(currentPaperState, currentPayload, settingsRef.current);
    if (readiness.level === "block") {
      appendExecutionDecisionLog({ source: "PAPER_TRADE", result: "BLOCKED", level: "block",
        securityCode: currentPayload.security.code, securityName: currentPayload.security.name,
        summary: readiness.summary, score: readiness.score, reasons: readiness.reasons });
      showToast(`${readiness.summary}，${readiness.recommendation}`);
      return;
    }
    const action = openPaperPositionFromSignal(currentPaperState, currentPayload, settingsRef.current);
    if (action.changed && !commitPaperAction(action.state)) return;
  appendExecutionDecisionLog({
    source: "PAPER_TRADE",
    result: action.changed ? "APPROVED" : "BLOCKED",
    level: action.changed ? readiness.level : "block",
    securityCode: String(payload.security?.code || ""),
    securityName: String(payload.security?.name || payload.security?.code || "UNKNOWN"),
      summary: action.message,
      score: readiness.score,
      reasons: readiness.reasons
    });
    showToast(action.message);
  };

  const closePaperTradeForCode = (code: string, reason: PaperClosedPosition["closeReason"] = "MANUAL") => {
    const position = paperSummary.normalized.openPositions.find((item) => item.code === code);
    if (!position) {
      showToast("当前标的无持仓可平");
      return;
    }
    const action = closePaperSimulationByCode(
      paperState,
      payload,
      settingsRef.current,
      reason,
      code,
      position.latestPrice
    );
    if (action.changed && !commitPaperAction(action.state)) return;
    showToast(action.message);
  };

  const closePaperTradeForCurrent = (reason: PaperClosedPosition["closeReason"] = "MANUAL") => {
    const code = String(payload?.security?.code || "");
    if (!code) {
      showToast("请先在分析页选择标的");
      return;
    }
    const action = closePaperSimulationByCode(paperState, payload, settingsRef.current, reason, code);
    if (action.changed && !commitPaperAction(action.state)) return;
    showToast(action.message);
  };

  // 一键平掉全部持仓（与按钮文案一致）；单只平仓能力保留在 closePaperTradeForCode / closePaperTradeForCurrent。
  const closeAllPaperTrades = (reason: PaperClosedPosition["closeReason"] = "MANUAL") => {
    const action = closeAllPaperTradesAction(paperStateRef.current, reason, settingsRef.current);
    if (action.changed && !commitPaperAction(action.state)) return;
    showToast(action.message);
  };

  const paperSummary = useMemo(() => {
    const normalized = normalizePaperState(paperState);
    const strategyGovernance = evaluatePaperStrategyGovernance(normalized, settings);
    const dailyTradeSignal = getPaperDailyTradeSignal(normalized, settings);
    const openValue = normalized.openPositions.reduce(
      (sum, position) => sum + position.latestPrice * position.shares,
      0
    );
    const openCost = normalized.openPositions.reduce(
      (sum, position) => sum + position.entryPrice * position.shares + position.entryFee,
      0
    );
    const { openPnl, maxDrawdownPercent } = getPaperAccountMetrics(normalized);
    const { cumulativeRealizedPnl, closedCount, closedWinCount, grossProfit, grossLoss, avgHoldingBars } =
      paperLifetimeMetrics(normalized);
    const lossStreakState = getPaperLossStreakState(normalized, settings);
    const currentSectorName = payload ? getSectorOfPayload(payload) : "";
    const currentSectorExposurePercent = currentSectorName
      ? getPaperSectorExposurePercent(normalized, currentSectorName)
      : 0;
    const killSwitch = evaluatePaperKillSwitch(normalized, settings);
    const openPnlPercent = openCost > 0 ? openPnl / openCost * 100 : 0;
  const equity = normalized.cash + openValue;
  const dailyLossLimit = normalized.initialCapital * (settings.maxDailyRiskPercent || 0) / 100;
  const cumulativeNetPnl = equity - normalized.initialCapital;
    const cumulativeReturnPercent = normalized.initialCapital > 0
      ? cumulativeNetPnl / normalized.initialCapital * 100
      : 0;
    const realizedReturnPercent = normalized.initialCapital > 0
      ? cumulativeRealizedPnl / normalized.initialCapital * 100
      : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;
    return {
      normalized,
      strategyGovernance,
      openValue,
      openCost,
      openPnl,
      openPnlPercent,
      equity,
      closedCount,
      winCount: closedWinCount,
      cumulativeRealizedPnl,
      realizedReturnPercent,
      cumulativeNetPnl,
      cumulativeReturnPercent,
      profitFactor,
      maxDrawdownPercent,
      avgHoldingBars,
      grossProfit,
      grossLoss,
      portfolioRiskPercent: killSwitch.portfolioExposurePercent,
      maxPortfolioRiskPercent: killSwitch.maxPortfolioRiskPercent,
      portfolioKill: killSwitch.hardTriggered,
      portfolioKillWarning: killSwitch.warningTriggered,
      portfolioKillReasons: killSwitch.reasons,
      lossPressureRatio: killSwitch.lossPressureRatio,
      portfolioUnrealizedLoss: killSwitch.openUnrealizedLoss,
      currentSectorName,
      currentSectorExposurePercent,
      maxSectorExposurePercent: settings.maxSectorExposurePercent ?? 45,
      lossStreakState,
      lossStreakConsecutive: lossStreakState.consecutiveLosses,
      lossStreakMultiplier: lossStreakState.deRiskMultiplier,
      lossStreakBlocked: lossStreakState.blockedByStreak,
      lossStreakStepPercent: lossStreakState.stepPercent,
      lossStreakFloorPercent: lossStreakState.floorPercent,
      lossStreakLimit: lossStreakState.maxConsecutiveLossesForStop,
      dailyTradeSignal,
      dailyLossLimit,
      dailyStopped: dailyLossLimit > 0 && normalized.dailyRealizedPnl <= -dailyLossLimit,
      winRate: closedCount > 0 ? closedWinCount / closedCount * 100 : 0
    };
  }, [
    paperState,
    payload?.security?.code,
    payload?.security?.name,
    settings.maxDailyRiskPercent,
    settings.maxPortfolioRiskPercent,
    settings.maxSectorExposurePercent,
    settings.maxConsecutiveLossesForStop,
    settings.lossStreakFloorPercent,
    settings.lossStreakStepPercent,
    settings.maxDailyTrades,
    settings.minPaperWinRatePercent,
    settings.minPaperRiskRewardRatio,
    settings.minExecutionRatePercent,
    settings.riskProfile,
    settings.selectedStrategies,
    settings.maxRiskPerTradePercent,
    settings.stopLossATRMultiple,
    settings.takeProfitATRMultiple,
    settings.maxHoldingBars
  ]);

  const paperCurrentPositions = payload
    ? paperSummary.normalized.openPositions.filter((position) => position.code === payload.security?.code)
    : [];
  const paperExecutionReadiness = evaluatePaperExecutionReadiness(
    paperSummary.normalized,
    payload,
    settings
  );
  const latestExecutionDecision = executionDecisionLog[0] || null;
  const canPaperTrade = paperExecutionReadiness.level !== "block";

  useEffect(() => {
    const synthesis = window.speechSynthesis;
    if (!live || settings.newsVoiceEnabled === false || !synthesis) {
      synthesis?.cancel();
      return;
    }
    let active = true;
    let busy = false;
    const pollMajorNews = async () => {
      if (busy) return;
      busy = true;
      try {
        const feed = await window.stockApi.getNewsFeed({
          scope: "all",
          direction: "all",
          limit: 120
        });
        if (!active) return;
        const items = Array.isArray(feed?.items) ? feed.items : [];
        if (!voiceFeedSeeded.current) {
          items.forEach((item: any) => voiceSeenIds.current.add(String(item.id)));
          voiceFeedSeeded.current = true;
          return;
        }
        const freshMajor = items.filter((item: any) => {
          const id = String(item.id || "");
          return id &&
            !voiceSeenIds.current.has(id) &&
            Number(item.ageMinutes || 0) <= 15 &&
            item.autoBroadcast === true;
        });
        if (voiceSeenIds.current.size > 2000) voiceSeenIds.current = new Set(items.map((item: any) => String(item.id)));
        else items.forEach((item: any) => voiceSeenIds.current.add(String(item.id)));
        if (!freshMajor.length) return;
        const text = freshMajor.slice(0, 3).reverse().map((item: any, index: number) => {
          const direction =
            item.direction === "negative" ? "风险事项" :
              item.direction === "positive" ? "正向事项" : "重要事项";
          const sectors = (item.relatedSectors || []).slice(0, 3).join("、");
          return `${index ? "下一条，" : ""}${direction}，${item.title}${sectors ? `，涉及${sectors}` : ""}`;
        }).join("。");
        const utterance = new SpeechSynthesisUtterance(`重大资讯播报。${text}`);
        utterance.lang = "zh-CN";
        utterance.rate = 0.95;
        synthesis.speak(utterance);
      } catch {
        // A failed news source should not interrupt the rest of the monitor.
      } finally {
        busy = false;
      }
    };
    const pollWhenVisible = whenVisible(pollMajorNews);
    pollWhenVisible();
    const timer = window.setInterval(
      pollWhenVisible,
      Math.max(5, Number(settings.newsRefreshSeconds) || 6) * 1000
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, settings.newsRefreshSeconds, settings.newsVoiceEnabled]);


  useEffect(() => {
    let active = true;
    let reportedFailure = false;
    const failed = () => {
      if (active && !reportedFailure) {
        reportedFailure = true;
        showToast("部分本地设置未加载，可继续使用趋势工作台");
      }
    };
    // Independent reads publish independently; a slow collection must not hide
    // another successful read. The promise boundary also contains sync bridges.
    watchlistReady.current = Promise.resolve().then(() => window.stockApi.getWatchlist()).then(value => {
      if (!active) return false;
      if (!Array.isArray(value)) { failed(); return false; }
      watchlistLoaded.current = true; watchlistRef.current = value; setWatchlist(value);
      return true;
    }).catch(() => { failed(); return false; });
    Promise.resolve().then(() => window.stockApi.getHoldings()).then(value => {
      if (!active) return;
      if (!Array.isArray(value)) { failed(); return; }
      holdingsLoaded.current = true; holdingsRef.current = value; setHoldings(value);
    }).catch(failed);
    Promise.resolve().then(() => window.stockApi.getVersion()).then(value => {
      if (active) setVersion(value);
    }).catch(failed);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    window.stockApi.getSettings().then(value => {
      if (!active) return;
      const loaded = normalizeSettings(value);
      settingsRef.current = loaded;
      settingsLoaded.current = true;
      setSettings(loaded);
      setSettingsLoadState("ready");
    }).catch(() => {
      if (active) setSettingsLoadState("failed");
    });
    return () => { active = false; };
  }, []);

  // Load the original market tools only when opened, keeping their network work
  // and five-day strategy controls out of the dedicated trend workflow.
  useEffect(() => {
    if (researchView || legacyBootstrapped.current) return;
    legacyBootstrapped.current = true;
    const requestId = ++limitPoolRequestId.current;
    void Promise.allSettled([
      Promise.resolve().then(() => window.stockApi.getLimitUpPoolSnapshot()),
      Promise.resolve().then(() => window.stockApi.discoverRecentLimitUps(11))
    ]).then(async ([poolResult, recentResult]) => {
      const recent = recentResult.status === "fulfilled" && Array.isArray(recentResult.value) ? recentResult.value : [];
      const snapshot = poolResult.status === "fulfilled" ? poolResult.value : { rows: recent.filter((item: WatchItem) => item.tradingDaysSince === 0), meta: {} };
      try {
        commitLimitUpPool(snapshot, requestId, "startup");
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "涨停行情响应异常，请稍后刷新";
        setError(message);
        showToast(message);
      }
      if (recent.length && await watchlistReady.current && watchlistLoaded.current) {
        await watchlistWriter.current!(current => mergeObservationPool(current, recent));
      }
      if (poolResult.status === "rejected" && recentResult.status === "rejected") setError("涨停行情暂时不可用，请稍后点击刷新");
    }).catch(reason => {
      setError(reason instanceof Error ? reason.message : "初始化涨停行情失败，请稍后刷新");
    });
  }, [view, commitLimitUpPool]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && searchBoxRef.current?.contains(event.target)) return;
      searchRequestId.current += 1;
      window.clearTimeout(searchTimer.current);
      setSuggestions([]); setSearching(false); setSearchError(""); setSearchComplete(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  const fetchSecuritySuggestions = useCallback(async (searchText: string, requestId: number) => {
    setSearching(true);
    setSearchError("");
    setSearchComplete(false);
    try {
      const result = await window.stockApi.search(searchText);
      if (requestId !== searchRequestId.current) return null;
      const next = Array.isArray(result) ? result : [];
      setSuggestions(next);
      setSearchComplete(true);
      return next;
    } catch {
      if (requestId !== searchRequestId.current) return null;
      setSuggestions([]);
      setSearchError("证券搜索暂不可用，请重试");
      return null;
    } finally {
      if (requestId === searchRequestId.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    const requestId = ++searchRequestId.current;
    window.clearTimeout(searchTimer.current);
    setSuggestions([]);
    setSearchError("");
    setSearchComplete(false);
    if (!query.trim() || searchComposing) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const searchText = query.trim();
    searchTimer.current = window.setTimeout(() => {
      void fetchSecuritySuggestions(searchText, requestId);
    }, 220);
    return () => {
      window.clearTimeout(searchTimer.current);
      if (requestId === searchRequestId.current) searchRequestId.current += 1;
    };
  }, [query, searchComposing, fetchSecuritySuggestions]);

  useEffect(() => {
    if (settingsLoadState !== "ready" || typeof window.stockApi?.getMarketSourceHealth !== "function") return;
    let active = true;
    const readHealth = async () => {
      try {
        const next = await window.stockApi.getMarketSourceHealth!();
        if (active) setSourceHealth(next);
      } catch {
        // 健康度只用于提示，读取失败不影响行情本身。
      }
    };
    const readHealthWhenVisible = whenVisible(readHealth);
    readHealthWhenVisible();
    const timer = window.setInterval(readHealthWhenVisible, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [settingsLoadState]);

  useEffect(() => {
    if (!live || !payload || view !== "dashboard" || dashboardMode !== "analysis") return;
    let active = true;
    let busy = false;
    const security = payload.security;
    const refreshQuote = async () => {
      if (busy) return;
      busy = true;
      try {
        const analysisGeneration = analysisRequestId.current;
        const snapshot = await window.stockApi.getQuoteSnapshot(security);
        const current = latestAnalysis.current;
        if (!active || analysisGeneration !== analysisRequestId.current || !current || current.security.code !== security.code) return;
        const next = enrichAnalysisWithExecution({
          ...current,
          quote: { ...current.quote, ...snapshot.quote, name: snapshot.quote?.name || current.quote.name, industry: snapshot.quote?.industry || current.quote.industry },
          actualProvider: snapshot.actualProvider || current.actualProvider,
          updatedAt: snapshot.updatedAt || new Date().toISOString()
        }, settingsRef.current);
        latestAnalysis.current = next;
        setPayload(next);
        setPaperState(currentState => advancePaperSimulationByQuote(currentState, next, settingsRef.current).state);
      } catch {
        // The last valid quote stays visible; the slower full refresh can recover.
      } finally {
        busy = false;
      }
    };
    const refreshQuoteWhenVisible = whenVisible(refreshQuote);
    const timer = window.setInterval(
      refreshQuoteWhenVisible,
      Math.max(3, Number(settings.quoteRefreshSeconds) || 5) * 1000
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, payload?.security.code, settings.quoteRefreshSeconds, view, dashboardMode]);

  useEffect(() => {
    if (
      !payload ||
      !live ||
      settings.multiSourceEnabled === false ||
      view !== "dashboard" ||
      dashboardMode !== "analysis"
    ) return;
    let active = true;
    let busy = false;
    const security = payload.security;
    const refreshFederation = async () => {
      if (busy) return;
      busy = true;
      try {
        const federation = await window.stockApi.getDataFederation(security);
        if (!active) return;
        setPayload((current) =>
          current?.security.code === security.code
            ? { ...current, dataFederation: federation }
            : current
        );
      } catch {
        // Primary quote remains available even if an auxiliary verifier fails.
      } finally {
        busy = false;
      }
    };
    const refreshFederationWhenVisible = whenVisible(refreshFederation);
    refreshFederationWhenVisible();
    const timer = window.setInterval(refreshFederationWhenVisible, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, payload?.security.code, settings.multiSourceEnabled, view, dashboardMode]);

  useEffect(() => {
    if (!live || !payload || view !== "dashboard" || dashboardMode !== "analysis") return;
    const timer = window.setInterval(
      whenVisible(() => { if (activeAnalysisLoads.current === 0) void loadSecurity(payload.security, true); }),
      Math.max(60, settings.refreshSeconds) * 1000
    );
    return () => window.clearInterval(timer);
  }, [live, payload?.security.code, settings.refreshSeconds, loadSecurity, view, dashboardMode]);

  useEffect(() => {
    if (!live || researchView) return;
    let active = true;
    let busy = false;
    const refreshPool = async () => {
      if (busy || limitPoolManualRefresh.current) return;
      busy = true;
      const requestId = ++limitPoolRequestId.current;
      try {
        const snapshot = await window.stockApi.getLimitUpPoolSnapshot();
        if (active) commitLimitUpPool(snapshot, requestId, "auto");
      } catch {
        // Keep the most recent complete pool during a transient source failure.
      } finally {
        busy = false;
      }
    };
    const refreshPoolWhenVisible = whenVisible(refreshPool);
    const timer = window.setInterval(refreshPoolWhenVisible, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [commitLimitUpPool, live, researchView]);

  useEffect(() => {
    if (!live || researchView) return;
    let active = true;
    let busy = false;
    const refreshObservationPool = async () => {
      if (busy) return;
      busy = true;
      try {
        const recent = await window.stockApi.discoverRecentLimitUps(11);
        if (!active) return;
        if (watchlistLoaded.current) await watchlistWriter.current!(current => mergeObservationPool(current, recent));
      } catch {
        // Keep the last complete ten-day pool until the data source recovers.
      } finally {
        busy = false;
      }
    };
    const refreshObservationPoolWhenVisible = whenVisible(refreshObservationPool);
    const timer = window.setInterval(refreshObservationPoolWhenVisible, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, researchView]);

  const loadSectorBoard = useCallback(async (forceRefresh = false) => {
    if (sectorBoardBusy.current && !forceRefresh) return false;
    sectorBoardBusy.current = true;
    const requestId = ++sectorBoardRequestId.current;
    setSectorBoardLoading(true);
    try {
      // 1.6.43：行业 + 概念两张榜和今日涨停主线一次取回；旧接口只给行业榜。
      const board = window.stockApi.getSectorStrengthBoard ? await window.stockApi.getSectorStrengthBoard({ forceRefresh }) : null;
      const rows = board ? board.industries : await window.stockApi.getLimitUpSectorBoard({ forceRefresh });
      if (!Array.isArray(rows)) throw new Error("板块排行响应结构异常，已保留上次有效数据");
      if (requestId !== sectorBoardRequestId.current) return false;
      setSectorBoard(rows);
      if (board) setSectorExtra({ concepts: Array.isArray(board.concepts) ? board.concepts : [], themes: Array.isArray(board.themes) ? board.themes : [],
        warnings: Array.isArray(board.warnings) ? board.warnings : [], conceptLimitUpSource: board.conceptLimitUpSource || "", limitUpTotal: board.limitUpTotal ?? null, fetchedAt: board.fetchedAt || "" });
      setSectorBoardError("");
      setSectorBoardLoaded(true);
      if (forceRefresh) showToast("板块排行已刷新");
      return true;
    } catch (e) {
      if (requestId !== sectorBoardRequestId.current) return false;
      const message = e instanceof Error ? e.message : "涨停板块对比加载失败";
      setSectorBoardError(message);
      showToast(message);
      return false;
    } finally {
      if (requestId === sectorBoardRequestId.current) {
        setSectorBoardLoading(false);
        sectorBoardBusy.current = false;
      }
    }
  }, []);

  // 板块强度页打开时，交易时段（北京时间工作日 9:15–11:30、13:00–15:05）每分钟静默刷新一次榜单；
  // 收盘后和午休不刷新（数据不变，也避免反复调用按次计费的扶摇接口）；页面不可见时跳过。
  useEffect(() => {
    if (view !== "sectors" || !live) return;
    const inSession = () => {
      const cn = new Date(Date.now() + 8 * 3600_000);
      const day = cn.getUTCDay(), minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
      return day >= 1 && day <= 5 && ((minute >= 9 * 60 + 15 && minute <= 11 * 60 + 30) || (minute >= 13 * 60 && minute <= 15 * 60 + 5));
    };
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!inSession()) return;
      void loadSectorBoard(false);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [view, live, loadSectorBoard]);

  useEffect(() => {
    // 榜单是主视图，进入「板块强度」即加载，不再等折叠块展开
    if (view === "sectors" && !sectorBoardLoaded && !sectorBoardLoading && !sectorBoardError) {
      loadSectorBoard(false);
    }
  }, [view, sectorBoardLoaded, sectorBoardLoading, sectorBoardError, loadSectorBoard]);

  const observationItems = useMemo(
    () => watchlist.filter((item) =>
      item.autoAdded &&
      Number(item.tradingDaysSince) >= 1 &&
      Number(item.tradingDaysSince) <= 10
    ),
    [watchlist]
  );
  const favoriteItems = useMemo(
    () => watchlist.filter((item) => item.favorite || !item.autoAdded),
    [watchlist]
  );
  const stockMonitors = useStockMonitors({
    items: favoriteItems,
    live,
    refreshSeconds: Number(settings.quoteRefreshSeconds) || 5,
    onAlert: alert => showToast(`${alert.name}（${alert.code}）：${alert.detail}`)
  });
  const tAssistant = useTAssistant({ live, onAlert: message => showToast(message) });
  const compareCandidates = useMemo(() => {
    const merged = new Map<string, Security>();
    const add = (item: any) => {
      const code = String(item?.code || "");
      if (!/^\d{6}$/.test(code) || merged.has(code)) return;
      merged.set(code, {
        ...item,
        code,
        name: String(item?.name || code),
        secid: String(item?.secid || "")
      });
    };
    if (payload?.security) add(payload.security);
    limitUps.forEach(add);
    holdings.forEach(add);
    favoriteItems.forEach(add);
    observationItems.forEach(add);
    return [...merged.values()];
  }, [payload?.security, limitUps, holdings, favoriteItems, observationItems]);
  const isFavorite = useMemo(
    () => !!payload && favoriteItems.some((item) => item.code === payload.security.code),
    [payload, favoriteItems]
  );

  const toggleFavorite = async (security = payload?.security) => {
    if (!security) return;
    if (!watchlistLoaded.current) { showToast("自选列表尚未加载，请稍后重试"); return; }
    const displayed = watchlist.find(item => item.code === security.code);
    const currentlyFavorite = Boolean(displayed && (displayed.favorite || !displayed.autoAdded));
    try {
      await watchlistWriter.current!(current => {
        const existing = current.find((item) => item.code === security.code);
        const next: WatchItem[] = currentlyFavorite
          ? existing?.autoAdded
            ? current.map((item) =>
                item.code === security.code
                  ? (() => {
                      const updated = { ...item, favorite: false };
                      delete updated.favoriteAddedAt;
                      return updated;
                    })()
                  : item
              )
            : current.filter((item) => item.code !== security.code)
          : existing
            ? current.map((item) =>
                item.code === security.code
                  ? { ...item, favorite: true, favoriteAddedAt: new Date().toISOString() }
                  : item
              )
            : [
                ...current,
                {
                  ...security,
                  createdAt: new Date().toISOString(),
                  favoriteAddedAt: new Date().toISOString(),
                  favorite: true,
                  autoAdded: false,
                  note: ""
                }
              ];
        return next;
      });
      showToast(currentlyFavorite ? "已移出自选板块" : "已加入自选板块");
    } catch { showToast("自选保存失败，已保留原有列表"); }
  };

  const removeObservation = async (security: WatchItem) => {
    if (!watchlistLoaded.current) { showToast("观察列表尚未加载，请稍后重试"); return; }
    try {
      await watchlistWriter.current!(current => current.flatMap(item => item.code !== security.code
        ? [item]
        : item.favorite || !item.autoAdded ? [{ ...item, autoAdded: false }] : []));
      showToast("已从当前观察列表移除");
    } catch { showToast("观察列表保存失败，已保留原有列表"); }
  };

  const saveHoldings = async (update: (items: HoldingItem[]) => HoldingItem[]) => {
    if (!holdingsLoaded.current) { showToast("持仓列表尚未加载，请稍后重试"); return false; }
    try {
      await holdingsWriter.current!(update);
      return true;
    } catch {
      showToast("持仓保存失败，未覆盖原有数据");
      return false;
    }
  };

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (searchComposingRef.current || !query.trim()) return;
    window.clearTimeout(searchTimer.current);
    const requestId = ++searchRequestId.current;
    if (suggestions[0]) {
      setSearchComplete(false);
      setSearchError("");
      setSearching(false);
      openAnalysis(suggestions[0]);
    } else if (/^\d{6}$/.test(query.trim())) {
      setSearchComplete(false);
      setSearchError("");
      setSearching(false);
      openAnalysis(query.trim());
    } else {
      const next = await fetchSecuritySuggestions(query.trim(), requestId);
      if (requestId === searchRequestId.current && next?.[0]) {
        setSearchComplete(false);
        openAnalysis(next[0]);
      }
    }
  };

  const discover = async () => {
    if (limitPoolManualRefresh.current) return;
    limitPoolManualRefresh.current = true;
    setDiscovering(true);
    const requestId = ++limitPoolRequestId.current;
    try {
      const snapshot = await window.stockApi.getLimitUpPoolSnapshot({ forceRefresh: true });
      const result = commitLimitUpPool(snapshot, requestId, "manual");
      if (!result) return;
      setError("");
      const source = limitPoolProviderLabel(result.meta.providers);
      const dateLabel = result.meta.dataDate || "最近交易日";
      const datePrefix = result.meta.dataDate && result.meta.dataDate !== shanghaiDateTag()
        ? `当前显示最近交易日 ${dateLabel}`
        : `${dateLabel}`;
      showToast(
        result.changed
          ? `${datePrefix} · 涨停池已更新：${result.rows.length}只 · ${source}`
          : `${datePrefix} · 涨停池已核对，暂无变化：${result.rows.length}只 · ${source}`
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : "涨停池更新失败");
    } finally {
      limitPoolManualRefresh.current = false;
      setDiscovering(false);
    }
  };

  const navItems = [
    { id: "dashboard" as View, label: "涨停监控", icon: LayoutDashboard },
    { id: "t-assistant" as View, label: "做T助手", icon: ArrowDownUp },
    { id: "previous-limit-up-failed" as View, label: "炸板观察", icon: Activity },
    { id: "favorites" as View, label: "自选板块", icon: Star },
    { id: "holdings" as View, label: "持仓股", icon: WalletCards },
    { id: "watchlist" as View, label: "观察池", icon: Bookmark },
    { id: "sectors" as View, label: "板块强度", icon: Layers3 },
    { id: "beijing" as View, label: "北交所", icon: Landmark },
    { id: "bonds" as View, label: "可转债", icon: Coins },
    { id: "hsgt" as View, label: "沪深港通", icon: ArrowLeftRight },
    { id: "news" as View, label: "资讯中心", icon: Newspaper },
    { id: "signals" as View, label: "策略选股", icon: TrendingUp },
    { id: "ai-picks" as View, label: "AI 选股", icon: Bot },
    { id: "ai-agent" as View, label: "AI 问股", icon: MessagesSquare },
    { id: "compare" as View, label: "多股同列", icon: BarChart3 },
    { id: "review" as View, label: "专业复盘", icon: BookOpenCheck },
    { id: "backtest" as View, label: "回测中心", icon: LineChart }
  ];
  const sourceNotice = settingsLoadState === "ready" ? describeSourceHealth(sourceHealth) : null;
  const providerLabel = (provider: unknown) => {
    if (provider === "ths") return "同花顺";
    if (provider === "fuyao") return "同花顺扶摇行情";
    if (provider === "ths_free") return "同花顺免费行情";
    if (provider === "eastmoney") return "东方财富";
    if (provider === "tencent") return "腾讯行情";
    if (provider === "sina") return "新浪行情";
    return "公开行情接力";
  };
  const requestedProviderLabel = providerLabel(settings.provider);
  const actualProviderLabel = payload?.actualProvider
    ? providerLabel(payload.actualProvider)
    : requestedProviderLabel;
  const marketDegraded = Boolean(error && !payload && !limitUps.length);
  const marketStatus = !live
    ? "实时刷新已暂停"
    : marketDegraded
      ? "行情连接待恢复"
      : "行情监控运行中";
  const marketStatusDetail = payload?.updatedAt
    ? `当前 ${actualProviderLabel} · ${new Date(payload.updatedAt).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`
    : `主线 ${requestedProviderLabel} · 涨停池 ${limitUps.length} 只`;

  // 组合回测视图的回调与入参保持引用稳定，配合 memo 避免轮询时整页重渲染。
  const navigationRef = useRef({ openAnalysis, returnFromAnalysis });
  navigationRef.current = { openAnalysis, returnFromAnalysis };
  const portfolioBack = useCallback(() => navigationRef.current.returnFromAnalysis(), []);
  const portfolioOpenSingle = useCallback(() => setBacktestCenterMode("single"), []);
  const portfolioOpenSecurity = useCallback((security: Security) =>
    navigationRef.current.openAnalysis(security, { view: "backtest", label: "返回组合回测" }), []);
  const portfolioInitialSecurities = useMemo(() => backtestDraft.strategyContext?.securities?.length
    ? backtestDraft.strategyContext.securities
    : backtestEntryContext?.security ? [backtestEntryContext.security] : [], [backtestDraft.strategyContext, backtestEntryContext]);

  return (
    <div className="app-shell terminal-shell" data-workspace={view} data-nav-collapsed={navigationCollapsed}>
      <WindowTitleBar />
      <WorkspaceNavigation items={navItems} active={view}
        counts={{ favorites: favoriteItems.length, holdings: holdings.length, watchlist: observationItems.length }}
        collapsed={navigationCollapsed} onCollapse={() => setNavigationCollapsed(value => !value)}
        onNavigate={id => id === "backtest" ? openBacktest() : navigateTo(id as View)} />

      <main className="main">
        <header className="topbar">
          <div className="workspace-location">{navItems.find(item => item.id === view)?.label || (view === "settings" ? "数据源设置" : "工作台")}</div>
          <form ref={searchBoxRef} className="search-box" onSubmit={handleSearch}>
            <Search size={18} />
            <input
              id="global-security-search"
              value={query}
              onCompositionStart={() => {
                searchComposingRef.current = true; setSearchComposing(true);
                searchEditVersion.current += 1; searchRequestId.current += 1;
                window.clearTimeout(searchTimer.current); setSuggestions([]); setSearching(false); setSearchError(""); setSearchComplete(false);
              }}
              onCompositionEnd={() => { searchComposingRef.current = false; setSearchComposing(false); }}
              onChange={(e) => { searchEditVersion.current += 1; searchRequestId.current += 1; setSuggestions([]); setSearchError(""); setSearchComplete(false); setQuery(e.target.value); }}
              onKeyDown={(event) => {
                if (searchComposingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
                  if (event.key === "Enter") event.preventDefault();
                  return;
                }
                if (event.key === "Escape") {
                  searchEditVersion.current += 1;
                  setQuery("");
                  setSuggestions([]);
                } else if (event.key === "ArrowDown" && suggestions.length > 0) {
                  event.preventDefault();
                  document.querySelector<HTMLButtonElement>("#global-security-suggestions button")?.focus();
                }
              }}
              placeholder="搜索 A股、ETF、可转债（代码 / 名称 / 拼音）"
              role="combobox"
              aria-label="证券搜索：A股、ETF、可转债"
              aria-expanded={suggestions.length > 0}
              aria-controls="global-security-suggestions"
            />
            {searching && <LoaderCircle size={16} className="spin" />}
            {query && !searching && (
              <button type="button" onClick={() => { searchEditVersion.current += 1; setQuery(""); }} aria-label="清空证券搜索"><X size={15} /></button>
            )}
            {query.trim() && !searchComposing && suggestions.length === 0 && (searching || searchError || searchComplete) && (
              <div className="suggestions security-search-feedback" role={searchError ? "alert" : "status"} aria-live="polite">
                <p>{searching ? "正在搜索证券…" : searchError || `未找到“${query.trim()}”，请检查名称、代码或拼音`}</p>
                {searchError && <button type="button" onClick={() => {
                  window.clearTimeout(searchTimer.current);
                  void fetchSecuritySuggestions(query.trim(), ++searchRequestId.current);
                }}>重试搜索</button>}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="suggestions" id="global-security-suggestions" role="listbox">
                {suggestions.map((item) => (
                  <button
                    key={item.secid}
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => openAnalysis(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setQuery("");
                        document.querySelector<HTMLInputElement>("#global-security-search")?.focus();
                        return;
                      }
                      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                      event.preventDefault();
                      const options = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button") || [])];
                      const currentIndex = options.indexOf(event.currentTarget);
                      const nextIndex = event.key === "ArrowDown"
                        ? (currentIndex + 1) % options.length
                        : (currentIndex - 1 + options.length) % options.length;
                      options[nextIndex]?.focus();
                    }}
                  >
                    <span><b>{item.name}</b><small>{item.code}</small></span>
                    <em>{item.marketName}</em>
                  </button>
                ))}
              </div>
            )}
          </form>
          <div className="top-actions">
            {researchView && <span className="trend-header-rule">策略驱动选股</span>}
            <DisplayDensityControl />
            <div className="theme-switch" aria-label="界面主题">
              {themeOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={(settings.theme || "system") === item.id ? "active" : ""}
                  onClick={() => setThemeMode(item.id)}
                  title={item.label}
                  aria-label={item.label}
                  aria-pressed={(settings.theme || "system") === item.id}
                >
                  <item.icon size={15} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            {!researchView && <><button className={`live-toggle ${live ? "on" : ""}`} onClick={() => setLive(!live)} aria-pressed={live}>
              <span />
              {live ? "实时刷新" : "已暂停"}
            </button>
            {canRefreshAnalysis(view, dashboardMode) && <button className="icon-button" onClick={() => payload && loadSecurity(payload.security, false, true)} disabled={!payload || loading} title="刷新当前股票" aria-label="刷新当前股票">
              <RefreshCw size={18} className={loading ? "spin" : ""} />
            </button>}
            <button
              className={`icon-button ${settings.newsVoiceEnabled === false ? "" : "voice-on"}`}
              onClick={toggleNewsVoice}
              title={settings.newsVoiceEnabled === false ? "开启重大资讯自动播报" : "关闭重大资讯自动播报"}
            >
              {settings.newsVoiceEnabled === false ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <button className="icon-button" onClick={() => navigateTo("news")} title="打开资讯中心"><Bell size={18} /><i /></button></>}
          </div>
        </header>
        {sourceNotice && sourceNotice.key !== providerBannerDismissed && (
          <div className={`provider-setup-banner ${sourceNotice.tone}`} role={sourceNotice.tone === "down" ? "alert" : "status"}>
            <CircleAlert size={16} />
            <span>{sourceNotice.message}</span>
            <button className="secondary-btn" onClick={() => navigateTo("settings")}>查看数据源</button>
            <button className="icon-button" aria-label="关闭数据源提示" title="关闭提示" onClick={() => setProviderBannerDismissed(sourceNotice.key)}><X size={15} /></button>
          </div>
        )}
        {(paperActionSaveError || paperSnapshotSaveError) && (
          <div className="paper-save-error" role="alert">
            {paperActionSaveError && <p>纸面账户保存失败，本次操作未生效。请检查存储空间后重新操作。</p>}
            {paperSnapshotSaveError && <p>纸面账户存在未保存的行情更新，请保存后再关闭软件。</p>}
            {paperSnapshotSaveError && <button className="secondary-btn" onClick={() => setPaperSaveRetry(value => value + 1)}>重试保存纸面账户</button>}
          </div>
        )}

        <div className={`page ${view === "review" ? "review-page-host" : ""}`}>
          {view === "dashboard" && (
            <Suspense fallback={<LoadingState />}><Dashboard
              live={live}
              payload={payload}
              loading={loading}
              error={error}
              isWatched={isFavorite}
              onToggleWatch={() => toggleFavorite()}
              onDiscover={discover}
              discovering={discovering}
              limitUps={limitUps}
              limitPoolMeta={limitPoolMeta}
              onOpen={(security: Security) => openAnalysis(security, { view: "dashboard", label: "返回涨停池" })}
              onAdd={(stock: Security) => {
                // 涨停池里的「监控」只加入自选，已在自选的不会被取消。
                if (!favoriteItems.some((item) => item.code === stock.code)) void toggleFavorite(stock);
              }}
              isFavorite={(code: string) => favoriteItems.some((item) => item.code === code)}
              settings={settings}
                analysisTarget={analysisTarget}
                mode={dashboardMode}
                backLabel={analysisOrigin?.label || "返回涨停池"}
                onBack={returnFromAnalysis}
                onOpenBacktest={openBacktest}
                executionDecisionLog={executionDecisionLog}
                onClearExecutionDecisionLog={clearExecutionDecisionLog}
                paperSummary={paperSummary}
                paperExecutionReadiness={paperExecutionReadiness}
                paperCurrentPositions={paperCurrentPositions}
                canPaperTrade={canPaperTrade}
                latestExecutionDecision={latestExecutionDecision}
                executePaperTrade={executePaperTrade}
                closePaperTradeForCurrent={closePaperTradeForCurrent}
                closePaperTradeForCode={closePaperTradeForCode}
                closeAllPaperTrades={closeAllPaperTrades}
                onRetry={() => analysisTarget && loadSecurity(analysisTarget, false, true)}
              /></Suspense>
            )}
          {view === "previous-limit-up-failed" && (
            <PreviousLimitUpFailedBoards
              live={live}
              cachedSnapshot={previousLimitUpFailedSnapshot}
              onSnapshot={setPreviousLimitUpFailedSnapshot}
              onOpen={(stock) => openAnalysis(stock, {
                view: "previous-limit-up-failed",
                label: "返回炸板观察"
              })}
              onAdd={(stock) => {
                if (!favoriteItems.some((item) => item.code === stock.code)) void toggleFavorite(stock);
              }}
              isFavorite={(code) => favoriteItems.some((item) => item.code === code)}
            />
          )}
          {view === "favorites" && (
            <Suspense fallback={<LoadingState />}><FavoritesView
              items={favoriteItems}
              monitors={stockMonitors}
              live={live}
              onOpen={(item: WatchItem) => openAnalysis(item, { view: "favorites", label: "返回自选板块" })}
              onRemove={toggleFavorite}
            /></Suspense>
          )}
          {view === "holdings" && (
            <Suspense fallback={<LoadingState />}><HoldingsView
              items={holdings}
              settings={settings}
              live={live}
              onSave={saveHoldings}
              onOpen={(item: HoldingItem) =>
                openAnalysis(item, { view: "holdings", label: "返回持仓股" })
              }
            /></Suspense>
          )}
          {view === "watchlist" && (
            <Suspense fallback={<LoadingState />}><WatchlistView
              items={observationItems}
              activeNode={watchlistNode}
              onNodeChange={setWatchlistNode}
              onOpen={(item: WatchItem) => openAnalysis(item, {
                view: "watchlist",
                node: watchlistNode,
                label: observationReturnLabel(watchlistNode)
              })}
              onRemove={removeObservation}
            /></Suspense>
          )}
          {view === "beijing" && (
            <Suspense fallback={<LoadingState />}><SectorView
              dedicatedSector="北交所" rows={[]} loading={false} loadError="" onRefresh={() => true}
              onOpenStock={(stock: Security) => openAnalysis(stock, { view: "beijing", label: "返回北交所" })}
            /></Suspense>
          )}
          {view === "hsgt" && <Suspense fallback={<LoadingState />}><HsgtWebView /></Suspense>}
          {view === "bonds" && (
            <Suspense fallback={<LoadingState />}><ConvertibleBondView
              onOpenSecurity={(security: Security) => openAnalysis(security, { view: "bonds", label: "返回可转债" })}
              live={live}
            /></Suspense>
          )}
          {view === "sectors" && <>
            {/* 板块强度：榜单（按涨幅排名）是主视图。
                原来这里放的是板块目录浏览，榜单被藏在默认收起的折叠块里，
                用户进入「板块强度」根本看不到排行 —— 现已对调。 */}
            <Suspense fallback={<LoadingState />}><SectorView rows={sectorBoard} extra={sectorExtra} loading={sectorBoardLoading} loadError={sectorBoardError}
              aiPanel={<AiInterpretPanel kind="sectors" disabled={!sectorBoard.length} getData={() => sectorsForAi(sectorBoard, sectorExtra)} />}
              onRefresh={() => loadSectorBoard(true)} onOpenStock={(stock: Security) => openAnalysis(stock, { view: "sectors", label: "返回板块强度" })} /></Suspense>
            <details className="sector-legacy-details" open={sectorLegacyOpen} onToggle={event => setSectorLegacyOpen(event.currentTarget.open)}>
              <summary>板块目录 · 按行业分类浏览、股票查所属行业</summary>
              {/* 目录默认展开：它提供「按目录找板块 → 看成分股」的入口，
                  与上方榜单（按涨幅排名）互补。折叠时保持挂载，避免每次展开都重新拉取目录。 */}
              <div hidden={!sectorLegacyOpen}>
                <Suspense fallback={<LoadingState />}><SectorExplorerPanel active={sectorLegacyOpen} onOpenStock={(stock: Security) => openAnalysis(stock, { view: "sectors", label: "返回板块强度" })} /></Suspense>
              </div>
            </details>
          </>}
          {(view === "news" || view === "announcements") && (
            <Suspense fallback={<LoadingState />}>
              <LazyNewsView
                payload={payload}
                watchlist={observationItems}
                holdings={holdings}
                limitUps={limitUps}
                settings={settings}
                contentType={resolveInformationCenterRoute(view, informationTab).informationTab}
                onContentTypeChange={(tab) => { setInformationTab(tab); setView("news"); }}
                onOpenStock={(stock: Security) => openAnalysis(stock, originForView(view))}
              />
            </Suspense>
          )}
          {researchView && (
            <Suspense fallback={<LoadingState />}>
              <StrategySignalsView
                live={live}
                quoteRefreshSeconds={settings.quoteRefreshSeconds}
                initialFocus={view === "trend-screener" ? "trend" : undefined}
                onOpen={(stock: Security) => openAnalysis(stock, { view: "signals", label: "返回策略选股" })}
                onOpenAiPicks={() => navigateTo("ai-picks")}
              />
            </Suspense>
          )}
          {view === "ai-picks" && (
            <Suspense fallback={<LoadingState />}>
              <AiPicksView
                live={live}
                quoteRefreshSeconds={settings.quoteRefreshSeconds}
                onOpen={(stock: Security) => openAnalysis(stock, { view: "ai-picks", label: "返回 AI 选股" })}
                onOpenStrategies={() => navigateTo("signals")}
              />
            </Suspense>
          )}
          {view === "ai-agent" && (
            <Suspense fallback={<LoadingState />}>
              <AiAgentView
                onOpenStock={(stock: Security) => openAnalysis(stock, { view: "ai-agent", label: "返回 AI 问股" })}
                onOpenSettings={() => navigateTo("settings")}
              />
            </Suspense>
          )}
          {view === "t-assistant" && (
            <Suspense fallback={<LoadingState />}>
              <TAssistantView
                api={tAssistant}
                holdings={holdings}
                live={live}
                onOpenStock={(stock: Security) => openAnalysis(stock, { view: "t-assistant", label: "返回做T助手" })}
                onToast={showToast}
              />
            </Suspense>
          )}
          {view === "compare" && (
            <Suspense fallback={<LoadingState />}>
              <MultiStockCompareView
                candidates={compareCandidates}
                live={live}
                onOpen={(stock: Security) =>
                  openAnalysis(stock, { view: "compare", label: "返回多股同列" })
                }
              />
            </Suspense>
          )}
          {(view === "review" || reviewMounted) && (
            <div hidden={view !== "review"}>
              <Suspense fallback={<LoadingState />}>
                <ProfessionalReview />
              </Suspense>
            </div>
          )}
          {(portfolioActive || portfolioMounted) && (
              <div hidden={!portfolioActive}>
                <Suspense fallback={<LoadingState />}>
                  <PortfolioBacktestView
                    active={portfolioActive}
                    initialStrategyContext={backtestDraft.strategyContext || null}
                    initialSecurities={portfolioInitialSecurities}
                    onBack={portfolioBack}
                    backLabel={analysisOrigin?.label || "返回涨停监控"}
                    onOpenSingle={portfolioOpenSingle}
                    onOpenSecurity={portfolioOpenSecurity}
                  />
                </Suspense>
              </div>
          )}
          {view === "backtest" && (
            <div hidden={backtestCenterMode !== "single"}>
              <Suspense fallback={<LoadingState />}>
                <BacktestView
                  draft={backtestDraft}
                  loading={backtestLoading}
                  error={backtestError}
                  result={backtestResult}
                  runRecord={backtestRunRecord}
                  history={backtestHistory}
                  profileComparisons={backtestProfileComparisons}
                  onDraftChange={(next) => { invalidateBacktests(); setBacktestDraft(next); }}
                  onInvalidateRun={invalidateBacktests}
                  onRun={runBacktest}
                  onRunProfileComparisons={runBacktestProfileComparisons}
                  onApplyProfileComparison={(record) =>
                    applyBacktestProfileWithGovernance(record, "BACKTEST_CURRENT", "风险档位对比")
                  }
                  onLoadHistory={loadBacktestRecord}
                  onExportHistory={exportBacktestPayload}
                  onExportCurrent={exportCurrentBacktest}
                  onApplyCurrent={applyCurrentBacktestToPaper}
                  onApplyHistory={applyHistoryToSettings}
                  onClearHistory={clearBacktestHistory}
                  onBack={returnFromAnalysis}
                  backLabel={analysisOrigin?.label || "返回涨停监控"}
                  entryContext={backtestEntryContext}
                  onTargetChange={(security, sourceLabel) => {
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
                  }}
                  currentSettings={settings}
                  executionProfile={toBacktestStrategyProfile(settings)}
                  profileDiff={(source) => buildBacktestProfileDiff(source, toBacktestStrategyProfile(settings))}
                  evaluateBacktestExecutionReadiness={evaluateBacktestExecutionReadiness}
                  buildBacktestExecutionPlan={buildBacktestExecutionPlan}
                  onOpenPortfolio={() => setBacktestCenterMode("portfolio")}
                />
              </Suspense>
            </div>
          )}
          {view === "settings" && (
            <Suspense fallback={<LoadingState />}>
              <SettingsView
                value={settings}
                loadState={settingsLoadState}
                onSave={async (next) => {
                  const analysisGeneration = analysisRequestId.current;
                  const refreshTarget = latestAnalysis.current?.security;
                  const saved = await persistSettings(next);
                  if (refreshTarget && analysisGeneration === analysisRequestId.current &&
                      latestAnalysis.current?.security.code === refreshTarget.code) {
                    await loadSecurity(refreshTarget, true);
                  }
                  showToast("设置已保存");
                  return saved;
                }}
              />
            </Suspense>
          )}
        </div>
        <footer className="terminal-statusbar">
        {!researchView && <div className="sidebar-status">
          <div className="status-row">
            <span className={`live-dot ${!live ? "paused" : marketDegraded ? "degraded" : ""}`} />
            <div><strong>{marketStatus}</strong><small>{marketStatusDetail}</small></div>
          </div>
          <div className="quota-text"><span>请求主源 {requestedProviderLabel}</span><b>实际 {actualProviderLabel}</b></div>
        </div>}
        <div className="version">趋势定制版 v{version} · 仅供研究，不构成投资建议</div>
        </footer>
      </main>
      {toast && <div className="toast" role="status" aria-live="polite"><ShieldCheck size={17} />{toast}</div>}
      <ConfirmDialog request={confirmRequest} onResolve={resolveConfirm} />
    </div>
  );
}



export default App;
