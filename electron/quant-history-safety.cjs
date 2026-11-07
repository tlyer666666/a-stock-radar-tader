"use strict";

const { priceLimitRate, isBseAshareCode } = require("./price-limit-rules.cjs");
const finite = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

// This detects an unresolved price basis, never infers a dividend or share split.
// Raw prices cannot be settled across this boundary without a verified action ledger.
function priceBasisIssueAt(rows, index, code = "", name = "") {
  if (index < 1 || index >= rows.length) return null;
  const row = rows[index], previous = rows[index - 1];
  const rawReturn = (Number(row.close) / Number(previous.close) - 1) * 100;
  if (!Number.isFinite(rawReturn)) return { date: row.date, source: "invalid_price_basis" };
  for (const key of ["changePct", "changePercent", "pctChange"]) {
    if (finite(row[key]) && Math.abs(Number(row[key]) - rawReturn) > .75) {
      return { date: row.date, source: key, reportedReturn: Number(row[key]), rawReturn };
    }
  }
  for (const key of ["preClose", "previousClose"]) {
    if (finite(row[key]) && Number(row[key]) > 0 && Math.abs(Number(row[key]) / previous.close - 1) > .002) {
      return { date: row.date, source: key, referenceClose: Number(row[key]), priorRawClose: previous.close };
    }
  }
  for (const key of ["adjustmentFactor", "adjFactor"]) {
    if (finite(row[key]) && finite(previous[key]) && Number(previous[key]) > 0 && Math.abs(Number(row[key]) / Number(previous[key]) - 1) > .002) {
      return { date: row.date, source: key };
    }
  }
  if (row.corporateActionUnresolved === true) return { date: row.date, source: "explicit_unresolved" };
  // A discontinuity beyond the regular board band is ambiguous when no reported
  // reference exists. Keep it unpriced; do not label the missing event a split.
  const band = priceLimitRate(code, name, row.date, row.isST) * 100;
  if (row.noPriceLimit !== true && !/^[NC]/i.test(name) && Math.abs(rawReturn) > band + .75) {
    return { date: row.date, source: "unexplained_price_discontinuity", rawReturn };
  }
  return null;
}

function intervalPriceBasisIssue(rows, start, end, code, name) {
  for (let i = Math.max(1, start); i <= Math.min(rows.length - 1, end); i++) {
    const issue = priceBasisIssueAt(rows, i, code, name);
    if (issue) return issue;
  }
  return null;
}

function boardOrderRule(code, defaultLot = 100) {
  if (/^68[89]\d{3}$/.test(code)) return { minimum: 200, step: 1 };
  if (isBseAshareCode(code)) return { minimum: 100, step: 1 };
  return { minimum: defaultLot, step: defaultLot };
}
module.exports = { priceBasisIssueAt, intervalPriceBasisIssue, boardOrderRule };
