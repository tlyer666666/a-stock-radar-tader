"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const {
  buildSelectedStrategyPortfolioReplay,
  buildSelectedStrategyReplayBundle
} = require("./strategy-signal-engine.cjs");
const { simulateStrategyPortfolio } = require("./portfolio-backtest.cjs");

try {
  if (workerData?.task === "single-stock-replay") {
    const { strategyIds, security, history, benchmarkHistory, replayOptions } = workerData;
    const result = buildSelectedStrategyReplayBundle(strategyIds, security, history, benchmarkHistory, replayOptions);
    parentPort.postMessage({ ok: true, value: result });
  } else {
    const replay = buildSelectedStrategyPortfolioReplay(
      workerData?.strategyIds,
      workerData?.securities,
      workerData?.historiesByCode,
      workerData?.benchmarkHistory,
      { ...workerData?.replayOptions,
        signalFrom: workerData?.portfolioOptions?.rangeFrom || workerData?.replayOptions?.signalFrom,
        signalTo: workerData?.portfolioOptions?.rangeTo || workerData?.replayOptions?.signalTo }
    );
    const portfolio = simulateStrategyPortfolio(
      [...replay.samples, ...replay.pendingSignals.filter(signal => signal.entryDate)],
      workerData?.historiesByCode,
      workerData?.benchmarkHistory,
      workerData?.portfolioOptions
    );
    parentPort.postMessage({ ok: true, value: { replay, portfolio } });
  }
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
}
