const { contextBridge, ipcRenderer } = require("electron");

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result?.ok === true) return result.value;
  const { code = "IPC_FAILED", message = "应用通信失败，请重试", retryable = false } = result?.error || {};
  // The code also travels in the message because contextBridge may discard
  // custom Error properties when crossing into the page's JavaScript world.
  throw Object.assign(new Error(`[${code}] ${message}${retryable ? "（可重试）" : ""}`), { code, retryable });
}

const getLimitUpPoolSnapshot = (options = {}) =>
  invoke("market:limit-ups", options);
const getRuntimeInfo = () => ({
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    undici: process.versions.undici
  },
  platform: process.platform,
  arch: process.arch
});

contextBridge.exposeInMainWorld("stockApi", {
  search: (query) => invoke("market:search", query),
  analyze: (security, options = {}) => invoke("market:analyze", security, options),
  getQuoteSnapshot: (security) => invoke("market:quote", security),
  getDataFederation: (security) => invoke("market:federation", security),
  getMarketSourceHealth: () => invoke("market:source-health"),
  getConvertibleBonds: (options = {}) => invoke("bond:list", options),
  getLimitEcology: (options = {}) => invoke("market:limit-ecology", options),
  ai: {
    status: () => invoke("ai:status"),
    rank: (input = {}) => invoke("ai:rank", input),
    summary: (input = {}) => invoke("ai:summary", input),
    cached: (input = {}) => invoke("ai:cached", input),
    draftStrategy: (input = {}) => invoke("ai:strategy-draft", input),
    parseNote: (input = {}) => invoke("ai:note-parse", input),
    test: (input = {}) => invoke("ai:test", input),
    profiles: () => invoke("ai:profiles"),
    saveProfile: (input = {}) => invoke("ai:profile-save", input),
    deleteProfile: (id) => invoke("ai:profile-delete", id),
    activateProfile: (id) => invoke("ai:profile-activate", id),
    setRankModels: (ids) => invoke("ai:rank-models", ids),
    history: () => invoke("ai:history"),
    historyDay: (asOfDate) => invoke("ai:history-day", asOfDate),
    review: (input = {}) => invoke("ai:review", input),
    cachedReview: (code) => invoke("ai:review-cached", code),
    customList: () => invoke("ai:custom-list"),
    saveCustomList: (items) => invoke("ai:custom-save", items),
    rankCustom: (input = {}) => invoke("ai:custom-rank", input),
    cachedCustom: () => invoke("ai:custom-cached"),
    frameworks: () => invoke("ai:frameworks"),
    saveFramework: (input = {}) => invoke("ai:framework-save", input),
    marketReview: (input = {}) => invoke("ai:market-review", input),
    lookback: (input = {}) => invoke("ai:lookback", input),
    cachedMarketReview: (asOfDate) => invoke("ai:market-review-cached", asOfDate),
    interpret: (input = {}) => invoke("ai:interpret", input),
    cachedInterpret: (input = {}) => invoke("ai:interpret-cached", input),
    agent: {
      state: () => invoke("agent:state"),
      conversation: (id) => invoke("agent:conversation", id),
      start: (input = {}) => invoke("agent:start", input),
      poll: (runId) => invoke("agent:poll", runId),
      cancel: (runId) => invoke("agent:cancel", runId),
      remove: (id) => invoke("agent:delete", id),
      settings: (input = {}) => invoke("agent:settings", input),
      saveSkill: (input = {}) => invoke("agent:skill-save", input),
      removeSkill: (id) => invoke("agent:skill-delete", id)
    }
  },
  thsWeb: {
    show: (options = {}) => invoke("ths-web:show", options),
    setBounds: (options = {}) => invoke("ths-web:bounds", options),
    hide: () => invoke("ths-web:hide"),
    command: (options = {}) => invoke("ths-web:command", options),
    state: () => invoke("ths-web:state")
  },
  getChart: (security, interval, options) =>
    invoke("market:chart", security, interval, options),
  discoverLimitUps: getLimitUpPoolSnapshot,
  getLimitUpPoolSnapshot,
  discoverRecentLimitUps: (days = 10, options = {}) =>
    invoke("market:recent-limit-ups", days, options),
  getPreviousLimitUpFailedBoardSnapshot: (options = {}) =>
    invoke("market:previous-limit-up-failed-boards", options),
  scanStrategySignals: (options = {}) => invoke("strategy:scan", options),
  cancelServiceJob: (requestId) => invoke("service:cancel", requestId),
  getStrategyDefinitions: () => invoke("strategy:definitions"),
  listCustomStrategies: () => invoke("strategy:custom:list"),
  saveCustomStrategy: (strategy) => invoke("strategy:custom:save", strategy),
  deleteCustomStrategy: (id) => invoke("strategy:custom:delete", id),
  importSettingsStrategy: () => invoke("strategy:custom:import-settings"),
  startTrendScan: (options = {}) => invoke("trend-screener:start", options),
  getTrendScan: (cursor) => invoke("trend-screener:status", cursor),
  evaluateTrendResearch: (options = {}) => invoke("trend-screener:research", options),
  checkTrendExecution: (options = {}) => invoke("trend-screener:execution-check", options),
  cancelTrendScan: () => invoke("trend-screener:cancel"),
  getLimitUpSectorBoard: (options = {}) => invoke("market:limit-up-sectors", options),
  getSectorStrengthBoard: (options = {}) => invoke("market:sector-strength", options),
  getSectorLimitUpCount: (input, options = {}) => invoke("market:sector-limit-count", input, options),
  getSectorClassifications: (options) => invoke("sector:classifications", options),
  getSectorCatalog: (options = {}) => invoke("sector:catalog", options),
  getSectorQuotes: (options = {}) => invoke("sector:quotes", options),
  getSectorDetail: (options) => invoke("sector:detail", options),
  cancelSectorRequest: (requestId) => invoke("sector:cancel", requestId),
  searchSectors: (query) => invoke("market:search-sectors", query),
  getConceptChain: (query) => invoke("market:concept-chain", query),
  analyzeSector: (sector) => invoke("market:analyze-sector", sector),
  getProfessionalReview: (options = {}) => invoke("review:get-market", options),
  openProfessionalReviewWindow: () => invoke("review:open-window"),
  getNewsFeed: (input) => invoke("news:get-feed", input),
  refreshNewsFeed: (input) => invoke("news:refresh", input),
  runBacktest: (security, options = {}) =>
    invoke("backtest:run", security, options),
  runPortfolioBacktest: (input = {}) =>
    invoke("backtest:run-portfolio", input),
  getWatchlist: () => invoke("watchlist:get"),
  saveWatchlist: (items) => invoke("watchlist:save", items),
  getHoldings: () => invoke("holdings:get"),
  // ERR-03：查询本次启动是否发生过本地数据损坏（只读诊断）
  getCorruptedOnLoad: () => invoke("diagnostics:corrupted-on-load"),
  saveHoldings: (items) => invoke("holdings:save", items),
  getSettings: () => invoke("settings:get"),
  saveSettings: (settings) => invoke("settings:save", settings),
  testProvider: (settings) => invoke("settings:test-provider", settings),
  setTheme: (theme) => invoke("app:set-theme", theme),
  controlWindow: (action) => invoke("app:window-control", action),
  notify: (message) => invoke("app:notify", message),
  notesWatch: (input) => invoke("notes:watch-sync", input),
  backup: {
    status: () => invoke("backup:status"),
    chooseFolder: () => invoke("backup:choose-folder"),
    configure: (patch) => invoke("backup:configure", patch),
    run: (local, options) => invoke("backup:run", local, options),
    inspect: (name, password) => invoke("backup:inspect", name, password),
    restore: (name, password) => invoke("backup:restore", name, password),
    relaunch: () => invoke("backup:relaunch")
  },
  openExternal: (url) => invoke("shell:open-external", url),
  getPlatform: () => process.platform,
  getVersion: () => invoke("app:version"),
  getRuntimeInfo
});
