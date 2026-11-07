"use strict";

const signalCombinations = require("./strategy-signal-combinations.cjs");
const selectionRules = require("./strategy-selection-rules.cjs");
const customStrategy = require("./custom-strategy.cjs");
const { legacyFactorSnapshot, isRiskSecurityName } = require("./strategy-intelligence.cjs");
const { isLimitUpBar, isOpeningLimitUpEntry, isOnePriceLimitUpEntry, isClosingLimitDownExit } = require("./price-limit-rules.cjs");

const { intervalPriceBasisIssue, priceBasisIssueAt } = require("./quant-history-safety.cjs");
const fieldRules = require("./strategy-field-rules.cjs");

const { roundTripBps } = require("./backtest-costs.cjs");

const DEFAULT_OPTIONS = Object.freeze({
  horizonDays: 5,
  cooldownDays: 5,
  minSamples: 30,
  minOutOfSampleSamples: 9,
  minWinRate: 45,
  minAverageReturn: 0.2,
  maxDrawdown: -22,
  roundTripCostBps: roundTripBps(),
  outOfSampleRatio: 0.3,
  walkForwardFolds: 3,
  minWalkForwardFoldSamples: 3,
  minCurrentHistoryBars: 60,
  minReturnLowerBound: -0.25,
  maxStrategyOverlap: 0.72,
  optimizedMinVotes: 2,
  terminalHoldoutRatio: 0.2
});

function finite(value) {
  return value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function numberOrNull(...values) {
  for (const value of values) {
    if (value !== "" && value !== null && value !== undefined && finite(value)) {
      return Number(value);
    }
  }
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function roundNullable(value, digits = 3) {
  return finite(value) ? round(Number(value), digits) : null;
}

/**
 * Fail-closed confidence gate. A missing (null/undefined/""/non-finite) 95%
 * one-sided lower bound can never satisfy the minimum: an unavailable bound is
 * absence of evidence, not evidence of zero. Previously `Number(null) === 0`
 * let every "insufficient independent samples" case slip through the gate.
 */
function lowerBoundPasses(value, minimum) {
  if (value === null || value === undefined || value === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= Number(minimum);
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length
    ? valid.reduce((total, value) => total + value, 0) / valid.length
    : null;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2
    ? valid[middle]
    : (valid[middle - 1] + valid[middle]) / 2;
}

function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return null;
  const mean = average(valid);
  const variance =
    valid.reduce((total, value) => total + (value - mean) ** 2, 0) /
    (valid.length - 1);
  return Math.sqrt(variance);
}

function dailyPortfolioReturns(samples) {
  const grouped = new Map();
  for (const sample of samples) {
    if (!finite(sample?.netReturn)) continue;
    const date = normalizeDate(sample.signalDate);
    if (!date) continue;
    const values = grouped.get(date) || [];
    const calendarDays = (Date.parse(sample.exitDate) - Date.parse(sample.entryDate)) / 86400000 + 1;
    const horizon = finite(sample.holdingTradingDays) ? Math.max(1, Number(sample.holdingTradingDays)) : Number.isFinite(calendarDays) ? Math.max(1, calendarDays) : 1;
    values.push(Number(sample.netReturn) / horizon);
    grouped.set(date, values);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, values]) => ({
      date,
      return: average(values),
      stockCount: values.length
    }));
}

function normalizeDate(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  const match = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : text.slice(0, 10);
}

function replayQuality() {
  return { invalidRows: 0, duplicateDates: 0, insufficientHistories: 0, unknownStRows: 0, validRows: 0, missingCodes: 0 };
}

function normalizeHistory(input, quality, through = "") {
  if (!Array.isArray(input)) return [];
  const byDate = new Map();
  for (const raw of input) {
    const date = normalizeDate(raw?.date ?? raw?.tradeDate ?? raw?.time);
    const open = numberOrNull(raw?.open);
    const high = numberOrNull(raw?.high);
    const low = numberOrNull(raw?.low);
    const close = numberOrNull(raw?.close);
    if (through && date > through) continue;
    if (!date || !open || !high || !low || !close || (quality && (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date ||
      Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) || low > Math.min(open, close)
    ))) {
      if (quality) quality.invalidRows++;
      continue;
    }
    if (quality && byDate.has(date)) quality.duplicateDates++;
    byDate.set(date, {
      date,
      open,
      high,
      low,
      close,
      volume: numberOrNull(raw?.volume, raw?.vol),
      amount: numberOrNull(raw?.amount),
      turnover: numberOrNull(raw?.turnover, raw?.turnoverRate),
      ...Object.fromEntries(["changePct", "changePercent", "pctChange", "preClose", "previousClose", "adjustmentFactor", "adjFactor", "corporateActionUnresolved", "lowerLimit"].filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]])),
      ...(Object.hasOwn(raw, "upperLimit") ? { upperLimit: raw.upperLimit } : {}),
      ...(Object.hasOwn(raw, "noPriceLimit") ? { noPriceLimit: raw.noPriceLimit } : {}),
      ...(Object.hasOwn(raw, "isST") ? { isST: raw.isST } : {})
    });
  }
  const rows = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (quality) {
    quality.validRows += rows.length;
    quality.unknownStRows += rows.filter(row => typeof row.isST !== "boolean").length;
  }
  return rows;
}

function isLimitUpAt(history, index, code, name) {
  if (index < 1 || index >= history.length) return false;
  const previousClose = Number(history[index - 1]?.close);
  const current = history[index];
  return isLimitUpBar(previousClose, current, code, name);
}

function meanClose(history, endIndex, period) {
  if (endIndex < 0) return null;
  return average(
    history
      .slice(Math.max(0, endIndex - period + 1), endIndex + 1)
      .map((row) => Number(row.close))
  );
}

function volumeAverage(history, start, end) {
  return average(
    history
      .slice(Math.max(0, start), Math.max(0, end))
      .map((row) => finite(row.volume) ? Number(row.volume) : null)
      .filter(Number.isFinite)
  );
}

function averageRangePercent(rows) {
  return average(
    rows
      .map((row) =>
        row.close > 0 ? ((Number(row.high) - Number(row.low)) / Number(row.close)) * 100 : null
      )
      .filter(Number.isFinite)
  );
}

function detectLimitIndices(history, code, name, endIndex = history.length - 1) {
  const indices = [];
  for (let index = 1; index <= Math.min(endIndex, history.length - 1); index += 1) {
    if (isLimitUpAt(history, index, code, name)) indices.push(index);
  }
  return indices;
}

/**
 * 下跌后放量大阳反弹、次日平量微涨微跌（v1.1.0：加入“不破大阳最低价”，去掉涨停日支撑否决；固定参数）：
 *   T-1 大阳：涨幅≥5%、收阳且实体≥3%，成交量≥此前5日均量1.8倍；
 *   T-1 之前处于下跌：T-2 收盘较此前20日最高收盘回落≥10%；
 *   T（信号日）：成交量为大阳日的0.8–1.25倍，涨跌幅在±2%以内，最低价不跌破大阳日最低价。
 * 这套形态自带承接判断，不套用“涨停日支撑”否决：大阳之前的下跌本来就会跌破更早涨停日的低点。
 * 只用到 T 及之前的日线。
 */
const VOLUME_REBOUND_HOLD = Object.freeze({ declineLookback: 20, minDeclinePercent: 10, minBigYangChangePercent: 5,
  minBigYangBodyPercent: 3, volumeBaseSessions: 5, minBigYangVolumeRatio: 1.8, minHoldVolumeRatio: 0.8, maxHoldVolumeRatio: 1.25,
  maxHoldChangePercent: 2 });

function volumeReboundHoldAt(history, index) {
  const cfg = VOLUME_REBOUND_HOLD;
  const empty = { passed: false };
  if (index < cfg.declineLookback + 2) return empty;
  const today = history[index], yang = history[index - 1], before = history[index - 2];
  const num = (value) => (finite(value) ? Number(value) : null);
  const [todayClose, todayVolume, todayLow, yangOpen, yangClose, yangVolume, yangLow, beforeClose] =
    [today?.close, today?.volume, today?.low, yang?.open, yang?.close, yang?.volume, yang?.low, before?.close].map(num);
  if (![todayClose, todayVolume, todayLow, yangOpen, yangClose, yangVolume, yangLow, beforeClose].every((value) => value !== null && value > 0)) return empty;
  const highBefore = Math.max(...history.slice(index - 1 - cfg.declineLookback, index - 1).map((row) => Number(row.close)).filter(Number.isFinite));
  const declinePercent = finite(highBefore) && highBefore > 0 ? (1 - beforeClose / highBefore) * 100 : null;
  const baseVolume = volumeAverage(history, index - 1 - cfg.volumeBaseSessions, index - 1);
  const bigYangChangePercent = (yangClose / beforeClose - 1) * 100;
  const bigYangBodyPercent = ((yangClose - yangOpen) / beforeClose) * 100;
  const bigYangVolumeRatio = baseVolume ? yangVolume / baseVolume : null;
  const holdVolumeRatio = todayVolume / yangVolume;
  const holdChangePercent = (todayClose / yangClose - 1) * 100;
  const passed = declinePercent !== null && declinePercent >= cfg.minDeclinePercent &&
    bigYangChangePercent >= cfg.minBigYangChangePercent && yangClose > yangOpen && bigYangBodyPercent >= cfg.minBigYangBodyPercent &&
    bigYangVolumeRatio !== null && bigYangVolumeRatio >= cfg.minBigYangVolumeRatio &&
    holdVolumeRatio >= cfg.minHoldVolumeRatio && holdVolumeRatio <= cfg.maxHoldVolumeRatio &&
    Math.abs(holdChangePercent) <= cfg.maxHoldChangePercent && todayLow >= yangLow;
  return { passed, heldBigYangLow: todayLow >= yangLow, bigYangDate: yang.date, bigYangLow: yangLow, declinePercent, bigYangChangePercent, bigYangBodyPercent, bigYangVolumeRatio, holdVolumeRatio, holdChangePercent };
}

/**
 * 游资经典打法（固定规则，2026-10-29 新增）。只用到 index 及之前的日线；涨停按交易所规则识别。
 *  - 首阴反包：连续涨停≥2板后出现第一根阴线（首阴），次日阳线收复首阴开盘价，当日涨幅≥5%。
 *  - 断板弱转强：连续涨停≥2板后断板（未涨停），次日高开且收盘站上断板日最高价，收在日内上部。
 *  - 一进二：前一日首板（此前一日未涨停）、今日再封涨停成为2连板，两天都不是一字板。
 *  - 龙回头：近20日最近一段≥3连板的龙头，从高点回调15%–40%后，出现缩量阳线企稳且不破首板启动价（回调期间每个满足条件的企稳日都会选出）。
 */
const YOUZI = Object.freeze({ minStreak: 2, reclaimMinReturnPercent: 5, w2sMinClosePosition: 0.7,
  dragonMinStreak: 3, dragonMinDays: 3, dragonMaxDays: 20, dragonMinPullback: 15, dragonMaxPullback: 40, dragonMaxVolumeRatio: 1.2, dragonMinClosePosition: 0.6 });

function youziPatternsAt(history, index, code, name) {
  const none = { firstNegativeReclaim: null, brokenBoardWeakToStrong: null, firstToSecondBoard: null, dragonPullback: null };
  if (index < 25) return none;
  const limitAt = i => isLimitUpAt(history, i, code, name);
  const streakEndingAt = i => { let count = 0; for (let k = i; k >= 1 && limitAt(k); k -= 1) count += 1; return count; };
  const today = history[index], yesterday = history[index - 1];
  const num = value => Number(value);
  const result = { ...none };
  const priorStreak = streakEndingAt(index - 2);
  const yesterdayLimit = limitAt(index - 1), todayLimit = limitAt(index);
  if (priorStreak >= YOUZI.minStreak && !yesterdayLimit) {
    const todayReturn = (num(today.close) / num(yesterday.close) - 1) * 100;
    if (num(yesterday.close) < num(yesterday.open) && num(today.close) > num(today.open) && num(today.close) >= num(yesterday.open) && todayReturn >= YOUZI.reclaimMinReturnPercent) {
      result.firstNegativeReclaim = { streak: priorStreak, negativeDate: yesterday.date, todayReturn };
    }
    const range = num(today.high) - num(today.low);
    const closePosition = range > 0 ? (num(today.close) - num(today.low)) / range : 1;
    if (num(today.open) > num(yesterday.close) && num(today.close) >= num(yesterday.high) && closePosition >= YOUZI.w2sMinClosePosition) {
      result.brokenBoardWeakToStrong = { streak: priorStreak, brokenDate: yesterday.date, gapPercent: (num(today.open) / num(yesterday.close) - 1) * 100 };
    }
  }
  const onePrice = row => num(row.high) === num(row.low);
  if (todayLimit && yesterdayLimit && !limitAt(index - 2) && !onePrice(today) && !onePrice(yesterday)) {
    result.firstToSecondBoard = { firstBoardDate: yesterday.date };
  }
  // 龙回头：找最近一段≥3连板（结束于 3–20 个交易日前）。
  for (let end = index - YOUZI.dragonMinDays; end >= Math.max(1, index - YOUZI.dragonMaxDays); end -= 1) {
    const streak = streakEndingAt(end);
    if (streak < YOUZI.dragonMinStreak) continue;
    if (limitAt(end + 1)) continue; // 只取连板段的最后一板
    const start = end - streak + 1;
    const launch = num(history[start - 1]?.close);
    // 高点取连板结束到昨天（不含今天）；回调低点只算高点之后；今天已收复高点的不算「回头」。
    let peakIndex = end;
    for (let at = end + 1; at < index; at += 1) if (num(history[at].high) > num(history[peakIndex].high)) peakIndex = at;
    const peak = num(history[peakIndex].high);
    const trough = Math.min(...history.slice(peakIndex + 1, index + 1).map(row => num(row.low)));
    const pullback = peak > 0 && Number.isFinite(trough) && num(today.high) < peak ? (1 - trough / peak) * 100 : null;
    const base = volumeAverage(history, index - 5, index);
    const volumeRatio = base && finite(today.volume) ? num(today.volume) / base : null;
    const range = num(today.high) - num(today.low);
    const closePosition = range > 0 ? (num(today.close) - num(today.low)) / range : 1;
    if (pullback !== null && pullback >= YOUZI.dragonMinPullback && pullback <= YOUZI.dragonMaxPullback &&
        launch > 0 && trough >= launch && num(today.close) > num(today.open) && num(today.close) > num(yesterday.close) &&
        closePosition >= YOUZI.dragonMinClosePosition && volumeRatio !== null && volumeRatio <= YOUZI.dragonMaxVolumeRatio) {
      result.dragonPullback = { streak, peakDate: history[end].date, pullbackPercent: pullback, volumeRatio, daysSincePeak: index - end, pullbackLow: trough, launchPrice: launch };
    }
    break;
  }
  return result;
}

/**
 * 底部趋势（1.6.43）：最近 15 个交易日内的「底部首板」——当日首板、涨停收盘不高于 MA20 的 105%、
 * 板前 60 日涨幅不为正（与低位首板同一口径）。之后再出涨停也保留这个起点。
 * 2021-01 至 2026-10 全A日线实测：底部首板之后，股价离 60 日线越远（跌得越深）后续 20 日相对同日涨停股池越强，
 * 两段年份方向一致；离 60 日线不到 5% 的“浅底”首板反而跑输（见 报告/底部涨停趋势策略实测_1.6.43）。
 * 只用到 index 及之前的日线。
 */
const BOTTOM_TREND = Object.freeze({ lookback: 15, deepMa60GapPercent: -15, reclaimMa60GapPercent: -10, quietBoardVolumeRatio: 1.2,
  pullbackMaxVolumeRatio: 1, pullbackWindow: [1, 10], reclaimWindow: [3, 15] });

function bottomTrendFeatures(history, index, limitIndices, ma10, priorDayMa10, volumeRatio) {
  const current = history[index];
  const close = Number(current?.close);
  const ma60 = index >= 59 ? meanClose(history, index, 60) : null;
  const ma60GapPercent = ma60 && close > 0 ? (close / ma60 - 1) * 100 : null;
  let origin = null;
  for (let cursor = limitIndices.length - 1; cursor >= 0; cursor -= 1) {
    const board = limitIndices[cursor];
    if (index - board > BOTTOM_TREND.lookback) break;
    if (board < 60 || (cursor > 0 && limitIndices[cursor - 1] === board - 1)) continue;
    const boardClose = Number(history[board]?.close);
    const boardMa20 = meanClose(history, board, 20);
    const base60 = Number(history[board - 60]?.close);
    if (!(boardClose > 0) || !boardMa20 || !(base60 > 0)) continue;
    if (boardClose <= boardMa20 * (1 + fieldRules.LOW_FIRST_BOARD.maxMa20ExtensionPercent / 100) && (boardClose / base60 - 1) * 100 <= fieldRules.LOW_FIRST_BOARD.maxReturn60Percent) {
      origin = board;
      break;
    }
  }
  if (origin === null) return { bottomBoardDays: null, ma60GapPercent };
  const board = history[origin];
  const preVolume = volumeAverage(history, origin - 5, origin);
  const after = history.slice(origin + 1, index + 1);
  const lowSince = after.length ? Math.min(...after.map(row => Number(row.low))) : null;
  return {
    bottomBoardDays: index - origin,
    bottomBoardDate: String(board.date || ""),
    bottomBoardClose: Number(board.close),
    bottomBoardLow: Number(board.low),
    bottomBoardVolumeRatio: preVolume && finite(board.volume) ? Number(board.volume) / preVolume : null,
    bottomHeldLow: lowSince === null ? true : lowSince >= Number(board.low) * 0.995,
    limitsSinceBottom: limitIndices.filter(item => item > origin && item < index).length,
    ma60GapPercent,
    ma10GapPercent: ma10 && close > 0 ? (close / ma10 - 1) * 100 : null,
    bottomMa10Reclaim: Boolean(ma10 && priorDayMa10 && index >= 1 && Number(history[index - 1]?.close) < priorDayMa10 && close >= ma10),
    bottomVolumeRatio: volumeRatio
  };
}

/** 底部首板之后的非涨停日：起点之后没有再涨停（不追二波板，实测跑输）。 */
const quietSinceBottom = feature => feature.isCurrentLimit !== true && feature.limitsSinceBottom === 0;
const inWindow = (value, [low, high]) => Number.isInteger(value) && value >= low && value <= high;
/** 连板后缩量回调（2026-11-05 全A实测）：连板（≥2板）结束后 3–10 天，之后日均量不到涨停日的 60%，且始终守住涨停日最低价。 */
const STREAK_PULLBACK = Object.freeze({ window: [3, 10], minBoards: 2, maxPostVolumeRatio: 0.6 });
const bottomReasons = feature => [
  feature.bottomBoardDate ? `底部首板 ${feature.bottomBoardDate}（${feature.bottomBoardDays} 个交易日前）` : "",
  finite(feature.ma60GapPercent) ? `收盘低于MA60 ${round(Math.abs(feature.ma60GapPercent), 1)}%` : ""
].filter(Boolean);

function featureSnapshot(
  history,
  index,
  code,
  name,
  limitIndicesThroughCurrent = null,
  combinationTimeline = null
) {
  const current = history[index];
  if (!current || index < 1) return null;
  const previous = history[index - 1];
  const limitIndices = Array.isArray(limitIndicesThroughCurrent)
    ? limitIndicesThroughCurrent
    : detectLimitIndices(history, code, name, index);
  const latestLimitIndex = limitIndices.at(-1);
  const isCurrentLimit = latestLimitIndex === index;
  const hasRecentLimit =
    Number.isInteger(latestLimitIndex) && index - latestLimitIndex <= 20;
  const eventIndex = hasRecentLimit ? latestLimitIndex : null;
  // The 80-session technical gate is shorter than the low-position input:
  // a recent event also consumes up to 100 bars BEFORE that event. Do not
  // compare prices across a known basis break in either consumed window.
  const priceWindowStart = Math.max(1, Math.min(index - 79,
    Number.isInteger(eventIndex) ? eventIndex - selectionRules.LOW_POSITION.lookback + 1 : index));
  if (intervalPriceBasisIssue(history, priceWindowStart, index, code, name)) return null;
  const event = Number.isInteger(eventIndex) ? history[eventIndex] : null;
  const daysSinceLimit = Number.isInteger(eventIndex) ? index - eventIndex : null;
  const preLimitRows = event
    ? history.slice(Math.max(0, eventIndex - 20), eventIndex)
    : [];
  const preBoxHigh = preLimitRows.length >= 10
    ? Math.max(...preLimitRows.map((row) => Number(row.high)))
    : null;
  const preBoxLow = preLimitRows.length >= 10
    ? Math.min(...preLimitRows.map((row) => Number(row.low)))
    : null;
  const boxWidth =
    preBoxHigh && preBoxLow ? ((preBoxHigh / preBoxLow) - 1) * 100 : null;
  const preLimitBase = eventIndex >= 20 ? Number(history[eventIndex - 20]?.close) : null;
  const preLimitReference = eventIndex >= 1 ? Number(history[eventIndex - 1]?.close) : null;
  const preLimitReturn20 =
    preLimitBase && preLimitReference
      ? ((preLimitReference / preLimitBase) - 1) * 100
      : null;
  const eventPreVolume = event
    ? volumeAverage(history, eventIndex - 5, eventIndex)
    : null;
  const eventVolumeRatio =
    eventPreVolume && finite(event?.volume)
      ? Number(event.volume) / eventPreVolume
      : null;
  const previousVolume = volumeAverage(history, index - 5, index);
  const volumeRatio =
    previousVolume && finite(current.volume)
      ? Number(current.volume) / previousVolume
      : null;
  const closePosition =
    Number(current.high) > Number(current.low)
      ? (Number(current.close) - Number(current.low)) /
        (Number(current.high) - Number(current.low))
      : Number(current.close) >= Number(current.open) ? 1 : 0;
  const recentRows = event ? history.slice(eventIndex, index + 1) : [];
  const heldSupport =
    event && recentRows.length
      ? Math.min(...recentRows.map((row) => Number(row.low))) >= Number(event.low) * 0.995
      : null;
  const maxDrawdownSinceLimit =
    event && recentRows.length
      ? Math.min(...recentRows.map((row) => ((Number(row.low) / Number(event.close)) - 1) * 100))
      : null;
  const postRows =
    event && index > eventIndex
      ? history.slice(eventIndex + 1, index + 1)
      : [];
  const postVolumeAverage = average(
    postRows.map((row) => finite(row.volume) ? Number(row.volume) : null).filter(Number.isFinite)
  );
  const postVolumeRatio =
    postVolumeAverage && finite(event?.volume)
      ? postVolumeAverage / Number(event.volume)
      : null;
  const preVolatility = event
    ? averageRangePercent(history.slice(Math.max(0, eventIndex - 10), eventIndex))
    : null;
  const postVolatility = postRows.length ? averageRangePercent(postRows) : null;
  const postHigh =
    postRows.length > 1
      ? Math.max(...postRows.slice(0, -1).map((row) => Number(row.high)))
      : null;
  const postRangeHigh = postRows.length
    ? Math.max(...postRows.map((row) => Number(row.high)))
    : null;
  const postRangeLow = postRows.length
    ? Math.min(...postRows.map((row) => Number(row.low)))
    : null;
  const postRangePercent =
    postRangeHigh && postRangeLow
      ? ((postRangeHigh / postRangeLow) - 1) * 100
      : null;
  let consecutiveBoards = 0;
  if (Number.isInteger(eventIndex)) {
    for (let cursor = eventIndex; cursor >= 1 && isLimitUpAt(history, cursor, code, name); cursor -= 1) {
      consecutiveBoards += 1;
    }
  }
  const previousLimitIndex =
    limitIndices.length >= 2 ? limitIndices[limitIndices.length - 2] : null;
  const daysBetweenLimits =
    Number.isInteger(eventIndex) && Number.isInteger(previousLimitIndex)
      ? eventIndex - previousLimitIndex
      : null;
  const previousLimit = Number.isInteger(previousLimitIndex)
    ? history[previousLimitIndex]
    : null;
  const priorLimitCount60 = Number.isInteger(eventIndex)
    ? limitIndices.filter(
      (limitIndex) =>
        limitIndex < eventIndex &&
        limitIndex >= Math.max(1, eventIndex - 60) &&
        limitIndex < eventIndex - 1
    ).length
    : null;
  const ma5 = meanClose(history, index, 5);
  const ma10 = meanClose(history, index, 10);
  const ma20 = meanClose(history, index, 20);
  const previousMa5 = meanClose(history, index - 3, 5);
  const priorDayMa10 = meanClose(history, index - 1, 10);
  const preEventClose =
    Number.isInteger(eventIndex) && eventIndex >= 1
      ? Number(history[eventIndex - 1]?.close)
      : null;
  const eventGapPercent =
    event && preEventClose
      ? ((Number(event.open) / preEventClose) - 1) * 100
      : null;
  const gapHeld =
    event &&
    preEventClose &&
    eventGapPercent >= 1 &&
    recentRows.length > 1
      ? Math.min(...recentRows.map((row) => Number(row.low))) >= preEventClose * 1.001
      : false;
  const currentReturn =
    Number(previous?.close) > 0
      ? ((Number(current.close) / Number(previous.close)) - 1) * 100
      : null;
  const return3 =
    index >= 3 && Number(history[index - 3]?.close) > 0
      ? ((Number(current.close) / Number(history[index - 3].close)) - 1) * 100
      : null;
  const lastThreeVolume = volumeAverage(history, index - 2, index + 1);
  const priorTenVolume = volumeAverage(history, index - 12, index - 2);
  const threeDayVolumeRatio =
    lastThreeVolume && priorTenVolume ? lastThreeVolume / priorTenVolume : null;
  const touchesMa10 =
    ma10 &&
    Number(current.low) <= ma10 * 1.02 &&
    Number(current.low) >= ma10 * 0.965 &&
    Number(current.close) >= ma10;
  const ma10Reclaim =
    ma10 &&
    priorDayMa10 &&
    Number(previous.close) < priorDayMa10 &&
    Number(current.close) >= ma10;
  const eventRange =
    event ? Number(event.high) - Number(event.low) : null;
  const eventLowerShadowRatio =
    event && eventRange > 0
      ? (Math.min(Number(event.open), Number(event.close)) - Number(event.low)) /
        eventRange
      : null;
  const originBreakout =
    isCurrentLimit &&
    consecutiveBoards === 1 &&
    preLimitRows.length >= 15 &&
    boxWidth !== null &&
    boxWidth <= 18 &&
    Number(current.close) >= Number(preBoxHigh) * 0.995 &&
    eventVolumeRatio !== null &&
    eventVolumeRatio >= 0.9 &&
    eventVolumeRatio <= 3.5 &&
    (preLimitReturn20 === null || preLimitReturn20 <= 15);
  const vcpCompression =
    daysSinceLimit !== null &&
    daysSinceLimit >= 3 &&
    daysSinceLimit <= 12 &&
    postRows.length >= 3 &&
    heldSupport === true &&
    postVolumeRatio !== null &&
    postVolumeRatio <= 0.78 &&
    postVolatility !== null &&
    preVolatility !== null &&
    postVolatility <= preVolatility * 0.9 &&
    maxDrawdownSinceLimit >= -12;
  const secondBreakout =
    daysSinceLimit !== null &&
    daysSinceLimit >= 3 &&
    daysSinceLimit <= 15 &&
    postHigh !== null &&
    Number(current.close) > postHigh * 1.001 &&
    volumeRatio !== null &&
    volumeRatio >= 1.05 &&
    volumeRatio <= 2.5 &&
    heldSupport === true;
  const reclaimedEventClose =
    event &&
    Number(previous.close) < Number(event.close) &&
    Number(current.close) >= Number(event.close);
  const lowOpenRecovery =
    Number(current.open) < Number(previous.close) &&
    Number(current.close) > Number(previous.high);
  const weakToStrong =
    daysSinceLimit !== null &&
    daysSinceLimit >= 1 &&
    daysSinceLimit <= 10 &&
    heldSupport === true &&
    Number(current.close) > Number(current.open) &&
    closePosition >= 0.72 &&
    (volumeRatio === null || volumeRatio <= 2) &&
    Boolean(reclaimedEventClose || lowOpenRecovery);
  const trendFirstBoard =
    isCurrentLimit &&
    consecutiveBoards === 1 &&
    Boolean(ma5 && ma10 && ma20 && ma5 > ma10 && ma10 > ma20) &&
    Boolean(ma5 && previousMa5 && ma5 > previousMa5) &&
    eventVolumeRatio !== null &&
    eventVolumeRatio >= 0.8 &&
    eventVolumeRatio <= 2.8 &&
    (preLimitReturn20 === null ||
      (preLimitReturn20 >= -10 && preLimitReturn20 <= 20));
  const lowVolumeFirstBoard =
    isCurrentLimit &&
    consecutiveBoards === 1 &&
    eventVolumeRatio !== null &&
    eventVolumeRatio >= 0.5 &&
    eventVolumeRatio <= 1.08 &&
    Boolean(ma20 && Number(current.close) > ma20) &&
    (preLimitReturn20 === null || preLimitReturn20 <= 18);
  const limitGapHold =
    daysSinceLimit !== null &&
    daysSinceLimit >= 1 &&
    daysSinceLimit <= 8 &&
    gapHeld === true &&
    Number(current.close) >= Number(event.close) * 0.97 &&
    heldSupport === true &&
    (postVolumeRatio === null || postVolumeRatio <= 1);
  const limitMa10Pullback =
    daysSinceLimit !== null &&
    daysSinceLimit >= 2 &&
    daysSinceLimit <= 15 &&
    touchesMa10 === true &&
    heldSupport === true &&
    closePosition >= 0.55 &&
    (volumeRatio === null || volumeRatio <= 1.35);
  const volumeDryupRebound =
    daysSinceLimit !== null &&
    daysSinceLimit >= 2 &&
    daysSinceLimit <= 12 &&
    heldSupport === true &&
    postVolumeRatio !== null &&
    postVolumeRatio <= 0.68 &&
    Number(current.close) > Number(current.open) &&
    closePosition >= 0.65 &&
    (volumeRatio === null || volumeRatio <= 1.15);
  const doubleLimitRelay =
    isCurrentLimit &&
    consecutiveBoards === 1 &&
    daysBetweenLimits !== null &&
    daysBetweenLimits >= 3 &&
    daysBetweenLimits <= 20 &&
    previousLimit &&
    Number(current.close) > Number(previousLimit.close) &&
    Math.min(...history.slice(previousLimitIndex, index + 1).map(row => Number(row.low))) >= Number(previousLimit.low) * 0.95 &&
    eventVolumeRatio !== null &&
    eventVolumeRatio >= 0.75 &&
    eventVolumeRatio <= 3.2;
  const highTightFlag =
    daysSinceLimit !== null &&
    daysSinceLimit >= 2 &&
    daysSinceLimit <= 12 &&
    postRows.length >= 2 &&
    postRangePercent !== null &&
    postRangePercent <= 8 &&
    postVolumeRatio !== null &&
    postVolumeRatio <= 0.85 &&
    Number(current.close) >= Number(event.close) * 0.96 &&
    heldSupport === true &&
    Boolean(ma5 && ma10 && ma5 >= ma10);
  const maReclaimAfterLimit =
    daysSinceLimit !== null &&
    daysSinceLimit >= 2 &&
    daysSinceLimit <= 15 &&
    ma10Reclaim === true &&
    heldSupport === true &&
    Number(current.close) > Number(current.open) &&
    closePosition >= 0.62 &&
    (volumeRatio === null || volumeRatio <= 1.8);
  const longLowerShadowLimit =
    isCurrentLimit &&
    eventLowerShadowRatio !== null &&
    eventLowerShadowRatio >= 0.25 &&
    Number(current.open) < Number(current.close) * 0.995 &&
    closePosition >= 0.95 &&
    eventVolumeRatio !== null &&
    eventVolumeRatio >= 1.1 &&
    eventVolumeRatio <= 3;

  const volumeReboundHold = volumeReboundHoldAt(history, index);
  const youzi = youziPatternsAt(history, index, code, name);
  const result = {
    firstNegativeReclaim: Boolean(youzi.firstNegativeReclaim),
    brokenBoardWeakToStrong: Boolean(youzi.brokenBoardWeakToStrong),
    firstToSecondBoard: Boolean(youzi.firstToSecondBoard),
    dragonPullback: Boolean(youzi.dragonPullback),
    youziDetail: youzi,
    date: current.date,
    latest: Number(current.close),
    volumeReboundHold: volumeReboundHold.passed === true,
    volumeReboundHoldDetail: volumeReboundHold.passed ? volumeReboundHold : null,
    isCurrentLimit,
    eventIndex,
    eventDate: event?.date || "",
    eventLow: event ? Number(event.low) : null,
    daysSinceLimit,
    previousLimitIndex,
    daysBetweenLimits,
    consecutiveBoards,
    priorLimitCount60,
    preLimitReturn20,
    preLimitPosition: Number.isInteger(eventIndex) ? selectionRules.preLimitRangePosition(history, eventIndex) : null,
    preBoxHigh,
    preBoxLow,
    boxWidth,
    eventVolumeRatio,
    volumeRatio,
    postVolumeRatio,
    preVolatility,
    postVolatility,
    postRangePercent,
    closePosition,
    eventGapPercent,
    gapHeld,
    currentReturn,
    return3,
    threeDayVolumeRatio,
    touchesMa10,
    ma10Reclaim,
    eventLowerShadowRatio,
    heldSupport,
    maxDrawdownSinceLimit,
    ma5,
    ma10,
    ma20,
    maBull: Boolean(ma5 && ma10 && ma20 && ma5 > ma10 && ma10 > ma20),
    ma5SlopeUp: Boolean(ma5 && previousMa5 && ma5 > previousMa5),
    originBreakout,
    vcpCompression,
    secondBreakout,
    weakToStrong,
    trendFirstBoard,
    lowVolumeFirstBoard,
    limitGapHold,
    limitMa10Pullback,
    volumeDryupRebound,
    doubleLimitRelay,
    highTightFlag,
    maReclaimAfterLimit,
    longLowerShadowLimit,
    riskVeto:
      heldSupport !== false &&
      (volumeRatio === null || volumeRatio <= 3) &&
      !(closePosition < 0.25 && volumeRatio !== null && volumeRatio > 1.5)
  };
  // 实测过热指标与低位判断（strategy-field-rules）：只用到 index 及之前的日线。
  result.ma20ExtensionPercent = ma20 ? (Number(current.close) / ma20 - 1) * 100 : null;
  const close60 = index >= 60 ? Number(history[index - 60]?.close) : null;
  result.return60Percent = close60 > 0 ? (Number(current.close) / close60 - 1) * 100 : null;
  const overheat = fieldRules.overheatAssessment(result);
  result.overheatFlags = overheat.flags;
  result.overheatCount = overheat.count;
  result.overheatVeto = overheat.veto;
  result.lowPositionBoard = isCurrentLimit && consecutiveBoards === 1 && fieldRules.isLowPositionBoard(result);
  Object.assign(result, bottomTrendFeatures(history, index, limitIndices, ma10, priorDayMa10, volumeRatio));
  result.securityCode = String(code || "");
  result.latestAmount = finite(current.amount) ? Number(current.amount) : null;
  result.onePriceToday = Boolean(isCurrentLimit && Number(current.high) === Number(current.low));
  const prepared = combinationTimeline || priceSafeCombinationTimeline(history, code, name);
  return withLegacyFactors(signalCombinations.attachCombinationEvidence(result, prepared[index]), history, index, code, name);
}

/**
 * Custom strategies read the 个股分析 daily factors. They are computed lazily
 * (only when a custom strategy asks) from the same bars up to `index`, and
 * kept non-enumerable so snapshots, spreads and reports are unchanged.
 */
function withLegacyFactors(feature, history, index, code, name) {
  if (!feature || typeof feature !== "object") return feature;
  let cached;
  Object.defineProperty(feature, "legacyFactors", {
    configurable: true, enumerable: false,
    get() {
      if (cached === undefined) {
        // Legacy factors allow an event up to 59 sessions old. Validate its
        // own pre-event range only when a user strategy actually reads them.
        let eventIndex = -1;
        for (let i = index; i >= Math.max(1, index - 59); i--) {
          if (isLimitUpAt(history, i, code, name)) { eventIndex = i; break; }
        }
        const start = Math.max(1, eventIndex - selectionRules.LOW_POSITION.lookback + 1);
        cached = eventIndex >= 0 && intervalPriceBasisIssue(history, start, index, code, name)
          ? null : legacyFactorSnapshot(history, index, code, name);
      }
      return cached;
    }
  });
  return feature;
}

/**
 * Calculate the daily feature snapshots for one security once. The
 * visible limit-up index list grows with the day, so a snapshot can never see
 * a future limit-up event while the full history is being prepared up front.
 */
function priceSafeCombinationTimeline(history, code, name, benchmark = []) {
  const timeline = [];
  let start = 0;
  // EMA/SMA and cumulative OBV otherwise retain pre-break prices indefinitely.
  // Restart at the new basis, retaining the same periods and warm-up gates.
  for (let index = 1; index <= history.length; index++) {
    if (index < history.length && !priceBasisIssueAt(history, index, code, name)) continue;
    timeline.push(...signalCombinations.prepareCombinationTimeline(history.slice(start, index), code, name, benchmark));
    start = index;
  }
  return timeline;
}

function buildFeatureTimeline(history, code, name, benchmark = []) {
  const timeline = new Array(history.length).fill(null);
  const combinationTimeline = priceSafeCombinationTimeline(history, code, name, benchmark);
  const allLimitIndices = detectLimitIndices(history, code, name);
  const visibleLimitIndices = [];
  let limitCursor = 0;
  for (let index = 0; index < history.length; index += 1) {
    while (
      limitCursor < allLimitIndices.length &&
      allLimitIndices[limitCursor] <= index
    ) {
      visibleLimitIndices.push(allLimitIndices[limitCursor]);
      limitCursor += 1;
    }
    timeline[index] = featureSnapshot(
      history,
      index,
      code,
      name,
      visibleLimitIndices,
      combinationTimeline
    );
  }
  return timeline;
}

function candidateIdentity(candidate, fallbackCode = "") {
  const quote = candidate?.quote || {};
  const security = candidate?.security || {};
  const rawCode =
    candidate?.code ??
    candidate?.symbol ??
    quote?.code ??
    security?.code ??
    fallbackCode;
  const codeMatch = String(rawCode || "").match(/\d{6}/);
  const code = codeMatch ? codeMatch[0] : String(rawCode || "");
  return {
    code,
    name: String(candidate?.name ?? quote?.name ?? security?.name ?? code),
    industry: String(
      candidate?.industry ??
      candidate?.sector ??
      quote?.industry ??
      candidate?.concept ??
      ""
    )
  };
}

function historyEntries(historiesByCode) {
  if (historiesByCode instanceof Map) return [...historiesByCode.entries()];
  if (!historiesByCode || typeof historiesByCode !== "object") return [];
  return Object.entries(historiesByCode);
}

function historyForCode(historiesByCode, code) {
  if (historiesByCode instanceof Map) {
    return historiesByCode.get(code) ?? historiesByCode.get(String(code));
  }
  if (!historiesByCode || typeof historiesByCode !== "object") return undefined;
  return (
    historiesByCode[code] ??
    historiesByCode[String(code)] ??
    historiesByCode[`${code}.SH`] ??
    historiesByCode[`${code}.SZ`] ??
    historiesByCode[`${code}.BJ`]
  );
}

function candidateAnalysis(candidate) {
  return {
    ...(candidate?.quote?.analysis || {}),
    ...(candidate?.analysis || {})
  };
}

function enhanceCurrentFeature(baseFeature, candidate, _code, _name) {
  const analysis = candidateAnalysis(candidate);
  const changePct = numberOrNull(
    candidate?.changePct,
    candidate?.changePercent,
    candidate?.pctChange,
    candidate?.quote?.changePct,
    candidate?.quote?.changePercent
  );
  const tradingDaysSince = numberOrNull(candidate?.tradingDaysSince);
  const poolSaysCurrentLimit =
    candidate?.isLimitUp === true ||
    candidate?.limitUp === true ||
    tradingDaysSince === 0;
  const explicitHeldSupport =
    typeof analysis.heldSupport === "boolean"
      ? analysis.heldSupport
      : typeof candidate?.heldSupport === "boolean"
        ? candidate.heldSupport
        : null;
  const feature = {
    ...(baseFeature || {}),
    date:
      baseFeature?.date ||
      normalizeDate(candidate?.date ?? candidate?.tradeDate ?? candidate?.limitDate),
    latest: numberOrNull(
      candidate?.latest,
      candidate?.price,
      candidate?.close,
      candidate?.quote?.latest,
      candidate?.quote?.close,
      baseFeature?.latest
    ),
    changePct,
    isCurrentLimit: Boolean(baseFeature?.isCurrentLimit || poolSaysCurrentLimit),
    daysSinceLimit: numberOrNull(
      baseFeature?.daysSinceLimit,
      tradingDaysSince,
      analysis.daysSinceLimit
    ),
    consecutiveBoards: numberOrNull(
      candidate?.consecutiveBoards,
      candidate?.limitStats?.consecutiveBoards,
      baseFeature?.consecutiveBoards
    ),
    priorLimitCount60: numberOrNull(
      analysis.eventCount60,
      candidate?.limitStats?.count !== undefined
        ? Math.max(0, Number(candidate.limitStats.count) - 1)
        : null,
      baseFeature?.priorLimitCount60
    ),
    preLimitReturn20: numberOrNull(
      analysis.preLimitReturn20,
      candidate?.preLimitReturn20,
      baseFeature?.preLimitReturn20
    ),
    boxWidth: numberOrNull(analysis.boxWidth, candidate?.boxWidth, baseFeature?.boxWidth),
    eventVolumeRatio: numberOrNull(
      analysis.limitVolumeRatio,
      candidate?.limitVolumeRatio,
      baseFeature?.eventVolumeRatio
    ),
    volumeRatio: numberOrNull(
      analysis.volumeRatio,
      candidate?.volumeRatio,
      baseFeature?.volumeRatio
    ),
    postVolumeRatio: numberOrNull(
      analysis.postVolumeRatio,
      candidate?.postVolumeRatio,
      baseFeature?.postVolumeRatio
    ),
    postRangePercent: numberOrNull(
      analysis.postRangePercent,
      candidate?.postRangePercent,
      baseFeature?.postRangePercent
    ),
    closePosition: numberOrNull(
      analysis.closePosition,
      candidate?.closePosition,
      baseFeature?.closePosition
    ),
    eventGapPercent: numberOrNull(
      analysis.eventGapPercent,
      candidate?.eventGapPercent,
      baseFeature?.eventGapPercent
    ),
    daysBetweenLimits: numberOrNull(
      analysis.daysBetweenLimits,
      candidate?.daysBetweenLimits,
      baseFeature?.daysBetweenLimits
    ),
    threeDayVolumeRatio: numberOrNull(
      analysis.threeDayVolumeRatio,
      candidate?.threeDayVolumeRatio,
      baseFeature?.threeDayVolumeRatio
    ),
    eventLowerShadowRatio: numberOrNull(
      analysis.eventLowerShadowRatio,
      candidate?.eventLowerShadowRatio,
      baseFeature?.eventLowerShadowRatio
    ),
    gapHeld:
      analysis.gapHeld === false
        ? false
        : baseFeature?.gapHeld ?? null,
    heldSupport:
      explicitHeldSupport === false
        ? false
        : baseFeature?.heldSupport ?? null,
    maxDrawdownSinceLimit: numberOrNull(
      analysis.maxDrawdown,
      candidate?.maxDrawdownSinceLimit,
      baseFeature?.maxDrawdownSinceLimit
    ),
    originBreakout: baseFeature?.originBreakout === true,
    vcpCompression: baseFeature?.vcpCompression === true,
    secondBreakout: baseFeature?.secondBreakout === true,
    weakToStrong: baseFeature?.weakToStrong === true,
    trendFirstBoard: baseFeature?.trendFirstBoard === true,
    lowVolumeFirstBoard: baseFeature?.lowVolumeFirstBoard === true,
    limitGapHold: baseFeature?.limitGapHold === true,
    limitMa10Pullback: baseFeature?.limitMa10Pullback === true,
    volumeDryupRebound: baseFeature?.volumeDryupRebound === true,
    volumeReboundHold: baseFeature?.volumeReboundHold === true,
    volumeReboundHoldDetail: baseFeature?.volumeReboundHoldDetail ?? null,
    firstNegativeReclaim: baseFeature?.firstNegativeReclaim === true,
    brokenBoardWeakToStrong: baseFeature?.brokenBoardWeakToStrong === true,
    firstToSecondBoard: baseFeature?.firstToSecondBoard === true,
    dragonPullback: baseFeature?.dragonPullback === true,
    youziDetail: baseFeature?.youziDetail ?? null,
    doubleLimitRelay: baseFeature?.doubleLimitRelay === true,
    highTightFlag: baseFeature?.highTightFlag === true,
    maReclaimAfterLimit: baseFeature?.maReclaimAfterLimit === true,
    longLowerShadowLimit: baseFeature?.longLowerShadowLimit === true,
    lowFirstBoard: baseFeature?.lowFirstBoard === true,
    matchSource: baseFeature ? "ohlcv" : "missing_ohlcv",
    riskVeto:
      analysis.riskVeto === false || candidate?.riskVeto === false
        ? false
        : baseFeature?.riskVeto ?? explicitHeldSupport !== false
  };
  return feature;
}

/**
 * 低位首板 v1.3.0（2026-10-27 按全A实测改写）：当日首板，涨停收盘距 MA20 不超过 5%，近 60 日涨幅不为正。
 * 旧版（近60日无重复涨停 + 板前20日涨幅 -25%～15% + 板前位于100日区间下方60%）实测 5 日平均 -0.85%，
 * 六年里五年为负；新版同口径 +1.0%（2021–2023）/ +2.4%（2024–2026），次日开盘一字涨停买不到的约 4%。
 * 两个阈值都需要可计算：不足 60 个交易日或缺 MA20 时不判为低位。
 */
/** 信号日必然是涨停日的策略：过热否决对它们不起作用（涨停日本身不计过热），版本号不因此变动。 */
const LIMIT_DAY_ONLY_STRATEGIES = new Set(["low_first_board", "bottom_deep_first_board", "platform_breakout", "trend_first_board", "low_volume_first_board",
  "double_limit_relay", "long_lower_shadow_limit", "first_board_quality_resonance", "n_relay_resonance",
  // 游资打法本身就是追强（反包、弱转强当天必然“过热”），按原打法不套用过热否决；版本号自带。
  "youzi_first_negative_reclaim", "youzi_broken_board_weak_to_strong", "youzi_first_to_second_board", "youzi_dragon_pullback"]);

function isLowFirstBoard(feature) {
  if (feature.lowFirstBoard) return true;
  const boards = Number(feature.consecutiveBoards);
  return (
    feature.isCurrentLimit === true &&
    Number.isFinite(boards) &&
    boards === 1 &&
    fieldRules.isLowPositionBoard(feature) &&
    feature.heldSupport !== false
  );
}

const RAW_STRATEGY_DEFINITIONS = Object.freeze([
  {
    id: "low_first_board",
    name: "低位首板",
    version: "1.3.0",
    detail: "下跌或横盘之后的第一个涨停：涨停收盘距20日均线不超过5%，近60日涨幅不为正。",
    conditions: ["当日首板", `涨停收盘不高于MA20的${100 + fieldRules.LOW_FIRST_BOARD.maxMa20ExtensionPercent}%`, "近60个交易日涨幅不为正"],
    risk: "超跌后的首板也可能只是一日反抽；次日高开过多时不追，跌破涨停日最低价即视为失败。",
    parameters: fieldRules.LOW_FIRST_BOARD,
    adaptationNote: "v1.3.0（2026-10-27）：“低位”改为按涨停收盘相对MA20的位置和近60日涨幅判断，取代旧版的板前20日涨幅与100日区间位置。",
    matches: (feature) => isLowFirstBoard(feature) && feature.riskVeto !== false,
    reasons: (feature) => [
      "下跌或横盘后的首个涨停",
      finite(feature.ma20ExtensionPercent) ? `涨停收盘距MA20 ${round(feature.ma20ExtensionPercent, 1)}%` : "",
      finite(feature.return60Percent) ? `近60日涨幅 ${round(feature.return60Percent, 1)}%` : ""
    ].filter(Boolean)
  },
  {
    id: "bottom_deep_first_board",
    name: "深跌底部首板",
    version: "1.0.0",
    detail: "低位首板里跌得最深的一类：涨停当天收盘仍低于60日均线15%以上。",
    conditions: ["当日首板", "符合低位首板：涨停收盘不高于MA20的105%，近60日涨幅不为正", `涨停收盘低于MA60至少${-BOTTOM_TREND.deepMa60GapPercent}%`],
    risk: "深跌股的首板常在大盘见底时成批出现，单只的持续性取决于后续能否企稳；次日高开过多不追，跌破涨停日最低价视为失败。",
    parameters: { deepMa60GapPercent: BOTTOM_TREND.deepMa60GapPercent },
    adaptationNote: "v1.0.0（2026-11-03）：全A实测，底部首板离60日线越远，之后20日相对同日涨停股池越强，两段年份一致。",
    matches: (feature) => isLowFirstBoard(feature) && feature.bottomBoardDays === 0 && finite(feature.ma60GapPercent) && feature.ma60GapPercent <= BOTTOM_TREND.deepMa60GapPercent,
    reasons: (feature) => ["深跌后的首个涨停", ...bottomReasons(feature).slice(1)]
  },
  {
    id: "bottom_board_pullback",
    name: "深跌首板后缩量回踩",
    version: "1.0.0",
    detail: "深跌后出现底部首板，1至10天内缩量回落到10日线下方，仍在60日线下方15%以外；等回踩低吸，不追高。",
    conditions: ["1至10个交易日前出现底部首板，之后没有再涨停", "收盘不高于MA10", `量比不超过${BOTTOM_TREND.pullbackMaxVolumeRatio}`, `收盘低于MA60至少${-BOTTOM_TREND.deepMa60GapPercent}%`],
    risk: "回踩可能演变成继续下跌；跌破底部首板最低价后要降低预期，反弹需重新放量确认。",
    parameters: { window: BOTTOM_TREND.pullbackWindow, maxVolumeRatio: BOTTOM_TREND.pullbackMaxVolumeRatio, deepMa60GapPercent: BOTTOM_TREND.deepMa60GapPercent },
    adaptationNote: "v1.0.0（2026-11-03）：全A实测，深跌底部首板之后缩量回到10日线下方的，20日相对同日涨停股池平均高4.9个百分点，六年均为正。",
    matches: (feature) => inWindow(feature.bottomBoardDays, BOTTOM_TREND.pullbackWindow) && quietSinceBottom(feature) &&
      finite(feature.ma10GapPercent) && feature.ma10GapPercent <= 0 && finite(feature.bottomVolumeRatio) && feature.bottomVolumeRatio <= BOTTOM_TREND.pullbackMaxVolumeRatio &&
      finite(feature.ma60GapPercent) && feature.ma60GapPercent <= BOTTOM_TREND.deepMa60GapPercent,
    reasons: (feature) => ["底部首板后缩量回踩10日线", ...bottomReasons(feature), finite(feature.bottomVolumeRatio) ? `量比 ${round(feature.bottomVolumeRatio, 2)}` : ""].filter(Boolean)
  },
  {
    id: "bottom_quiet_board_follow",
    name: "底部温和首板后承接",
    version: "1.0.0",
    detail: "底部首板当天没有放出巨量（量比不超过1.2），1至10天内股价仍在60日线下方15%以外，等承接跟进。",
    conditions: ["1至10个交易日前出现底部首板，之后没有再涨停", `底部首板当天量比不超过${BOTTOM_TREND.quietBoardVolumeRatio}`, `收盘低于MA60至少${-BOTTOM_TREND.deepMa60GapPercent}%`],
    risk: "温和放量说明抛压不重，但也可能只是成交清淡；流动性差的股票进出要控制仓位。",
    parameters: { window: BOTTOM_TREND.pullbackWindow, quietBoardVolumeRatio: BOTTOM_TREND.quietBoardVolumeRatio, deepMa60GapPercent: BOTTOM_TREND.deepMa60GapPercent },
    adaptationNote: "v1.0.0（2026-11-03）：全A实测，底部首板量比越小后续越强；按信号日等权计算也为正，六年均为正。",
    matches: (feature) => inWindow(feature.bottomBoardDays, BOTTOM_TREND.pullbackWindow) && quietSinceBottom(feature) &&
      finite(feature.bottomBoardVolumeRatio) && feature.bottomBoardVolumeRatio <= BOTTOM_TREND.quietBoardVolumeRatio &&
      finite(feature.ma60GapPercent) && feature.ma60GapPercent <= BOTTOM_TREND.deepMa60GapPercent,
    reasons: (feature) => ["底部温和放量首板后承接", ...bottomReasons(feature), finite(feature.bottomBoardVolumeRatio) ? `首板量比 ${round(feature.bottomBoardVolumeRatio, 2)}` : ""].filter(Boolean)
  },
  {
    id: "bottom_ma10_reclaim",
    name: "深跌首板后收复10日线",
    version: "1.0.0",
    detail: "底部首板后3至15天，股价由10日线下方重新站上10日线，离60日线仍有10%以上空间：趋势重新启动的位置。",
    conditions: ["3至15个交易日前出现底部首板，之后没有再涨停", "前一日收盘在MA10下方，当日收盘站上MA10", `收盘低于MA60至少${-BOTTOM_TREND.reclaimMa60GapPercent}%`],
    risk: "收复10日线后若很快再跌破，说明反弹乏力；跌破底部首板最低价视为失败。",
    parameters: { window: BOTTOM_TREND.reclaimWindow, ma60GapPercent: BOTTOM_TREND.reclaimMa60GapPercent },
    adaptationNote: "v1.0.0（2026-11-03）：全A实测，底部首板后重新站上10日线的，20日相对同日涨停股池平均高3.5个百分点，六年均为正。",
    matches: (feature) => inWindow(feature.bottomBoardDays, BOTTOM_TREND.reclaimWindow) && quietSinceBottom(feature) && feature.bottomMa10Reclaim === true &&
      finite(feature.ma60GapPercent) && feature.ma60GapPercent <= BOTTOM_TREND.reclaimMa60GapPercent,
    reasons: (feature) => ["底部首板后重新站上10日线", ...bottomReasons(feature)]
  },
  {
    id: "board_streak_quiet_pullback",
    name: "连板后缩量回调",
    version: "1.0.0",
    detail: "2板及以上的连板结束后3至10天，成交明显缩小（日均量不到涨停日的60%），且始终守住涨停日最低价：强势股缩量洗盘、等承接。",
    conditions: [`最近一次涨停为${STREAK_PULLBACK.minBoards}连板及以上，${STREAK_PULLBACK.window[0]}至${STREAK_PULLBACK.window[1]}个交易日前，之后没有再涨停`,
      `涨停后日均成交量不到涨停日的${Math.round(STREAK_PULLBACK.maxPostVolumeRatio * 100)}%`, "涨停后最低价始终不低于涨停日最低价"],
    risk: "缩量也可能是资金离场；放量跌破涨停日最低价视为失败。缩量越明显，实测越好。",
    parameters: { windowStart: STREAK_PULLBACK.window[0], windowEnd: STREAK_PULLBACK.window[1], minBoards: STREAK_PULLBACK.minBoards, maxPostVolumeRatio: STREAK_PULLBACK.maxPostVolumeRatio },
    adaptationNote: "v1.0.0（2026-11-05）：全A日线回放（次日开盘买入），相对同期近15日涨停股基线，5/10/20日在2021–2023与2024–2026两段都更好；阈值附近（2–8/3–12天、量比0.5–0.7）同样成立。",
    matches: (feature) => feature.isCurrentLimit !== true && inWindow(feature.daysSinceLimit, STREAK_PULLBACK.window) &&
      Number(feature.consecutiveBoards) >= STREAK_PULLBACK.minBoards && feature.heldSupport === true &&
      finite(feature.postVolumeRatio) && feature.postVolumeRatio < STREAK_PULLBACK.maxPostVolumeRatio && feature.riskVeto !== false,
    reasons: (feature) => [
      `${feature.consecutiveBoards}连板后第${feature.daysSinceLimit}天缩量回调`,
      finite(feature.postVolumeRatio) ? `日均量为涨停日的${Math.round(feature.postVolumeRatio * 100)}%` : "",
      "守住涨停日最低价"
    ].filter(Boolean)
  },
  {
    id: "platform_breakout",
    name: "平台突破首板",
    detail: "窄幅平台上沿被首板突破，同时约束板前位置与涨停日放量。",
    conditions: ["板前平台宽度不超过18%", "涨停突破平台上沿", "涨停日量比0.9至3.5"],
    risk: "平台可能是假突破；次日若跌回平台上沿下方，突破逻辑即失效。",
    matches: (feature) => feature.originBreakout === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "涨停突破板前平台上沿",
      finite(feature.boxWidth)
        ? `平台宽度 ${round(feature.boxWidth, 1)}%`
        : "平台结构已确认"
    ]
  },
  {
    id: "vcp_compression",
    name: "涨停后量价收缩",
    detail: "涨停后3至12日波动和成交同步收缩，且始终守住涨停日低点。",
    conditions: ["涨停后3至12日", "量能缩至涨停日的78%以内", "波动收缩且支撑有效"],
    risk: "缩量也可能代表资金撤离；跌破涨停日低点时必须视为形态失败。",
    matches: (feature) => feature.vcpCompression === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "涨停后量价同步压缩",
      finite(feature.postVolumeRatio)
        ? `整理期量能/涨停日 ${round(feature.postVolumeRatio, 2)}x`
        : "缩量结构已确认"
    ]
  },
  {
    id: "second_breakout",
    name: "涨停后二次突破",
    detail: "涨停后3至15日突破整理高点，量比适中且支撑未失效。",
    conditions: ["涨停后3至15日", "收盘突破此前整理高点", "当日量比1.05至2.5"],
    risk: "二次突破容易出现冲高回落，过度放量或尾盘回落会削弱有效性。",
    matches: (feature) => feature.secondBreakout === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "放量突破涨停后整理高点",
      finite(feature.volumeRatio)
        ? `当日量比 ${round(feature.volumeRatio, 2)}x`
        : "突破量价结构已确认"
    ]
  },
  {
    id: "weak_to_strong",
    name: "弱转强修复",
    detail: "近期涨停股低开回收或重新站回涨停收盘价，收盘位置强且量能不过热。",
    conditions: ["近期存在涨停事件", "低开回收或重回涨停收盘价", "收盘位于日内上部"],
    risk: "修复信号对次日情绪依赖较强，若竞价再次转弱，容易形成二次下杀。",
    matches: (feature) => feature.weakToStrong === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "弱势开盘后强势回收",
      finite(feature.closePosition)
        ? `收盘位于日内区间 ${round(feature.closePosition * 100, 0)}%`
        : "修复形态已确认"
    ]
  },
  {
    id: "trend_first_board",
    name: "多头趋势首板",
    detail: "均线多头排列且MA5继续上行时出现首板，限制板前涨幅和涨停日量能。",
    conditions: ["当日首板", "MA5高于MA10且MA10高于MA20", "涨停日量比0.8至2.8"],
    risk: "趋势末端也可能满足均线条件；板前涨幅接近上限时追高风险明显增加。",
    matches: (feature) => feature.trendFirstBoard === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "多头均线上的趋势首板",
      finite(feature.eventVolumeRatio)
        ? `涨停日量比 ${round(feature.eventVolumeRatio, 2)}x`
        : "量能处于温和区间"
    ]
  },
  {
    id: "low_volume_first_board",
    name: "低量首板",
    detail: "首板成交量不高于近5日均量约1.08倍，同时收盘位于MA20之上。",
    conditions: ["当日首板", "涨停日量比0.50至1.08", "收盘高于MA20"],
    risk: "缩量封板可能来自流动性不足；次日放量开板时承接能力难以确认。",
    matches: (feature) => feature.lowVolumeFirstBoard === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "低量能完成首板",
      finite(feature.eventVolumeRatio)
        ? `涨停日量比 ${round(feature.eventVolumeRatio, 2)}x`
        : "缩量特征已确认"
    ]
  },
  {
    id: "limit_gap_hold",
    name: "涨停高开支撑守卫",
    detail: "涨停日高开至少1%，之后1至8日最低价始终高于涨停前收盘价且量能不过热。",
    conditions: ["涨停日高开至少1%", "涨停后1至8日不回落至涨停前收盘价", "守住涨停日支撑"],
    risk: "跌回涨停前收盘支撑会破坏短期强势假设；高开本身不代表形成未回补价格缺口。",
    matches: (feature) => feature.limitGapHold === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "涨停高开的前收盘支撑保持有效",
      finite(feature.eventGapPercent)
        ? `涨停日高开 ${round(feature.eventGapPercent, 1)}%`
        : "缺口支撑已确认"
    ]
  },
  {
    id: "limit_ma10_pullback",
    name: "涨停后MA10回踩",
    detail: "涨停后2至15日缩量回踩MA10附近，当日收回均线上方且支撑未破。",
    conditions: ["涨停后2至15日", "最低价触及MA10附近", "收盘重回MA10且日内位置偏强"],
    risk: "均线支撑具有滞后性；若MA10转为下行，回踩可能演变为趋势破位。",
    matches: (feature) => feature.limitMa10Pullback === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "涨停后回踩MA10并收回",
      finite(feature.volumeRatio)
        ? `回踩日量比 ${round(feature.volumeRatio, 2)}x`
        : "回踩量能未过热"
    ]
  },
  {
    id: "volume_dryup_rebound",
    name: "涨停后缩量阳线修复",
    detail: "涨停后2至12日平均量能显著收缩，随后出现收盘靠近日内高位的阳线修复。",
    conditions: ["整理量不高于涨停日的68%", "当日阳线且收盘位置不低于65%", "涨停日支撑有效"],
    risk: "地量反弹的持续性依赖后续增量资金；没有放量确认时可能仅是弱反抽。",
    matches: (feature) => feature.volumeDryupRebound === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "地量整理后阳线修复",
      finite(feature.postVolumeRatio)
        ? `整理均量/涨停日 ${round(feature.postVolumeRatio, 2)}x`
        : "地量结构已确认"
    ]
  },
  {
    id: "volume_rebound_hold",
    version: "1.2.0",
    name: "下跌后放量大阳·次日平量",
    detail: "一段下跌后出现放量大阳反弹，次日成交量与大阳日相近，股价微涨或微跌，承接住大阳的成果。",
    conditions: [
      "大阳前处于下跌：前一日收盘较此前20日最高收盘回落至少10%",
      "大阳日涨幅≥5%、收阳且实体≥3%，成交量≥此前5日均量1.8倍",
      "信号日成交量为大阳日的0.8至1.25倍，涨跌幅在±2%以内，最低价不破大阳日最低价"
    ],
    risk: "下跌后的放量反弹可能只是超跌反抽；次日平量不涨说明分歧仍在，跌破大阳最低价即视为反弹失败。",
    parameters: VOLUME_REBOUND_HOLD,
    adaptationNote: "按用户描述的形态写成的固定规则（2026-10-23 新增）；阈值为事先指定的工程假设，未证明收益更优。“量和前天差不多”按“与大阳日相近”实现。",
    // 不用通用的涨停日支撑否决（大阳前的下跌必然破掉更早的涨停低点）；承接由“不破大阳最低价”判断。
    matches: (feature) => feature.volumeReboundHold === true,
    reasons: (feature) => {
      const detail = feature.volumeReboundHoldDetail;
      return detail ? [
        `${detail.bigYangDate} 放量大阳 ${round(detail.bigYangChangePercent, 2)}%，量为前5日均量 ${round(detail.bigYangVolumeRatio, 2)}x`,
        `此前回落 ${round(detail.declinePercent, 1)}%；信号日量为大阳日 ${round(detail.holdVolumeRatio, 2)}x，涨跌 ${round(detail.holdChangePercent, 2)}%`
      ] : ["下跌后放量大阳，次日平量微涨微跌"];
    }
  },
  {
    id: "youzi_first_negative_reclaim",
    version: "1.0.0",
    name: "首阴反包",
    detail: "游资经典打法：连续涨停至少2板后出现第一根阴线（首阴），次日阳线反包，收盘收复首阴开盘价。",
    conditions: ["此前连续涨停至少2板", "前一日为连板后的第一根阴线（未涨停、收盘低于开盘）", "当日阳线、收盘不低于首阴开盘价，涨幅至少5%"],
    risk: "反包失败会形成双阴破位；高位多次反包后的筹码松动风险大，次日不能继续走强时应离场。",
    parameters: { minStreak: YOUZI.minStreak, reclaimMinReturnPercent: YOUZI.reclaimMinReturnPercent },
    adaptationNote: "按游资通用口径写成的固定规则（2026-10-29 新增）；属主动追强打法，不套用过热否决。",
    matches: feature => feature.firstNegativeReclaim === true,
    reasons: feature => {
      const detail = feature.youziDetail?.firstNegativeReclaim;
      return detail ? [`此前${detail.streak}连板，${detail.negativeDate} 首阴`, `今日反包涨 ${round(detail.todayReturn, 2)}%`] : ["连板后首阴，次日反包"];
    }
  },
  {
    id: "youzi_broken_board_weak_to_strong",
    version: "1.0.0",
    name: "断板弱转强",
    detail: "游资经典打法：连续涨停至少2板后断板，次日竞价高开、收盘站上断板日最高价，资金重新转强。",
    conditions: ["此前连续涨停至少2板", "前一日断板（未涨停）", "当日高开，收盘不低于断板日最高价且收在日内上部70%以上"],
    risk: "断板后的转强需要板块情绪配合；高开低走跌回断板日区间即视为转强失败。",
    parameters: { minStreak: YOUZI.minStreak, minClosePosition: YOUZI.w2sMinClosePosition },
    adaptationNote: "按游资通用口径写成的固定规则（2026-10-29 新增）；属主动追强打法，不套用过热否决。",
    matches: feature => feature.brokenBoardWeakToStrong === true,
    reasons: feature => {
      const detail = feature.youziDetail?.brokenBoardWeakToStrong;
      return detail ? [`此前${detail.streak}连板，${detail.brokenDate} 断板`, `今日高开 ${round(detail.gapPercent, 2)}% 并站上断板日高点`] : ["断板后次日弱转强"];
    }
  },
  {
    id: "youzi_first_to_second_board",
    version: "1.0.0",
    name: "一进二接力",
    detail: "游资经典打法：前一日首板，今日再次封板成为2连板；两天都是换手板（非一字板），筹码有交换。",
    conditions: ["前一日首板（再前一日未涨停）", "当日涨停成为2连板", "两日都不是一字板"],
    risk: "2板是分歧最大的位置，次日不能晋级3板时回撤较快；一字加速后的接力不在此列。",
    parameters: {},
    adaptationNote: "按游资通用口径写成的固定规则（2026-10-29 新增）；信号日即涨停日。",
    matches: feature => feature.firstToSecondBoard === true,
    reasons: feature => [`${feature.youziDetail?.firstToSecondBoard?.firstBoardDate || "前一日"} 首板，今日换手晋级2板`]
  },
  {
    id: "youzi_dragon_pullback",
    version: "1.0.0",
    name: "龙回头",
    detail: "游资经典打法：近20日内出现至少3连板的龙头，从高点回调15%–40%后出现缩量阳线企稳，且回调未跌破首板启动价（只看最近一段连板；回调中每个满足条件的企稳日都会选出）。",
    conditions: ["3–20个交易日前出现至少3连板", "从连板后高点回调15%–40%，最低未跌破首板前收盘（启动价）", "当日缩量阳线（量比≤1.2）、收盘高于前一日，收在日内上部60%以上"],
    risk: "龙头回调后可能是退潮的开始；再次放量跌破回调低点时，龙回头逻辑失效。",
    parameters: { minStreak: YOUZI.dragonMinStreak, minPullbackPercent: YOUZI.dragonMinPullback, maxPullbackPercent: YOUZI.dragonMaxPullback, maxVolumeRatio: YOUZI.dragonMaxVolumeRatio },
    adaptationNote: "按游资通用口径写成的固定规则（2026-10-29 新增）；回调股会跌破涨停日低点，所以不套用涨停日支撑否决，承接改由“不破启动价”判断。",
    matches: feature => feature.dragonPullback === true,
    reasons: feature => {
      const detail = feature.youziDetail?.dragonPullback;
      return detail ? [`${detail.peakDate} 结束${detail.streak}连板，回调 ${round(detail.pullbackPercent, 1)}%`, `今日缩量阳线企稳，量比 ${round(detail.volumeRatio, 2)}`] : ["龙头回调后缩量企稳"];
    }
  },
  {
    id: "double_limit_relay",
    name: "双涨停N形接力",
    detail: "两次非连续涨停间隔3至20日，第二次涨停站上前板且未破前板主要支撑。",
    conditions: ["两次涨停间隔3至20日", "第二次为非连板涨停", "第二板收盘高于第一板"],
    risk: "二次涨停可能是高位诱多；前一涨停低点附近失守时，N形结构不再成立。",
    matches: (feature) => feature.doubleLimitRelay === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "两次涨停构成N形接力",
      finite(feature.daysBetweenLimits)
        ? `两板间隔 ${round(feature.daysBetweenLimits, 0)} 个交易日`
        : "双板间隔符合约束"
    ]
  },
  {
    id: "high_tight_flag",
    name: "涨停后高位窄幅整理",
    detail: "涨停后2至12日保持高位窄幅整理，区间宽度不超过8%且成交显著收缩。",
    conditions: ["涨停后2至12日", "整理区间宽度不超过8%", "整理均量不高于涨停日的85%"],
    risk: "高位窄幅也可能是派发；放量跌破旗形下沿时应立即否定该信号。",
    matches: (feature) => feature.highTightFlag === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "涨停后高位窄幅缩量",
      finite(feature.postRangePercent)
        ? `整理区间宽度 ${round(feature.postRangePercent, 1)}%`
        : "窄旗结构已确认"
    ]
  },
  {
    id: "ma_reclaim_after_limit",
    name: "涨停后MA10收复修复",
    detail: "涨停后2至15日一度收于MA10下方，随后阳线重新站回MA10并收在日内上部。",
    conditions: ["近期涨停后回落", "前收盘低于MA10", "当日重新站上MA10"],
    risk: "单日站回均线可能是假修复；次日重新跌回MA10下方时反转信号失效。",
    matches: (feature) => feature.maReclaimAfterLimit === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "阳线重新站回MA10",
      finite(feature.closePosition)
        ? `收盘位于日内区间 ${round(feature.closePosition * 100, 0)}%`
        : "均线反转已确认"
    ]
  },
  {
    id: "long_lower_shadow_limit",
    name: "长下影涨停封板",
    detail: "涨停日盘中曾明显下探但最终收于日内高位，且成交放大处于可控范围。",
    conditions: ["当日涨停", "下影占日内振幅至少25%", "涨停日量比1.1至3.0"],
    risk: "长下影意味着盘中分歧较大；次日若低开且不能迅速修复，抛压可能延续。",
    matches: (feature) => feature.longLowerShadowLimit === true && feature.riskVeto !== false,
    reasons: (feature) => [
      "分歧下探后收于涨停",
      finite(feature.eventLowerShadowRatio)
        ? `下影占振幅 ${round(feature.eventLowerShadowRatio * 100, 0)}%`
        : "长下影结构已确认"
    ]
  },
  {
    id: "first_board_quality_resonance",
    type: "composite",
    version: "1.3.0",
    name: "首板质量共振",
    detail: "低位首板为必要条件，并由平台突破、趋势多头或低量首板中的至少一项再次确认。",
    components: [
      "low_first_board",
      "platform_breakout",
      "trend_first_board",
      "low_volume_first_board"
    ],
    voteRule: "低位首板必须成立，另3个质量组件至少1票，总计至少2个组件同时成立",
    conditions: ["低位首板为必要票", "平台/趋势/低量首板至少一票", "所有条件使用同一信号日快照"],
    risk: "多条件共振仍无法消除次日情绪退潮风险，竞价明显转弱时不应机械追入。",
    matches: (feature) =>
      feature.riskVeto !== false &&
      isLowFirstBoard(feature) &&
      [
        feature.originBreakout,
        feature.trendFirstBoard,
        feature.lowVolumeFirstBoard
      ].filter(Boolean).length >= 1,
    reasons: (feature) => [
      "低位首板与质量因子共振",
      `辅助组件 ${
        [
          feature.originBreakout && "平台",
          feature.trendFirstBoard && "趋势",
          feature.lowVolumeFirstBoard && "缩量"
        ].filter(Boolean).join("、")
      }`
    ]
  },
  {
    id: "post_limit_contraction_resonance",
    type: "composite",
    name: "涨停后缩量共振",
    detail: "涨停后量价收缩为必要条件，并由高位窄幅整理或缩量阳线修复再次确认。",
    components: [
      "vcp_compression",
      "high_tight_flag",
      "volume_dryup_rebound"
    ],
    voteRule: "量价收缩必须成立，窄幅整理/缩量阳线修复至少1票，总计至少2个组件同时成立",
    conditions: ["量价收缩为必要票", "窄幅整理或缩量阳线修复至少一票", "涨停日支撑必须有效"],
    risk: "缩量共振可能来自参与资金减少；若整理末端未出现增量承接，突破容易失败。",
    matches: (feature) =>
      feature.riskVeto !== false &&
      feature.vcpCompression === true &&
      [feature.highTightFlag, feature.volumeDryupRebound].filter(Boolean).length >= 1,
    reasons: (feature) => [
      "涨停后波动与成交收缩条件同时成立",
      feature.highTightFlag ? "高位窄旗确认" : "地量阳线修复确认"
    ]
  },
  {
    id: "breakout_repair_resonance",
    type: "composite",
    name: "突破修复共振",
    detail: "涨停后二次突破为必要条件，同时出现弱转强或MA10反转修复。",
    components: [
      "second_breakout",
      "weak_to_strong",
      "ma_reclaim_after_limit"
    ],
    voteRule: "二次突破必须成立，弱转强/MA10反转至少1票，总计至少2个组件同时成立",
    conditions: ["二次突破为必要票", "弱转强或MA10反转至少一票", "量能不得触发风险否决"],
    risk: "突破和修复发生在同日时波动通常较高，尾盘回落会显著增加假突破概率。",
    matches: (feature) =>
      feature.riskVeto !== false &&
      feature.secondBreakout === true &&
      [feature.weakToStrong, feature.maReclaimAfterLimit].filter(Boolean).length >= 1,
    reasons: (feature) => [
      "二次突破与修复信号共振",
      feature.weakToStrong ? "弱转强确认" : "MA10反转确认"
    ]
  },
  {
    id: "n_relay_resonance",
    type: "composite",
    name: "N形接力共振",
    detail: "双涨停N形接力为必要条件，并由平台、趋势或长下影封板质量中的至少一项确认。",
    components: [
      "double_limit_relay",
      "platform_breakout",
      "trend_first_board",
      "long_lower_shadow_limit"
    ],
    voteRule: "双涨停N形必须成立，另3个封板质量组件至少1票，总计至少2个组件同时成立",
    conditions: ["双涨停N形为必要票", "平台/趋势/长下影至少一票", "第二板必须站上第一板"],
    risk: "二次接力处于更高价格区间，筹码松动或板块降温会放大高位回撤。",
    matches: (feature) =>
      feature.riskVeto !== false &&
      feature.doubleLimitRelay === true &&
      [
        feature.originBreakout,
        feature.trendFirstBoard,
        feature.longLowerShadowLimit
      ].filter(Boolean).length >= 1,
    reasons: (feature) => [
      "双涨停N形与封板质量共振",
      `质量组件 ${
        [
          feature.originBreakout && "平台",
          feature.trendFirstBoard && "趋势",
          feature.longLowerShadowLimit && "长下影"
        ].filter(Boolean).join("、")
      }`
    ]
  },
  ...signalCombinations.definitions,
  selectionRules.relativeDefinition
].map(definition => {
  const family = definition.id === "board_streak_quiet_pullback" ? "pullback" : /^youzi_/.test(definition.id) ? "youzi"
    : /^bottom_/.test(definition.id) ? "bottom_trend"
    : /first_board|platform_breakout|long_lower_shadow/.test(definition.id) ? "first_board"
    : /relay/.test(definition.id) ? "relay"
      : /breakout/.test(definition.id) ? "breakout"
        : /pullback|reclaim|gap/.test(definition.id) ? "pullback"
          : /compression|contraction|tight_flag/.test(definition.id) ? "contraction" : "repair";
  // 版本：1.6.21 加入过热否决的策略升到 1.2.0（自带版本号的在各自定义处升级）；只在涨停日出信号的不变。
  const merged = { version: LIMIT_DAY_ONLY_STRATEGIES.has(definition.id) ? "1.1.0" : "1.2.0", family, parameters: {}, sources: [], componentNames: [],
    dataRequirements: ["必要完整股票窗口及正有限成交量/额", "以独立交易日历确认已完成收盘日"],
    scope: "全市场A股（剔除ST、*ST与退市整理，含北交所）逐只按不复权日线识别涨停与形态；上市不足120个交易日或近期停牌的股票不参与",
    evidenceLevel: "自定义技术规则候选，排序分不是收益概率",
    adaptationNote: "固定规则仅用于筛选技术候选，不能证明可成交收益或收益优越性。", ...definition };
  // 过热否决（2026-10-27 实测）：信号日不是涨停日时，6项过热指标满足2项及以上不选。
  // 只在涨停日出信号的策略不受影响，版本号不变。
  const limitDayOnly = LIMIT_DAY_ONLY_STRATEGIES.has(merged.id);
  const ownMatches = merged.matches;
  return {
    ...merged,
    overheatGate: !limitDayOnly,
    ...(limitDayOnly ? {} : { conditions: [...(merged.conditions || []), `过热指标（收盘高位/当日涨超${fieldRules.OVERHEAT.maxDayReturnPercent}%/高于MA20超${fieldRules.OVERHEAT.maxMa20ExtensionPercent}%/量比超${fieldRules.OVERHEAT.maxVolumeRatio}/近60日涨停≥3次/近60日涨超${fieldRules.OVERHEAT.maxReturn60Percent}%）不超过1项`] }),
    matches: limitDayOnly ? ownMatches : (feature) => feature?.overheatVeto !== true && ownMatches(feature)
  };
}));

/**
 * 留强去弱（2026-11-05 全A日线回放，次日开盘买入，按信号日等权、相对同期近15日涨停股基线，
 * 分 2021–2023 / 2024–2026 两段看 5/10/20 日）：
 * - 精选：六个格子里至少五个跑赢基线、平均优势明显，排在策略库最前面；
 * - 下线：几乎所有格子都跑输基线，或六年可成交信号不足 100 次。下线的策略不再参与选股、不在策略库显示，
 *   但「我的策略」里已经引用它们作条件的仍可继续使用。
 */
const FEATURED_STRATEGY_IDS = new Set(["bottom_quiet_board_follow", "bottom_ma10_reclaim", "bottom_deep_first_board", "bottom_board_pullback",
  "board_streak_quiet_pullback", "volume_rebound_hold", "limit_gap_hold"]);
const RETIRED_STRATEGY_IDS = new Set(["low_first_board", "platform_breakout", "second_breakout", "trend_first_board", "low_volume_first_board",
  "limit_ma10_pullback", "youzi_first_negative_reclaim", "youzi_broken_board_weak_to_strong", "youzi_first_to_second_board", "youzi_dragon_pullback",
  "double_limit_relay", "long_lower_shadow_limit", "breakout_repair_resonance", "n_relay_resonance", "limit_macd_pullback_resonance",
  "limit_boll_breakout_resonance", "limit_obv_breakout_resonance", "limit_dmi_reclaim_resonance", "limit_kdj_dryup_resonance",
  "limit_rsi_pullback_resonance", "limit_cci_breakout_resonance", "limit_mfi_pullback_resonance", "limit_cci_roc_resonance", "relative_strength_pullback"]);
const RETIRED_STRATEGY_DEFINITIONS = Object.freeze(RAW_STRATEGY_DEFINITIONS.filter(definition => RETIRED_STRATEGY_IDS.has(definition.id)).map(definition => ({ ...definition, retired: true })));
/** 策略选股用的在用策略：精选排在前面，其余保持原顺序。 */
const STRATEGY_DEFINITIONS = Object.freeze(RAW_STRATEGY_DEFINITIONS.filter(definition => !RETIRED_STRATEGY_IDS.has(definition.id))
  .map(definition => FEATURED_STRATEGY_IDS.has(definition.id) ? { ...definition, featured: true } : definition)
  .sort((a, b) => Number(b.featured === true) - Number(a.featured === true)));
/** 完整策略库（回测中心、历史回放、我的策略的条件）：在用的在前，已下线的标 retired 排在后面。 */
const ALL_STRATEGY_DEFINITIONS = Object.freeze([...STRATEGY_DEFINITIONS, ...RETIRED_STRATEGY_DEFINITIONS]);

const STRATEGY_DEFINITION_BY_ID = new Map(
  ALL_STRATEGY_DEFINITIONS.map((definition) => [definition.id, definition])
);

function wilsonInterval(wins, total, z = 1.96) {
  if (!total) return null;
  const ratio = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (ratio + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((ratio * (1 - ratio)) / total + (z * z) / (4 * total * total))) /
    denominator;
  return [
    round(Math.max(0, (center - margin) * 100), 2),
    round(Math.min(100, (center + margin) * 100), 2)
  ];
}

function sequenceMaxDrawdown(returns) {
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const value of returns.filter(Number.isFinite)) {
    equity *= Math.max(0, 1 + value / 100);
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? ((equity / peak) - 1) * 100 : -100;
    worst = Math.min(worst, drawdown);
  }
  return worst;
}

function summarizeSamples(samples) {
  const usable = samples
    .filter((sample) => finite(sample?.netReturn))
    .sort((left, right) =>
      `${left.signalDate}:${left.code}`.localeCompare(`${right.signalDate}:${right.code}`)
    );
  const netReturns = usable.map((sample) => Number(sample.netReturn));
  const grossReturns = usable.map((sample) => Number(sample.grossReturn)).filter(Number.isFinite);
  const excessReturns = usable
    .filter(
      (sample) =>
        sample.excessReturn !== null &&
        sample.excessReturn !== undefined &&
        sample.excessReturn !== "" &&
        Number.isFinite(Number(sample.excessReturn))
    )
    .map((sample) => Number(sample.excessReturn));
  const wins = netReturns.filter((value) => value > 0).length;
  const adverse = usable
    .map((sample) => Number(sample.maxAdverseExcursion))
    .filter(Number.isFinite);
  const dailyReturns = dailyPortfolioReturns(usable);
  const maxDrawdown = sequenceMaxDrawdown(
    dailyReturns.map((row) => Number(row.return))
  );
  const averageReturn = average(netReturns);
  // Keep the point estimate and confidence bound sample weighted. Cluster by
  // signal day and reduce effective degrees of freedom for overlapping holds.
  const clusters = new Map();
  for (const sample of usable) {
    const key = normalizeDate(sample.signalDate);
    const group = clusters.get(key) || [];
    group.push(sample); clusters.set(key, group);
  }
  const horizons = usable.map(sample => {
    const days = (Date.parse(sample.exitDate) - Date.parse(sample.entryDate)) / 86400000 + 1;
    return finite(sample.holdingTradingDays) ? Math.max(1, Number(sample.holdingTradingDays)) : Number.isFinite(days) ? Math.max(1, days) : 1;
  });
  const overlapHorizon = average(horizons) || 1;
  const effectiveIndependentSamples = Math.floor(clusters.size / overlapHorizon);
  const degreesOfFreedom = effectiveIndependentSamples - 1;
  const criticalValues = [null, 6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812];
  const critical = degreesOfFreedom <= 10 ? criticalValues[degreesOfFreedom] : degreesOfFreedom <= 20 ? 1.812 : degreesOfFreedom <= 30 ? 1.725 : degreesOfFreedom <= 60 ? 1.697 : degreesOfFreedom <= 120 ? 1.671 : 1.658;
  const clusterScoreSquared = [...clusters.values()].reduce((sum, group) => sum + group.reduce((score, sample) => score + Number(sample.netReturn) - averageReturn, 0) ** 2, 0);
  // C-06：持有期重叠只通过 effectiveIndependentSamples（自由度）折减一次。
  // 旧式 SE 在信号日聚类之外又乘了 √H，等于对同一份重叠重复惩罚两遍，
  // 与对外文案「信号日聚类标准误，按平均持有期折减自由度」不符，也让下限虚低。
  // 这里保留聚类稳健标准误（CR1 形式：G/(G-1) × Σ 簇内离差平方和 / n），
  // 自由度仍由 effectiveIndependentSamples 承担。
  const standardError = clusters.size > 1 ? Math.sqrt(clusters.size / (clusters.size - 1) * clusterScoreSquared) / usable.length : null;
  const averageReturnLowerBound95 = effectiveIndependentSamples >= 2 && Number.isFinite(standardError)
    ? averageReturn - critical * standardError : null;
  const grossProfit = netReturns
    .filter((value) => value > 0)
    .reduce((total, value) => total + value, 0);
  const grossLoss = Math.abs(
    netReturns
      .filter((value) => value < 0)
      .reduce((total, value) => total + value, 0)
  );
  const first = usable[0];
  const last = usable.at(-1);
  return {
    sampleCount: usable.length,
    winCount: wins,
    lossCount: netReturns.filter(value => value < 0).length,
    flatCount: netReturns.filter(value => value === 0).length,
    winRate: usable.length ? round((wins / usable.length) * 100, 2) : null,
    winRateInterval95: wilsonInterval(wins, usable.length),
    averageReturn: round(averageReturn),
    averageReturnPct: round(averageReturn),
    averageGrossReturn: round(average(grossReturns)),
    medianReturn: round(median(netReturns)),
    returnVolatility: round(standardDeviation(netReturns)),
    averageReturnLowerBound95: roundNullable(averageReturnLowerBound95),
    profitFactor:
      grossLoss > 0
        ? round(grossProfit / grossLoss)
        : null,
    profitFactorStatus: grossLoss > 0 ? "finite" : grossProfit > 0 ? "no_losses" : "no_profit_or_loss",
    maxDrawdown: round(maxDrawdown),
    maxDrawdownPct: round(maxDrawdown),
    independentSignalDays: dailyReturns.length,
    effectiveIndependentSamples,
    confidenceMethod: "样本等权均值；信号日聚类标准误，按平均持有期折减自由度；单侧95% Student-t下限",
    maxSameDayStockCount: dailyReturns.length
      ? Math.max(...dailyReturns.map((row) => row.stockCount))
      : 0,
    equityAggregation: "同一信号日股票等权聚合，按持有期分摊仓位后顺序复利（诊断近似）",
    worstTradeDrawdown: adverse.length ? round(Math.min(...adverse)) : null,
    benchmarkSampleCount: excessReturns.length,
    averageExcessReturn: round(average(excessReturns)),
    range:
      first && last
        ? { from: first.signalDate, to: last.signalDate }
        : { from: "", to: "" }
  };
}

function benchmarkCoverageForSummary(summary, label) {
  const sampleCount = Math.max(0, Number(summary?.sampleCount) || 0);
  const matchedSampleCount = Math.max(
    0,
    Math.min(sampleCount, Number(summary?.benchmarkSampleCount) || 0)
  );
  const missingSampleCount = Math.max(0, sampleCount - matchedSampleCount);
  const complete = sampleCount > 0 && missingSampleCount === 0;
  return {
    required: true,
    complete,
    sampleCount,
    matchedSampleCount,
    missingSampleCount,
    reason: complete
      ? `${label}基准可比交易完整：${matchedSampleCount}/${sampleCount}`
      : sampleCount > 0
        ? `${label}基准可比交易不足：${matchedSampleCount}/${sampleCount}，缺少 ${missingSampleCount} 笔，不能通过复核`
        : `${label}暂无可核对的交易样本`
  };
}

function matchedStrategyIdsForReplay(definition, feature) {
  if (definition.componentEvidence) return definition.componentEvidence(feature).filter(item => item.passed).map(item => item.id);
  const componentIds = Array.isArray(definition?.components) && definition.components.length
    ? definition.components
    : [definition?.id];
  const matchedIds = componentIds.filter((id) => {
    const component = STRATEGY_DEFINITION_BY_ID.get(id);
    return component?.matches?.(feature) === true;
  });
  return matchedIds.length
    ? [...new Set(matchedIds)]
    : [String(definition?.id || "selected_strategy")];
}

function replaySignalBase(definition, code, name, signal, feature) {
  const strategyId = String(definition?.id || "selected_strategy");
  const signalDate = String(signal?.date || "");
  return {
    sampleId: `${strategyId}:${code}:${signalDate}`,
    code,
    name,
    strategyId,
    strategyIds: matchedStrategyIdsForReplay(definition, feature),
    signalDate
  };
}

function replayStrategy(
  definition,
  code,
  name,
  history,
  benchmarkByDate,
  options,
  executionPolicy = {}
) {
  const samples = [];
  const rejectedSignals = [];
  const pendingSignals = [];
  let untradeableCount = 0;
  const untradeableReasons = {
    nextDayOnePriceLimitUp: 0,
    ...(executionPolicy.entryGapRule === true ? { entryGapOutOfRange: 0 } : {}),
    suspendedOrNoLiquidity: 0,
    customEntryPriceNotReached: 0,
    invalidPrice: 0,
    missingNextMarketDay: 0
  };
  const requireNextMarketDay = executionPolicy.requireNextMarketDay === true;
  const nextMarketDateByDate = executionPolicy.nextMarketDateByDate instanceof Map
    ? executionPolicy.nextMarketDateByDate
    : new Map();
  const featureTimeline = Array.isArray(executionPolicy.featureTimeline)
    ? executionPolicy.featureTimeline
    : buildFeatureTimeline(history, code, code, [...benchmarkByDate.values()]);
  const observationEndIndex = options.signalTo
    ? history.findLastIndex(row => row.date <= options.signalTo)
    : history.length - 1;
  let lastSignalIndex = -Infinity;
  const startIndex = Math.max(20, 1);
  for (let index = startIndex; index < history.length; index += 1) {
    const feature = featureTimeline
      ? featureTimeline[index]
      : featureSnapshot(history, index, code, code);
    if (history[index].isST === true || !feature || !definition.matches(feature)) continue;
    if (index - lastSignalIndex <= options.cooldownDays) continue;
    const signal = history[index];
    if (
      (options.signalFrom && signal.date < options.signalFrom) ||
      (options.signalTo && signal.date > options.signalTo)
    ) {
      continue;
    }
    const signalBase = replaySignalBase(
      definition,
      code,
      name,
      signal,
      feature
    );
    signalBase.historicalStStatus = signal.isST === false ? "ordinary" : "unknown";
    const entryIndex = index + 1;
    let exitIndex = entryIndex + Math.max(2, options.horizonDays) - 1;
    const entry = entryIndex <= observationEndIndex ? history[entryIndex] : undefined;
    while (exitIndex <= observationEndIndex && ((!finite(history[exitIndex].volume) || Number(history[exitIndex].volume) <= 0) ||
      isClosingLimitDownExit(history[exitIndex - 1]?.close, history[exitIndex], code, code))) exitIndex += 1;
    const exitRow = exitIndex <= observationEndIndex ? history[exitIndex] : undefined;
    const expectedEntryDate = requireNextMarketDay
      ? String(nextMarketDateByDate.get(signal.date) || "")
      : "";
    if (
      requireNextMarketDay &&
      (
        (expectedEntryDate && entry?.date !== expectedEntryDate) ||
        (!expectedEntryDate && Boolean(entry))
      )
    ) {
      untradeableCount += 1;
      untradeableReasons.missingNextMarketDay += 1;
      rejectedSignals.push({
        ...signalBase,
        entryDate: entry?.date || "",
        exitDate: exitRow?.date || "",
        expectedEntryDate,
        status: "rejected",
        reason: "missingNextMarketDay",
        reasonText: expectedEntryDate
          ? `信号后的下一主市场交易日 ${expectedEntryDate} 缺少可成交K线，按停牌或缺失行情剔除`
          : "无法从中证全指交易日历核对信号后的下一主市场交易日，按基准日历缺失剔除"
      });
      continue;
    }
    if (!entry) {
      pendingSignals.push({
        ...signalBase,
        entryDate: "",
        exitDate: "",
        status: "pending",
        reason: "pending_next_trading_day",
        reasonText: "信号已命中，尚未出现可观察的下一交易日，暂不计入收益"
      });
      continue;
    }
    let entryPrice = Number(entry.open);
    const nextDayOnePriceLimit = isOpeningLimitUpEntry(Number(signal.close), entry, code, code);
    if (nextDayOnePriceLimit) {
      untradeableCount += 1;
      untradeableReasons.nextDayOnePriceLimitUp += 1;
      rejectedSignals.push({
        ...signalBase,
        entryDate: entry.date,
        exitDate: exitRow?.date || "",
        status: "rejected",
        reason: "nextDayOnePriceLimitUp",
        reasonText: "信号次日开盘达到涨停价，无法证明开盘可成交"
      });
      continue;
    }
    // 可选执行规则（选股页历史参考使用）：次日竞价高开或低开过多时按规则放弃，不计收益。
    const gapRule = executionPolicy.entryGapRule === true ? fieldRules.entryGapOutOfRange(signal.close, entry.open) : null;
    if (gapRule) {
      untradeableCount += 1;
      untradeableReasons.entryGapOutOfRange += 1;
      rejectedSignals.push({
        ...signalBase,
        entryDate: entry.date,
        exitDate: exitRow?.date || "",
        status: "rejected",
        reason: "entryGapOutOfRange",
        reasonText: `信号次日开盘${gapRule.side === "high" ? "高开" : "低开"} ${round(Math.abs(gapRule.gapPercent), 2)}%，按“${fieldRules.ENTRY_GAP_TEXT}”放弃`
      });
      continue;
    }
    const nextDayNoLiquidity = !finite(entry.volume) || Number(entry.volume) <= 0;
    if (nextDayNoLiquidity) {
      untradeableCount += 1;
      untradeableReasons.suspendedOrNoLiquidity += 1;
      rejectedSignals.push({
        ...signalBase,
        entryDate: entry.date,
        exitDate: exitRow?.date || "",
        status: "rejected",
        reason: "suspendedOrNoLiquidity",
        reasonText: "信号次日无有效流动性，按停牌或不可成交剔除"
      });
      continue;
    }
    if (Number.isFinite(options.customEntryPrice) && options.customEntryPrice > 0) {
      const customEntryPrice = Number(options.customEntryPrice);
      const entryLow = Number(entry.low);
      const entryHigh = Number(entry.high);
      if (
        !Number.isFinite(entryLow) ||
        !Number.isFinite(entryHigh) ||
        customEntryPrice < entryLow ||
        customEntryPrice > entryHigh
      ) {
        untradeableCount += 1;
        untradeableReasons.customEntryPriceNotReached += 1;
        rejectedSignals.push({
          ...signalBase,
          entryDate: entry.date,
          exitDate: exitRow?.date || "",
          customEntryPrice,
          entryLow: Number.isFinite(entryLow) ? entryLow : null,
          entryHigh: Number.isFinite(entryHigh) ? entryHigh : null,
          status: "rejected",
          reason: "customEntryPriceNotReached",
          reasonText: `下一交易日价格区间未触达自定义买入价 ${customEntryPrice}`
        });
        continue;
      }
      entryPrice = customEntryPrice;
    }
    const entryEvidence = { entryDate: entry.date, entryPrice, roundTripCostBps: options.roundTripCostBps };
    const priceBasisIssue = intervalPriceBasisIssue(history, entryIndex, Math.min(exitIndex, observationEndIndex), code, code);
    if (priceBasisIssue) {
      pendingSignals.push({ ...signalBase, ...entryEvidence, exitDate: "", status: "pending",
        reason: "corporate_action_unresolved", priceBasisIssue,
        reasonText: "持有区间原始价格与涨跌幅或参考价不一致，缺少可核验的除权结算数据，收益不可结算" });
      lastSignalIndex = index;
      continue;
    }
    lastSignalIndex = index;
    if (!exitRow || (options.signalTo && exitRow.date > options.signalTo)) {
      pendingSignals.push({
        ...signalBase,
        ...entryEvidence,
        exitDate: "",
        status: "pending",
        reason: "pending_exit_horizon",
        reasonText: `信号已命中，但尚未走完${options.horizonDays}个交易日持有期，暂不计入收益`
      });
      continue;
    }
    const exitPrice = Number(exitRow.close);
    if (!entryPrice || !exitPrice) {
      untradeableCount += 1;
      untradeableReasons.invalidPrice += 1;
      rejectedSignals.push({
        ...signalBase,
        entryDate: entry.date,
        exitDate: exitRow.date,
        status: "rejected",
        reason: "invalidPrice",
        reasonText: "入场开盘价或退出收盘价无效，无法可靠计算收益"
      });
      continue;
    }
    const grossReturn = ((exitPrice / entryPrice) - 1) * 100;
    const netReturn = grossReturn - options.roundTripCostBps / 100;
    const holdingRows = history.slice(entryIndex, exitIndex + 1);
    const maxAdverseExcursion = Math.min(
      ...holdingRows.map((row) => ((Number(row.low) / entryPrice) - 1) * 100)
    );
    const benchmarkEntry = benchmarkByDate.get(entry.date);
    const benchmarkExit = benchmarkByDate.get(exitRow.date);
    const benchmarkReturn =
      benchmarkEntry?.open && benchmarkExit?.close
        ? ((Number(benchmarkExit.close) / Number(benchmarkEntry.open)) - 1) * 100
        : null;
    samples.push({
      ...signalBase,
      entryDate: entry.date,
      exitDate: exitRow.date,
      holdingTradingDays: exitIndex - entryIndex + 1,
      entryPrice,
      entryPriceSource: Number.isFinite(options.customEntryPrice) && options.customEntryPrice > 0
        ? "custom_limit_price"
        : "next_market_open",
      exitPrice,
      grossReturn,
      roundTripCostBps: options.roundTripCostBps,
      netReturn,
      benchmarkReturn,
      excessReturn:
        Number.isFinite(benchmarkReturn) ? netReturn - benchmarkReturn : null,
      maxAdverseExcursion
    });
  }
  return {
    samples,
    rejectedSignals,
    pendingSignals,
    matchedSignalCount:
      samples.length + rejectedSignals.length + pendingSignals.length,
    pendingCount: pendingSignals.length,
    untradeableCount,
    untradeableReasons
  };
}

function temporalSplit(samples, outOfSampleRatio) {
  const ordered = [...samples].sort((left, right) =>
    `${left.signalDate}:${left.code}`.localeCompare(`${right.signalDate}:${right.code}`)
  );
  const signalDates = [...new Set(ordered.map((sample) => sample.signalDate))].sort();
  if (ordered.length < 2 || signalDates.length < 2) {
    return {
      inSample: ordered,
      outOfSample: [],
      splitDate: "",
      purgedTrainingSamples: 0,
      independentSignalDays: signalDates.length
    };
  }
  const ratio = clamp(outOfSampleRatio, 0.15, 0.5);
  const splitDateIndex = clamp(
    Math.floor(signalDates.length * (1 - ratio)),
    1,
    signalDates.length - 1
  );
  const splitDate = signalDates[splitDateIndex];
  const rawInSample = ordered.filter((sample) => sample.signalDate < splitDate);
  const inSample = rawInSample.filter((sample) => {
    const exitDate = normalizeDate(sample?.exitDate);
    return !exitDate || exitDate < splitDate;
  });
  return {
    inSample,
    outOfSample: ordered.filter((sample) => sample.signalDate >= splitDate),
    splitDate,
    purgedTrainingSamples: rawInSample.length - inSample.length,
    independentSignalDays: signalDates.length
  };
}

function validationHurdles(options) {
  const strategyCount = Math.max(1, Number(options.strategyCount) || 1);
  const multiplicity = Math.log2(strategyCount);
  const returnPenalty = multiplicity * 0.05;
  const winRatePenalty = Math.min(5, multiplicity);
  return {
    strategyCount,
    method: "按同时检验策略数施加对数型收益/胜率门槛惩罚",
    baseAverageReturn: round(options.minAverageReturn, 3),
    adjustedAverageReturn: round(options.minAverageReturn + returnPenalty, 3),
    baseWinRate: round(options.minWinRate, 2),
    adjustedWinRate: round(options.minWinRate + winRatePenalty, 2),
    returnPenalty: round(returnPenalty, 3),
    winRatePenalty: round(winRatePenalty, 2)
  };
}

function buildStabilityAudit(samples, options) {
  const ordered = [...samples].sort((left, right) =>
    `${left.signalDate}:${left.code}`.localeCompare(`${right.signalDate}:${right.code}`)
  );
  const daily = dailyPortfolioReturns(ordered);
  const codeCounts = new Map();
  for (const sample of ordered) {
    codeCounts.set(sample.code, (codeCounts.get(sample.code) || 0) + 1);
  }
  const maxCodeSamples = codeCounts.size
    ? Math.max(...codeCounts.values())
    : 0;
  const maxCodeShare = ordered.length ? maxCodeSamples / ordered.length : 1;
  const available =
    ordered.length >= options.minSamples &&
    daily.length >= options.minIndependentSignalDays;
  if (!available) {
    return {
      available: false,
      accepted: false,
      sampleCount: ordered.length,
      independentSignalDays: daily.length,
      minimumIndependentSignalDays: options.minIndependentSignalDays,
      distinctStocks: codeCounts.size,
      maxSingleStockShare: round(maxCodeShare, 4),
      buckets: [],
      positiveBucketRate: 0,
      reason:
        daily.length < options.minIndependentSignalDays
          ? `独立信号日不足：${daily.length}/${options.minIndependentSignalDays}`
          : `稳定性样本不足：${ordered.length}/${options.minSamples}`
    };
  }

  const bucketCount = Math.max(3, Math.min(4, Math.floor(daily.length / 3)));
  const buckets = [];
  let cursor = 0;
  for (let index = 0; index < bucketCount; index += 1) {
    const remaining = daily.length - cursor;
    const remainingBuckets = bucketCount - index;
    const size = Math.max(1, Math.floor(remaining / remainingBuckets));
    const end = index === bucketCount - 1 ? daily.length : cursor + size;
    const rows = daily.slice(cursor, end);
    const returns = rows.map((row) => Number(row.return));
    buckets.push({
      bucket: index + 1,
      from: rows[0]?.date || "",
      to: rows.at(-1)?.date || "",
      independentSignalDays: rows.length,
      averageReturn: round(average(returns)),
      winRate: rows.length
        ? round((returns.filter((value) => value > 0).length / rows.length) * 100, 2)
        : null,
      maxDrawdown: round(sequenceMaxDrawdown(returns))
    });
    cursor = end;
  }
  const positiveBuckets = buckets.filter(
    (bucket) => Number(bucket.averageReturn) > 0
  ).length;
  const positiveBucketRate = buckets.length
    ? positiveBuckets / buckets.length
    : 0;
  const worstBucketDrawdown = buckets.length
    ? Math.min(...buckets.map((bucket) => Number(bucket.maxDrawdown)))
    : null;
  const accepted =
    positiveBucketRate >= 2 / 3 &&
    Number(worstBucketDrawdown) >= options.maxDrawdown &&
    maxCodeShare <= 0.35;
  const reasons = [];
  if (positiveBucketRate < 2 / 3) reasons.push("少于三分之二时间分段取得正收益");
  if (Number(worstBucketDrawdown) < options.maxDrawdown) {
    reasons.push(`分段最差回撤低于 ${options.maxDrawdown}% 底线`);
  }
  if (maxCodeShare > 0.35) reasons.push("单只股票样本占比超过35%");
  return {
    available: true,
    accepted,
    sampleCount: ordered.length,
    independentSignalDays: daily.length,
    minimumIndependentSignalDays: options.minIndependentSignalDays,
    distinctStocks: codeCounts.size,
    maxSingleStockShare: round(maxCodeShare, 4),
    buckets,
    positiveBuckets,
    positiveBucketRate: round(positiveBucketRate, 4),
    worstBucketDrawdown: round(worstBucketDrawdown),
    reason: accepted ? "时间分段与样本分散度均达标" : reasons.join("；")
  };
}

function buildWalkForward(samples, options) {
  const ordered = [...samples].sort((left, right) =>
    `${left.signalDate}:${left.code}`.localeCompare(`${right.signalDate}:${right.code}`)
  );
  const signalDates = [...new Set(ordered.map((sample) => sample.signalDate))].sort();
  if (
    ordered.length < options.minSamples ||
    signalDates.length < options.minIndependentSignalDays
  ) {
    return {
      available: false,
      accepted: false,
      sampleCount: ordered.length,
      minimumSamples: options.minSamples,
      independentSignalDays: signalDates.length,
      minimumIndependentSignalDays: options.minIndependentSignalDays,
      folds: [],
      passedFolds: 0,
      passRate: 0,
      positiveFoldRate: 0,
      outOfSample: summarizeSamples([]),
      degradationPercent: null,
      overfitRisk: "insufficient",
      reason:
        ordered.length < options.minSamples
          ? `走步样本不足：${ordered.length}/${options.minSamples}`
          : `走步独立信号日不足：${signalDates.length}/${options.minIndependentSignalDays}`
    };
  }

  const initialTrainDateCount = Math.max(
    3,
    Math.floor(signalDates.length * (1 - options.outOfSampleRatio))
  );
  const availableTestDates = signalDates.length - initialTrainDateCount;
  const possibleFolds = Math.floor(
    availableTestDates / options.minWalkForwardFoldSamples
  );
  const foldCount = Math.min(options.walkForwardFolds, possibleFolds);
  if (foldCount < 2) {
    return {
      available: false,
      accepted: false,
      sampleCount: ordered.length,
      minimumSamples: options.minSamples,
      independentSignalDays: signalDates.length,
      minimumIndependentSignalDays: options.minIndependentSignalDays,
      folds: [],
      passedFolds: 0,
      passRate: 0,
      positiveFoldRate: 0,
      outOfSample: summarizeSamples([]),
      degradationPercent: null,
      overfitRisk: "insufficient",
      reason:
        `走步样本外窗口不足：${availableTestDates}个独立信号日，` +
        `每窗至少${options.minWalkForwardFoldSamples}日`
    };
  }
  const hurdles = validationHurdles(options);
  const rowsForDates = (dates) => {
    const dateSet = new Set(dates);
    return ordered.filter((sample) => dateSet.has(sample.signalDate));
  };
  const initialTrainingDates = signalDates.slice(0, initialTrainDateCount);
  const outOfSampleDates = signalDates.slice(initialTrainDateCount);
  const folds = [];
  let dateCursor = initialTrainDateCount;
  for (let index = 0; index < foldCount; index += 1) {
    const remaining = signalDates.length - dateCursor;
    const remainingFolds = foldCount - index;
    const testDateCount = Math.max(
      options.minWalkForwardFoldSamples,
      Math.floor(remaining / remainingFolds)
    );
    const endDateIndex =
      index === foldCount - 1
        ? signalDates.length
        : Math.min(signalDates.length, dateCursor + testDateCount);
    const trainDates = signalDates.slice(0, dateCursor);
    const testDates = signalDates.slice(dateCursor, endDateIndex);
    const rawTrainRows = rowsForDates(trainDates);
    const testStartDate = testDates[0] || "";
    const purgedTrainRows = rawTrainRows.filter((sample) => {
      const exitDate = normalizeDate(sample?.exitDate);
      return !testStartDate || !exitDate || exitDate < testStartDate;
    });
    const train = summarizeSamples(purgedTrainRows);
    const test = summarizeSamples(rowsForDates(testDates));
    const testBenchmarkCoverage = benchmarkCoverageForSummary(
      test,
      `走步第${index + 1}窗`
    );
    const accepted =
      test.sampleCount >= options.minWalkForwardFoldSamples &&
      test.independentSignalDays >= options.minWalkForwardFoldSamples &&
      Number(test.averageReturn) >= hurdles.adjustedAverageReturn &&
      lowerBoundPasses(test.averageReturnLowerBound95, options.minReturnLowerBound) &&
      testBenchmarkCoverage.complete &&
      Number(test.averageExcessReturn) > 0 &&
      Number(test.winRate) >= hurdles.adjustedWinRate &&
      Number(test.maxDrawdown) >= options.maxDrawdown;
    folds.push({
      fold: index + 1,
      trainRange: train.range,
      testRange: test.range,
      trainSampleCount: train.sampleCount,
      trainIndependentSignalDays: train.independentSignalDays,
      purgedTrainingSamples: rawTrainRows.length - purgedTrainRows.length,
      testSampleCount: test.sampleCount,
      testIndependentSignalDays: test.independentSignalDays,
      trainAverageReturn: train.averageReturn,
      testAverageReturn: test.averageReturn,
      testAverageReturnLowerBound95: test.averageReturnLowerBound95,
      testAverageExcessReturn: test.averageExcessReturn,
      testBenchmarkSampleCount: test.benchmarkSampleCount,
      benchmarkCoverage: testBenchmarkCoverage,
      testWinRate: test.winRate,
      testMaxDrawdown: test.maxDrawdown,
      accepted
    });
    dateCursor = endDateIndex;
  }

  const rawInitialTraining = rowsForDates(initialTrainingDates);
  const initialTrainingRows = rawInitialTraining.filter(sample => !sample.exitDate || normalizeDate(sample.exitDate) < outOfSampleDates[0]);
  const training = summarizeSamples(initialTrainingRows);
  const outOfSample = summarizeSamples(rowsForDates(outOfSampleDates));
  const outOfSampleBenchmarkCoverage = benchmarkCoverageForSummary(
    outOfSample,
    "走步样本外"
  );
  const passedFolds = folds.filter((fold) => fold.accepted).length;
  const positiveFolds = folds.filter(
    (fold) => Number(fold.testAverageReturn) > 0
  ).length;
  const passRate = folds.length ? passedFolds / folds.length : 0;
  const positiveFoldRate = folds.length ? positiveFolds / folds.length : 0;
  const degradationPercent =
    Number(training.averageReturn) > 0 && Number.isFinite(Number(outOfSample.averageReturn))
      ? Math.max(
        0,
        ((Number(training.averageReturn) - Number(outOfSample.averageReturn)) /
          Math.max(Math.abs(Number(training.averageReturn)), 0.01)) * 100
      )
      : Number(outOfSample.averageReturn) < Number(training.averageReturn) ? 100 : 0;
  const overfitRisk =
    Number(outOfSample.averageReturn) <= 0 ||
    passRate < 0.5 ||
    degradationPercent > 70
      ? "high"
      : passRate < 2 / 3 || degradationPercent > 40
        ? "medium"
        : "low";
  const accepted =
    outOfSample.sampleCount >= options.minOutOfSampleSamples &&
    outOfSample.independentSignalDays >= options.minOutOfSampleSamples &&
    passRate >= 2 / 3 &&
    positiveFoldRate >= 2 / 3 &&
    Number(outOfSample.averageReturn) >= hurdles.adjustedAverageReturn &&
    lowerBoundPasses(outOfSample.averageReturnLowerBound95, options.minReturnLowerBound) &&
    outOfSampleBenchmarkCoverage.complete &&
    Number(outOfSample.averageExcessReturn) > 0 &&
    Number(outOfSample.winRate) >= hurdles.adjustedWinRate &&
    Number(outOfSample.maxDrawdown) >= options.maxDrawdown &&
    overfitRisk !== "high";

  return {
    available: true,
    accepted,
    sampleCount: ordered.length,
    minimumSamples: options.minSamples,
    independentSignalDays: signalDates.length,
    minimumIndependentSignalDays: options.minIndependentSignalDays,
    minimumOutOfSampleSamples: options.minOutOfSampleSamples,
    minimumFoldSignalDays: options.minWalkForwardFoldSamples,
    multipleTesting: hurdles,
    initialTraining: training,
    purgedInitialTrainingSamples: rawInitialTraining.length - initialTrainingRows.length,
    outOfSample,
    benchmarkCoverage: outOfSampleBenchmarkCoverage,
    folds,
    passedFolds,
    passRate: round(passRate, 4),
    positiveFoldRate: round(positiveFoldRate, 4),
    degradationPercent: round(degradationPercent, 2),
    overfitRisk,
    reason: accepted
      ? `走步验证通过：${passedFolds}/${folds.length} 个样本外窗口达标`
      : outOfSample.sampleCount > 0 && !outOfSampleBenchmarkCoverage.complete
        ? `走步验证未通过：${outOfSampleBenchmarkCoverage.reason}`
        : `走步验证未通过：${passedFolds}/${folds.length} 个样本外窗口达标`
  };
}

function confidenceLevel(sampleCount) {
  if (sampleCount >= 100) return "high";
  if (sampleCount >= 30) return "medium";
  if (sampleCount >= 18) return "low";
  return "insufficient";
}

function buildValidation(
  samples,
  untradeableCount,
  untradeableReasons,
  options
) {
  const summary = summarizeSamples(samples);
  const split = temporalSplit(samples, options.outOfSampleRatio);
  const inSample = summarizeSamples(split.inSample);
  const outOfSample = summarizeSamples(split.outOfSample);
  const walkForward = buildWalkForward(samples, options);
  const stability = buildStabilityAudit(samples, options);
  const hurdles = validationHurdles(options);
  const overallBenchmarkCoverage = benchmarkCoverageForSummary(
    summary,
    "全部样本"
  );
  const outOfSampleBenchmarkCoverage = benchmarkCoverageForSummary(
    outOfSample,
    "样本外"
  );
  const benchmarkCoverage = {
    required: true,
    complete:
      overallBenchmarkCoverage.complete &&
      outOfSampleBenchmarkCoverage.complete,
    overall: overallBenchmarkCoverage,
    outOfSample: outOfSampleBenchmarkCoverage,
    reason: [overallBenchmarkCoverage, outOfSampleBenchmarkCoverage]
      .filter((item) => item.sampleCount > 0 && !item.complete)
      .map((item) => item.reason)
      .join("；")
  };
  const accepted =
    summary.sampleCount >= options.minSamples &&
    summary.independentSignalDays >= options.minIndependentSignalDays &&
    outOfSample.sampleCount >= options.minOutOfSampleSamples &&
    outOfSample.independentSignalDays >= options.minOutOfSampleSamples &&
    Number(outOfSample.averageReturn) >= hurdles.adjustedAverageReturn &&
    lowerBoundPasses(outOfSample.averageReturnLowerBound95, options.minReturnLowerBound) &&
    benchmarkCoverage.complete &&
    Number(outOfSample.averageExcessReturn) > 0 &&
    Number(outOfSample.winRate) >= hurdles.adjustedWinRate &&
    Number(outOfSample.maxDrawdown) >= options.maxDrawdown &&
    walkForward.accepted &&
    stability.accepted;
  const reasons = [];
  if (summary.sampleCount < options.minSamples) {
    reasons.push(`样本不足：${summary.sampleCount}/${options.minSamples}`);
  }
  if (summary.independentSignalDays < options.minIndependentSignalDays) {
    reasons.push(
      `独立信号日不足：${summary.independentSignalDays}/${options.minIndependentSignalDays}`
    );
  }
  if (outOfSample.sampleCount < options.minOutOfSampleSamples) {
    reasons.push(
      `样本外记录不足：${outOfSample.sampleCount}/${options.minOutOfSampleSamples}`
    );
  }
  if (outOfSample.independentSignalDays < options.minOutOfSampleSamples) {
    reasons.push(
      `样本外独立信号日不足：${outOfSample.independentSignalDays}/${options.minOutOfSampleSamples}`
    );
  } else {
    if (Number(outOfSample.averageReturn) < hurdles.adjustedAverageReturn) {
      reasons.push(
        `样本外平均收益 ${outOfSample.averageReturn}% 低于多策略修正门槛 ${hurdles.adjustedAverageReturn}%`
      );
    }
    if (!lowerBoundPasses(outOfSample.averageReturnLowerBound95, options.minReturnLowerBound)) {
      reasons.push(
        finite(outOfSample.averageReturnLowerBound95)
          ? `样本外平均收益95%单侧下限 ${outOfSample.averageReturnLowerBound95}% 低于 ${options.minReturnLowerBound}%`
          : "样本外独立信号日不足（有效独立样本少于2），无法计算95%单侧下限，按不通过处理"
      );
    }
    if (
      outOfSampleBenchmarkCoverage.complete &&
      Number(outOfSample.averageExcessReturn) <= 0
    ) {
      reasons.push(`样本外相对中证全指超额收益 ${outOfSample.averageExcessReturn}% 未转正`);
    }
    if (Number(outOfSample.winRate) < hurdles.adjustedWinRate) {
      reasons.push(
        `样本外胜率 ${outOfSample.winRate}% 低于多策略修正门槛 ${hurdles.adjustedWinRate}%`
      );
    }
    if (Number(outOfSample.maxDrawdown) < options.maxDrawdown) {
      reasons.push(
        `样本外最大回撤 ${outOfSample.maxDrawdown}% 低于底线 ${options.maxDrawdown}%`
      );
    }
  }
  if (summary.sampleCount > 0 && !overallBenchmarkCoverage.complete) {
    reasons.push(overallBenchmarkCoverage.reason);
  }
  if (outOfSample.sampleCount > 0 && !outOfSampleBenchmarkCoverage.complete) {
    reasons.push(outOfSampleBenchmarkCoverage.reason);
  }
  if (!walkForward.accepted) reasons.push(walkForward.reason);
  if (!stability.accepted) reasons.push(stability.reason);
  return {
    ...summary,
    horizonDays: options.horizonDays,
    entryRule: `信号次一交易日开盘买入（必须为下一主市场交易日），持有${options.horizonDays}个交易日；剔除次日一字涨停、停牌及缺失行情样本`,
    returnType: "扣除双边交易成本后的区间收益率（百分比）",
    roundTripCostBps: options.roundTripCostBps,
    untradeableCount,
    untradeableReasons: {
      nextDayOnePriceLimitUp:
        Number(untradeableReasons?.nextDayOnePriceLimitUp) || 0,
      suspendedOrNoLiquidity:
        Number(untradeableReasons?.suspendedOrNoLiquidity) || 0,
      invalidPrice:
        Number(untradeableReasons?.invalidPrice) || 0,
      missingNextMarketDay:
        Number(untradeableReasons?.missingNextMarketDay) || 0
    },
    confidence: confidenceLevel(summary.sampleCount),
    thresholds: {
      minSamples: options.minSamples,
      minIndependentSignalDays: options.minIndependentSignalDays,
      minOutOfSampleSamples: options.minOutOfSampleSamples,
      minWalkForwardFoldSamples: options.minWalkForwardFoldSamples,
      minWinRate: options.minWinRate,
      minAverageReturn: options.minAverageReturn,
      minReturnLowerBound: options.minReturnLowerBound,
      maxDrawdown: options.maxDrawdown
    },
    multipleTesting: hurdles,
    benchmarkCoverage,
    inSample,
    outOfSample,
    walkForward,
    stability,
    accepted,
    reason: accepted ? "历史回放、时间切分样本外与走步验证均通过" : reasons.join("；")
  };
}

function marketRegimeState(benchmarkRows) {
  const rows = Array.isArray(benchmarkRows) ? benchmarkRows : [];
  const byDate = new Map();
  const closes = [];
  const dailyChanges = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const close = Number(row?.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    closes.push(close);
    if (index > 0 && Number(rows[index - 1]?.close) > 0) {
      dailyChanges.push((close / Number(rows[index - 1].close) - 1) * 100);
    } else {
      dailyChanges.push(0);
    }
    const ma20 = average(closes.slice(-20));
    const ma60 = average(closes.slice(-60));
    const return20 = closes.length > 20
      ? (close / closes.at(-21) - 1) * 100
      : null;
    const volatility20 = standardDeviation(dailyChanges.slice(-20));
    let id = "balanced";
    if (
      closes.length >= 60 &&
      close > Number(ma60) &&
      Number(ma20) > Number(ma60) &&
      Number(return20) > 2
    ) {
      id = "risk_on";
    } else if (
      closes.length >= 60 &&
      close < Number(ma60) &&
      Number(ma20) < Number(ma60) &&
      Number(return20) < -2
    ) {
      id = "risk_off";
    }
    const value = {
      id,
      label:
        id === "risk_on" ? "趋势进攻" : id === "risk_off" ? "退潮防守" : "震荡均衡",
      date: normalizeDate(row.date),
      close: round(close),
      ma20: roundNullable(ma20),
      ma60: roundNullable(ma60),
      return20: roundNullable(return20),
      volatility20: roundNullable(volatility20),
      volatility: Number(volatility20) >= 1.8 ? "high" : "normal"
    };
    byDate.set(value.date, value);
  }
  return {
    byDate,
    current: rows.length
      ? byDate.get(normalizeDate(rows.at(-1)?.date)) || null
      : null
  };
}

function buildRegimeEvidence(samples, regimeState, options) {
  const buckets = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const regime = regimeState?.byDate?.get(normalizeDate(sample?.signalDate));
    const id = regime?.id || "unknown";
    const rows = buckets.get(id) || [];
    rows.push(sample);
    buckets.set(id, rows);
  }
  const orderedIds = ["risk_on", "balanced", "risk_off", "unknown"];
  const minimumSignalDays = Math.max(
    6,
    Math.min(12, Number(options.minWalkForwardFoldSamples) || 6)
  );
  const regimes = orderedIds
    .filter((id) => buckets.has(id))
    .map((id) => {
      const summary = summarizeSamples(buckets.get(id));
      const benchmarkReady =
        summary.sampleCount > 0 &&
        summary.benchmarkSampleCount >= summary.sampleCount;
      const supported =
        summary.independentSignalDays >= minimumSignalDays &&
        lowerBoundPasses(summary.averageReturnLowerBound95, options.minReturnLowerBound) &&
        benchmarkReady &&
        Number(summary.averageExcessReturn) > 0 &&
        Number(summary.maxDrawdown) >= options.maxDrawdown;
      return {
        id,
        label:
          id === "risk_on"
            ? "趋势进攻"
            : id === "risk_off"
              ? "退潮防守"
              : id === "balanced"
                ? "震荡均衡"
                : "状态未知",
        minimumSignalDays,
        benchmarkComplete: benchmarkReady,
        supported,
        ...summary
      };
    });
  const currentId = regimeState?.current?.id || "unknown";
  const current = regimes.find((item) => item.id === currentId);
  const currentFit = {
    regimeId: currentId,
    regimeLabel: regimeState?.current?.label || "状态未知",
    available: Boolean(current),
    supported: current?.supported === true,
    sampleCount: Number(current?.sampleCount || 0),
    independentSignalDays: Number(current?.independentSignalDays || 0),
    averageReturn: current?.averageReturn ?? null,
    averageReturnLowerBound95: current?.averageReturnLowerBound95 ?? null,
    averageExcessReturn: current?.averageExcessReturn ?? null,
    benchmarkComplete: current?.benchmarkComplete === true,
    maxDrawdown: current?.maxDrawdown ?? null,
    reason: !current
      ? "当前市场状态没有可复核样本"
      : current.supported
        ? "当前市场状态的历史样本、置信下限、超额收益与回撤均达标"
        : current.benchmarkComplete !== true
          ? `当前市场状态基准可比交易不足：${Number(current.benchmarkSampleCount || 0)}/${Number(current.sampleCount || 0)}`
          : `当前市场状态未达标：独立信号日 ${current.independentSignalDays}/${minimumSignalDays}`
  };
  return { regimes, currentFit };
}

function sampleKey(sample) {
  return `${normalizeDate(sample?.signalDate)}:${String(sample?.code || "")}`;
}

function pearsonCorrelation(leftValues, rightValues) {
  if (leftValues.length < 3 || leftValues.length !== rightValues.length) return null;
  const leftMean = average(leftValues);
  const rightMean = average(rightValues);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < leftValues.length; index += 1) {
    const left = leftValues[index] - leftMean;
    const right = rightValues[index] - rightMean;
    numerator += left * right;
    leftSquare += left * left;
    rightSquare += right * right;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator > 0 ? numerator / denominator : null;
}

function strategyDependence(left, right) {
  const leftMap = new Map((left.samples || []).map((sample) => [sampleKey(sample), sample]));
  const rightMap = new Map((right.samples || []).map((sample) => [sampleKey(sample), sample]));
  const leftKeys = new Set(leftMap.keys());
  const rightKeys = new Set(rightMap.keys());
  const commonKeys = [...leftKeys].filter((key) => rightKeys.has(key));
  const unionSize = new Set([...leftKeys, ...rightKeys]).size;
  const smallerSize = Math.min(leftKeys.size, rightKeys.size);
  const leftReturns = [];
  const rightReturns = [];
  for (const key of commonKeys) {
    const leftReturn = Number(leftMap.get(key)?.netReturn);
    const rightReturn = Number(rightMap.get(key)?.netReturn);
    if (Number.isFinite(leftReturn) && Number.isFinite(rightReturn)) {
      leftReturns.push(leftReturn);
      rightReturns.push(rightReturn);
    }
  }
  return {
    leftId: left.id,
    rightId: right.id,
    commonSignals: commonKeys.length,
    jaccard: round(unionSize ? commonKeys.length / unionSize : 0, 4),
    containment: round(smallerSize ? commonKeys.length / smallerSize : 0, 4),
    returnCorrelation: roundNullable(pearsonCorrelation(leftReturns, rightReturns)),
    redundant: smallerSize > 0 && commonKeys.length / smallerSize > 0.72
  };
}

function robustStrategyScore(validation) {
  const outOfSample = validation?.outOfSample || {};
  const walkForward = validation?.walkForward || {};
  const stability = validation?.stability || {};
  const wilsonLow = Array.isArray(outOfSample.winRateInterval95)
    ? Number(outOfSample.winRateInterval95[0])
    : 0;
  let score = 25;
  score += clamp(Number(outOfSample.averageReturnLowerBound95 || 0) * 8, -20, 20);
  score += clamp(Number(outOfSample.averageExcessReturn || 0) * 5, -15, 15);
  score += clamp((wilsonLow - 40) * 0.65, -10, 15);
  score += clamp(Number(walkForward.passRate || 0) * 20, 0, 20);
  score += clamp(Number(stability.positiveBucketRate || 0) * 10, 0, 10);
  score += clamp((Number(outOfSample.maxDrawdown || -30) + 30) * 0.35, 0, 10);
  score -= clamp(Number(walkForward.degradationPercent || 0) / 10, 0, 10);
  if (validation?.accepted === true) score += 10;
  return round(clamp(score, 0, 100), 1);
}

function terminalSplitDate(strategyRows, ratio) {
  const dates = [
    ...new Set(
      strategyRows.flatMap((row) =>
        (row.samples || []).map((sample) => normalizeDate(sample.signalDate)).filter(Boolean)
      )
    )
  ].sort();
  if (dates.length < 2) return "";
  const index = clamp(Math.floor(dates.length * (1 - ratio)), 1, dates.length - 1);
  return dates[index] || "";
}

function splitForTerminalHoldout(samples, splitDate) {
  const source = Array.isArray(samples) ? samples : [];
  if (!splitDate) return { development: source, holdout: [], purged: 0 };
  const rawDevelopment = source.filter(
    (sample) => normalizeDate(sample.signalDate) < splitDate
  );
  const development = rawDevelopment.filter((sample) => {
    const exitDate = normalizeDate(sample.exitDate);
    return !exitDate || exitDate < splitDate;
  });
  return {
    development,
    holdout: source.filter(
      (sample) => normalizeDate(sample.signalDate) >= splitDate
    ),
    purged: rawDevelopment.length - development.length
  };
}

function consensusSamples(strategyRows, minimumVotes) {
  const votesByKey = new Map();
  for (const row of strategyRows) {
    for (const sample of row.samples || []) {
      const key = sampleKey(sample);
      if (!key.endsWith(":")) {
        const record = votesByKey.get(key) || {
          sample,
          strategyIds: new Set()
        };
        record.strategyIds.add(row.id);
        votesByKey.set(key, record);
      }
    }
  }
  return [...votesByKey.values()]
    .filter((record) => record.strategyIds.size >= minimumVotes)
    .map((record) => ({
      ...record.sample,
      strategyId: "optimized_robust_consensus",
      matchedStrategyIds: [...record.strategyIds].sort(),
      voteCount: record.strategyIds.size
    }));
}

function terminalHoldoutAudit(samples, options, splitDate, purgedSamples) {
  const summary = summarizeSamples(samples);
  const minimumSamples = Math.max(12, options.minOutOfSampleSamples);
  const hurdles = validationHurdles(options);
  const benchmarkCoverage = benchmarkCoverageForSummary(summary, "终端留出");
  const accepted =
    summary.sampleCount >= minimumSamples &&
    summary.independentSignalDays >= minimumSamples &&
    Number(summary.averageReturn) >= hurdles.adjustedAverageReturn &&
    lowerBoundPasses(summary.averageReturnLowerBound95, options.minReturnLowerBound) &&
    benchmarkCoverage.complete &&
    Number(summary.averageExcessReturn) > 0 &&
    Number(summary.winRate) >= hurdles.adjustedWinRate &&
    Number(summary.maxDrawdown) >= options.maxDrawdown;
  const reasons = [];
  if (summary.sampleCount < minimumSamples) {
    reasons.push(`终端留出样本不足：${summary.sampleCount}/${minimumSamples}`);
  }
  if (summary.independentSignalDays < minimumSamples) {
    reasons.push(`终端留出独立信号日不足：${summary.independentSignalDays}/${minimumSamples}`);
  }
  if (!lowerBoundPasses(summary.averageReturnLowerBound95, options.minReturnLowerBound)) {
    reasons.push(finite(summary.averageReturnLowerBound95)
      ? "终端留出收益置信下限未达标"
      : "终端留出独立信号日不足（有效独立样本少于2），无法计算95%单侧下限，按不通过处理");
  }
  if (summary.sampleCount > 0 && !benchmarkCoverage.complete) {
    reasons.push(benchmarkCoverage.reason);
  } else if (benchmarkCoverage.complete && Number(summary.averageExcessReturn) <= 0) {
    reasons.push("终端留出相对中证全指超额收益未转正");
  }
  if (Number(summary.maxDrawdown) < options.maxDrawdown) {
    reasons.push("终端留出最大回撤超出底线");
  }
  return {
    ...summary,
    splitDate,
    minimumSamples,
    purgedDevelopmentSamples: purgedSamples,
    benchmarkCoverage,
    accepted,
    reason: accepted ? "未参与选优的终端留出样本通过" : reasons.join("；")
  };
}

function buildOptimizedPortfolio(strategyRows, regimeState, options) {
  const baseRows = strategyRows.filter((row) => row.type !== "composite");
  const splitDate = terminalSplitDate(baseRows, options.terminalHoldoutRatio);
  const candidates = baseRows.map((row) => {
    const split = splitForTerminalHoldout(row.samples, splitDate);
    const developmentValidation = buildValidation(split.development, row.untradeableCount || 0, row.untradeableReasons || {}, options);
    return {
      ...row,
      samples: split.development,
      holdoutSamples: split.holdout,
      purgedSamples: split.purged,
      developmentValidation,
      robustScore: robustStrategyScore(developmentValidation)
    };
  }).sort(
    (left, right) =>
      Number(right.developmentValidation.accepted) -
        Number(left.developmentValidation.accepted) ||
      right.robustScore - left.robustScore ||
      left.id.localeCompare(right.id)
  );
  const eligible = candidates.filter(
    (row) => row.developmentValidation.accepted === true
  );
  const viableCandidates = candidates.filter(
    (row) => row.developmentValidation.sampleCount > 0
  );
  const selectionPool = eligible.length >= options.optimizedMinVotes
    ? eligible
    : viableCandidates;
  const selected = [];
  const rejectedForOverlap = [];
  for (const row of selectionPool) {
    if (selected.length >= 4) break;
    const comparisons = selected.map((existing) => strategyDependence(existing, row));
    const conflict = comparisons.find(
      (item) => Number(item.containment) > options.maxStrategyOverlap
    );
    if (conflict) {
      rejectedForOverlap.push({
        strategyId: row.id,
        blockedBy: conflict.leftId,
        containment: conflict.containment,
        reason: "与已选策略信号高度重叠"
      });
      continue;
    }
    selected.push(row);
  }
  const developmentConsensus = consensusSamples(
    selected.map((row) => ({ id: row.id, samples: row.samples })),
    options.optimizedMinVotes
  );
  const holdoutConsensus = consensusSamples(
    selected.map((row) => ({ id: row.id, samples: row.holdoutSamples })),
    options.optimizedMinVotes
  );
  const combinedValidation = buildValidation(developmentConsensus, 0, {}, options);
  const terminalHoldout = terminalHoldoutAudit(
    holdoutConsensus,
    options,
    splitDate,
    selected.reduce((total, row) => total + row.purgedSamples, 0)
  );
  const allConsensus = [...developmentConsensus, ...holdoutConsensus];
  const regimeEvidence = buildRegimeEvidence(allConsensus, regimeState, options);
  const dependence = [];
  for (let leftIndex = 0; leftIndex < selected.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selected.length; rightIndex += 1) {
      dependence.push(strategyDependence(selected[leftIndex], selected[rightIndex]));
    }
  }
  const currentVotes = new Map();
  for (const row of selected) {
    for (const stock of row.stocks || []) {
      const code = String(stock?.code || "");
      if (!code) continue;
      const record = currentVotes.get(code) || {
        stock,
        strategyIds: new Set(),
        scores: []
      };
      record.strategyIds.add(row.id);
      record.scores.push(Number(stock.signalStrength || 0));
      currentVotes.set(code, record);
    }
  }
  const stocks = [...currentVotes.values()]
    .filter((record) => record.strategyIds.size >= options.optimizedMinVotes)
    .map((record) => ({
      ...record.stock,
      matchedStrategyIds: [...record.strategyIds].sort(),
      voteCount: record.strategyIds.size,
      signalStrength: Math.round(
        clamp(average(record.scores) + (record.strategyIds.size - 1) * 4, 0, 100)
      )
    }))
    .sort(
      (left, right) =>
        Number(right.voteCount) - Number(left.voteCount) ||
        Number(right.signalStrength) - Number(left.signalStrength) ||
        String(left.code).localeCompare(String(right.code))
    )
    .map((stock, index) => ({ ...stock, rank: index + 1 }));
  const selectedAccepted =
    selected.length >= options.optimizedMinVotes &&
    selected.every((row) => row.developmentValidation.accepted === true);
  const selectedBenchmarkComplete =
    selected.length >= options.optimizedMinVotes &&
    selected.every(
      (row) => row.developmentValidation?.benchmarkCoverage?.complete === true
    );
  const benchmarkCoverage = {
    required: true,
    complete:
      selectedBenchmarkComplete &&
      combinedValidation?.benchmarkCoverage?.complete === true &&
      terminalHoldout?.benchmarkCoverage?.complete === true,
    selectedComponentsComplete: selectedBenchmarkComplete,
    combinedDevelopment:
      combinedValidation?.benchmarkCoverage || null,
    terminalHoldout: terminalHoldout?.benchmarkCoverage || null
  };
  const accepted =
    selectedAccepted &&
    benchmarkCoverage.complete &&
    combinedValidation.accepted === true &&
    terminalHoldout.accepted === true &&
    regimeEvidence.currentFit.supported === true;
  const reasons = [];
  if (selected.length < options.optimizedMinVotes) {
    reasons.push(`低相关达标策略不足：${selected.length}/${options.optimizedMinVotes}`);
  }
  if (!selectedAccepted) reasons.push("入选组件未全部通过开发期历史复核");
  if (!benchmarkCoverage.complete) {
    const benchmarkReasons = [
      !selectedBenchmarkComplete
        ? "入选组件的开发期基准可比交易不完整"
        : "",
      combinedValidation?.benchmarkCoverage?.reason || "",
      terminalHoldout?.benchmarkCoverage?.reason || ""
    ].filter(Boolean);
    reasons.push(`组合基准复核未完成：${benchmarkReasons.join("；")}`);
  }
  if (!combinedValidation.accepted) reasons.push("历史共识组合未通过走步与稳定性复核");
  if (!terminalHoldout.accepted) reasons.push(terminalHoldout.reason);
  if (!regimeEvidence.currentFit.supported) reasons.push(regimeEvidence.currentFit.reason);
  return {
    id: "optimized_robust_consensus",
    name: "稳健优选组合",
    version: "robust-v2",
    accepted,
    publicationAccepted: false,
    selectedStrategies: selected.map((row) => ({
      id: row.id,
      name: row.name,
      robustScore: row.robustScore,
      developmentAccepted: row.developmentValidation.accepted === true,
      developmentOutOfSample: row.developmentValidation.outOfSample,
      developmentBenchmarkCoverage:
        row.developmentValidation.benchmarkCoverage,
      currentMatchCount: row.stocks.length
    })),
    minimumVotes: options.optimizedMinVotes,
    maxAllowedContainment: options.maxStrategyOverlap,
    dependence,
    rejectedForOverlap,
    splitDate,
    selectionWindow: "终端留出日期之前；持仓跨界样本已清洗",
    terminalHoldout,
    validation: combinedValidation,
    benchmarkCoverage,
    currentRegime: regimeState?.current || null,
    regimes: regimeEvidence.regimes,
    currentRegimeFit: regimeEvidence.currentFit,
    stocks,
    reason: accepted
      ? "低重叠组件、开发期共识回放、终端留出与当前市场状态均通过"
      : reasons.join("；"),
    methodology: {
      selection: "仅用终端留出之前的数据按样本外置信下限、超额收益、走步通过率、回撤与稳定性排序",
      dependence: "用同股同日信号包含率去除高度重复组件",
      consensus: `同一股票同一交易日至少 ${options.optimizedMinVotes} 个低相关策略同时命中`,
      holdout: `最后约 ${Math.round(options.terminalHoldoutRatio * 100)}% 独立信号日期只用于终端考试，不参与组件选优`,
      regime: "依据中证全指当时可见的MA20、MA60与20日收益划分趋势进攻、震荡均衡、退潮防守"
    }
  };
}

function stockSignal(definition, candidate, identity, feature, historyLength) {
  const analysis = candidateAnalysis(candidate);
  const reasons = definition.reasons(feature).filter(Boolean);
  const risks = [];
  if (feature.heldSupport === false) risks.push("已跌破涨停日低点");
  if (finite(feature.volumeRatio) && Number(feature.volumeRatio) > 2.5) {
    risks.push("量能偏热");
  }
  if (analysis.riskVeto === false || candidate?.riskVeto === false) {
    risks.push("候选数据触发风险否决");
  }
  // 排序分按 2021–2026 全A实测重写（strategy-field-rules.fieldSignalStrength）：
  // 旧公式奖励的“均线多头、收盘在日内高位”在实测中对应更差的后续收益。
  if (Array.isArray(feature.overheatFlags) && feature.overheatFlags.length) {
    risks.push(`过热指标：${feature.overheatFlags.join("、")}`);
  }
  const strength = fieldRules.fieldSignalStrength(feature);
  const latest = numberOrNull(
    candidate?.latest,
    candidate?.price,
    candidate?.close,
    candidate?.quote?.latest,
    candidate?.quote?.close,
    feature.latest
  );
  const evidenceIds =
    definition.type === "composite" && Array.isArray(definition.components)
      ? definition.components
      : [definition.id];
  const componentEvidence = definition.componentEvidence ? definition.componentEvidence(feature) : evidenceIds.map((id) => {
    const component = STRATEGY_DEFINITION_BY_ID.get(id);
    return {
      id,
      name: component?.name || id,
      passed: component ? component.matches(feature) === true : false,
      source: "ohlcv_rule_engine",
      sourceDate: feature.date || ""
    };
  });
  return {
    code: identity.code,
    name: identity.name,
    industry: identity.industry,
    latest,
    changePct: feature.changePct ?? null,
    signalDate: feature.date || normalizeDate(candidate?.limitDate),
    signalStrength: Math.round(clamp(strength, 0, 100)),
    reasons,
    risks,
    historyBars: historyLength,
    matchSource: feature?.matchSource || "ohlcv",
    matchedStrategyIds: componentEvidence
      .filter((item) => item.passed)
      .map((item) => item.id),
    componentEvidence,
    strategyVersion: definition.version,
    ...(definition.technicalId && feature.signalCombinations ? { signalEvidence: {
      limit: feature.signalCombinations.limit, indicators: feature.signalCombinations.indicators,
      calendarComplete: feature.signalCombinations.calendarComplete,
      basis: "原始日线+板块常规限价；缺公司行为和官方历史状态完整性证明，收益为诊断"
    } } : {}),
    riskVetoStatus:
      feature?.riskVeto === false
        ? "failed"
        : feature?.matchSource === "ohlcv"
          ? "passed"
          : "unknown",
    metrics: {
      daysSinceLimit: feature.daysSinceLimit ?? null,
      consecutiveBoards: feature.consecutiveBoards ?? null,
      ma20ExtensionPercent: roundNullable(feature.ma20ExtensionPercent),
      return60Percent: roundNullable(feature.return60Percent),
      overheatCount: Number.isInteger(feature.overheatCount) ? feature.overheatCount : null,
      preLimitReturn20: roundNullable(feature.preLimitReturn20),
      boxWidth: roundNullable(feature.boxWidth),
      volumeRatio: roundNullable(feature.volumeRatio),
      postVolumeRatio: roundNullable(feature.postVolumeRatio),
      postRangePercent: roundNullable(feature.postRangePercent),
      eventGapPercent: roundNullable(feature.eventGapPercent),
      daysBetweenLimits: roundNullable(feature.daysBetweenLimits, 0),
      threeDayVolumeRatio: roundNullable(feature.threeDayVolumeRatio),
      eventLowerShadowRatio:
        finite(feature.eventLowerShadowRatio)
          ? round(Number(feature.eventLowerShadowRatio) * 100, 1)
          : null,
      closePosition:
        finite(feature.closePosition)
          ? round(Number(feature.closePosition) * 100, 1)
          : null,
      maxDrawdownSinceLimit: roundNullable(feature.maxDrawdownSinceLimit),
      heldSupport: feature.heldSupport ?? null,
      ma5: roundNullable(feature.ma5),
      ma10: roundNullable(feature.ma10),
      ma20: roundNullable(feature.ma20)
    }
  };
}

function resolvedOptions(raw = {}) {
  const rawSignalFrom = String(raw.signalFrom || "").slice(0, 10);
  const rawSignalTo = String(raw.signalTo || "").slice(0, 10);
  return {
    signalFrom: /^\d{4}-\d{2}-\d{2}$/.test(rawSignalFrom)
      ? rawSignalFrom
      : "",
    signalTo: /^\d{4}-\d{2}-\d{2}$/.test(rawSignalTo)
      ? rawSignalTo
      : "",
    customEntryPrice: finite(raw.customEntryPrice) && Number(raw.customEntryPrice) > 0
      ? clamp(Number(raw.customEntryPrice), 0.001, 1000000)
      : null,
    horizonDays: Math.round(
      clamp(numberOrNull(raw.horizonDays, DEFAULT_OPTIONS.horizonDays), 1, 20)
    ),
    cooldownDays: Math.round(
      clamp(numberOrNull(raw.cooldownDays, raw.horizonDays, DEFAULT_OPTIONS.cooldownDays), 0, 30)
    ),
    minSamples: Math.round(
      clamp(numberOrNull(raw.minSamples, DEFAULT_OPTIONS.minSamples), 6, 500)
    ),
    minOutOfSampleSamples: Math.round(
      clamp(
        numberOrNull(
          raw.minOutOfSampleSamples,
          DEFAULT_OPTIONS.minOutOfSampleSamples
        ),
        6,
        200
      )
    ),
    minIndependentSignalDays: Math.round(
      clamp(
        numberOrNull(
          raw.minIndependentSignalDays,
          DEFAULT_OPTIONS.minOutOfSampleSamples
        ),
        6,
        200
      )
    ),
    minWinRate: clamp(
      numberOrNull(raw.minWinRate, DEFAULT_OPTIONS.minWinRate),
      0,
      100
    ),
    minAverageReturn: clamp(
      numberOrNull(raw.minAverageReturn, DEFAULT_OPTIONS.minAverageReturn),
      -10,
      20
    ),
    maxDrawdown: clamp(
      numberOrNull(raw.maxDrawdown, DEFAULT_OPTIONS.maxDrawdown),
      -100,
      0
    ),
    roundTripCostBps: clamp(
      numberOrNull(raw.roundTripCostBps, DEFAULT_OPTIONS.roundTripCostBps),
      0,
      200
    ),
    outOfSampleRatio: clamp(
      numberOrNull(raw.outOfSampleRatio, DEFAULT_OPTIONS.outOfSampleRatio),
      0.15,
      0.5
    ),
    walkForwardFolds: Math.round(
      clamp(
        numberOrNull(raw.walkForwardFolds, DEFAULT_OPTIONS.walkForwardFolds),
        2,
        5
      )
    ),
    minWalkForwardFoldSamples: Math.round(
      clamp(
        numberOrNull(
          raw.minWalkForwardFoldSamples,
          DEFAULT_OPTIONS.minWalkForwardFoldSamples
        ),
        2,
        20
      )
    ),
    minCurrentHistoryBars: Math.round(
      clamp(
        numberOrNull(raw.minCurrentHistoryBars, DEFAULT_OPTIONS.minCurrentHistoryBars),
        20,
        420
      )
    ),
    minReturnLowerBound: clamp(
      numberOrNull(raw.minReturnLowerBound, DEFAULT_OPTIONS.minReturnLowerBound),
      -10,
      10
    ),
    maxStrategyOverlap: clamp(
      numberOrNull(raw.maxStrategyOverlap, DEFAULT_OPTIONS.maxStrategyOverlap),
      0.2,
      0.95
    ),
    optimizedMinVotes: Math.round(
      clamp(numberOrNull(raw.optimizedMinVotes, DEFAULT_OPTIONS.optimizedMinVotes), 2, 4)
    ),
    terminalHoldoutRatio: clamp(
      numberOrNull(raw.terminalHoldoutRatio, DEFAULT_OPTIONS.terminalHoldoutRatio),
      0.15,
      0.35
    ),
    strategyCount: ALL_STRATEGY_DEFINITIONS.length
  };
}

function derivedGeneratedAt(candidates, historiesByCode, benchmarkHistory, options) {
  if (options?.generatedAt) return String(options.generatedAt);
  const dates = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const value = normalizeDate(
      candidate?.date ?? candidate?.tradeDate ?? candidate?.limitDate
    );
    if (value) dates.push(value);
  }
  for (const [, rawHistory] of historyEntries(historiesByCode)) {
    const latest = normalizeHistory(rawHistory).at(-1)?.date;
    if (latest) dates.push(latest);
  }
  const benchmarkLatest = normalizeHistory(benchmarkHistory).at(-1)?.date;
  if (benchmarkLatest) dates.push(benchmarkLatest);
  const latestDate = dates.sort().at(-1);
  return latestDate ? `${latestDate}T15:00:00+08:00` : "";
}

const HISTORICAL_REVIEW_DEFAULTS = Object.freeze({
  horizonDays: 5,
  cooldownDays: 5,
  roundTripCostBps: roundTripBps(),
  minSamples: 20,
  minSignalDays: 8,
  baselineMaxDaysSinceLimit: 15,
  // 1：按“次日竞价高开超过4%或低开超过5%不买”统计（strategy-field-rules）；0：不加此规则。
  entryGapRule: 1
});

function reviewVerdict(summary, baseline, minSamples, minSignalDays) {
  if (!summary || summary.sampleCount < minSamples || summary.independentSignalDays < minSignalDays) {
    return { level: "insufficient", text: "历史样本不足，仅供观察" };
  }
  const edge = finite(baseline?.averageReturn) ? summary.averageReturn - baseline.averageReturn : null;
  const medianEdge = finite(baseline?.medianReturn) ? summary.medianReturn - baseline.medianReturn : null;
  if (edge !== null && edge > 0 && medianEdge !== null && medianEdge >= 0 && finite(summary.averageReturnLowerBound95) && summary.averageReturnLowerBound95 > 0) {
    return { level: "neutral", text: "本候选篮子的均值和中位数高于基线，历史股票池覆盖不足，仅作样本描述" };
  }
  if (edge !== null && edge < 0 && medianEdge !== null && medianEdge < 0) {
    return { level: "weak", text: "历史均值与中位数均低于同期近期涨停股基线" };
  }
  return { level: "neutral", text: "相对同期近期涨停股基线无稳定优势" };
}

/**
 * Historical reference for the selection page. Replays each rule over the
 * already-loaded daily bars with next-open entry, fixed holding and cost, and
 * compares it with buying any recent limit-up stock on the same days.
 * Only outcomes completed on or before `signalTo` count, so the limit-pool
 * window that chose these stocks cannot leak into the statistics. It is
 * reference information only and never filters or reorders current picks.
 */
function buildSelectionHistoricalReview(definitions, candidates, historiesByCode, benchmarkHistory, rawReview = {}) {
  const signalTo = normalizeDate(rawReview?.signalTo);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signalTo)) return null;
  const cfg = { ...HISTORICAL_REVIEW_DEFAULTS, ...Object.fromEntries(Object.entries(rawReview || {}).filter(([key, value]) => key in HISTORICAL_REVIEW_DEFAULTS && finite(value))) };
  const options = resolvedOptions({ horizonDays: cfg.horizonDays, cooldownDays: cfg.cooldownDays, roundTripCostBps: cfg.roundTripCostBps, signalTo });
  const benchmark = normalizeHistory(benchmarkHistory);
  const benchmarkByDate = new Map(benchmark.map(row => [row.date, row]));
  const marketDates = benchmark.map(row => row.date);
  const nextMarketDateByDate = new Map(marketDates.slice(0, -1).map((date, index) => [date, marketDates[index + 1]]));
  const pooled = definitions.map(() => ({ samples: [], observedEntries: 0, onePrice: 0, gapSkipped: 0 }));
  const policyUsesGapRule = cfg.entryGapRule !== 0;
  const baselineDefinition = {
    id: "recent_limit_baseline",
    matches: feature => Number.isInteger(feature.daysSinceLimit) && feature.daysSinceLimit <= cfg.baselineMaxDaysSinceLimit
  };
  const baselineReturns = [];
  const dataQuality = replayQuality();
  let stocks = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const identity = candidateIdentity(candidate);
    if (!identity.code) { dataQuality.missingCodes++; continue; }
    const history = normalizeHistory(historyForCode(historiesByCode, identity.code), dataQuality, signalTo);
    if (history.length < 80) { dataQuality.insufficientHistories++; continue; }
    stocks += 1;
    const featureTimeline = buildFeatureTimeline(history, identity.code, identity.code, benchmark);
    const policy = { featureTimeline, requireNextMarketDay: marketDates.length > 0, nextMarketDateByDate, entryGapRule: policyUsesGapRule };
    definitions.forEach((definition, index) => {
      const replay = replayStrategy(definition, identity.code, identity.name, history, benchmarkByDate, options, policy);
      pooled[index].samples.push(...replay.samples);
      // Entry feasibility is already known for pending exits. Signals without
      // an observed next-market-day open must not dilute the unbuyable rate.
      pooled[index].observedEntries += replay.samples.length
        + replay.pendingSignals.filter(signal => signal.entryDate).length
        + replay.rejectedSignals.filter(signal => signal.entryDate && signal.reason !== "missingNextMarketDay").length;
      pooled[index].onePrice += replay.untradeableReasons.nextDayOnePriceLimitUp;
      pooled[index].gapSkipped += replay.untradeableReasons.entryGapOutOfRange || 0;
    });
    // Keep entry dates, delayed untradeable exits, costs and same-stock signal
    // spacing identical to the strategies; only the selection rule differs.
    const baselineReplay = replayStrategy(baselineDefinition, identity.code, identity.name, history, benchmarkByDate, options, policy);
    baselineReturns.push(...baselineReplay.samples.map(sample => sample.netReturn));
  }
  const baseline = baselineReturns.length ? {
    sampleCount: baselineReturns.length,
    averageReturn: round(average(baselineReturns)),
    medianReturn: round(median(baselineReturns)),
    winRate: round(baselineReturns.filter(value => value > 0).length / baselineReturns.length * 100, 2)
  } : null;
  const strategies = {};
  definitions.forEach((definition, index) => {
    const entry = pooled[index];
    const summary = entry.samples.length ? summarizeSamples(entry.samples) : null;
    const attempted = entry.observedEntries;
    strategies[definition.id] = {
      sampleCount: summary?.sampleCount || 0,
      independentSignalDays: summary?.independentSignalDays || 0,
      winRate: summary?.winRate ?? null,
      winRateInterval95: summary?.winRateInterval95 ?? null,
      averageReturn: summary?.averageReturn ?? null,
      medianReturn: summary?.medianReturn ?? null,
      averageReturnLowerBound95: summary?.averageReturnLowerBound95 ?? null,
      averageExcessReturn: summary?.averageExcessReturn ?? null,
      worstTradeDrawdown: summary?.worstTradeDrawdown ?? null,
      edgeVsBaseline: summary && baseline ? round(summary.averageReturn - baseline.averageReturn) : null,
      medianEdgeVsBaseline: summary && baseline ? round(summary.medianReturn - baseline.medianReturn) : null,
      // Practicality: share of signals whose next open was already limit-up (not buyable).
      nextDayUnbuyableRate: attempted ? round(entry.onePrice / attempted * 100, 1) : null,
      entryGapSkippedRate: attempted && policyUsesGapRule ? round(entry.gapSkipped / attempted * 100, 1) : null,
      range: summary?.range || { from: "", to: "" },
      verdict: reviewVerdict(summary, baseline, cfg.minSamples, cfg.minSignalDays)
    };
  });
  return {
    method: `次日开盘买入、持有${options.horizonDays}个交易日收盘卖出、双边成本${options.roundTripCostBps / 100}%；同股信号间隔${options.cooldownDays}日；退出日跌停或无成交则顺延；基线采用相同撮合与信号间隔。次日开盘即涨停视为买不到并剔除，比例按已观察到次日开盘的信号统计。${policyUsesGapRule ? `${fieldRules.ENTRY_GAP_TEXT}，这部分信号放弃、不计收益（基线同样处理）。` : ""}`,
    entryRule: policyUsesGapRule ? fieldRules.ENTRY_GAP_TEXT : "",
    baselineDefinition: `基线：同期任一近${cfg.baselineMaxDaysSinceLimit}个交易日内涨停过的候选股，次日开盘买入的同口径收益。`,
    caveat: "样本只来自本轮候选股在入选窗口之前的日线（约1年），存在幸存者与样本选择偏差；仅作参考，不代表未来收益，也不参与选股。",
    dataQuality, universe: { pointInTime: false, survivorBias: true },
    signalTo, stockCount: stocks, horizonDays: options.horizonDays, roundTripCostBps: options.roundTripCostBps,
    baseline, strategies
  };
}

/** Expose only an already-validated support used by this strategy; this never changes qualification. */
function selectionInvalidation(definition, feature) {
  if (definition.id === "volume_rebound_hold") {
    const detail = feature.volumeReboundHoldDetail;
    return detail?.passed && detail.heldBigYangLow && finite(detail.bigYangLow) && detail.bigYangLow > 0
      ? { price: round(detail.bigYangLow, 2), note: `失效依据：${detail.bigYangDate} 大阳最低价；跌破该价即反弹失败。` }
      : { price: null };
  }
  if (definition.id === "youzi_dragon_pullback") {
    const detail = feature.youziDetail?.dragonPullback;
    return finite(detail?.pullbackLow) && detail.pullbackLow > 0 && detail.pullbackLow >= detail.launchPrice
      ? { price: round(detail.pullbackLow, 2), note: "失效依据：本轮回调低点；再次放量跌破该价时龙回头逻辑失效。" }
      : { price: null };
  }
  // 底部趋势：以底部首板最低价为界。已经跌破的不给失效价，但写明（实测这类样本 20 日超额不低于守住的，胜率较低，保留选出）。
  if (definition.family === "bottom_trend") {
    if (feature.bottomHeldLow === true && finite(feature.bottomBoardLow) && feature.bottomBoardLow > 0) {
      return { price: round(Number(feature.bottomBoardLow) * 0.995, 2), note: `失效依据：底部首板（${feature.bottomBoardDate || "--"}）最低价×0.995。` };
    }
    return feature.bottomHeldLow === false && finite(feature.bottomBoardLow)
      ? { price: null, note: `已跌破底部首板（${feature.bottomBoardDate || "--"}）最低价 ${round(Number(feature.bottomBoardLow), 2)}：胜率较守住的低，仓位从轻，无明确失效价。` }
      : { price: null };
  }
  // Other youzi rules and arbitrary custom conditions have no proven numeric exit boundary.
  if (definition.custom || definition.family === "youzi") return { price: null };
  return feature.heldSupport === true && finite(feature.eventLow) && feature.eventLow > 0
    ? { price: round(Number(feature.eventLow) * 0.995, 2), note: "失效依据：涨停日最低价×0.995（原有涨停日支撑边界）。" }
    : { price: null };
}

/** Run the current rule snapshot; optionally attach a historical reference that never gates picks. */
function buildStrategySelectionReport(candidates = [], historiesByCode = {}, benchmarkHistory = [], rawOptions = {}) {
  const context = selectionRules.selectionContext(rawOptions, benchmarkHistory);
  const benchmark = normalizeHistory(context.benchmark);
  const requestedIds = new Set(Array.isArray(rawOptions.strategyIds) ? rawOptions.strategyIds.map(String) : []);
  // 默认（策略选股页）只跑在用策略；明确按 id 指定时（研究、回测联动）也可以跑已下线的策略。
  const builtIns = rawOptions.includeBuiltIn === false ? [] : requestedIds.size
    ? ALL_STRATEGY_DEFINITIONS.filter(definition => requestedIds.has(definition.id)) : STRATEGY_DEFINITIONS;
  const custom = compileCustomDefinitions(rawOptions.customStrategies, rawOptions.universe || "limit_pool");
  const definitions = [...builtIns, ...custom.definitions];
  const strategies = definitions.map(({ matches: _matches, reasons: _reasons, componentEvidence: _evidence, evaluate: _evaluate, ...definition }) => ({ ...definition, stocks: [] }));
  const byCode = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const identity = candidateIdentity(candidate);
    if (identity.code) byCode.set(identity.code, { candidate, identity });
  }
  const dataQuality = { requested: byCode.size, processed: 0, invalid: 0, stale: 0, missing: 0, excluded: 0,
    benchmarkReady: context.benchmarkReady, benchmarkReason: context.benchmarkReason,
    calendarState: context.calendarReady ? "ready" : "unknown", requiredBars: context.requiredBars, reasons: {} };
  const countIssue = reason => { dataQuality.reasons[reason] = (dataQuality.reasons[reason] || 0) + 1; };
  for (const { candidate, identity } of byCode.values()) {
    if (isRiskSecurityName(identity.name) || [candidate?.isST, candidate?.st, candidate?.security?.isST, candidate?.quote?.isST].some(value => value === true)) {
      dataQuality.excluded++; countIssue("risk_security"); continue;
    }
    // A supplied listing date inside the required window proves ineligibility.
    // A short history alone cannot distinguish a new listing from recoverable missing data.
    if (context.calendarReady && context.stockDates.indexOf(candidate?.listingDate) > 0) {
      dataQuality.excluded++; countIssue("insufficient_listing_sessions"); continue;
    }
    const prepared = selectionRules.prepareStock(historyForCode(historiesByCode, identity.code), context);
    if (prepared.state !== "ready") {
      dataQuality[prepared.state]++; countIssue(prepared.reason); continue;
    }
    const history = normalizeHistory(prepared.rows);
    if (history.at(-1)?.isST === true) { dataQuality.excluded++; countIssue("risk_security"); continue; }
    // Combination indicators need their causal timeline; base features need only the latest snapshot.
    const combinationTimeline = priceSafeCombinationTimeline(history, identity.code, identity.name, benchmark);
    const baseFeature = featureSnapshot(history, history.length - 1, identity.code, identity.name, null, combinationTimeline);
    if (!baseFeature) { dataQuality.invalid++; countIssue("unresolved_price_basis"); continue; }
    dataQuality.processed++;
    const feature = baseFeature;
    // 外部明确否决的候选整体排除；日线风险否决（跌破涨停日低点、量能异常）交给各策略自己判断：
    // 绝大多数策略的条件里本来就要求它，龙回头、下跌后放量大阳等自带承接规则的策略不要求。
    if (candidate?.riskVeto === false) {
      dataQuality.excluded++; countIssue("risk_veto"); continue;
    }
    if (feature.riskVeto === false) countIssue("risk_veto_flagged");
    const executionNotes = selectionExecutionNotes(history, feature, identity);
    definitions.forEach((definition, index) => {
      const evaluation = definition.custom ? definition.evaluate(feature) : null;
      if (evaluation ? !evaluation.passed : !definition.matches(feature)) return;
      // A historical limit-pool quote must not replace the latest daily bar.
      const stock = stockSignal(definition, {}, identity, feature, history.length);
      const invalidation = selectionInvalidation(definition, feature);
      strategies[index].stocks.push({
        code: stock.code, name: stock.name, industry: stock.industry,
        secid: String(candidate?.secid || `${stock.code.startsWith("6") ? "1" : "0"}.${stock.code}`),
        latest: stock.latest, changePct: feature.currentReturn,
        turnover: numberOrNull(history.at(-1)?.turnover),
        amount: numberOrNull(history.at(-1)?.amount),
        limitDate: feature.eventDate || "", signalDate: stock.signalDate,
        daysSinceLimit: Number.isInteger(feature.daysSinceLimit) ? feature.daysSinceLimit : null,
        invalidationPrice: invalidation.price,
        consecutiveBoards: Number.isInteger(feature.consecutiveBoards) ? feature.consecutiveBoards : null,
        signalStrength: stock.signalStrength,
        overheatCount: Number.isInteger(feature.overheatCount) ? feature.overheatCount : null,
        reasons: stock.reasons.slice(0, 3),
        executionNotes: invalidation.note ? [...executionNotes, invalidation.note] : executionNotes,
        ...(evaluation ? { matchRate: evaluation.matchRate, needsConfirmation: evaluation.needsConfirmation, pendingConditions: evaluation.pending } : {})
      });
    });
  }
  for (const strategy of strategies) {
    // Custom strategies rank by how many of the user's own conditions hold first.
    strategy.stocks.sort((left, right) => (right.matchRate ?? 0) - (left.matchRate ?? 0) || right.signalStrength - left.signalStrength || left.code.localeCompare(right.code));
  }
  strategies.push(...custom.errors);
  let historicalReview = null;
  if (rawOptions.historicalReview && typeof rawOptions.historicalReview === "object") {
    try {
      historicalReview = buildSelectionHistoricalReview(definitions, [...byCode.values()].map(item => item.candidate), historiesByCode, benchmarkHistory, rawOptions.historicalReview);
    } catch (error) {
      historicalReview = { error: error instanceof Error ? error.message : String(error) };
    }
    if (historicalReview?.strategies) {
      for (const strategy of strategies) {
        if (strategy.error) continue;
        strategy.history = historicalReview.strategies[strategy.id] || null;
        if (strategy.history && strategy.hasExternal) strategy.history.pendingAssumed = true;
      }
    }
  }
  return {
    mode: "selection", generatedAt: rawOptions.generatedAt || new Date().toISOString(),
    asOfDate: context.asOfDate, dataQuality,
    qualifiedCount: new Set(strategies.flatMap(group => group.stocks.map(stock => stock.code))).size,
    strategies,
    ...(historicalReview ? { historicalReview: { ...historicalReview, strategies: undefined } } : {})
  };
}

/**
 * Compile the user's saved strategies for this universe. A strategy that no
 * longer validates is reported with its error instead of failing the run.
 */
function compileCustomDefinitions(list, universe) {
  // 已下线的策略不参与选股，但「我的策略」里引用它们作条件的仍可判断。
  const patternMatchers = new Map(ALL_STRATEGY_DEFINITIONS.map(definition => [definition.id, definition.matches]));
  const patternNames = new Map(ALL_STRATEGY_DEFINITIONS.map(definition => [definition.id, definition.name]));
  const patternIds = new Set(patternMatchers.keys());
  const definitions = [], errors = [];
  for (const raw of Array.isArray(list) ? list : []) {
    try {
      const strategy = customStrategy.normalizeCustomStrategy(raw, { patternIds });
      if (!strategy.id) throw new Error("策略缺少编号，请重新保存");
      if (strategy.universe !== universe) continue;
      definitions.push(customStrategy.compileCustomStrategy(strategy, { patternMatchers, patternNames }));
    } catch (error) {
      if (raw && typeof raw === "object" && raw.universe && raw.universe !== universe) continue;
      errors.push({ id: String(raw?.id || "custom-invalid"), name: String(raw?.name || "自定义策略"), type: "custom", custom: true, family: "custom",
        version: "", detail: "", conditions: [], stocks: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { definitions, errors };
}

/** Practical next-session cautions for a current pick; descriptive only, never a filter. */
function selectionExecutionNotes(history, feature, identity) {
  const notes = [];
  const latest = history.at(-1), previous = history.at(-2);
  if (feature.isCurrentLimit === true) {
    const onePrice = latest && previous && isOnePriceLimitUpEntry(Number(previous.close), latest, identity.code, identity.name);
    notes.push(onePrice ? "今日一字涨停：次日大概率高开或继续一字，难以按计划买入" : `今日涨停：${fieldRules.ENTRY_GAP_TEXT}`);
  }
  if (Array.isArray(feature.overheatFlags) && feature.overheatFlags.length) notes.push(`过热指标：${feature.overheatFlags.join("、")}`);
  if (Number.isInteger(feature.consecutiveBoards) && feature.consecutiveBoards >= 3 && feature.daysSinceLimit !== null && feature.daysSinceLimit <= 3) {
    notes.push(`近期${feature.consecutiveBoards}连板，高位分歧风险大`);
  }
  const amount = numberOrNull(latest?.amount);
  if (amount !== null && amount < 1e8) notes.push("当日成交额不足1亿元，注意冲击成本与流动性");
  if (finite(feature.maxDrawdownSinceLimit) && feature.maxDrawdownSinceLimit < -10) notes.push("涨停后最大回撤超过10%");
  return notes;
}

/**
 * Build a deterministic strategy signal and validation report from caller-provided
 * candidate snapshots and OHLCV histories. This function performs no I/O.
 */
function buildStrategySignalReport(
  candidates = [],
  historiesByCode = {},
  benchmarkHistory = [],
  rawOptions = {}
) {
  const options = resolvedOptions(rawOptions);
  const candidateRows = Array.isArray(candidates) ? candidates : [];
  const candidateByCode = new Map();
  for (const candidate of candidateRows) {
    const identity = candidateIdentity(candidate);
    if (identity.code) candidateByCode.set(identity.code, { candidate, identity });
  }
  const benchmark = normalizeHistory(benchmarkHistory);
  const benchmarkByDate = new Map(benchmark.map((row) => [row.date, row]));
  const regimeState = marketRegimeState(benchmark);
  const requestedCurrentCodes = Array.isArray(rawOptions?.currentCandidateCodes)
    ? new Set(rawOptions.currentCandidateCodes.map(String))
    : null;
  const replayHistories = new Map();
  const historicalDataQuality = replayQuality();
  for (const [rawCode, rawHistory] of historyEntries(historiesByCode)) {
    const fallbackIdentity = candidateIdentity(undefined, rawCode);
    const identity =
      candidateByCode.get(fallbackIdentity.code)?.identity || fallbackIdentity;
    const history = normalizeHistory(rawHistory, historicalDataQuality);
    if (identity.code && history.length) replayHistories.set(identity.code, history);
  }

  const replayByStrategyId = new Map(
    ALL_STRATEGY_DEFINITIONS.map((definition) => [
      definition.id,
      {
        allSamples: [],
        untradeableCount: 0,
        untradeableReasons: {
          nextDayOnePriceLimitUp: 0,
          suspendedOrNoLiquidity: 0,
          invalidPrice: 0,
          missingNextMarketDay: 0
        }
      }
    ])
  );
  const latestFeatureByCode = new Map();

  // Stock-first execution keeps only one feature timeline in memory at a time.
  // Every definition then consumes the exact same precomputed
  // daily evidence instead of independently rescanning the same OHLCV history.
  for (const [code, history] of replayHistories.entries()) {
    const candidateRecord = candidateByCode.get(code);
    const name = candidateRecord?.identity?.name || code;
    const featureTimeline = buildFeatureTimeline(history, code, code, benchmark);
    latestFeatureByCode.set(code, featureTimeline.at(-1) || null);
    for (const definition of ALL_STRATEGY_DEFINITIONS) {
      const replay = replayStrategy(
        definition,
        code,
        name,
        history,
        benchmarkByDate,
        options,
        { featureTimeline }
      );
      const accumulator = replayByStrategyId.get(definition.id);
      accumulator.allSamples.push(...replay.samples);
      accumulator.untradeableCount += replay.untradeableCount;
      accumulator.untradeableReasons.nextDayOnePriceLimitUp +=
        Number(replay.untradeableReasons?.nextDayOnePriceLimitUp) || 0;
      accumulator.untradeableReasons.suspendedOrNoLiquidity +=
        Number(replay.untradeableReasons?.suspendedOrNoLiquidity) || 0;
      accumulator.untradeableReasons.invalidPrice +=
        Number(replay.untradeableReasons?.invalidPrice) || 0;
      accumulator.untradeableReasons.missingNextMarketDay +=
        Number(replay.untradeableReasons?.missingNextMarketDay) || 0;
    }
  }

  const strategies = ALL_STRATEGY_DEFINITIONS.map((definition) => {
    const accumulator = replayByStrategyId.get(definition.id);
    const allSamples = accumulator.allSamples;
    const untradeableCount = accumulator.untradeableCount;
    const untradeableReasons = accumulator.untradeableReasons;
    const rawValidation = buildValidation(
      allSamples,
      untradeableCount,
      untradeableReasons,
      options
    );
    const regimeEvidence = buildRegimeEvidence(allSamples, regimeState, options);
    const validation = {
      ...rawValidation,
      regimes: regimeEvidence.regimes,
      currentRegimeFit: regimeEvidence.currentFit,
      validationVersion: "robust-v2"
    };
    const stocks = [];
    for (const { candidate, identity } of candidateByCode.values()) {
      const requiresTechnicalEligibility = Boolean(definition.technicalId) || definition.id === "relative_strength_pullback";
      if (requiresTechnicalEligibility && [candidate?.isST, candidate?.st, candidate?.security?.isST, candidate?.quote?.isST].some(value => value === true)) continue;
      if (isRiskSecurityName(identity.name)) continue;
      if (requestedCurrentCodes && !requestedCurrentCodes.has(identity.code)) continue;
      const history =
        replayHistories.get(identity.code) ||
        normalizeHistory(historyForCode(historiesByCode, identity.code));
      if (history.length < options.minCurrentHistoryBars) continue;
      const baseFeature = replayHistories.has(identity.code)
        ? latestFeatureByCode.get(identity.code) || null
        : history.length
          ? featureSnapshot(history, history.length - 1, identity.code, identity.name)
          : null;
      const feature = enhanceCurrentFeature(
        baseFeature,
        candidate,
        identity.code,
        identity.name
      );
      if (!definition.matches(feature) || feature.riskVeto === false) continue;
      stocks.push(
        stockSignal(definition, candidate, identity, feature, history.length)
      );
    }
    stocks.sort(
      (left, right) =>
        right.signalStrength - left.signalStrength ||
        left.code.localeCompare(right.code)
    );
    return {
      id: definition.id,
      type: definition.type || "base",
      name: definition.name,
      ...(definition.version ? { version: definition.version, parameters: { ...definition.parameters },
        sources: definition.sources.map(item => ({ ...item })), adaptationNote: definition.adaptationNote,
        componentNames: [...definition.componentNames] } : {}),
      detail: definition.detail,
      conditions: [...definition.conditions],
      risk: definition.risk,
      components: Array.isArray(definition.components)
        ? [...definition.components]
        : [],
      voteRule: definition.voteRule || "",
      validation,
      _samples: allSamples,
      stocks: stocks.map((stock, index) => ({
        ...stock,
        rank: index + 1,
        validationPassed: validation.accepted
      }))
    };
  });

  const optimizedPortfolio = buildOptimizedPortfolio(
    strategies.map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      type: strategy.type,
      samples: strategy._samples,
      untradeableCount: strategy.validation.untradeableCount,
      untradeableReasons: strategy.validation.untradeableReasons,
      stocks: strategy.stocks
    })),
    regimeState,
    options
  );
  const publicStrategies = strategies.map(({ _samples, ...strategy }) => strategy);

  return {
    generatedAt: derivedGeneratedAt(
      candidateRows,
      historiesByCode,
      benchmarkHistory,
      rawOptions
    ),
    source: "provided_ohlcv_replay",
    currentRegime: regimeState.current,
    sourceNote: "仅使用调用方提供的候选快照、个股OHLCV与基准OHLCV；未联网且未补造行情。",
    methodology: {
      signalTiming: "每个历史信号只使用信号日及以前的数据",
      entry: "次一交易日开盘价",
      exit: `入场后第${options.horizonDays}个交易日收盘价`,
      costs: `双边合计 ${options.roundTripCostBps} bps`,
      maxDrawdown: "同一信号日股票先等权聚合，按持有期分摊仓位后顺序复利估算回撤；真实账户以组合盯市曲线为准",
      split: `前 ${(1 - options.outOfSampleRatio) * 100}% 训练 / 后 ${options.outOfSampleRatio * 100}% 样本外`,
      splitGuard: "同一信号日的全部股票只会落在训练集或样本外之一，禁止跨集合泄漏",
      walkForward: "按独立信号日执行扩展训练窗 + 不重叠连续样本外窗口",
      multipleTesting: validationHurdles(options).method,
      stability: "至少三个时间分段，要求三分之二以上分段为正且单股样本占比不超过35%"
    },
    optimizedPortfolio,
    historicalDataQuality, universe: { pointInTime: false, survivorBias: true },
    coverage: {
      candidateCount: candidateRows.length,
      currentCandidateCount: requestedCurrentCodes
        ? requestedCurrentCodes.size
        : candidateRows.length,
      historiesProvided: historyEntries(historiesByCode).length,
      historiesUsed: replayHistories.size,
      benchmarkBars: benchmark.length
    },
    strategies: publicStrategies
  };
}

function benchmarkReplayContext(rawBenchmarkHistory) {
  const benchmark = normalizeHistory(rawBenchmarkHistory);
  return {
    benchmark,
    benchmarkByDate: new Map(benchmark.map(row => [row.date, row])),
    nextMarketDateByDate: new Map(benchmark.map((row, index) => [row.date, benchmark[index + 1]?.date || ""])),
    regimeState: marketRegimeState(benchmark)
  };
}

function stockReplayContext(security, rawHistory, benchmarkContext) {
  const historicalDataQuality = replayQuality();
  const history = normalizeHistory(rawHistory, historicalDataQuality);
  const code = String(security?.code || "").match(/\d{6}/)?.[0] || "";
  return { ...benchmarkContext, history, historicalDataQuality, featureTimeline: buildFeatureTimeline(history, code, code, benchmarkContext.benchmark) };
}

function buildSelectedStrategyReplayBundle(strategyIds, security, history, benchmarkHistory, options = {}) {
  const context = stockReplayContext(security, history, benchmarkReplayContext(benchmarkHistory));
  const replay = buildSelectedStrategyReplay(strategyIds, security, history, benchmarkHistory, options, context);
  const replaysById = {};
  if (strategyIds.length > 1) for (const id of strategyIds) {
    replaysById[id] = buildSelectedStrategyReplay([id], security, history, benchmarkHistory, {
      ...options, strategyId: id, strategyName: String(STRATEGY_DEFINITION_BY_ID.get(id)?.name || id), minimumVotes: 1
    }, context);
  }
  return { replay, replaysById };
}

/**
 * Replay one selected signal strategy (or a low-correlation strategy vote)
 * against a single stock history. Unlike the legacy analysis-factor replay,
 * this uses the exact same versioned definitions as the strategy-signal page.
 */
function buildSelectedStrategyReplay(
  rawStrategyIds = [],
  security = {},
  rawHistory = [],
  rawBenchmarkHistory = [],
  rawOptions = {},
  preparedContext = null
) {
  const requestedIds = Array.isArray(rawStrategyIds)
    ? rawStrategyIds
    : [rawStrategyIds];
  const strategyIds = [...new Set(
    requestedIds.map((item) => String(item || "").trim()).filter(Boolean)
  )];
  const definitions = strategyIds
    .map((id) => STRATEGY_DEFINITION_BY_ID.get(id))
    .filter(Boolean);
  const unknownIds = strategyIds.filter(
    (id) => !STRATEGY_DEFINITION_BY_ID.has(id)
  );
  if (unknownIds.length) {
    throw new Error(`未知策略：${unknownIds.join("、")}`);
  }
  if (!definitions.length) {
    throw new Error("未选择可回放的策略信号");
  }

  const code = String(security?.code || "").match(/\d{6}/)?.[0] || "";
  const name = String(security?.name || code || "").trim() || code;
  if (!code) throw new Error("缺少可回放的股票代码");
  const context = preparedContext || stockReplayContext(security, rawHistory, benchmarkReplayContext(rawBenchmarkHistory));
  const { history, benchmark, benchmarkByDate, nextMarketDateByDate, regimeState, featureTimeline } = context;
  const options = resolvedOptions(rawOptions);
  const minimumVotes = Math.round(
    clamp(
      numberOrNull(rawOptions.minimumVotes, definitions.length > 1 ? 2 : 1),
      1,
      definitions.length
    )
  );
  const definition = definitions.length === 1
    ? definitions[0]
    : {
        id: String(rawOptions.strategyId || "optimized_strategy_vote"),
        type: "optimized",
        name: String(rawOptions.strategyName || "稳健优选组合"),
        detail: `${definitions.length}套已选策略中至少${minimumVotes}票同日共振`,
        conditions: definitions.map((item) => item.name),
        risk: "组合投票降低单一规则偶然性，但不消除行情切换与样本不足风险。",
        components: definitions.map((item) => item.id),
        voteRule: `至少 ${minimumVotes}/${definitions.length} 套策略在同一交易日命中`,
        matches: (feature) =>
          feature?.riskVeto !== false &&
          definitions.filter((item) => item.matches(feature) === true).length >= minimumVotes,
        reasons: () => []
      };
  const replay = replayStrategy(
    definition,
    code,
    name,
    history,
    benchmarkByDate,
    options,
    {
      requireNextMarketDay: true,
      nextMarketDateByDate,
      featureTimeline
    }
  );
  const validation = buildValidation(
    replay.samples,
    replay.untradeableCount,
    replay.untradeableReasons,
    options
  );
  const regimeEvidence = buildRegimeEvidence(
    replay.samples,
    regimeState,
    options
  );

  return {
    id: definition.id,
    type: definition.type || "base",
    name: definition.name,
    ...(definition.version ? { version: definition.version, parameters: { ...definition.parameters },
      sources: definition.sources.map(item => ({ ...item })), adaptationNote: definition.adaptationNote } : {}),
    detail: definition.detail,
    components: Array.isArray(definition.components)
      ? [...definition.components]
      : definitions.map((item) => item.id),
    componentNames: definition.componentNames?.length ? [...definition.componentNames] : definitions.map((item) => item.name),
    voteRule: definition.voteRule || "单策略逐日命中",
    validation: {
      ...validation,
      regimes: regimeEvidence.regimes,
      currentRegimeFit: regimeEvidence.currentFit,
      validationVersion: "robust-v2-single-stock"
    },
    currentRegime: regimeState.current,
    historicalDataQuality: context.historicalDataQuality,
    universe: { pointInTime: false, survivorBias: true },
    historyBars: history.length,
    benchmarkBars: benchmark.length,
    matchedSignalCount: replay.matchedSignalCount,
    pendingCount: replay.pendingCount,
    untradeableCount: replay.untradeableCount,
    untradeableReasons: { ...replay.untradeableReasons },
    samples: replay.samples.map((sample) => ({ ...sample })),
    rejectedSignals: replay.rejectedSignals.map((signal) => ({ ...signal })),
    pendingSignals: replay.pendingSignals.map((signal) => ({ ...signal }))
  };
}

/**
 * Replay the same selected strategy definition across multiple securities and
 * return one combined validation/sample contract for the shared-account
 * portfolio simulator. No current candidate fields or network data are used.
 */
function buildSelectedStrategyPortfolioReplay(
  rawStrategyIds = [],
  securities = [],
  historiesByCode = {},
  benchmarkHistory = [],
  rawOptions = {}
) {
  if (!Array.isArray(securities) || !securities.length) {
    throw new TypeError("securities 必须包含至少一只股票");
  }
  const securityByCode = new Map();
  for (const raw of securities) {
    const security = typeof raw === "string" ? { code: raw } : (raw || {});
    const code = String(security.code || "").match(/\d{6}/)?.[0] || "";
    if (!code) throw new TypeError("securities 中存在无效股票代码");
    if (!securityByCode.has(code)) {
      securityByCode.set(code, {
        ...security,
        code,
        name: String(security.name || code)
      });
    }
  }
  const benchmarkContext = benchmarkReplayContext(benchmarkHistory);
  const { benchmark, nextMarketDateByDate: nextBenchmarkDate, regimeState } = benchmarkContext;
  const benchmarkDates = benchmark.map(row => row.date);
  const options = resolvedOptions(rawOptions);
  const perSecurity = [];
  const samples = [];
  let untradeableCount = 0;
  const untradeableReasons = {
    nextDayOnePriceLimitUp: 0,
    suspendedOrNoLiquidity: 0,
    invalidPrice: 0,
    missingNextMarketDay: 0
  };
  const rejections = [];
  const pendingSignals = [];
  let portfolioIdentity = null;
  for (const security of [...securityByCode.values()].sort((left, right) =>
    left.code.localeCompare(right.code)
  )) {
    const rawHistory = historyForCode(historiesByCode, security.code);
    if (!Array.isArray(rawHistory) || !rawHistory.length) {
      throw new TypeError(`股票 ${security.code} 缺少策略回放历史`);
    }
    const replay = buildSelectedStrategyReplay(
      rawStrategyIds,
      security,
      rawHistory,
      benchmark,
      rawOptions,
      stockReplayContext(security, rawHistory, benchmarkContext)
    );
    portfolioIdentity ||= replay;
    const perSecurityRejections = replay.rejectedSignals.map((signal) => ({
      ...signal,
      status: "rejected"
    }));
    const perSecurityPending = replay.pendingSignals.map((signal) => ({
      ...signal,
      status: "pending"
    }));
    rejections.push(...perSecurityRejections);
    pendingSignals.push(...perSecurityPending);
    let missingNextMarketDayCount = 0;
    const tradableSamples = replay.samples.filter((sample) => {
      if (!benchmarkDates.length) return true;
      const expectedEntryDate = nextBenchmarkDate.get(sample.signalDate) || "";
      if (sample.entryDate === expectedEntryDate) return true;
      const rejection = {
        sampleId: sample.sampleId,
        code: security.code,
        name: security.name,
        strategyId: sample.strategyId,
        strategyIds: [...(sample.strategyIds || [sample.strategyId])],
        signalDate: sample.signalDate,
        entryDate: sample.entryDate,
        exitDate: sample.exitDate,
        expectedEntryDate,
        status: "rejected",
        reason: "missingNextMarketDay",
        reasonText: "信号后的下一市场交易日缺少可成交K线，按停牌或缺失行情剔除"
      };
      missingNextMarketDayCount += 1;
      perSecurityRejections.push(rejection);
      rejections.push(rejection);
      return false;
    });
    samples.push(...tradableSamples.map((sample) => ({ ...sample })));
    untradeableCount += Number(replay.untradeableCount || 0);
    untradeableCount += missingNextMarketDayCount;
    untradeableReasons.nextDayOnePriceLimitUp +=
      Number(replay.untradeableReasons?.nextDayOnePriceLimitUp || 0);
    untradeableReasons.suspendedOrNoLiquidity +=
      Number(replay.untradeableReasons?.suspendedOrNoLiquidity || 0);
    untradeableReasons.invalidPrice +=
      Number(replay.untradeableReasons?.invalidPrice || 0);
    const replayMissingNextMarketDayCount = Number(
      replay.untradeableReasons?.missingNextMarketDay || 0
    );
    untradeableReasons.missingNextMarketDay +=
      replayMissingNextMarketDayCount + missingNextMarketDayCount;
    const perSecurityValidation = missingNextMarketDayCount === 0 ? replay.validation : buildValidation(
      tradableSamples,
      Number(replay.untradeableCount || 0) + missingNextMarketDayCount,
      {
        ...replay.untradeableReasons,
        missingNextMarketDay:
          replayMissingNextMarketDayCount + missingNextMarketDayCount
      },
      options
    );
    const perSecurityRegime = buildRegimeEvidence(
      tradableSamples,
      regimeState,
      options
    );
    perSecurity.push({
      code: security.code,
      name: security.name,
      historicalDataQuality: replay.historicalDataQuality,
      historyBars: replay.historyBars,
      sampleCount: tradableSamples.length,
      matchedSignalCount:
        tradableSamples.length + perSecurityRejections.length + perSecurityPending.length,
      rejectedSampleCount: perSecurityRejections.length,
      pendingCount: perSecurityPending.length,
      validation: {
        ...perSecurityValidation,
        regimes: perSecurityRegime.regimes,
        currentRegimeFit: perSecurityRegime.currentFit,
        validationVersion: "robust-v2-multi-stock-security"
      },
      samples: tradableSamples.map((sample) => ({ ...sample })),
      rejections: perSecurityRejections,
      pendingSignals: perSecurityPending
    });
  }
  samples.sort((left, right) =>
    `${left.signalDate}:${left.code}:${left.strategyId}`.localeCompare(
      `${right.signalDate}:${right.code}:${right.strategyId}`
    )
  );
  rejections.sort((left, right) =>
    `${left.signalDate}:${left.code}:${left.strategyId}`.localeCompare(
      `${right.signalDate}:${right.code}:${right.strategyId}`
    )
  );
  pendingSignals.sort((left, right) =>
    `${left.signalDate}:${left.code}:${left.strategyId}`.localeCompare(
      `${right.signalDate}:${right.code}:${right.strategyId}`
    )
  );
  const rawValidation = buildValidation(
    samples,
    untradeableCount,
    untradeableReasons,
    options
  );
  const regimeEvidence = buildRegimeEvidence(samples, regimeState, options);
  return {
    id: portfolioIdentity.id,
    type: "multi_stock_portfolio",
    name: `${portfolioIdentity.name} · 多股票统一组合`,
    ...(portfolioIdentity.version ? { version: portfolioIdentity.version, parameters: { ...portfolioIdentity.parameters },
      sources: portfolioIdentity.sources.map(item => ({ ...item })), adaptationNote: portfolioIdentity.adaptationNote } : {}),
    detail: portfolioIdentity.detail,
    components: [...portfolioIdentity.components],
    componentNames: [...portfolioIdentity.componentNames],
    voteRule: portfolioIdentity.voteRule,
    validation: {
      ...rawValidation,
      regimes: regimeEvidence.regimes,
      currentRegimeFit: regimeEvidence.currentFit,
      validationVersion: "robust-v2-multi-stock"
    },
    currentRegime: regimeState.current,
    benchmarkBars: benchmark.length,
    securityCount: perSecurity.length,
    sampleCount: samples.length,
    matchedSignalCount: samples.length + rejections.length + pendingSignals.length,
    pendingCount: pendingSignals.length,
    untradeableCount,
    untradeableReasons,
    rejections,
    rejectedSignals: rejections,
    pendingSignals,
    samples,
    perSecurity
  };
}

module.exports = {
  buildStrategySelectionReport,
  buildStrategySignalReport,
  buildSelectedStrategyReplay,
  buildSelectedStrategyReplayBundle,
  buildSelectedStrategyPortfolioReplay,
  STRATEGY_DEFINITIONS,
  RETIRED_STRATEGY_DEFINITIONS,
  ALL_STRATEGY_DEFINITIONS,
  summarizeSamples,
  temporalSplit,
  strategyDependence,
  robustStrategyScore,
  buildSelectionHistoricalReview,
  compileCustomDefinitions,
  __test: {
    selectionExecutionNotes,
    volumeReboundHoldAt,
    VOLUME_REBOUND_HOLD,
    buildFeatureTimeline,
    featureSnapshot,
    isLimitUpAt,
    replayStrategy,
    resolvedOptions,
    buildValidation,
    lowerBoundPasses,
    buildWalkForward
  }
};
