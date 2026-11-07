"use strict";

const { createTradingCalendar, validDate } = require("./trend-trading-calendar.cjs");

const numeric = value => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value));
const positive = value => numeric(value) && Number(value) > 0;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const rawDate = row => String(row?.date ?? row?.tradeDate ?? row?.time ?? "");

function validPriceRow(row) {
  if (![row?.open, row?.high, row?.low, row?.close].every(positive)) return false;
  const [open, high, low, close] = [row.open, row.high, row.low, row.close].map(Number);
  return high >= Math.max(open, close) && low <= Math.min(open, close) && high >= low;
}

/** Validate raw rows before any sorting, deduplication or invalid-row removal. */
function prepareWindow(input, asOfDate, dates, requireActivity) {
  if (!Array.isArray(input) || !input.length) return { state: "missing", reason: "missing_history", rows: [] };
  if (!Array.isArray(dates) || !dates.length) return { state: "invalid", reason: "unknown_calendar", rows: [] };
  if (input.some(row => !validDate(rawDate(row)))) return { state: "invalid", reason: "invalid_date", rows: [] };
  const causal = input.filter(row => rawDate(row) <= asOfDate);
  if (!causal.length || !causal.some(row => rawDate(row) === asOfDate)) return { state: "stale", reason: "missing_as_of_session", rows: [] };
  const retained = causal.filter(row => rawDate(row) >= dates[0]);
  const byDate = new Map();
  for (const row of retained) {
    const date = rawDate(row);
    if (byDate.has(date)) return { state: "invalid", reason: "duplicate_date", rows: [] };
    if (!validPriceRow(row)) return { state: "invalid", reason: "invalid_ohlc", rows: [] };
    if (requireActivity && (!positive(row.volume ?? row.vol) || !positive(row.amount))) return { state: "invalid", reason: "missing_activity", rows: [] };
    byDate.set(date, row);
  }
  if (retained.length !== dates.length || dates.some(date => !byDate.has(date))) return { state: "invalid", reason: "incomplete_sessions", rows: [] };
  return { state: "ready", reason: "complete", rows: dates.map(date => byDate.get(date)) };
}

function selectionContext(rawOptions = {}, benchmark = []) {
  const calendar = createTradingCalendar();
  const explicit = Object.hasOwn(rawOptions, "asOfDate");
  const asOfDate = explicit ? (validDate(rawOptions.asOfDate) ? rawOptions.asOfDate : null) : calendar.expectedCloseDate().date;
  const requested = numeric(rawOptions.minCurrentHistoryBars) ? Number(rawOptions.minCurrentHistoryBars) : 120;
  const requiredBars = Math.round(Math.max(60, Math.min(420, requested)));
  const supplied = Object.hasOwn(rawOptions, "marketDates");
  const marketDates = supplied ? rawOptions.marketDates : asOfDate ? calendar.sessionsThrough(asOfDate, Math.max(80, requiredBars)) : null;
  const calendarReady = Boolean(asOfDate && Array.isArray(marketDates) && marketDates.length >= requiredBars &&
    marketDates.every((date, index) => validDate(date) && (!index || date > marketDates[index - 1])) && marketDates.at(-1) === asOfDate);
  const stockDates = calendarReady ? marketDates.slice(-requiredBars) : [];
  const benchmarkDates = calendarReady && marketDates.length >= 80 ? marketDates.slice(-80) : [];
  const preparedBenchmark = prepareWindow(benchmark, asOfDate, benchmarkDates, false);
  return { asOfDate, requiredBars, calendarReady, stockDates,
    benchmark: preparedBenchmark.state === "ready" ? preparedBenchmark.rows : [],
    benchmarkReady: preparedBenchmark.state === "ready", benchmarkReason: preparedBenchmark.reason };
}

function prepareStock(input, context) {
  if (!context.calendarReady) return { state: "invalid", reason: "unknown_calendar", rows: [] };
  return prepareWindow(input, context.asOfDate, context.stockDates, true);
}

const relativeParameters = Object.freeze({ recentLimitMinAge: 2, recentLimitMaxAge: 15,
  relativeShortPeriod: 20, relativeLongPeriod: 60, maTrend: 20, maLong: 60, maSlopeSessions: 5,
  highLookback: 60, maxDistanceFromHighPercent: 10, maxMa20ExtensionPercent: 10,
  trueRangePeriod: 14, maxAtrExtension: 2, amountPeriod: 20, minMedianAmount: 200000000 });

/** Price/benchmark observations at i use only dates through i. Amount is capacity, not fund flow. */
function relativeStrengthAt(history, index, benchmark = []) {
  const cfg = relativeParameters;
  if (index < cfg.relativeLongPeriod) return { passed: false, reason: "insufficient_history" };
  const recent = history.slice(index - cfg.relativeLongPeriod, index + 1);
  const benchmarkByDate = new Map(benchmark.filter(row => rawDate(row) <= history[index].date).map(row => [rawDate(row), row]));
  const market = recent.map(row => benchmarkByDate.get(row.date));
  if (market.some(row => !row || !validPriceRow(row)) || recent.some(row => !validPriceRow(row) || !positive(row.volume) || !positive(row.amount))) return { passed: false, reason: "incomplete_relative_window" };
  const closes = history.map(row => Number(row.close)), close = closes[index];
  const averageClose = (end, period) => mean(closes.slice(end - period + 1, end + 1));
  const ma20 = averageClose(index, 20), ma60 = averageClose(index, 60), previousMa20 = averageClose(index - 5, 20);
  const marketClose = Number(market.at(-1).close), marketMa60 = mean(market.slice(-60).map(row => Number(row.close)));
  const stockReturn20 = close / closes[index - 20] - 1, stockReturn60 = close / closes[index - 60] - 1;
  const marketReturn20 = marketClose / Number(market.at(-21).close) - 1, marketReturn60 = marketClose / Number(market[0].close) - 1;
  const high60 = Math.max(...closes.slice(index - 59, index + 1));
  const atr14 = mean(history.slice(index - 13, index + 1).map((row, offset) => {
    const previousClose = closes[index - 14 + offset];
    return Math.max(Number(row.high) - Number(row.low), Math.abs(Number(row.high) - previousClose), Math.abs(Number(row.low) - previousClose));
  }));
  const medianAmount20 = median(history.slice(index - 19, index + 1).map(row => Number(row.amount)));
  const extension = close - ma20, current = history[index];
  const passed = close > ma20 && ma20 > ma60 && ma20 > previousMa20 && stockReturn20 > marketReturn20 && stockReturn60 > marketReturn60 &&
    marketClose >= marketMa60 && close >= high60 * .9 && close / ma20 <= 1.1 && extension <= atr14 * 2 &&
    medianAmount20 >= cfg.minMedianAmount && Number(current.high) > Number(current.low);
  return { passed, stockReturn20, stockReturn60, marketReturn20, marketReturn60, ma20, ma60, previousMa20,
    marketClose, marketMa60, high60, atr14, medianAmount20, extension, reason: passed ? "relative_strength_and_capacity" : "relative_conditions_not_met" };
}

const relativeDefinition = {
  id: "relative_strength_pullback", version: "1.1.0", type: "base", name: "涨停池相对强势回踩", family: "pullback",
  detail: "近期涨停后MA10回踩，20及60日收益均跑赢中证全指，并约束趋势、波动偏离与成交容量。",
  conditions: ["涨停后2至15日MA10回踩且支撑有效", "20及60日收益均跑赢同日中证全指；指数不低于MA60", "Close>MA20>MA60且MA20五日上升；距60日收盘高点不超过10%", "MA20偏离不超过10%且不超过2倍14日平均TR；20日成交额中位数至少2亿元；当日非一价"],
  risk: "相对强势在急速反转时仍会失效，容量和波动门槛不能证明次日可成交或保证收益。",
  parameters: relativeParameters, componentNames: [],
  dataRequirements: ["120个完整股票交易日及正有限成交量/额", "同日对齐的80日中证全指", "公开原始日线与常规涨停规则；缺完整历史公司行为证明"],
  scope: "全市场A股（剔除ST，含北交所）逐只判定；不是全市场横截面排名",
  evidenceLevel: "有研究思路来源的自定义技术候选，未证明收益优越性",
  sources: [{ title: "AQR：Fact, Fiction and Momentum Investing（2014）", url: "https://www.aqr.com/insights/research/journal-article/fact-fiction-and-momentum-investing?aqrPDF=1" },
    { title: "Shi、Zhou：Time series momentum and contrarian effects in the Chinese stock market（2017）", url: "https://arxiv.org/abs/1702.07374" }],
  adaptationNote: "仅借鉴相对动量研究思路，不是论文复刻。固定阈值为预先指定的工程假设，未证明本套短线规则或参数收益更优；原始/复权与公司行为证据不足时仅作技术候选。",
  matches: feature => feature?.riskVeto === true && feature.limitMa10Pullback === true && feature.relativeStrength?.passed === true,
  reasons: () => ["MA10回踩并保持涨停日支撑", "20及60日收益跑赢同日指数，趋势、偏离和容量条件同时满足"]
};

/**
 * "低位" means the close before the limit-up sits in the lower part of its own
 * recent range (default: last 100 sessions before the event). Returns 0..1, or
 * null when fewer than `minBars` prior sessions exist. Uses bars before the event only.
 */
const LOW_POSITION = Object.freeze({ lookback: 100, minBars: 60, maxPosition: 0.6 });
function preLimitRangePosition(history, eventIndex, { lookback = LOW_POSITION.lookback, minBars = LOW_POSITION.minBars } = {}) {
  if (!Array.isArray(history) || !Number.isInteger(eventIndex) || eventIndex < 1) return null;
  const rows = history.slice(Math.max(0, eventIndex - lookback), eventIndex);
  if (rows.length < minBars || rows.some(row => !validPriceRow(row))) return null;
  const high = Math.max(...rows.map(row => Number(row.high))), low = Math.min(...rows.map(row => Number(row.low)));
  const reference = Number(history[eventIndex - 1].close);
  return high > low ? (reference - low) / (high - low) : null;
}

module.exports = { selectionContext, prepareStock, relativeStrengthAt, relativeDefinition, preLimitRangePosition, LOW_POSITION };
