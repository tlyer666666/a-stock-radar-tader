"use strict";

const assert = require("node:assert/strict");
const { runBacktest } = require("../electron/services.cjs");

async function main() {
  const startDate = "2025-01-01";
  const result = await runBacktest(
    { code: "600410", name: "华胜天成", assetType: "stock" },
    {
      provider: "eastmoney",
      fallbackEnabled: true,
      commissionBps: 7,
      slippageBps: 2
    },
    {
      startDate,
      customEntryPrice: 26,
      lookbackBars: 120,
      minSamples: 8,
      benchmark: "all",
      signalStrategyIds: ["trend_first_board", "low_first_board"],
      strategyContext: {
        strategyEngine: "verified-signal-v2",
        strategyId: "custom_strategy_vote",
        strategyName: "多策略组合（2套）",
        strategyIds: ["trend_first_board", "low_first_board"],
        minimumVotes: 1
      }
    }
  );
  assert.equal(result?.backtestMode, "verified_signal_strategy");
  assert.equal(result?.strategyEngine, "verified-signal-v2");
  assert.equal(result?.security?.code, "600410");
  assert.deepEqual(result?.strategyIds, ["trend_first_board", "low_first_board"]);
  assert.equal(result?.strategyContext?.strategyId, "custom_strategy_vote");
  assert.equal(result?.strategyContext?.minimumVotes, 1);
  assert.ok(result?.lookbackBars > 120);
  assert.equal(result?.range?.requestedFrom, startDate);
  assert.equal(result?.range?.signalFrom, startDate);
  assert.ok(Number.isInteger(result?.metrics?.replayableSignals));
  assert.ok(result.metrics.replayableSignals >= 0);
  assert.equal(typeof result?.metrics?.accepted, "boolean");
  assert.ok(Array.isArray(result?.rawStats?.samples));
  assert.ok(Array.isArray(result?.trades));
  assert.ok(result.trades.length > 0);
  assert.ok(result.profitSummary.tradeCount > 0);
  assert.equal(result.strategyBreakdown.length, 2);
  assert.ok(result.trades.every((trade) => trade.entryPrice === 26));
  assert.ok(result.trades.every((trade) => trade.entryPriceSource === "custom_limit_price"));
  assert.equal(typeof result?.profitSummary?.totalNetReturnPercent, "number");
  assert.ok(result.trades.every((trade) => trade.signalDate >= startDate));
  assert.ok(Array.isArray(result?.historicalSamplePath?.points));
  process.stdout.write(`${JSON.stringify({
    mode: result.backtestMode,
    engine: result.strategyEngine,
    code: result.security?.code,
    name: result.security?.name,
    strategy: result.strategyContext?.strategyName,
    strategies: result.strategyIds,
    customEntryPrice: result.customEntryPrice,
    bars: result.lookbackBars,
    range: result.range,
    samples: result.metrics?.replayableSignals,
    trades: result.profitSummary?.tradeCount,
    totalNetReturnPercent: result.profitSummary?.totalNetReturnPercent,
    accepted: result.metrics?.accepted
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
