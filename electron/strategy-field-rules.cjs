"use strict";

/**
 * 实测规则（2026-10-27）：用 2021-01 至 2026-10 全A日线（约 5400 只，86.7 万条近期涨停样本），
 * 按“次日开盘买入、持有5个交易日收盘卖出、双边成本0.3%”回放得到。每条规则在 2021–2023 与
 * 2024–2026 两段里方向一致，阈值取整数且附近取值结论不变（见 报告/策略实测回测与优化_1.6.21）。
 *
 * 过热指标：在近期涨停股里，下面每多满足一项，之后5日收益越差（6项中满足0项平均 +0.13%，
 * 满足4项以上 -1.1%～-2.5%，六个年份逐年单调）。
 */
const OVERHEAT = Object.freeze({
  maxClosePosition: 0.8,        // 收盘位于日内振幅上部 80% 以上
  maxDayReturnPercent: 3.5,     // 当日涨幅超过 3.5%
  maxMa20ExtensionPercent: 12,  // 收盘高于 MA20 超过 12%
  maxVolumeRatio: 1.4,          // 量比（对前5日均量）超过 1.4
  maxPriorLimits60: 2,          // 近60日此前涨停 3 次及以上
  maxReturn60Percent: 40,       // 近60日涨幅超过 40%
  vetoAtCount: 2                // 非涨停日信号满足 2 项及以上即否决
});

/** 低位首板 v1.3.0：涨停收盘距 MA20 不超过 5%，近 60 日涨幅不为正（下跌或横盘后的第一个涨停）。 */
const LOW_FIRST_BOARD = Object.freeze({ maxMa20ExtensionPercent: 5, maxReturn60Percent: 0 });

/** 次日竞价：高开超过 4% 或低开超过 5% 不买（两种情况 5 日平均亏损 1.5%～4.4%，逐年一致）。 */
const ENTRY_GAP = Object.freeze({ maxGapPercent: 4, minGapPercent: -5 });

const finiteNumber = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

function overheatFlags(input) {
  const flags = [];
  if (finiteNumber(input.closePosition) && Number(input.closePosition) > OVERHEAT.maxClosePosition) flags.push("收盘在日内高位");
  if (finiteNumber(input.currentReturn) && Number(input.currentReturn) > OVERHEAT.maxDayReturnPercent) flags.push(`当日涨幅超${OVERHEAT.maxDayReturnPercent}%`);
  if (finiteNumber(input.ma20ExtensionPercent) && Number(input.ma20ExtensionPercent) > OVERHEAT.maxMa20ExtensionPercent) flags.push(`高于MA20超${OVERHEAT.maxMa20ExtensionPercent}%`);
  if (finiteNumber(input.volumeRatio) && Number(input.volumeRatio) > OVERHEAT.maxVolumeRatio) flags.push(`量比超${OVERHEAT.maxVolumeRatio}`);
  if (finiteNumber(input.priorLimitCount60) && Number(input.priorLimitCount60) > OVERHEAT.maxPriorLimits60) flags.push(`近60日涨停${OVERHEAT.maxPriorLimits60 + 1}次以上`);
  if (finiteNumber(input.return60Percent) && Number(input.return60Percent) > OVERHEAT.maxReturn60Percent) flags.push(`近60日涨幅超${OVERHEAT.maxReturn60Percent}%`);
  return flags;
}

/**
 * 涨停当日本身必然“收盘在高位、当日大涨”，这两项不计入涨停日信号的过热判断；
 * 涨停日量比在实测中对首板后续收益没有区分度，也不计入。
 */
const LIMIT_DAY_INHERENT = new Set(["收盘在日内高位", `当日涨幅超${OVERHEAT.maxDayReturnPercent}%`, `量比超${OVERHEAT.maxVolumeRatio}`]);

function overheatAssessment(input) {
  const all = overheatFlags(input);
  const flags = input.isCurrentLimit === true ? all.filter(flag => !LIMIT_DAY_INHERENT.has(flag)) : all;
  return { flags, count: flags.length, veto: input.isCurrentLimit !== true && flags.length >= OVERHEAT.vetoAtCount };
}

function isLowPositionBoard(input) {
  return finiteNumber(input.ma20ExtensionPercent) && Number(input.ma20ExtensionPercent) <= LOW_FIRST_BOARD.maxMa20ExtensionPercent &&
    finiteNumber(input.return60Percent) && Number(input.return60Percent) <= LOW_FIRST_BOARD.maxReturn60Percent;
}

/**
 * 排序分：实测有效的方向。原公式奖励“均线多头、收盘在高位”，这两项在实测中反而对应更差的后续收益。
 * 70 起，每项过热指标 -15；涨停日为低位（距MA20≤5%且60日不涨）+15；跌破涨停日支撑 -20。
 */
function fieldSignalStrength(input) {
  const { count } = overheatAssessment(input);
  let strength = 70 - count * 15;
  if (input.isCurrentLimit === true && isLowPositionBoard(input)) strength += 15;
  if (input.heldSupport === false) strength -= 20;
  return Math.round(Math.max(0, Math.min(100, strength)));
}

function entryGapOutOfRange(signalClose, entryOpen) {
  const close = Number(signalClose), open = Number(entryOpen);
  if (!(close > 0) || !(open > 0)) return null;
  const gapPercent = (open / close - 1) * 100;
  if (gapPercent > ENTRY_GAP.maxGapPercent) return { gapPercent, side: "high" };
  if (gapPercent < ENTRY_GAP.minGapPercent) return { gapPercent, side: "low" };
  return null;
}

const ENTRY_GAP_TEXT = `次日竞价高开超过${ENTRY_GAP.maxGapPercent}%或低开超过${-ENTRY_GAP.minGapPercent}%不买`;

/**
 * 深跌底部：收盘仍低于 60 日线 15% 以上。与策略库「深跌底部首板 / 首板后缩量回踩 / 温和首板后承接」
 * 用的是同一个阈值（strategy-signal-engine 的 BOTTOM_TREND.deepMa60GapPercent，2026-11-03 全A实测：
 * 底部首板离 60 日线越远，之后 20 日相对同日涨停股池越强，两段年份一致）。
 */
const DEEP_BASE = Object.freeze({ ma60GapPercent: -15 });

function meanCloseAt(history, index, days) {
  if (!Number.isInteger(index) || index < days - 1 || index >= history.length) return null;
  let sum = 0;
  for (let cursor = index - days + 1; cursor <= index; cursor += 1) {
    const close = Number(history[cursor]?.close);
    if (!(close > 0)) return null;
    sum += close;
  }
  return sum / days;
}

/**
 * 个股分析的三个「实测因子」，直接由日线算出；实时分析（security-analysis）和历史回放
 * （strategy-intelligence）共用这一个实现，避免两处口径漂移。
 *
 * - notOverheated  不过热：6 项过热指标满足不到 2 项（涨停当天不计「收盘高位 / 当日大涨 / 放量」这三项固有特征）。
 * - lowPositionBoard 低位涨停：最近一次涨停是首板（前一日没有涨停），涨停收盘不高于 MA20 的 105%，
 *   涨停前 60 日涨幅不为正，之后没有跌破涨停日最低价。与策略库「底部首板」同一口径。
 * - deepBase 深跌底部：低位涨停成立，且评估日收盘仍低于 MA60 至少 15%。
 *
 * @param {object} input
 * @param {Array<{close:number}>} input.history 时间升序、同一复权口径的日线
 * @param {number|null} input.eventIndex 最近一次涨停所在下标；没有则为 null
 * @param {number} input.evaluationIndex 评估日下标
 * @param {number[]} [input.limitIndices] 已识别的涨停日下标（升序）
 * @param {number|null} input.closePosition 评估日收盘在当日振幅中的位置（0–1）
 * @param {number|null} input.volumeRatio 评估日量比（对前 5 日均量）
 * @param {boolean} input.heldSupport 涨停后是否守住涨停日最低价
 */
function measuredFactorSnapshot(input = {}) {
  const history = Array.isArray(input.history) ? input.history : [];
  const index = input.evaluationIndex;
  const empty = { notOverheated: false, overheatFlags: [], lowPositionBoard: false, deepBase: false,
    ma20ExtensionPercent: null, return60Percent: null, ma60GapPercent: null, limitMa20ExtensionPercent: null, limitReturn60Percent: null };
  if (!Number.isInteger(index) || index < 1 || index >= history.length) return empty;
  const close = Number(history[index]?.close);
  const previousClose = Number(history[index - 1]?.close);
  if (!(close > 0) || !(previousClose > 0)) return empty;
  const eventIndex = Number.isInteger(input.eventIndex) && input.eventIndex >= 0 && input.eventIndex <= index ? input.eventIndex : null;
  const limitIndices = Array.isArray(input.limitIndices) ? input.limitIndices.filter(Number.isInteger) : eventIndex === null ? [] : [eventIndex];
  const ma20 = meanCloseAt(history, index, 20);
  const ma60 = meanCloseAt(history, index, 60);
  const base60 = Number(history[index - 60]?.close);
  const ma20ExtensionPercent = ma20 ? (close / ma20 - 1) * 100 : null;
  const return60Percent = base60 > 0 ? (close / base60 - 1) * 100 : null;
  const ma60GapPercent = ma60 ? (close / ma60 - 1) * 100 : null;
  const isCurrentLimit = eventIndex === index;
  const assessment = overheatAssessment({
    closePosition: finiteNumber(input.closePosition) ? Number(input.closePosition) : null,
    currentReturn: (close / previousClose - 1) * 100,
    ma20ExtensionPercent,
    volumeRatio: finiteNumber(input.volumeRatio) && Number(input.volumeRatio) > 0 ? Number(input.volumeRatio) : null,
    priorLimitCount60: limitIndices.filter(item => item < index && item >= index - 60).length,
    return60Percent,
    isCurrentLimit
  });
  // 均线和 60 日涨幅都算不出来时无法判断是否过热，不当作「不过热」。
  const notOverheated = ma20ExtensionPercent !== null && return60Percent !== null && assessment.count < OVERHEAT.vetoAtCount;

  let limitMa20ExtensionPercent = null;
  let limitReturn60Percent = null;
  let lowPositionBoard = false;
  if (eventIndex !== null) {
    const boardClose = Number(history[eventIndex]?.close);
    const boardMa20 = meanCloseAt(history, eventIndex, 20);
    const boardBase60 = Number(history[eventIndex - 60]?.close);
    if (boardClose > 0 && boardMa20) limitMa20ExtensionPercent = (boardClose / boardMa20 - 1) * 100;
    if (boardClose > 0 && boardBase60 > 0) limitReturn60Percent = (boardClose / boardBase60 - 1) * 100;
    const firstBoard = !limitIndices.includes(eventIndex - 1);
    lowPositionBoard = firstBoard && input.heldSupport === true &&
      isLowPositionBoard({ ma20ExtensionPercent: limitMa20ExtensionPercent, return60Percent: limitReturn60Percent });
  }
  const deepBase = lowPositionBoard && ma60GapPercent !== null && ma60GapPercent <= DEEP_BASE.ma60GapPercent;
  return { notOverheated, overheatFlags: assessment.flags, lowPositionBoard, deepBase,
    ma20ExtensionPercent, return60Percent, ma60GapPercent, limitMa20ExtensionPercent, limitReturn60Percent };
}

module.exports = { OVERHEAT, LOW_FIRST_BOARD, ENTRY_GAP, ENTRY_GAP_TEXT, DEEP_BASE, overheatFlags, overheatAssessment, isLowPositionBoard,
  fieldSignalStrength, entryGapOutOfRange, measuredFactorSnapshot };
