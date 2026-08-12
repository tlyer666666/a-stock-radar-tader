"use strict";

const assert = require("node:assert/strict");
const { scanStrategySignals } = require("../electron/services.cjs");

function finite(value) {
  return Number.isFinite(Number(value));
}

function ratio(value) {
  if (!finite(value)) return null;
  const number = Number(value);
  return number <= 1 ? Number((number * 100).toFixed(2)) : Number(number.toFixed(2));
}

async function main() {
  const maxUniverse = Math.max(
    40,
    Math.min(300, Math.round(Number(process.argv[2]) || 300))
  );
  const historyBars = 720;
  const report = await scanStrategySignals({
    maxUniverse,
    maxStocksPerStrategy: maxUniverse,
    historyBars,
    minSamples: 120,
    minOutOfSampleSamples: 36,
    minIndependentSignalDays: 60,
    minWalkForwardFoldSamples: 10,
    walkForwardFolds: 4,
    refresh: true,
    strategyIds: []
  });

  const summary = {
    generatedAt: report.generatedAt,
    source: report.source,
    sourceClass: report.sourceClass,
    universeDefinition:
      report.universeDefinition ||
      report.coverage?.universeDefinition ||
      "最近交易日非ST涨停候选（详见报告警告）",
    selectionBiasWarning:
      report.selectionBiasWarning ||
      report.coverage?.selectionBiasWarning ||
      null,
    sampleDiversity: report.sampleDiversity || null,
    universe: {
      available: report.availableUniverseSize,
      requested: maxUniverse,
      processed: report.processed,
      failed: report.failed,
      historyBarsRequested: report.historyBarsRequested,
      benchmarkBars: report.benchmarkBars,
      actualRange:
        report.actualHistoryRange ||
        report.dataRange ||
        report.coverage?.actualHistoryRange ||
        null
    },
    methodology: report.methodologyDetails || report.methodology,
    warning: report.warning,
    qualifiedCount: report.qualifiedCount,
    strategiesTested: report.strategiesTested,
    publishedStrategyCount: report.publishedStrategyCount,
    strategies: (
      Array.isArray(report.auditedStrategies) && report.auditedStrategies.length
        ? report.auditedStrategies
        : Array.isArray(report.strategies)
          ? report.strategies
          : []
    ).map(
      (item) => {
        const validation = item.validation || {};
        const outOfSample = validation.outOfSample || {};
        const walkForward = validation.walkForward || {};
        const accepted =
          typeof item.publicationAccepted === "boolean"
            ? item.publicationAccepted === true
            : typeof validation.publicationAccepted === "boolean"
              ? validation.publicationAccepted === true
              : validation.accepted === true;
        return {
          id: item.id,
          name: item.name,
          type: item.type || "base",
          components: Array.isArray(item.components) ? item.components : [],
          voteRule: item.voteRule || null,
          accepted,
          engineAccepted: validation.accepted === true,
          status: validation.status || null,
          confidence: validation.confidence || null,
          totalSamples: validation.sampleCount ?? null,
          totalRange: validation.range || null,
          outOfSample: {
            samples:
              validation.outOfSampleCount ??
              outOfSample.sampleCount ??
              null,
            range: outOfSample.range || null,
            winRatePercent:
              validation.winRate5 ??
              outOfSample.winRate ??
              null,
            averageReturnPercent:
              validation.average5 ??
              outOfSample.averageReturn ??
              null,
            excessReturnPercent:
              validation.excess5 ??
              outOfSample.averageExcessReturn ??
              null,
            maxDrawdownPercent:
              validation.worstMdd5 ??
              outOfSample.maxDrawdown ??
              null
          },
          walkForward: {
            available: walkForward.available === true,
            folds: Array.isArray(walkForward.folds)
              ? walkForward.folds.length
              : null,
            passedFolds: walkForward.passedFolds ?? null,
            passRatePercent: ratio(
              validation.walkForwardPassRate ?? walkForward.passRate
            ),
            overfitRisk: walkForward.overfitRisk || null
          },
          roundTripCostBps: validation.roundTripCostBps ?? null,
          rejectedBecause:
            accepted
              ? null
              : validation.publicationFailureReasons ||
                validation.reasons ||
                validation.reason ||
                null,
          currentSignalCount:
            accepted && Array.isArray(item.stocks)
              ? item.stocks.length
              : 0,
          currentSignalCodes:
            accepted && Array.isArray(item.stocks)
              ? item.stocks.map((stock) => stock.code)
              : []
        };
      }
    )
  };

  assert.ok(Number.isFinite(Date.parse(summary.generatedAt)), "report timestamp must be valid");
  assert.ok(typeof summary.source === "string" && summary.source.length > 0);
  assert.ok(summary.universe.processed > 0, "at least one real security history must be processed");
  assert.equal(summary.universe.historyBarsRequested, historyBars);
  assert.ok(summary.strategies.length > 0, "the audited strategy library must not be empty");
  assert.equal(summary.strategies.length, report.strategiesTested);
  for (const strategy of summary.strategies) {
    assert.ok(strategy.id && strategy.name, "each audited strategy needs an identity");
    assert.ok(Number.isInteger(strategy.totalSamples) && strategy.totalSamples >= 0);
    assert.ok(["PASS", "REVIEW", "INSUFFICIENT", null].includes(strategy.status));
    if (!strategy.accepted) {
      assert.ok(strategy.rejectedBecause, `${strategy.id} must explain why it was not published`);
      assert.equal(strategy.currentSignalCount, 0);
      continue;
    }
    assert.ok((strategy.outOfSample.samples || 0) >= 36);
    assert.equal(strategy.walkForward.available, true);
    assert.ok((strategy.walkForward.passRatePercent || 0) >= 66.67);
    assert.ok((strategy.outOfSample.averageReturnPercent || 0) > 0);
    assert.ok((strategy.outOfSample.excessReturnPercent || 0) > 0);
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  const cause = error?.cause
    ? `\nCAUSE: ${error.cause?.stack || error.cause}`
    : "";
  process.stderr.write(`${error?.stack || error}${cause}\n`);
  process.exitCode = 1;
});
