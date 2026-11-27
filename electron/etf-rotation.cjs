"use strict";

/**
 * ETF 轮动（规则化双动量）。纯规则计算，不用 AI。设计参考 daily_stock_analysis 的 --etf-rotation（MIT），按本软件口径重写。
 *
 * 规则：
 * 1. 调仓日：每周（或每月）最后一个交易日收盘后算信号，下一个交易日收盘成交（不用信号当天的价成交，避免未来函数）。
 * 2. 相对动量：按过去 lookback 个交易日的涨幅给风险池里的 ETF 排名。
 * 3. 绝对动量：涨幅为正的才能入选；每个名额 1/topN 仓位，没选满的名额放防守资产（货币 ETF），没配或没行情就是现金。
 * 4. 换仓缓冲：已持有的只要仍为正、且动量落后最后一个入选名额不超过 bufferPct 个百分点，就继续持有，减少来回换。
 * 5. 组合不变不交易；持仓期间权重随涨跌漂移，不拉回等权。
 * 6. 成本：每次调仓按成交额 × costBps 扣。
 *
 * 数据：前复权日线，只用已收盘的。历史不够 lookback 天的 ETF 在攒够之前不参与排名；
 * 单日涨跌超过 15%（疑似拆分或复权缺失）、历史被截短、取数失败都列进 warnings。
 * 回测区间不足 1 年时不出年化类指标。结果不代表未来收益。
 */

const DEFAULTS = Object.freeze({
  pool: ["510300", "510500", "159915", "512890", "513100", "518880"],
  safeAsset: "511880", lookback: 60, rebalance: "weekly", topN: 2, bufferPct: 2, costBps: 10, years: 8
});
const POOL_NAMES = Object.freeze({ "510300": "沪深300ETF", "510500": "中证500ETF", "159915": "创业板ETF", "512890": "红利低波ETF", "513100": "纳指ETF", "518880": "黄金ETF", "511880": "银华日利（货币）" });
const SWEEP = Object.freeze([20, 40, 60, 90, 120, 160, 200]);

const finite = value => { const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(n) ? n : null; };
const intIn = (value, low, high, fallback) => { const n = finite(value); return n !== null && Number.isInteger(n) && n >= low && n <= high ? n : fallback; };
const round = (value, digits = 2) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

function normalizeConfig(raw = {}) {
  const codes = value => [...new Set((Array.isArray(value) ? value : String(value || "").split(/[,，\s]+/)).map(item => String(item).trim()).filter(code => /^\d{6}$/.test(code)))];
  const safe = raw.safeAsset === "" ? "" : codes([raw.safeAsset])[0] ?? DEFAULTS.safeAsset;
  const rawPool = codes(raw.pool).filter(code => code !== safe).slice(0, 20);
  const fallbackPool = DEFAULTS.pool.filter(code => code !== safe);
  const pool = rawPool.length >= 2 ? rawPool : (fallbackPool.length >= 2 ? fallbackPool : [...DEFAULTS.pool]);
  const bufferPct = finite(raw.bufferPct);
  const costBps = finite(raw.costBps);
  return {
    pool,
    safeAsset: safe,
    lookback: intIn(raw.lookback, 5, 500, DEFAULTS.lookback),
    rebalance: raw.rebalance === "monthly" ? "monthly" : "weekly",
    topN: Math.min(intIn(raw.topN, 1, 10, DEFAULTS.topN), pool.length),
    bufferPct: bufferPct !== null && bufferPct >= 0 && bufferPct <= 20 ? bufferPct : DEFAULTS.bufferPct,
    costBps: costBps !== null && costBps >= 0 && costBps <= 100 ? costBps : DEFAULTS.costBps,
    years: intIn(raw.years, 1, 15, DEFAULTS.years)
  };
}

const weekKey = date => { const d = new Date(`${date}T00:00:00Z`); const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000); return monday.toISOString().slice(0, 10); };
const periodKey = (date, rebalance) => rebalance === "monthly" ? date.slice(0, 7) : weekKey(date);

/** 把各 ETF 的日线对齐到统一日期轴；缺的日子用前一个有效收盘价补（最多 5 根），补不上就是 null。 */
function alignPrices(seriesByCode) {
  const dates = [...new Set(Object.values(seriesByCode).flatMap(rows => rows.map(row => row.date)))].sort();
  const prices = {};
  for (const [code, rows] of Object.entries(seriesByCode)) {
    const map = new Map(rows.map(row => [row.date, row.close]));
    let last = null, gap = 0;
    prices[code] = dates.map(date => {
      const value = map.get(date);
      if (value !== undefined) { last = value; gap = 0; return value; }
      gap += 1;
      return last !== null && gap <= 5 ? last : null;
    });
  }
  return { dates, prices };
}

/** 某一天的目标组合：返回入选的风险 ETF（按动量降序）和动量排名。 */
function selectTargets({ prices, index, config, held }) {
  const ranking = [];
  for (const code of config.pool) {
    const now = prices[code]?.[index], then = index - config.lookback >= 0 ? prices[code]?.[index - config.lookback] : null;
    if (now === null || now === undefined || then === null || then === undefined || !(then > 0)) continue;
    ranking.push({ code, momentumPct: (now / then - 1) * 100 });
  }
  ranking.sort((a, b) => b.momentumPct - a.momentumPct);
  const eligible = ranking.filter(item => item.momentumPct > 0);
  const fresh = eligible.slice(0, config.topN);
  const cutoff = fresh.length === config.topN ? fresh.at(-1).momentumPct : 0;
  // 已持有的：仍为正且落后最后一个名额不超过缓冲，就留下。
  const keep = eligible.filter(item => held.has(item.code) && item.momentumPct >= cutoff - config.bufferPct);
  const chosen = [...keep];
  for (const item of fresh) { if (chosen.length >= config.topN) break; if (!chosen.some(entry => entry.code === item.code)) chosen.push(item); }
  chosen.sort((a, b) => b.momentumPct - a.momentumPct);
  return { targets: chosen.slice(0, config.topN).map(item => item.code), ranking };
}

function metrics(equity, dates) {
  if (equity.length < 2) return null;
  const returns = equity.slice(1).map((value, index) => value / equity[index] - 1);
  const total = equity.at(-1) / equity[0] - 1;
  const years = (Date.parse(`${dates.at(-1)}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / (365.25 * 86_400_000);
  let peak = equity[0], maxDrawdown = 0;
  for (const value of equity) { peak = Math.max(peak, value); maxDrawdown = Math.max(maxDrawdown, 1 - value / peak); }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(250);
  const enough = years >= 1;
  const annual = enough ? (1 + total) ** (1 / years) - 1 : null;
  return {
    totalPct: round(total * 100), years: round(years, 1), maxDrawdownPct: round(maxDrawdown * 100),
    annualPct: annual === null ? null : round(annual * 100), volPct: enough ? round(vol * 100) : null,
    sharpe: enough && vol > 0 ? round(annual / vol) : null, calmar: enough && maxDrawdown > 0 ? round(annual / maxDrawdown) : null
  };
}

/**
 * 回测。seriesByCode：代码 → 升序已收盘日线 [{ date, close }]（前复权）。
 * 返回 { equity, benchmark, dates, rebalances, holdings(当前规则持仓), firstIndex }，数据不够返回 null。
 */
function backtest(seriesByCode, config) {
  const { dates, prices } = alignPrices(seriesByCode);
  if (dates.length < config.lookback + 10) return null;
  const safe = config.safeAsset && prices[config.safeAsset] ? config.safeAsset : "";
  let cash = 1;
  let positions = new Map(); // code → 份额
  let pending = null;        // 等待下一个交易日执行的目标
  let started = -1;
  const equity = [], benchmark = [], outDates = [], rebalances = [];
  let bench = 1;
  // 持仓估值：当天没报价就用最后一个有效收盘价（停牌、数据缺口），不能当成 0——那会凭空造出一次大回撤。
  const lastPrice = (code, index) => { for (let i = index; i >= 0; i -= 1) { const value = prices[code]?.[i]; if (value !== null && value !== undefined) return value; } return 0; };
  const valueAt = index => cash + [...positions].reduce((sum, [code, units]) => sum + units * lastPrice(code, index), 0);
  for (let index = config.lookback; index < dates.length; index += 1) {
    // 先执行昨天收盘后给出的目标（今天收盘价成交）；遇单日停牌/缺数时顺延最多 5 个交易日重试。
    if (pending) {
      const { targets, signalDate, age = 0 } = pending;
      const tradable = [...targets, ...positions.keys()].every(code => prices[code]?.[index] !== null && prices[code]?.[index] !== undefined);
      if (!tradable) {
        pending = age + 1 < 5 ? { targets, signalDate, age: age + 1 } : null;
      } else {
        pending = null;
        const currentRisky = [...positions.keys()].filter(code => code !== safe).sort().join(",");
        // 第一次给出目标时即使全部名额空着也要建仓（全部放防守资产或现金），否则熊市开局永远不会开始记账。
        if (started < 0 || [...targets].sort().join(",") !== currentRisky) {
          const total = valueAt(index);
          const outgoing = [...positions.keys()].filter(code => code !== safe && !targets.includes(code));
          const incoming = targets.filter(code => !positions.has(code));
          // 留下的风险持仓不动（权重随涨跌漂移）；卖出的、防守资产和现金腾出来的钱，平均分给新入选的和空着的名额。
          const keptValue = targets.filter(code => positions.has(code)).reduce((sum, code) => sum + positions.get(code) * prices[code][index], 0);
          const safeBefore = safe && positions.has(safe) ? positions.get(safe) * prices[safe][index] : 0;
          const soldValue = outgoing.reduce((sum, code) => sum + positions.get(code) * prices[code][index], 0);
          const idleSlots = config.topN - targets.length;
          const shares = incoming.length + idleSlots;
          const freeBefore = total - keptValue;
          const perShare = shares > 0 ? freeBefore / shares : 0;
          const safeAfterGross = safe && prices[safe][index] !== null ? perShare * idleSlots : 0;
          // 成交额：卖出的 + 买入的 + 防守资产的增减；现金进出不算。
          const traded = soldValue + perShare * incoming.length + Math.abs(safeAfterGross - safeBefore);
          const cost = traded * config.costBps / 10000;
          const scale = freeBefore > 0 ? Math.max(0, (freeBefore - cost) / freeBefore) : 1;
          const next = new Map();
          for (const code of targets) next.set(code, positions.has(code) ? positions.get(code) : perShare * scale / prices[code][index]);
          let rest = perShare * idleSlots * scale;
          if (rest > 1e-12 && safe && prices[safe][index] !== null) { next.set(safe, (next.get(safe) || 0) + rest / prices[safe][index]); rest = 0; }
          positions = next; cash = Math.max(0, rest);
          if (started < 0) started = index;
          rebalances.push({ signalDate, tradeDate: dates[index], out: outgoing, in: incoming, holdings: [...targets], costPct: round(cost / total * 100, 3) });
        }
      }
    }
    if (started >= 0) {
      if (index > started) {
        const moves = config.pool.map(code => { const a = prices[code]?.[index - 1], b = prices[code]?.[index]; return a && b ? b / a - 1 : null; }).filter(value => value !== null);
        if (moves.length) bench *= 1 + moves.reduce((a, b) => a + b, 0) / moves.length;
      }
      equity.push(valueAt(index)); benchmark.push(bench); outDates.push(dates[index]);
    }
    // 收盘后：若今天是本周（月）最后一个交易日，给出下一个交易日的目标。
    const last = index === dates.length - 1 ? false : periodKey(dates[index], config.rebalance) !== periodKey(dates[index + 1], config.rebalance);
    if (last) pending = { targets: selectTargets({ prices, index, config, held: new Set([...positions.keys()].filter(code => code !== safe)) }).targets, signalDate: dates[index], age: 0 };
  }
  if (started < 0) return null;
  const base = equity[0];
  return { dates: outDates, equity: equity.map(value => value / base), benchmark: benchmark.map(value => value / benchmark[0]), rebalances,
    holdings: [...positions.keys()], safe, prices, allDates: dates };
}

/** 分年度收益（策略与等权基准）。 */
function yearly(dates, equity, benchmark) {
  const out = [];
  let start = 0;
  for (let index = 1; index <= dates.length; index += 1) {
    if (index === dates.length || dates[index].slice(0, 4) !== dates[start].slice(0, 4)) {
      const from = start === 0 ? 0 : start - 1;
      out.push({ year: dates[start].slice(0, 4), strategyPct: round((equity[index - 1] / equity[from] - 1) * 100), benchmarkPct: round((benchmark[index - 1] / benchmark[from] - 1) * 100), partial: start === 0 || index === dates.length });
      start = index;
    }
  }
  return out;
}

/** 生成完整报告。now 用来丢掉当天未收盘的 K 线由调用方完成；这里只算。 */
function buildReport(seriesInput, rawConfig = {}, { names = {}, failed = [], unadjusted = [], isTradingDate = null } = {}) {
  const config = normalizeConfig(rawConfig);
  const warnings = [];
  const series = {};
  for (const code of [...config.pool, ...(config.safeAsset ? [config.safeAsset] : [])]) {
    const rows = (seriesInput[code] || []).map(row => ({ date: String(row?.date || "").slice(0, 10), close: finite(row?.close) })).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.close !== null && row.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) { if (code === config.safeAsset) warnings.push(`防守资产 ${code} 没取到行情，空仓名额按现金算`); else warnings.push(`${names[code] || POOL_NAMES[code] || code}（${code}）没取到行情，已从本次计算里剔除`); continue; }
    const jump = rows.find((row, index) => index > 0 && Math.abs(row.close / rows[index - 1].close - 1) > 0.15);
    if (jump) warnings.push(`${names[code] || POOL_NAMES[code] || code} 在 ${jump.date} 单日涨跌超过 15%，可能是拆分或复权缺失，结论要打折扣`);
    if (rows.length < config.lookback + 60) warnings.push(`${names[code] || POOL_NAMES[code] || code} 只有 ${rows.length} 根日线，历史偏短`);
    series[code] = rows;
  }
  for (const code of failed) if (!warnings.some(text => text.includes(code))) warnings.push(`${code} 取数失败`);
  for (const code of unadjusted) warnings.push(`${names[code] || POOL_NAMES[code] || code}（${code}）回退到了不复权日线，分红或拆分会影响动量与回测结果`);
  const pool = config.pool.filter(code => series[code]);
  const label = code => names[code] || POOL_NAMES[code] || code;
  if (pool.length < 2) return { config, warnings: [...warnings, "风险池里有行情的 ETF 不到 2 只，无法计算"], signal: null, performance: null, yearly: [], sweep: [], rebalances: [], asOf: "" };
  const effectiveTopN = Math.min(config.topN, pool.length);
  const effective = { ...config, pool, topN: effectiveTopN };
  const result = backtest(series, effective);
  if (!result) return { config, warnings: [...warnings, `历史不够（至少要 ${config.lookback + 10} 个交易日）`], signal: null, performance: null, yearly: [], sweep: [], rebalances: [], asOf: "" };
  const lastIndex = result.allDates.length - 1;
  const asOf = result.allDates[lastIndex];
  const held = new Set(result.holdings.filter(code => code !== result.safe));
  const latest = selectTargets({ prices: result.prices, index: lastIndex, config: effective, held });
  // 最新收盘是不是本周（月）最后一个交易日：找下一个交易日（有交易日历就用日历跳过节假日，否则只跳过周末）。
  const isRebalanceDay = (() => {
    let d = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000);
    const open = date => typeof isTradingDate === "function" ? isTradingDate(date) !== false && ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) : ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    for (let guard = 0; guard < 30 && !open(d.toISOString().slice(0, 10)); guard += 1) d = new Date(d.getTime() + 86_400_000);
    return periodKey(asOf, config.rebalance) !== periodKey(d.toISOString().slice(0, 10), config.rebalance);
  })();
  const idleSlots = effective.topN - latest.targets.length;
  const signal = {
    asOf,
    holdings: result.holdings.map(code => ({ code, name: label(code), safe: code === result.safe })),
    targets: latest.targets.map(code => ({ code, name: label(code), weightPct: round(100 / effective.topN, 1) })),
    idleWeightPct: round(idleSlots * 100 / effective.topN, 1), idleTo: idleSlots > 0 ? (result.safe ? label(result.safe) : "现金") : "",
    needRebalance: [...latest.targets].sort().join(",") !== [...held].sort().join(","),
    isRebalanceDay,
    ranking: latest.ranking.map(item => ({ code: item.code, name: label(item.code), momentumPct: round(item.momentumPct), selected: latest.targets.includes(item.code), positive: item.momentumPct > 0 }))
  };
  const strategy = metrics(result.equity, result.dates);
  const bench = metrics(result.benchmark, result.dates);
  const short = !strategy || strategy.years < 1;
  if (short) warnings.push("可回测区间不足 1 年，年化类指标没有参考意义，只保留最新信号");
  // 参数平原：只改动量窗口，统一从最晚的起点算，区间不足 1 年的窗口不列。
  const sweep = [];
  if (!short) {
    const windows = [...new Set([...SWEEP, config.lookback])].sort((a, b) => a - b);
    const runs = windows.map(lookback => ({ lookback, run: backtest(series, { ...effective, lookback }) })).filter(item => item.run);
    const start = runs.map(item => item.run.dates[0]).sort().at(-1);
    for (const { lookback, run } of runs) {
      const from = run.dates.findIndex(date => date >= start);
      if (from < 0) continue;
      const m = metrics(run.equity.slice(from), run.dates.slice(from));
      if (m && m.years >= 1) sweep.push({ lookback, annualPct: m.annualPct, maxDrawdownPct: m.maxDrawdownPct, sharpe: m.sharpe, current: lookback === config.lookback });
    }
  }
  const step = Math.max(1, Math.ceil(result.dates.length / 240));
  return {
    config, warnings, asOf, signal,
    performance: short ? null : { from: result.dates[0], to: result.dates.at(-1), strategy, benchmark: bench },
    yearly: short ? [] : yearly(result.dates, result.equity, result.benchmark),
    sweep,
    rebalances: result.rebalances.slice(-10).reverse().map(item => ({ ...item, out: item.out.map(label), in: item.in.map(label), holdings: item.holdings.map(label) })),
    rebalanceCount: result.rebalances.length,
    curve: result.dates.filter((_, index) => index % step === 0 || index === result.dates.length - 1).map(date => { const index = result.dates.indexOf(date); return { date, strategy: round(result.equity[index], 4), benchmark: round(result.benchmark[index], 4) }; })
  };
}

module.exports = { buildReport, backtest, selectTargets, alignPrices, metrics, normalizeConfig, ETF_ROTATION_DEFAULTS: DEFAULTS, POOL_NAMES };
