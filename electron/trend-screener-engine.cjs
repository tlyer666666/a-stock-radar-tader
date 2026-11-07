"use strict";

const PRICE_KEYS = ["open", "high", "low", "close"];
const { isBseAshareCode, roundPrice } = require("./price-limit-rules.cjs");
// C2-03：与选股报告、策略信号共用一个 ST/退市名称判定（原先三处口径不一致）。
const { isRiskSecurityName } = require("./strategy-intelligence.cjs");
const DAY_MS = 86_400_000;

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Exchange prices round half up on the cent. `+ Number.EPSILON` (2.2e-16) is far
// below the floating-point error of `price * 100` at these magnitudes, so it
// silently rounded x.xx5 DOWN by one cent for some previous closes (17.15 * 1.1
// became 18.86 instead of 18.87). That made a genuine limit-up bar look like a
// price/limit conflict and could also accept a non-limit bar as the anchor.
// Delegate to the single audited implementation in price-limit-rules.
const cents = value => roundPrice(value);

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
  if (isBseAshareCode(code)) return "beijing";
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

/** Prepare one causal, exact-date 250-session window for every trend model.
 * Older feed pagination may differ; a missing date within the retained window
 * must never be hidden by intersecting or by joining array offsets.
 */
function prepareAlignedTrendSeries({ rawRows, adjustedRows, benchmarkRows, asOf } = {}) {
  if (!isoDate(asOf)) return unavailable("截止日期无效");
  const rawFull = prepareRows(rawRows, asOf, true);
  const adjustedFull = prepareRows(adjustedRows, asOf, false);
  if (!rawFull || !adjustedFull) return unavailable("原始或前复权日线存在缺失、重复或无效字段");
  const adjustedDates = new Set(adjustedFull.map(row => row.date));
  const common = rawFull.filter(row => adjustedDates.has(row.date)).slice(-250);
  if (common.length < 250) return unavailable("有效共同日线少于250根");
  const firstDate = common[0].date;
  const raw = rawFull.filter(row => row.date >= firstDate);
  const adjusted = adjustedFull.filter(row => row.date >= firstDate);
  if (raw.length !== 250 || adjusted.length !== 250 || raw.some((row, i) => row.date !== adjusted[i].date)) {
    return unavailable("原始与前复权日线日期不一致，250日窗口存在缺失行情");
  }
  let benchmark = null;
  if (benchmarkRows !== undefined && benchmarkRows !== null && !Array.isArray(benchmarkRows)) {
    return unavailable("中证全指日线字段无效");
  }
  if (Array.isArray(benchmarkRows) && benchmarkRows.length) {
    const full = prepareBenchmarkRows(benchmarkRows, asOf);
    if (!full) return unavailable("中证全指日线字段无效");
    benchmark = full.slice(-250);
    const marketWindow = benchmark.slice(-80), stockWindow = raw.slice(-80);
    if (marketWindow.length < 80 || marketWindow.some((row, i) => row.date !== stockWindow[i].date)) {
      return unavailable("近80个交易所交易日与个股K线不齐或基准不足，可能存在停牌或缺失行情");
    }
    // Use older benchmark sessions when supplied to catch a date omitted by
    // both stock feeds. Their availability is optional, never a new data gate.
    const stockDates = new Set(raw.map(row => row.date));
    if (benchmark.some(row => row.date >= firstDate && !stockDates.has(row.date))) {
      return unavailable("250日窗口内缺少已有基准交易日对应的个股行情");
    }
  }
  const factor = raw.at(-1).close / adjusted.at(-1).close;
  if (!finiteNumber(factor) || factor <= 0) return unavailable("前复权价无法换算实际报价");
  for (let i = raw.length - 20; i < raw.length; i++) {
    const ratio = raw[i].close / adjusted[i].close;
    if (!finiteNumber(ratio) || Math.abs(ratio / factor - 1) > .002) {
      return unavailable("近20日复权因子变化，原始成交量不可直接与复权形态混用");
    }
  }
  const prices = adjusted.map((row, i) => ({ ...row,
    open: row.open * factor, high: row.high * factor, low: row.low * factor, close: row.close * factor,
    volume: raw[i].volume, amount: raw[i].amount }));
  if (prices.some(row => !validRow(row, false))) return unavailable("复权换算价格无效");
  return { kind: "prepared", raw, adjusted, benchmark, prices, factor };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
  if (!Array.isArray(rows) || rows.length < 15 || !rows.slice(-15).every(row => [row?.high, row?.low, row?.close].every(finiteNumber))) return null;
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

/**
 * `group` 用于区分「复合判定的总括项」与「构成它的分项」。
 * 例：A 形态命中是一个 AND 组合，A时间窗/A均线回踩/A缩量/A突破与放量 是它的分项。
 * 若不区分，证据链会被误读成「命中了 6 条独立条件」，夸大信号强度。
 * 该字段是增量信息，不影响任何判定逻辑。
 */
function evidence(label, passed, value, rule, group) {
  return { label, passed, value: String(value), rule, ...(group ? { group } : {}) };
}

/** Identity, asset-type and ST gates shared by the full evaluation and the fast prefilter.
 * Both entry points must accept and reject exactly the same securities, in the same order. */
function gateTrendSecurity(security) {
  const code = String(security?.code || "");
  const name = String(security?.name || "");
  if (!/^\d{6}$/.test(code) || !name || !security?.secid) return { error: unavailable("证券身份字段缺失或无效") };
  if (security.assetType && security.assetType !== "stock") return { error: excluded("非股票资产") };
  if (security.isST === true || isRiskSecurityName(name)) return { error: excluded("ST或退市证券") };
  const board = boardFor(code);
  if (!board) return { error: excluded("非沪深北A股代码") };
  return { code, name, board };
}

/** Raw-series gates shared by the full evaluation and the fast prefilter: ST trading state,
 * suspension, benchmark calendar alignment and freshness. */
function gateTrendSeries({ raw, benchmarkRows, asOf }) {
  if (raw.slice(-15).some((row) => row.isST === true)) return { error: excluded("近期存在ST交易状态") };
  if (raw.at(-1).volume <= 0 || raw.at(-1).amount <= 0) return { error: unavailable("当日停牌或无有效成交") };
  if (raw.slice(-20).some((row) => row.volume <= 0 || row.amount <= 0)) {
    return { error: unavailable("近20日存在停牌或无有效成交记录") };
  }
  let benchmark = null;
  if (Array.isArray(benchmarkRows) && benchmarkRows.length) {
    benchmark = prepareBenchmarkRows(benchmarkRows, asOf);
    if (!benchmark) return { error: unavailable("中证全指日线字段无效") };
    // The broad index is a conservative exchange-calendar proxy for all four A-share boards.
    // A source that omits a suspended stock's bar must not shorten limit/MA/volume windows.
    if (benchmark.length < 80) return { error: unavailable("基准交易日历不足80日，无法核对信号窗口") };
    const exchangeDates = benchmark.slice(-80);
    const stockDates = raw.slice(-80);
    if (exchangeDates.some((row, i) => row.date !== stockDates[i].date)) {
      return { error: unavailable("近80个交易所交易日与个股K线不齐，可能存在停牌或缺失行情") };
    }
    const retained = raw.slice(-250), retainedDates = new Set(retained.map(row => row.date));
    if (benchmark.some(row => row.date >= retained[0].date && !retainedDates.has(row.date))) {
      return { error: unavailable("250日窗口内缺少已有基准交易日对应的个股行情") };
    }
  }
  const expectedDate = benchmark?.length ? benchmark.at(-1).date : asOf;
  if (raw.at(-1).date !== expectedDate || (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${raw.at(-1).date}T00:00:00Z`)) / DAY_MS > 14) {
    return { error: unavailable("日线未更新至最近交易日") };
  }
  return { benchmark };
}

function trendAnchorShape(raw, prices, t0) {
  const last = prices.length - 1, close = prices[last].close, t0Low = prices[t0].low;
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
  return { daysSinceLimit, prior3, avgVolume3, avgVolume5, pullbackTouch, aWindow, aContracted,
    aBreakout, aVolume, a, consolidation, consolidationLow, consolidationHigh, bWindow,
    bRange, bContracted, bBreakout, bVolume, b };
}

function evaluateTrendStock({ security, rawRows, adjustedRows, benchmarkRows, asOf } = {}, { anchorPolicy = "latest" } = {}) {
  if (!isoDate(asOf)) return unavailable("截止日期无效");
  const gate = gateTrendSecurity(security);
  if (gate.error) return gate.error;
  const { code, name, board } = gate;

  const prepared = prepareAlignedTrendSeries({ rawRows, adjustedRows, benchmarkRows, asOf });
  if (prepared.kind !== "prepared") return prepared;
  const { raw, prices } = prepared;
  const series = gateTrendSeries({ raw, benchmarkRows: prepared.benchmark, asOf });
  if (series.error) return series.error;
  const benchmark = prepared.benchmark;

  const last = prices.length - 1;
  const close = prices[last].close;
  const ma20 = maAt(prices, last, 20);
  const ma60 = maAt(prices, last, 60);
  const avgAmount20 = mean(raw.slice(-20), "amount");
  const deviationPercent = (close / ma20 - 1) * 100;
  const anchors = [];
  for (let i = last; i >= last - 14; i--) {
    const state = limitAt(raw, i, board);
    if (state.invalid) return unavailable("涨停价或日涨跌幅与原始收盘价冲突，无法核验涨停");
    if (state.limited) {
      anchors.push({ index: i, evidence: state.evidence });
      if (anchorPolicy !== "active") break;
    }
  }
  if (!anchors.length) return excluded("最近15根交易日没有收盘涨停");
  let anchor = anchors[0];
  if (anchorPolicy === "active") {
    const supported = anchors.filter(({ index }) => !prices.slice(index + 1).some(row => row.close < prices[index].low - 1e-9));
    if (!supported.length) return excluded("涨停后收盘跌破t0最低价，最近15日没有有效活动形态");
    // Prefer the oldest still-supported shape that
    // actually triggers A/B today. Otherwise retain the latest valid watch.
    anchor = [...supported].reverse().find(({ index }) => {
      const shape = trendAnchorShape(raw, prices, index);
      return last - index >= 4 && (shape.a || shape.b);
    }) || supported[0];
  }
  const t0 = anchor.index, limitEvidence = anchor.evidence;
  const t0Low = prices[t0].low;
  const trend = close > ma20 && ma20 > ma60 && ma20 > maAt(prices, last - 5, 20);
  if (!trend) return excluded("未满足收盘价>MA20>MA60且MA20上升");
  if (prices.slice(t0 + 1).some((row) => row.close < t0Low - 1e-9)) return excluded("涨停后收盘跌破t0最低价");
  if (avgAmount20 < 200_000_000) return excluded("近20日平均成交额不足2亿元");

  const { daysSinceLimit, prior3, avgVolume3, avgVolume5, pullbackTouch, aWindow, aContracted,
    aBreakout, aVolume, a, consolidation, consolidationLow, consolidationHigh, bWindow,
    bRange, bContracted, bBreakout, bVolume, b } = trendAnchorShape(raw, prices, t0);
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
  // 偏离度必须落在 (0, 10] 区间：上界防止追高，下界显式表达
  // 「信号日必须在 MA20 之上」。trend 门槛已强制 close > ma20，
  // 这里再写一次下界是为了让 signal 的成立条件自洽 —— 将来若 trend 规则调整，
  // 不会因为负数也满足 `<= 10` 而静默放行。
  const deviationInRange = deviationPercent > 0 && deviationPercent <= 10;
  const signal = patterns.length > 0 && deviationInRange && riskValid && marketOpen;
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
      evidence("收盘涨停", true, raw[t0].date, anchorPolicy === "active" ? "最近15日内优先最早仍有支撑且当日触发A/B的4–14日锚点；否则最近有效观察锚点" : "最近15根交易日内最近一次收盘涨停"),
      evidence("趋势", trend, `${close.toFixed(2)} / ${ma20.toFixed(2)} / ${ma60.toFixed(2)}`, "收盘价>MA20>MA60且MA20上升"),
      evidence("成交额", true, avgAmount20.toFixed(0), "近20日平均成交额至少2亿元"),
      evidence("A缩量回踩", a, a ? "命中" : "未命中", "涨停后第4–14日三根缩量回踩并放量反包", "summary"),
      evidence("A时间窗", aWindow, `${daysSinceLimit}日`, "涨停后第4–14日", "detail"),
      evidence("A均线回踩", pullbackTouch, pullbackTouch ? "触及" : "未触及", "此前三根至少一根最低价在当日MA20的98%–102%", "detail"),
      evidence("A缩量", aContracted, `${(avgVolume3 / raw[t0].volume * 100).toFixed(1)}%`, "三根均量不超过t0量70%", "detail"),
      evidence("A突破与放量", aBreakout && aVolume, `${aBreakout ? "突破" : "未突破"} / ${(raw[last].volume / avgVolume5 * 100).toFixed(1)}%`, "收盘高于前高且当日量不低于前五根均量", "detail"),
      evidence("B整理突破", b, b ? "命中" : "未命中", "涨停后第4–11日整理并放量突破", "summary"),
      evidence("B时间窗", bWindow, `${consolidation.length}根`, "t0后3–10根整理且信号日在第4–11日", "detail"),
      evidence("B整理幅度", bRange, `${((consolidationHigh / consolidationLow - 1) * 100).toFixed(1)}%`, "整理最高/最低-1不超过10%", "detail"),
      evidence("B缩量", bContracted, consolidation.length ? `${(mean(consolidation, "volume") / raw[t0].volume * 100).toFixed(1)}%` : "无整理", "整理均量不超过t0量80%", "detail"),
      evidence("B突破与放量", bBreakout && bVolume, `${bBreakout ? "突破" : "未突破"} / ${(raw[last].volume / avgVolume5 * 100).toFixed(1)}%`, "收盘突破整理最高价且当日量不低于前五根均量120%", "detail"),
      evidence("偏离MA20", deviationInRange, `${deviationPercent.toFixed(2)}%`, "信号时在 MA20 之上且偏离不超过10%"),
      evidence("参考风险区间", riskValid, riskValid ? `${cents(stop)}–${maxEntry}` : "无有效区间", "S<P≤min(1.03C,S/0.92)"),
      evidence("市场门槛", marketOpen, marketBlocked ? "暂停" : benchmarkMa60 === null ? "未知" : "通过", "中证全指收盘不低于MA60")
    ],
    metrics: { close: cents(raw[last].close), ma20: cents(ma20), ma60: cents(ma60),
      avgAmount20: Number(avgAmount20.toFixed(2)), medianAmount20: median(raw.slice(-20).map(row => row.amount)), deviationPercent: Number(deviationPercent.toFixed(2)),
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

/** 最近 61 根原始日线里是否有除权等价格基准变化（报告涨跌幅与原始收盘不符，或昨收接不上）。 */
function rawBasisChanged(raw, sessions = 61) {
  for (let i = Math.max(1, raw.length - sessions); i < raw.length; i += 1) {
    const row = raw[i], previous = raw[i - 1];
    const reported = changePercent(row);
    if (reported !== null && Math.abs(reported - (row.close / previous.close - 1) * 100) > 0.75) return true;
    const preClose = finiteNumber(row.preClose) ? row.preClose : finiteNumber(row.previousClose) ? row.previousClose : null;
    if (preClose !== null && Math.abs(preClose / previous.close - 1) > 0.002) return true;
  }
  return false;
}

/** Necessary raw-data conditions only. A null result requires the complete
 * adjusted-price evaluation; it is never an affirmative candidate result.
 * Sharing prepareRows/limitAt keeps the fast path on the classic rules.
 * requireLimit=false（只选了经典技术策略库）：不要求近期涨停；没有除权的股票先用原始价核对趋势，
 * 不满足就不必再下载前复权日线（无除权时原始价与前复权只差一个常数比例，均线关系相同）。 */
function prefilterTrendStock({ security, rawRows, benchmarkRows, asOf } = {}, { requireLimit = true } = {}) {
  if (!isoDate(asOf)) return unavailable("截止日期无效");
  const gate = gateTrendSecurity(security);
  if (gate.error) return gate.error;
  const { board } = gate;

  const raw = prepareRows(rawRows, asOf, true);
  if (!raw) return unavailable("原始日线存在缺失、重复或无效字段");
  if (raw.length < 250) return unavailable("有效日线少于250根");
  const series = gateTrendSeries({ raw, benchmarkRows, asOf });
  if (series.error) return series.error;
  let found = false;
  for (let i = raw.length - 1; i >= raw.length - 15; i--) {
    const state = limitAt(raw, i, board);
    if (state.invalid) return unavailable("涨停价或日涨跌幅与原始收盘价冲突，无法核验涨停");
    if (state.limited) { found = true; if (requireLimit) break; }
  }
  if (requireLimit && !found) return excluded("最近15根交易日没有收盘涨停");
  if (mean(raw.slice(-20), "amount") < 200_000_000) return excluded("近20日平均成交额不足2亿元");
  if (!requireLimit && !rawBasisChanged(raw)) {
    const last = raw.length - 1, close = raw[last].close, ma20 = maAt(raw, last, 20), ma60 = maAt(raw, last, 60);
    if (!(close > ma20 && ma20 > ma60 && ma20 > maAt(raw, last - 5, 20))) return excluded("未满足收盘价>MA20>MA60且MA20上升");
  }
  return null;
}

/**
 * 经典技术策略库的共同底座：只要求身份/日线/交易日历核验、上升趋势（收盘>MA20>MA60且MA20上升）
 * 和近20日平均成交额≥2亿元，不要求近期涨停。若最近15日内有收盘涨停且此后收盘未跌破涨停日最低价，
 * 记下涨停日供止损参考（止损取涨停日最低价与前低减0.5ATR的较高者）。
 */
function evaluateTrendBase({ security, rawRows, adjustedRows, benchmarkRows, asOf } = {}) {
  if (!isoDate(asOf)) return unavailable("截止日期无效");
  const gate = gateTrendSecurity(security);
  if (gate.error) return gate.error;
  const { code, name, board } = gate;
  const prepared = prepareAlignedTrendSeries({ rawRows, adjustedRows, benchmarkRows, asOf });
  if (prepared.kind !== "prepared") return prepared;
  const { raw, prices } = prepared;
  const series = gateTrendSeries({ raw, benchmarkRows: prepared.benchmark, asOf });
  if (series.error) return series.error;
  const benchmark = prepared.benchmark;
  const last = prices.length - 1;
  const close = prices[last].close;
  const ma20 = maAt(prices, last, 20);
  const ma60 = maAt(prices, last, 60);
  const avgAmount20 = mean(raw.slice(-20), "amount");
  const deviationPercent = (close / ma20 - 1) * 100;
  let anchor = null;
  for (let i = last; i >= last - 14; i--) {
    const state = limitAt(raw, i, board);
    if (state.invalid) return unavailable("涨停价或日涨跌幅与原始收盘价冲突，无法核验涨停");
    if (state.limited && !anchor && !prices.slice(i + 1).some(row => row.close < prices[i].low - 1e-9)) anchor = { index: i, evidence: state.evidence };
  }
  const trend = close > ma20 && ma20 > ma60 && ma20 > maAt(prices, last - 5, 20);
  if (!trend) return excluded("未满足收盘价>MA20>MA60且MA20上升");
  if (avgAmount20 < 200_000_000) return excluded("近20日平均成交额不足2亿元");
  const benchmarkByDate = new Map((benchmark || []).map((row) => [row.date, row]));
  const benchmarkStart = benchmarkByDate.get(prices[last - 20].date);
  const benchmarkEnd = benchmarkByDate.get(prices[last].date);
  const relativeStrength20 = benchmarkStart && benchmarkEnd
    ? ((prices[last].close / prices[last - 20].close - 1) - (benchmarkEnd.close / benchmarkStart.close - 1)) * 100 : null;
  const warnings = [];
  if (anchor?.evidence === "calculated") warnings.push("涨停价按常规板块规则推算，待官方数据核验");
  warnings.push("观察结果需复核次日交易状态、公告及交易权限");
  const candidate = {
    security: { code, name, secid: String(security.secid),
      ...(security.industry ? { industry: String(security.industry) } : {}), assetType: "stock" },
    board, asOf: raw[last].date, limitDate: anchor ? raw[anchor.index].date : null, daysSinceLimit: anchor ? last - anchor.index : null,
    patterns: [], stage: "watch", ...(anchor ? { limitEvidence: anchor.evidence } : {}),
    evidence: [
      evidence("趋势", trend, `${close.toFixed(2)} / ${ma20.toFixed(2)} / ${ma60.toFixed(2)}`, "收盘价>MA20>MA60且MA20上升"),
      evidence("成交额", true, avgAmount20.toFixed(0), "近20日平均成交额至少2亿元"),
      ...(anchor ? [evidence("近期涨停", true, raw[anchor.index].date, "最近15日内收盘涨停且此后收盘未跌破涨停日最低价；仅作止损参考，不是入选条件")] : [])
    ],
    metrics: { close: cents(raw[last].close), ma20: cents(ma20), ma60: cents(ma60),
      avgAmount20: Number(avgAmount20.toFixed(2)), medianAmount20: median(raw.slice(-20).map(row => row.amount)), deviationPercent: Number(deviationPercent.toFixed(2)),
      relativeStrength20: relativeStrength20 === null ? null : Number(relativeStrength20.toFixed(2)),
      atr14: Number(atr14(prices).toFixed(4)) },
    plan: null, warnings
  };
  return { kind: "candidate", reason: "趋势底座通过", candidate };
}

module.exports = { evaluateTrendStock, evaluateTrendBase, rankTrendCandidates, prefilterTrendStock, gateTrendSeries, cents,
  trendMath: Object.freeze({ prepareRows, prepareBenchmarkRows, prepareAlignedTrendSeries, maAt, atr14, mean, ceilCents, floorCents, cents }) };
