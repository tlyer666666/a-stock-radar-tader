const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  nativeTheme,
  Menu,
  Tray,
  WebContentsView,
  safeStorage,
  dialog,
  session,
  powerMonitor,
  Notification
} = require("electron");
const path = require("path");
const fs = require("fs");
const { createRuntimeLogger } = require("./runtime-diagnostics.cjs");
const { pathToFileURL } = require("node:url");
const { createCustomStrategyStore } = require("./custom-strategy-store.cjs");
const { createLocalSecretStorage, createLocalFirstSecretStorage, hasSystemCiphertext } = require("./local-secret-storage.cjs");

if (process.env.A_STOCK_E2E_USER_DATA) {
  const isolatedUserData = path.resolve(process.env.A_STOCK_E2E_USER_DATA);
  fs.mkdirSync(isolatedUserData, { recursive: true });
  app.setPath("userData", isolatedUserData);
  app.setPath("sessionData", path.join(isolatedUserData, "session"));
}

// 1.6.49：不再使用 macOS 钥匙串（每次更新重新签名后都会弹登录密码）。
// 只有本机设置里还留着 1.6.48 写入的钥匙串密文时，这一次启动才访问钥匙串把它们迁回本机加密；
// 迁完之后的启动都用 Chromium 的模拟钥匙串，不再碰系统钥匙串。
const keychainMigrationPending = (() => {
  if (process.platform !== "darwin") return false;
  try {
    // 主文件和 .last-good 备份都检查：主文件损坏时会从备份恢复，备份里的钥匙串密文也要能迁回。
    return ["settings", "settings.last-good", "ai-profiles", "ai-profiles.last-good"].some(name => {
      try { return hasSystemCiphertext(JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), `${name}.json`), "utf8"))); }
      catch { return false; }
    });
  } catch { return false; }
})();
if (process.platform === "darwin" && !keychainMigrationPending) app.commandLine?.appendSwitch?.("use-mock-keychain");

const {
  capItemsPreservingFavorites,
  readJsonWithBackup,
  writeJsonAtomic
} = require("./persistence.cjs");
const {
  createTrustedIpcHandler,
  withIpcResult,
  decryptStoredSecret,
  encryptSecretForStorage,
  isAllowedRendererNavigation,
  migrateLegacyStoredSecrets,
  normalizeExternalHttpsUrl,
  pickBacktestSettingOverrides,
  redactRuntimeText,
  resolveStoredSecret,
  resolveTestSecret
} = require("./security-policy.cjs");
const {
  searchSecurities,
  analyzeSecurity,
  strategyHitsForStock,
  getQuoteSnapshot,
  getMarketSourceHealth,
  getConvertibleBonds,
  getFuyaoReviewData,
  configureConvertibleRosterStore,
  configureStockIndustryStore,
  configureDailyBarStore,
  dailyBarStore,
  dailyBarAsOf,
  configureFuyao,
  trendThsLane,
  getDataFederation,
  getChart,
  resolveStockIndustries,
  stockAnnouncements,
  discoverLimitUps,
  discoverRecentLimitUps,
  getPreviousLimitUpFailedBoardSnapshot,
  scanStrategySignals,
  checkTrendExecution,
  evaluateTrendResearch,
  getLimitUpSectorBoard,
  getSectorStrengthBoard,
  getSectorLimitUpCount,
  getSectorCatalog,
  getSectorQuotes,
  getSectorClassifications,
  getSectorDetail,
  cancelSectorRequest,
  searchSectors,
  getConceptChain,
  analyzeSector,
  getNewsFeed,
  resetNewsCache,
  testProvider,
  getStrategyDefinitions,
  getStrategyPatternIds,
  runPortfolioBacktest,
  runBacktest,
  cancelServiceJob,
  cancelServiceOwner,
  shutdownServiceResources
} = require("./services.cjs");
const { createShutdownGate } = require("./shutdown-gate.cjs");
const { shutdownThsTokenManager } = require("./ths-token-manager.cjs");
const {
  getProfessionalReview,
  resetProfessionalReviewCache
} = require("./review-service.cjs");
const { createTrendScreenerService } = require("./trend-screener-service.cjs");
const { createTrendMarketData } = require("./trend-screener-adapter.cjs");
const { createReviewWindowManager } = require('./review-window.cjs');
const { createThsWebViewManager } = require("./ths-web-view.cjs");
const { createAiService, marketFromEcology, isAiStore } = require("./ai-service.cjs");
const { buildStockProfile, trendText, summarizeAnnouncements } = require("./stock-profile.cjs");
const { frameworkCatalog, normalizeCustom, normalizeFrameworkState, situationOf, evaluateFramework, resolveFramework } = require("./ai-frameworks.cjs");
const { createReviewSkills } = require("./review-skills.cjs");
const { createAiProfileStore, isAiProfileStore, sameOrigin } = require("./ai-profile-store.cjs");
const { createAiClient } = require("./ai-client.cjs");
const { createStockAgentService, isAgentStore } = require("./stock-agent.cjs");
const { createBackupService } = require("./data-backup.cjs");
const { createStockAgentTools } = require("./stock-agent-tools.cjs");
const trendScreener = createTrendScreenerService(createTrendMarketData({ ths: trendThsLane, dailyStore: dailyBarStore, asOf: dailyBarAsOf }));
const reviewWindows = createReviewWindowManager({ BrowserWindow, root: path.join(__dirname, '..'), packaged: app.isPackaged, devUrl: process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173', hidden: process.env.A_STOCK_E2E_HIDDEN === '1', openExternal: url => shell.openExternal(url), onError: error => debugLog(`review external ${error.message}`) });

let mainWindow;
let tray;
let themeMode = "system";
let isQuitting = false;
let rendererRecoveryTimer;
const rendererRecoveryAttempts = [];
const serviceJobOwners = new WeakSet();
let trendScanOwner;
const RENDERER_RECOVERY_WINDOW_MS = 60 * 1000;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_DELAY_MS = 750;
const SECRET_SETTING_KEYS = Object.freeze(["refreshToken", "tushareToken", "fuyaoApiKey", "aiApiKey"]);

function updateWindowChrome() {
  const dark = nativeTheme.shouldUseDarkColors;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(dark ? "#070b14" : "#f4f6fb");
  }
}

function applyWindowTheme(mode = "system") {
  themeMode = ["light", "dark", "system"].includes(mode) ? mode : "system";
  nativeTheme.themeSource = themeMode;
  updateWindowChrome();
  // 返回实际生效的模式，调用方无需再读模块级状态即可转发给其它窗口。
  return themeMode;
}

function debugLog(message) {
  if (!process.env.ASTOCK_DEBUG) return;
  try {
    const safeMessage = redactRuntimeText(message).replace(/[\r\n]+/g, " ");
    fs.appendFileSync(
      path.join(app.getPath("temp"), "astock-monitor-startup.log"),
      `${new Date().toISOString()} ${safeMessage}\n`,
      "utf8"
    );
  } catch {
    // Debug logging must never affect application startup.
  }
}

const runtimeErrorLog = createRuntimeLogger({
  isEnabled: () => app.isPackaged,
  getDirectory: () => app.getPath("userData"),
  debugLog
});

process.on("uncaughtExceptionMonitor", (error, origin) =>
  runtimeErrorLog("uncaughtException", error, `origin=${origin}`)
);
process.on("unhandledRejection", (error) => runtimeErrorLog("unhandledRejection", error));

function jsonPath(name) {
  return path.join(app.getPath("userData"), `${name}.json`);
}

function backupJsonPath(name) {
  return path.join(app.getPath("userData"), `${name}.last-good.json`);
}

function readJson(name, fallback, validator) {
  const result = readJsonWithBackup(jsonPath(name), backupJsonPath(name), fallback, validator);
  if (result.recovered) {
    debugLog(`recovered ${name} from last-good backup`);
    // ERR-03：从备份恢复说明主文件已损坏，必须让用户/日志知道，
    // 否则下次保存会把「恢复出来的旧值」当成正常数据静默写回。
    runtimeErrorLog("persistence-primary-corrupted", new Error(`${name} 主文件损坏，已从 last-good 备份恢复`), name);
  }
  if (result.corrupted) {
    // 双损坏：主备都读不出来。原始文件已被 quarantine 留档。
    runtimeErrorLog(
      "persistence-both-corrupted",
      new Error(
        `${name} 的主文件与备份均无法解析，已回退默认值。` +
        `原始文件已留档：${(result.quarantined || []).join(", ") || "(留档失败)"}`
      ),
      name
    );
    // 记录到内存，供 UI 查询「本次启动是否存在数据损坏」
    corruptedOnLoad.add(name);
  }
  return result.value;
}

/** ERR-03：本次启动中发生数据损坏的记录名，供渲染层提示用户。 */
const corruptedOnLoad = new Set();
function getCorruptedOnLoad() {
  return [...corruptedOnLoad];
}

function writeJson(name, value, validator, synchronizeBackup = false) {
  return writeJsonAtomic(jsonPath(name), backupJsonPath(name), value, validator,
    error => runtimeErrorLog("persistence-backup-degraded", error, name), { synchronizeBackup });
}

function isSettingsRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertProtectedFields(record, keys) {
  for (const key of keys) {
    if (record[key] && (typeof record[key] !== "string" || !record[key].startsWith("safe:"))) {
      throw Object.assign(new Error("旧密钥暂不能迁移。请解锁系统安全存储或明确清除旧密钥后再保存。"), {code:"SAFE_STORAGE_UNAVAILABLE"});
    }
  }
}

function writeSettings(value, synchronizeBackup = false) {
  assertProtectedFields(value, SECRET_SETTING_KEYS);
  return writeJson("settings", value, isSettingsRecord, synchronizeBackup);
}

function isCustomStrategyStore(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.strategies);
}

function isConvertibleRoster(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.bonds);
}

// 可转债在市名单：同花顺逐码核对的结果缓存在本机，避免每次启动都重新核对。
configureConvertibleRosterStore({
  read: () => readJson("convertible-roster", null, isConvertibleRoster),
  write: value => writeJson("convertible-roster", value, isConvertibleRoster)
});

// 本地日线库：全市场选股与趋势扫描的不复权日线存在本机，每天只补最新一根。
configureDailyBarStore({ directory: () => path.join(app.getPath("userData"), "daily-bars") });

// 个股 → 同花顺行业索引：保存在本机，每天最多重建一次（炸板观察等补行业用）。
configureStockIndustryStore({
  read: () => readJson("stock-industry-index", null, isStockIndustryIndex),
  write: value => writeJson("stock-industry-index", value, isStockIndustryIndex)
});

function isStockIndustryIndex(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && value.industries !== null && typeof value.industries === "object";
}

// 用户自定义选股策略：独立文件保存；首次读取时迁移设置页的自主策略组合。
const customStrategyStore = createCustomStrategyStore({
  read: () => readJson("custom-strategies", null, isCustomStrategyStore),
  write: value => writeJson("custom-strategies", value, isCustomStrategyStore),
  loadLegacySelection: () => loadStoredSettings().selectedStrategies,
  patternIds: () => getStrategyPatternIds()
});

function customStrategiesForScan() {
  try { return customStrategyStore.list(); }
  catch (error) { runtimeErrorLog("custom-strategies-unavailable", error, "custom-strategies"); return []; }
}

/** Identity fields shared by the persisted holdings and watchlist documents. Both describe
 * the same security, so both must apply the same trim and truncation limits. */
function normalizeSecurityIdentity(row, code) {
  return {
    code,
    name: String(row?.name || code).trim().slice(0, 80) || code,
    secid: String(row?.secid || "").trim().slice(0, 40),
    thscode: String(row?.thscode || "").trim().slice(0, 40),
    marketName: String(row?.marketName || "").trim().slice(0, 40)
  };
}

function normalizeHoldings(value) {
  const rows = Array.isArray(value) ? value : [];
  const holdings = new Map();
  const now = new Date().toISOString();
  for (const row of rows) {
    const code = String(row?.code || "").trim();
    if (!/^\d{6}$/.test(code)) continue;
    const shares = Math.floor(Number(row?.shares));
    const costPrice = Number(row?.costPrice);
    if (!Number.isFinite(shares) || shares <= 0) continue;
    if (!Number.isFinite(costPrice) || costPrice <= 0) continue;
    const createdAt = Number.isFinite(Date.parse(row?.createdAt)) ? row.createdAt : now;
    const updatedAt = Number.isFinite(Date.parse(row?.updatedAt)) ? row.updatedAt : createdAt;
    const holding = {
      ...normalizeSecurityIdentity(row, code),
      assetType: row?.assetType,
      shares: Math.min(shares, 1_000_000_000),
      costPrice: Math.min(costPrice, 10_000_000),
      createdAt,
      updatedAt,
      note: String(row?.note || "").trim().slice(0, 160)
    };
    holdings.set(code, holding);
  }
  return [...holdings.values()].slice(0, 80);
}

function normalizeWatchlist(value) {
  const rows = Array.isArray(value) ? value : [];
  const watchlist = new Map();
  const now = new Date().toISOString();
  for (const row of rows) {
    const code = String(row?.code || "").trim();
    if (!/^\d{6}$/.test(code)) continue;
    const createdAt = Number.isFinite(Date.parse(row?.createdAt)) ? row.createdAt : now;
    const favoriteAddedAt = Number.isFinite(Date.parse(row?.favoriteAddedAt))
      ? row.favoriteAddedAt
      : undefined;
    const limitDate = /^\d{4}-\d{2}-\d{2}$/.test(String(row?.limitDate || ""))
      ? String(row.limitDate)
      : undefined;
    const security = {
      ...normalizeSecurityIdentity(row, code),
      assetType: row?.assetType === "etf" || row?.assetType === "convertibleBond"
        ? row.assetType
        : "stock",
      createdAt,
      note: String(row?.note || "").trim().slice(0, 160),
      limitDate,
      tradingDaysSince: Number.isFinite(Number(row?.tradingDaysSince))
        ? Math.max(0, Math.min(100, Math.round(Number(row.tradingDaysSince))))
        : undefined,
      observationNode: String(row?.observationNode || "").trim().slice(0, 24) || undefined,
      consecutiveBoards: Number.isFinite(Number(row?.consecutiveBoards))
        ? Math.max(0, Math.min(100, Math.round(Number(row.consecutiveBoards))))
        : undefined,
      autoAdded: row?.autoAdded === true,
      favorite: row?.favorite === true,
      favoriteAddedAt
    };
    watchlist.set(code, security);
  }
  return capItemsPreservingFavorites(
    [...watchlist.values()],
    500,
    (item) => item.favorite === true || item.autoAdded !== true
  );
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function usableWatchlist(value) {
  return Array.isArray(value) && (value.length === 0 || normalizeWatchlist(value).length > 0);
}
function usableHoldings(value) {
  return Array.isArray(value) && (value.length === 0 || normalizeHoldings(value).length > 0);
}

// 新写入用本机 AS1 加密；系统安全存储只用于把 1.6.48 存进钥匙串的旧密文迁回（见文件开头）。
let localSecretStorage;
function secretStorage() {
  localSecretStorage ||= createLocalFirstSecretStorage(
    createLocalSecretStorage({ keyPath: path.join(app.getPath("userData"), "local-secret.key") }),
    keychainMigrationPending ? safeStorage : null);
  return localSecretStorage;
}

function encryptSecret(value) {
  return encryptSecretForStorage(value, secretStorage());
}

function decryptSecret(value) {
  return decryptStoredSecret(value, secretStorage());
}

function defaultSettings() {
  return {
    provider: "ths",
    riskProfile: "balanced",
    refreshToken: "",
    tushareToken: "",
    fuyaoApiKey: "",
    aiBaseUrl: "",
    aiModel: "",
    aiApiKey: "",
    aiRankInstructions: "",
    aiSummaryInstructions: "",
    multiSourceEnabled: true,
    fallbackEnabled: true,
    quoteRefreshSeconds: 5,
    refreshSeconds: 90,
    newsRefreshSeconds: 6,
    newsVoiceEnabled: true,
    alertScore: 75,
    exactNodesOnly: false,
    strictGate: false,
    maxPositionPercent: 28,
    maxRiskPerTradePercent: 1.0,
    stopLossATRMultiple: 2.0,
    takeProfitATRMultiple: 3.2,
    maxHoldingBars: 30,
    minMarketCap: 0,
    maxDailyRiskPercent: 3.2,
    maxPortfolioRiskPercent: 70,
    maxSectorExposurePercent: 45,
    minProjectedNetEdgePercent: 0.2,
    minExpectancyPoints: 0.2,
    maxConsecutiveLossesForStop: 4,
    lossStreakStepPercent: 18,
    lossStreakFloorPercent: 30,
    minExecutionRatePercent: 90,
    minPaperWinRatePercent: 52,
    minPaperRiskRewardRatio: 1.15,
    minTurnoverPercent: 0.4,
    minQuoteAmount: 1_200_000,
    maxQuoteAgeSeconds: 480,
    maxDailyTrades: 12,
    trailingStopPercent: 3,
    commissionBps: 7,
    slippageBps: 2,
    timeDecayPerBarPercent: 0.11,
    maxOpenPositions: 2,
    enabledPaperSim: true,
    selectedStrategies: ["support", "avwap", "trend", "contraction", "sector", "sectorLadder", "riskVeto"],
    theme: "system"
  };
}

function normalizeSettings(value) {
  const fallback = defaultSettings();
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const selected = Array.isArray(input.selectedStrategies) && input.selectedStrategies.length
    ? input.selectedStrategies
    : fallback.selectedStrategies;
  const stopLossATRMultiple = clampNumber(
    input.stopLossATRMultiple,
    0.8,
    5,
    fallback.stopLossATRMultiple
  );
  const takeProfitMinimum = Math.max(2, stopLossATRMultiple + 0.4);
  const selectedStrategies = [...new Set(
    selected
      .filter((item) => typeof item === "string")
      .map((item) => item.trim().slice(0, 64))
      .filter(Boolean)
  )];
  return {
    ...fallback,
    ...input,
    // The application topology is fixed: THS is the requested primary and
    // Eastmoney is the first automatic fallback/verification source.
    provider: "ths",
    riskProfile: input.riskProfile === "conservative" || input.riskProfile === "aggressive"
      ? input.riskProfile
      : "balanced",
    refreshToken: typeof input.refreshToken === "string" ? input.refreshToken : fallback.refreshToken,
    tushareToken: typeof input.tushareToken === "string" ? input.tushareToken : fallback.tushareToken,
    fuyaoApiKey: typeof input.fuyaoApiKey === "string" ? input.fuyaoApiKey : (fallback.fuyaoApiKey || ""),
    aiBaseUrl: typeof input.aiBaseUrl === "string" ? input.aiBaseUrl.trim().slice(0, 300) : "",
    aiModel: typeof input.aiModel === "string" ? input.aiModel.trim().slice(0, 100) : "",
    aiApiKey: typeof input.aiApiKey === "string" ? input.aiApiKey : "",
    aiRankInstructions: typeof input.aiRankInstructions === "string" ? input.aiRankInstructions.slice(0, 1000) : "",
    aiSummaryInstructions: typeof input.aiSummaryInstructions === "string" ? input.aiSummaryInstructions.slice(0, 1000) : "",
    quoteRefreshSeconds: clampNumber(input.quoteRefreshSeconds, 3, 20, fallback.quoteRefreshSeconds),
    refreshSeconds: clampNumber(input.refreshSeconds, 30, 300, fallback.refreshSeconds),
    newsRefreshSeconds: clampNumber(input.newsRefreshSeconds, 5, 45, fallback.newsRefreshSeconds),
    newsVoiceEnabled: input.newsVoiceEnabled !== false,
    multiSourceEnabled: input.multiSourceEnabled !== false,
    fallbackEnabled: input.fallbackEnabled !== false,
    alertScore: clampNumber(input.alertScore, 50, 95, fallback.alertScore),
    exactNodesOnly: input.exactNodesOnly === true,
    strictGate: input.strictGate === true,
    maxPositionPercent: clampNumber(input.maxPositionPercent, 5, 90, fallback.maxPositionPercent),
    maxRiskPerTradePercent: clampNumber(input.maxRiskPerTradePercent, 0.2, 5, fallback.maxRiskPerTradePercent),
    stopLossATRMultiple,
    takeProfitATRMultiple: clampNumber(
      Math.max(Number(input.takeProfitATRMultiple) || takeProfitMinimum, takeProfitMinimum),
      takeProfitMinimum,
      10,
      takeProfitMinimum
    ),
    maxHoldingBars: Math.round(clampNumber(input.maxHoldingBars, 3, 120, fallback.maxHoldingBars)),
    minMarketCap: clampNumber(input.minMarketCap, 0, 100_000, fallback.minMarketCap),
    maxDailyRiskPercent: clampNumber(input.maxDailyRiskPercent, 0.3, 12, fallback.maxDailyRiskPercent),
    maxPortfolioRiskPercent: clampNumber(input.maxPortfolioRiskPercent, 10, 100, fallback.maxPortfolioRiskPercent),
    maxSectorExposurePercent: clampNumber(input.maxSectorExposurePercent, 10, 100, fallback.maxSectorExposurePercent),
    minProjectedNetEdgePercent: clampNumber(input.minProjectedNetEdgePercent, -2, 10, fallback.minProjectedNetEdgePercent),
    minExpectancyPoints: clampNumber(input.minExpectancyPoints, -1, 5, fallback.minExpectancyPoints),
    maxConsecutiveLossesForStop: Math.round(clampNumber(input.maxConsecutiveLossesForStop, 2, 12, fallback.maxConsecutiveLossesForStop)),
    lossStreakStepPercent: clampNumber(input.lossStreakStepPercent, 2, 60, fallback.lossStreakStepPercent),
    lossStreakFloorPercent: clampNumber(input.lossStreakFloorPercent, 10, 80, fallback.lossStreakFloorPercent),
    minExecutionRatePercent: clampNumber(input.minExecutionRatePercent, 40, 100, fallback.minExecutionRatePercent),
    minPaperWinRatePercent: clampNumber(input.minPaperWinRatePercent, 40, 90, fallback.minPaperWinRatePercent),
    minPaperRiskRewardRatio: clampNumber(input.minPaperRiskRewardRatio, 1, 3, fallback.minPaperRiskRewardRatio),
    minTurnoverPercent: clampNumber(input.minTurnoverPercent, 0, 20, fallback.minTurnoverPercent),
    minQuoteAmount: clampNumber(input.minQuoteAmount, 0, 1_000_000_000, fallback.minQuoteAmount),
    maxQuoteAgeSeconds: clampNumber(input.maxQuoteAgeSeconds, 30, 1800, fallback.maxQuoteAgeSeconds),
    maxDailyTrades: Math.round(clampNumber(input.maxDailyTrades, 1, 200, fallback.maxDailyTrades)),
    trailingStopPercent: clampNumber(input.trailingStopPercent, 0, 20, fallback.trailingStopPercent),
    commissionBps: clampNumber(input.commissionBps, 0, 40, fallback.commissionBps),
    slippageBps: clampNumber(input.slippageBps, 0, 40, fallback.slippageBps),
    timeDecayPerBarPercent: clampNumber(input.timeDecayPerBarPercent, 0, 1, fallback.timeDecayPerBarPercent),
    maxOpenPositions: Math.round(clampNumber(input.maxOpenPositions, 1, 10, fallback.maxOpenPositions)),
    enabledPaperSim: input.enabledPaperSim !== false,
    selectedStrategies: selectedStrategies.includes("riskVeto")
      ? selectedStrategies
      : [...selectedStrategies, "riskVeto"],
    theme: input.theme === "light" || input.theme === "dark" ? input.theme : "system"
  };
}

function loadStoredSettings() {
  if (loadStoredSettings.cached) return loadStoredSettings.cached;
  const stored = normalizeSettings({ ...defaultSettings(), ...readJson("settings", {}, isSettingsRecord) });
  const migration = migrateLegacyStoredSecrets(stored, SECRET_SETTING_KEYS, secretStorage());
  if (migration.deferredKeys.length) return stored;
  if (!migration.migrated) return (loadStoredSettings.cached = stored);
  try {
    const saved = writeSettings(normalizeSettings(migration.settings), true);
    debugLog(`migrated legacy secrets count=${migration.migratedKeys.length}`);
    return (loadStoredSettings.cached = saved);
  } catch (error) {
    // Fail closed in memory even if the atomic cleanup cannot reach the disk.
    // A later load retries the migration/cleanup.
    runtimeErrorLog("secret-migration-failed", error);
    return (loadStoredSettings.cached = normalizeSettings(migration.settings));
  }
}

function settingsForService(override) {
  const saved = loadStoredSettings();
  const cached = settingsForService.cached;
  const decrypted = cached?.stored === saved ? cached.value : {
    ...saved,
    refreshToken: decryptSecret(saved.refreshToken),
    tushareToken: decryptSecret(saved.tushareToken),
    fuyaoApiKey: decryptSecret(saved.fuyaoApiKey),
    aiApiKey: decryptSecret(saved.aiApiKey)
  };
  settingsForService.cached = { stored: saved, value: decrypted };
  return normalizeSettings({ ...decrypted, ...(override || {}) });
}

function publicSettings() {
  const stored = loadStoredSettings();
  return {
    ...stored,
    refreshToken: stored.refreshToken ? "••••••••••••" : "",
    tushareToken: stored.tushareToken ? "••••••••••••" : "",
    fuyaoApiKey: stored.fuyaoApiKey ? "••••••••••••" : "",
    aiApiKey: stored.aiApiKey ? "••••••••••••" : ""
  };
}



function cancelRendererRecovery() {
  if (!rendererRecoveryTimer) return;
  clearTimeout(rendererRecoveryTimer);
  rendererRecoveryTimer = undefined;
}

function scheduleRendererRecovery(reason, targetWindow = mainWindow) {
  if (isQuitting || !targetWindow || targetWindow.isDestroyed()) return;
  if (rendererRecoveryTimer) return;

  const now = Date.now();
  while (
    rendererRecoveryAttempts.length > 0
    && now - rendererRecoveryAttempts[0] > RENDERER_RECOVERY_WINDOW_MS
  ) {
    rendererRecoveryAttempts.shift();
  }
  if (rendererRecoveryAttempts.length >= RENDERER_RECOVERY_MAX_ATTEMPTS) {
    runtimeErrorLog(
      "renderer-recovery-suppressed",
      new Error("Renderer automatic recovery limit reached"),
      `attempts=${rendererRecoveryAttempts.length} windowMs=${RENDERER_RECOVERY_WINDOW_MS}`
    );
    return;
  }

  rendererRecoveryAttempts.push(now);
  const attempt = rendererRecoveryAttempts.length;
  debugLog(`renderer recovery scheduled attempt=${attempt} reason=${reason}`);
  rendererRecoveryTimer = setTimeout(() => {
    rendererRecoveryTimer = undefined;
    if (
      isQuitting
      || targetWindow !== mainWindow
      || targetWindow.isDestroyed()
      || targetWindow.webContents.isDestroyed()
    ) {
      return;
    }
    try {
      debugLog(`renderer recovery reload attempt=${attempt}`);
      targetWindow.webContents.reloadIgnoringCache();
    } catch (error) {
      runtimeErrorLog("renderer-recovery-failed", error, `attempt=${attempt}`);
    }
  }, RENDERER_RECOVERY_DELAY_MS);
}

function showSystemNotification(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const title = String(value.title || "").trim().slice(0, 60);
  const body = String(value.body || "").trim().slice(0, 240);
  if (!title) throw new Error("通知标题为空");
  if (process.platform === "darwin" && app.dock && mainWindow && !mainWindow.isFocused()) app.dock.bounce("informational");
  if (!Notification.isSupported()) return { shown: false };
  const notification = new Notification({ title, body, silent: false });
  notification.on("click", () => focusMainWindow());
  notification.show();
  return { shown: true };
}

const { createIntervalReminderScheduler } = require("./note-watch.cjs");
const intervalReminders = createIntervalReminderScheduler({ notify: showSystemNotification });

let noteWatcherInstance = null;
function noteWatcher() {
  if (!noteWatcherInstance) {
    const { createNoteWatcher, inTradingSession } = require("./note-watch.cjs");
    const { tradingDateStatus } = require("./market-time-rules.cjs");
    noteWatcherInstance = createNoteWatcher({
      getQuote: security => getQuoteSnapshot(security, settingsForService()),
      notify: message => showSystemNotification(message),
      inSession: ms => inTradingSession(ms, date => tradingDateStatus(date) !== false)
    });
  }
  return noteWatcherInstance;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return true;
}

function applicationIconPath(forTray = false) {
  const assetRoot = path.join(__dirname, "..", "assets");
  const names = forTray && process.platform === "win32"
    ? ["a-stock-radar-bull-v1.ico", "a-stock-radar-bull-v1.png"]
    : ["a-stock-radar-bull-v1.png", "a-stock-radar-bull-v1.ico"];
  return names
    .map((name) => path.join(assetRoot, name))
    .find((candidate) => fs.existsSync(candidate)) || path.join(assetRoot, names[0]);
}

function showOrCreateMainWindow() {
  if (isQuitting) return false;
  try {
    if (focusMainWindow()) return true;
    if (!app.isReady()) return false;
    createWindow();
    return focusMainWindow();
  } catch (error) {
    runtimeErrorLog("window-restore-failed", error);
    requestExplicitQuit();
    return false;
  }
}

function requestExplicitQuit() {
  if (isQuitting) return;
  isQuitting = true;
  cancelRendererRecovery();
  app.quit();
}

function createTray() {
  if (process.env.A_STOCK_E2E_HIDDEN === "1") return undefined;
  if (tray && !tray.isDestroyed()) return tray;
  let createdTray;
  try {
    createdTray = new Tray(applicationIconPath(true));
    createdTray.setToolTip("A股雷达");
    createdTray.setContextMenu(Menu.buildFromTemplate([
      {
        label: "显示 A股雷达",
        click: () => showOrCreateMainWindow()
      },
      { type: "separator" },
      {
        label: "退出",
        click: requestExplicitQuit
      }
    ]));
    createdTray.on("click", () => showOrCreateMainWindow());
    createdTray.on("double-click", () => showOrCreateMainWindow());
    tray = createdTray;
    return tray;
  } catch (error) {
    try { if (createdTray && !createdTray.isDestroyed()) createdTray.destroy(); }
    catch { /* Preserve the setup failure; never leave the window unreachable. */ }
    tray = undefined;
    runtimeErrorLog("tray-create-failed", error);
    return undefined;
  }
}

function destroyTray() {
  const currentTray = tray;
  tray = undefined;
  if (!currentTray || currentTray.isDestroyed()) return;
  try {
    currentTray.destroy();
  } catch (error) {
    runtimeErrorLog("tray-destroy-failed", error);
  }
}

function trustedMainWebContents() {
  if (!mainWindow || mainWindow.isDestroyed()) return undefined;
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed()) return undefined;
  return contents;
}

function handleTrustedIpc(channel, handler, getTrustedWebContents = trustedMainWebContents) {
  const review = getTrustedWebContents === reviewWindows.getWebContents;
  const file = review ? "review/review.html" : "index.html";
  const dev = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const entry = app.isPackaged ? pathToFileURL(path.join(__dirname, "..", "dist", file)).href
    : review ? new URL("review.html", dev.replace(/\/?$/, "/")).href : new URL(dev).href;
  const checked = createTrustedIpcHandler(handler, getTrustedWebContents, channel, entry);
  ipcMain.handle(channel, withIpcResult(checked, code => runtimeErrorLog("ipc-error", new Error(code), channel)));
}

function serviceRequestId(value, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw Object.assign(new TypeError("任务 requestId 必须是 1–256 字符的非空字符串"), { code: "INVALID_IPC_PAYLOAD" });
  }
  return value.trim();
}

function serviceRequestRuntime(event, input = {}) {
  const requestId = serviceRequestId(input?.requestId);
  const timeoutMs = input?.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw Object.assign(new TypeError("任务 timeoutMs 必须是正数"), { code: "INVALID_IPC_PAYLOAD" });
  }
  const sender = event?.sender;
  if (!sender || !Number.isInteger(sender.id) || sender.id < 0 || sender.isDestroyed?.() || typeof sender.once !== "function") {
    throw Object.assign(new TypeError("任务窗口已关闭或无效"), { code: "INVALID_IPC_PAYLOAD" });
  }
  if (!serviceJobOwners.has(sender)) {
    serviceJobOwners.add(sender);
    const cancelOwner = () => {
      cancelServiceOwner(sender.id);
      // Ownership survives destruction; resolving the current trusted window
      // here excludes a destroyed sender and can also select its replacement.
      if (trendScanOwner?.sender === sender) {
        const ownership = trendScanOwner;
        trendScanOwner = undefined;
        try {
          if (trendScreener.getStatus().jobId === ownership.jobId) trendScreener.cancel();
        } catch (error) { runtimeErrorLog('renderer-trend-cancel', error); }
      }
    };
    const navigation = (details, _url, legacySameDocument, legacyMainFrame) => {
      // Electron 43 carries these fields in details; positional fields remain
      // available for compatibility with older supported Electron callbacks.
      const isMainFrame = typeof details?.isMainFrame === "boolean" ? details.isMainFrame : legacyMainFrame;
      const isSameDocument = typeof details?.isSameDocument === "boolean" ? details.isSameDocument : legacySameDocument;
      if (isMainFrame === true && isSameDocument === false) cancelOwner();
    };
    sender.on("render-process-gone", cancelOwner);
    sender.on("did-start-navigation", navigation);
    sender.once("destroyed", () => {
      sender.removeListener("render-process-gone", cancelOwner);
      sender.removeListener("did-start-navigation", navigation);
      cancelOwner();
    });
  }
  return { owner: sender.id, ...(requestId === undefined ? {} : { requestId }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function observeWindowResponsiveness(win) {
  let prompt;
  function clearPrompt() {
    prompt?.abort();
    prompt = undefined;
  }
  win.on("unresponsive", () => {
    if (prompt || isQuitting || win.isDestroyed()) return;
    const pending = new AbortController();
    prompt = pending;
    runtimeErrorLog("renderer-unresponsive", new Error("窗口未响应"));
    void Promise.resolve().then(() => dialog.showMessageBox(win, {
      type: "warning", message: "窗口暂时没有响应", detail: "可继续等待，或重新加载窗口恢复操作。",
      buttons: ["继续等待", "重新加载窗口"], defaultId: 0, cancelId: 0, signal: pending.signal
    })).then(({ response }) => {
      if (response === 1 && !pending.signal.aborted && !isQuitting && !win.isDestroyed()) win.webContents.reload();
    }).catch(error => { if (!pending.signal.aborted) runtimeErrorLog("renderer-response-prompt", error); })
      .finally(() => { if (prompt === pending) prompt = undefined; });
  });
  win.on("responsive", clearPrompt);
  win.once("closed", clearPrompt);
}

function createWindow() {
  debugLog(`createWindow packaged=${app.isPackaged} dirname=${__dirname}`);
  // Window appearance needs no credentials. Keychain authorization must not
  // delay constructing the window simply to read a non-sensitive preference.
  applyWindowTheme(normalizeSettings(readJson("settings", {}, isSettingsRecord)).theme);
  const dark = nativeTheme.shouldUseDarkColors;
  const hiddenE2E = process.env.A_STOCK_E2E_HIDDEN === "1";
  const createdWindow = new BrowserWindow({
    show: !hiddenE2E,
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: dark ? "#070b14" : "#f4f6fb",
    icon: applicationIconPath(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  if (hiddenE2E) {
    createdWindow.on("show", () => {
      if (!createdWindow.isDestroyed()) setImmediate(() => createdWindow.hide());
    });
  }
  mainWindow = createdWindow;
  observeWindowResponsiveness(createdWindow);
  createdWindow.on("close", (event) => {
    if (isQuitting) return;
    if (process.platform !== "win32") return;
    event.preventDefault();
    const availableTray = createTray();
    if (!availableTray || availableTray.isDestroyed()) return;
    if (!createdWindow.isDestroyed()) createdWindow.hide();
    debugLog("window hidden to tray");
  });
  createdWindow.on("closed", () => {
    debugLog("window closed");
    cancelRendererRecovery();
    if (mainWindow === createdWindow) {
      thsWebViewManager?.destroy();
      mainWindow = undefined;
    }
  });
  createdWindow.webContents.on("did-finish-load", () => {
    debugLog("did-finish-load");
    // 界面重新加载后，沪深港通网页由页面重新决定是否显示，避免旧视图盖在新界面上。
    thsWebViewManager?.hide();
    cancelRendererRecovery();
  });
  createdWindow.webContents.on(
    "did-fail-load",
    (_, code, description, __, isMainFrame) => {
      debugLog(`did-fail-load ${code} ${description} mainFrame=${isMainFrame !== false}`);
      if (isMainFrame === false || code === -3 || isQuitting) return;
      runtimeErrorLog(
        "did-fail-load",
        new Error(`Renderer main frame failed to load: ${description}`),
        `code=${code}`
      );
      scheduleRendererRecovery(`did-fail-load:${code}`, createdWindow);
    }
  );
  createdWindow.webContents.on("render-process-gone", (_, details) => {
    const reason = typeof details?.reason === "string" ? details.reason : "unknown";
    const exitCode = Number.isFinite(details?.exitCode) ? details.exitCode : "unknown";
    debugLog(`render-process-gone reason=${reason} exitCode=${exitCode}`);
    if (reason === "clean-exit" || isQuitting) return;
    runtimeErrorLog(
      "render-process-gone",
      new Error(`Renderer process exited unexpectedly: ${reason}`),
      `reason=${reason} exitCode=${exitCode}`
    );
    scheduleRendererRecovery(`render-process-gone:${reason}`, createdWindow);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const file = path.join(__dirname, "..", "dist", "index.html");
  const rendererEntryUrl = app.isPackaged ? pathToFileURL(file).href : devUrl;
  const openSafeExternalUrl = (url) => {
    const safeUrl = normalizeExternalHttpsUrl(url);
    if (safeUrl) shell.openExternal(safeUrl).catch((error) => debugLog(`openExternal ${error.stack || error}`));
  };
  createdWindow.webContents.setWindowOpenHandler(({ url }) => {
    openSafeExternalUrl(url);
    return { action: "deny" };
  });
  createdWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedRendererNavigation(url, rendererEntryUrl)) return;
    event.preventDefault();
    openSafeExternalUrl(url);
  });
  createdWindow.webContents.session.setPermissionCheckHandler(() => false);
  createdWindow.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  if (!app.isPackaged) {
    createdWindow.loadURL(devUrl).catch((error) => debugLog(`loadURL ${error.stack || error}`));
  } else {
    debugLog(`loadFile ${file}`);
    createdWindow.loadFile(file).catch((error) => debugLog(`loadFile ${error.stack || error}`));
  }
  return createdWindow;
}

// AI 助手（选股点评打分、每日总结、大白话建策略）：接口地址/模型/Key 来自设置，Key 只加密保存在本机。
let aiServiceInstance = null;
let aiProfileStore = null;
function readAiProfileStore() {
  const stored = readJson("ai-profiles", null, isAiProfileStore);
  if (!stored) return null;
  let changed = false, deferred = false;
  const profiles = stored.profiles.map(profile => {
    if (!profile || typeof profile !== "object") return profile;
    const migration = migrateLegacyStoredSecrets(profile, ["apiKey"], secretStorage());
    changed ||= migration.migrated;
    deferred ||= migration.deferredKeys.length > 0;
    return migration.settings;
  });
  if (!changed || deferred) return stored;
  return writeJson("ai-profiles", {...stored, profiles}, isAiProfileStore, true);
}

function aiProfiles() {
  // 多套模型配置单独保存；首次使用把设置里的单套配置迁移成「默认」。
  if (!aiProfileStore) aiProfileStore = createAiProfileStore({
    read: readAiProfileStore,
    write: value => {
      for (const profile of value.profiles) assertProtectedFields(profile, ["apiKey"]);
      return writeJson("ai-profiles", value, isAiProfileStore, true);
    },
    encrypt: encryptSecret, decrypt: decryptSecret,
    legacy: () => { const settings = settingsForService(); return { baseUrl: settings.aiBaseUrl, model: settings.aiModel, apiKey: settings.aiApiKey }; }
  });
  return aiProfileStore;
}
function aiService() {
  if (!aiServiceInstance) aiServiceInstance = createAiService({
    getConfig: () => aiProfiles().active() || {},
    getRankProfiles: () => aiProfiles().rankProfiles(),
    getInstructions: () => { const settings = settingsForService(); return { rank: settings.aiRankInstructions, summary: settings.aiSummaryInstructions }; },
    getFramework: () => readAiFramework(),
    store: { read: () => readJson("ai-selection", null, isAiStore), write: value => writeJson("ai-selection", value, isAiStore) },
    loadMarket: async () => marketFromEcology(await getFuyaoReviewData())
  });
  return aiServiceInstance;
}
const aiPayload = value => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
// AI 打分的分析框架（短线涨停 / 技术面综合 / 自定义）单独保存在 userData/ai-framework.json。
const isAiFrameworkState = value => value !== null && typeof value === "object" && !Array.isArray(value);
const readAiFramework = () => normalizeFrameworkState(readJson("ai-framework", null, isAiFrameworkState));

// 任意股票 AI 打分：「我的股票」清单（最多 40 只，只存代码和名称）+ 用日线现算的体检数据。
const AI_CUSTOM_MAX = 40;
const isAiCustomList = value => value !== null && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.items);
function normalizeAiCustomItems(items) {
  const seen = new Set();
  const list = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const code = String(raw?.code || "").trim();
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    list.push({ code, name: String(raw?.name || code).replace(/\s+/g, "").slice(0, 12) || code });
    if (list.length >= AI_CUSTOM_MAX) break;
  }
  return list;
}
const readAiCustomList = () => normalizeAiCustomItems(readJson("ai-custom-stocks", { items: [] }, isAiCustomList).items);
async function loadAiStockProfiles(securities, { signal, track = factory => factory() } = {}) {
  signal?.throwIfAborted();
  const list = normalizeAiCustomItems(securities);
  const industries = await track(() => resolveStockIndustries(list.map(item => item.code), { signal })).catch(() => { signal?.throwIfAborted(); return new Map(); });
  // 公告（消息面）每次最多同时取 4 只，失败不影响打分，只标记“公告未取到”。
  const notices = new Map();
  let cursor = 0;
  let deadlineTimer;
  const noticeDeadline = new Promise(resolve => { deadlineTimer = setTimeout(resolve, 15000); deadlineTimer.unref?.(); });
  const noticesDone = track(() => Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
    while (cursor < list.length) {
      const item = list[cursor++];
      signal?.throwIfAborted();
      try { notices.set(item.code, await track(() => stockAnnouncements(item.code))); } catch { notices.set(item.code, null); }
    }
  })));
  const settled = await Promise.allSettled(list.map(async item => {
    signal?.throwIfAborted();
    const chart = await track(() => getChart({ code: item.code, name: item.name, assetType: "stock" }, "101", { limit: 120 }, { signal }));
    const profile = buildStockProfile({ code: item.code, name: item.name, industry: industries.get(item.code) || "", rows: chart?.rows });
    if (!profile) throw new Error("日线数据不足");
    // 公告最多等 15 秒：来源慢或不可用时不拖住打分，没取到的按「公告未取到」处理。
    await Promise.race([noticesDone, noticeDeadline]);
    const raw = notices.get(item.code);
    return { ...profile, trend: trendText(profile), announcements: summarizeAnnouncements(raw || [], profile.asOfDate), announcementsAvailable: Array.isArray(raw) };
  }));
  clearTimeout(deadlineTimer);
  signal?.throwIfAborted();
  const profiles = [];
  const failed = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") profiles.push(outcome.value);
    else failed.push(list[index].name);
  });
  return { profiles, failed };
}
const latestDate = profiles => profiles.map(item => item.asOfDate).filter(Boolean).sort().at(-1) || "";

// AI 问股（1.6.53）：对话式个股分析。工具只读软件已有的公开行情数据；对话和偏好存在 userData/stock-agent.json。
let stockAgentInstance = null;
function stockAgent() {
  if (stockAgentInstance) return stockAgentInstance;
  // 每次调用新建一份：复盘技能内部会缓存板块数据和失败结果，长期复用会一直拿旧数据。
  const reviewSkills = () => createReviewSkills({
    loadFuyao: () => getFuyaoReviewData(),
    loadSectorBoard: () => getSectorStrengthBoard(settingsForService()),
    analyzeSector: name => analyzeSector({ name }, settingsForService()),
    loadProfiles: list => loadAiStockProfiles(list),
    previousReviews: () => [],
    situationOf
  });
  const tools = createStockAgentTools({
    search: query => searchSecurities(query),
    quote: security => getQuoteSnapshot(security, settingsForService()),
    profile: async (security, lifecycle) => {
      const { profiles, failed } = await loadAiStockProfiles([security], lifecycle);
      if (!profiles.length) throw new Error(failed.length ? `${failed[0]} 的日线没读到` : "日线没读到");
      return profiles[0];
    },
    dailyRows: async (security, limit, lifecycle) => (await lifecycle.track(() => getChart(security, "101", { limit }, { signal: lifecycle.signal })))?.rows || [],
    timeShare: (security, lifecycle) => getChart(security, "time", {}, { signal: lifecycle.signal }),
    announcements: code => stockAnnouncements(code),
    news: stock => getNewsFeed({ scope: "stock", currentStock: stock, limit: 12 }, settingsForService()),
    industry: async (code, lifecycle) => (await lifecycle.track(() => resolveStockIndustries([code], { signal: lifecycle.signal }))).get(code) || "",
    sectorDetail: name => analyzeSector({ name }, settingsForService()),
    fuyao: () => getFuyaoReviewData(),
    marketContext: value => marketFromEcology(value),
    score: (profile, market) => evaluateFramework(resolveFramework(readAiFramework()), profile, market),
    situationOf: profile => situationOf(profile),
    strategies: security => strategyHitsForStock(security),
    diagnosis: security => analyzeSecurity(security, settingsForService()),
    sectorBoard: () => getSectorStrengthBoard(settingsForService()),
    reviewSkill: (skill, args) => reviewSkills().runSkill(skill, args)
  });
  stockAgentInstance = createStockAgentService({
    // 推理模型（如 deepseek-reasoner、gemini 高推理档）读完一轮数据要想一两分钟以上，单次请求放宽到 4 分钟。
    clientFor: (config, lifecycle) => createAiClient({ getConfig: () => config, timeoutMs: 240_000, ...lifecycle }),
    resolveProfile: id => aiProfiles().resolve(String(id || "")),
    listProfiles: () => aiProfiles().list(),
    tools,
    store: { read: () => readJson("stock-agent", null, isAgentStore), write: value => writeJson("stock-agent", value, isAgentStore) }
  });
  return stockAgentInstance;
}

let thsWebViewManager = null;
function thsWebView() {
  if (!thsWebViewManager) thsWebViewManager = createThsWebViewManager({
    WebContentsView, session, getWindow: () => mainWindow,
    openExternal: url => shell.openExternal(url),
    onError: error => debugLog(`ths-web external ${error?.message || error}`)
  });
  return thsWebViewManager;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (isQuitting || !app.isReady()) return;
    showOrCreateMainWindow();
  });

  app.whenReady().then(() => {
  debugLog("app ready");
  if (keychainMigrationPending) {
    // 把钥匙串密文迁回本机加密（设置与 AI 模型配置）；下次启动起不再访问钥匙串。
    try { loadStoredSettings(); readAiProfileStore(); debugLog("keychain secrets moved back to local storage"); }
    catch (error) { runtimeErrorLog("keychain-migration", error); }
  }
  configureFuyao({ getApiKey: () => settingsForService().fuyaoApiKey });
  nativeTheme.on("updated", updateWindowChrome);
  if (process.platform === "win32") createTray();
  handleTrustedIpc("market:search", (_, query) => searchSecurities(query));
  handleTrustedIpc("market:analyze", (_, security, options = {}) =>
    analyzeSecurity(security, settingsForService({
      forceRefresh: options?.forceRefresh === true
    }))
  );
  handleTrustedIpc("market:quote", (_, security) =>
    getQuoteSnapshot(security, settingsForService())
  );
  handleTrustedIpc("market:source-health", () => getMarketSourceHealth());
  handleTrustedIpc("bond:list", (_, options = {}) => getConvertibleBonds(options));
  // 沪深港通：同花顺数据中心网页嵌入（独立会话，用户自行登录同花顺账号）。
  handleTrustedIpc("ths-web:show", (_, options = {}) => thsWebView().show({ bounds: options?.bounds, page: options?.page === "login" ? "login" : "hsgt" }));
  handleTrustedIpc("ths-web:bounds", (_, options = {}) => thsWebView().setBounds({ bounds: options?.bounds }));
  handleTrustedIpc("ths-web:hide", () => thsWebView().hide());
  handleTrustedIpc("ths-web:command", (_, options = {}) => thsWebView().command({ action: typeof options?.action === "string" ? options.action : "" }));
  handleTrustedIpc("ths-web:state", () => thsWebView().state());
  handleTrustedIpc("ai:status", () => aiService().status());
  handleTrustedIpc("ai:rank", async (_, input) => {
    const raw = aiPayload(input);
    const picks = Array.isArray(raw.picks) ? raw.picks.slice(0, AI_CUSTOM_MAX) : [];
    // only：只给勾选的这几只打分；display：页面上的整张候选清单（结果按它取）。
    const only = Array.isArray(raw.only) ? raw.only.map(String).filter(code => /^\d{6}$/.test(code)).slice(0, AI_CUSTOM_MAX) : null;
    const payload = { ...raw, picks, display: picks.map(item => String(item?.code || "")), ...(only ? { only } : {}) };
    // 只给还没打分（或要重新打分）的股票读日线；都打过了直接返回本机结果。
    const todo = new Set(aiService().pending("rank", payload));
    if (!todo.size) return aiService().cachedRank(payload) || aiService().rank(payload);
    // 策略候选也读日线算体检数据，按分析框架打分；读不到时退回只用规则指标。
    const targets = picks.filter(item => todo.has(String(item?.code || "")));
    const { profiles } = await loadAiStockProfiles(targets).catch(() => ({ profiles: [] }));
    const byCode = new Map(targets.map(item => [String(item?.code || ""), item]));
    const merged = profiles.map(profile => ({ ...profile, strategies: byCode.get(profile.code)?.strategies || [], notes: byCode.get(profile.code)?.notes || [] }));
    // 部分股票日线没读到：这次不参与打分，并把名单告诉页面（以前静默略过，看起来像漏打）。
    const profiled = new Set(merged.map(item => String(item.code)));
    const failed = merged.length ? targets.filter(item => !profiled.has(String(item?.code || ""))).map(item => String(item?.name || item?.code || "")) : [];
    const ranking = await aiService().rank({ ...payload, only: merged.length ? [...profiled] : [...todo], ...(merged.length ? { profiles: merged } : {}) });
    return failed.length ? { ...ranking, failed } : ranking;
  });
  // AI 复盘：市场复盘与回看用专业复盘的同一份快照（主进程读取，不信任页面传来的统计）。
  const shanghaiToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const reviewSnapshot = () => getProfessionalReview({ settings: settingsForService() });
  // 复盘技能：AI 写市场复盘时可自主调用（板块强度、涨停原因、梯队、炸板、热股、龙虎榜、异动、板块成分、个股体检、历次复盘）。
  const reviewSkillsFor = snapshot => createReviewSkills({
    loadFuyao: () => getFuyaoReviewData(),
    loadSectorBoard: () => getSectorStrengthBoard(settingsForService()),
    analyzeSector: name => analyzeSector({ name }, settingsForService()),
    loadProfiles: list => loadAiStockProfiles(list),
    previousReviews: count => aiService().recentMarketReviews(String(snapshot?.date || ""), count),
    situationOf
  });
  handleTrustedIpc("ai:market-review", async (_, input) => {
    const snapshot = await reviewSnapshot();
    return aiService().marketReview({ snapshot, force: aiPayload(input).force === true, skills: reviewSkillsFor(snapshot) });
  });
  handleTrustedIpc("ai:lookback", async (_, input) => aiService().lookback({ snapshot: await reviewSnapshot(), force: aiPayload(input).force === true }));
  handleTrustedIpc("ai:market-review-cached", (_, asOfDate) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || "")) ? String(asOfDate) : shanghaiToday();
    const previous = aiService().previousMarketReview(date);
    return { review: aiService().cachedMarketReview(date), lookback: aiService().cachedLookback(date), previousDate: previous?.asOfDate || "" };
  });
  const interpretKind = kind => ["ecology", "failed-boards", "sectors"].includes(kind) ? kind : null;
  const interpretDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : shanghaiToday();
  handleTrustedIpc("ai:interpret", (_, input) => {
    const payload = aiPayload(input);
    const kind = interpretKind(payload.kind);
    if (!kind) throw Object.assign(new TypeError("不支持的解读类型"), { code: "INVALID_IPC_PAYLOAD" });
    return aiService().interpret({ kind, data: payload.data, asOfDate: interpretDate(payload.asOfDate), force: payload.force === true });
  });
  handleTrustedIpc("ai:interpret-cached", (_, input) => {
    const payload = aiPayload(input);
    const kind = interpretKind(payload.kind);
    return kind ? aiService().cachedInterpret(kind, interpretDate(payload.asOfDate)) : null;
  });
  handleTrustedIpc("ai:frameworks", () => frameworkCatalog(readAiFramework()));
  handleTrustedIpc("ai:framework-save", (_, input) => {
    const payload = aiPayload(input);
    const current = readAiFramework();
    const next = normalizeFrameworkState({
      v: 2,
      active: typeof payload.active === "string" ? payload.active : current.active,
      custom: payload.custom ? normalizeCustom(payload.custom) : current.custom
    });
    writeJson("ai-framework", next, isAiFrameworkState);
    return frameworkCatalog(next);
  });
  handleTrustedIpc("ai:summary", (_, input) => aiService().summary(aiPayload(input)));
  handleTrustedIpc("ai:cached", (_, input) => { const payload = aiPayload(input); return { rank: aiService().cachedRank(payload), summary: aiService().cachedSummary(payload) }; });
  handleTrustedIpc("ai:history", () => aiService().history());
  handleTrustedIpc("ai:review", async (_, input) => {
    const payload = aiPayload(input);
    const { profiles, failed } = await loadAiStockProfiles([payload.security]);
    if (!profiles.length) throw new Error(failed.length ? `读取${failed[0]}日线失败，暂时无法点评，请稍后重试` : "请选择一只 A 股股票");
    // 个股复盘页会带上复盘诊断要点（文字），供 AI 结合参考。
    const context = (Array.isArray(payload.context) ? payload.context : []).map(item => String(item || "").slice(0, 60)).filter(Boolean).slice(0, 8);
    return aiService().review({ asOfDate: profiles[0].asOfDate, profile: context.length ? { ...profiles[0], context } : profiles[0], force: payload.force === true });
  });
  handleTrustedIpc("ai:review-cached", (_, code) => /^\d{6}$/.test(String(code || "")) ? aiService().cachedReview(String(code)) : null);
  handleTrustedIpc("ai:custom-list", () => readAiCustomList());
  handleTrustedIpc("ai:custom-save", (_, items) => {
    const list = normalizeAiCustomItems(items);
    writeJson("ai-custom-stocks", { items: list }, isAiCustomList);
    return list;
  });
  handleTrustedIpc("ai:custom-rank", async (_, input) => {
    const payload = aiPayload(input);
    const list = readAiCustomList();
    if (!list.length) throw new Error("先添加要打分的股票");
    // codes：只给勾选的这几只打分（必须在清单里）；不带时给整张清单打分。
    const only = Array.isArray(payload.codes) ? new Set(payload.codes.map(String)) : null;
    const targets = only ? list.filter(item => only.has(item.code)) : list;
    if (!targets.length) throw new Error("勾选的股票不在清单里，请刷新后重试");
    const { profiles, failed } = await loadAiStockProfiles(targets);
    if (!profiles.length) throw new Error(targets.length === 1 ? `${targets[0].name} 的日线没读到，请稍后重试` : "这些股票的日线都没读到，请稍后重试");
    const ranking = await aiService().rankCustom({ asOfDate: latestDate(profiles), profiles, display: list.map(item => item.code), force: payload.force === true });
    return { ...ranking, failed };
  });
  handleTrustedIpc("ai:custom-cached", () => aiService().cachedCustom(readAiCustomList().map(item => item.code)));
  handleTrustedIpc("ai:history-day", (_, asOfDate) => aiService().historyDay(String(asOfDate || "").slice(0, 10)));
  handleTrustedIpc("ai:strategy-draft", (_, input) => aiService().draftStrategy(aiPayload(input)));
  // 随心记「AI 整理」：只发这段文字、当前时间和接下来的交易日。
  handleTrustedIpc("ai:note-parse", (_, input) => {
    const payload = aiPayload(input);
    return aiService().parseNote({ text: String(payload.text ?? "").slice(0, 600), now: String(payload.now ?? "").slice(0, 40),
      tradingDays: Array.isArray(payload.tradingDays) ? payload.tradingDays.slice(0, 15).map(day => String(day).slice(0, 10)) : [] });
  });
  handleTrustedIpc("ai:profiles", () => aiProfiles().list());
  handleTrustedIpc("ai:profile-save", (_, input) => aiProfiles().save(aiPayload(input)));
  handleTrustedIpc("ai:profile-delete", (_, id) => aiProfiles().remove(String(id || "")));
  handleTrustedIpc("ai:profile-activate", (_, id) => aiProfiles().activate(String(id || "")));
  handleTrustedIpc("ai:rank-models", (_, ids) => aiProfiles().setRankIds(Array.isArray(ids) ? ids.slice(0, 8) : []));
  handleTrustedIpc("ai:test", (_, input) => {
    // 测试设置页正在编辑的草稿：Key 未修改（掩码）时用这套配置已保存的 Key。
    const payload = aiPayload(input);
    const saved = typeof payload.id === "string" && payload.id ? aiProfiles().resolve(payload.id) : null;
    return aiService().test({
      baseUrl: String(payload.baseUrl || ""), model: String(payload.model || ""),
      // 换了域名测试时不带上旧 Key（避免把 Key 发给新地址），提示重新填写。
      apiKey: resolveTestSecret(payload.apiKey, saved?.apiKey && sameOrigin(saved.baseUrl, payload.baseUrl) ? saved.apiKey : "")
    });
  });
  // AI 问股：开始一轮分析立即返回 runId，页面轮询进度（工具调用步骤）直到完成。
  handleTrustedIpc("agent:state", () => stockAgent().state());
  handleTrustedIpc("agent:conversation", (_, id) => stockAgent().conversation(String(id || "").slice(0, 80)));
  handleTrustedIpc("agent:start", (_, input) => {
    const payload = aiPayload(input);
    return stockAgent().start({ message: typeof payload.message === "string" ? payload.message : "",
      title: typeof payload.title === "string" ? payload.title.slice(0, 16) : "",
      conversationId: typeof payload.conversationId === "string" ? payload.conversationId.slice(0, 80) : "",
      // focus：没传 = 沿用对话里的股票；传 null = 清除。
      ...(Object.hasOwn(payload, "focus") ? { focus: payload.focus && typeof payload.focus === "object" ? { code: String(payload.focus.code || ""), name: String(payload.focus.name || "") } : null } : {}),
      ...(Array.isArray(payload.skillIds) ? { skillIds: payload.skillIds.slice(0, 6).map(item => String(item).slice(0, 40)) } : {}) });
  });
  handleTrustedIpc("agent:poll", (_, runId) => stockAgent().poll(String(runId || "").slice(0, 80)));
  handleTrustedIpc("agent:cancel", (_, runId) => stockAgent().cancel(String(runId || "").slice(0, 80)));
  handleTrustedIpc("agent:delete", (_, id) => stockAgent().remove(String(id || "").slice(0, 80)));
  handleTrustedIpc("agent:settings", (_, input) => {
    const payload = aiPayload(input);
    return stockAgent().settings({ ...(typeof payload.memory === "string" ? { memory: payload.memory } : {}),
      ...(typeof payload.profileId === "string" ? { profileId: payload.profileId.slice(0, 80) } : {}),
      ...(Array.isArray(payload.skillIds) ? { skillIds: payload.skillIds.slice(0, 6).map(item => String(item).slice(0, 40)) } : {}) });
  });
  // AI 问股的自定义打法：名称、判断要点、要看的数据（主进程再校验一遍长度和数据项）。
  handleTrustedIpc("agent:skill-save", (_, input) => {
    const payload = aiPayload(input);
    return stockAgent().saveSkill({ id: typeof payload.id === "string" ? payload.id.slice(0, 40) : "", name: String(payload.name ?? "").slice(0, 40),
      method: String(payload.method ?? "").slice(0, 2000), tools: Array.isArray(payload.tools) ? payload.tools.slice(0, 20).map(item => String(item).slice(0, 30)) : [] });
  });
  handleTrustedIpc("agent:skill-delete", (_, id) => stockAgent().removeSkill(String(id || "").slice(0, 40)));
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
  handleTrustedIpc("sector:classifications", (_, options = {}) => getSectorClassifications(options));
  handleTrustedIpc("sector:catalog", (_, options = {}) => getSectorCatalog(options));
  handleTrustedIpc("sector:quotes", (_, options = {}) => getSectorQuotes(options));
  handleTrustedIpc("sector:detail", (_, options = {}) => getSectorDetail(options));
  handleTrustedIpc("sector:cancel", (_, requestId) => cancelSectorRequest(requestId));
  handleTrustedIpc("strategy:definitions", () => getStrategyDefinitions());
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
    trendScanOwner = { sender: event.sender, jobId: status.jobId };
    return status;
  });
  handleTrustedIpc("trend-screener:status", (_, cursor) => trendScreener.getStatus(cursor));
  handleTrustedIpc("trend-screener:cancel", () => {
    trendScanOwner = undefined;
    return trendScreener.cancel();
  });
  handleTrustedIpc("market:limit-up-sectors", (_, options = {}) =>
    getLimitUpSectorBoard({
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true
    })
  );
  handleTrustedIpc("market:sector-strength", (_, options = {}) =>
    getSectorStrengthBoard({ ...settingsForService(), forceRefresh: options?.forceRefresh === true })
  );
  handleTrustedIpc("market:sector-limit-count", (_, input, options = {}) =>
    getSectorLimitUpCount(input, { forceRefresh: options?.forceRefresh === true })
  );
  handleTrustedIpc("market:search-sectors", (_, query) => searchSectors(query));
  handleTrustedIpc("market:concept-chain", (_, query) =>
    getConceptChain(query, settingsForService())
  );
  handleTrustedIpc("market:analyze-sector", (_, sector) =>
    analyzeSector(sector, settingsForService())
  );
  handleTrustedIpc("review:get-market", (_, options = {}) => {
    return getProfessionalReview({
      ...options,
      settings: settingsForService()
    });
  });
  handleTrustedIpc("review:open-window", () => reviewWindows.open());
  for (const [channel, handler] of Object.entries({
    'review-window:search': (_, query) => searchSecurities(query),
    'review-window:analyze': (_, security) => analyzeSecurity(security, settingsForService()),
    'review-window:market': (_, options = {}) => getProfessionalReview({ refresh: options?.refresh === true, settings: settingsForService() }),
    'review-window:theme': () => ({ theme: themeMode })
  })) handleTrustedIpc(channel, handler, reviewWindows.getWebContents);
  handleTrustedIpc("news:get-feed", (_, input) =>
    getNewsFeed(input || {}, settingsForService())
  );
  handleTrustedIpc("news:refresh", (_, input) => {
    resetNewsCache();
    return getNewsFeed(input || {}, settingsForService());
  });
  handleTrustedIpc("backtest:run", (event, input, options = {}) => {
    const safeOptions = options && typeof options === "object" && !Array.isArray(options)
      ? { ...options }
      : {};
    const allowedOverrides = pickBacktestSettingOverrides(safeOptions.settings);
    const mergedSettings = settingsForService(allowedOverrides);
    safeOptions.settings = pickBacktestSettingOverrides(mergedSettings);
    return runBacktest(input, mergedSettings, safeOptions, serviceRequestRuntime(event, {
      requestId: safeOptions.requestId ?? input?.requestId,
      timeoutMs: safeOptions.timeoutMs ?? input?.timeoutMs
    }));
  });
  handleTrustedIpc("backtest:run-portfolio", (event, input = {}) =>
    runPortfolioBacktest(input, settingsForService(), serviceRequestRuntime(event, input))
  );
  handleTrustedIpc("watchlist:get", () => normalizeWatchlist(readJson("watchlist", [], usableWatchlist)));
  handleTrustedIpc("watchlist:save", (_, items) => {
    if (!Array.isArray(items)) throw Object.assign(new TypeError("观察池保存参数必须为数组"), { code: "INVALID_IPC_PAYLOAD" });
    if (!usableWatchlist(items)) throw Object.assign(new Error("自选列表没有有效股票"), { code: "INVALID_IPC_PAYLOAD" });
    return writeJson("watchlist", normalizeWatchlist(items), usableWatchlist);
  });
  handleTrustedIpc("holdings:get", () => normalizeHoldings(readJson("holdings", [], usableHoldings)));
  // ERR-03：让渲染层能查询本次启动是否发生过本地数据损坏，
  // 以便显示一次性提示（而不是让用户以为数据本来就是空的）。
  handleTrustedIpc("diagnostics:corrupted-on-load", () => getCorruptedOnLoad());
  handleTrustedIpc("holdings:save", (_, items) => {
    if (!Array.isArray(items)) throw Object.assign(new TypeError("持仓保存参数必须为数组"), { code: "INVALID_IPC_PAYLOAD" });
    if (!usableHoldings(items)) throw Object.assign(new Error("持仓列表没有有效股票"), { code: "INVALID_IPC_PAYLOAD" });
    return writeJson("holdings", normalizeHoldings(items), usableHoldings);
  });
  handleTrustedIpc("settings:get", () => publicSettings());
  handleTrustedIpc("settings:save", (_, next) => {
    const input = next && typeof next === "object" && !Array.isArray(next) ? next : {};
    const previous = loadStoredSettings();
    const refreshToken = resolveStoredSecret(input.refreshToken, previous.refreshToken, encryptSecret);
    const tushareToken = resolveStoredSecret(input.tushareToken, previous.tushareToken, encryptSecret);
    const fuyaoApiKey = resolveStoredSecret(input.fuyaoApiKey, previous.fuyaoApiKey, encryptSecret);
    const aiApiKey = resolveStoredSecret(input.aiApiKey, previous.aiApiKey, encryptSecret);
    const secretsChanged = refreshToken !== previous.refreshToken
      || tushareToken !== previous.tushareToken
      || fuyaoApiKey !== previous.fuyaoApiKey
      || aiApiKey !== previous.aiApiKey;
    const saved = writeSettings(
      normalizeSettings({ ...previous, ...input, refreshToken, tushareToken, fuyaoApiKey, aiApiKey }),
      secretsChanged
    );
    loadStoredSettings.cached = saved;
    settingsForService.cached = undefined;
    resetNewsCache();
    resetProfessionalReviewCache();
    reviewWindows.broadcastTheme(applyWindowTheme(saved.theme));
    return publicSettings();
  });
  handleTrustedIpc("app:set-theme", (_, theme) => {
    // 已打开的独立复盘窗口常驻副屏，主题需即时跟随而非等到窗口重新聚焦。
    reviewWindows.broadcastTheme(applyWindowTheme(theme));
  });
  handleTrustedIpc("app:window-control", (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return { ok: false, maximized: false };
    if (action === "minimize") {
      window.minimize();
    } else if (action === "toggle-maximize") {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    } else if (action === "close") {
      window.close();
      return { ok: true, maximized: false };
    } else {
      throw new Error("不支持的窗口操作");
    }
    return { ok: true, maximized: window.isMaximized() };
  });
  // 数据备份（1.6.64）：写到用户选的文件夹（网盘同步文件夹即可上传到网盘）。文件夹只能从系统对话框或推荐列表来。
  const backupValidators = {
    settings: isSettingsRecord, watchlist: usableWatchlist, holdings: usableHoldings, "custom-strategies": isCustomStrategyStore,
    "ai-profiles": isAiProfileStore, "ai-framework": isAiFrameworkState, "ai-custom-stocks": isAiCustomList, "ai-selection": isAiStore, "stock-agent": isAgentStore
  };
  const backup = createBackupService({
    readStore: name => readJson(name, null, backupValidators[name]),
    writeStore: (name, value) => {
      if (!backupValidators[name](value)) throw Object.assign(new Error(`备份里的「${name}」数据格式不对，已跳过恢复`), { code: "BACKUP_INVALID" });
      writeJson(name, value, backupValidators[name], true);
    },
    readConfig: () => readJson("backup-config", {}, isSettingsRecord),
    writeConfig: value => writeJson("backup-config", value, isSettingsRecord),
    encryptSecret, decryptSecret, appVersion: app.getVersion()
  });
  const backupStatus = () => ({ ...backup.status(), suggestions: backup.suggestions() });
  const backupLocal = input => {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const local = {};
    let bytes = 0;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "string" || key.length > 120) continue;
      bytes += key.length + item.length;
      if (bytes > 48 * 1024 * 1024) throw Object.assign(new Error("本地数据过大，无法备份"), { code: "BACKUP_TOO_LARGE" });
      local[key] = item;
    }
    return local;
  };
  handleTrustedIpc("backup:status", () => backupStatus());
  handleTrustedIpc("backup:choose-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择备份文件夹（选网盘的同步文件夹会自动上传到网盘）", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths?.[0]) return backupStatus();
    backup.configure({ folder: result.filePaths[0] });
    return backupStatus();
  });
  handleTrustedIpc("backup:configure", (_, input) => {
    const patch = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const next = {};
    if (typeof patch.suggestedFolder === "string") {
      const hit = backup.suggestions().find(item => item.path === patch.suggestedFolder);
      if (!hit) throw Object.assign(new Error("这个文件夹不在推荐列表里，请用「选择文件夹」"), { code: "BACKUP_FOLDER" });
      next.folder = hit.path;
    }
    if (typeof patch.auto === "boolean") next.auto = patch.auto;
    if (patch.keep !== undefined) next.keep = patch.keep;
    if (typeof patch.password === "string") next.password = patch.password;
    backup.configure(next);
    return backupStatus();
  });
  handleTrustedIpc("backup:run", (_, local, options) => {
    const reason = options && options.reason === "auto" ? "auto" : "manual";
    return { ...backup.run(backupLocal(local), { reason }), status: backupStatus() };
  });
  handleTrustedIpc("backup:inspect", (_, name, password) => backup.inspect(String(name || ""), typeof password === "string" ? password : ""));
  handleTrustedIpc("backup:restore", (_, name, password) => backup.restore(String(name || ""), typeof password === "string" ? password : ""));
  handleTrustedIpc("backup:relaunch", async () => {
    // 恢复后重启：先把渲染进程刚写的本地存储刷到磁盘。
    try { await mainWindow?.webContents.session.flushStorageData(); } catch { /* 刷盘失败也继续重启 */ }
    setTimeout(() => { app.relaunch(); app.quit(); }, 200);
    return { ok: true };
  });

  // 随心记提醒：用系统通知，窗口在后台或最小化时也能看到；点通知回到软件。只接受短文本。
  handleTrustedIpc("app:notify", (_, input) => showSystemNotification(input));
  handleTrustedIpc("notes:interval-sync", (_, input) => intervalReminders.sync(input));
  powerMonitor.on("resume", intervalReminders.tick);
  // 随心记的价格条件：主进程在交易时段盯报价，满足就发系统通知；页面同步时取走触发记录。
  handleTrustedIpc("notes:watch-sync", (_, input) => {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return noteWatcher().sync({ items: Array.isArray(value.items) ? value.items.slice(0, 60) : [], systemNotify: value.systemNotify !== false });
  });
  handleTrustedIpc("settings:test-provider", (_, next) => {
    const input = next && typeof next === "object" && !Array.isArray(next) ? next : {};
    const saved = settingsForService();
    const merged = settingsForService({
      ...input,
      refreshToken: resolveTestSecret(input.refreshToken, saved.refreshToken),
      tushareToken: resolveTestSecret(input.tushareToken, saved.tushareToken),
      fuyaoApiKey: resolveTestSecret(input.fuyaoApiKey, saved.fuyaoApiKey)
    });
    return testProvider(merged);
  });
  handleTrustedIpc("shell:open-external", (_, url) => {
    const safeUrl = normalizeExternalHttpsUrl(url);
    if (!safeUrl) throw new Error("仅允许打开不含账号凭据的 HTTPS 链接");
    return shell.openExternal(safeUrl);
  });
  handleTrustedIpc("app:version", () => app.getVersion());

  if (!focusMainWindow()) createWindow();
  app.on("activate", () => {
    showOrCreateMainWindow();
  });
  }).catch((error) => {
    runtimeErrorLog("whenReady", error);
    app.quit();
  });
}

const finishShutdown = createShutdownGate({
  cleanup: async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(shutdownServiceResources),
      Promise.resolve().then(shutdownThsTokenManager),
      Promise.resolve().then(() => aiServiceInstance?.shutdown()),
      Promise.resolve().then(() => stockAgentInstance?.shutdown())
    ]);
    for (const result of results) if (result.status === "rejected") runtimeErrorLog("shutdown-resource", result.reason);
  },
  complete: () => app.quit(),
  onError: error => runtimeErrorLog("shutdown-cleanup", error)
});

app.on("before-quit", (event) => {
  isQuitting = true;
  cancelRendererRecovery();
  trendScanOwner = undefined;
  trendScreener.cancel();
  noteWatcherInstance?.stop();
  intervalReminders.stop();
  finishShutdown(event);
});

app.on("will-quit", destroyTray);

app.on("window-all-closed", () => {
  if (process.platform === "darwin") {
    debugLog("all windows closed; macOS application remains available from Dock");
    return;
  }
  if (process.platform !== "win32") {
    debugLog("all windows closed; quitting application");
    app.quit();
    return;
  }
  debugLog("all windows closed; tray process remains active");
});
