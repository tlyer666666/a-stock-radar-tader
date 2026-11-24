"use strict";
// 从 electron/services.cjs 提取（2026-11-15 审核 P0-2b 拆分）。
// services.cjs 通过顶部解构回本模块并继续按原契约 re-export，勿在这里引入
// 对 services.cjs 的反向依赖。
const { BoundedCache } = require("../bounded-cache.cjs");
const _runtime = require("./runtime.cjs");
const { fuyao, serviceRuntime } = _runtime;
function serviceSignal(...args) { return _runtime.serviceSignal(...args); }
function trackServiceRequest(...args) { return _runtime.trackServiceRequest(...args); }
const _backtest = require("./backtest.cjs");
function finiteOrNull(...args) { return _backtest.finiteOrNull(...args); }

const fuyaoReviewCache = new BoundedCache({ maxEntries: 4, maxBytes: 2 * 1024 * 1024, staleTtlMs: 0, now: () => Date.now() });

/** 涨停原因归类：同花顺原因写成「A+B+C」，按「+」拆开计数。 */
function limitUpReasonGroups(rows, top = 12) {
  const groups = new Map();
  for (const row of rows) {
    for (const part of String(row.reason || "").split(/[+＋、,，;；]/).map((text) => text.trim()).filter(Boolean)) {
      const group = groups.get(part) || { reason: part, count: 0, stocks: [] };
      group.count += 1;
      if (group.stocks.length < 6) group.stocks.push({ code: row.code, name: row.name, boards: row.boards });
      groups.set(part, group);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "zh-CN")).slice(0, top);
}

/** 北京时间分钟数与日期（交易日判断由调用方负责）。 */
function fuyaoClock(now = Date.now()) {
  const cn = new Date(now + 8 * 3600000);
  return { date: cn.toISOString().slice(0, 10), minute: cn.getUTCHours() * 60 + cn.getUTCMinutes(), hhmm: cn.toISOString().slice(11, 16) };
}

/**
 * 扶摇在每天约 9:00 清空各池、开盘前对空池返回 code=5003「missing required pagination」（2026-11-06 实测：
 * 08:57 正常，09:00 起跌停池报这个错，涨停池同时返回 0 只）。9:25 之前当日池子按定义就是空的，按空池处理、不报警。
 */
const isPreOpenEmptyPool = (reason, now = Date.now()) => /missing required pagination/i.test(String(reason?.message || reason || "")) && fuyaoClock(now).minute < 9 * 60 + 25;

/** 各分块最近一次成功的数据（同一天内）：某块单次刷新失败时沿用，并在提示里写明时间，不让整块消失。 */
const fuyaoLastGood = new Map();

/** 北京时间交易日 9:10–11:35、12:55–15:10（含竞价与收盘后几分钟的补数据）。 */
function fuyaoDataMayChange(now = Date.now()) {
  const cn = new Date(now + 8 * 3600000);
  const date = cn.toISOString().slice(0, 10);
  const { tradingDateStatus } = require("../market-time-rules.cjs");
  if (tradingDateStatus(date) === false) return false;
  const minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  return (minute >= 9 * 60 + 10 && minute <= 11 * 60 + 35) || (minute >= 12 * 60 + 55 && minute <= 15 * 60 + 10);
}

/**
 * 复盘页的同花顺扶摇数据：连板天梯、涨停原因、炸板/跌停、热股榜、飙升榜、龙虎榜、异动解读。
 * 没有 Key 时返回 { available: false }；每一块独立失败，不拖累其他块和复盘主体。
 */
async function getFuyaoReviewData(options = {}) {
  return (await getFuyaoReviewSnapshot(options)).review;
}

async function getFuyaoReviewSnapshot(options = {}) {
  if (!fuyao.configured()) return { review: { available: false, reason: "未配置同花顺扶摇 API Key（数据源设置里填写后即可显示）" }, industryPool: null };
  const signal = serviceSignal();
  // 交易时段 60 秒刷新；收盘后、午休和休市日数据不再变化，改为 20 分钟，避免页面定时刷新反复调用按次计费的扶摇接口。
  // 两种时段各用一个固定键：开盘时不沿用休市缓存或订阅尚未完成的休市请求。
  const cacheKey = fuyaoDataMayChange() ? "review:live" : "review:closed";
  return serviceRuntime.cached(fuyaoReviewCache, cacheKey, () => (fuyaoDataMayChange() ? 60 * 1000 : 20 * 60 * 1000), async () => {
    const parts = {
      limitUp: () => fuyao.limitUpPool({ signal }),
      limitBreak: () => fuyao.limitBreakPool({ signal }),
      limitDown: () => fuyao.limitDownPool({ signal }),
      ladder: () => fuyao.limitUpLadder({ signal }),
      hot: () => fuyao.hotStocks({ period: "day", signal }),
      skyrocket: () => fuyao.skyrocket({ period: "day", signal }),
      hotHour: () => fuyao.hotStocks({ period: "hour", signal }),
      skyrocketHour: () => fuyao.skyrocket({ period: "hour", signal }),
      dragonTiger: () => fuyao.dragonTiger({ signal }),
      anomalies: () => fuyao.anomalies({ tags: ["LIMIT_UP", "SHARP_RISE", "RAPID_RALLY", "LIMIT_DOWN", "SHARP_FALL"], signal })
    };
    const names = Object.keys(parts);
    const settled = await Promise.allSettled(names.map((name) => serviceRuntime.track(() => trackServiceRequest(parts[name]()))));
    const labels = { limitUp: "涨停池", limitBreak: "炸板池", limitDown: "跌停池", ladder: "连板天梯", hot: "24小时热股榜", skyrocket: "24小时飙升榜", hotHour: "1小时热股榜", skyrocketHour: "1小时飙升榜", dragonTiger: "龙虎榜", anomalies: "异动解读" };
    const clock = fuyaoClock(), live = fuyaoDataMayChange();
    // 只在本轮有其他分块成功时才沿用：全部失败仍按失败处理；也只沿用同一天、同一时段（盘中/休市）的数据，开盘时不拿开盘前的数据顶替。
    const anySucceeded = settled.some((result) => result.status === "fulfilled");
    const value = {}, warnings = [];
    names.forEach((name, index) => {
      const result = settled[index];
      if (result.status === "fulfilled") { value[name] = result.value; fuyaoLastGood.set(name, { value: result.value, date: clock.date, hhmm: clock.hhmm, live }); return; }
      if (["limitUp", "limitBreak", "limitDown"].includes(name) && isPreOpenEmptyPool(result.reason)) { value[name] = { rows: [], total: 0, fetchedAt: "" }; return; }
      const reason = String(result.reason?.message || result.reason).slice(0, 80);
      const last = fuyaoLastGood.get(name);
      if (anySucceeded && last && last.date === clock.date && last.live === live) { value[name] = last.value; warnings.push(`${labels[name]}本次刷新失败，沿用 ${last.hhmm} 的数据（${reason}）`); return; }
      value[name] = null; warnings.push(`${labels[name]}暂不可用：${reason}`);
    });
    if (names.every((name) => value[name] === null)) {
      const first = settled[0].reason;
      throw Object.assign(new Error(`同花顺扶摇复盘数据全部不可用：${first?.message || first}`), { code: first?.code });
    }
    const limitUpRows = (value.limitUp?.rows || []).filter((row) => !row.isSt);
    const hotLists = await fuyaoHotLists(value, signal);
    const maxBoards = limitUpRows.reduce((max, row) => Math.max(max, Number(row.boards) || 0), 0);
    const review = {
      available: true,
      source: "同花顺扶摇官方数据接口",
      fetchedAt: new Date().toISOString(),
      limitUp: value.limitUp ? {
        count: limitUpRows.length,
        maxBoards,
        boardCounts: [1, 2, 3, 4, 5].map((level) => ({ level, label: level === 5 ? "5板以上" : level === 1 ? "首板" : `${level}板`,
          count: limitUpRows.filter((row) => level === 5 ? Number(row.boards) >= 5 : Number(row.boards || 1) === level).length })),
        reasons: limitUpReasonGroups(limitUpRows),
        leaders: limitUpRows.filter((row) => Number(row.boards) >= 2).sort((a, b) => (b.boards || 0) - (a.boards || 0) || (b.sealMoney || 0) - (a.sealMoney || 0)).slice(0, 12),
        // 每只涨停股的同花顺涨停原因，复盘梯队按代码合并。
        byCode: Object.fromEntries(limitUpRows.slice(0, 300).map((row) => [row.code, { name: row.name, reason: row.reason, boards: row.boards, boardsText: row.boardsText, sealMoney: row.sealMoney, limitUpTime: row.limitUpTime }]))
      } : null,
      // byCode：AI 问股按代码查一只股票是否在炸板池、跌停池、龙虎榜里（只留几个字段）。
      limitBreak: value.limitBreak ? { count: value.limitBreak.total, top: value.limitBreak.rows.slice(0, 10),
        byCode: Object.fromEntries(value.limitBreak.rows.slice(0, 400).map((row) => [row.code, { name: row.name, changePct: row.changePct, openTimes: row.openTimes, turnoverRate: row.turnoverRate }])) } : null,
      limitDown: value.limitDown ? { count: value.limitDown.total, top: value.limitDown.rows.slice(0, 10),
        byCode: Object.fromEntries(value.limitDown.rows.slice(0, 300).map((row) => [row.code, { name: row.name, changePct: row.changePct, firstLimitTime: row.firstLimitTime, lastLimitTime: row.lastLimitTime }])) } : null,
      sealRate: value.limitUp && value.limitBreak && limitUpRows.length + value.limitBreak.total > 0
        ? limitUpRows.length / (limitUpRows.length + value.limitBreak.total) : null,
      ladder: value.ladder ? { days: value.ladder.days.slice(-5) } : null,
      hot: value.hot ? value.hot.slice(0, 20) : null,
      skyrocket: value.skyrocket ? value.skyrocket.slice(0, 10) : null,
      // 同花顺热榜两个页签：1小时 / 24小时，各含热股榜与飙升榜（各最多30条，带当前涨跌幅）。
      hotLists,
      dragonTiger: value.dragonTiger ? {
        date: value.dragonTiger.date,
        count: value.dragonTiger.count,
        topNet: [...value.dragonTiger.stocks].filter((row) => Number.isFinite(row.net)).sort((a, b) => b.net - a.net).slice(0, 10),
        desks: value.dragonTiger.desks.slice(0, 6),
        byCode: Object.fromEntries(value.dragonTiger.stocks.slice(0, 200).map((row) => [row.code, { name: row.name, changePct: row.changePct, net: row.net, buy: row.buy, sell: row.sell,
          orgNet: row.orgNet, hotMoneyNet: row.hotMoneyNet, reason: row.reason, concepts: row.concepts, days: row.days,
          desks: value.dragonTiger.desks.filter((desk) => desk.stocks.some((item) => item.code === row.code)).map((desk) => desk.name).slice(0, 4) }]))
      } : null,
      anomalies: value.anomalies ? value.anomalies.rows.slice(0, 30) : null,
      warnings
    };
    // 行业成分明细也显示 ST 股；行业榜用完整池，复盘摘要维持原来的筛选和条数。
    return { review, industryPool: value.limitUp ? {
      total: value.limitUp.total,
      stocks: value.limitUp.rows.map(({ code, name, boards, reason, isSt }) => ({ code, name, boards, reason, isSt }))
    } : null };
  }, { forceRefresh: options?.forceRefresh === true });
}

/**
 * 热榜按同花顺的 1小时 / 24小时 两个页签整理；榜单本身不带价格，用扶摇批量快照补现价与涨跌幅
 * （快照失败只是不显示涨跌幅，不影响榜单）。
 */
async function fuyaoHotLists(value, signal) {
  const lists = { hour: { hot: value.hotHour, skyrocket: value.skyrocketHour }, day: { hot: value.hot, skyrocket: value.skyrocket } };
  const codes = new Map();
  for (const period of Object.values(lists)) for (const rows of Object.values(period)) for (const row of rows || []) if (row?.code) codes.set(row.code, row);
  let quotes = new Map();
  if (codes.size) {
    try {
      quotes = await serviceRuntime.track(() => trackServiceRequest(fuyao.snapshot([...codes.values()].map(row => ({ code: row.code, thscode: row.thscode })), { signal })));
    } catch (error) {
      signal?.throwIfAborted?.();
      if (error?.name === "AbortError") throw error;
      quotes = new Map();
    }
  }
  const withQuote = rows => Array.isArray(rows) ? rows.slice(0, 30).map(row => {
    const code = String(row.code || "").trim();
    const thscode = String(row.thscode || (code ? `${code}.${/^6/.test(code) ? "SH" : /^(?:4|8|92)/.test(code) ? "BJ" : "SZ"}` : "")).trim().toUpperCase();
    const quote = quotes.get(thscode) || quotes.get(code);
    return { ...row, latest: finiteOrNull(quote?.latest), changePct: finiteOrNull(quote?.changePct) };
  }) : null;
  const pack = period => (lists[period].hot || lists[period].skyrocket) ? { hot: withQuote(lists[period].hot), skyrocket: withQuote(lists[period].skyrocket) } : null;
  const hour = pack("hour"), day = pack("day");
  return hour || day ? { hour, day, quotedAt: quotes.size ? new Date().toISOString() : null } : null;
}

module.exports = {
  fuyaoReviewCache,
  limitUpReasonGroups,
  fuyaoClock,
  isPreOpenEmptyPool,
  fuyaoLastGood,
  fuyaoDataMayChange,
  getFuyaoReviewData,
  getFuyaoReviewSnapshot,
  fuyaoHotLists
};
