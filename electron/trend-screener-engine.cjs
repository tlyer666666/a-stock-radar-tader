"use strict";

const PRICE_KEYS = ["open", "high", "low", "close"];
const DAY_MS = 86_400_000;

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function cents(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function floorCents(value) {
  return Math.floor((value + 1e-9) * 100) / 100;
}

function ceilCents(value) {
  return Math.ceil((value - 1e-9) * 100) / 100;
}

function boardFor(code) {
  if (/^(?:000|001|002|003|600|601|603|605)\d{3}$/.test(code)) return "main";
  if (/^(?:300|301|302)\d{3}$/.test(code)) return "growth";
  if (/^(?:688|689)\d{3}$/.test(code)) return "star";
  if (/^(?:4|8)\d{5}$/.test(code) || /^920\d{3}$/.test(code)) return "beijing";
  return null;
}

function unavailable(reason) { return { kind: "unavailable", reason }; }
function excluded(reason) { return { kind: "excluded", reason }; }

function validRow(row, raw) {
  if (!row || !isoDate(row.date)) return false;
  if (!PRICE_KEYS.every((key) => finiteNumber(row[key]) && row[key] > 0)) return false;
  if (!(row.low <= row.open && row.open <= row.high && row.low <= row.close && row.close <= row.high)) return false;
  if (!finiteNumber(row.volume) || row.volume < 0 || !finiteNumber(row.amount) || row.amount < 0) return false;
  if (raw && row.upperLimit !== undefined && (!finiteNumber(row.upperLimit) || row.upperLimit <= 0)) return false;
  if (raw && row.isST !== undefined && typeof row.isST !== "boolean") return false;
  if (raw && row.noPriceLimit !== undefined && typeof row.noPriceLimit !== "boolean") return false;
  for (const key of ["changePct", "changePercent", "pctChange"]) {
    if (raw && row[key] !== undefined && !finiteNumber(row[key])) return false;
  }
  return true;
}

function prepareRows(rows, asOf, raw) {
  if (!Array.isArray(rows)) return null;
  if (rows.some((row) => !row || !isoDate(row.date))) return null;
  const selected = rows.filter((row) => row.date <= asOf);
  if (selected.some((row) => !validRow(row, raw))) return null;
  selected.sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].date === selected[i - 1].date) return null;
  }
  return selected;
}

// The CSI benchmark supplies dates and prices only. Its missing volume/amount
// remain missing; stock bars still use the stricter validator above.
function prepareBenchmarkRows(rows, asOf) {
  if (!Array.isArray(rows) || rows.some(row => !row || !isoDate(row.date))) return null;
  const selected = rows.filter(row => row.date <= asOf);
  if (selected.some(row => !PRICE_KEYS.every(key => finiteNumber(row[key]) && row[key] > 0) ||
      !(row.low <= row.open && row.open <= row.high && row.low <= row.close && row.close <= row.high) ||
      ["volume", "amount"].some(key => row[key] != null && (!finiteNumber(row[key]) || row[key] < 0)))) return null;
  selected.sort((a, b) => a.date.localeCompare(b.date));
  if (selected.some((row, i) => i > 0 && row.date === selected[i - 1].date)) return null;
  return selected;
}

function mean(rows, key) {
  return rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
}

function maAt(rows, end, length) {
  if (end < length - 1) return null;
  let sum = 0;
  for (let i = end - length + 1; i <= end; i++) sum += rows[i].close;
  return sum / length;
}

function atr14(rows) {
  let sum = 0;
  for (let i = rows.length - 14; i < rows.length; i++) {
    const row = rows[i];
    const previous = rows[i - 1];
    sum += Math.max(row.high - row.low, Math.abs(row.high - previous.close), Math.abs(row.low - previous.close));
  }
  return sum / 14;
}

function changePercent(row) {
  for (const key of ["changePct", "changePercent", "pctChange"]) {
    if (row[key] !== undefined) return row[key];
  }
  return null;
}

function limitAt(rows, i, board) {
  const row = rows[i];
  const previous = rows[i - 1];
  if (!previous) return { limited: false, evidence: "calculated" };
  if (row.noPriceLimit === true) return { limited: false, evidence: "official" };
  if (row.upperLimit !== undefined) {
    if (row.close > row.upperLimit + 0.005) return { invalid: true, limited: false, evidence: "official" };
    return { limited: Math.abs(row.close - row.upperLimit) < 0.005, evidence: "official" };
  }
  const reported = changePercent(row);
  const rawChange = (row.close / previous.close - 1) * 100;
  if (reported !== null && Math.abs(reported - rawChange) > 0.75) {
    return { invalid: true, limited: false, evidence: "calculated" };
  }
  const rate = board === "main" ? 0.1 : board === "beijing" ? 0.3 : 0.2;
  const target = cents(previous.close * (1 + rate));
  if (row.close > target + 0.005) return { invalid: true, limited: false, evidence: "calculated" };
  return { limited: Math.abs(row.close - target) < 0.005, evidence: "calculated" };
}

function evidence(label, passed, value, rule) {
  return { label, passed, value: String(value), rule };
}

function evaluateTrendStock({ security, rawRows, adjustedRows, benchmarkRows, asOf } = {}) {
  if (!isoDate(asOf)) return unavailable("截止日期无效");
  const code = String(security?.code || "");
  const name = String(security?.name || "");
  if (!/^\d{6}$/.test(code) || !name || !security?.secid) return unavailable("证券身份字段缺失或无效");
  if (security.assetType && security.assetType !== "stock") return excluded("非股票资产");
  if (security.isST === true || /\*?ST|退市|退$/i.test(name)) return excluded("ST或退市证券");
  const board = boardFor(code);
  if (!board) return excluded("非沪深北A股代码");

  const raw = prepareRows(rawRows, asOf, true);
  const adjusted = prepareRows(adjustedRows, asOf, false);
  if (!raw || !adjusted) return unavailable("原始或前复权日线存在缺失、重复或无效字段");
  if (raw.length < 250 || adjusted.length < 250) return unavailable("有效日线少于250根");
  if (raw.length !== adjusted.length || raw.some((row, i) => row.date !== adjusted[i].date)) {
    return unavailable("原始与前复权日线日期不一致");
  }
  if (raw.slice(-15).some((row) => row.isST === true)) return excluded("近期存在ST交易状态");
  if (raw.at(-1).volume <= 0 || raw.at(-1).amount <= 0) return unavailable("当日停牌或无有效成交");
  if (raw.slice(-20).some((row) => row.volume <= 0 || row.amount <= 0)) {
    return unavailable("近20日存在停牌或无有效成交记录");
  }
  let benchmark = null;
  if (Array.isArray(benchmarkRows) && benchmarkRows.length) {
    benchmark = prepareBenchmarkRows(benchmarkRows, asOf);
    if (!benchmark) return unavailable("中证全指日线字段无效");
    // The broad index is a conservative exchange-calendar proxy for all four A-share boards.
    // A source that omits a suspended stock's bar must not shorten limit/MA/volume windows.
    if (benchmark.length < 65) return unavailable("基准交易日历不足65日，无法核对信号窗口");
    const exchangeDates = benchmark.slice(-65);
    const stockDates = raw.slice(-65);
    if (exchangeDates.some((row, i) => row.date !== stockDates[i].date)) {
      return unavailable("近65个交易所交易日与个股K线不齐，可能存在停牌或缺失行情");
    }
  }
  const expectedDate = benchmark?.length ? benchmark.at(-1).date : asOf;
  if (raw.at(-1).date !== expectedDate || (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${raw.at(-1).date}T00:00:00Z`)) / DAY_MS > 14) {
    return unavailable("日线未更新至最近交易日");
  }

  const currentFactor = raw.at(-1).close / adjusted.at(-1).close;
  if (!Number.isFinite(currentFactor) || currentFactor <= 0) return unavailable("前复权价无法换算实际报价");
  for (let i = raw.length - 20; i < raw.length; i++) {
    const ratio = raw[i].close / adjusted[i].close;
    if (!Number.isFinite(ratio) || Math.abs(ratio / currentFactor - 1) > 0.002) {
      return unavailable("近20日复权因子变化，原始成交量不可直接与复权形态混用");
    }
  }
  const prices = adjusted.map((row, i) => ({ ...row,
    open: row.open * currentFactor, high: row.high * currentFactor,
    low: row.low * currentFactor, close: row.close * currentFactor,
    volume: raw[i].volume,
    amount: raw[i].amount
  }));
  const last = prices.length - 1;
  const close = prices[last].close;
  const ma20 = maAt(prices, last, 20);
  const ma60 = maAt(prices, last, 60);
  const avgAmount20 = mean(raw.slice(-20), "amount");
  const deviationPercent = (close / ma20 - 1) * 100;
  let t0 = -1;
  let limitEvidence = "calculated";
  for (let i = last; i >= last - 14; i--) {
    const state = limitAt(raw, i, board);
    if (state.invalid) return unavailable("涨停价或日涨跌幅与原始收盘价冲突，无法核验涨停");
    if (state.limited) { t0 = i; limitEvidence = state.evidence; break; }
  }
  if (t0 < 0) return excluded("最近15根交易日没有收盘涨停");
  const t0Low = prices[t0].low;
  const trend = close > ma20 && ma20 > ma60 && ma20 > maAt(prices, last - 5, 20);
  if (!trend) return excluded("未满足收盘价>MA20>MA60且MA20上升");
  if (prices.slice(t0 + 1).some((row) => row.close < t0Low - 1e-9)) return excluded("涨停后收盘跌破t0最低价");
  if (avgAmount20 < 200_000_000) return excluded("近20日平均成交额不足2亿元");

  const daysSinceLimit = last - t0;
  const prior3 = prices.slice(last - 3, last);
  const prior5 = prices.slice(last - 5, last);
  const avgVolume3 = mean(prior3, "volume");
  const avgVolume5 = mean(prior5, "volume");
  const pullbackTouch = prior3.some((row, offset) => {
    const rowMa20 = maAt(prices, last - 3 + offset, 20);
    return row.low >= rowMa20 * 0.98 && row.low <= rowMa20 * 1.02;
  });
  const aWindow = daysSinceLimit >= 4 && daysSinceLimit <= 14;
  const aContracted = avgVolume3 <= raw[t0].volume * 0.7;
  const aBreakout = close > prices[last - 1].high;
  const aVolume = raw[last].volume >= avgVolume5;
  const a = aWindow && pullbackTouch && aContracted && aBreakout && aVolume;
  const consolidation = prices.slice(t0 + 1, last);
  const consolidationLow = consolidation.length ? Math.min(...consolidation.map((row) => row.low)) : t0Low;
  const consolidationHigh = consolidation.length ? Math.max(...consolidation.map((row) => row.high)) : t0Low;
  const bWindow = daysSinceLimit >= 4 && daysSinceLimit <= 11 &&
    consolidation.length >= 3 && consolidation.length <= 10;
  const bRange = consolidationHigh / consolidationLow - 1 <= 0.1;
  const bContracted = consolidation.length > 0 && mean(consolidation, "volume") <= raw[t0].volume * 0.8;
  const bBreakout = close > consolidationHigh;
  const bVolume = raw[last].volume >= avgVolume5 * 1.2;
  const b = bWindow && bRange && bContracted && bBreakout && bVolume;
  const patterns = [a && "A", b && "B"].filter(Boolean);
  const atr = atr14(prices);
  const patternLow = a ? Math.min(...prior3.map((row) => row.low)) : consolidationLow;
  const stop = ceilCents(Math.max(t0Low, patternLow - 0.5 * atr));
  const maxEntry = floorCents(Math.min(1.03 * close, stop / 0.92));
  const riskValid = stop < maxEntry;
  const benchmarkByDate = new Map((benchmark || []).map((row) => [row.date, row]));
  const start = prices[last - 20];
  const end = prices[last];
  const benchmarkStart = benchmarkByDate.get(start.date);
  const benchmarkEnd = benchmarkByDate.get(end.date);
  const relativeStrength20 = benchmarkStart && benchmarkEnd
    ? ((end.close / start.close - 1) - (benchmarkEnd.close / benchmarkStart.close - 1)) * 100
    : null;
  const benchmarkMa60 = benchmark?.length >= 60 ? maAt(benchmark, benchmark.length - 1, 60) : null;
  const marketBlocked = benchmarkMa60 !== null && benchmark.at(-1).close < benchmarkMa60;
  const warnings = [];
  if (limitEvidence === "calculated") warnings.push("涨停价按常规板块规则推算，待官方数据核验");
  if (!benchmark?.length || benchmarkMa60 === null) warnings.push("中证全指数据不足，市场开仓门槛未知");
  if (marketBlocked) warnings.push("中证全指低于MA60，暂停新开仓");
  warnings.push("观察结果需复核次日交易状态、公告及交易权限");
  const marketOpen = benchmarkMa60 !== null && !marketBlocked;
  const signal = patterns.length > 0 && deviationPercent <= 10 && riskValid && marketOpen;
  const plan = signal ? {
    stop,
    maxEntry,
    maxRiskPercent: Number(((maxEntry - stop) / maxEntry * 100).toFixed(2)),
    holdingDays: "目标持有10–30个交易日；收盘跌破止损或连续两日低于MA20则下一可交易日退出，第30日开盘离场"
  } : null;
  const candidate = {
    security: { code, name, secid: String(security.secid),
      ...(security.industry ? { industry: String(security.industry) } : {}), assetType: "stock" },
    board, asOf: raw[last].date, limitDate: raw[t0].date, daysSinceLimit,
    patterns, stage: signal ? "signal" : "watch", limitEvidence,
    evidence: [
      evidence("收盘涨停", true, raw[t0].date, "最近15根交易日内最近一次收盘涨停"),
      evidence("趋势", trend, `${close.toFixed(2)} / ${ma20.toFixed(2)} / ${ma60.toFixed(2)}`, "收盘价>MA20>MA60且MA20上升"),
      evidence("成交额", true, avgAmount20.toFixed(0), "近20日平均成交额至少2亿元"),
      evidence("A缩量回踩", a, a ? "命中" : "未命中", "涨停后第4–14日三根缩量回踩并放量反包"),
      evidence("A时间窗", aWindow, `${daysSinceLimit}日`, "涨停后第4–14日"),
      evidence("A均线回踩", pullbackTouch, pullbackTouch ? "触及" : "未触及", "此前三根至少一根最低价在当日MA20的98%–102%"),
      evidence("A缩量", aContracted, `${(avgVolume3 / raw[t0].volume * 100).toFixed(1)}%`, "三根均量不超过t0量70%"),
      evidence("A突破与放量", aBreakout && aVolume, `${aBreakout ? "突破" : "未突破"} / ${(raw[last].volume / avgVolume5 * 100).toFixed(1)}%`, "收盘高于前高且当日量不低于前五根均量"),
      evidence("B整理突破", b, b ? "命中" : "未命中", "涨停后第4–11日整理并放量突破"),
      evidence("B时间窗", bWindow, `${consolidation.length}根`, "t0后3–10根整理且信号日在第4–11日"),
      evidence("B整理幅度", bRange, `${((consolidationHigh / consolidationLow - 1) * 100).toFixed(1)}%`, "整理最高/最低-1不超过10%"),
      evidence("B缩量", bContracted, consolidation.length ? `${(mean(consolidation, "volume") / raw[t0].volume * 100).toFixed(1)}%` : "无整理", "整理均量不超过t0量80%"),
      evidence("B突破与放量", bBreakout && bVolume, `${bBreakout ? "突破" : "未突破"} / ${(raw[last].volume / avgVolume5 * 100).toFixed(1)}%`, "收盘突破整理最高价且当日量不低于前五根均量120%"),
      evidence("偏离MA20", deviationPercent <= 10, `${deviationPercent.toFixed(2)}%`, "信号时不超过10%"),
      evidence("参考风险区间", riskValid, riskValid ? `${cents(stop)}–${maxEntry}` : "无有效区间", "S<P≤min(1.03C,S/0.92)"),
      evidence("市场门槛", marketOpen, marketBlocked ? "暂停" : benchmarkMa60 === null ? "未知" : "通过", "中证全指收盘不低于MA60")
    ],
    metrics: { close: cents(raw[last].close), ma20: cents(ma20), ma60: cents(ma60),
      avgAmount20: Number(avgAmount20.toFixed(2)), deviationPercent: Number(deviationPercent.toFixed(2)),
      relativeStrength20: relativeStrength20 === null ? null : Number(relativeStrength20.toFixed(2)),
      atr14: Number(atr.toFixed(4)) },
    plan, warnings
  };
  return { kind: "candidate", reason: signal ? "趋势波段信号" : "趋势波段观察", candidate };
}

function rankTrendCandidates(candidates) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((a, b) => {
    const ra = a?.metrics?.relativeStrength20;
    const rb = b?.metrics?.relativeStrength20;
    if (ra == null && rb != null) return 1;
    if (rb == null && ra != null) return -1;
    if (ra != null && rb != null && ra !== rb) return rb - ra;
    const amountDifference = (b?.metrics?.avgAmount20 || 0) - (a?.metrics?.avgAmount20 || 0);
    return amountDifference || String(a?.security?.code || "").localeCompare(String(b?.security?.code || ""));
  });
}

/** Necessary raw-data conditions only. A null result requires the complete
 * adjusted-price evaluation; it is never an affirmative candidate result.
 * Sharing prepareRows/limitAt keeps the fast path on the classic rules. */
function prefilterTrendStock({ security, rawRows, benchmarkRows, asOf } = {}) {
  if (!isoDate(asOf)) return unavailable("截止日期无效");
  const code = String(security?.code || "");
  const name = String(security?.name || "");
  if (!/^\d{6}$/.test(code) || !name || !security?.secid) return unavailable("证券身份字段缺失或无效");
  if (security.assetType && security.assetType !== "stock") return excluded("非股票资产");
  if (security.isST === true || /\*?ST|退市|退$/i.test(name)) return excluded("ST或退市证券");
  const board = boardFor(code);
  if (!board) return excluded("非沪深北A股代码");
  const raw = prepareRows(rawRows, asOf, true);
  if (!raw) return unavailable("原始日线存在缺失、重复或无效字段");
  if (raw.length < 250) return unavailable("有效日线少于250根");
  if (raw.slice(-15).some((row) => row.isST === true)) return excluded("近期存在ST交易状态");
  if (raw.at(-1).volume <= 0 || raw.at(-1).amount <= 0) return unavailable("当日停牌或无有效成交");
  if (raw.slice(-20).some((row) => row.volume <= 0 || row.amount <= 0)) {
    return unavailable("近20日存在停牌或无有效成交记录");
  }
  let benchmark = null;
  if (Array.isArray(benchmarkRows) && benchmarkRows.length) {
    benchmark = prepareBenchmarkRows(benchmarkRows, asOf);
    if (!benchmark) return unavailable("中证全指日线字段无效");
    if (benchmark.length < 65) return unavailable("基准交易日历不足65日，无法核对信号窗口");
    const stockDates = raw.slice(-65);
    if (benchmark.slice(-65).some((row, i) => row.date !== stockDates[i].date)) {
      return unavailable("近65个交易所交易日与个股K线不齐，可能存在停牌或缺失行情");
    }
  }
  const expectedDate = benchmark?.length ? benchmark.at(-1).date : asOf;
  if (raw.at(-1).date !== expectedDate || (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${raw.at(-1).date}T00:00:00Z`)) / DAY_MS > 14) {
    return unavailable("日线未更新至最近交易日");
  }
  let found = false;
  for (let i = raw.length - 1; i >= raw.length - 15; i--) {
    const state = limitAt(raw, i, board);
    if (state.invalid) return unavailable("涨停价或日涨跌幅与原始收盘价冲突，无法核验涨停");
    if (state.limited) { found = true; break; }
  }
  if (!found) return excluded("最近15根交易日没有收盘涨停");
  if (mean(raw.slice(-20), "amount") < 200_000_000) return excluded("近20日平均成交额不足2亿元");
  return null;
}

module.exports = { evaluateTrendStock, rankTrendCandidates, prefilterTrendStock,
  trendMath: Object.freeze({ prepareRows, prepareBenchmarkRows, maAt, atr14, mean, ceilCents, floorCents }) };
