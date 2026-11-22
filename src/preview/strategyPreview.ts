import type { StockApi } from "../shared/ipc-contract";
import { createTrendPreviewStatus, createConfiguredTrendPreviewStatus } from "../trendScreenerPreview";
import { CUSTOM_CATALOG, type CustomStrategy } from "../features/strategy-selection/customStrategyModel";
import {
  previewSecurities,
  previewVerifiedStrategies,
  previewExtraIds,
  resolveSecurity,
  previewState,
  savePreviewCustom
} from "./shared";
import { buildPreviewPayload } from "./mockMarketData";
import type { StrategyLeaderboardStrategyRow } from "../shared/ipc-contract";

export type PreviewStrategyApi = Pick<
  StockApi,
  | "getStrategyDefinitions"
  | "listCustomStrategies"
  | "saveCustomStrategy"
  | "deleteCustomStrategy"
  | "importSettingsStrategy"
  | "cancelServiceJob"
  | "runBacktest"
  | "runPortfolioBacktest"
  | "scanStrategySignals"
  | "getStrategyLeaderboard"
  | "startTrendScan"
  | "evaluateTrendResearch"
  | "checkTrendExecution"
  | "getTrendScan"
  | "cancelTrendScan"
>;

export function createPreviewStrategyMethods(): PreviewStrategyApi {
  let trendState = createTrendPreviewStatus();
  return {
    async getStrategyDefinitions() {
      return previewVerifiedStrategies.map((item) => ({ ...item }));
    },
    async listCustomStrategies() { return structuredClone(previewState.customStrategies); },
    async saveCustomStrategy(strategy: CustomStrategy) { return savePreviewCustom(strategy); },
    async deleteCustomStrategy(id: string) {
      if (!previewState.customStrategies.some(item => item.id === id)) throw new Error("策略不存在或已删除");
      previewState.customStrategies = previewState.customStrategies.filter(item => item.id !== id);
      return { strategies: structuredClone(previewState.customStrategies) };
    },
    async importSettingsStrategy() {
      return savePreviewCustom({ ...structuredClone(previewState.customStrategies[0] || {} as CustomStrategy), id: null, name: `设置导入${previewState.customSequence + 1}`, origin: "legacy-settings" });
    },
    async cancelServiceJob(_requestId) { return false; },
    async runBacktest(security, options = {}) {
      const resolved = resolveSecurity(security);
      const settings = { ...previewState.settings, ...(options.settings || {}) };
      const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.startDate || ""))
        ? String(options.startDate).slice(0, 10)
        : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      const signalTo = new Date().toISOString().slice(0, 10);
      const minimumSamples = Math.max(18, Number(options.minSamples) || 18);
      const signalStrategyIds = Array.isArray(options.signalStrategyIds)
        ? [...new Set(options.signalStrategyIds.map(String).filter(Boolean))]
        : [];
      const strategyIds = signalStrategyIds.length
        ? signalStrategyIds
        : [...new Set([...(settings.selectedStrategies || []), "riskVeto"])];
      const strategyContext = signalStrategyIds.length
        ? {
          ...(options.strategyContext || {}),
          strategyEngine: "verified-signal-v2",
          strategyIds: signalStrategyIds,
          componentNames: signalStrategyIds
        }
        : undefined;
      const walkForwardValidation = {
        available: false,
        accepted: false,
        sampleCount: 0,
        minimumSamples,
        folds: [],
        foldPassRate: 0,
        positiveFoldRate: 0,
        oosSampleCount: 0,
        oosWinRate5: 0,
        oosExpectancy5: 0,
        oosProjectedNetEdge: 0,
        oosWorstMdd5: 0,
        degradationPercent: 100,
        overfitRisk: "insufficient",
        reason: "预览模式没有真实逐事件样本，样本外验证不可用"
      };
      const executionReadiness = {
        score: 0,
        level: "block",
        status: "BLOCK",
        summary: "预览回测禁止进入执行",
        recommendation: "请使用桌面版真实历史数据完成滚动样本外验证。",
        reasons: [walkForwardValidation.reason],
        canRunLive: false,
        canExecute: false
      };
      return {
        security: resolved,
        generatedAt: new Date().toISOString(),
        lookbackBars: 120,
        entryPriceMode: Number(options.customEntryPrice) > 0
          ? "custom_limit_price"
          : "next_market_open",
        customEntryPrice: Number(options.customEntryPrice) > 0
          ? Number(options.customEntryPrice)
          : null,
        range: {
          requestedFrom: startDate,
          signalFrom: startDate,
          signalTo,
          historyFrom: startDate,
          historyTo: signalTo,
          historyBars: 120
        },
        ...(strategyContext
          ? {
            backtestMode: "verified_signal_strategy",
            strategyEngine: "verified-signal-v2",
            strategyMode: signalStrategyIds.length > 1
              ? "multi_strategy_vote"
              : "single_verified_strategy",
            minimumVotes: Number(strategyContext.minimumVotes) || 1,
            strategyContext
          }
          : {}),
        strategyIds,
        strategyProfile: {
          riskProfile: settings.riskProfile,
          selectedStrategies: strategyIds,
          minProjectedNetEdgePercent: settings.minProjectedNetEdgePercent,
          minExpectancyPoints: settings.minExpectancyPoints,
          minTurnoverPercent: settings.minTurnoverPercent,
          minQuoteAmount: settings.minQuoteAmount,
          maxQuoteAgeSeconds: settings.maxQuoteAgeSeconds,
          commissionBps: settings.commissionBps,
          slippageBps: settings.slippageBps,
          maxPositionPercent: settings.maxPositionPercent,
          maxRiskPerTradePercent: settings.maxRiskPerTradePercent,
          stopLossATRMultiple: settings.stopLossATRMultiple,
          takeProfitATRMultiple: settings.takeProfitATRMultiple,
          maxHoldingBars: settings.maxHoldingBars,
          maxOpenPositions: settings.maxOpenPositions,
          maxDailyRiskPercent: settings.maxDailyRiskPercent,
          maxPortfolioRiskPercent: settings.maxPortfolioRiskPercent,
          maxSectorExposurePercent: settings.maxSectorExposurePercent,
          minExecutionRatePercent: settings.minExecutionRatePercent,
          trailingStopPercent: settings.trailingStopPercent,
          lossStepPercent: settings.lossStreakStepPercent,
          lossFloorPercent: settings.lossStreakFloorPercent,
          maxConsecutiveLossesForStop: settings.maxConsecutiveLossesForStop,
          timeDecayPerBarPercent: settings.timeDecayPerBarPercent
        },
        metrics: {
          totalSignals: 0,
          replayableSignals: 0,
          untradeableSignals: 0,
          winRate5: 0,
          averageR5: 0,
          medianR5: 0,
          expectancy5: 0,
          projectedNetEdge: 0,
          worstMdd5: 0,
          avgExcess5: 0,
          walkForwardAvailable: false,
          walkForwardAccepted: false,
          walkForwardPassRate: 0,
          oosSampleCount: 0,
          oosWinRate5: 0,
          oosExpectancy5: 0,
          oosProjectedNetEdge: 0,
          oosWorstMdd5: 0,
          overfitRisk: "insufficient",
          degradationPercent: 100,
          tradeCount: 0,
          profitableTrades: 0,
          losingTrades: 0,
          totalNetReturnPercent: 0,
          totalProfitAmount: 0,
          winRatePercent: 0,
          accountMaxDrawdownPercent: 0,
          accepted: false,
          passReason: walkForwardValidation.reason,
          source: "preview"
        },
        nodeStats: [],
        benchmarkReturns: { r1: 0, r3: 0, r5: 0, spanBars: 0 },
        trades: [],
        profitSummary: {
          startingCapital: 200000,
          endingCapital: 200000,
          totalProfitAmount: 0,
          totalNetReturnPercent: 0,
          positionPercent: Number(settings.maxPositionPercent || 100),
          roundTripCostPercent: Number(((Number(settings.commissionBps || 0) + Number(settings.slippageBps || 0)) * 2 / 100).toFixed(4)),
          tradeCount: 0,
          profitableTrades: 0,
          losingTrades: 0,
          flatTrades: 0,
          winRatePercent: 0,
          maxDrawdownPercent: 0,
          skippedOverlaps: 0
        },
        historicalSamplePath: {
          startingCapital: 200000,
          endingCapital: 200000,
          positionPercent: 0,
          roundTripCostPercent: 0,
          skippedOverlaps: 0,
          points: []
        },
        walkForwardValidation,
        tradeExecutionReadiness: executionReadiness,
        executionReadiness,
        rawStats: { source: "preview", strategyIds }
      };
    },
    async runPortfolioBacktest(input) {
      const securities = (Array.isArray(input.securities) ? input.securities : [])
        .map((item) => resolveSecurity(item))
        .filter((item, index, rows) => rows.findIndex((row) => row.code === item.code) === index);
      const requestedStrategyIds = [...new Set(
        (Array.isArray(input.strategyIds) ? input.strategyIds : [])
          .map(String)
          .filter(Boolean)
      )];
      const strategyIds = requestedStrategyIds.length
        ? requestedStrategyIds
        : [previewVerifiedStrategies[0]?.id || "low_first_board"];
      const startingCapital = Math.max(10_000, Number(input.startingCapital) || 200_000);
      const minimumVotes = Math.max(
        1,
        Math.min(strategyIds.length || 1, Math.round(Number(input.minimumVotes) || 1))
      );
      const maxPositions = Math.max(
        1,
        Math.min(10, Math.round(Number(input.maxPositions) || 3))
      );
      const pointCount = 64;
      const equityCurve = Array.from({ length: pointCount }, (_, index) => {
        const date = new Date(2026, 4, 5 + index);
        const progress = index / Math.max(1, pointCount - 1);
        const returnPercent = progress * 8.4 + Math.sin(index / 5) * 1.7;
        const equity = startingCapital * (1 + returnPercent / 100);
        return {
          date: date.toISOString().slice(0, 10),
          equity: Number(equity.toFixed(2)),
          cash: Number((equity * 0.34).toFixed(2)),
          openPositions: Math.min(maxPositions, index % (maxPositions + 1)),
          returnPercent: Number(returnPercent.toFixed(3)),
          drawdownPercent: Number((-Math.max(0, Math.sin(index / 7) * 1.9)).toFixed(3))
        };
      });
      const endingCapital = equityCurve.at(-1)?.equity || startingCapital;
      const totalReturnPercent = (endingCapital / startingCapital - 1) * 100;
      const contributions = securities.map((security, index) => ({
        code: security.code,
        name: security.name,
        tradeCount: 3 + index,
        winCount: 2 + Math.floor(index / 2),
        winRate: Number(((2 + Math.floor(index / 2)) / (3 + index) * 100).toFixed(2)),
        netPnl: Number((startingCapital * (0.018 + index * 0.006)).toFixed(2)),
        contributionPercent: Number((1.8 + index * 0.6).toFixed(2)),
        averageReturn: Number((1.2 + index * 0.25).toFixed(2))
      }));
      const trades = securities.flatMap((security, index) => [0, 1].map((roundIndex) => ({
        id: `${security.code}-${roundIndex}`,
        code: security.code,
        name: security.name,
        signalDate: `2026-0${5 + roundIndex}-0${6 + index}`,
        entryDate: `2026-0${5 + roundIndex}-0${7 + index}`,
        exitDate: `2026-0${5 + roundIndex}-1${2 + index}`,
        entryPrice: Number((28 + index * 17 + roundIndex).toFixed(2)),
        exitPrice: Number((28.8 + index * 17 + roundIndex).toFixed(2)),
        netReturn: Number((2.1 - index * 0.4 + roundIndex * 0.3).toFixed(2)),
        netPnl: Number((1260 - index * 180 + roundIndex * 90).toFixed(2)),
        allocation: Number((startingCapital / maxPositions).toFixed(2)),
        shares: Math.max(100, Math.floor((startingCapital / maxPositions) / (28 + index * 17 + roundIndex) / 100) * 100),
        strategyIds: strategyIds.slice(0, Math.max(1, minimumVotes))
      })));
      const strategyNameById = new Map(previewVerifiedStrategies.map((item) => [item.id, item.name]));
      const filledSignalEvents = trades.map((trade) => ({
        sampleId: `preview-signal-${trade.id}`,
        code: trade.code,
        name: trade.name,
        strategyId: trade.strategyIds[0] || strategyIds[0]!,
        strategyIds: trade.strategyIds,
        strategyNames: trade.strategyIds.map((id) => strategyNameById.get(id) || id),
        signalDate: trade.signalDate,
        entryDate: trade.entryDate,
        exitDate: trade.exitDate,
        status: "filled",
        reason: "filled_next_market_open",
        reasonText: "信号次一交易日开盘按共享账户规则成交",
        allocation: trade.allocation,
        shares: trade.shares,
        pnl: trade.netPnl,
        netReturnPercent: trade.netReturn
      }));
      const rejectedSignalEvents = securities.slice(0, Math.min(2, securities.length)).map((security, index) => {
        const matchedIds = strategyIds.slice(0, Math.max(1, minimumVotes));
        return {
          sampleId: `preview-rejected-${security.code}-${index}`,
          code: security.code,
          name: security.name,
          strategyId: matchedIds[0] || strategyIds[0]!,
          strategyIds: matchedIds,
          strategyNames: matchedIds.map((id) => strategyNameById.get(id) || id),
          signalDate: index === 0 ? "2026-06-18" : "2026-05-22",
          entryDate: index === 0 ? "2026-06-19" : "2026-05-25",
          status: "rejected",
          reason: index === 0 ? "max_positions_reached" : "insufficient_cash_for_board_lot",
          reasonText: index === 0 ? "当日最大持仓数已满" : "可用现金不足以买入一手"
        };
      });
      const pendingSignalEvents = securities.slice(0, 1).map((security) => {
        const matchedIds = strategyIds.slice(0, Math.max(1, minimumVotes));
        return {
          sampleId: `preview-pending-${security.code}`,
          code: security.code,
          name: security.name,
          strategyId: matchedIds[0] || strategyIds[0]!,
          strategyIds: matchedIds,
          strategyNames: matchedIds.map((id) => strategyNameById.get(id) || id),
          signalDate: "2026-07-31",
          entryDate: "2026-08-01",
          exitDate: "",
          status: "pending",
          reason: "pending_exit_horizon",
          reasonText: "信号已命中，但尚未走完5个交易日持有期，暂不计入收益"
        };
      });
      const signalEvents = [...filledSignalEvents, ...rejectedSignalEvents, ...pendingSignalEvents]
        .sort((left, right) => right.signalDate.localeCompare(left.signalDate) || left.code.localeCompare(right.code));
      const signalTimeline = [...new Set(signalEvents.map((event) => event.signalDate))]
        .map((signalDate) => ({
          signalDate,
          events: signalEvents.filter((event) => event.signalDate === signalDate)
        }));
      const benchmarkReturnPercent = 3.1;
      return {
        source: "preview portfolio backtest",
        generatedAt: new Date().toISOString(),
        backtestMode: "verified_strategy_portfolio",
        strategyEngine: "verified-signal-v2",
        lookbackBars: 120,
        universe: {
          selectionMode: input.universeSource === "strategy_current_matches"
            ? "strategy_current_matches"
            : "manual_current_basket",
          selectionLabel: input.universeSource === "strategy_current_matches"
            ? "所选策略本轮命中股票"
            : "用户自定义股票篮子",
          requestedCount: securities.length,
          usedCount: securities.length,
          failedCount: 0,
          requestedCodes: securities.map((item) => item.code),
          usableCodes: securities.map((item) => item.code),
          securities,
          excluded: [],
          pointInTime: false,
          survivorBias: true
        },
        strategyIds,
        minimumVotes,
        strategyContext: {
          strategyId: strategyIds.length > 1 ? "custom_strategy_vote" : strategyIds[0],
          strategyName: strategyIds.length > 1 ? "自选策略共振" : previewVerifiedStrategies.find((item) => item.id === strategyIds[0])?.name,
          strategyIds,
          minimumVotes,
          voteRule: strategyIds.length > 1 ? `至少 ${minimumVotes}/${strategyIds.length} 票同日命中` : "单策略逐日命中"
        },
        metrics: {
          startingCapital,
          endingCapital: Number(endingCapital.toFixed(2)),
          totalReturnPercent: Number(totalReturnPercent.toFixed(3)),
          annualizedReturnPercent: 8.9,
          maxDrawdownPercent: -3.7,
          sharpeRatio: 0.91,
          tradeCount: trades.length,
          winRate: 62.5,
          profitFactor: 1.48,
          averageTradeReturnPercent: 1.34,
          benchmarkReturnPercent,
          excessReturnPercent: Number((totalReturnPercent - benchmarkReturnPercent).toFixed(3)),
          rejectedSignals: 2,
          maxOpenPositions: maxPositions
        },
        equityCurve,
        contributions,
        trades,
        signalEvents,
        signalTimeline,
        validation: {
          accepted: false,
          sampleCount: trades.length,
          independentSignalDays: trades.length,
          reason: "浏览器预览数据只用于界面检查，不能视为真实历史验证。"
        },
        dataQuality: {
          requestedStocks: securities.length,
          loadedStocks: securities.length,
          failedStocks: [],
          providerPolicy: "预览数据",
          partial: false
        },
        warning: "当前为浏览器预览组合回测，所有数值均为界面演示，禁止用于投资判断。"
      };
    },
    async scanStrategySignals(options = {}) {
      const stocks = previewSecurities.map((security, index) => {
        const payload = buildPreviewPayload(security);
        return {
          ...security,
          ...payload.quote,
          industry: payload.quote.industry,
          mrs: payload.analysis.mrs,
          grade: payload.analysis.grade,
          signalScore: Math.max(58, payload.analysis.mrs - index * 3),
          strategyMatchRate: payload.analysis.strategyMatchRate,
          observationNode: payload.analysis.exactNode || payload.analysis.nextNode,
          reasons: ["预览行情结构", "风险否决通过"],
          risks: [],
          matchSource: "ohlcv",
          historyBars: 720,
          riskVetoStatus: "passed"
        };
      });
      // 与桌面一致：不指定策略时只跑在用策略（已下线的只在明确指定 id 时出现）。
      const definitions = previewVerifiedStrategies as Array<(typeof previewVerifiedStrategies)[number] & { retired?: boolean }>;
      const strategies: Array<Record<string, unknown> & { id: string; type?: string; stocks: Array<{ code: string }> }> = definitions
        .filter(definition => options.strategyIds?.length ? options.strategyIds.includes(definition.id) : definition.retired !== true)
        .map((definition, index) => ({
          ...definition,
          stocks: previewExtraIds.has(definition.id) ? [] : stocks.slice(0, index % 3 + 1).map(stock => ({
            code: stock.code, name: stock.name, industry: stock.industry,
            latest: stock.latest, changePct: stock.changePct, amount: stock.amount,
            turnover: stock.turnover, signalDate: new Date().toISOString().slice(0, 10),
            signalStrength: stock.signalScore
          }))
        }));
      const customGroups = previewState.customStrategies.map((strategy, index) => ({
        id: strategy.id || `cs_preview_${index}`, name: strategy.name, type: "custom", custom: true, family: "custom", version: `custom-r${strategy.revision || 1}`,
        detail: strategy.description, conditions: ["浏览器预览：条件按演示数据展示"], universeId: strategy.universe,
        stocks: stocks.slice(0, index % 2 + 1).map(stock => ({
          code: stock.code, name: stock.name, industry: stock.industry, latest: stock.latest, changePct: stock.changePct, amount: stock.amount,
          turnover: stock.turnover, signalDate: new Date().toISOString().slice(0, 10), signalStrength: stock.signalScore,
          matchRate: 83, needsConfirmation: strategy.conditions.some(item => /sector|information|marketEmotion|firstBoardQuality/.test(item.ref)),
          pendingConditions: strategy.conditions.filter(item => /sector|information|marketEmotion|firstBoardQuality/.test(item.ref))
            .map(item => CUSTOM_CATALOG.factors.find(factor => `factor:${factor.id}` === item.ref)?.label || item.ref)
        }))
      }));
      strategies.push(...customGroups);
      return {
        mode: "selection", generatedAt: new Date().toISOString(), sourceClass: "preview",
        source: "浏览器演示数据", warning: "当前为演示股票列表，真实选股结果请在桌面软件中查看。",
        universeSize: stocks.length, availableUniverseSize: stocks.length, processed: stocks.length, failed: 0,
        universeCoverage: { boards: [], listed: stocks.length, eligible: stocks.length, excludedRisk: 0, failed: 0, requestsComplete: true, complete: true },
        compositeStrategyCount: strategies.filter(item => item.type === "composite").length,
        qualifiedCount: new Set(strategies.flatMap(item => item.stocks.map(stock => stock.code))).size,
        strategies
      };
    },
    async getStrategyLeaderboard() {
      const rows = [
        ["weak_to_strong", "弱转强修复", "repair", false, [[247, 138, 78.5, 4.82, 3.88, 1.36], [230, 118, 71.3, 6.9, 5.4, 1.02], [198, 96, 66.4, 8.2, 6.1, 0.88]], "strong"],
        ["post_limit_contraction_resonance", "涨停后缩量共振", "contraction", false, [[173, 113, 54.9, 3.38, 2.96, -0.07], [160, 96, 58.2, 4.1, 3.5, 0.12], [140, 80, 60.1, 5.2, 4.2, 0.35]], "ahead"],
        ["vcp_compression", "涨停后量价收缩", "contraction", false, [[249, 158, 56.6, 2.98, 0.93, -0.57], [210, 120, 52.4, 3.2, 1.1, -0.62], [172, 94, 48.8, 2.6, 0.5, -0.81]], "behind"],
        ["high_tight_flag", "涨停后高位窄幅整理", "contraction", false, [[384, 204, 46.4, 1.83, -0.62, -1.74], [310, 150, 42.1, 1.6, -0.8, -1.9], [240, 110, 38.0, 0.9, -1.1, -2.2]], "weak"],
        ["ma_reclaim_after_limit", "涨停后MA10收复修复", "pullback", false, [[118, 76, 54.2, 1.42, 0.1, -2.07], [96, 60, 50.2, 1.2, -0.2, -1.8], [80, 44, 46.0, 0.6, -0.5, -1.4]], "weak"],
        ["volume_dryup_rebound", "涨停后缩量阳线修复", "repair", false, [[119, 87, 52.1, 0.96, 0.34, -2.3], [98, 70, 48.4, 0.8, 0.1, -2.0], [75, 50, 44.0, 0.4, -0.3, -1.7]], "weak"],
        ["bottom_deep_first_board", "深跌底部首板", "bottom_trend", true, [[44, 22, 63.6, 4.9, 3.4, 2.62], [36, 18, 61.1, 5.5, 4.0, 2.9], [30, 14, 60.0, 6.4, 5.1, 3.1]], "ahead"],
        ["bottom_board_pullback", "深跌首板后缩量回踩", "bottom_trend", true, [[51, 26, 60.8, 4.2, 2.8, 1.9], [44, 20, 59.1, 4.8, 3.3, 2.2], [36, 15, 58.3, 5.9, 4.4, 2.6]], "ahead"],
        ["bottom_quiet_board_follow", "底部温和首板后承接", "bottom_trend", true, [[62, 33, 58.1, 3.6, 2.4, 1.44], [50, 24, 56.0, 4.0, 2.9, 1.7], [40, 18, 55.0, 4.6, 3.5, 2.0]], "mixed"],
        ["board_streak_quiet_pullback", "连板后缩量回调", "pullback", true, [[70, 40, 55.7, 3.1, 1.9, 0.6], [58, 30, 53.4, 3.4, 2.2, 0.8], [46, 22, 50.0, 3.0, 1.8, 0.5]], "mixed"],
        ["volume_rebound_hold", "下跌后放量大阳·次日平量", "repair", true, [[58, 30, 56.9, 2.7, 1.5, 0.4], [46, 22, 52.2, 2.9, 1.7, 0.6], [38, 16, 50.0, 2.4, 1.2, 0.3]], "mixed"],
        ["limit_gap_hold", "涨停高开支撑守卫", "pullback", true, [[66, 36, 57.6, 2.4, 1.2, 0.1], [54, 28, 53.7, 2.6, 1.4, 0.2], [42, 20, 50.0, 2.0, 1.0, -0.1]], "mixed"],
        ["first_board_quality_resonance", "首板质量共振", "first_board", false, [[0, 0, null, null, null, null], [0, 0, null, null, null, null], [0, 0, null, null, null, null]], "insufficient"]
      ];
      const baselineByHorizon = { "5": { sampleCount: 4126, winRate: 55.2, averageReturn: 2.62, medianReturn: 1.1 }, "10": { sampleCount: 3400, winRate: 56.8, averageReturn: 3.8, medianReturn: 2.2 }, "20": { sampleCount: 2600, winRate: 57.5, averageReturn: 5.1, medianReturn: 3.4 } };
      const strategies = rows.map((row: unknown, index: number) => {
        const [id, name, family, featured, hs, verdict] = row as [string, string, string, boolean, [number, number, number | null, number | null, number | null, number | null][], string];
        const horizons: StrategyLeaderboardStrategyRow["horizons"] = {};
        ["5", "10", "20"].forEach((key, h) => {
          const [sampleCount, days, winRate, averageReturn, medianReturn, edge] = hs[h]!;
          horizons[key] = { sampleCount, independentSignalDays: days, winRate,
            winRateInterval95: typeof winRate === "number" ? [Math.max(0, Math.round((winRate - 8) * 10) / 10), Math.min(100, Math.round((winRate + 8) * 10) / 10)] : null,
            averageReturn, medianReturn, averageExcessReturn: averageReturn === null ? null : Math.round((averageReturn - 0.4) * 10) / 10,
            edgeVsBaseline: edge === null ? null : Math.round((edge - 0.1) * 100) / 100, medianEdgeVsBaseline: edge === null ? null : Math.round(edge * 80) / 100,
            dayWeightedEdge: edge, comparedSignalDays: days,
            nextDayUnbuyableRate: sampleCount ? Math.round((index % 3) * 0.4 * 10) / 10 : null,
            entryGapSkippedRate: sampleCount ? Math.round((index % 4) * 1.2 * 10) / 10 : null };
        });
        const edge = hs[0]![5];
        return { id, name, family, featured, detail: "演示：与策略库同一套冻结规则。",
          horizons, rank: index + 1,
          halves: [
            { label: "前半段", from: "2025-11-24", to: "2026-04-28", sampleCount: Math.round(hs[0]![0] * 0.55), winRate: typeof hs[0]![2] === "number" ? Math.round((hs[0]![2] - 1.4) * 10) / 10 : null, averageReturn: hs[0]![3] === null ? null : Math.round((hs[0]![3] - 0.4) * 10) / 10, dayWeightedEdge: edge === null ? null : Math.round((edge - 0.2) * 100) / 100, comparedSignalDays: Math.round(hs[0]![1] * 0.55) },
            { label: "后半段", from: "2026-04-29", to: "2026-11-13", sampleCount: Math.round(hs[0]![0] * 0.45), winRate: typeof hs[0]![2] === "number" ? Math.round((hs[0]![2] + 1.1) * 10) / 10 : null, averageReturn: hs[0]![3] === null ? null : Math.round((hs[0]![3] + 0.5) * 10) / 10, dayWeightedEdge: edge === null ? null : Math.round((edge + 0.25) * 100) / 100, comparedSignalDays: Math.round(hs[0]![1] * 0.45) }
          ],
          verdict: { level: verdict, text: verdict === "strong" ? "各持有期都跑赢同期涨停股基线，前后两段方向一致" : verdict === "ahead" ? "多数持有期跑赢基线，但不是每段都一致" : verdict === "weak" ? "各持有期都跑输同期涨停股基线，前后两段方向一致" : verdict === "behind" ? "多数持有期跑输基线" : verdict === "insufficient" ? "样本不足（少于 30 笔或 10 个信号日），只能观察" : "与基线大致持平，没有稳定优势" } };
      });
      strategies.sort((a, b) => (b.horizons["5"]?.dayWeightedEdge ?? -Infinity) - (a.horizons["5"]?.dayWeightedEdge ?? -Infinity));
      strategies.forEach((row, index) => { row.rank = index + 1; });
      return {
        v: 1, generatedAt: new Date().toISOString(), signalTo: "2026-11-20", dataThrough: "2026-11-20", libraryStale: false,
        stockCount: 5120, window: { from: "2025-11-24", to: "2026-11-13" }, splitDate: "2026-04-29",
        horizons: [5, 10, 20], primaryHorizon: 5, minSamples: 30, minSignalDays: 10, edgeTolerance: 0.3, benchmarkReady: true,
        universe: { localStocks: 5400, readable: 5120, replayed: 5120, excludedRisk: 120, namesAvailable: true }, elapsedSeconds: 96,
        method: "信号日收盘后确认，次日开盘买入，持有 5 / 10 / 20 个交易日后收盘卖出，扣双边成本 0.23%；同一只股票相邻信号至少间隔 5 个交易日；次日一字涨停买不到的不计入；次日竞价高开超过4%或低开超过5%不买；退出日跌停或无成交则顺延。",
        baselineDefinition: "基线：同期任意一只近 15 个交易日内涨停过的股票，用同样的买卖规则得到的收益。",
        edgeDefinition: "优势按信号日等权：每个信号日先算“策略平均收益 − 基线平均收益”，再对所有信号日取平均；某一天成批出信号不会主导结论。",
        caveat: "浏览器预览演示数据：样本来自本机日线库当前收录的股票（约一年多的日线，扣除指标预热后大约是近一年的信号）。已退市的股票不在其中，ST 按现在的名称剔除，所以结果偏乐观；只说明这套规则近一年在全市场的表现，不代表未来收益，也不参与选股。",
        baseline: baselineByHorizon, strategies
      };
    },
    async startTrendScan(options) { trendState = await createConfiguredTrendPreviewStatus(options); return structuredClone(trendState); },
    async evaluateTrendResearch() { throw new Error("浏览器预览不执行历史研究，请在桌面软件中导入真实或明确标记的合成数据"); },
    async checkTrendExecution({ signalDate }) { return {
      checkedAt: new Date().toISOString(), signalDate, executionDate: null, expectedSignalDate: null,
      state: "unknown", reasons: ["浏览器演示不提供可执行交易状态，请在桌面软件核对真实数据"],
      latest: null, upperLimit: null, lowerLimit: null, suspended: null, priceDate: null,
      source: "preview", minimumBuyQuantity: 100, quantityStep: 100
    }; },
    async getTrendScan() { return structuredClone(trendState); },
    async cancelTrendScan() { return structuredClone(trendState); },
  };
}
