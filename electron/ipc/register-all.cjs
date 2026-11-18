"use strict";

const { createExternalFactorArchive } = require("./external-factors.cjs");
const { registerMarketIpc } = require("./market.ipc.cjs");
const { registerSectorIpc } = require("./sector.ipc.cjs");
const { registerStrategyIpc } = require("./strategy.ipc.cjs");
const { registerBacktestIpc } = require("./backtest.ipc.cjs");
const { registerAiIpc } = require("./ai.ipc.cjs");
const { registerNewsReviewIpc } = require("./news-review.ipc.cjs");
const { registerWorkspaceIpc } = require("./workspace.ipc.cjs");

function registerAllIpc(deps) {
  const externalFactors = createExternalFactorArchive({
    readJson: deps.readJson,
    writeJson: deps.writeJson
  });
  const shared = {
    ...deps,
    readExternalFactorStore: externalFactors.readStore,
    recordExternalFactorSnapshot: externalFactors.recordSnapshot,
    externalArchiveSummary: externalFactors.summary
  };
  registerMarketIpc(shared);
  registerSectorIpc(shared);
  registerStrategyIpc(shared);
  registerBacktestIpc(shared);
  registerAiIpc(shared);
  registerNewsReviewIpc(shared);
  registerWorkspaceIpc(shared);
}

module.exports = { registerAllIpc };
