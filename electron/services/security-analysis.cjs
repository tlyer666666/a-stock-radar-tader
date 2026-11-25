"use strict";
// 从 electron/services.cjs 提取（2026-11-15 审核 P0-2b 拆分）。
// services.cjs 通过顶部解构回本模块并继续按原契约 re-export，勿在这里引入
// 对 services.cjs 的反向依赖。
const { priceLimitRate, upperLimitPrice, isLimitUpBar } = require("../price-limit-rules.cjs");
const { DEFAULT_COSTS, roundTripBps } = require("../backtest-costs.cjs");
const { anchoredVwap } = require("../market-history-rules.cjs");
const { computePatternStrategies, scoreFirstBoardQuality, computeRegimeWeightProfile } = require("../strategy-intelligence.cjs");
const { buildQuoteConsensus } = require("../data-federation.cjs");
const { evaluateAnalysisPresetRequirements } = require("../analysis-selection-policy.cjs");
const { measuredFactorSnapshot, OVERHEAT, LOW_FIRST_BOARD, DEEP_BASE } = require("../strategy-field-rules.cjs");
const _backtest = require("./backtest.cjs");
const { marketSourceHealth, QUOTE_SOURCE_LABELS } = _backtest;
function clamp(...args) { return _backtest.clamp(...args); }
function average(...args) { return _backtest.average(...args); }
function roundPrice(...args) { return _backtest.roundPrice(...args); }
function finiteOrNull(...args) { return _backtest.finiteOrNull(...args); }
function publicQuoteWithFallback(...args) { return _backtest.publicQuoteWithFallback(...args); }
function eastHistoryCached(...args) { return _backtest.eastHistoryCached(...args); }
function eastQuote(...args) { return _backtest.eastQuote(...args); }
function rememberIndustry(...args) { return _backtest.rememberIndustry(...args); }
function marketQuoteChain(...args) { return _backtest.marketQuoteChain(...args); }
function thsHistoryCached(...args) { return _backtest.thsHistoryCached(...args); }
function isRiskStockName(...args) { return _backtest.isRiskStockName(...args); }
function buildHistoricalStrategyStatsInWorker(...args) { return _backtest.buildHistoricalStrategyStatsInWorker(...args); }
const _sectors = require("./sectors.cjs");
function returnWindow(...args) { return _sectors.returnWindow(...args); }
function wholeMarketSnapshot(...args) { return _sectors.wholeMarketSnapshot(...args); }
function sectorStrength(...args) { return _sectors.sectorStrength(...args); }
const _runtime = require("./runtime.cjs");
function toSecurity(...args) { return _runtime.toSecurity(...args); }
const _quotes_and_charts = require("./quotes-and-charts.cjs");
function thsQuote(...args) { return _quotes_and_charts.thsQuote(...args); }
function announcements(...args) { return _quotes_and_charts.announcements(...args); }
function marketEmotionSnapshot(...args) { return _quotes_and_charts.marketEmotionSnapshot(...args); }
function quoteFederation(...args) { return _quotes_and_charts.quoteFederation(...args); }
function quoteProviderMeta(...args) { return _quotes_and_charts.quoteProviderMeta(...args); }
function sourceFromQuote(...args) { return _quotes_and_charts.sourceFromQuote(...args); }
const _limit_pool = require("./limit-pool.cjs");
function currentLadderPools(...args) { return _limit_pool.currentLadderPools(...args); }
function topicPoolForDate(...args) { return _limit_pool.topicPoolForDate(...args); }

function buildTradeExecutionReadiness(analysis = {}, tradePlan = {}, settings = {}) {
  const safeSettings = settings || {};
  const blockers = [];
  const warnings = [];
  const signal = String(tradePlan?.signal || "WAIT");
  const minExecutionRatePercent = clamp(
    Number(safeSettings.minExecutionRatePercent ?? 90),
    40,
    100,
    90
  );
  const executionFillRatePercent = clamp(
    Number(tradePlan?.executionFillRatePercent),
    0,
    100,
    100
  );

  if (signal !== "BUY" && signal !== "BUY_AGGRESSIVE") {
    blockers.push(`交易计划未给出可执行买入信号：${signal}`);
  }
  if (executionFillRatePercent < minExecutionRatePercent) {
    blockers.push(
      `预计成交率 ${executionFillRatePercent.toFixed(1)}% 低于阈值 ${minExecutionRatePercent}%`
    );
  }
  if (!Number.isFinite(Number(tradePlan?.positionSizePercent)) || Number(tradePlan?.positionSizePercent) <= 0) {
    blockers.push("仓位建议为0，不执行");
  }
  if (tradePlan?.killSwitchTriggered) {
    blockers.push("交易计划触发风险熔断");
  }
  if (analysis?.qualification?.riskVetoPassed === false) {
    blockers.push("风控否决未通过");
  }
  if (analysis?.historicalEdge && analysis.historicalEdge.passed === false) {
    blockers.push(
      `历史回测门槛未通过：${analysis.historicalEdge.passReason || "样本/收益/回撤不满足"}`
    );
  }

  const riskPenalty = Number(analysis?.riskPenalty);
  if (riskPenalty > 35) {
    blockers.push(`风险惩罚过高：${riskPenalty.toFixed(1)}`);
  } else if (riskPenalty > 15) {
    warnings.push(`风险惩罚偏高：${riskPenalty.toFixed(1)}`);
  }

  const riskReward = Number(tradePlan?.riskReward);
  if (Number.isFinite(riskReward) && riskReward > 0 && riskReward < 1.2) {
    warnings.push(`风险收益比偏低：${riskReward.toFixed(2)}`);
  }

  const mrs = Number(analysis?.mrs);
  if (Number.isFinite(mrs) && mrs < 65) {
    warnings.push(`模型评分偏低：${mrs.toFixed(1)}`);
  }

  const reasons = [...blockers, ...warnings];
  const score = clamp(
    Math.round(100 - blockers.length * 26 - warnings.length * 8),
    0,
    100,
    0
  );

  let level = "pass";
  let status = "PASS";
  let recommendation = "可执行";
  let summary = "当前符合执行条件，可继续开仓。";

  if (blockers.length > 0) {
    level = "block";
    status = "BLOCK";
    recommendation = "请先修复阻断条件后再执行。";
    summary = "执行阻断：需要先解除风控约束。";
  } else if (warnings.length > 2 || score < 68) {
    level = "wait";
    status = "WAIT";
    recommendation = "建议先复核后执行（可进行人工确认）。";
    summary = "建议先确认再执行。";
  }

  return {
    score,
    level,
    status,
    summary,
    recommendation,
    reasons: reasons.length ? reasons : ["执行评估已完成。"],
    canExecute: level !== "block"
  };
}

function calculateAtr(history, period = 14) {
  if (!Array.isArray(history) || history.length <= period) return null;
  const ranges = [];
  for (let index = Math.max(1, history.length - period); index < history.length; index += 1) {
    const current = history[index];
    const previous = history[index - 1];
    if (!current || !previous) continue;
    const trueRange = Math.max(
      Number(current.high || 0) - Number(current.low || 0),
      Math.abs(Number(current.high || 0) - Number(previous.close || 0)),
      Math.abs(Number(current.low || 0) - Number(previous.close || 0))
    );
    if (Number.isFinite(trueRange)) ranges.push(trueRange);
  }
  if (!ranges.length) return null;
  const tail = ranges.slice(-period);
  return tail.length ? average(tail) : null;
}

function buildTradePlan(analysis, quote, history, settings) {
  const latest = Number(quote?.latest || quote?.close || 0);
  if (!Number.isFinite(latest) || latest <= 0 || !analysis) return null;
  const atr = calculateAtr(history, 14);
  const atrMultipleStop = Math.max(1, Math.min(8, Number(settings?.stopLossATRMultiple) || 2));
  const atrMultipleTake = Math.max(1.2, Math.min(12, Number(settings?.takeProfitATRMultiple) || 3.2));
  const atrDistance = Number.isFinite(atr) && atr > 0
    ? atr
    : Math.abs((quote.open || latest) - (quote.preClose || latest)) || latest * 0.012;
  const tick = Number(quote?.pricePrecision) === 3 ? 0.001 : 0.01;
  const stopLossDistance = atrDistance * atrMultipleStop;
  const targetDistance = atrDistance * atrMultipleTake;
  const rawStopPrice = roundPrice(latest - stopLossDistance);
  const stopInvalid = stopLossDistance >= latest || !(rawStopPrice > 0) || !(latest > tick);
  const stopLossPrice = Math.max(tick, rawStopPrice);
  const effectiveStopDistance = Math.max(0, latest - stopLossPrice);
  const takeProfitPrice = roundPrice(latest + targetDistance);
  const stopLossPercent = stopInvalid
    ? (stopLossDistance / latest) * 100
    : (effectiveStopDistance / latest) * 100;
  const takeProfitPercent = (targetDistance / latest) * 100;
  const riskDistancePercent = Math.max(0.5, stopLossPercent);
  const accountRiskPercent = Math.max(0.1, Math.min(20, Number(settings?.maxRiskPerTradePercent) || 1));
  const maxPositionPercent = Math.max(5, Math.min(90, Number(settings?.maxPositionPercent) || 28));
  const scoreRate = Math.max(0.2, Math.min(1, (analysis.mrs || 0) / 100));
  const historicalPass = Boolean(analysis.historicalEdge?.passed);
  const nodePenalty = analysis.exactNode ? 1 : 0.88;
  const historicalPenalty = historicalPass ? 1 : 0.7;
  const riskFactor = Math.max(0.1, 1 - ((analysis.riskPenalty || 0) / 120));
  const confidence = clamp(scoreRate * historicalPenalty * nodePenalty * riskFactor, 0.1, 1);
  const stopLossExposureRatio = accountRiskPercent / riskDistancePercent;
  const basePosition = clamp(stopLossExposureRatio * 100, 0, maxPositionPercent);
  const positionSizePercent = stopInvalid
    ? 0
    : clamp(basePosition * confidence, 0, maxPositionPercent);
  const riskReward = !stopInvalid && effectiveStopDistance > 0
    ? Number(targetDistance / effectiveStopDistance)
    : Number.NaN;
  const maxLossBudgetPercent = stopInvalid
    ? 0
    : Math.max(0, (positionSizePercent * riskDistancePercent) / 100);
  let signal = "WAIT";
  if (!stopInvalid && analysis.alertQualified && analysis.strategyQualified && historicalPass) {
    if (analysis.mrs >= 82 && riskReward >= 1.7) signal = "BUY_AGGRESSIVE";
    else if (analysis.mrs >= 70 && riskReward >= 1.2) signal = "BUY";
    else signal = "OBSERVE";
  }
  return {
    signal,
    entryPrice: roundPrice(latest),
    positionSizePercent: Number(positionSizePercent.toFixed(2)),
    maxPositionPercent,
    maxLossBudgetPercent: Number(maxLossBudgetPercent.toFixed(2)),
    stopLossPrice,
    stopInvalid,
    takeProfitPrice,
    stopLossDistancePercent: Number(stopLossPercent.toFixed(2)),
    takeProfitDistancePercent: Number(takeProfitPercent.toFixed(2)),
    riskReward: Number.isFinite(riskReward) ? Number(riskReward.toFixed(2)) : null,
    atrDistance: Number(atrDistance.toFixed(4)),
    stopLossATRMultiple: atrMultipleStop,
    takeProfitATRMultiple: atrMultipleTake,
    maxHoldingBars: Math.max(5, Number(settings?.maxHoldingBars) || 30),
    confidence: Number((confidence * 100).toFixed(1)),
    lastUpdatedAt: new Date().toISOString()
  };
}

function movingAverage(history, days, endOffset = 0) {
  const end = history.length - endOffset;
  return average(history.slice(Math.max(0, end - days), end).map((x) => x.close));
}

function clampScore(value, min = 0, max = 100) {
  const score = Number(value);
  return Number.isFinite(score)
    ? Math.max(min, Math.min(max, Math.round(score)))
    : min;
}

function edgeGateFromStats(historicalStats, options = {}) {
  const combination = Array.isArray(historicalStats?.stats)
    ? historicalStats.stats.find((item) => item.id === "currentCombination")
    : null;
  const rawSampleCount = finiteOrNull(combination?.sampleCount) ?? 0;
  const settledN5 = finiteOrNull(combination?.n5);
  const independentEventCount = finiteOrNull(combination?.independentEventCount);
  const independentN5 = finiteOrNull(combination?.independentN5);
  const sampleCount = independentN5 !== null
    ? independentN5
    : settledN5 !== null
      ? settledN5
      : independentEventCount !== null
        ? independentEventCount
        : rawSampleCount;
  const winRate5 = finiteOrNull(combination?.winRate5);
  const rawAverage5 = finiteOrNull(combination?.average5);
  const costsIncluded = historicalStats?.costsIncluded === true || options.costDeducted === true;
  const roundTripCostPercent = costsIncluded ? 0 : roundTripBps(DEFAULT_COSTS) / 100;
  const average5 = rawAverage5 === null ? null : rawAverage5 - roundTripCostPercent;
  const worstMdd5 = finiteOrNull(combination?.worstMdd5);
  const confidence = combination?.confidence || "不足";
  const minimumSamples = Math.max(
    12,
    Math.round(Number(options.minimumSamples) || 30)
  );
  const reasons = [];
  let penalty = 0;
  let passed = true;
  if (sampleCount < minimumSamples) {
    passed = false;
    penalty += 12;
    reasons.push(`历史独立样本不足（${sampleCount}/${minimumSamples} 条）`);
  } else {
    if (winRate5 === null) {
      passed = false;
      penalty += 14;
      reasons.push("5日胜率缺失");
    } else if (winRate5 < 45) {
      passed = false;
      penalty += 14;
      reasons.push(`5日胜率不足（${winRate5.toFixed(1)}%，低于45%）`);
    }
    if (average5 === null) {
      passed = false;
      penalty += 12;
      reasons.push("5日平均净收益缺失");
    } else if (average5 <= 0.3) {
      passed = false;
      penalty += 12;
      reasons.push(`5日平均净收益偏弱（${average5.toFixed(2)}%）`);
    }
    if (worstMdd5 === null) {
      passed = false;
      penalty += 10;
      reasons.push("历史最差5日回撤缺失");
    } else if (worstMdd5 < -22) {
      passed = false;
      penalty += 10;
      reasons.push(`历史最差5日回撤过大（${worstMdd5.toFixed(2)}%）`);
    }
    if (winRate5 !== null && average5 !== null && winRate5 >= 58 && average5 >= 0.8) {
      penalty = Math.max(0, penalty - 2);
    }
  }
  if (options.strictGate && sampleCount < Math.max(60, minimumSamples)) {
    passed = false;
    penalty += 4;
    reasons.push(`严格模式样本要求≥${Math.max(60, minimumSamples)}（当前 ${sampleCount}）`);
  }
  return {
    passed,
    sampleCount,
    rawSampleCount,
    settledN5,
    independentEventCount,
    independentN5,
    winRate5,
    average5,
    worstMdd5,
    confidence,
    minimumSamples,
    penalty,
    reasons
  };
}

function analyzeHistory(
  security,
  quote,
  history,
  sector,
  marketEmotion = null,
  benchmarkHistory = [],
  eventHistory = history
) {
  if (history.length < 21) throw new Error("历史行情不足，无法计算指标");
  const latest = history.at(-1);
  const events = [];
  const rawByDate = new Map((eventHistory || []).map((row, index) => [row.date, { row, previous: eventHistory[index - 1] }]));
  const recentWindowStart = Math.max(1, history.length - 60);
  for (let i = recentWindowStart; i < history.length; i += 1) {
    const day = history[i];
    const raw = rawByDate.get(day.date);
    if (!raw?.previous) continue;
    const rate = priceLimitRate(security.code, quote.name, day.date, raw.row.isST);
    const rawTarget = upperLimitPrice(raw.previous.close, raw.row, security.code, quote.name);
    if (rawTarget !== null && isLimitUpBar(raw.previous.close, raw.row, security.code, quote.name)) {
      const factor = Number(day.close) / Number(raw.row.close);
      events.push({ ...day, index: i, target: rawTarget * factor, rawClose: raw.row.close, rawTarget, rate });
    }
  }
  const limitEvent = events.at(-1) || null;
  const daysSince = limitEvent ? history.length - 1 - limitEvent.index : null;
  const since = limitEvent ? history.slice(limitEvent.index) : history.slice(-10);
  const supportLow = limitEvent?.low || 0;
  const minLow = Math.min(...since.map((x) => x.low));
  const heldSupport = limitEvent ? minLow >= supportLow - 0.001 : false;
  const supportDistance = limitEvent
    ? ((latest.close - supportLow) / supportLow) * 100
    : 0;
  const avwapRows = since.map(row => {
    const raw = rawByDate.get(row.date)?.row;
    const factor = raw && Number(raw.close) > 0 ? Number(row.close) / Number(raw.close) : null;
    // 复权一致：价格用前复权，成交量换算成复权股数（不复权量 ÷ 复权因子），成交额保持实际金额；
    // 这样跨除权日累计时每天的权重正确（以前用不复权量配复权额，除权前的成交量权重被压缩）。
    const usable = factor !== null && Number.isFinite(factor) && factor > 0 && raw.amount !== null && raw.amount !== undefined && Number(raw.volume) > 0;
    return { ...row, amount: usable ? Number(raw.amount) : null, volume: usable ? Number(raw.volume) / factor : null, volumeUnit: raw?.volumeUnit || "lots" };
  });
  const avwap = anchoredVwap(avwapRows);
  const ma5 = movingAverage(history, 5);
  const ma10 = movingAverage(history, 10);
  const ma20 = movingAverage(history, 20);
  const ma60 = movingAverage(history, 60);
  const priorMa5 = movingAverage(history, 5, 1);
  const priorMa10 = movingAverage(history, 10, 1);
  const priorMa20 = movingAverage(history, 20, 1);
  const maBull = ma5 !== null && ma10 !== null && ma20 !== null && ma5 > ma10 && ma10 > ma20;
  const slopesUp = ma5 !== null && priorMa5 !== null && ma10 !== null && priorMa10 !== null && ma20 !== null && priorMa20 !== null && ma5 > priorMa5 && ma10 > priorMa10 && ma20 > priorMa20;
  const divergence = ma20 ? ((ma5 - ma20) / ma20) * 100 : 0;
  // 量比按复权股数比较：近 5 日内有送转时，除权前的成交量换算到现在的股本，避免股本扩大被当成放量。
  const comparableVolume = (row) => {
    const raw = rawByDate?.get?.(row.date)?.row;
    const factor = raw && Number(raw.close) > 0 ? Number(row.close) / Number(raw.close) : null;
    return factor && Number.isFinite(factor) && factor > 0 && Number(raw.volume) > 0 ? Number(raw.volume) / factor : row.volume;
  };
  const avgVol5 = average(history.slice(-6, -1).map(comparableVolume));
  const volumeRatio = avgVol5 ? comparableVolume(latest) / avgVol5 : 0;
  const avgTurn20 = average(history.slice(-21, -1).map((x) => x.turnover).filter((v) => Number.isFinite(v) && v > 0));
  const latestTurnover = finiteOrNull(latest.turnover);
  const relativeTurnover = avgTurn20 && latestTurnover !== null && latestTurnover > 0 ? latestTurnover / avgTurn20 : null;
  const maxDrawdown = limitEvent
    ? ((limitEvent.close - minLow) / limitEvent.close) * 100
    : 0;
  const closePosition =
    latest.high === latest.low
      ? 1
      : (latest.close - latest.low) / (latest.high - latest.low);
  const stockReturn3Window = returnWindow(history, 3);
  const stockReturn3 = stockReturn3Window?.value ?? null;
  const sectorReturn3 = finiteOrNull(sector?.returns?.r3);
  const sectorReturn3Window = sector?.returnWindows?.r3 || null;
  const sectorDatesAlign =
    !sectorReturn3Window ||
    Boolean(
      stockReturn3Window?.startDate &&
      stockReturn3Window?.endDate &&
      stockReturn3Window.startDate === sectorReturn3Window.startDate &&
      stockReturn3Window.endDate === sectorReturn3Window.endDate
    );
  // E-06：3 日收益、板块 3 日收益任一未知或起止交易日不一致时，相对板块强弱同样是未知。
  // 旧实现 null - 0 = 0 / (sector?.returns?.r3 || 0)，会把"未知"读成"恰好 0% 超额"。
  const rsSector =
    stockReturn3 === null || sectorReturn3 === null || !sectorDatesAlign
      ? null
      : stockReturn3 - sectorReturn3;
  const eventCount60 = events.length;
  const preLimitStart = limitEvent ? Math.max(0, limitEvent.index - 20) : 0;
  const preLimitEnd = limitEvent ? Math.max(0, limitEvent.index - 1) : 0;
  const preLimitReturn20 =
    limitEvent && history[preLimitStart]?.close
      ? ((history[preLimitEnd].close / history[preLimitStart].close) - 1) * 100
      : 0;
  const consolidation = limitEvent ? history.slice(limitEvent.index + 1, -1).slice(-8) : [];
  const platformHigh = consolidation.length
    ? Math.max(...consolidation.map((item) => item.high))
    : 0;
  const platformLow = consolidation.length
    ? Math.min(...consolidation.map((item) => item.low))
    : 0;
  const platformRange = platformLow ? ((platformHigh - platformLow) / platformLow) * 100 : 0;
  const previousDay = history.at(-2);
  const reclaimedSupport = Boolean(
    limitEvent && latest.low < supportLow && latest.close >= supportLow
  );
  const lowOpenRecovery = Boolean(
    previousDay &&
      latest.open < previousDay.close &&
      latest.close > previousDay.close &&
      closePosition >= 0.7
  );
  const isLowFirstBoard = Boolean(
    limitEvent && eventCount60 === 1 && preLimitReturn20 <= 15 && preLimitReturn20 >= -25
  );
  const secondBreakout = Boolean(
    limitEvent &&
      daysSince >= 3 &&
      daysSince <= 9 &&
      consolidation.length >= 2 &&
      platformRange <= 12 &&
      latest.close > platformHigh &&
      volumeRatio >= 1.1 &&
      volumeRatio <= 2.2 &&
      heldSupport
  );
  const weakToStrong = Boolean(
    (reclaimedSupport || lowOpenRecovery) && closePosition >= 0.7 && volumeRatio <= 1.8
  );
  const patternStrategies = limitEvent
    ? computePatternStrategies(history, limitEvent.index, history.length - 1)
    : {
        originBreakout: false,
        vcpCompression: false,
        chipLock: false
      };
  const sectorRankIndex = sector?.constituents?.findIndex(
    (item) => String(item.code) === String(security.code)
  );
  const sectorRank = Number.isInteger(sectorRankIndex) && sectorRankIndex >= 0
    ? sectorRankIndex + 1
    : null;
  const leaderCutoff = Math.max(3, Math.ceil((sector?.memberCount || 20) * 0.15));
  const sectorLeader = Boolean(
    (sector?.score || 0) >= 65 &&
      rsSector !== null &&
      rsSector >= 0 &&
      (sectorRank ? sectorRank <= leaderCutoff : rsSector >= 2)
  );
  const nodes = [3, 5, 7, 9];
  const exactNode = nodes.includes(daysSince) ? `T+${daysSince}` : null;
  const nextNode =
    daysSince === null
      ? null
      : nodes.find((n) => n > daysSince) || (daysSince > 9 ? "已过观察窗" : `T+${nodes.at(-1)}`);

  // 实测因子（不过热 / 低位涨停 / 深跌底部）：与历史回放共用 strategy-field-rules 的同一实现。
  const measured = measuredFactorSnapshot({
    history,
    eventIndex: limitEvent ? limitEvent.index : null,
    evaluationIndex: history.length - 1,
    limitIndices: events.map((item) => item.index),
    closePosition,
    volumeRatio,
    heldSupport
  });

  let structureScore = 0;
  if (limitEvent) {
    structureScore += heldSupport ? 22 : Math.max(0, 10 + supportDistance * 2);
    structureScore += avwap !== null && latest.close >= avwap ? 12 : avwap === null ? 0 : 3;
    structureScore += maBull ? 12 : (ma5 !== null && ma10 !== null && ma5 > ma10) ? 7 : 2;
    structureScore += slopesUp ? 8 : 2;
    structureScore += volumeRatio < 0.8 ? 10 : volumeRatio < 1.5 ? 7 : volumeRatio < 2 ? 3 : 0;
    structureScore += relativeTurnover === null ? 0 : relativeTurnover < 1.5 ? 8 : relativeTurnover < 2 ? 3 : 0;
    structureScore += maxDrawdown < 5 ? 8 : maxDrawdown < 10 ? 5 : maxDrawdown < 15 ? 2 : 0;
    structureScore += closePosition > 0.75 ? 6 : closePosition > 0.5 ? 4 : 1;
    structureScore += rsSector === null ? 0 : rsSector > 2 ? 7 : rsSector > 0 ? 4 : 0;
    structureScore += divergence >= 0 && divergence <= 8 ? 7 : divergence > 8 ? 3 : 0;
  } else {
    // ma5 为 null（K 线不足 5 根）时不能参与比较：null 会被隐式转成 0，
    // 让"收盘价在 MA5 上方"恒真并白拿 20 分。
    structureScore = (maBull ? 35 : 10) + (slopesUp ? 25 : 5) +
      (ma5 !== null && latest.close > ma5 ? 20 : 0);
  }
  structureScore = Math.round(Math.min(100, structureScore));
  const sectorScore = sector?.score ?? 50;
  const sectorLadderScore = sector?.ladder?.score ?? 0;
  const infoScore = 50;
  const marketScore = marketEmotion?.score ?? 55;
  const nodeScore = exactNode ? 85 : daysSince !== null && daysSince <= 9 ? 65 : 35;
  let riskPenalty = 0;
  const risks = [];
  if (limitEvent && !heldSupport) {
    riskPenalty += 20;
    risks.push("已跌破涨停日最低价");
  }
  if (avwap && latest.close < avwap) {
    riskPenalty += 8;
    risks.push("价格位于涨停锚定均价下方");
  }
  if (volumeRatio > 2) {
    riskPenalty += 8;
    risks.push("成交量显著放大");
  }
  if (divergence > 10) {
    riskPenalty += 6;
    risks.push("均线乖离偏热");
  }
  const mrs = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        structureScore * 0.35 +
          sectorScore * 0.3 +
          infoScore * 0.2 +
          marketScore * 0.1 +
          nodeScore * 0.05 -
          riskPenalty
      )
    )
  );
  const grade = mrs >= 85 ? "S" : mrs >= 75 ? "A" : mrs >= 60 ? "B" : "C";
  return {
    limitEvent,
    daysSince,
    exactNode,
    nextNode: typeof nextNode === "number" ? `T+${nextNode}` : nextNode,
    heldSupport,
    supportDistance,
    avwap,
    ma5,
    ma10,
    ma20,
    ma60,
    maBull,
    slopesUp,
    divergence,
    volumeRatio,
    relativeTurnover,
    maxDrawdown,
    closePosition,
    stockReturn3,
    rsSector,
    eventCount60,
    preLimitReturn20,
    isLowFirstBoard,
    platformHigh,
    platformRange,
    secondBreakout,
    reclaimedSupport,
    lowOpenRecovery,
    weakToStrong,
    measured,
    ...patternStrategies,
    benchmarkAvailable: Array.isArray(benchmarkHistory) && benchmarkHistory.length > 0,
    sectorRank,
    sectorLeader,
    structureScore,
    sectorScore,
    sectorLadderScore,
    infoScore,
    marketScore,
    marketEmotion,
    nodeScore,
    riskPenalty,
    risks,
    mrs,
    grade,
    trendLabel: maBull && slopesUp ? "多头发散" : maBull ? "多头排列" : ma5 > ma10 ? "趋势形成中" : "震荡/偏弱"
  };
}

// E-06：相对板块收益可以是 null（3 日样本不足）。展示层必须能表示"未知"，
// 旧代码直接 analysis.rsSector.toFixed(2) 在 null 上会抛 TypeError。
function relativeSectorText(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : "未知";
}

const signedPercentText = (value, digits = 1) => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(digits)}%` : "--";

/** 三个实测因子的匹配结果与说明（数字取不到时写「--」，不当成 0）。 */
function measuredStrategyResults(analysis) {
  const measured = analysis.measured || {};
  const flags = Array.isArray(measured.overheatFlags) ? measured.overheatFlags : [];
  const hasEvent = Boolean(analysis.limitEvent);
  return [
    {
      id: "notOverheated",
      label: "不过热",
      matched: measured.notOverheated === true,
      detail: measured.ma20ExtensionPercent === null || measured.ma20ExtensionPercent === undefined
        ? "历史行情不足，无法判断是否过热"
        : flags.length
          ? `过热指标 ${flags.length} 项：${flags.join("、")}（满 ${OVERHEAT.vetoAtCount} 项即视为过热）`
          : "6 项过热指标均未触发"
    },
    {
      id: "lowPositionBoard",
      label: "低位涨停",
      matched: measured.lowPositionBoard === true,
      detail: hasEvent
        ? `涨停收盘距MA20 ${signedPercentText(measured.limitMa20ExtensionPercent)}（上限 +${LOW_FIRST_BOARD.maxMa20ExtensionPercent}%）/ 涨停前60日 ${signedPercentText(measured.limitReturn60Percent)}（须不为正）`
        : "近60日没有涨停"
    },
    {
      id: "deepBase",
      label: "深跌底部",
      matched: measured.deepBase === true,
      detail: `收盘距MA60 ${signedPercentText(measured.ma60GapPercent)}（须低于 ${DEEP_BASE.ma60GapPercent}%）${hasEvent && measured.lowPositionBoard !== true ? " / 最近一次涨停不属于低位涨停" : ""}`
    }
  ];
}

function strategyDefinitionsFor(analysis, quote) {
  const priceAvailable = Number.isFinite(quote.latest) && quote.latest > 0 && !quote.missingFields?.includes("latest");
  const aboveAvwap = Boolean(priceAvailable && analysis.avwap && quote.latest >= analysis.avwap);
  const emotion = analysis.marketEmotion;
  const marketEmotionMatched = Boolean(
    emotion && emotion.score >= 60 && emotion.limitDownRatio <= 0.35
  );
  const hardRiskReasons = [];
  if (priceAvailable && analysis.limitEvent && quote.latest < analysis.limitEvent.low) {
    hardRiskReasons.push("收盘跌破涨停低点");
  }
  if (analysis.volumeRatio > 2) hardRiskReasons.push("成交量超过2倍");
  if (analysis.divergence > 10) hardRiskReasons.push("均线乖离过热");
  if (priceAvailable && analysis.avwap && quote.latest < analysis.avwap && analysis.volumeRatio > 1.3) {
    hardRiskReasons.push("放量跌破AVWAP");
  }
  if (analysis.closePosition < 0.25 && analysis.volumeRatio > 1.5) {
    hardRiskReasons.push("放量弱收盘");
  }
  if (analysis.marketEmotion?.score < 45 || analysis.marketEmotion?.limitDownRatio > 0.55) {
    hardRiskReasons.push("市场情绪转弱，不适合新增仓位");
  }
  if (
    Number.isFinite(analysis.relativeTurnover) &&
    analysis.relativeTurnover >= 2.8 &&
    analysis.volumeRatio >= 1.8 &&
    Number.isFinite(analysis.stockReturn3) &&
    analysis.stockReturn3 < -1.5
  ) {
    hardRiskReasons.push("下跌时换手失衡，成交放大且承压");
  }
  if (analysis.infoRiskSeverity >= 3) {
    hardRiskReasons.push("存在高可信重大风险公告");
  }
  return [
    {
      id: "support",
      label: "涨停低点防守",
      matched: analysis.heldSupport,
      detail: analysis.heldSupport ? "未跌破涨停日最低价" : "已跌破涨停日最低价"
    },
    {
      id: "avwap",
      label: "锚定均价承接",
      matched: aboveAvwap,
      detail: aboveAvwap ? "价格位于涨停 AVWAP 上方" : "价格位于涨停 AVWAP 下方"
    },
    {
      id: "trend",
      label: "均线多头发散",
      matched: analysis.maBull && analysis.slopesUp,
      detail: analysis.trendLabel
    },
    {
      id: "contraction",
      label: "缩量抗跌",
      matched: analysis.volumeRatio > 0 && analysis.volumeRatio < 1 && Number.isFinite(analysis.relativeTurnover) && analysis.relativeTurnover > 0 && analysis.relativeTurnover < 1.5,
      detail: `量能 ${analysis.volumeRatio.toFixed(2)}x / 相对换手 ${Number.isFinite(analysis.relativeTurnover) ? `${analysis.relativeTurnover.toFixed(2)}x` : "--"}`
    },
    {
      id: "sector",
      label: "强板块共振",
      // rsSector 为 null 时 null >= 0 会隐式成立，必须显式要求是有限数。
      matched: analysis.sectorScore >= 65 && Number.isFinite(analysis.rsSector) && analysis.rsSector >= 0,
      detail: `板块 ${analysis.sectorScore} 分 / 相对板块 ${relativeSectorText(analysis.rsSector)}`
    },
    {
      id: "volatility",
      label: "回撤与收盘质量",
      matched: analysis.maxDrawdown < 10 && analysis.closePosition > 0.55,
      detail: `最大回撤 ${analysis.maxDrawdown.toFixed(2)}% / 收盘位置 ${(analysis.closePosition * 100).toFixed(0)}%`
    },
    {
      id: "originBreakout",
      label: "平台突破首板",
      matched: Boolean(analysis.originBreakout),
      detail: analysis.boxHigh
        ? `箱体宽度 ${Number(analysis.boxWidth || 0).toFixed(1)}% / 突破 ${Number(analysis.breakoutPct || 0).toFixed(1)}% / 涨停量比 ${Number(analysis.limitVolumeRatio || 0).toFixed(2)}x${analysis.originLocalVeto ? " / 已触发局部否决" : ""}`
        : "涨停日前20日箱体数据不足"
    },
    {
      id: "vcpCompression",
      label: "波动压缩平台",
      matched: Boolean(analysis.vcpCompression),
      detail: analysis.limitEvent
        ? `TR压缩 ${Number(analysis.compressionRatio || 0).toFixed(2)}x / 平台宽度 ${Number(analysis.vcpPlatformWidth || 0).toFixed(1)}% / 后段波动 ${Number(analysis.lateEarlyRatio || 0).toFixed(2)}x${analysis.vcpLocalVeto ? " / 已触发局部否决" : ""}`
        : "暂无涨停后整理区间"
    },
    {
      id: "chipLock",
      label: "筹码锁定",
      matched: Boolean(analysis.chipLock),
      detail: analysis.limitEvent
        ? `锁定 ${Number(analysis.chipLockScore || 0)}分 / ${analysis.chipUsesTurnover ? "换手" : "量能代理"}衰减 ${Number(analysis.turnoverDecay || 0).toFixed(2)}x / 下跌量占比 ${(Number(analysis.downVolumeShare || 0) * 100).toFixed(0)}%${analysis.chipLocalVeto ? " / 已触发局部否决" : ""}`
        : "暂无涨停后筹码区间"
    },
    {
      id: "information",
      label: "信息催化确认",
      matched: analysis.infoScore >= 60 && (analysis.infoRiskSeverity || 0) < 2,
      detail: `催化 ${analysis.infoScore} 分 / 风险级别 ${analysis.infoRiskSeverity || 0}`
    },
    {
      id: "exactNode",
      label: "精确观察节点",
      matched: Boolean(analysis.exactNode),
      detail: analysis.exactNode || analysis.nextNode || "不在观察节点"
    },
    {
      id: "lowFirstBoard",
      label: "低位首板",
      matched: analysis.isLowFirstBoard && analysis.heldSupport,
      detail: `近60日 ${analysis.eventCount60} 次涨停 / 板前20日 ${analysis.preLimitReturn20.toFixed(1)}%`
    },
    {
      id: "firstBoardQuality",
      label: "首板质量",
      matched: Boolean(analysis.firstBoardQuality?.matched),
      detail: analysis.firstBoardQuality?.summary || "等待涨停专题字段"
    },
    {
      id: "secondBreakout",
      label: "平台二次突破",
      matched: analysis.secondBreakout,
      detail: analysis.platformHigh
        ? `平台高点 ${analysis.platformHigh.toFixed(2)} / 整理振幅 ${analysis.platformRange.toFixed(1)}%`
        : "涨停后平台尚未形成"
    },
    {
      id: "sectorLeader",
      label: "板块龙头",
      matched: analysis.sectorLeader,
      detail: analysis.sectorRank
        ? `板块排名第 ${analysis.sectorRank} / 相对板块 ${relativeSectorText(analysis.rsSector)}`
        : `相对板块 ${relativeSectorText(analysis.rsSector)} / 板块 ${analysis.sectorScore} 分`
    },
    {
      id: "sectorLadder",
      label: "板块梯队",
      matched: (analysis.sectorLadderScore || 0) >= 65,
      detail: analysis.sectorLadder
        ? `${analysis.sectorLadder.state} ${analysis.sectorLadder.score}分 / 高度${analysis.sectorLadder.maxHeight}板`
        : "板块梯队数据暂不可用"
    },
    {
      id: "weakToStrong",
      label: "弱转强",
      matched: analysis.weakToStrong,
      detail: analysis.reclaimedSupport
        ? "盘中跌破关键位后收回"
        : analysis.lowOpenRecovery
          ? "低开后收盘反包"
          : "尚未出现弱转强结构"
    },
    {
      id: "marketEmotion",
      label: "市场情绪过滤",
      matched: marketEmotionMatched,
      detail: emotion
        ? `${emotion.state} ${emotion.score}分 / 涨停${emotion.limitUpCount} 跌停${emotion.limitDownCount}`
        : "市场情绪数据暂不可用"
    },
    ...measuredStrategyResults(analysis),
    {
      id: "riskVeto",
      label: "风险否决",
      matched: hardRiskReasons.length === 0,
      detail: hardRiskReasons.length ? hardRiskReasons.join("、") : "未触发硬性风险"
    }
  ];
}

async function dataByProvider(security, settings = {}) {
  const serviceSettings = settings || {};
  const startedAt = Date.now();
  if (serviceSettings.provider !== "ths") {
    const [publicQuote, history] = await Promise.all([
      publicQuoteWithFallback(security),
      eastHistoryCached(security, 160, 1, 8 * 60 * 1000, serviceSettings)
    ]);
    return {
      quote: publicQuote.quote,
      history,
      actualProvider: publicQuote.actualProvider,
      requestedPrimary: "eastmoney",
      primaryStatus: "active",
      warning: publicQuote.warning,
      providerLatencyMs: Date.now() - startedAt
    };
  }
  if (!String(serviceSettings.refreshToken || "").trim()) {
    // 未配置 QuantAPI：同花顺免费行情为主源。东方财富报价同时取一次，
    // 既补行业/涨跌停等免费网关没有的字段，也作为交叉校验；同一请求被接力链复用。
    let eastPromise = null;
    const eastOnce = () => (eastPromise ||= eastQuote(security, 6000));
    const eastVerification = marketSourceHealth.isOpen("eastmoney")
      ? Promise.resolve(null)
      : eastOnce().then((quote) => { rememberIndustry(quote); return quote; }, () => null);
    const [freeQuote, history, verification] = await Promise.all([
      marketQuoteChain(security, { eastFactory: eastOnce }),
      eastHistoryCached(security, 160, 1, 8 * 60 * 1000, serviceSettings),
      eastVerification
    ]);
    const quote = { ...freeQuote.quote };
    if (verification && freeQuote.actualProvider !== "eastmoney") {
      if (!quote.industry || quote.industry === "未分类") quote.industry = verification.industry;
      if (!(quote.limitUp > 0)) quote.limitUp = verification.limitUp;
      if (!(quote.limitDown > 0)) quote.limitDown = verification.limitDown;
    }
    if (!quote.industry) quote.industry = "未分类";
    return {
      quote,
      history,
      actualProvider: freeQuote.actualProvider,
      requestedPrimary: "ths",
      primaryStatus: ["fuyao", "ths_free"].includes(freeQuote.actualProvider) ? "free_active" : "fallback",
      warning: freeQuote.warning,
      verificationQuote: freeQuote.actualProvider === "eastmoney" ? null : verification,
      verificationProvider: verification ? "eastmoney" : "",
      providerLatencyMs: Date.now() - startedAt
    };
  }
  try {
    const [[quote, history], publicMeta] = await Promise.all([
      Promise.all([
        thsQuote(security, serviceSettings),
        thsHistoryCached(security, serviceSettings)
      ]),
      publicQuoteWithFallback(security).catch(() => null)
    ]);
    if (publicMeta?.quote) {
      quote.name = publicMeta.quote.name;
      quote.industry = publicMeta.quote.industry;
      quote.secid = publicMeta.quote.secid;
      quote.limitUp = publicMeta.quote.limitUp;
      quote.limitDown = publicMeta.quote.limitDown;
    }
    return {
      quote,
      history,
      actualProvider: "ths",
      requestedPrimary: "ths",
      primaryStatus: "active",
      warning: "",
      verificationQuote: publicMeta?.quote || null,
      verificationProvider: publicMeta?.actualProvider || "",
      providerLatencyMs: Date.now() - startedAt
    };
  } catch (error) {
    if (serviceSettings.fallbackEnabled === false) throw error;
    const [publicQuote, history] = await Promise.all([
      marketQuoteChain(security),
      eastHistoryCached(security, 160, 1, 8 * 60 * 1000, serviceSettings)
    ]);
    if (!publicQuote.quote.industry) publicQuote.quote.industry = "未分类";
    return {
      quote: publicQuote.quote,
      history,
      actualProvider: publicQuote.actualProvider,
      requestedPrimary: "ths",
      primaryStatus: "unavailable",
      warning: [
        `同花顺 QuantAPI 连接失败，已切换${QUOTE_SOURCE_LABELS[publicQuote.actualProvider] || "免费行情"}：${error.message}`,
        publicQuote.warning
      ].filter(Boolean).join(" "),
      providerLatencyMs: Date.now() - startedAt
    };
  }
}

async function analyzeSecurity(input, settings = {}, options = {}) {
  settings = settings || {};
  const security = toSecurity(input);
  if (!/^\d{6}$/.test(security.code)) throw new Error("请输入正确的6位股票代码");
  const core = await dataByProvider(security, settings);
  const isStockAsset = security.assetType === "stock";
  if (isStockAsset && isRiskStockName(core.quote.name)) {
    throw new Error(`${core.quote.name} 属于 ST 或退市风险股票，已按策略剔除`);
  }
  const [
    news,
    marketEmotion,
    marketSnapshot,
    ladderPools,
    replayHistory,
    replayBenchmarkHistory
  ] = await Promise.all([
    isStockAsset ? announcements(security.code).catch(() => []) : Promise.resolve([]),
    marketEmotionSnapshot(settings).catch(() => null),
    isStockAsset
      ? wholeMarketSnapshot(settings).catch(() => ({ breadth: null, averageReturn: null }))
      // 非股票资产（ETF / 可转债）本就不参与板块强弱，保留中性的 50% 广度占位，语义是"不适用"而非"取不到"。
      : Promise.resolve({ breadth: 0.5, averageReturn: 0 }),
    isStockAsset
      ? currentLadderPools(settings).catch(() => ({
          currentPool: [],
          previousPool: [],
          failedPool: null,
          failedPoolAvailable: false
        }))
      : Promise.resolve({ currentPool: [], previousPool: [], failedPool: null, failedPoolAvailable: false }),
    isStockAsset
      ? eastHistoryCached(security, 420, 0, 30 * 60 * 1000, settings).catch(() => null)
      : Promise.resolve(null),
    isStockAsset
      ? eastHistoryCached(
          { code: "000985", secid: "1.000985", thscode: "000985.SH", assetType: "index" },
          420,
          0,
          30 * 60 * 1000,
          settings
        ).catch(() => [])
      : Promise.resolve([])
  ]);
  const safeReplayHistory = Array.isArray(replayHistory) && replayHistory.length && Number(replayHistory.actualAdjustment ?? 0) === 0
    ? replayHistory
    : (Array.isArray(core.history) && Number(core.history.actualAdjustment ?? 1) === 0 ? core.history : []);
  const dataFederation = await quoteFederation(security, core, settings).catch(() => {
    const providerMeta = quoteProviderMeta(core.actualProvider);
    return buildQuoteConsensus([
      sourceFromQuote(providerMeta.id, providerMeta.name, core.quote, {
        kind: providerMeta.kind,
        role: core.actualProvider === "ths" ? "主数据源" : "故障接力",
        latencyMs: core.providerLatencyMs
      })
    ]);
  });
  const sector = isStockAsset
    ? await sectorStrength(core.quote.industry, {
        marketBreadth: marketSnapshot.breadth,
        marketAverageReturn: marketSnapshot.averageReturn,
        ladderPools,
        options: settings
      }).catch(() => null)
    : null;
  const analysis = analyzeHistory(
    security,
    core.quote,
    core.history,
    sector,
    marketEmotion,
    replayBenchmarkHistory,
    safeReplayHistory.length ? safeReplayHistory : undefined
  );
  const isSearchOnlyAsset =
    security.assetType === "etf" || security.assetType === "convertibleBond";
  analysis.analysisScope = isSearchOnlyAsset
    ? "searchOnlyAsset"
    : analysis.limitEvent
      ? "limitUpEvent"
      : "generalStock";
  analysis.limitUpContextAvailable = Boolean(analysis.limitEvent);
  if (isSearchOnlyAsset) {
    const assetLabel = security.assetType === "etf" ? "ETF" : "可转债";
    const trendPassed = Boolean(analysis.maBull && analysis.slopesUp);
    const volumePassed = Number(analysis.volumeRatio || 0) <= 1.8;
    const volatilityPassed =
      Number(analysis.closePosition || 0) >= 0.35 &&
      Number(analysis.volumeRatio || 0) <= 2.2;
    const assetRiskReasons = [];
    if (Number(analysis.divergence || 0) > 12) assetRiskReasons.push("均线乖离偏热");
    if (Number(analysis.volumeRatio || 0) > 2.2) assetRiskReasons.push("量能异常放大");
    if (Number(analysis.closePosition || 0) < 0.2) assetRiskReasons.push("日内收盘位置偏弱");
    const assetWindow = core.history.slice(-10);
    const assetVolume = assetWindow.reduce(
      (sum, item) => sum + Math.max(0, Number(item.volume || 0)),
      0
    );
    const assetWeightedPrice = assetWindow.reduce((sum, item) => {
      const typicalPrice =
        (Number(item.high || item.close || 0) +
          Number(item.low || item.close || 0) +
          Number(item.close || 0)) / 3;
      return sum + typicalPrice * Math.max(0, Number(item.volume || 0));
    }, 0);
    const assetRangeWindow = core.history.slice(-20);
    const assetWindowHigh = Math.max(...assetRangeWindow.map((item) => Number(item.high || 0)));
    const assetWindowLow = Math.min(...assetRangeWindow.map((item) => Number(item.low || 0)));
    analysis.assetType = security.assetType;
    analysis.assetLabel = assetLabel;
    analysis.isSearchOnlyAsset = true;
    analysis.limitEvent = null;
    analysis.daysSince = null;
    analysis.exactNode = null;
    analysis.nextNode = null;
    analysis.heldSupport = true;
    analysis.supportDistance = 0;
    analysis.eventCount60 = 0;
    analysis.isLowFirstBoard = false;
    analysis.platformHigh = 0;
    analysis.platformRange = 0;
    analysis.avwap = assetVolume ? assetWeightedPrice / assetVolume : 0;
    analysis.maxDrawdown =
      assetWindowHigh > 0 && Number.isFinite(assetWindowLow)
        ? ((assetWindowHigh - assetWindowLow) / assetWindowHigh) * 100
        : 0;
    analysis.structureScore = clampScore(
      (analysis.maBull ? 35 : 10) +
        (analysis.slopesUp ? 25 : 5) +
        (Number(core.history.at(-1)?.close || 0) > Number(analysis.ma5 || 0) ? 20 : 0) +
        (volumePassed ? 10 : 3) +
        (Number(analysis.closePosition || 0) >= 0.5 ? 10 : 3)
    );
    analysis.firstBoardQuality = null;
    analysis.sectorLadder = null;
    analysis.sectorLadderScore = 0;
    analysis.infoScore = 50;
    analysis.infoRiskSeverity = 0;
    analysis.infoRiskPenalty = 0;
    analysis.nodeScore = 50;
    analysis.risks = assetRiskReasons;
    analysis.riskPenalty = assetRiskReasons.length * 6;
    analysis.mrs = clampScore(
      analysis.structureScore * 0.62 +
        analysis.marketScore * 0.18 +
        (volumePassed ? 12 : 4) +
        (volatilityPassed ? 8 : 2) -
        analysis.riskPenalty
    );
    analysis.grade =
      analysis.mrs >= 85 ? "S" : analysis.mrs >= 75 ? "A" : analysis.mrs >= 60 ? "B" : "C";
    analysis.historicalStats = null;
    analysis.historicalEdge = null;
    analysis.strategyResults = [
      {
        id: "trend",
        label: "均线趋势",
        matched: trendPassed,
        detail: analysis.trendLabel
      },
      {
        id: "contraction",
        label: "量能结构",
        matched: volumePassed,
        detail: `量能倍数 ${Number(analysis.volumeRatio || 0).toFixed(2)}x`
      },
      {
        id: "volatility",
        label: "波动与收盘质量",
        matched: volatilityPassed,
        detail: `收盘位置 ${(Number(analysis.closePosition || 0) * 100).toFixed(0)}%`
      },
      {
        id: "riskVeto",
        label: "风险观察",
        matched: assetRiskReasons.length === 0,
        detail: assetRiskReasons.join("；") || "未发现明显量价风险"
      }
    ];
    analysis.strategyMatched = analysis.strategyResults.filter((item) => item.matched).length;
    analysis.strategyTotal = analysis.strategyResults.length;
    analysis.strategyMatchRate = Math.round(
      (analysis.strategyMatched / analysis.strategyTotal) * 100
    );
    analysis.strategyQualified = false;
    analysis.alertQualified = false;
    analysis.qualification = {
      strategyMatched: false,
      scoreMatched: false,
      nodeMatched: false,
      riskVetoPassed: assetRiskReasons.length === 0,
      historicalEdgePassed: false,
      historicalEdgePenalty: 0,
      alertScore: Number(settings.alertScore || 75),
      exactNodesOnly: false,
      vetoReasons: assetRiskReasons,
      note: `${assetLabel} 不进入A股涨停策略、观察池和自动交易信号`
    };
    analysis.tradePlan = buildTradePlan(analysis, core.quote, core.history, settings);
    if (analysis.tradePlan) analysis.tradePlan.signal = "WAIT";
    analysis.actionSignal = "WAIT";
    analysis.tradeExecutionReadiness = buildTradeExecutionReadiness(
      analysis,
      analysis.tradePlan,
      settings
    );
    analysis.executionReadiness = analysis.tradeExecutionReadiness;
    return {
      security: { ...security, name: core.quote.name },
      quote: { ...core.quote, assetType: security.assetType, assetLabel },
      history: core.history.slice(-90),
      analysis,
      sector: null,
      dataFederation,
      announcements: news,
      actualProvider: core.actualProvider,
      warning: `${assetLabel} 支持行情与多周期 K 线；不参与A股涨停策略筛选`,
      updatedAt: new Date().toISOString()
    };
  }
  const limitPool = analysis.limitEvent
    ? await topicPoolForDate(analysis.limitEvent.date, "limit", settings).catch(() => null)
    : null;
  const poolRecord = limitPool?.pool?.find((item) => item.code === security.code) || null;
  analysis.firstBoardQuality = analysis.limitEvent
    ? scoreFirstBoardQuality(poolRecord, analysis)
    : null;
  analysis.sectorLadder = sector?.ladder || null;
  analysis.sectorLadderScore = sector?.ladder?.score || 0;

  const recentNews = news.slice(0, 8);
  const positiveImpact = recentNews
    .filter((item) => item.direction === "positive")
    .reduce((max, item) => Math.max(max, Number(item.impactScore || item.score || 0)), 0);
  const negativeImpact = recentNews
    .filter((item) => item.direction === "negative" || item.direction === "mixed")
    .reduce((max, item) => Math.max(max, Number(item.impactScore || item.score || 0)), 0);
  analysis.infoRiskSeverity = recentNews.reduce(
    (max, item) => Math.max(max, Number(item.riskSeverity || 0)),
    0
  );
  analysis.infoScore = news.length
    ? Math.round(Math.max(0, Math.min(100, 50 + positiveImpact * 0.42 - negativeImpact * 0.48)))
    : 50;
  analysis.infoRiskPenalty =
    analysis.infoRiskSeverity >= 3 ? 25 :
      analysis.infoRiskSeverity === 2 ? 12 :
        analysis.infoRiskSeverity === 1 ? 5 : 0;
  if (analysis.infoRiskPenalty) {
    analysis.riskPenalty += analysis.infoRiskPenalty;
    const riskNews = recentNews.find((item) => Number(item.riskSeverity || 0) === analysis.infoRiskSeverity);
    analysis.risks.push(
      analysis.infoRiskSeverity >= 3
        ? `重大公告风险：${riskNews?.title || "高风险事件"}`
        : `资讯风险级别 ${analysis.infoRiskSeverity}`
    );
  }

  const strategyDefinitions = strategyDefinitionsFor(analysis, core.quote);
  const selectedSet = new Set(
    Array.isArray(settings.selectedStrategies)
      ? settings.selectedStrategies
      : ["support", "avwap", "trend", "contraction", "sector"]
  );
  selectedSet.add("riskVeto");
  const selectedIds = [...selectedSet];
  analysis.risks = Array.isArray(analysis.risks) ? analysis.risks : [];
  const rawExternal = options?.externalFactorSnapshots ?? settings?.externalFactorSnapshots;
  const externalSnapshots = rawExternal && typeof rawExternal === "object" ? rawExternal : null;
  analysis.historicalStats = await buildHistoricalStrategyStatsInWorker(
    safeReplayHistory,
    security.code,
    core.quote.name,
    selectedIds,
    replayBenchmarkHistory,
    externalSnapshots ? { externalSnapshots } : {}
  );
  if (externalSnapshots) {
    const latestDate = Object.keys(externalSnapshots).sort().reverse()[0];
    if (latestDate) {
      analysis.regimeProfile = computeRegimeWeightProfile(externalSnapshots[latestDate]);
      analysis.externalArchiveDays = Object.keys(externalSnapshots).length;
    }
  }
  analysis.historicalEdge = edgeGateFromStats(analysis.historicalStats, {
    strictGate: Boolean(settings.strictGate)
  });
  analysis.riskPenalty += Number(analysis.historicalEdge?.penalty || 0);
  if (analysis.historicalEdge?.reasons?.length) {
    analysis.risks.push(...analysis.historicalEdge.reasons);
  }
  analysis.mrs = clampScore(
    analysis.structureScore * 0.35 +
      analysis.sectorScore * 0.3 +
      analysis.infoScore * 0.2 +
      analysis.marketScore * 0.1 +
      analysis.nodeScore * 0.05 -
      analysis.riskPenalty
  );
  analysis.grade =
    analysis.mrs >= 85 ? "S" : analysis.mrs >= 75 ? "A" : analysis.mrs >= 60 ? "B" : "C";
  analysis.strategyResults = strategyDefinitions.filter((item) => selectedIds.includes(item.id));
  const gateIds = new Set(["riskVeto", "exactNode"]);
  const scoringResults = analysis.strategyResults.filter((item) => !gateIds.has(item.id));
  analysis.strategyMatched = scoringResults.filter((item) => item.matched).length;
  analysis.strategyTotal = scoringResults.length;
  analysis.strategyMatchRate = analysis.strategyTotal
    ? Math.round((analysis.strategyMatched / analysis.strategyTotal) * 100)
    : 0;
  const riskVeto = strategyDefinitions.find((item) => item.id === "riskVeto");
  const exactNodeIsGate = Boolean(settings.exactNodesOnly || selectedSet.has("exactNode"));
  const nodeMatched = !exactNodeIsGate || Boolean(analysis.exactNode);
  analysis.presetRequirements = evaluateAnalysisPresetRequirements(selectedIds, analysis.strategyResults);
  analysis.strategyQualified =
    analysis.presetRequirements.passed &&
    analysis.strategyTotal > 0 &&
    analysis.strategyMatchRate >= 70 &&
    Boolean(analysis.historicalEdge?.passed) &&
    Boolean(riskVeto?.matched) &&
    nodeMatched;
  analysis.alertQualified =
    analysis.strategyQualified &&
    analysis.mrs >= Number(settings.alertScore || 75);
  analysis.qualification = {
    strategyMatched: analysis.strategyQualified,
    scoreMatched: analysis.mrs >= Number(settings.alertScore || 75),
    nodeMatched,
    presetRequirements: analysis.presetRequirements,
    riskVetoPassed: Boolean(riskVeto?.matched),
    historicalEdgePassed: Boolean(analysis.historicalEdge?.passed),
    historicalEdgePenalty: analysis.historicalEdge?.penalty || 0,
    alertScore: Number(settings.alertScore || 75),
    exactNodesOnly: exactNodeIsGate,
    vetoReasons: [
      ...(riskVeto?.matched ? [] : String(riskVeto?.detail || "").split("、").filter(Boolean)),
      ...analysis.presetRequirements.missingFactors.map(id => `命名组合必要条件未满足：${id}`)
    ]
  };
  analysis.tradePlan = buildTradePlan(analysis, core.quote, core.history, settings);
  analysis.actionSignal = analysis.tradePlan?.signal || (analysis.alertQualified ? "BUY" : "WAIT");
  const tradeExecutionReadiness = buildTradeExecutionReadiness(
    analysis,
    analysis.tradePlan,
    settings
  );
  analysis.tradeExecutionReadiness = tradeExecutionReadiness;
  analysis.executionReadiness = tradeExecutionReadiness;
  return {
    security: { ...security, name: core.quote.name },
    quote: core.quote,
    history: core.history.slice(-90),
    analysis,
    sector,
    dataFederation,
    announcements: news,
    actualProvider: core.actualProvider,
    warning: core.warning,
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildTradeExecutionReadiness,
  calculateAtr,
  buildTradePlan,
  movingAverage,
  clampScore,
  edgeGateFromStats,
  analyzeHistory,
  relativeSectorText,
  strategyDefinitionsFor,
  dataByProvider,
  analyzeSecurity
};
