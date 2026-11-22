"use strict";

/**
 * 策略实测榜的合并与汇总（纯函数，不读盘、不联网、不依赖信号引擎）。
 *
 * 输入是 strategy-signal-engine.buildStrategyLeaderboardChunk 按批返回的紧凑样本；
 * 这里把各批合并，按策略、持有期算出样本数、胜率、平均与中位净收益，以及相对
 * 「同期近期涨停股基线」的优势。
 *
 * 优势按信号日等权：先算每个信号日“策略当日平均 − 基线当日平均”，再对信号日取平均。
 * 这样某一天成批出信号（如大盘见底日）不会主导结论，和策略库留强去弱时的口径一致。
 */

const PRIMARY_HORIZON = 5;
// edgeTolerance：优势绝对值不到 0.3 个百分点（约等于一次买卖的成本）视为与基线持平，避免把噪声当结论。
const DEFAULTS = Object.freeze({ minSamples: 30, minSignalDays: 10, edgeTolerance: 0.3 });

const finite = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const round = (value, digits = 2) => (finite(value) ? Math.round(Number(value) * 10 ** digits) / 10 ** digits : null);
const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function wilsonInterval(wins, total, z = 1.96) {
  if (!total) return null;
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [round(Math.max(0, (center - margin) * 100), 1), round(Math.min(100, (center + margin) * 100), 1)];
}

/** 每个信号日的平均净收益。 */
function dailyMeans(samples) {
  const sums = new Map();
  for (const sample of samples) {
    const date = String(sample[0] || "");
    const value = Number(sample[1]);
    if (!date || !Number.isFinite(value)) continue;
    const entry = sums.get(date) || { sum: 0, count: 0 };
    entry.sum += value;
    entry.count += 1;
    sums.set(date, entry);
  }
  return new Map([...sums].map(([date, entry]) => [date, entry.sum / entry.count]));
}

/** 按信号日等权的优势：只统计基线当天也有样本的信号日。 */
function dayWeightedEdge(strategyDaily, baselineDaily, from = "", to = "") {
  const diffs = [];
  for (const [date, value] of strategyDaily) {
    if ((from && date < from) || (to && date > to)) continue;
    const base = baselineDaily.get(date);
    if (base === undefined) continue;
    diffs.push(value - base);
  }
  return { edge: diffs.length ? mean(diffs) : null, days: diffs.length };
}

function basicStats(samples) {
  const returns = samples.map(sample => Number(sample[1])).filter(Number.isFinite);
  if (!returns.length) return { sampleCount: 0, independentSignalDays: 0, winRate: null, winRateInterval95: null, averageReturn: null, medianReturn: null, averageExcessReturn: null };
  const wins = returns.filter(value => value > 0).length;
  const excess = samples.map(sample => sample[2]).filter(finite).map(Number);
  return {
    sampleCount: returns.length,
    independentSignalDays: new Set(samples.map(sample => String(sample[0] || ""))).size,
    winRate: round((wins / returns.length) * 100, 1),
    winRateInterval95: wilsonInterval(wins, returns.length),
    averageReturn: round(mean(returns)),
    medianReturn: round(median(returns)),
    averageExcessReturn: excess.length ? round(mean(excess)) : null
  };
}

/** 把各批回放结果合并成一份：样本拼接、计数相加；策略顺序取第一批的定义顺序。 */
function mergeLeaderboardChunks(chunks) {
  const list = (Array.isArray(chunks) ? chunks : []).filter(chunk => chunk && chunk.v === 1 && chunk.horizons);
  if (!list.length) return null;
  const [first] = list;
  const merged = {
    v: 1, signalTo: first.signalTo, stockCount: 0, benchmarkReady: true,
    cooldownDays: first.cooldownDays, roundTripCostBps: first.roundTripCostBps,
    baselineMaxDaysSinceLimit: first.baselineMaxDaysSinceLimit, entryRule: first.entryRule || "",
    definitions: Array.isArray(first.definitions) ? first.definitions.map(item => ({ ...item })) : [],
    dataQuality: {},
    horizons: {}
  };
  for (const chunk of list) {
    merged.stockCount += Math.max(0, Math.trunc(Number(chunk.stockCount) || 0));
    if (chunk.benchmarkReady === false) merged.benchmarkReady = false;
    for (const [key, value] of Object.entries(chunk.dataQuality || {})) {
      if (finite(value)) merged.dataQuality[key] = (merged.dataQuality[key] || 0) + Number(value);
    }
    for (const [horizon, bucket] of Object.entries(chunk.horizons || {})) {
      const target = (merged.horizons[horizon] ||= { strategies: {}, baseline: [] });
      for (const [id, entry] of Object.entries(bucket?.strategies || {})) {
        const slot = (target.strategies[id] ||= { samples: [], observedEntries: 0, onePrice: 0, gapSkipped: 0 });
        if (Array.isArray(entry?.samples)) for (const sample of entry.samples) slot.samples.push(sample);
        slot.observedEntries += Number(entry?.observedEntries) || 0;
        slot.onePrice += Number(entry?.onePrice) || 0;
        slot.gapSkipped += Number(entry?.gapSkipped) || 0;
      }
      if (Array.isArray(bucket?.baseline)) for (const sample of bucket.baseline) target.baseline.push(sample);
    }
  }
  return merged;
}

function verdictFor(horizonStats, halves, options) {
  const primary = horizonStats[String(PRIMARY_HORIZON)];
  if (!primary || primary.sampleCount < options.minSamples || primary.independentSignalDays < options.minSignalDays) {
    return { level: "insufficient", text: `样本不足（少于 ${options.minSamples} 笔或 ${options.minSignalDays} 个信号日），只能观察` };
  }
  const edges = Object.values(horizonStats).map(stats => stats.dayWeightedEdge).filter(finite);
  const positive = edges.filter(value => value > options.edgeTolerance).length;
  const negative = edges.filter(value => value < -options.edgeTolerance).length;
  const halfEdges = halves.map(half => half.dayWeightedEdge);
  const bothHalvesPositive = halfEdges.length === 2 && halfEdges.every(value => finite(value) && value > 0);
  const bothHalvesNegative = halfEdges.length === 2 && halfEdges.every(value => finite(value) && value < 0);
  if (edges.length && positive === edges.length && bothHalvesPositive) {
    return { level: "strong", text: "各持有期都跑赢同期涨停股基线，前后两段方向一致" };
  }
  if (edges.length && negative === edges.length && bothHalvesNegative) {
    return { level: "weak", text: "各持有期都跑输同期涨停股基线，前后两段方向一致" };
  }
  if (positive > negative) return { level: "ahead", text: "多数持有期跑赢基线，但不是每段都一致" };
  if (negative > positive) return { level: "behind", text: "多数持有期跑输基线" };
  return { level: "mixed", text: "与基线大致持平，没有稳定优势" };
}

const VERDICT_ORDER = { strong: 0, ahead: 1, mixed: 2, behind: 3, weak: 4, insufficient: 5 };

/**
 * 汇总成排行榜。
 * @param {object[]} chunks buildStrategyLeaderboardChunk 的各批结果
 * @param {{ minSamples?: number, minSignalDays?: number, generatedAt?: string }} [rawOptions]
 */
function summarizeStrategyLeaderboard(chunks, rawOptions = {}) {
  const merged = mergeLeaderboardChunks(chunks);
  if (!merged) return null;
  const options = {
    minSamples: finite(rawOptions.minSamples) ? Math.max(1, Math.trunc(Number(rawOptions.minSamples))) : DEFAULTS.minSamples,
    minSignalDays: finite(rawOptions.minSignalDays) ? Math.max(1, Math.trunc(Number(rawOptions.minSignalDays))) : DEFAULTS.minSignalDays,
    edgeTolerance: DEFAULTS.edgeTolerance
  };
  const horizonKeys = Object.keys(merged.horizons).sort((left, right) => Number(left) - Number(right));
  const primaryKey = horizonKeys.includes(String(PRIMARY_HORIZON)) ? String(PRIMARY_HORIZON) : horizonKeys[0];

  // 信号窗口与前后两段的分界：用基线（最密的那组样本）的信号日，取中位信号日作分界。
  const baselineByHorizon = Object.fromEntries(horizonKeys.map(key => [key, dailyMeans(merged.horizons[key].baseline)]));
  const primaryDates = [...(baselineByHorizon[primaryKey]?.keys() || [])].sort();
  const allDates = new Set(primaryDates);
  for (const key of horizonKeys) {
    for (const entry of Object.values(merged.horizons[key].strategies)) for (const sample of entry.samples) allDates.add(String(sample[0] || ""));
  }
  const sortedDates = [...allDates].filter(Boolean).sort();
  const window = { from: sortedDates[0] || "", to: sortedDates.at(-1) || "" };
  const splitSource = primaryDates.length >= 2 ? primaryDates : sortedDates;
  const splitDate = splitSource.length >= 2 ? splitSource[Math.floor(splitSource.length / 2)] : "";
  const previousOf = date => { const index = sortedDates.indexOf(date); return index > 0 ? sortedDates[index - 1] : ""; };
  const halfRanges = splitDate
    ? [{ label: "前半段", from: window.from, to: previousOf(splitDate) || window.from }, { label: "后半段", from: splitDate, to: window.to }]
    : [];

  const baseline = Object.fromEntries(horizonKeys.map(key => {
    const stats = basicStats(merged.horizons[key].baseline);
    return [key, { sampleCount: stats.sampleCount, winRate: stats.winRate, averageReturn: stats.averageReturn, medianReturn: stats.medianReturn }];
  }));

  const strategies = merged.definitions.map(definition => {
    const horizons = {};
    let primaryDaily = new Map();
    for (const key of horizonKeys) {
      const entry = merged.horizons[key].strategies[definition.id] || { samples: [], observedEntries: 0, onePrice: 0, gapSkipped: 0 };
      const stats = basicStats(entry.samples);
      const daily = dailyMeans(entry.samples);
      if (key === primaryKey) primaryDaily = daily;
      const weighted = dayWeightedEdge(daily, baselineByHorizon[key]);
      horizons[key] = {
        ...stats,
        edgeVsBaseline: stats.averageReturn !== null && baseline[key].averageReturn !== null ? round(stats.averageReturn - baseline[key].averageReturn) : null,
        medianEdgeVsBaseline: stats.medianReturn !== null && baseline[key].medianReturn !== null ? round(stats.medianReturn - baseline[key].medianReturn) : null,
        dayWeightedEdge: round(weighted.edge),
        comparedSignalDays: weighted.days,
        nextDayUnbuyableRate: entry.observedEntries ? round((entry.onePrice / entry.observedEntries) * 100, 1) : null,
        entryGapSkippedRate: entry.observedEntries ? round((entry.gapSkipped / entry.observedEntries) * 100, 1) : null
      };
    }
    const primarySamples = merged.horizons[primaryKey]?.strategies[definition.id]?.samples || [];
    const halves = halfRanges.map(range => {
      const inRange = primarySamples.filter(sample => String(sample[0]) >= range.from && String(sample[0]) <= range.to);
      const stats = basicStats(inRange);
      const weighted = dayWeightedEdge(primaryDaily, baselineByHorizon[primaryKey], range.from, range.to);
      return { ...range, sampleCount: stats.sampleCount, winRate: stats.winRate, averageReturn: stats.averageReturn, dayWeightedEdge: round(weighted.edge), comparedSignalDays: weighted.days };
    });
    return { id: definition.id, name: definition.name, featured: definition.featured === true, family: definition.family || "", detail: definition.detail || "",
      horizons, halves, verdict: verdictFor(horizons, halves, options) };
  });

  strategies.sort((left, right) =>
    VERDICT_ORDER[left.verdict.level] - VERDICT_ORDER[right.verdict.level] ||
    (right.horizons[primaryKey]?.dayWeightedEdge ?? -Infinity) - (left.horizons[primaryKey]?.dayWeightedEdge ?? -Infinity) ||
    String(left.id).localeCompare(String(right.id)));
  strategies.forEach((item, index) => { item.rank = index + 1; });

  const cost = finite(merged.roundTripCostBps) ? Number(merged.roundTripCostBps) / 100 : null;
  return {
    v: 1,
    generatedAt: typeof rawOptions.generatedAt === "string" ? rawOptions.generatedAt : new Date().toISOString(),
    signalTo: merged.signalTo,
    stockCount: merged.stockCount,
    window,
    splitDate,
    horizons: horizonKeys.map(Number),
    primaryHorizon: Number(primaryKey),
    minSamples: options.minSamples,
    minSignalDays: options.minSignalDays,
    edgeTolerance: options.edgeTolerance,
    benchmarkReady: merged.benchmarkReady,
    dataQuality: merged.dataQuality,
    method: `信号日收盘后确认，次日开盘买入，持有 ${horizonKeys.join(" / ")} 个交易日后收盘卖出${cost === null ? "" : `，扣双边成本 ${cost}%`}；同一只股票相邻信号至少间隔 ${merged.cooldownDays} 个交易日；次日一字涨停买不到的不计入；${merged.entryRule || "竞价缺口过大不买"}；退出日跌停或无成交则顺延。`,
    baselineDefinition: `基线：同期任意一只近 ${merged.baselineMaxDaysSinceLimit} 个交易日内涨停过的股票，用同样的买卖规则得到的收益。`,
    edgeDefinition: "优势按信号日等权：每个信号日先算“策略平均收益 − 基线平均收益”，再对所有信号日取平均；某一天成批出信号不会主导结论。",
    caveat: "样本来自本机日线库当前收录的股票（约一年多的日线，扣除指标预热后大约是近一年的信号）。已退市的股票不在其中，ST 按现在的名称剔除，所以结果偏乐观；只说明这套规则近一年在全市场的表现，不代表未来收益，也不参与选股。",
    baseline,
    strategies
  };
}

module.exports = { PRIMARY_HORIZON, DEFAULTS, mergeLeaderboardChunks, summarizeStrategyLeaderboard, dailyMeans, dayWeightedEdge, basicStats };
