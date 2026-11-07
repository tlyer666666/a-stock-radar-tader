"use strict";

// Service daily bars use lots (100 shares) and yuan. Untagged historical callers
// retain the same legacy lot contract; explicitly tagged share bars are accepted.
function anchoredVwap(rows) {
  let shares = 0, amount = 0;
  for (const row of rows || []) {
    if (row.volume === null || row.volume === undefined || row.amount === null || row.amount === undefined || row.volume === "" || row.amount === "") return null;
    const volume = Number(row.volume), cash = Number(row.amount);
    if (!Number.isFinite(volume) || volume < 0 || !Number.isFinite(cash) || cash < 0) return null;
    if (row.volumeUnit && !["lots", "shares"].includes(row.volumeUnit)) return null;
    shares += volume * (row.volumeUnit === "shares" ? 1 : 100);
    amount += cash;
  }
  return shares > 0 && amount > 0 ? amount / shares : null;
}
module.exports = { anchoredVwap };
