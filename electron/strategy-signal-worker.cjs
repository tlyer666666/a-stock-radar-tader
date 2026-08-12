"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const {
  buildStrategySignalReport
} = require("./strategy-signal-engine.cjs");

try {
  const value = buildStrategySignalReport(
    workerData?.candidates,
    workerData?.historiesByCode,
    workerData?.benchmarkRows,
    workerData?.replay
  );
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
}
