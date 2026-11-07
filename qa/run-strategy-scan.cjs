"use strict";
const assert = require("node:assert/strict");
const { scanStrategySignals, shutdownServiceResources } = require("../electron/services.cjs");
async function main() {
  try {
    const report = await scanStrategySignals({ maxUniverse: Math.max(40, Math.min(300, Number(process.argv[2]) || 300)), strategyIds: [] });
    assert.equal(report.mode, "selection");
    assert.ok(report.processed > 0);
    assert.equal(report.strategies.length, require("../electron/strategy-signal-engine.cjs").STRATEGY_DEFINITIONS.length);
    assert.ok(report.strategies.every(group => Array.isArray(group.stocks) && !("validation" in group)));
    process.stdout.write(`${JSON.stringify({ generatedAt: report.generatedAt, asOfDate: report.asOfDate, universeCoverage: report.universeCoverage, dataQuality: report.dataQuality, source: report.source,
      stocks: report.strategies.map(group => ({ strategy: group.name, stocks: group.stocks })) }, null, 2)}\n`);
  } finally { await shutdownServiceResources(); }
}
main().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
