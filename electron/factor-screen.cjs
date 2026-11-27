"use strict";

/**
 * 多因子选股（基本面 + 估值 + 量价），带「为什么选它 / 为什么是现在」的解释。
 * 设计参考 daily_stock_analysis 的选股引擎与解释契约（MIT），按本软件的数据口径重写。
 *
 * 漏斗两步：
 * 1. 全市场：最新一期业绩报表（东方财富数据中心，约 12 页）+ 腾讯批量行情（现价、市值、成交额、滚动市盈率、市净率）
 *    → 硬过滤（ST、停牌、亏损、太小、没成交）→ 按策略的基本面 / 估值因子做全市场百分位打分，取前 CANDIDATES 只。
 * 2. 候选：逐只读日线，补上量价因子（60 日涨幅、20 日波动、离 60 日高点的距离）→ 用完整权重重排，取前 top 只。
 *
 * 因子分 = 该因子在可比股票里的百分位（0–100，越大越好；「越低越好」的因子取反）。
 * 缺某个因子时把它的权重摊给其余因子；可用权重不到 60% 的股票不参与排名。
 * 解释只写确实观测到的数：因子值和它的全市场位置（observed）；日线没取到时「为什么是现在」写「等待证据」，不编。
 * 这是筛选，不是买卖建议；因子权重是经验设定，没有在本机做过历史回测。
 */

const REPORT_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const REPORT_COLUMNS = "SECURITY_CODE,SECURITY_NAME_ABBR,REPORTDATE,DATATYPE,BASIC_EPS,YSTZ,SJLTZ,WEIGHTAVG_ROE,XSMLL,BPS,MGJYXJJE,PUBLISHNAME,NOTICE_DATE";
const REPORT_CACHE_MS = 12 * 3600_000;
const QUOTE_CACHE_MS = 5 * 60_000;
const CANDIDATES = 100;
/** 同比增速封顶：几千个百分点的增速几乎都是上年基数太低，不代表真有那么强的成长。 */
const GROWTH_CAP = 300;
const MIN_WEIGHT_COVERAGE = 0.6;

/** 因子：higher=true 表示越大越好。stage 2 的因子要日线。 */
const FACTORS = Object.freeze({
  roe: { label: "ROE", unit: "%", higher: true, stage: 1 },
  grossMargin: { label: "毛利率", unit: "%", higher: true, stage: 1 },
  revenueGrowth: { label: "营收同比", unit: "%", higher: true, stage: 1 },
  profitGrowth: { label: "净利润同比", unit: "%", higher: true, stage: 1 },
  cashQuality: { label: "经营现金流/每股收益", unit: "倍", higher: true, stage: 1 },
  pe: { label: "滚动市盈率", unit: "倍", higher: false, stage: 1 },
  pb: { label: "市净率", unit: "倍", higher: false, stage: 1 },
  size: { label: "总市值", unit: "亿", higher: true, stage: 1 },
  momentum60: { label: "60 日涨幅", unit: "%", higher: true, stage: 2 },
  lowVol: { label: "20 日波动", unit: "%", higher: false, stage: 2 },
  oversold: { label: "离 60 日高点", unit: "%", higher: false, stage: 2 }
});

const STRATEGIES = Object.freeze([
  { id: "quality_value", name: "质量价值", summary: "赚钱能力强、估值不贵", weights: { roe: 30, grossMargin: 10, cashQuality: 15, pe: 25, pb: 20 }, filters: { minRoe: 8, profitable: true } },
  { id: "blue_chip_value", name: "蓝筹低估", summary: "大市值、盈利稳、估值低", weights: { size: 25, roe: 25, pe: 25, pb: 15, cashQuality: 10 }, filters: { minCapYi: 300, profitable: true } },
  { id: "growth_quality", name: "成长质量", summary: "营收利润双增、ROE 高", weights: { revenueGrowth: 25, profitGrowth: 30, roe: 25, grossMargin: 10, pe: 10 }, filters: { minRoe: 6, profitable: true, minProfitGrowth: 0 } },
  { id: "momentum_quality", name: "动量质量", summary: "近期强势且业绩撑得住", weights: { momentum60: 40, roe: 20, profitGrowth: 25, lowVol: 15 }, filters: { profitable: true, minProfitGrowth: -10 }, barFilters: { minMomentum60: 0 } },
  { id: "low_vol_quality", name: "低波质量", summary: "波动小、盈利稳、估值合理", weights: { lowVol: 35, roe: 25, pe: 20, cashQuality: 10, size: 10 }, filters: { minRoe: 6, profitable: true } },
  { id: "oversold_reversal", name: "超跌反转", summary: "基本面没坏、跌得多", weights: { oversold: 40, pb: 20, roe: 20, profitGrowth: 20 }, filters: { profitable: true, minProfitGrowth: -20 }, barFilters: { maxOversold: -15 } }
]);

const num = value => { const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(n) ? n : null; };
const round = (value, digits = 2) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const isRisky = name => /ST|退|\*/.test(String(name || ""));

/** 距今最近的几个报告期末（新到旧）。 */
function recentPeriods(nowMs, count = 3) {
  const d = new Date(nowMs + 8 * 3600_000);
  const ends = ["03-31", "06-30", "09-30", "12-31"];
  const out = [];
  for (let year = d.getUTCFullYear(); out.length < count && year > d.getUTCFullYear() - 3; year -= 1) {
    for (const end of [...ends].reverse()) { const date = `${year}-${end}`; if (date <= d.toISOString().slice(0, 10) && out.length < count) out.push(date); }
  }
  return out;
}

/** 一行原始数据 → 因子原值（缺的保持 null）。 */
function rawFactors(report, quote) {
  const eps = num(report.eps);
  const cash = num(report.opCashPerShare);
  const pe = num(quote?.pe);
  const pb = num(quote?.pb);
  return {
    roe: num(report.roePct), grossMargin: num(report.grossMarginPct),
    revenueGrowth: num(report.revenueYoyPct) === null ? null : Math.min(GROWTH_CAP, num(report.revenueYoyPct)),
    profitGrowth: num(report.netProfitYoyPct) === null ? null : Math.min(GROWTH_CAP, num(report.netProfitYoyPct)),
    cashQuality: eps !== null && eps > 0 && cash !== null ? cash / eps : null,
    pe: pe !== null && pe > 0 ? pe : null, pb: pb !== null && pb > 0 ? pb : null,
    size: num(quote?.totalMarketCap) !== null ? quote.totalMarketCap / 1e8 : null,
    momentum60: null, lowVol: null, oversold: null
  };
}

/** 量价因子：需要至少 61 根已收盘日线。 */
function barFactors(rows) {
  const bars = (Array.isArray(rows) ? rows : []).map(row => ({ date: String(row?.date || "").slice(0, 10), close: num(row?.close), high: num(row?.high) })).filter(row => row.date && row.close !== null && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 61) return null;
  const last = bars.at(-1).close;
  const window = bars.slice(-61);
  const returns = window.slice(-21).slice(1).map((row, index) => row.close / window.slice(-21)[index].close - 1);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const vol = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1)) * 100;
  const high = Math.max(...window.map(row => (row.high !== null && row.high > 0 ? row.high : row.close)));
  return { momentum60: (last / window[0].close - 1) * 100, lowVol: vol, oversold: (last / high - 1) * 100, asOf: bars.at(-1).date };
}

/** 百分位打分：返回 code → { 因子: 0–100 }。并列取平均名次；单样本统一给 50 分避免方向不对称。 */
function percentileScores(items, factorIds) {
  const scores = new Map(items.map(item => [item.code, {}]));
  for (const id of factorIds) {
    const valued = items.filter(item => item.factors[id] !== null && item.factors[id] !== undefined).sort((a, b) => a.factors[id] - b.factors[id]);
    const n = valued.length;
    if (!n) continue;
    if (n === 1) { scores.get(valued[0].code)[id] = 50; continue; }
    let index = 0;
    while (index < n) {
      let end = index;
      while (end + 1 < n && valued[end + 1].factors[id] === valued[index].factors[id]) end += 1;
      const rank = ((index + end) / 2) / (n - 1) * 100;
      for (let k = index; k <= end; k += 1) scores.get(valued[k].code)[id] = FACTORS[id].higher ? rank : 100 - rank;
      index = end + 1;
    }
  }
  return scores;
}

/** 加权总分：缺的因子把权重摊给其余因子；可用权重不够返回 null。 */
function weightedScore(scoreOf, weights) {
  let used = 0, total = 0, sum = 0;
  const parts = [];
  for (const [id, weight] of Object.entries(weights)) {
    total += weight;
    const score = scoreOf[id];
    if (score === undefined) continue;
    used += weight; sum += score * weight;
    parts.push({ id, score, weight, contribution: score * weight });
  }
  if (!total || used / total < MIN_WEIGHT_COVERAGE) return null;
  return { score: sum / used, coverage: used / total, parts: parts.sort((a, b) => b.contribution - a.contribution) };
}

/** 报表是累计值：一季报的 ROE 只有全年的四分之一左右。按报告期折算门槛（3 月 ×0.25、6 月 ×0.5、9 月 ×0.75、年报 ×1）。 */
function periodScale(period) {
  const month = Number(String(period || "").slice(5, 7));
  return month === 3 ? 0.25 : month === 6 ? 0.5 : month === 9 ? 0.75 : 1;
}

function passesFilters(item, filters = {}) {
  const f = item.factors;
  if (filters.profitable && !(num(item.report.eps) > 0)) return false;
  if (filters.minRoe !== undefined && !(f.roe !== null && f.roe >= filters.minRoe * periodScale(item.report.period))) return false;
  if (filters.minCapYi !== undefined && !(f.size !== null && f.size >= filters.minCapYi)) return false;
  if (filters.minProfitGrowth !== undefined && !(f.profitGrowth !== null && f.profitGrowth >= filters.minProfitGrowth)) return false;
  return true;
}

const fmt = (id, value) => (id === "profitGrowth" || id === "revenueGrowth") && value >= GROWTH_CAP
  ? `${FACTORS[id].label}超过 ${GROWTH_CAP}%（多为上年基数低）`
  : `${FACTORS[id].label} ${round(value, 1)}${FACTORS[id].unit}`;
const rankWord = score => score >= 90 ? "前 10%" : score >= 75 ? "前 25%" : score >= 50 ? "中上" : "中下";

/** 入选解释：贡献最大的三个因子（观测值 + 位置）。 */
function whySelected(item, result) {
  return result.parts.slice(0, 3).map(part => ({ code: part.id, text: `${fmt(part.id, item.factors[part.id])}，${FACTORS[part.id].stage === 1 ? "全市场" : "候选里"}${rankWord(part.score)}`, quality: "observed", source: FACTORS[part.id].stage === 1 ? "业绩报表与行情" : "日线" }));
}

/** 时点解释：只写日线和报表里确实有的；日线没取到就是「等待证据」。 */
function whyNow(item) {
  const out = [];
  const f = item.factors;
  if (item.barsAsOf) {
    if (f.momentum60 !== null) out.push({ code: "momentum60", text: `近 60 个交易日${f.momentum60 >= 0 ? "上涨" : "下跌"} ${Math.abs(round(f.momentum60, 1))}%`, quality: "observed", source: "日线" });
    if (f.oversold !== null) out.push({ code: "oversold", text: f.oversold > -3 ? "收盘价贴近 60 日高点" : `比 60 日高点低 ${Math.abs(round(f.oversold, 1))}%`, quality: "observed", source: "日线" });
  }
  if (item.report.noticeDate) out.push({ code: "report", text: `${item.report.label || "最新报表"}披露于 ${item.report.noticeDate}`, quality: "observed", source: "业绩报表" });
  if (num(item.quote?.changePct) !== null) out.push({ code: "quote", text: `今日涨跌 ${item.quote.changePct > 0 ? "+" : ""}${round(item.quote.changePct, 2)}%`, quality: "observed", source: "实时行情" });
  if (!item.barsAsOf) out.unshift({ code: "awaiting_evidence", text: "日线没取到，量价上的时点证据暂缺", quality: "unknown", source: "" });
  return out.slice(0, 4);
}

/**
 * 纯计算：给定全市场数据、策略和候选日线读取函数，返回排名结果。
 * @param {{ universe: Array<{code,name,industry,report,quote}>, strategy: object, top?: number, loadBars: (item) => Promise<Array|null> }} input
 */
/**
 * 今天已经交易了全天的几成（按北京时间估算，9:30–11:30、13:00–15:00）。开盘前返回 0，收盘后返回 1。
 * 成交额门槛按这个比例折算：早盘用全天 5000 万的标准会把几乎所有股票都筛掉。
 */
function sessionFraction(nowMs) {
  const d = new Date(nowMs + 8 * 3600_000);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const traded = Math.max(0, Math.min(120, minutes - 570)) + Math.max(0, Math.min(120, minutes - 780));
  return traded / 240;
}

async function runScreen({ universe, strategy, top = 20, loadBars, nowMs = null, isTradingDate = null, signal = null }) {
  const clampedTop = Math.max(1, Math.min(50, Math.round(Number(top) || 20)));
  const stage1Ids = Object.keys(strategy.weights).filter(id => FACTORS[id].stage === 1);
  const stage2Ids = Object.keys(strategy.weights).filter(id => FACTORS[id].stage === 2);
  const funnel = { universe: universe.length };
  // 成交额门槛：全天 5000 万；仅在「交易日盘中（09:30–15:00）且行情日期为今天」时按已交易进度折算，休市/盘前/盘后一律用全天 5000 万。
  let todayCn = "";
  let useIntraday = false;
  if (nowMs !== null) {
    const d = new Date(nowMs + 8 * 3600_000);
    todayCn = d.toISOString().slice(0, 10);
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    const isTradeDay = typeof isTradingDate === "function" ? isTradingDate(todayCn) !== false : ![0, 6].includes(d.getUTCDay());
    const datedQuotes = universe.filter(item => typeof item?.quote?.quoteDate === "string" && item.quote.quoteDate.length >= 10);
    const hasTodayQuotes = datedQuotes.length === 0 || datedQuotes.filter(item => item.quote.quoteDate.slice(0, 10) === todayCn).length * 2 >= datedQuotes.length;
    useIntraday = isTradeDay && minutes >= 570 && minutes < 900 && hasTodayQuotes;
  }
  const fraction = useIntraday ? sessionFraction(nowMs) : 1;
  const minAmount = useIntraday ? (fraction >= 0.125 ? 5e7 * fraction : null) : 5e7;
  funnel.amountFilter = minAmount === null ? "开盘不到半小时，暂不按成交额筛" : fraction < 1 ? `按盘中进度折算为 ${Math.round(minAmount / 1e4)} 万` : "全天 5000 万";
  const amountThresholdFor = quote => {
    if (!useIntraday) return 5e7;
    if (typeof quote?.quoteDate === "string" && quote.quoteDate.length >= 10 && quote.quoteDate.slice(0, 10) !== todayCn) return 5e7;
    return minAmount;
  };
  const tradable = universe.filter(item => {
    if (isRisky(item.name) || !(num(item.quote?.latest) > 0) || item.quote.tradeStatus !== "trading" || !(num(item.quote.floatMarketCap) >= 30e8)) return false;
    const threshold = amountThresholdFor(item.quote);
    return threshold === null || num(item.quote.amount) >= threshold;
  });
  funnel.tradable = tradable.length;
  const pool = tradable.map(item => ({ ...item, factors: rawFactors(item.report, item.quote) })).filter(item => passesFilters(item, strategy.filters));
  funnel.passedFilters = pool.length;
  // 第一步：只用基本面 / 估值因子在全市场排，量价因子权重暂时不算。
  const stage1Weights = Object.fromEntries(stage1Ids.map(id => [id, strategy.weights[id]]));
  const scores1 = percentileScores(pool, stage1Ids);
  const ranked1 = pool.map(item => ({ item, result: weightedScore(scores1.get(item.code), stage1Weights) })).filter(entry => entry.result)
    .sort((a, b) => b.result.score - a.result.score || a.item.code.localeCompare(b.item.code));
  funnel.scored = ranked1.length;
  const candidates = ranked1.slice(0, stage2Ids.length ? CANDIDATES : Math.max(clampedTop, 20)).map(entry => ({ ...entry.item, stage1Score: entry.result.score, stage1Scores: scores1.get(entry.item.code) }));
  funnel.candidates = candidates.length;
  // 第二步：候选补量价因子。
  let barsFailed = 0;
  const queue = [...candidates];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      if (signal?.aborted) break;
      const item = queue.shift();
      let facts = null;
      try { facts = barFactors(await loadBars(item)); } catch (error) { if (signal?.aborted || error?.name === "AbortError") break; facts = null; }
      if (facts) { Object.assign(item.factors, { momentum60: facts.momentum60, lowVol: facts.lowVol, oversold: facts.oversold }); item.barsAsOf = facts.asOf; }
      else barsFailed += 1;
    }
  }));
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("多因子选股已取消"), { name: "AbortError" });
  funnel.barsFailed = barsFailed;
  // 量价硬条件（如动量策略要求 60 日涨幅为正、超跌策略要求离高点至少 15%）：日线没取到的不算满足。
  const barFilters = strategy.barFilters || {};
  const qualified = candidates.filter(item => (barFilters.minMomentum60 === undefined || (item.factors.momentum60 !== null && item.factors.momentum60 > barFilters.minMomentum60))
    && (barFilters.maxOversold === undefined || (item.factors.oversold !== null && item.factors.oversold <= barFilters.maxOversold)));
  funnel.qualified = qualified.length;
  const scores2 = percentileScores(qualified, stage2Ids);
  const final = qualified.map(item => {
    const result = weightedScore({ ...item.stage1Scores, ...scores2.get(item.code) }, strategy.weights);
    return result ? { item, result } : null;
  }).filter(Boolean).sort((a, b) => b.result.score - a.result.score || a.item.code.localeCompare(b.item.code)).slice(0, clampedTop);
  return {
    funnel,
    picks: final.map(({ item, result }, index) => {
      const selected = whySelected(item, result);
      const now = whyNow(item);
      return {
        rank: index + 1, code: item.code, name: item.name, industry: item.industry, score: round(result.score, 1), coveragePct: round(result.coverage * 100, 0),
        latest: num(item.quote.latest), changePct: round(num(item.quote.changePct)), marketCapYi: round(item.factors.size, 0),
        factors: Object.fromEntries(Object.keys(strategy.weights).map(id => [id, { label: FACTORS[id].label, unit: FACTORS[id].unit, value: round(item.factors[id], 2), score: result.parts.find(part => part.id === id) ? round(result.parts.find(part => part.id === id).score, 0) : null, weight: strategy.weights[id] }])),
        whySelected: selected, whyNow: now,
        explanationQuality: { whySelected: selected.length ? "ok" : "unknown", whyNow: now.some(entry => entry.quality === "unknown") ? "partial" : "ok" },
        reportLabel: item.report.label, reportPeriod: item.report.period
      };
    })
  };
}

function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error("请求已取消"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? Object.assign(new Error("请求已取消"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function createFactorScreen({ fetchJson, readQuotes, loadBars, now = () => Date.now(), isTradingDate = null, log = () => {} } = {}) {
  if (typeof fetchJson !== "function" || typeof readQuotes !== "function" || typeof loadBars !== "function") throw new TypeError("fetchJson, readQuotes and loadBars are required");
  let reportCache = null, reportPending = null;
  let quoteCache = null, quotePending = null;

  async function fetchPeriod(period) {
    const rows = [];
    for (let page = 1; page <= 16; page += 1) {
      const url = `${REPORT_URL}?reportName=RPT_LICO_FN_CPD&columns=${REPORT_COLUMNS}&filter=(REPORTDATE%3D%27${period}%27)&pageSize=500&pageNumber=${page}&sortColumns=SECURITY_CODE&sortTypes=1`;
      const json = await fetchJson(url, { headers: { Referer: "https://data.eastmoney.com/" } }, 12000);
      const data = Array.isArray(json?.result?.data) ? json.result.data : [];
      rows.push(...data);
      if (!data.length || page >= Number(json?.result?.pages || 1)) break;
    }
    return rows;
  }

  /** 最新一期报表：最近的报告期披露不到 3000 家（还在披露期）就退到上一期。 */
  async function reports(signal) {
    if (reportCache && reportCache.expiresAt > now()) return reportCache.value;
    if (!reportPending) {
      reportPending = (async () => {
        let best = null;
        for (const period of recentPeriods(now())) {
          let rows;
          try { rows = await fetchPeriod(period); } catch (error) { log(`factor-screen ${period} ${error?.message || error}`); continue; }
          const byCode = new Map();
          for (const row of rows) {
            const code = String(row?.SECURITY_CODE || "");
            if (!/^(?:00|30|60|68|43|83|87|92)\d{4}$/.test(code)) continue;
            if (!byCode.has(code)) byCode.set(code, row);
          }
          const usable = [...byCode.values()];
          if (!best || usable.length > best.rows.length) best = { period, rows: usable };
          if (usable.length >= 3000) break;
        }
        if (!best || !best.rows.length) throw new Error("业绩报表没取到，暂时不能做多因子选股");
        const value = { period: best.period, complete: best.rows.length >= 3000, items: best.rows.map(row => ({
          code: String(row.SECURITY_CODE), name: String(row.SECURITY_NAME_ABBR || row.SECURITY_CODE), industry: String(row.PUBLISHNAME || ""),
          report: { period: best.period, label: String(row.DATATYPE || "").replace(/\s+/g, ""), noticeDate: String(row.NOTICE_DATE || "").slice(0, 10), eps: num(row.BASIC_EPS), revenueYoyPct: num(row.YSTZ), netProfitYoyPct: num(row.SJLTZ), roePct: num(row.WEIGHTAVG_ROE), grossMarginPct: num(row.XSMLL), bps: num(row.BPS), opCashPerShare: num(row.MGJYXJJE) }
        })) };
        reportCache = { value, expiresAt: now() + REPORT_CACHE_MS };
        return value;
      })();
      const clearPending = () => { reportPending = null; };
      reportPending.then(clearPending, clearPending);
    }
    return raceSignal(reportPending, signal);
  }

  async function quotes(codes, signal) {
    if (quoteCache && quoteCache.expiresAt > now()) return quoteCache.value;
    if (!quotePending) {
      quotePending = (async () => {
        const map = new Map();
        let failed = 0;
        for (let offset = 0; offset < codes.length; offset += 1000) {
          try {
            const result = await readQuotes(codes.slice(offset, offset + 1000).map(code => ({ code })), {});
            for (const [code, quote] of result.quotes) map.set(code, quote);
            failed += Number(result.failedChunks) || 0; // 一批里部分分片失败也要算进提示
          }
          catch (error) { failed += 1; log(`factor-screen quotes ${error?.message || error}`); }
        }
        if (!map.size) throw new Error("全市场行情没取到，暂时不能做多因子选股");
        const value = { map, failedChunks: failed };
        quoteCache = { value, expiresAt: now() + QUOTE_CACHE_MS };
        return value;
      })();
      const clearQuotePending = () => { quotePending = null; };
      quotePending.then(clearQuotePending, clearQuotePending);
    }
    return raceSignal(quotePending, signal);
  }

  async function screen({ strategyId = "quality_value", top = 20, signal } = {}) {
    const strategy = STRATEGIES.find(item => item.id === strategyId) || STRATEGIES[0];
    const report = await reports(signal);
    const quote = await quotes(report.items.map(item => item.code), signal);
    const universe = report.items.map(item => ({ ...item, quote: quote.map.get(item.code) || null })).filter(item => item.quote);
    const result = await runScreen({ universe, strategy, top, loadBars: item => loadBars(item, { signal }), nowMs: now(), isTradingDate, signal });
    const warnings = [];
    if (!report.complete) warnings.push(`${report.period} 这一期报表只披露了 ${report.items.length} 家，排名不完整`);
    if (quote.failedChunks) warnings.push(`有 ${quote.failedChunks} 批行情没取到，这些股票没参与排名`);
    if (result.funnel.barsFailed) warnings.push(`${result.funnel.barsFailed} 只候选的日线没取到，它们的量价因子缺失`);
    if (!result.picks.length) warnings.push(strategy.id === "momentum_quality" ? "基本面过关的候选里，现在没有 60 日涨幅为正的" : strategy.id === "oversold_reversal" ? "基本面过关的候选里，现在没有比 60 日高点低 15% 以上的" : "没有股票通过这套策略的条件");
    return {
      strategy: { id: strategy.id, name: strategy.name, summary: strategy.summary, weights: Object.entries(strategy.weights).map(([id, weight]) => ({ id, label: FACTORS[id].label, weight, higher: FACTORS[id].higher })) },
      strategies: STRATEGIES.map(item => ({ id: item.id, name: item.name, summary: item.summary })),
      reportPeriod: report.period, generatedAt: new Date(now()).toISOString(), warnings, ...result,
      note: "因子权重是经验设定，没有在本机做过历史回测；这是筛选结果，不是买卖建议。"
    };
  }

  return { screen };
}

module.exports = { createFactorScreen, runScreen, sessionFraction, periodScale, percentileScores, weightedScore, barFactors, rawFactors, recentPeriods, FACTOR_STRATEGIES: STRATEGIES, FACTORS };
