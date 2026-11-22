"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const {
  buildStrategySignalReport, buildStrategySelectionReport, buildStrategyLeaderboardChunk
} = require("./strategy-signal-engine.cjs");

try {
  // replay.leaderboard：回测中心「策略实测榜」的一批全市场回放；selectionOnly：只选股不回放。
  const build = workerData?.replay?.leaderboard === true ? buildStrategyLeaderboardChunk
    : workerData?.replay?.selectionOnly === true ? buildStrategySelectionReport : buildStrategySignalReport;
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
