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

module.exports = { OVERHEAT, LOW_FIRST_BOARD, ENTRY_GAP, ENTRY_GAP_TEXT, overheatFlags, overheatAssessment, isLowPositionBoard,
  fieldSignalStrength, entryGapOutOfRange };
