'use strict';
const bundled = require('../config/a-share-market-calendar.json');
// Beyond the bundled exchange calendar, sessions may be inferred only from an
// observed index series. A stale series must not stand in for "today".
const MAX_INFERRED_STALENESS_DAYS = 10;
const EXPIRY_NOTICE_DAYS = 60;
function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}
function shanghaiClock(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('无效检查时间');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute), second: Number(p.second) };
}
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
function createTradingCalendar(data = bundled, { observedSessions = [] } = {}) {
  if (!data || !validDate(data.coveredFrom) || !validDate(data.coveredTo) || data.coveredFrom > data.coveredTo || !Array.isArray(data.closedRanges)) throw new TypeError('交易日历覆盖范围无效');
  const ranges = data.closedRanges.map(range => {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(validDate) || range[0] > range[1] || range[0] < data.coveredFrom || range[1] > data.coveredTo) throw new TypeError('交易日历休市日期无效');
    return [...range];
  });
  // Observed weekday sessions after the bundled range (CSI All Share bars).
  // Inside the bundled range the exchange calendar always wins.
  const observed = new Set((Array.isArray(observedSessions) ? observedSessions : [])
    .map(String).filter(date => validDate(date) && date > data.coveredTo && ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())));
  const observedTo = observed.size ? [...observed].sort().at(-1) : null;
  const effectiveTo = observedTo || data.coveredTo;
  const version = observedTo ? `${data.version}+observed-${observedTo}` : data.version;
  const covered = date => validDate(date) && date >= data.coveredFrom && date <= effectiveTo;
  const isSession = date => {
    if (!covered(date)) return null;
    if (date > data.coveredTo) return observed.has(date);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6 && !ranges.some(([from, to]) => date >= from && date <= to);
  };
  const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const search = (date, direction, inclusive = false) => {
    if (!covered(date)) return null;
    let current = inclusive ? date : shift(date, direction);
    while (covered(current)) {
      if (isSession(current)) return current;
      current = shift(current, direction);
    }
    return null;
  };
  const previousSession = (date, inclusive = false) => search(date, -1, inclusive);
  const nextSession = date => search(date, 1);
  const expectedCloseDate = (now = new Date()) => {
    const clock = shanghaiClock(now);
    const afterClose = clock.minute >= 15 * 60 + 10;
    if (clock.date >= data.coveredFrom && clock.date <= data.coveredTo) {
      const date = previousSession(clock.date, afterClose);
      return { date, state: date ? 'known' : 'unknown', inferred: false, calendarVersion: data.version,
        reason: date ? `按独立交易日历使用${date}完整收盘数据` : `交易日历未覆盖检查日期或此前交易日（${data.coveredFrom}至${data.coveredTo}），请更新日历` };
    }
    if (clock.date > data.coveredTo && observedTo) {
      const candidates = [...observed].filter(date => date < clock.date || (date === clock.date && afterClose)).sort();
      const date = candidates.at(-1) || previousSession(data.coveredTo, true);
      if (date && dayDiff(date, clock.date) <= MAX_INFERRED_STALENESS_DAYS) {
        return { date, state: 'known', inferred: true, calendarVersion: version,
          reason: `内置交易日历覆盖至${data.coveredTo}，按中证全指实际交易日推断${date}为最近完整交易日；请更新交易日历` };
      }
    }
    return { date: null, state: 'unknown', inferred: false, calendarVersion: data.version,
      reason: `交易日历未覆盖检查日期或此前交易日（${data.coveredFrom}至${data.coveredTo}），且没有足够新的指数交易日可推断，请更新日历` };
  };
  const tradingSessionsBetween = (from, to) => {
    if (!covered(from) || !covered(to) || from > to) return null;
    let count = 0;
    for (let date = from; date <= to; date = shift(date, 1)) count += Number(isSession(date));
    return count;
  };
  const sessionsThrough = (date, count) => {
    if (!covered(date) || !Number.isSafeInteger(count) || count < 1 || count > 1500) return null;
    const dates=[];
    for (let current=previousSession(date,true); current && dates.length<count; current=previousSession(current)) dates.push(current);
    return dates.length===count?dates.reverse():null;
  };
  const executionWindow = (signalDate, now = new Date()) => {
    const clock = shanghaiClock(now), expectedSignalDate = previousSession(clock.date);
    const executionDate = isSession(signalDate) === true ? nextSession(signalDate) : null;
    let state = 'unknown', reason = '信号日期或执行日期未获交易日历确认';
    if (executionDate && covered(clock.date)) {
      if (clock.date > executionDate || (clock.date === executionDate && clock.minute >= 9 * 60 + 35)) { state = 'expired'; reason = '已超过信号次一交易日09:25–09:35开盘复核窗口'; }
      else if (clock.date < executionDate || clock.minute < 9 * 60 + 25) { state = 'blocked'; reason = `仅限${executionDate} 09:25–09:35开盘窗口复核`; }
      else { state = 'ready'; reason = '处于信号次一交易日开盘复核窗口'; }
    }
    return { state, reason, executionDate, expectedSignalDate, validUntil: executionDate ? `${executionDate}T09:35:00+08:00` : null };
  };
  /** Short user-facing notice while the bundled calendar is near or past expiry; empty otherwise. */
  const coverageNotice = (now = new Date()) => {
    const today = shanghaiClock(now).date, remaining = dayDiff(today, data.coveredTo);
    if (remaining < 0) return `内置交易日历已于${data.coveredTo}到期，当前按中证全指实际交易日推断完整交易日；请更新 config/a-share-market-calendar.json。`;
    if (remaining <= EXPIRY_NOTICE_DAYS) return `内置交易日历覆盖至${data.coveredTo}（剩余${remaining}天），到期后自动按指数实际交易日推断；交易所公布次年休市安排后请更新。`;
    return '';
  };
  const withObservedSessions = dates => createTradingCalendar(data, { observedSessions: [...observed, ...(Array.isArray(dates) ? dates : [])] });
  return { isSession, previousSession, nextSession, expectedCloseDate, executionWindow, tradingSessionsBetween, sessionsThrough, coverageNotice, withObservedSessions,
    version, coveredFrom: data.coveredFrom, coveredTo: effectiveTo, bundledCoveredTo: data.coveredTo };
}
module.exports = { createTradingCalendar, shanghaiClock, validDate };
