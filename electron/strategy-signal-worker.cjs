"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const {
  buildStrategySignalReport, buildStrategySelectionReport
} = require("./strategy-signal-engine.cjs");

try {
  const build = workerData?.replay?.selectionOnly === true ? buildStrategySelectionReport : buildStrategySignalReport;
  const value = build(
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
