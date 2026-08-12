"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const {
  buildSelectedStrategyPortfolioReplay
} = require("./strategy-signal-engine.cjs");
const { simulateStrategyPortfolio } = require("./portfolio-backtest.cjs");

try {
  const replay = buildSelectedStrategyPortfolioReplay(
    workerData?.strategyIds,
    workerData?.securities,
    workerData?.historiesByCode,
    workerData?.benchmarkHistory,
    workerData?.replayOptions
  );
  const portfolio = simulateStrategyPortfolio(
    replay.samples,
    workerData?.historiesByCode,
    workerData?.benchmarkHistory,
    workerData?.portfolioOptions
  );
  parentPort.postMessage({ ok: true, value: { replay, portfolio } });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
}
