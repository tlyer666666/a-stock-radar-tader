const { contextBridge, ipcRenderer } = require("electron");

const getLimitUpPoolSnapshot = (options = {}) =>
  ipcRenderer.invoke("market:limit-ups", options);

contextBridge.exposeInMainWorld("stockApi", {
  search: (query) => ipcRenderer.invoke("market:search", query),
  analyze: (security, options = {}) => ipcRenderer.invoke("market:analyze", security, options),
  getQuoteSnapshot: (security) => ipcRenderer.invoke("market:quote", security),
  getDataFederation: (security) => ipcRenderer.invoke("market:federation", security),
  getChart: (security, interval, options) =>
    ipcRenderer.invoke("market:chart", security, interval, options),
  discoverLimitUps: getLimitUpPoolSnapshot,
  getLimitUpPoolSnapshot,
  discoverRecentLimitUps: (days = 10, options = {}) =>
    ipcRenderer.invoke("market:recent-limit-ups", days, options),
  scanStrategySignals: (options = {}) => ipcRenderer.invoke("strategy:scan", options),
  getStrategyDefinitions: () => ipcRenderer.invoke("strategy:definitions"),
  getLimitUpSectorBoard: (options = {}) => ipcRenderer.invoke("market:limit-up-sectors", options),
  searchSectors: (query) => ipcRenderer.invoke("market:search-sectors", query),
  getConceptChain: (query) => ipcRenderer.invoke("market:concept-chain", query),
  analyzeSector: (sector) => ipcRenderer.invoke("market:analyze-sector", sector),
  getProfessionalReview: (options = {}) => ipcRenderer.invoke("review:get-market", options),
  getNewsFeed: (input) => ipcRenderer.invoke("news:get-feed", input),
  refreshNewsFeed: (input) => ipcRenderer.invoke("news:refresh", input),
  runBacktest: (security, options = {}) =>
    ipcRenderer.invoke("backtest:run", security, options),
  runPortfolioBacktest: (input = {}) =>
    ipcRenderer.invoke("backtest:run-portfolio", input),
  getWatchlist: () => ipcRenderer.invoke("watchlist:get"),
  saveWatchlist: (items) => ipcRenderer.invoke("watchlist:save", items),
  getHoldings: () => ipcRenderer.invoke("holdings:get"),
  saveHoldings: (items) => ipcRenderer.invoke("holdings:save", items),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testProvider: (settings) => ipcRenderer.invoke("settings:test-provider", settings),
  setTheme: (theme) => ipcRenderer.invoke("app:set-theme", theme),
  controlWindow: (action) => ipcRenderer.invoke("app:window-control", action),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  getPlatform: () => process.platform,
  getVersion: () => ipcRenderer.invoke("app:version")
});
