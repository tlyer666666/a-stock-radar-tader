"use strict";

/**
 * 任意股票的「体检数据」：用日线（最近约 120 根）算出 AI 打分需要的客观指标。
 * 价位（支撑/压力）全部由这里按均线和区间高低点算出，AI 只能引用、不能自己编价位。
 * 纯函数，不联网；行情由调用方传入。
 */
const { priceLimitRate } = require("./price-limit-rules.cjs");
const { macd, rsi } = require("./trend-indicators.cjs");

const finite = value => typeof value === "number" && Number.isFinite(value) ? value : (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
const round = (value, digits = 2) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const pct = (now, before) => now !== null && before !== null && before > 0 ? round((now / before - 1) * 100) : null;

function cleanRows(rows) {
  const list = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row?.date || "").slice(0, 10);
    const close = finite(row?.close), high = finite(row?.high), low = finite(row?.low), open = finite(row?.open);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close === null || close <= 0 || high === null || low === null) continue;
    if (list.length && list.at(-1).date >= date) continue;
    list.push({ date, open: open ?? close, close, high, low, volume: finite(row?.volume), amount: finite(row?.amount), turnover: finite(row?.turnover) });
  }
  return list;
}

const average = values => {
  const usable = values.filter(value => value !== null && Number.isFinite(value));
  return usable.length === values.length && usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
};
const movingAverage = (rows, size, end = rows.length) => end >= size ? average(rows.slice(end - size, end).map(row => row.close)) : null;

/** 以涨跌幅判断涨停（复权价对涨停价的四舍五入不敏感）：收盘涨幅达到限幅且收在最高价附近。 */
function limitState(previous, row, code, name) {
  if (!previous) return { limitUp: false, touched: false };
  const rate = priceLimitRate(code, name, row.date);
  const tolerance = rate >= 0.2 ? 0.004 : 0.003;
  const closeGain = row.close / previous.close - 1;
  const highGain = row.high / previous.close - 1;
  const limitUp = closeGain >= rate - tolerance && row.close >= row.high * 0.999;
  return { limitUp, touched: !limitUp && highGain >= rate - tolerance };
}

/**
 * @param {{ code: string, name?: string, industry?: string, rows: Array<object> }} input
 * @returns 体检数据；日线不足 2 根时返回 null。
 */
function buildStockProfile({ code, name = "", industry = "", rows } = {}) {
  const bars = cleanRows(rows);
  if (!/^\d{6}$/.test(String(code || "")) || bars.length < 2) return null;
  const last = bars.at(-1);
  const previous = bars.at(-2);
  const closeAgo = days => bars.length > days ? bars.at(-1 - days).close : null;
  const ma = { ma5: movingAverage(bars, 5), ma10: movingAverage(bars, 10), ma20: movingAverage(bars, 20), ma60: movingAverage(bars, 60) };
  const above = Object.fromEntries(Object.entries(ma).map(([key, value]) => [key, value === null ? null : last.close >= value]));
  const recent = (count) => bars.slice(-count);
  const high20 = Math.max(...recent(20).map(row => row.high));
  const low20 = Math.min(...recent(20).map(row => row.low));
  const high60 = Math.max(...recent(60).map(row => row.high));
  const low60 = Math.min(...recent(60).map(row => row.low));
  const prevVolumes = bars.slice(-6, -1).map(row => row.volume);
  const volumeRatio = last.volume !== null && prevVolumes.length === 5 && average(prevVolumes) > 0 ? round(last.volume / average(prevVolumes)) : null;
  const amounts20 = recent(20).map(row => row.amount).filter(value => value !== null);

  // 涨停记录：近 20 根内涨停次数、炸板（摸到涨停没封住）次数、最近一次涨停、当前连板。
  const states = bars.map((row, index) => limitState(bars[index - 1], row, code, name));
  const window = states.slice(-20);
  const limitUps20 = window.filter(item => item.limitUp).length;
  const broken20 = window.filter(item => item.touched).length;
  let lastLimitIndex = -1;
  for (let index = states.length - 1; index >= 0; index -= 1) if (states[index].limitUp) { lastLimitIndex = index; break; }
  let boards = 0;
  for (let index = states.length - 1; index >= 0 && states[index].limitUp; index -= 1) boards += 1;

  // 支撑/压力：均线和区间高低点里，低于现价的取最近的 3 个做支撑，高于现价的取最近的 3 个做压力。
  const candidates = [
    { label: "5日线", price: ma.ma5 }, { label: "10日线", price: ma.ma10 }, { label: "20日线", price: ma.ma20 }, { label: "60日线", price: ma.ma60 },
    { label: "近20日最低", price: low20 }, { label: "近60日最低", price: low60 }, { label: "近20日最高", price: high20 }, { label: "近60日最高", price: high60 },
    ...(lastLimitIndex >= 0 ? [{ label: "最近涨停日最低", price: bars[lastLimitIndex].low }] : [])
  ].filter(item => item.price !== null && Number.isFinite(item.price)).map(item => ({ label: item.label, price: round(item.price) }));
  const unique = list => list.filter((item, index) => list.findIndex(other => Math.abs(other.price - item.price) < 0.005) === index);
  const support = unique(candidates.filter(item => item.price < last.close).sort((a, b) => b.price - a.price)).slice(0, 3);
  const resistance = unique(candidates.filter(item => item.price > last.close).sort((a, b) => a.price - b.price)).slice(0, 3);

  // 技术指标：MACD(12,26,9)、RSI(6/14)、5日线乖离、均线排列、近 20 根内未回补的跳空缺口。
  const closes = bars.map(row => row.close);
  const macdLines = macd(closes);
  const at = (series, back = 0) => { const value = series[series.length - 1 - back]; return Number.isFinite(value) ? value : null; };
  const dif = at(macdLines.dif), dea = at(macdLines.dea), hist = at(macdLines.histogram), histPrev = at(macdLines.histogram, 1);
  let crossDays = null, cross = "";
  for (let back = 0; back < Math.min(5, bars.length - 1); back += 1) {
    const nowDiff = at(macdLines.dif, back) - at(macdLines.dea, back);
    const beforeDiff = at(macdLines.dif, back + 1) - at(macdLines.dea, back + 1);
    if (!Number.isFinite(nowDiff) || !Number.isFinite(beforeDiff)) break;
    if (beforeDiff <= 0 && nowDiff > 0) { cross = "金叉"; crossDays = back; break; }
    if (beforeDiff >= 0 && nowDiff < 0) { cross = "死叉"; crossDays = back; break; }
  }
  const rsi14 = at(rsi(closes, 14)), rsi6 = at(rsi(closes, 6));
  const bias5 = ma.ma5 ? round((last.close / ma.ma5 - 1) * 100) : null;
  const alignment = [ma.ma5, ma.ma10, ma.ma20, ma.ma60].some(value => value === null) ? (ma.ma5 !== null && ma.ma10 !== null && ma.ma20 !== null
    ? (ma.ma5 > ma.ma10 && ma.ma10 > ma.ma20 ? "短期多头排列" : ma.ma5 < ma.ma10 && ma.ma10 < ma.ma20 ? "短期空头排列" : "均线交织") : "")
    : ma.ma5 > ma.ma10 && ma.ma10 > ma.ma20 && ma.ma20 > ma.ma60 ? "多头排列" : ma.ma5 < ma.ma10 && ma.ma10 < ma.ma20 && ma.ma20 < ma.ma60 ? "空头排列" : "均线交织";
  const gaps = [];
  for (let index = Math.max(1, bars.length - 20); index < bars.length; index += 1) {
    const before = bars[index - 1], row = bars[index], after = bars.slice(index + 1);
    if (row.low > before.high && after.every(next => next.low > before.high)) gaps.push({ type: "向上缺口", date: row.date, top: round(row.low), bottom: round(before.high) });
    if (row.high < before.low && after.every(next => next.high < before.low)) gaps.push({ type: "向下缺口", date: row.date, top: round(before.low), bottom: round(row.high) });
  }
  const recentGaps = gaps.slice(-3);
  for (const gap of recentGaps) {
    if (gap.type === "向上缺口") candidates.push({ label: "向上缺口上沿", price: gap.top }, { label: "向上缺口下沿", price: gap.bottom });
    else candidates.push({ label: "向下缺口下沿", price: gap.bottom }, { label: "向下缺口上沿", price: gap.top });
  }
  const levelPool = unique(candidates);
  support.splice(0, support.length, ...unique(levelPool.filter(item => item.price < last.close).sort((a, b) => b.price - a.price)).slice(0, 3));
  resistance.splice(0, resistance.length, ...unique(levelPool.filter(item => item.price > last.close).sort((a, b) => a.price - b.price)).slice(0, 3));

  return {
    code: String(code), name: String(name || code).slice(0, 12), industry: String(industry || "").slice(0, 12),
    asOfDate: last.date, bars: bars.length,
    latest: round(last.close), changePct: pct(last.close, previous.close),
    turnover: round(last.turnover), amountYi: last.amount === null ? null : round(last.amount / 1e8),
    avgAmount20Yi: amounts20.length ? round(amounts20.reduce((sum, value) => sum + value, 0) / amounts20.length / 1e8) : null,
    volumeRatio,
    return5: pct(last.close, closeAgo(5)), return20: pct(last.close, closeAgo(20)), return60: pct(last.close, closeAgo(60)),
    ma: Object.fromEntries(Object.entries(ma).map(([key, value]) => [key, round(value)])), above,
    high20: round(high20), low20: round(low20), high60: round(high60), low60: round(low60),
    fromHigh20Pct: pct(last.close, high20), fromLow20Pct: pct(last.close, low20),
    limitUps20, broken20, consecutiveBoards: boards,
    lastLimitDate: lastLimitIndex >= 0 ? bars[lastLimitIndex].date : "",
    daysSinceLimit: lastLimitIndex >= 0 ? bars.length - 1 - lastLimitIndex : null,
    macd: { dif: round(dif, 3), dea: round(dea, 3), hist: round(hist, 3), histTrend: hist === null || histPrev === null ? "" : Math.abs(hist) > Math.abs(histPrev) ? "放大" : "缩小", cross, crossDays },
    rsi6: round(rsi6, 1), rsi14: round(rsi14, 1), bias5, alignment, gaps: recentGaps,
    support, resistance
  };
}

const DIRECTION_LABEL = { positive: "利好", negative: "利空", mixed: "多空交织", neutral: "中性" };
/**
 * 公告整理成 AI 用的消息面：只取数据日前 30 天内的，最多 5 条（风险高的优先，其次按时间新旧）。
 * 方向和风险等级沿用公告分类规则（关键词判断，不是 AI 判断）。
 */
function summarizeAnnouncements(list, asOfDate, days = 30) {
  const end = Date.parse(`${/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || "")) ? asOfDate : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)}T23:59:59+08:00`);
  const start = end - days * 86400000;
  const rows = [];
  for (const item of Array.isArray(list) ? list : []) {
    // 优先用带时分秒的 display_time；纯日期（YYYY-MM-DD）补成当天 0 点，否则 Date.parse 会得到 NaN、公告被漏掉。
    const raw = String(item?.display_time || item?.notice_date || "").trim().replace(" ", "T").slice(0, 19);
    const time = Date.parse(`${/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw}+08:00`);
    const title = String(item?.title || "").replace(/\s+/g, " ").trim();
    if (!title || !Number.isFinite(time) || time < start || time > end + 86400000) continue;
    const risk = Number.isInteger(item?.riskSeverity) ? Math.max(0, Math.min(3, item.riskSeverity)) : 0;
    rows.push({ date: new Date(time + 8 * 3600000).toISOString().slice(0, 10), title: [...title].length > 40 ? `${[...title].slice(0, 39).join("")}…` : title,
      direction: DIRECTION_LABEL[item?.direction] || "中性", risk, time });
  }
  return rows.sort((a, b) => b.risk - a.risk || b.time - a.time).slice(0, 5).map(({ time: _time, ...row }) => row);
}

/** 均线位置的一句话描述（给界面和 AI 都用）。 */
function trendText(profile) {
  if (!profile?.above) return "";
  const labels = { ma5: "5日", ma10: "10日", ma20: "20日", ma60: "60日" };
  const over = Object.entries(profile.above).filter(([, value]) => value === true).map(([key]) => labels[key]);
  const under = Object.entries(profile.above).filter(([, value]) => value === false).map(([key]) => labels[key]);
  if (!over.length && !under.length) return "";
  if (!under.length) return "站上全部均线";
  if (!over.length) return "跌破全部均线";
  return `站上${over.join("/")}线，${under.join("/")}线下方`;
}

module.exports = { buildStockProfile, trendText, cleanRows, summarizeAnnouncements };
