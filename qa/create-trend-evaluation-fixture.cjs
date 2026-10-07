"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Fictional prices and weekday-only calendar: a software fixture, never market history. */
function createSyntheticTrendDataset(count = 310) {
  if (!Number.isInteger(count) || count < 270 || count > 10000) throw new TypeError("count must be 270..10000");
  const calendar = []; const day = new Date("2025-01-01T00:00:00Z");
  while (calendar.length < count) {
    if (![0, 6].includes(day.getUTCDay())) calendar.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  const rawRows = calendar.map((date, i) => {
    const close = Number((i < 270 ? 10 + i * .02 : 16.5 + (i - 270) * .04).toFixed(2));
    return { date, open: close, high: Number((close + .12).toFixed(2)), low: Number((close - .12).toFixed(2)), close,
      volume: 8000000, amount: 240000000, isST: false };
  });
  rawRows[263] = { ...rawRows[263], open: 15, close: 15, high: 15.2, low: 14.9 };
  rawRows[264] = { ...rawRows[264], open: 15.9, high: 16.5, low: 15.8, close: 16.5, volume: 10000000, amount: 300000000 };
  for (let i = 265; i <= 268; i++) rawRows[i] = { ...rawRows[i], open: 16, high: 16.3, low: 15.5, close: 16.1, volume: 5000000, amount: 220000000 };
  rawRows[269] = { ...rawRows[269], open: 16.2, high: 16.5, low: 16.1, close: 16.45, volume: 8000000, amount: 260000000 };
  for (let i = 1; i < rawRows.length; i++) {
    rawRows[i].upperLimit = Math.round(rawRows[i - 1].close * 110) / 100;
    rawRows[i].lowerLimit = Math.round(rawRows[i - 1].close * 90) / 100;
  }
  const benchmarkRows = calendar.map((date, i) => {
    const close = Number((100 + i * .05).toFixed(2));
    return { date, open: close, high: Number((close + .1).toFixed(2)), low: Number((close - .1).toFixed(2)), close, volume: 1, amount: 1 };
  });
  return { schemaVersion: 1, sourceClass: "synthetic", source: "Fictional software fixture; weekdays include exchange holidays; prices, names and limits are invented",
    universeMode: "selected", historicalStatusComplete: true, priceLimitEvidence: "synthetic",
    suggestedEvaluation: { from: calendar[269], splitDate: calendar[269], to: calendar.at(-1) }, calendar, benchmarkRows,
    securities: [{ security: { code: "600001", secid: "1.600001", name: "虚构合成样本（非真实证券）", assetType: "stock" },
      statusHistory: [{ date: calendar[0], name: "虚构合成样本（非真实证券）", isST: false, listed: true,
        minimumBuyQuantity: 100, quantityStep: 100 }], rawRows, adjustedRows: structuredClone(rawRows) }] };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--output" || !args[1]) throw new TypeError("Usage: node qa/create-trend-evaluation-fixture.cjs --output /path/synthetic.json");
    const output = path.resolve(args[1]); const dataset = createSyntheticTrendDataset();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(dataset, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ output, sourceClass: dataset.sourceClass, ...dataset.suggestedEvaluation })}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { createSyntheticTrendDataset };
