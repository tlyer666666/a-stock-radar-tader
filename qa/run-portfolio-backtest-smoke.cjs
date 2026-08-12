"use strict";

const assert = require("node:assert/strict");
const { runPortfolioBacktest } = require("../electron/services.cjs");

async function main() {
  const result = await runPortfolioBacktest(
    {
      securities: [
        { code: "600519", name: "贵州茅台", secid: "1.600519", thscode: "600519.SH", assetType: "stock" }
      ],
      strategyIds: ["low_first_board"],
      minimumVotes: 1,
      startingCapital: 200000,
      maxPositions: 1,
      maxPositionPercent: 28,
      lookbackBars: 120,
      commissionBps: 7,
      slippageBps: 2,
      lotSize: 100,
      benchmark: "000985"
    },
    {
      provider: "eastmoney",
      fallbackEnabled: true,
      maxPositionPercent: 28,
      commissionBps: 7,
      slippageBps: 2
    }
  );
  assert.equal(result?.backtestMode, "verified_strategy_portfolio");
  assert.equal(result?.strategyEngine, "verified-signal-v2");
  assert.equal(result?.status, "DIAGNOSTIC");
  assert.equal(result?.validation?.accepted, false);
  assert.equal(result?.lookbackBars, 120);
  assert.equal(result?.universe?.requestedCount, 1);
  assert.equal(result?.universe?.usedCount, 1);
  assert.deepEqual(result?.strategyIds, ["low_first_board"]);
  assert.ok(Array.isArray(result?.equityCurve) && result.equityCurve.length === 120);
  assert.ok(Array.isArray(result?.contributions) && result.contributions.length === 1);
  assert.ok(Array.isArray(result?.signalEvents));
  assert.ok(Array.isArray(result?.signalTimeline));
  assert.ok(Number.isFinite(result?.metrics?.endingCapital));
  assert.match(result?.methodology?.summary || "", /共享现金/);
  console.log(JSON.stringify({
    mode: result.backtestMode,
    status: result.status,
    strategy: result.strategyContext?.strategyName,
    requestedStocks: result.universe?.requestedCount,
    usedStocks: result.universe?.usedCount,
    benchmarkBars: result.dataQuality?.benchmarkBars,
    historyBars: [result.dataQuality?.minimumStockBars, result.dataQuality?.maximumStockBars],
    signals: result.metrics?.replayableSignals,
    trades: result.metrics?.tradeCount,
    totalReturnPercent: result.metrics?.totalReturnPercent,
    maxDrawdownPercent: result.metrics?.maxDrawdownPercent,
    equityPoints: result.equityCurve?.length,
    signalTimelineRows: result.signalTimeline?.length,
    firstSignalDate: result.signalTimeline?.[0]?.signalDate,
    diagnosticReason: result.validation?.reason
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
