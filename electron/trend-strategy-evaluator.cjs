"use strict";

const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { evaluateTrendStrategy, normalizeTrendStrategy } = require("./trend-strategy.cjs");
const STRATEGY_LIBRARY = require("../config/trend-strategy-library.json");

const DEFAULT_EXECUTION = Object.freeze({ notional: 100000, commissionBps: 3,
  minCommission: 5, sellTaxBps: 5, transferFeeBps: 0, slippageBps: 5 });
const finite = value => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const mean = values => values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
const iso = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function sortedDates(values, label) {
  if (!Array.isArray(values) || values.some(value => !iso(value))) throw new TypeError(`${label} requires ISO dates`);
  const dates = [...values].sort();
  if (new Set(dates).size !== dates.length) throw new TypeError(`${label} contains duplicate dates`);
  return dates;
}

function rowsThrough(rows, to, label, calendar, raw = false) {
  if (!Array.isArray(rows)) throw new TypeError(`${label} must be an array`);
  if (rows.some(row => !iso(row?.date))) throw new TypeError(`${label} has an invalid date`);
  // Values dated after the evaluation cutoff are never validated or consumed.
  const selected = rows.filter(row => row.date <= to).map(row => ({ ...row })).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(selected.map(row => row.date)).size !== selected.length) throw new TypeError(`${label} has duplicate dates`);
  for (const row of selected) {
    if (!calendar.has(row.date) || !["open", "high", "low", "close"].every(key => finite(row[key]) && row[key] > 0) ||
      row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) ||
      !finite(row.volume) || row.volume < 0 || !finite(row.amount) || row.amount < 0) {
      throw new TypeError(`${label} ${row.date} has invalid OHLCV/amount/calendar data`);
    }
    if (raw) {
      for (const key of ["upperLimit", "lowerLimit"]) if (row[key] !== undefined && (!finite(row[key]) || row[key] <= 0)) throw new TypeError(`${label} invalid ${key}`);
      for (const key of ["isST", "noPriceLimit", "suspended"]) if (row[key] !== undefined && typeof row[key] !== "boolean") throw new TypeError(`${label} invalid ${key}`);
      if (row.upperLimit !== undefined && row.lowerLimit !== undefined && row.upperLimit < row.lowerLimit) throw new TypeError(`${label} inconsistent price limits`);
      if (row.noPriceLimit !== true) {
        for (const key of ["open", "high", "low", "close"]) {
          if (finite(row.upperLimit) && row[key] > row.upperLimit + .005) throw new TypeError(`${label} ${row.date} ${key} exceeds upperLimit`);
          if (finite(row.lowerLimit) && row[key] < row.lowerLimit - .005) throw new TypeError(`${label} ${row.date} ${key} is below lowerLimit`);
        }
      }
    }
  }
  return selected;
}

function normalizeExecution(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("execution must be an object");
  for (const key of Object.keys(input)) if (!(key in DEFAULT_EXECUTION)) throw new TypeError(`Unknown execution setting ${key}`);
  const result = { ...DEFAULT_EXECUTION, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!finite(value) || value < 0 || (key === "notional" && value <= 0) || (key.endsWith("Bps") && value > 1000)) throw new TypeError(`Invalid execution.${key}`);
  }
  return result;
}

function prepareDataset(dataset, to) {
  if (!dataset || dataset.schemaVersion !== 1 || !["synthetic", "real"].includes(dataset.sourceClass) ||
    typeof dataset.source !== "string" || !dataset.source.trim() ||
    !["point-in-time", "current-survivors", "selected"].includes(dataset.universeMode)) {
    throw new TypeError("dataset requires schemaVersion=1, sourceClass, source and universeMode");
  }
  if (dataset.priceLimitEvidence !== undefined && !["official", "synthetic", "calculated", "unknown"].includes(dataset.priceLimitEvidence)) throw new TypeError("dataset.priceLimitEvidence is invalid");
  const calendar = sortedDates(dataset.calendar, "calendar").filter(date => date <= to);
  if (!calendar.length) throw new TypeError("calendar has no dates at or before to");
  const calendarSet = new Set(calendar);
  const benchmarkRows = rowsThrough(dataset.benchmarkRows, to, "benchmarkRows", calendarSet);
  if (!Array.isArray(dataset.securities) || !dataset.securities.length) throw new TypeError("dataset.securities must be nonempty");
  const codes = new Set();
  const securities = dataset.securities.map((item, index) => {
    const security = { ...item.security };
    if (!/^\d{6}$/.test(security.code) || !security.name || !security.secid || codes.has(security.code)) throw new TypeError(`Invalid or duplicate securities[${index}].security`);
    codes.add(security.code);
    const rawRows = rowsThrough(item.rawRows, to, `${security.code}.rawRows`, calendarSet, true);
    const adjustedRows = rowsThrough(item.adjustedRows, to, `${security.code}.adjustedRows`, calendarSet);
    const states = item.statusHistory === undefined ? [] : item.statusHistory;
    if (!Array.isArray(states) || states.some(state => !iso(state?.date))) throw new TypeError(`${security.code}.statusHistory invalid dates`);
    const statusHistory = states.filter(state => state.date <= to).map(state => ({ ...state })).sort((a, b) => a.date.localeCompare(b.date));
    if (new Set(statusHistory.map(state => state.date)).size !== statusHistory.length) throw new TypeError(`${security.code}.statusHistory duplicate date`);
    for (const state of statusHistory) {
      if (typeof state.name !== "string" || !state.name || typeof state.isST !== "boolean" || typeof state.listed !== "boolean") throw new TypeError(`${security.code}.statusHistory requires historical name/isST/listed`);
      for (const key of ["minimumBuyQuantity", "quantityStep"]) if (state[key] !== undefined && (!Number.isSafeInteger(state[key]) || state[key] < 1)) throw new TypeError(`${security.code}.statusHistory invalid ${key}`);
    }
    // A historical ST interval must remain visible to the classic event-window veto,
    // even when today's security name or an imported bar flag says otherwise.
    let stateIndex = -1;
    for (const row of rawRows) {
      while (statusHistory[stateIndex + 1]?.date <= row.date) stateIndex++;
      if (stateIndex >= 0) row.isST = row.isST === true || statusHistory[stateIndex].isST;
    }
    return { security, rawRows, adjustedRows, statusHistory,
      priceLimitsVerified: dataset.sourceClass === "synthetic" || dataset.priceLimitEvidence === "official",
      rawByDate: new Map(rawRows.map(row => [row.date, row])), adjustedByDate: new Map(adjustedRows.map(row => [row.date, row])) };
  }).sort((a, b) => a.security.code.localeCompare(b.security.code));
  return { calendar, benchmarkRows, securities };
}

function stateAt(stock, date) {
  let state = null;
  for (const candidate of stock.statusHistory) {
    if (candidate.date > date) break;
    state = candidate;
  }
  return state;
}

function identityAt(stock, date) {
  const state = stateAt(stock, date);
  const bar = stock.rawByDate.get(date);
  return { ...stock.security, ...(state || {}),
    isST: state ? state.isST : bar?.isST ?? stock.security.isST };
}

function adjustmentFactor(raw, adjusted) {
  if (!raw || !adjusted) return null;
  const factor = raw.open / adjusted.open;
  return ["high", "low", "close"].every(key => Math.abs(raw[key] / adjusted[key] / factor - 1) < 1e-6) ? factor : null;
}

function tradability(row, side) {
  if (row.suspended === true || row.volume <= 0 || row.amount <= 0) return "suspended";
  if (row.noPriceLimit !== true && (!finite(row.upperLimit) || !finite(row.lowerLimit))) return "unknown_price_limits";
  if (row.noPriceLimit !== true && (row.open > row.upperLimit + .005 || row.open < row.lowerLimit - .005)) return "inconsistent_price_limits";
  if (side === "buy" && row.noPriceLimit !== true && row.open >= row.upperLimit - .005) return "opening_upper_limit";
  if (side === "sell" && row.noPriceLimit !== true && row.open <= row.lowerLimit + .005) return "opening_lower_limit";
  return null;
}

function fillPrice(open, side, bps) {
  const slipped = open * (1 + (side === "buy" ? 1 : -1) * bps / 10000);
  return side === "buy" ? Math.ceil((slipped - 1e-9) * 100) / 100 : Math.floor((slipped + 1e-9) * 100) / 100;
}

function fees(value, side, execution) {
  const commission = money(Math.max(execution.minCommission, value * execution.commissionBps / 10000));
  const transfer = money(value * execution.transferFeeBps / 10000);
  const tax = side === "sell" ? money(value * execution.sellTaxBps / 10000) : 0;
  return { commission, transfer, tax, total: money(commission + transfer + tax) };
}

function quantities(stock, date) {
  const state = stateAt(stock, date);
  const star = /^68[89]/.test(stock.security.code);
  const beijing = /^(?:[48]|920)/.test(stock.security.code);
  return { minimum: state?.minimumBuyQuantity ?? (star ? 200 : 100), step: state?.quantityStep ?? (star || beijing ? 1 : 100) };
}

function evaluateSample(stock, candidate, signalIndex, calendar, execution) {
  const signalDate = calendar[signalIndex];
  const plan = structuredClone(candidate.plan);
  const sample = { code: stock.security.code, name: candidate.security.name, signalDate, strategy: candidate.strategy || null,
    plan, status: "pending", reason: "pending_next_open", entryDate: null, entryPrice: null, exitDate: null, exitPrice: null,
    exitReason: null, shares: 0, entryCost: null, exitProceeds: null, grossReturnPercent: null, netReturnPercent: null,
    maxAdverseExcursionPercent: null, holdingTradingDays: 0, delayedExitSessions: 0, lastObservedDate: signalDate };
  const finish = (status, reason, date) => ({ ...sample, status, reason, ...(date ? { unresolvedDate: date } : {}),
    ...(reason === "corporate_action_unresolved" ? { reasonText: "原始与复权OHLC比例无法一致核验：可能是复权价格舍入、精度不足或公司行为，不能据此确定原因或生成已实现收益。" } : {}) });
  if (signalIndex + 1 >= calendar.length) return sample;
  const entryIndex = signalIndex + 1;
  const entryDate = calendar[entryIndex];
  const raw = stock.rawByDate.get(entryDate); const adjusted = stock.adjustedByDate.get(entryDate);
  if (!raw || !adjusted) return finish("unresolved", "missing_entry_bar", entryDate);
  if (!stock.priceLimitsVerified) return finish("unresolved", "unverified_price_limit_source", entryDate);
  const signalFactor = adjustmentFactor(stock.rawByDate.get(signalDate), stock.adjustedByDate.get(signalDate));
  const entryFactor = adjustmentFactor(raw, adjusted);
  if (!signalFactor || !entryFactor || Math.abs(entryFactor / signalFactor - 1) >= 1e-6) return finish("unresolved", "corporate_action_unresolved", entryDate);
  const state = identityAt(stock, entryDate);
  if (state.listed === false || state.isST === true || /\*?ST|退市|退$/i.test(state.name)) return finish("rejected", "entry_security_ineligible");
  const entryIssue = tradability(raw, "buy");
  if (entryIssue) return finish(entryIssue.includes("price_limits") ? "unresolved" : "rejected", entryIssue);
  const entryPrice = fillPrice(raw.open, "buy", execution.slippageBps);
  const minEntry = plan.minEntry ?? money(plan.stop + .01);
  if (entryPrice < minEntry - 1e-9 || entryPrice <= plan.stop || entryPrice > plan.maxEntry + 1e-9 ||
    (raw.noPriceLimit !== true && entryPrice > raw.upperLimit + 1e-9)) return finish("rejected", "outside_entry_range");
  const quantity = quantities(stock, entryDate);
  const maxShares = Math.floor(execution.notional / entryPrice);
  const shares = maxShares < quantity.minimum ? 0 : quantity.minimum + Math.floor((maxShares - quantity.minimum) / quantity.step) * quantity.step;
  if (!shares) return finish("rejected", "insufficient_notional");
  const entryFees = fees(shares * entryPrice, "buy", execution);
  Object.assign(sample, { entryDate, entryPrice, shares, entryFees, entryCost: money(shares * entryPrice + entryFees.total), status: "censored", reason: "evaluation_end" });
  let exitReason = null; let previousBelow = false; let worst = 0;
  for (let index = entryIndex; index < calendar.length; index++) {
    const date = calendar[index]; const row = stock.rawByDate.get(date); const adj = stock.adjustedByDate.get(date);
    sample.holdingTradingDays = index - entryIndex + 1;
    if (!row || !adj) return finish("unresolved", "missing_held_bar", date);
    if (stateAt(stock, date)?.listed === false) return finish("unresolved", "delisting_settlement_unknown", date);
    const factor = adjustmentFactor(row, adj);
    if (!factor || Math.abs(factor / entryFactor - 1) >= 1e-6) return finish("unresolved", "corporate_action_unresolved", date);
    if (exitReason && index > entryIndex) {
      const issue = tradability(row, "sell");
      if (issue === "unknown_price_limits" || issue === "inconsistent_price_limits") return finish("unresolved", issue, date);
      if (!issue) {
        const exitPrice = fillPrice(row.open, "sell", execution.slippageBps);
        if (row.noPriceLimit !== true && exitPrice < row.lowerLimit - 1e-9) return finish("unresolved", "slippage_beyond_lower_limit", date);
        const exitFees = fees(shares * exitPrice, "sell", execution);
        const exitProceeds = money(shares * exitPrice - exitFees.total);
        return { ...sample, status: "closed", reason: null, exitReason, exitDate: date, exitPrice, exitFees, exitProceeds,
          lastObservedDate: date, grossReturnPercent: round((exitPrice / entryPrice - 1) * 100),
          maxAdverseExcursionPercent: round(Math.min(worst, (exitPrice / entryPrice - 1) * 100)),
          netReturnPercent: round((exitProceeds / sample.entryCost - 1) * 100) };
      }
      sample.delayedExitSessions++;
    }
    sample.lastObservedDate = date;
    if (row.suspended === true || row.volume <= 0 || row.amount <= 0) {
      previousBelow = false;
      if (sample.holdingTradingDays >= 29) exitReason ||= "maximum_holding_period";
      continue;
    }
    worst = Math.min(worst, (row.low / entryPrice - 1) * 100);
    sample.maxAdverseExcursionPercent = round(worst);
    const currentIndex = stock.adjustedRows.findIndex(bar => bar.date === date);
    const recent = stock.adjustedRows.slice(currentIndex - 19, currentIndex + 1);
    const ma20 = recent.length === 20 ? recent.reduce((sum, bar) => sum + bar.close, 0) / 20 * factor : null;
    if (!ma20) return finish("unresolved", "missing_exit_ma20", date);
    const below = row.close < ma20;
    if (row.close < plan.stop) exitReason ||= "close_below_frozen_stop";
    else if (previousBelow && below) exitReason ||= "two_closes_below_ma20";
    else if (sample.holdingTradingDays >= 29) exitReason ||= "maximum_holding_period";
    previousBelow = below;
  }
  return { ...sample, exitReason };
}

function summarize(samples) {
  const closed = samples.filter(sample => sample.status === "closed");
  return { signals: samples.length, entered: samples.filter(sample => sample.entryDate).length, closed: closed.length,
    pending: samples.filter(sample => sample.status === "pending").length,
    censored: samples.filter(sample => sample.status === "censored").length,
    rejected: samples.filter(sample => sample.status === "rejected").length,
    unresolved: samples.filter(sample => sample.status === "unresolved").length,
    meanNetReturnPercent: mean(closed.map(sample => sample.netReturnPercent)),
    meanGrossReturnPercent: mean(closed.map(sample => sample.grossReturnPercent)),
    winRatePercent: closed.length ? round(closed.filter(sample => sample.netReturnPercent > 0).length / closed.length * 100) : null,
    meanClosedTradeMaePercent: mean(closed.map(sample => sample.maxAdverseExcursionPercent)),
    meanHoldingTradingDays: mean(closed.map(sample => sample.holdingTradingDays)),
    totalModeledFees: money(samples.reduce((sum, sample) => sum + (sample.entryFees?.total || 0) + (sample.exitFees?.total || 0), 0)),
    independentSignalDates: new Set(samples.map(sample => sample.signalDate)).size,
    distinctSecurities: new Set(samples.map(sample => sample.code)).size };
}

function evaluatePeriod(prepared, from, to, options, execution) {
  const calendar = prepared.calendar.filter(date => date <= to);
  const lookback = STRATEGY_LIBRARY.find(entry => entry.id === options.strategyId)?.marketCalendarLookback ?? 65;
  const benchmarkDates = new Set(prepared.benchmarkRows.map(row => row.date));
  const samples = []; const coverage = { evaluations: 0, candidates: 0, watch: 0, excluded: 0, unavailable: 0, reasons: {} };
  for (let index = 0; index < calendar.length; index++) {
    const asOf = calendar[index]; if (asOf < from) continue;
    // Stock and benchmark can share the same missing pages. Their mutual alignment
    // is insufficient: the supplied market calendar is the independent clock.
    const recentSessions = calendar.slice(Math.max(0, index - lookback + 1), index + 1);
    const benchmarkGap = recentSessions.length < lookback || recentSessions.some(date => !benchmarkDates.has(date));
    const benchmarkRows = prepared.benchmarkRows.filter(row => row.date <= asOf);
    for (const stock of prepared.securities) {
      coverage.evaluations++;
      const identity = identityAt(stock, asOf);
      const calendarGap = benchmarkGap || recentSessions.some(date => !stock.rawByDate.has(date) || !stock.adjustedByDate.has(date));
      const outcome = identity.listed === false ? { kind: "excluded", reason: "Not listed at signal date" } :
        calendarGap ? { kind: "unavailable", reason: "market_calendar_gap" } : evaluateTrendStrategy({ security: identity,
        rawRows: stock.rawRows.filter(row => row.date <= asOf), adjustedRows: stock.adjustedRows.filter(row => row.date <= asOf), benchmarkRows, asOf }, options);
      if (outcome.kind !== "candidate") {
        coverage[outcome.kind === "excluded" ? "excluded" : "unavailable"]++;
        coverage.reasons[outcome.reason] = (coverage.reasons[outcome.reason] || 0) + 1;
        continue;
      }
      coverage.candidates++;
      if (outcome.candidate.stage !== "signal" || !outcome.candidate.plan) { coverage.watch++; continue; }
      samples.push(evaluateSample(stock, outcome.candidate, index, calendar, execution));
    }
  }
  return { range: { from, to }, metrics: summarize(samples), coverage, samples };
}

function evaluateTrendStrategies({ dataset, from, to, splitDate, advancedStrategyId = "quality-v2", advancedConfig, execution: executionInput } = {}) {
  const started = performance.now();
  if (!iso(from) || !iso(to) || from > to || !iso(splitDate) || splitDate < from || splitDate > to) throw new TypeError("from/to/splitDate must be ordered ISO dates (from <= splitDate <= to)");
  const execution = normalizeExecution(executionInput);
  const baselineOptions = { strategyId: "classic-v1" };
  const advancedOptions = { strategyId: advancedStrategyId, ...(advancedConfig === undefined ? {} : { config: advancedConfig }) };
  const baselineStrategy = normalizeTrendStrategy(baselineOptions);
  const advancedStrategy = normalizeTrendStrategy(advancedOptions);
  const prepared = prepareDataset(dataset, to);
  const developmentTo = prepared.calendar.filter(date => date < splitDate).at(-1) || null;
  const run = (options, strategy) => ({ strategy,
    ...evaluatePeriod(prepared, splitDate, to, options, execution),
    development: developmentTo && developmentTo >= from ? evaluatePeriod(prepared, from, developmentTo, options, execution) :
      { range: { from, to: developmentTo }, metrics: summarize([]), coverage: { evaluations: 0, candidates: 0, watch: 0, excluded: 0, unavailable: 0, reasons: {} }, samples: [] } });
  const baseline = run(baselineOptions, baselineStrategy); const advanced = run(advancedOptions, advancedStrategy);
  const limitations = ["独立信号交易样本，同股信号允许重叠；没有共享资金账户、仓位容量或组合收益。",
    "闭合样本收益均值不含未平仓或未解决样本；须同时检查删失、拒绝及未解决数量，不能据均值认定策略优越。",
    "日线开盘撮合为保守模型，未模拟真实排队、成交深度、公告或账户权限；费率与滑点为用户配置假设。",
    "开发区和测试区独立截止，参数未在本评估器拟合；反复查看测试结果后调参会使留出区失效。"];
  if (dataset.sourceClass === "synthetic") limitations.push("合成证券与工作日日历仅验证软件机制，所有收益均无真实投资证据含义。");
  if (dataset.universeMode !== "point-in-time") limitations.push("证券池不是历史时点全市场成分，存在选择偏差或幸存者偏差。");
  if (dataset.historicalStatusComplete !== true || prepared.securities.some(stock => !stock.statusHistory.length)) limitations.push("历史证券状态、行业或交易规则未完整证明，当前证券名称和交易单位可能不适用于历史。");
  if (dataset.sourceClass === "real" && dataset.priceLimitEvidence !== "official") limitations.push("真实数据未声明官方历史限价来源，信号不产生可成交收益；推算限价不能替代历史特殊交易规则。");
  if ([baseline, advanced].some(result => result.metrics.unresolved || result.development.metrics.unresolved)) limitations.push("存在无法核验限价、缺行情或公司行为的样本，收益不完整，不能作为可成交回测验证。");
  return { schemaVersion: 1, scope: "independent-signal-cohorts", range: { from, to, splitDate, developmentTo }, execution,
    provenance: { sourceClass: dataset.sourceClass, source: dataset.source, universeMode: dataset.universeMode,
      priceLimitEvidence: dataset.priceLimitEvidence ?? "unknown",
      dataHash: digest({ sourceClass: dataset.sourceClass, source: dataset.source, universeMode: dataset.universeMode, calendar: prepared.calendar,
        benchmarkRows: prepared.benchmarkRows, securities: prepared.securities.map(({ rawByDate, adjustedByDate, ...stock }) => stock) }) },
    qualification: { status: dataset.sourceClass === "synthetic" ? "SYNTHETIC_MECHANICS_ONLY" : "REAL_DIAGNOSTIC",
      returnSuperiorityVerified: false, limitations },
    methodology: { timing: "收盘信号仅使用截至当日数据；下一市场日开盘，开盘涨停不买、跌停延迟退出。",
      samples: "每次信号独立使用固定名义金额，同股重叠信号不合并；均值是已结束交易的非组合统计。",
      split: "开发信号 [from,splitDate)，开发成交也截止 splitDate 前；测试信号 [splitDate,to]，不借用 to 后行情。",
      exit: "收盘低于冻结S、两个连续持仓交易日收盘低于MA20、或第29日晚触发，下一可交易日开盘退出。",
      missing: "显式停牌可延迟退出；未知缺数、无法核验限价、复权因子变化或复权精度不足单列unresolved；期末未平仓censored。" },
    baseline, advanced,
    comparison: { closedMeanNetReturnDifferencePercent: baseline.metrics.meanNetReturnPercent === null || advanced.metrics.meanNetReturnPercent === null ? null :
      round(advanced.metrics.meanNetReturnPercent - baseline.metrics.meanNetReturnPercent),
      signalCountDifference: advanced.metrics.signals - baseline.metrics.signals, interpretation: "不同筛选样本的描述性差异；不是配对因果效应或收益优越结论。" },
    performance: { elapsedMs: round(performance.now() - started, 3), securities: prepared.securities.length,
      evaluationDates: prepared.calendar.filter(date => date >= from).length, peakRssBytes: process.resourceUsage().maxRSS * 1024,
      nodeVersion: process.version, platform: process.platform } };
}

module.exports = { evaluateTrendStrategies };
