"use strict";

// Source/storage contract only. Listing age, warmup windows, missing sessions
// and price-basis evidence are evaluated by the strategy engines separately.
function validateDailyBarRows(rows, { label = "日线", priceOnly = false } = {}) {
  const invalid = () => Object.assign(new Error(`${label}日期、价格或成交额字段缺失/无效`), { code: "TREND_DATA_UNAVAILABLE" });
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !row || typeof row.date !== "string")) throw invalid();
  const sorted = [...rows].sort((left, right) => left.date.localeCompare(right.date));
  for (let index = 0; index < sorted.length; index++) {
    const row = sorted[index], time = Date.parse(`${row.date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== row.date ||
        (index > 0 && row.date === sorted[index - 1].date) ||
        ![row.open, row.high, row.low, row.close].every(value => typeof value === "number" && Number.isFinite(value) && value > 0) ||
        row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) ||
        [row.volume, row.amount].some(value => !(priceOnly && value == null) && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) throw invalid();
  }
  return sorted;
}

module.exports = { validateDailyBarRows };
