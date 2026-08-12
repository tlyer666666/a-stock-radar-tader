"use strict";

const assert = require("node:assert/strict");
const { scanStrategySignals } = require("../electron/services.cjs");

async function main() {
  const report = await scanStrategySignals({
    maxUniverse: 40,
    maxStocksPerStrategy: 40,
    historyBars: 420,
    strategyIds: []
  });
  const auditedStrategies = Array.isArray(report.auditedStrategies)
    ? report.auditedStrategies
    : [];
  const publishedStrategies = Array.isArray(report.strategies)
    ? report.strategies
    : [];
  assert.ok(Number.isFinite(Date.parse(report.generatedAt)), "report timestamp must be valid");
  assert.ok(typeof report.source === "string" && report.source.length > 0);
  assert.ok(Number.isInteger(report.processed) && report.processed > 0);
  assert.ok(Number.isInteger(report.failed) && report.failed >= 0);
  assert.ok(auditedStrategies.length > 0, "the full strategy library must be audited");
  assert.equal(report.strategiesTested, auditedStrategies.length);
  assert.equal(report.publishedStrategyCount, publishedStrategies.length);
  assert.ok(auditedStrategies.every((strategy) =>
    strategy?.id && strategy?.name && strategy?.validation && Array.isArray(strategy.stocks)
  ));
  assert.ok(publishedStrategies.every((strategy) =>
    strategy.publicationAccepted === true ||
    strategy.validation?.publicationAccepted === true ||
    strategy.validation?.accepted === true
  ), "only strategies that pass publication checks may expose current stocks");
  const summary = {
    source: report.source,
    universeSize: report.universeSize,
    availableUniverseSize: report.availableUniverseSize,
    processed: report.processed,
    failed: report.failed,
    qualifiedCount: report.qualifiedCount,
    warning: report.warning,
    strategies: report.strategies.map((item) => ({
      id: item.id,
      accepted: item.validation.accepted,
      samples: item.validation.sampleCount,
      stocks: item.stocks.length
    }))
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
