"use strict";

const catalog = require("../config/strategy-signal-combinations.json");
const indicators = require("./trend-indicators.cjs");
const finite = value => typeof value === "number" && Number.isFinite(value);
const iso = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const roundPrice = value => Math.round((value + Number.EPSILON) * 100) / 100;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function boardRate(code, date) {
  if (/^(?:000|001|002|003|600|601|603|605)\d{3}$/.test(code)) return .1;
  if (/^30[012]\d{3}$/.test(code)) return date < "2020-08-24" ? .1 : .2;
  if (/^68[89]\d{3}$/.test(code)) return .2;
  if (/^(?:[48]\d{5}|920\d{3})$/.test(code)) return .3;
  return null;
}
function limitEvidenceAt(history, index, code, name) {
  const row = history[index], previous = history[index - 1];
  const rate = boardRate(code, row?.date);
  if (!row || !previous || !rate || /ST|退/i.test(String(name)) || row.isST === true || row.noPriceLimit === true ||
      !finite(previous.close) || previous.close <= 0 || !finite(row.close) || !finite(row.high)) return null;
  const official = Object.hasOwn(row, "upperLimit");
  const upperLimit = official ? row.upperLimit : roundPrice(previous.close * (1 + rate));
  if (!finite(upperLimit) || upperLimit <= 0 || Math.abs(row.close - upperLimit) >= .005 || row.high > upperLimit + .005) return null;
  return { date: row.date, previousClose: previous.close, close: row.close, upperLimit,
    rate, source: official ? "provided_upper_limit" : "calculated_board_rule" };
}

// Full causal series are prepared once per stock; every output at index i uses
// only values <= i. The benchmark date sequence guards missing stock pages.
function prepareCombinationTimeline(history, code, name, benchmark = []) {
  const closes = history.map(row => row.close);
  const ma = Object.fromEntries([5, 10, 20, 60].map(period => [period, indicators.rollingMean(closes, period)]));
  const macd = indicators.macd(closes), boll = indicators.boll(closes), dmi = indicators.dmi(history);
  const obv = indicators.obv(history), kdj = indicators.kdj(history);
  const rsi = indicators.rsi(closes, 14), cci = indicators.cci(history, 14), roc = indicators.roc(closes, 12);
  const emv = indicators.emv(history, 14, 100000000), mfi = indicators.mfi(history, 14), channel = indicators.donchian(history, 55);
  const calendar = [...new Set(benchmark.map(row => row.date).filter(iso))].sort();
  let calendarEnd = -1, invalidPricePrefix = 0;
  const limitEvents = [];
  return history.map((row, index) => {
    if (!iso(row.date) || (index && row.date <= history[index - 1].date) ||
        ![row.open, row.high, row.low, row.close].every(value => finite(value) && value > 0) ||
        row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) invalidPricePrefix++;
    while (calendar[calendarEnd + 1] <= row.date) calendarEnd++;
    const recent = history.slice(Math.max(0, index - 79), index + 1);
    const dates = calendar.slice(Math.max(0, calendarEnd - 79), calendarEnd + 1);
    const calendarComplete = recent.length === 80 && dates.length === 80 && recent.every((bar, offset) => bar.date === dates[offset]);
    const dataValid = invalidPricePrefix === 0 && recent.length === 80 &&
      recent.every(bar => finite(bar.volume) && bar.volume > 0 && finite(bar.amount) && bar.amount > 0);
    const event = limitEvidenceAt(history, index, code, name);
    if (event) limitEvents.push({ index, event });
    const latest = limitEvents.at(-1);
    const limit = latest && index - latest.index < 15 ? latest.event : null;
    const eligible = Boolean(boardRate(code, row.date)) && !/ST|退/i.test(String(name)) &&
      !history.slice(Math.max(0, index - 14), index + 1).some(bar => bar.isST === true);
    const trend = row.close > ma[20][index] && ma[20][index] > ma[60][index] &&
      ma[20][index] > ma[20][index - 5] && row.close / ma[20][index] <= 1.1;
    const widths = boll.width.slice(Math.max(0, index - 60), index);
    const widthMedian = widths.length === 60 && widths.every(finite) ? median(widths) : null;
    const closeHigh = Math.max(...closes.slice(Math.max(0, index - 20), index));
    const obvHigh = Math.max(...obv.slice(Math.max(0, index - 20), index));
    const values = {
      ma5: ma[5][index], ma10: ma[10][index], ma20: ma[20][index], ma60: ma[60][index],
      dif: macd.dif[index], dea: macd.dea[index], macdHistogram: macd.histogram[index],
      bollUpperPrevious: boll.upper[index - 1], bollWidthPrevious: boll.width[index - 1], bollWidthMedian: widthMedian,
      obv: obv[index], obvPreviousHigh: obvHigh, closePreviousHigh: closeHigh,
      pdi: dmi.pdi[index], mdi: dmi.mdi[index], adx: dmi.adx[index],
      k: kdj.k[index], d: kdj.d[index], previousHigh: history[index - 1]?.high,
      rsi: rsi[index], cci: cci[index], roc: roc[index], emv: emv[index], mfi: mfi[index], donchianUpper: channel.upper[index]
    };
    const rsiStrength = finite(rsi[index]) && rsi[index] > 50 && rsi[index] <= 75 && rsi[index] > rsi[index - 1];
    const mfiStrength = finite(mfi[index]) && mfi[index] > 50 && mfi[index] <= 80 && mfi[index] > mfi[index - 1];
    const rocStrength = finite(roc[index]) && roc[index] > 0 && roc[index] > roc[index - 1];
    return { eligible, dataValid, calendarComplete, trend, limit,
      indicators: Object.fromEntries(Object.entries(values).filter(([, value]) => finite(value))),
      confirmations: {
        limit_macd_pullback_resonance: macd.dif[index] > macd.dea[index] && macd.dea[index] > 0 && macd.histogram[index] > macd.histogram[index - 1],
        limit_boll_breakout_resonance: finite(widthMedian) && boll.width[index - 1] <= widthMedian &&
          history[index - 1]?.close <= boll.upper[index - 1] && row.close > boll.upper[index - 1],
        limit_obv_breakout_resonance: index >= 20 && row.close > closeHigh && obv[index] > obvHigh,
        limit_dmi_reclaim_resonance: finite(dmi.pdi[index]) && finite(dmi.mdi[index]) && finite(dmi.adx[index]) && finite(dmi.adx[index - 1]) &&
          dmi.pdi[index] > dmi.mdi[index] && dmi.adx[index] >= 20 && dmi.adx[index] > dmi.adx[index - 1],
        limit_kdj_dryup_resonance: finite(kdj.rsv[index]) && indicators.crossedAbove(kdj.k[index - 1], kdj.d[index - 1], kdj.k[index], kdj.d[index]) &&
          kdj.k[index] <= 80 && row.close > history[index - 1]?.close,
        limit_gap_ma_resonance: ma[5][index] > ma[10][index] && ma[10][index] > ma[20][index] && ma[20][index] > ma[60][index] && row.close > history[index - 1]?.high,
        limit_rsi_pullback_resonance: rsiStrength,
        limit_cci_breakout_resonance: indicators.crossedAbove(cci[index - 1], 100, cci[index], 100),
        limit_roc_reclaim_resonance: rocStrength,
        limit_emv_dryup_resonance: finite(emv[index]) && finite(emv[index - 1]) && emv[index] > 0 && emv[index] > emv[index - 1],
        limit_mfi_pullback_resonance: mfiStrength,
        limit_donchian_breakout_resonance: finite(channel.upper[index]) && finite(channel.upper[index - 1]) && row.close > channel.upper[index] && history[index - 1]?.close <= channel.upper[index - 1],
        limit_rsi_mfi_resonance: rsiStrength && mfiStrength,
        limit_cci_roc_resonance: finite(cci[index]) && finite(cci[index - 1]) && cci[index] > 100 && cci[index] > cci[index - 1] && rocStrength
      }
    };
  });
}

function attachCombinationEvidence(feature, prepared) {
  if (!prepared) return feature;
  const common = prepared.eligible && prepared.dataValid && prepared.calendarComplete && prepared.trend &&
    Boolean(prepared.limit) && prepared.limit.date === feature.eventDate && feature.heldSupport === true && feature.riskVeto === true;
  // Key by stable identity, never by catalog position. Reordering metadata
  // cannot silently change which price pattern a combination requires.
  const shapes = {
    limit_macd_pullback_resonance: feature.limitMa10Pullback,
    limit_boll_breakout_resonance: feature.secondBreakout,
    limit_obv_breakout_resonance: feature.secondBreakout,
    limit_dmi_reclaim_resonance: feature.limitMa10Pullback || feature.maReclaimAfterLimit,
    limit_kdj_dryup_resonance: feature.volumeDryupRebound,
    limit_gap_ma_resonance: feature.limitGapHold,
    limit_rsi_pullback_resonance: feature.limitMa10Pullback,
    limit_cci_breakout_resonance: feature.secondBreakout,
    limit_roc_reclaim_resonance: feature.maReclaimAfterLimit,
    limit_emv_dryup_resonance: feature.volumeDryupRebound,
    limit_mfi_pullback_resonance: feature.limitMa10Pullback,
    limit_donchian_breakout_resonance: feature.secondBreakout,
    limit_rsi_mfi_resonance: feature.volumeDryupRebound,
    limit_cci_roc_resonance: feature.maReclaimAfterLimit
  };
  return { ...feature, signalCombinations: { common: Boolean(common), limit: prepared.limit,
    dataValid: prepared.dataValid, calendarComplete: prepared.calendarComplete, indicators: prepared.indicators,
    matches: Object.fromEntries(catalog.map(entry => [entry.id, {
      shape: shapes[entry.id] === true,
      confirmation: prepared.confirmations[entry.id] === true && (entry.id !== "limit_gap_ma_resonance" ||
        (finite(feature.volumeRatio) && feature.volumeRatio >= 1 && feature.volumeRatio <= 2.5))
    }])) } };
}

const definitions = catalog.map(entry => ({
  ...entry, type: "composite", components: ["recent_limit_trend_gate", `${entry.id}:shape`, entry.technicalId],
  componentNames: ["近期涨停上升趋势", entry.shapeLabel, entry.technicalLabel],
  voteRule: "近期涨停趋势共同门槛、涨停后形态、技术确认三项同时成立；不以多数票替代必要条件",
  matches: feature => feature?.signalCombinations?.common === true && feature.riskVeto !== false &&
    feature.signalCombinations.matches[entry.id]?.shape === true && feature.signalCombinations.matches[entry.id]?.confirmation === true,
  reasons: feature => [entry.shapeLabel, entry.technicalLabel,
    `涨停证据 ${feature.signalCombinations.limit.date}，限价 ${feature.signalCombinations.limit.upperLimit}（${feature.signalCombinations.limit.source === "provided_upper_limit" ? "输入限价字段，来源待核验" : "按板块常规规则推算，待核验"}）`],
  componentEvidence: feature => [
    { id: "recent_limit_trend_gate", name: "近期涨停上升趋势", passed: feature.signalCombinations?.common === true },
    { id: `${entry.id}:shape`, name: entry.shapeLabel, passed: feature.signalCombinations?.matches[entry.id]?.shape === true },
    { id: entry.technicalId, name: entry.technicalLabel, passed: feature.signalCombinations?.matches[entry.id]?.confirmation === true }
  ].map(item => ({ ...item, source: "ohlcv_rule_engine", sourceDate: feature.date || "" }))
}));

module.exports = { definitions, prepareCombinationTimeline, attachCombinationEvidence, limitEvidenceAt };
