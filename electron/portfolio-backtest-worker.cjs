"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const {
  buildSelectedStrategyPortfolioReplay,
  buildSelectedStrategyReplay,
  STRATEGY_DEFINITIONS
} = require("./strategy-signal-engine.cjs");
const { simulateStrategyPortfolio } = require("./portfolio-backtest.cjs");

try {
  if (workerData?.task === "single-stock-replay") {
    const { strategyIds, security, history, benchmarkHistory, replayOptions } = workerData;
    const replay = buildSelectedStrategyReplay(strategyIds, security, history, benchmarkHistory, replayOptions);
    const definitions = new Map(STRATEGY_DEFINITIONS.map(item => [item.id, item]));
    const replaysById = {};
    if (strategyIds.length > 1) {
      for (const id of strategyIds) {
        replaysById[id] = buildSelectedStrategyReplay([id], security, history, benchmarkHistory, {
          ...replayOptions, strategyId: id, strategyName: String(definitions.get(id)?.name || id), minimumVotes: 1
        });
      }
    }
    parentPort.postMessage({ ok: true, value: { replay, replaysById } });
  } else {
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
  }
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
}
