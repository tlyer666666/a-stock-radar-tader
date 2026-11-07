"use strict";

const catalog = require("../config/strategy-signal-combinations.json");
const indicators = require("./trend-indicators.cjs");
const selectionRules = require("./strategy-selection-rules.cjs");
const { priceLimitRate, isBseAshareCode, upperLimitPrice } = require("./price-limit-rules.cjs");
const finite = value => typeof value === "number" && Number.isFinite(value);
const iso = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function boardRate(code, date) {
  if (!/^(?:000|001|002|003|600|601|603|605|30[012]|68[89])\d{3}$/.test(code) && !isBseAshareCode(code)) return null;
  return priceLimitRate(code, "", date, false);
}
function limitEvidenceAt(history, index, code, name) {
  const row = history[index], previous = history[index - 1];
  const rate = boardRate(code, row?.date);
  if (!row || !previous || !rate || /ST|退/i.test(String(name)) || row.isST === true || row.noPriceLimit === true ||
      !finite(previous.close) || previous.close <= 0 || !finite(row.close) || !finite(row.high)) return null;
  // Same limit price as the base strategies (price-limit-rules): an exchange
  // reference close (preClose, e.g. ex-dividend) or provided upperLimit wins.
  const official = Object.hasOwn(row, "upperLimit");
  const upperLimit = upperLimitPrice(previous.close, row, code, name);
  if (!finite(upperLimit) || upperLimit <= 0 || Math.abs(row.close - upperLimit) >= .005 || row.high > upperLimit + .005) return null;
  return { date: row.date, previousClose: previous.close, close: row.close, upperLimit,
    rate, source: official ? "provided_upper_limit" : Object.hasOwn(row, "preClose") ? "reference_pre_close" : "calculated_board_rule" };
}

// Full causal series are prepared once per stock; every output at index i uses
// only values <= i. The benchmark date sequence guards missing stock pages.
function prepareCombinationTimeline(history, code, name, benchmark = []) {
  const parameters = Object.fromEntries(catalog.map(entry => [entry.id, entry.parameters]));
  const common = parameters[catalog[0].id];
  const commonKeys = ["marketCalendarLookback", "recentLimitSessions", "maFast", "maMiddle", "maTrend", "maLong", "maxMa20ExtensionPercent"];
  for (const entry of catalog) {
    if (Object.values(entry.parameters).some(value => !finite(value) || value <= 0)) throw new TypeError(`组合参数须为正有限数：${entry.id}`);
    if (commonKeys.some(key => entry.parameters[key] !== common[key])) throw new TypeError("组合共同门槛参数须一致");
  }
  const cfg = id => parameters[`limit_${id}_resonance`];
  const closes = history.map(row => row.close);
  const ma = Object.fromEntries([common.maFast, common.maMiddle, common.maTrend, common.maLong].map(period => [period, indicators.rollingMean(closes, period)]));
  const m = cfg("macd_pullback"), b = cfg("boll_breakout"), d = cfg("dmi_reclaim"), k = cfg("kdj_dryup"), e = cfg("emv_dryup"), c = cfg("donchian_breakout");
  const macd = indicators.macd(closes, m.fastPeriod, m.slowPeriod, m.signalPeriod), boll = indicators.boll(closes, b.bollPeriod, b.bollMultiplier), dmi = indicators.dmi(history, d.dmiPeriod, d.adxPeriod);
  const obv = indicators.obv(history), kdj = indicators.kdj(history, k.rsvPeriod, k.kPeriod, k.dPeriod);
  const rsi = indicators.rsi(closes, cfg("rsi_pullback").rsiPeriod), cci = indicators.cci(history, cfg("cci_breakout").cciPeriod), roc = indicators.roc(closes, cfg("roc_reclaim").rocPeriod);
  const emv = indicators.emv(history, e.emvPeriod, e.volumeDivisor), mfi = indicators.mfi(history, cfg("mfi_pullback").mfiPeriod), channel = indicators.donchian(history, c.channelPeriod);
  const dualRsi = indicators.rsi(closes, cfg("rsi_mfi").rsiPeriod), dualMfi = indicators.mfi(history, cfg("rsi_mfi").mfiPeriod);
  const dualCci = indicators.cci(history, cfg("cci_roc").cciPeriod), dualRoc = indicators.roc(closes, cfg("cci_roc").rocPeriod);
  const strength = (series, index, threshold, maximum = Infinity) => finite(series[index]) && finite(series[index - 1]) && series[index] > threshold && series[index] <= maximum && series[index] > series[index - 1];
  const calendar = [...new Set(benchmark.map(row => row.date).filter(iso))].sort();
  let calendarEnd = -1, invalidPricePrefix = 0;
  const limitEvents = [];
  return history.map((row, index) => {
    if (!iso(row.date) || (index && row.date <= history[index - 1].date) ||
        ![row.open, row.high, row.low, row.close].every(value => finite(value) && value > 0) ||
        row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) invalidPricePrefix++;
    while (calendar[calendarEnd + 1] <= row.date) calendarEnd++;
    const recent = history.slice(Math.max(0, index - common.marketCalendarLookback + 1), index + 1);
    const dates = calendar.slice(Math.max(0, calendarEnd - common.marketCalendarLookback + 1), calendarEnd + 1);
    const calendarComplete = recent.length === common.marketCalendarLookback && dates.length === common.marketCalendarLookback && recent.every((bar, offset) => bar.date === dates[offset]);
    const dataValid = invalidPricePrefix === 0 && recent.length === common.marketCalendarLookback &&
      recent.every(bar => finite(bar.volume) && bar.volume > 0 && finite(bar.amount) && bar.amount > 0);
    const event = limitEvidenceAt(history, index, code, name);
    if (event) limitEvents.push({ index, event });
    const latest = limitEvents.at(-1);
    const limit = latest && index - latest.index < common.recentLimitSessions ? latest.event : null;
    const relativeLimit = latest && index - latest.index <= selectionRules.relativeDefinition.parameters.recentLimitMaxAge ? latest.event : null;
    const eligible = Boolean(boardRate(code, row.date)) && !/ST|退/i.test(String(name)) &&
      !history.slice(Math.max(0, index - common.recentLimitSessions + 1), index + 1).some(bar => bar.isST === true);
    const trend = [row.close, ma[common.maTrend][index], ma[common.maLong][index], ma[common.maTrend][index - common.maFast]].every(finite) &&
      row.close > ma[common.maTrend][index] && ma[common.maTrend][index] > ma[common.maLong][index] &&
      ma[common.maTrend][index] > ma[common.maTrend][index - common.maFast] && row.close / ma[common.maTrend][index] <= 1 + common.maxMa20ExtensionPercent / 100;
    const widths = boll.width.slice(Math.max(0, index - b.widthLookback), index);
    const widthMedian = widths.length === b.widthLookback && widths.every(finite) ? median(widths) : null;
    const closeHigh = Math.max(...closes.slice(Math.max(0, index - cfg("obv_breakout").breakoutPeriod), index));
    const obvHigh = Math.max(...obv.slice(Math.max(0, index - cfg("obv_breakout").breakoutPeriod), index));
    const values = {
      ma5: ma[common.maFast][index], ma10: ma[common.maMiddle][index], ma20: ma[common.maTrend][index], ma60: ma[common.maLong][index],
      dif: macd.dif[index], dea: macd.dea[index], macdHistogram: macd.histogram[index],
      bollUpperPrevious: boll.upper[index - 1], bollWidthPrevious: boll.width[index - 1], bollWidthMedian: widthMedian,
      obv: obv[index], obvPreviousHigh: obvHigh, closePreviousHigh: closeHigh,
      pdi: dmi.pdi[index], mdi: dmi.mdi[index], adx: dmi.adx[index],
      k: kdj.k[index], d: kdj.d[index], previousHigh: history[index - 1]?.high,
      rsi: rsi[index], cci: cci[index], roc: roc[index], emv: emv[index], mfi: mfi[index], donchianUpper: channel.upper[index]
    };
    const rsiStrength = strength(rsi, index, cfg("rsi_pullback").rsiThreshold, cfg("rsi_pullback").maxRsi);
    const mfiStrength = strength(mfi, index, cfg("mfi_pullback").mfiThreshold, cfg("mfi_pullback").maxMfi);
    const rocStrength = strength(roc, index, 0);
    return { eligible, dataValid, calendarComplete, trend, limit, relativeLimit,
      relativeStrength: selectionRules.relativeStrengthAt(history, index, benchmark),
      indicators: Object.fromEntries(Object.entries(values).filter(([, value]) => finite(value))),
      confirmations: {
        limit_macd_pullback_resonance: [macd.dif[index], macd.dea[index], macd.histogram[index], macd.histogram[index - 1]].every(finite) && macd.dif[index] > macd.dea[index] && macd.dea[index] > 0 && macd.histogram[index] > macd.histogram[index - 1],
        limit_boll_breakout_resonance: [widthMedian, boll.width[index - 1], boll.upper[index - 1], history[index - 1]?.close].every(finite) && boll.width[index - 1] <= widthMedian &&
          history[index - 1]?.close <= boll.upper[index - 1] && row.close > boll.upper[index - 1],
        limit_obv_breakout_resonance: index >= cfg("obv_breakout").breakoutPeriod && [row.close, closeHigh, obv[index], obvHigh].every(finite) && row.close > closeHigh && obv[index] > obvHigh,
        limit_dmi_reclaim_resonance: finite(dmi.pdi[index]) && finite(dmi.mdi[index]) && finite(dmi.adx[index]) && finite(dmi.adx[index - 1]) &&
          dmi.pdi[index] > dmi.mdi[index] && dmi.adx[index] >= d.adxThreshold && dmi.adx[index] > dmi.adx[index - 1],
        limit_kdj_dryup_resonance: finite(kdj.rsv[index]) && indicators.crossedAbove(kdj.k[index - 1], kdj.d[index - 1], kdj.k[index], kdj.d[index]) &&
          kdj.k[index] <= k.maxK && row.close > history[index - 1]?.close,
        limit_gap_ma_resonance: [ma[common.maFast][index], ma[common.maMiddle][index], ma[common.maTrend][index], ma[common.maLong][index], history[index - 1]?.high].every(finite) && ma[common.maFast][index] > ma[common.maMiddle][index] && ma[common.maMiddle][index] > ma[common.maTrend][index] && ma[common.maTrend][index] > ma[common.maLong][index] && row.close > history[index - 1]?.high,
        limit_rsi_pullback_resonance: rsiStrength,
        limit_cci_breakout_resonance: indicators.crossedAbove(cci[index - 1], cfg("cci_breakout").cciThreshold, cci[index], cfg("cci_breakout").cciThreshold),
        limit_roc_reclaim_resonance: rocStrength,
        limit_emv_dryup_resonance: finite(emv[index]) && finite(emv[index - 1]) && emv[index] > 0 && emv[index] > emv[index - 1],
        limit_mfi_pullback_resonance: mfiStrength,
        limit_donchian_breakout_resonance: finite(channel.upper[index]) && finite(channel.upper[index - 1]) && row.close > channel.upper[index] && history[index - 1]?.close <= channel.upper[index - 1],
        limit_rsi_mfi_resonance: strength(dualRsi, index, cfg("rsi_mfi").rsiThreshold, cfg("rsi_mfi").maxRsi) && strength(dualMfi, index, cfg("rsi_mfi").mfiThreshold, cfg("rsi_mfi").maxMfi),
        limit_cci_roc_resonance: strength(dualCci, index, cfg("cci_roc").cciThreshold) && strength(dualRoc, index, 0)
      }
    };
  });
}

function attachCombinationEvidence(feature, prepared) {
  if (!prepared) return feature;
  const common = prepared.eligible && prepared.dataValid && prepared.calendarComplete && prepared.trend &&
    Boolean(prepared.limit) && prepared.limit.date === feature.eventDate && feature.heldSupport === true && feature.riskVeto === true;
  const relativeCommon = prepared.eligible && prepared.dataValid && prepared.calendarComplete && prepared.trend &&
    feature.daysSinceLimit >= selectionRules.relativeDefinition.parameters.recentLimitMinAge &&
    feature.daysSinceLimit <= selectionRules.relativeDefinition.parameters.recentLimitMaxAge &&
    Boolean(prepared.relativeLimit) && prepared.relativeLimit.date === feature.eventDate && feature.heldSupport === true && feature.riskVeto === true;
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
  return { ...feature, relativeStrength: { ...prepared.relativeStrength,
    passed: Boolean(relativeCommon && prepared.relativeStrength?.passed) }, signalCombinations: { common: Boolean(common), limit: prepared.limit,
    dataValid: prepared.dataValid, calendarComplete: prepared.calendarComplete, indicators: prepared.indicators,
    matches: Object.fromEntries(catalog.map(entry => [entry.id, {
      shape: shapes[entry.id] === true,
      confirmation: prepared.confirmations[entry.id] === true && (entry.id !== "limit_gap_ma_resonance" ||
        (finite(feature.volumeRatio) && feature.volumeRatio >= entry.parameters.minVolumeRatio && feature.volumeRatio <= entry.parameters.maxVolumeRatio))
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
