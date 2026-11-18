"use strict";

function registerBacktestIpc({
  handleTrustedIpc,
  serviceRequestRuntime,
  prepareSingleBacktestRequest,
  readExternalFactorStore,
  settingsForService,
  runBacktest,
  runPortfolioBacktest
}) {
  handleTrustedIpc("backtest:run", (event, input, options = {}) => {
    const prepared = prepareSingleBacktestRequest(input, options, {
      settingsForService,
      readExternalFactorSnapshots: typeof readExternalFactorStore === "function"
        ? () => readExternalFactorStore().snapshots
        : undefined
    });
    return runBacktest(prepared.input, prepared.settings, prepared.options, serviceRequestRuntime(event, prepared.runtimeInput));
  });
  handleTrustedIpc("backtest:run-portfolio", (event, input = {}) =>
    runPortfolioBacktest(input, settingsForService(), serviceRequestRuntime(event, input))
  );
}

module.exports = { registerBacktestIpc };
