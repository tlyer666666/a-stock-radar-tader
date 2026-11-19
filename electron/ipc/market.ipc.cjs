"use strict";

function registerMarketIpc({
  handleTrustedIpc,
  serviceRequestRuntime,
  settingsForService,
  readExternalFactorStore,
  searchSecurities,
  analyzeSecurity,
  getQuoteSnapshot,
  getMarketSourceHealth,
  resetMarketSourceHealth = () => ({ ok: true }),
  getConvertibleBonds,
  getFuyaoReviewData,
  getDataFederation,
  getChart,
  discoverLimitUps,
  discoverRecentLimitUps,
  getPreviousLimitUpFailedBoardSnapshot,
  thsWebView
}) {
  handleTrustedIpc("market:search", (_, query) => searchSecurities(query));
  handleTrustedIpc("market:analyze", (_, security, options = {}) =>
    analyzeSecurity(security, {
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true,
      externalFactorSnapshots: readExternalFactorStore().snapshots
    })
  );
  handleTrustedIpc("market:quote", (_, security) =>
    getQuoteSnapshot(security, settingsForService())
  );
  handleTrustedIpc("market:source-health", () => getMarketSourceHealth());
  handleTrustedIpc("market:source-reset", () => resetMarketSourceHealth());
  handleTrustedIpc("bond:list", (_, options = {}) => getConvertibleBonds(options));
  // 沪深港通：同花顺数据中心网页嵌入（独立会话，用户自行登录同花顺账号）。
  handleTrustedIpc("ths-web:show", (_, options = {}) =>
    thsWebView().show({
      bounds: options?.bounds,
      page: options?.page === "login" ? "login" : options?.page === "hsgt" ? "hsgt" : undefined
    })
  );
  handleTrustedIpc("ths-web:bounds", (_, options = {}) => thsWebView().setBounds({ bounds: options?.bounds }));
  handleTrustedIpc("ths-web:hide", () => thsWebView().hide());
  handleTrustedIpc("ths-web:command", (_, options = {}) => thsWebView().command({ action: typeof options?.action === "string" ? options.action : "" }));
  handleTrustedIpc("ths-web:state", () => thsWebView().state());
  handleTrustedIpc("market:limit-ecology", (_, options = {}) => getFuyaoReviewData({ forceRefresh: options?.forceRefresh === true }));
  handleTrustedIpc("market:federation", (_, security) =>
    getDataFederation(security, settingsForService())
  );
  handleTrustedIpc("market:chart", (event, security, interval, options = {}) =>
    getChart(security, interval, options, serviceRequestRuntime(event, options))
  );
  handleTrustedIpc("market:limit-ups", async (_, options = {}) => {
    return discoverLimitUps({
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true
    });
  });
  handleTrustedIpc("market:recent-limit-ups", (_, days, options = {}) =>
    discoverRecentLimitUps(days, {
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true
    })
  );
  handleTrustedIpc("market:previous-limit-up-failed-boards", (_, options = {}) =>
    getPreviousLimitUpFailedBoardSnapshot({
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true,
      refreshDate: typeof options?.refreshDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.refreshDate)
        ? options.refreshDate
        : undefined
    })
  );
}

module.exports = { registerMarketIpc };
