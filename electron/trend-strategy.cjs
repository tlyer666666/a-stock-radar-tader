"use strict";

const { createHash } = require("node:crypto");
const { evaluateTrendStock, rankTrendCandidates, trendMath } = require("./trend-screener-engine.cjs");
const library = require("../config/trend-strategy-library.json");
const { prepareTrendLibrary, evaluatePreparedTrendLibrary } = require("./trend-library-engine.cjs");
const libraryById = new Map(library.map(item => [item.id, item]));
const { prepareRows, prepareBenchmarkRows, maAt, atr14, mean, ceilCents, floorCents } = trendMath;
const DEFAULTS = Object.freeze({ maxExtensionAtr: 2, minCloseLocation: 0.7, maxVolumeRatio: 3 });
const BOUNDS = Object.freeze({ maxExtensionAtr: [0.5, 5], minCloseLocation: [0.5, 0.95], maxVolumeRatio: [1.2, 6] });
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function normalizeTrendStrategy(options = {}) {
  if (!plain(options) || Object.keys(options).some(key => !["strategyId", "config"].includes(key))) {
    throw new TypeError("策略选项仅允许 strategyId 和 config");
  }
  const id = options.strategyId === undefined ? "classic-v1" : options.strategyId;
  const libraryEntry = libraryById.get(id);
  if (!["classic-v1", "quality-v2"].includes(id) && !libraryEntry) throw new TypeError("未知趋势策略 ID");
  const input = options.config === undefined ? {} : options.config;
  if (!plain(input)) throw new TypeError("策略配置必须是参数对象");
  const defaults = libraryEntry ? libraryEntry.parameters : DEFAULTS;
  const allowed = libraryEntry ? Object.keys(defaults) : id === "quality-v2" ? Object.keys(DEFAULTS) : [];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new TypeError("策略配置包含未知参数");
  const config = {};
  for (const key of allowed) {
    const value = Object.hasOwn(input, key) ? input[key] : defaults[key];
    if (libraryEntry) {
      if (!finite(value) || value !== defaults[key]) throw new TypeError(`策略固定参数 ${key} 须为 ${defaults[key]}`);
      config[key] = value;
      continue;
    }
    if (!finite(value) || value < BOUNDS[key][0] || value > BOUNDS[key][1]) {
      throw new TypeError(`策略参数 ${key} 须为 ${BOUNDS[key][0]} 至 ${BOUNDS[key][1]} 的有限数值`);
    }
    config[key] = value;
  }
  const version = libraryEntry ? libraryEntry.version : id === "classic-v1" ? "1.0.0" : "2.0.0";
  const configHash = createHash("sha256").update(JSON.stringify({ id, version, config })).digest("hex");
  return { id, version, configHash, config };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const detail = (label, passed, value, rule) => ({ label, passed: Boolean(passed), value: String(value), rule });

function evaluateTrendStrategy(input, options) {
  return evaluateTrendStrategyBatch(input, [options])[0];
}

function evaluateTrendStrategyBatch(input, optionsArray) {
  if (!Array.isArray(optionsArray)) throw new TypeError("批量策略选项须为数组");
  const strategies = optionsArray.map(normalizeTrendStrategy);
  if (!strategies.length) return [];
  const result = evaluateTrendStock(input);
  const prepared = strategies.some(strategy => libraryById.has(strategy.id)) ? prepareTrendLibrary(input, result) : null;
  return strategies.map(strategy => libraryById.has(strategy.id)
    ? evaluatePreparedTrendLibrary(prepared, strategy) : evaluateClassicOrQuality(input, strategy, result));
}

function evaluateClassicOrQuality(input, strategy, result) {
  if (result.kind !== "candidate") return result;
  const original = result.candidate;
  if (strategy.id === "classic-v1") return { ...result, candidate: { ...original, strategy } };

  // The classic validator has already established positive aligned histories.
  // Rebuild only as-of prices; a future bar cannot influence any quality gate.
  const raw = prepareRows(input.rawRows, input.asOf, true);
  const adjusted = prepareRows(input.adjustedRows, input.asOf, false);
  const factor = raw.at(-1).close / adjusted.at(-1).close;
  const aligned21 = raw.slice(-21).every((row, offset) =>
    Math.abs((row.close / adjusted[adjusted.length - 21 + offset].close) / factor - 1) <= 0.002);
  const prices = adjusted.map((row, i) => ({ ...row,
    open: row.open * factor, high: row.high * factor, low: row.low * factor, close: row.close * factor,
    volume: raw[i].volume, amount: raw[i].amount }));
  const last = prices.length - 1;
  const today = prices[last];
  const ma20 = maAt(prices, last, 20);
  const ma60 = maAt(prices, last, 60);
  const previousAtr = atr14(prices.slice(0, -1));
  const atrKnown = finite(previousAtr) && previousAtr > 0;
  const extensionAtr = atrKnown ? (today.close - ma20) / previousAtr : 0;
  const amplitude = today.high - today.low;
  const closeLocation = amplitude > 0 ? (today.close - today.low) / amplitude : 0;
  const prior3 = prices.slice(last - 3, last);
  const volumeMedian20 = median(raw.slice(last - 20, last).map(row => row.volume));
  const volumeRatio = raw[last].volume / mean(raw.slice(last - 5, last), "volume");
  const holdingMa20Count = prior3.filter((row, offset) => row.close >= maAt(prices, last - 3 + offset, 20)).length;
  const t0 = raw.findIndex(row => row.date === original.limitDate);
  const consolidation = prices.slice(t0 + 1, last);
  const consolidationLow = consolidation.length ? Math.min(...consolidation.map(row => row.low)) : prices[t0].low;
  const consolidationHigh = consolidation.length ? Math.max(...consolidation.map(row => row.high)) : prices[t0].high;
  const prior3High = Math.max(...prior3.map(row => row.high));
  const primaryPattern = original.patterns.includes("A") ? "A" : original.patterns.includes("B") ? "B" : null;
  // Preserve classic's A-first stop basis, including when both labels match.
  // A failed primary shape must not silently borrow another shape's evidence.
  const patternLow = primaryPattern === "A" ? Math.min(...prior3.map(row => row.low)) : consolidationLow;
  const stop = original.plan?.stop ?? ceilCents(Math.max(prices[t0].low, patternLow - 0.5 * atr14(prices)));
  const stopDistanceAtr = atrKnown ? (today.close - stop) / previousAtr : 0;
  const ma60Rising = ma60 >= maAt(prices, last - 5, 60);
  const benchmark = Array.isArray(input.benchmarkRows) && input.benchmarkRows.length
    ? prepareBenchmarkRows(input.benchmarkRows, input.asOf) : [];
  const benchmarkStart = benchmark.find(row => row.date === prices[last - 20].date);
  const benchmarkEnd = benchmark.find(row => row.date === today.date);
  // Display rounding must not turn a positive (or negative) excess return into
  // an exact zero at the decision boundary or change the v2 ranking order.
  const relativeStrength20 = benchmarkStart && benchmarkEnd
    ? ((today.close / prices[last - 20].close - 1) - (benchmarkEnd.close / benchmarkStart.close - 1)) * 100
    : null;
  const relativeStrengthPositive = relativeStrength20 !== null && relativeStrength20 > 0;
  const aBreakout = today.close > prior3High;
  const aVolume = mean(prior3, "volume") <= volumeMedian20;
  const bRange = atrKnown && consolidationHigh - consolidationLow <= 4 * previousAtr;
  const bVolume = consolidation.length > 0 && mean(consolidation, "volume") <= volumeMedian20;
  const shapePassed = primaryPattern === "A" ? aBreakout && aVolume : primaryPattern === "B" ? bRange && bVolume : false;
  const breakoutLevel = primaryPattern === "A" ? prior3High : consolidationHigh;
  const minEntry = ceilCents(Math.max(breakoutLevel + 0.01, stop + 0.01));
  const maxEntry = floorCents(Math.min(original.plan?.maxEntry ?? 0, today.close + 0.5 * previousAtr));
  const entryValid = Boolean(original.plan) && stop < minEntry && minEntry <= maxEntry;
  const gates = [aligned21, ma60Rising, relativeStrengthPositive, atrKnown,
    atrKnown && extensionAtr <= strategy.config.maxExtensionAtr,
    amplitude > 0 && closeLocation >= strategy.config.minCloseLocation,
    volumeRatio <= strategy.config.maxVolumeRatio, holdingMa20Count >= 2,
    shapePassed, atrKnown && stopDistanceAtr >= 0.5, entryValid];
  const signal = original.stage === "signal" && gates.every(Boolean);
  const evidence = [
    detail("21日复权口径", aligned21, aligned21 ? "一致" : "变化", "前20日成交量与信号日共21根须同口径；复权因子相对变化不超过0.2%"),
    detail("MA60方向", ma60Rising, `${ma60.toFixed(4)} / ${maAt(prices, last - 5, 60).toFixed(4)}`, "MA60不低于5个交易日前"),
    detail("相对强度", relativeStrengthPositive, relativeStrength20 === null ? "未知" : `${relativeStrength20.toFixed(6)}%`, "20日超额涨幅严格大于0；按未舍入数值判断，不是收益预测"),
    detail("昨日ATR", atrKnown, atrKnown ? previousAtr.toFixed(4) : "无有效波动", "ATR14只使用截至昨日的行情且须大于0"),
    detail("ATR偏离", atrKnown && extensionAtr <= strategy.config.maxExtensionAtr, atrKnown ? extensionAtr.toFixed(4) : "无法计算", `收盘与MA20距离不超过${strategy.config.maxExtensionAtr}倍昨日ATR14`),
    detail("收盘位置", amplitude > 0 && closeLocation >= strategy.config.minCloseLocation, closeLocation.toFixed(4), `当日非零振幅且(收盘-最低)/(最高-最低)至少${strategy.config.minCloseLocation}`),
    detail("信号量比", volumeRatio <= strategy.config.maxVolumeRatio, volumeRatio.toFixed(4), `当日量/此前五日均量不超过${strategy.config.maxVolumeRatio}`),
    detail("三日均线承接", holdingMa20Count >= 2, `${holdingMa20Count}/3`, "此前三日至少两日收盘不低于各自MA20"),
    detail("A三日突破", aBreakout, prior3High.toFixed(4), "主形态A须收盘突破此前三日最高价；A+B时仍按A复核"),
    detail("A常态缩量", aVolume, `${mean(prior3, "volume").toFixed(0)} / ${volumeMedian20.toFixed(0)}`, "主形态A的前三日均量不超过此前20日量中位数"),
    detail("B波动宽度", bRange, (consolidationHigh - consolidationLow).toFixed(4), "主形态B的平台绝对宽度不超过4倍昨日ATR14"),
    detail("B常态缩量", bVolume, `${consolidation.length ? mean(consolidation, "volume").toFixed(0) : "无整理"} / ${volumeMedian20.toFixed(0)}`, "主形态B的整理均量不超过此前20日量中位数"),
    detail("止损波动距离", atrKnown && stopDistanceAtr >= 0.5, atrKnown ? stopDistanceAtr.toFixed(4) : "无法计算", "信号收盘至原冻结止损至少0.5倍昨日ATR14"),
    detail("质量版入场区间", entryValid, entryValid ? `${minEntry.toFixed(2)}–${maxEntry.toFixed(2)}` : "无有效区间", "S<最低入场≤最高入场；最低入场至少突破位+0.01，最高入场不超过原Pmax及C+0.5昨日ATR")
  ];
  const plan = signal ? { ...original.plan, minEntry, maxEntry,
    maxRiskPercent: Number(((maxEntry - stop) / maxEntry * 100).toFixed(2)) } : null;
  return { ...result, reason: signal ? "质量趋势波段信号" : "质量趋势波段观察", candidate: {
    ...original, strategy, primaryPattern,
    quality: { atr14Previous: previousAtr, extensionAtr, closeLocation, volumeRatio, volumeMedian20,
      ma60Rising, relativeStrengthPositive, holdingMa20Count, stopDistanceAtr },
    metrics: { ...original.metrics, relativeStrength20 },
    stage: signal ? "signal" : "watch", plan, evidence: [...original.evidence, ...evidence],
    warnings: [...original.warnings, "质量版为独立研究规则，参数与排序不代表更高收益或盈利概率"]
  } };
}

function rankTrendStrategyCandidates(rows, options) {
  const strategy = normalizeTrendStrategy(options);
  if (strategy.id === "classic-v1") return rankTrendCandidates(rows);
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const stage = Number(b?.stage === "signal") - Number(a?.stage === "signal");
    if (stage) return stage;
    const ra = a?.metrics?.relativeStrength20, rb = b?.metrics?.relativeStrength20;
    if (finite(ra) !== finite(rb)) return finite(ra) ? -1 : 1;
    if (finite(ra) && ra !== rb) return rb - ra;
    const ea = strategy.id === "quality-v2" ? a?.quality?.extensionAtr : a?.technical?.indicators?.extensionAtr;
    const eb = strategy.id === "quality-v2" ? b?.quality?.extensionAtr : b?.technical?.indicators?.extensionAtr;
    if (finite(ea) !== finite(eb)) return finite(ea) ? -1 : 1;
    if (finite(ea) && ea !== eb) return ea - eb;
    const amount = (finite(b?.metrics?.avgAmount20) ? b.metrics.avgAmount20 : 0) - (finite(a?.metrics?.avgAmount20) ? a.metrics.avgAmount20 : 0);
    return amount || String(a?.security?.code || "").localeCompare(String(b?.security?.code || ""));
  });
}

module.exports = { normalizeTrendStrategy, evaluateTrendStrategy, evaluateTrendStrategyBatch, rankTrendStrategyCandidates };
