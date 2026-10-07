'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { buildHistoricalStrategyStats } = require('./strategy-intelligence.cjs');

try {
  const value = buildHistoricalStrategyStats(
    workerData?.history, workerData?.code, workerData?.name,
    workerData?.selectedIds, workerData?.benchmarkHistory, workerData?.options
  );
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
