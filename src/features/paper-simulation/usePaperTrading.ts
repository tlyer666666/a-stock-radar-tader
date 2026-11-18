import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { PaperClosedPosition } from "../../domain/paperSimulationTypes";
import { inferSecid } from "../../domain/securityIdentifiers";
import { normalizeSettings } from "../../domain/settings";
import { isExecutionLogCollection, isPaperState } from "../../researchStorage";
import { saveSafeLocalJson } from "../../safeStorage";
import { whenVisible } from "../../visiblePolling";
import type { AnalysisPayload } from "../market/analysisTypes";
import type { WorkspaceView as View } from "../../workspaceView";
import { paperLifetimeMetrics } from "./paperClosedHistory";
import {
  advancePaperSimulationByQuote,
  closePaperAllSimulationByCode,
  closePaperSimulationByCode,
  confirmPaperPositionSettlement,
  evaluatePaperExecutionReadiness,
  evaluatePaperKillSwitch,
  evaluatePaperStrategyGovernance,
  getPaperAccountMetrics,
  getPaperDailyTradeSignal,
  getPaperLossStreakState,
  getPaperSectorExposurePercent,
  getSectorOfPayload,
  openPaperPositionFromSignal
} from "./paperSimulationEngine";
import {
  buildExecutionDecisionLogEntry,
  EXECUTION_DECISION_LOG_KEY,
  EXECUTION_DECISION_LOG_LIMIT,
  loadExecutionDecisionLog,
  loadPaperState,
  PAPER_SIM_STATE_KEY
} from "./paperSimulationPersistence";
import { normalizePaperState } from "./paperSimulationState";
import type { ExecutionDecisionLog, PaperSimulationState } from "./paperSimulationTypes";

type UsePaperTradingOptions = {
  payload: AnalysisPayload | null;
  latestAnalysis: MutableRefObject<AnalysisPayload | null>;
  settings: Settings;
  settingsRef: MutableRefObject<Settings>;
  settingsLoadState: "loading" | "ready" | "failed";
  live: boolean;
  view: View;
  dashboardMode: "pool" | "analysis";
  askConfirm: (request: {
    title: string;
    message: string;
    details?: string[];
    confirmLabel?: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  showToast: (message: string) => void;
};

export function usePaperTrading({
  payload,
  latestAnalysis,
  settings,
  settingsRef,
  settingsLoadState,
  live,
  view,
  dashboardMode,
  askConfirm,
  showToast
}: UsePaperTradingOptions) {
  const [paperState, setPaperState] = useState<PaperSimulationState>(loadPaperState);
  const paperStateRef = useRef(paperState);
  paperStateRef.current = paperState;
  const [paperActionSaveError, setPaperActionSaveError] = useState(false);
  const [paperSnapshotSaveError, setPaperSnapshotSaveError] = useState(false);
  const [paperSaveRetry, setPaperSaveRetry] = useState(0);
  const [executionDecisionLog, setExecutionDecisionLog] = useState<ExecutionDecisionLog[]>(loadExecutionDecisionLog);

  const savedSignatures = useRef<{ paper: string; log: string } | null>(null);
  const signatures = savedSignatures.current ??= {
    paper: JSON.stringify(normalizePaperState(paperState)),
    log: JSON.stringify(executionDecisionLog)
  };

  useEffect(() => {
    const next = normalizePaperState(paperState);
    const signature = JSON.stringify(next);
    if (signature === signatures.paper) return;
    if (saveSafeLocalJson(PAPER_SIM_STATE_KEY, next, isPaperState)) {
      signatures.paper = signature;
      setPaperSnapshotSaveError(false);
    } else {
      setPaperSnapshotSaveError(true);
    }
  }, [paperState, paperSaveRetry, signatures]);

  useEffect(() => {
    const signature = JSON.stringify(executionDecisionLog);
    if (signature === signatures.log) return;
    if (saveSafeLocalJson(
      EXECUTION_DECISION_LOG_KEY,
      executionDecisionLog.slice(0, EXECUTION_DECISION_LOG_LIMIT),
      isExecutionLogCollection
    )) {
      signatures.log = signature;
    }
  }, [executionDecisionLog, signatures]);

  const commitPaperAction = (next: PaperSimulationState) => {
    const normalized = normalizePaperState(next);
    if (!saveSafeLocalJson(PAPER_SIM_STATE_KEY, normalized, isPaperState)) {
      setPaperActionSaveError(true);
      showToast("纸面账户保存失败，本次操作未生效");
      return false;
    }
    // Commit the signature before rendering, so the effect never repeats this write.
    signatures.paper = JSON.stringify(normalized);
    setPaperActionSaveError(false);
    setPaperSnapshotSaveError(false);
    paperStateRef.current = normalized;
    setPaperState(normalized);
    return true;
  };

  const syncPaperQuote = useCallback((nextPayload: AnalysisPayload) => {
    setPaperState(currentState => advancePaperSimulationByQuote(currentState, nextPayload, settingsRef.current).state);
  }, [settingsRef]);

  const appendExecutionDecisionLog = (entry: Omit<ExecutionDecisionLog, "id" | "createdAt">) => {
    const next = buildExecutionDecisionLogEntry(entry);
    setExecutionDecisionLog(current => [next, ...current].slice(0, EXECUTION_DECISION_LOG_LIMIT));
  };

  const clearExecutionDecisionLog = () => {
    setExecutionDecisionLog([]);
  };

  const retryPaperSave = () => setPaperSaveRetry(value => value + 1);

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
    payload,
    settings
  ]);

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
      appendExecutionDecisionLog({
        source: "PAPER_TRADE",
        result: "BLOCKED",
        level: "block",
        securityCode: currentPayload.security.code,
        securityName: currentPayload.security.name,
        summary: readiness.summary,
        score: readiness.score,
        reasons: readiness.reasons
      });
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
    const currentPaperState = paperStateRef.current;
    const position = paperSummary.normalized.openPositions.find(item => item.code === code);
    if (!position) {
      showToast("当前标的无持仓可平");
      return;
    }
    const action = closePaperSimulationByCode(
      currentPaperState,
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
    const action = closePaperSimulationByCode(paperStateRef.current, payload, settingsRef.current, reason, code);
    if (action.changed && !commitPaperAction(action.state)) return;
    showToast(action.message);
  };

  // 一键平掉全部持仓（与按钮文案一致）；单只平仓能力保留在 closePaperTradeForCode / closePaperTradeForCurrent。
  const closeAllPaperTrades = (reason: PaperClosedPosition["closeReason"] = "MANUAL") => {
    const action = closePaperAllSimulationByCode(paperStateRef.current, reason, normalizeSettings(settingsRef.current));
    if (action.changed && !commitPaperAction(action.state)) return;
    showToast(action.message);
  };

  const confirmPaperSettlementForCode = (code: string) => {
    const action = confirmPaperPositionSettlement(paperStateRef.current, code, payload);
    if (action.changed && !commitPaperAction(action.state)) return;
    showToast(action.message);
  };

  const openPositionsSignature = paperSummary.normalized.openPositions.map(p => p.code).sort().join(",");
  useEffect(() => {
    if (!live || settingsLoadState !== "ready" || !openPositionsSignature || typeof window.stockApi?.getQuoteSnapshot !== "function") return;
    let active = true;
    let busy = false;
    const pollOpenPositions = async () => {
      if (busy) return;
      busy = true;
      try {
        const activeDashboardCode = view === "dashboard" && dashboardMode === "analysis" ? latestAnalysis.current?.security.code || "" : "";
        const maxPollCount = Math.max(10, Math.round(Number(settingsRef.current.maxOpenPositions) || 10));
        const targets = openPositionsSignature.split(",").filter(code => code && code !== activeDashboardCode).slice(0, maxPollCount);
        for (const code of targets) {
          if (!active) break;
          try {
            const security: Security = { code, name: code, secid: inferSecid(code), assetType: "stock" };
            const snapshot = await window.stockApi.getQuoteSnapshot(security);
            const latest = Number(snapshot?.quote?.latest);
            if (!active || !Number.isFinite(latest) || latest <= 0) continue;
            const synthetic = {
              security: { ...security, name: snapshot.quote?.name || code },
              quote: snapshot.quote,
              actualProvider: snapshot.actualProvider || settingsRef.current.provider,
              updatedAt: snapshot.updatedAt || new Date().toISOString()
            } as unknown as AnalysisPayload;
            const res = advancePaperSimulationByQuote(paperStateRef.current, synthetic, settingsRef.current);
            if (res.changed) {
              paperStateRef.current = res.state;
              setPaperState(res.state);
              if (res.message) showToast(`模拟持仓巡检：${res.message}`);
            }
          } catch {
            // Single position quote error should not interrupt monitoring others.
          }
        }
      } finally {
        busy = false;
      }
    };
    const pollVisible = whenVisible(() => void pollOpenPositions());
    const timer = window.setInterval(pollVisible, Math.max(15, (Number(settings.quoteRefreshSeconds) || 5) * 3) * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [live, settingsLoadState, openPositionsSignature, settings.quoteRefreshSeconds, view, dashboardMode, showToast, latestAnalysis, settingsRef]);

  const paperCurrentPositions = payload
    ? paperSummary.normalized.openPositions.filter(position => position.code === payload.security?.code)
    : [];
  const paperExecutionReadiness = evaluatePaperExecutionReadiness(
    paperSummary.normalized,
    payload,
    settings
  );
  const latestExecutionDecision = executionDecisionLog[0] || null;
  const canPaperTrade = paperExecutionReadiness.level !== "block";

  return {
    paperState,
    paperActionSaveError,
    paperSnapshotSaveError,
    retryPaperSave,
    executionDecisionLog,
    appendExecutionDecisionLog,
    clearExecutionDecisionLog,
    syncPaperQuote,
    paperSummary,
    paperCurrentPositions,
    paperExecutionReadiness,
    latestExecutionDecision,
    canPaperTrade,
    executePaperTrade,
    closePaperTradeForCode,
    closePaperTradeForCurrent,
    closeAllPaperTrades,
    confirmPaperSettlementForCode
  };
}
