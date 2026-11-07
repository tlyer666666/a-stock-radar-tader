"use strict";

function shanghaiDateTime(value = new Date()) {
  const date = new Date(value);
  return new Date(date.getTime() + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
}

// 休市日统一取 config/a-share-market-calendar.json（与交易日历同一份），不再另写一份年份清单：
// 次年日历按 docs/operations/market-calendar-update.md 更新后，这里自动生效。
let calendar = null;
function tradingDateStatus(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  if ([0, 6].includes(parsed.getUTCDay())) return false;
  calendar ||= require("./trend-trading-calendar.cjs").createTradingCalendar();
  return calendar.isSession(String(date).slice(0, 10)); // 日历覆盖范围外返回 null（视为可能交易）
}
module.exports = { shanghaiDateTime, tradingDateStatus };
