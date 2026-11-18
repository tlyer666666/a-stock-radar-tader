"use strict";

function registerStrategyIpc({
  handleTrustedIpc,
  serviceRequestId,
  serviceRequestRuntime,
  settingsForService,
  customStrategiesForScan,
  readJson,
  normalizeWatchlist,
  normalizeHoldings,
  usableWatchlist,
  usableHoldings,
  scanStrategySignals,
  cancelServiceJob,
  getStrategyDefinitions,
  customStrategyStore,
  externalArchiveSummary,
  evaluateTrendResearch,
  checkTrendExecution,
  trendScreener,
  setTrendScanOwner
}) {
  handleTrustedIpc("strategy:scan", (event, options = {}) => {
    const safeOptions = options && typeof options === "object" && !Array.isArray(options) ? options : {};
    const runtime = serviceRequestRuntime(event, safeOptions);
    const settings = settingsForService();
    const customStrategies = customStrategiesForScan();
    const watchlistSecurities = customStrategies.some(item => item.universe === "watchlist")
      ? [...normalizeWatchlist(readJson("watchlist", [], usableWatchlist)), ...normalizeHoldings(readJson("holdings", [], usableHoldings))]
        .map(({ code, name, secid }) => ({ code, name, secid }))
      : [];
    return scanStrategySignals({
      ...safeOptions,
      customStrategies,
      watchlistSecurities,
      provider: settings.provider,
      fallbackEnabled: settings.fallbackEnabled,
      multiSourceEnabled: settings.multiSourceEnabled
    }, runtime);
  });
  handleTrustedIpc("service:cancel", (event, requestId) =>
    cancelServiceJob(serviceRequestRuntime(event, { requestId: serviceRequestId(requestId, true) }))
  );
  handleTrustedIpc("strategy:definitions", () => getStrategyDefinitions());
  handleTrustedIpc("strategy:external-archive", () => externalArchiveSummary());
  handleTrustedIpc("strategy:custom:list", () => customStrategyStore.list());
  handleTrustedIpc("strategy:custom:save", (_, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new TypeError("策略保存参数无效"), { code: "INVALID_IPC_PAYLOAD" });
    }
    return customStrategyStore.save(input);
  });
  handleTrustedIpc("strategy:custom:delete", (_, id) => {
    if (typeof id !== "string" || !id) throw Object.assign(new TypeError("策略编号无效"), { code: "INVALID_IPC_PAYLOAD" });
    return customStrategyStore.remove(id);
  });
  handleTrustedIpc("strategy:custom:import-settings", () => customStrategyStore.importLegacy());
  handleTrustedIpc("trend-screener:research", (event, input = {}) => {
    const safe = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return evaluateTrendResearch(safe, serviceRequestRuntime(event, safe));
  });
  handleTrustedIpc("trend-screener:execution-check", (event, input = {}) => {
    const safe = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return checkTrendExecution(safe, settingsForService(), serviceRequestRuntime(event, safe));
  });
  handleTrustedIpc("trend-screener:start", (event, options = {}) => {
    serviceRequestRuntime(event);
    const status = trendScreener.start(options);
    setTrendScanOwner({ sender: event.sender, jobId: status.jobId });
    return status;
  });
  handleTrustedIpc("trend-screener:status", (_, cursor) => trendScreener.getStatus(cursor));
  handleTrustedIpc("trend-screener:cancel", () => {
    setTrendScanOwner(undefined);
    return trendScreener.cancel();
  });
}

module.exports = { registerStrategyIpc };
