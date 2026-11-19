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
  Notification,
  screen
} = require("electron");
const path = require("path");
const fs = require("fs");
const { createRuntimeLogger } = require("./runtime-diagnostics.cjs");
const { pathToFileURL } = require("node:url");
const { createCustomStrategyStore } = require("./custom-strategy-store.cjs");
const { createLocalSecretStorage, createLocalFirstSecretStorage, hasSystemCiphertext } = require("./local-secret-storage.cjs");
const { migrateLegacyUserData } = require("./user-data-migration.cjs");
const {
  capItemsPreservingFavorites,
  readJsonWithBackup,
  tightenUserDataPermissions,
  writeJsonAtomic
} = require("./persistence.cjs");

if (process.env.A_STOCK_E2E_USER_DATA) {
  const isolatedUserData = path.resolve(process.env.A_STOCK_E2E_USER_DATA);
  fs.mkdirSync(isolatedUserData, { recursive: true });
  app.setPath("userData", isolatedUserData);
  app.setPath("sessionData", path.join(isolatedUserData, "session"));
} else {
  try {
    migrateLegacyUserData({ userDataDir: app.getPath("userData") });
  } catch (error) {
    process.stderr.write(`[userData-migration] ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
try {
  tightenUserDataPermissions(app.getPath("userData"));
} catch {
  // Permission tightening is best-effort and must never block startup.
}

// 1.6.49：不再使用 macOS 钥匙串（每次更新重新签名后都会弹登录密码）。
// 只有本机设置里还留着 1.6.48 写入的钥匙串密文时，这一次启动才访问钥匙串把它们迁回本机加密；
// 迁完之后的启动都用 Chromium 的模拟钥匙串，不再碰系统钥匙串。
const keychainMigrationPending = (() => {
  try {
    // 主文件和 .last-good 备份都检查：主文件损坏时会从备份恢复，备份里的钥匙串密文也要能迁回。
    return [
      "settings",
      "settings.last-good",
      "ai-profiles",
      "ai-profiles.last-good",
      "backup-config",
      "backup-config.last-good"
    ].some(name => {
      try { return hasSystemCiphertext(JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), `${name}.json`), "utf8"))); }
      catch { return false; }
    });
  } catch { return false; }
})();
if (process.platform === "darwin" && !keychainMigrationPending) app.commandLine?.appendSwitch?.("use-mock-keychain");
const {
  createTrustedIpcHandler,
  withIpcResult,
  decryptStoredSecret,
  encryptSecretForStorage,
  isAllowedRendererNavigation,
  migrateLegacyStoredSecrets,
  normalizeExternalHttpsUrl,
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
const { createAiService, marketFromEcology, isAiStore, evaluateRowsOutcome } = require("./ai-service.cjs");
const { buildStockProfile, trendText, summarizeAnnouncements } = require("./stock-profile.cjs");
const { frameworkCatalog, normalizeCustom, normalizeFrameworkState, situationOf, evaluateFramework, resolveFramework } = require("./ai-frameworks.cjs");
const { createReviewSkills } = require("./review-skills.cjs");
const { createAiProfileStore, isAiProfileStore, sameOrigin } = require("./ai-profile-store.cjs");
const { createAiClient } = require("./ai-client.cjs");
const { createStockAgentService, isAgentStore } = require("./stock-agent.cjs");
const { createBackupService } = require("./data-backup.cjs");
const { createStockAgentTools } = require("./stock-agent-tools.cjs");
const { prepareSingleBacktestRequest } = require("./portfolio-backtest.cjs");
const { validateIpcPayload } = require("./ipc/contract.cjs");
const { registerAllIpc } = require("./ipc/register-all.cjs");
const { buildNewsImpactPromptInput } = require("./news-service.cjs");
const trendScreener = createTrendScreenerService(createTrendMarketData({ ths: trendThsLane, dailyStore: dailyBarStore, asOf: dailyBarAsOf }));
const reviewWindows = createReviewWindowManager({ BrowserWindow, screen, root: path.join(__dirname, '..'), packaged: app.isPackaged, devUrl: process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173', hidden: process.env.A_STOCK_E2E_HIDDEN === '1', openExternal: url => shell.openExternal(url), onError: error => debugLog(`review external ${error.message}`) });

let mainWindow;
let tray;
let themeMode = "system";
let isQuitting = false;
let restoredProfilePendingRestart = false;
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
  if (restoredProfilePendingRestart) {
    throw Object.assign(new Error("备份恢复完成，应用正在重启"), { code: "BACKUP_RESTARTING" });
  }
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
      assetType: row?.assetType === "etf"
        ? "etf"
        : row?.assetType === "convertibleBond" || row?.assetType === "bond"
          ? "convertibleBond"
          : "stock",
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
    minExpectancyPoints: clampNumber(input.minExpectancyPoints, -2, 8, fallback.minExpectancyPoints),
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
    trailingStopPercent: clampNumber(input.trailingStopPercent, 0, 25, fallback.trailingStopPercent),
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

function backupHasSystemCiphertext(name) {
  try {
    return hasSystemCiphertext(JSON.parse(fs.readFileSync(backupJsonPath(name), "utf8")));
  } catch {
    return false;
  }
}

function loadStoredSettings() {
  if (loadStoredSettings.cached) return loadStoredSettings.cached;
  const stored = normalizeSettings({ ...defaultSettings(), ...readJson("settings", {}, isSettingsRecord) });
  const migration = migrateLegacyStoredSecrets(stored, SECRET_SETTING_KEYS, secretStorage());
  if (migration.deferredKeys.length) return stored;
  const shouldSyncStaleBackup = !migration.migrated && backupHasSystemCiphertext("settings");
  if (!migration.migrated && !shouldSyncStaleBackup) return (loadStoredSettings.cached = stored);
  try {
    const saved = writeSettings(normalizeSettings(migration.settings), true);
    if (migration.migrated) debugLog(`migrated legacy secrets count=${migration.migratedKeys.length}`);
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

const MAX_ACTIVE_NOTIFICATIONS = 32;
const activeNotifications = new Set();

function showSystemNotification(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const title = String(value.title || "").trim().slice(0, 60);
  const body = String(value.body || "").trim().slice(0, 240);
  if (!title) throw new Error("通知标题为空");
  if (isQuitting || process.env.A_STOCK_E2E_HIDDEN === "1") return { shown: false };
  if (
    process.platform === "darwin"
    && app.dock
    && (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused())
  ) {
    app.dock.bounce("informational");
  }
  if (!Notification.isSupported()) return { shown: false };
  const notification = new Notification({ title, body, silent: false });
  const releaseNotification = () => { activeNotifications.delete(notification); };
  if (activeNotifications.size >= MAX_ACTIVE_NOTIFICATIONS) {
    const oldest = activeNotifications.values().next().value;
    activeNotifications.delete(oldest);
  }
  activeNotifications.add(notification);
  notification.on("click", () => showOrCreateMainWindow());
  notification.once("click", releaseNotification);
  notification.once("close", releaseNotification);
  notification.once("failed", releaseNotification);
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
      getQuote: security => getQuoteSnapshot(security, settingsForService()).catch(error => {
        throw Object.assign(new Error(redactRuntimeText(error?.message || error)), { code: error?.code });
      }),
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

function handleTrustedIpc(channel, rawHandler, getTrustedWebContents = trustedMainWebContents) {
  const review = getTrustedWebContents === reviewWindows.getWebContents;
  const file = review ? "review/review.html" : "index.html";
  const dev = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const entry = app.isPackaged ? pathToFileURL(path.join(__dirname, "..", "dist", file)).href
    : review ? new URL("review.html", dev.replace(/\/?$/, "/")).href : new URL(dev).href;
  const handler = (event, ...args) => {
    validateIpcPayload(channel, args);
    return rawHandler(event, ...args);
  };
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
  let primaryWorkArea;
  try {
    primaryWorkArea = screen?.getPrimaryDisplay?.()?.workAreaSize;
  } catch {
    primaryWorkArea = undefined;
  }
  const workWidth = Number(primaryWorkArea?.width) > 0 ? Number(primaryWorkArea.width) : 1480;
  const workHeight = Number(primaryWorkArea?.height) > 0 ? Number(primaryWorkArea.height) : 940;
  const createdWindow = new BrowserWindow({
    show: !hiddenE2E,
    width: Math.min(1480, workWidth),
    height: Math.min(940, workHeight),
    minWidth: 1024,
    minHeight: 640,
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
  const shouldSyncStaleBackup = !changed && backupHasSystemCiphertext("ai-profiles");
  if ((!changed && !shouldSyncStaleBackup) || deferred) return stored;
  const nextStore = { ...stored, profiles };
  try {
    return writeJson("ai-profiles", nextStore, isAiProfileStore, true);
  } catch (error) {
    runtimeErrorLog("secret-migration-failed", error, "ai-profiles");
    return nextStore;
  }
}

function directoryBytesBounded(rootDir, maxDepth = 3) {
  if (!rootDir || maxDepth < 0) return 0;
  let total = 0;
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isFile()) {
        try { total += fs.statSync(fullPath).size; } catch { /* ignore */ }
      } else if (entry.isDirectory() && maxDepth > 0) {
        total += directoryBytesBounded(fullPath, maxDepth - 1);
      }
    }
  } catch {
    return 0;
  }
  return total;
}

const STORAGE_SUMMARY_TTL_MS = 60_000;
let cachedStorageSummary = null;

function computeStorageSummary() {
  const userDataDir = app.getPath("userData");
  const nowMs = Date.now();
  if (
    cachedStorageSummary
    && cachedStorageSummary.userDataDir === userDataDir
    && nowMs - cachedStorageSummary.computedAt < STORAGE_SUMMARY_TTL_MS
  ) {
    return { ...cachedStorageSummary.value };
  }
  let userDataBytes = 0;
  try {
    const entries = fs.readdirSync(userDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      try { userDataBytes += fs.statSync(path.join(userDataDir, entry.name)).size; } catch { /* ignore */ }
    }
  } catch {
    userDataBytes = 0;
  }
  userDataBytes += directoryBytesBounded(path.join(userDataDir, "Local Storage"), 2);
  const barStats = typeof dailyBarStore?.getStorageStats === "function"
    ? dailyBarStore.getStorageStats()
    : { fileCount: 0, totalBytes: 0 };
  let sessionDir = "";
  try { sessionDir = app.getPath("sessionData"); } catch { sessionDir = ""; }
  const cacheRoots = new Set();
  for (const base of [userDataDir, sessionDir].filter(Boolean)) {
    for (const sub of ["Cache", "Code Cache", "GPUCache", path.join("Partitions", "ths-web", "Cache"), path.join("Partitions", "ths-web", "Code Cache"), path.join("Partitions", "ths-web", "GPUCache")]) {
      cacheRoots.add(path.join(base, sub));
    }
  }
  let webCacheBytes = 0;
  for (const cacheRoot of cacheRoots) {
    webCacheBytes += directoryBytesBounded(cacheRoot, 3);
  }
  const value = {
    userDataBytes,
    dailyBarsBytes: barStats.totalBytes,
    dailyBarsCount: barStats.fileCount,
    webCacheBytes
  };
  cachedStorageSummary = { userDataDir, computedAt: nowMs, value };
  return { ...value };
}

function readMigratedBackupConfig() {
  const stored = readJson("backup-config", {}, isSettingsRecord);
  const migration = migrateLegacyStoredSecrets(stored, ["password"], secretStorage());
  const shouldSyncStaleBackup = !migration.migrated && backupHasSystemCiphertext("backup-config");
  if (migration.deferredKeys.length || (!migration.migrated && !shouldSyncStaleBackup)) return stored;
  try {
    return writeJson("backup-config", migration.settings, isSettingsRecord, true);
  } catch (error) {
    runtimeErrorLog("secret-migration-failed", error, "backup-config");
    return migration.settings;
  }
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
    loadMarket: async () => marketFromEcology(await getFuyaoReviewData()),
    resolveStock: query => searchSecurities(query),
    evaluateOutcomes: async (asOfDate, codes) => {
      const date = String(asOfDate || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(codes) || !codes.length) return {};
      const out = {};
      await Promise.allSettled(codes.slice(0, 40).map(async code => {
        const cached = await dailyBarStore.peek(code);
        const outcome = evaluateRowsOutcome(cached?.rows, date, code);
        if (outcome) out[code] = outcome;
      }));
      return out;
    }
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
function normalizeAiCustomItem(raw) {
  const code = String(raw?.code || "").trim();
  if (!/^\d{6}$/.test(code)) return null;
  return { code, name: String(raw?.name || code).replace(/\s+/g, "").slice(0, 12) || code };
}
function normalizeAiCustomItems(items) {
  const seen = new Set();
  const list = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeAiCustomItem(raw);
    if (!item || seen.has(item.code)) continue;
    seen.add(item.code);
    list.push(item);
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
  let noticesStopped = false;
  let deadlineTimer;
  const noticeDeadline = new Promise(resolve => {
    deadlineTimer = setTimeout(() => {
      noticesStopped = true;
      resolve();
    }, 15000);
    deadlineTimer.unref?.();
  });
  const noticesDone = track(() => Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
    while (!noticesStopped && cursor < list.length && !signal?.aborted) {
      const item = list[cursor++];
      try {
        signal?.throwIfAborted();
        const rows = await track(() => stockAnnouncements(item.code));
        if (!noticesStopped) notices.set(item.code, rows);
      } catch {
        notices.set(item.code, null);
        if (signal?.aborted) break;
      }
    }
  })));
  noticesDone.catch(() => {});
  let settled;
  try {
    settled = await Promise.allSettled(list.map(async item => {
      signal?.throwIfAborted();
      const chart = await track(() => getChart({ code: item.code, name: item.name, assetType: "stock" }, "101", { limit: 120 }, { signal }));
      const profile = buildStockProfile({ code: item.code, name: item.name, industry: industries.get(item.code) || "", rows: chart?.rows });
      if (!profile) throw new Error("日线数据不足");
      // 公告最多等 15 秒：来源慢或不可用时不拖住打分，没取到的按「公告未取到」处理。
      await Promise.race([noticesDone, noticeDeadline]);
      const raw = notices.get(item.code);
      return { ...profile, trend: trendText(profile), announcements: summarizeAnnouncements(raw || [], profile.asOfDate), announcementsAvailable: Array.isArray(raw) };
    }));
  } finally {
    noticesStopped = true;
    clearTimeout(deadlineTimer);
  }
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
let workspaceAgentSnapshot = { tItems: [], plans: [], paperPositions: [], notes: [], updatedAt: "" };
let stockAgentInstance = null;
function stockAgent() {
  if (stockAgentInstance) return stockAgentInstance;
  // 每次调用新建一份：复盘技能内部会缓存板块数据和失败结果，长期复用会一直拿旧数据。
  const reviewSkills = () => createReviewSkills({
    loadFuyao: () => getFuyaoReviewData(),
    loadSectorBoard: () => getSectorStrengthBoard(settingsForService()),
    analyzeSector: name => analyzeSector({ name }, settingsForService()),
    loadProfiles: list => loadAiStockProfiles(list),
    previousReviews: count => (typeof aiService === "function" ? aiService().recentMarketReviews("", count) : []),
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
    reviewSkill: (skill, args) => reviewSkills().runSkill(skill, args),
    myPortfolio: code => {
      const holdingsValidator = typeof usableHoldings !== "undefined" ? usableHoldings : undefined;
      const watchlistValidator = typeof usableWatchlist !== "undefined" ? usableWatchlist : undefined;
      const holdings = typeof readJson === "function" && typeof normalizeHoldings === "function"
        ? normalizeHoldings(readJson("holdings", [], holdingsValidator))
        : [];
      const watchlist = typeof readJson === "function" && typeof normalizeWatchlist === "function"
        ? normalizeWatchlist(readJson("watchlist", [], watchlistValidator))
        : [];
      const aiCustomStocks = typeof readAiCustomList === "function" ? readAiCustomList() : [];
      return { holdings, watchlist, aiCustomStocks, focusCode: String(code || "") };
    },
    myTContext: () => ({
      items: workspaceAgentSnapshot.tItems,
      updatedAt: workspaceAgentSnapshot.updatedAt
    }),
    myPlansAndNotes: () => ({
      plans: workspaceAgentSnapshot.plans,
      paperPositions: workspaceAgentSnapshot.paperPositions,
      notes: workspaceAgentSnapshot.notes
    }),
    myRecentReviews: count => {
      const reviews = aiService().recentMarketReviews("9999-99-99", count) || [];
      return {
        reviews: reviews.map(item => ({
          asOfDate: item.asOfDate,
          headline: item.headline,
          cyclePhase: item.cycle?.phase || "",
          softwareRegime: item.softwareRegime || "",
          posture: item.nextDay?.posture || "",
          focus: item.nextDay?.focus || [],
          avoid: item.nextDay?.avoid || [],
          lookbackHitRatePct: item.lookbackHitRatePct ?? null,
          lookbackLessons: item.lookbackLessons || []
        }))
      };
    }
  });
  stockAgentInstance = createStockAgentService({
    // 推理模型（如 deepseek-reasoner、gemini 高推理档）读完一轮数据要想一两分钟以上，单次请求放宽到 4 分钟。
    clientFor: (config, lifecycle) => createAiClient({ getConfig: () => config, timeoutMs: 240_000, ...lifecycle }),
    resolveProfile: id => aiProfiles().resolve(String(id || "")),
    listProfiles: () => aiProfiles().list(),
    tools,
    onEvent: emitAiStream,
    store: { read: () => readJson("stock-agent", null, isAgentStore), write: value => writeJson("stock-agent", value, isAgentStore, true) }
  });
  return stockAgentInstance;
}

function emitAiStream(payload) {
  if (!payload || !mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send("ai:stream", payload);
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
  if (process.platform === "win32") {
    app.setAppUserModelId(app.isPackaged ? "com.tlyer666666.astockmonitor" : process.execPath);
  }
  app.on("second-instance", () => {
    if (isQuitting || !app.isReady()) return;
    showOrCreateMainWindow();
  });

  app.whenReady().then(() => {
  debugLog("app ready");
  if (keychainMigrationPending) {
    // 把钥匙串密文迁回本机加密（设置、AI 模型配置与备份密码）；下次启动起不再访问钥匙串。
    try { loadStoredSettings(); readAiProfileStore(); readMigratedBackupConfig(); debugLog("keychain secrets moved back to local storage"); }
    catch (error) { runtimeErrorLog("keychain-migration", error); }
  }
  configureFuyao({ getApiKey: () => settingsForService().fuyaoApiKey });
  nativeTheme.on("updated", updateWindowChrome);
  if (process.platform === "win32") createTray();
  registerAllIpc({
    handleTrustedIpc,
    app,
    fs,
    dialog,
    shell,
    powerMonitor,
    BrowserWindow,
    getMainWindow: () => mainWindow,
    trustedMainWebContents,
    serviceRequestId,
    serviceRequestRuntime,
    prepareSingleBacktestRequest,
    readJson,
    writeJson,
    jsonPath,
    backupJsonPath,
    normalizeWatchlist,
    normalizeHoldings,
    usableWatchlist,
    usableHoldings,
    getCorruptedOnLoad,
    publicSettings,
    loadStoredSettings,
    settingsForService,
    normalizeSettings,
    writeSettings,
    resolveStoredSecret,
    resolveTestSecret,
    encryptSecret,
    decryptSecret,
    isSettingsRecord,
    isCustomStrategyStore,
    isAiProfileStore,
    isAiFrameworkState,
    isAiCustomList,
    isAiStore,
    isAgentStore,
    createBackupService,
    readMigratedBackupConfig,
    getStorageSummary: computeStorageSummary,
    customStrategiesForScan,
    customStrategyStore,
    resetNewsCache,
    resetProfessionalReviewCache,
    applyWindowTheme,
    getThemeMode: () => themeMode,
    reviewWindows,
    closeReviewWindow: () => reviewWindows.closeWindow(),
    showSystemNotification,
    intervalReminders,
    noteWatcher,
    redactRuntimeText,
    testProvider,
    normalizeExternalHttpsUrl,
    getRestoredProfilePendingRestart: () => restoredProfilePendingRestart,
    setRestoredProfilePendingRestart: value => { restoredProfilePendingRestart = Boolean(value); },
    setTrendScanOwner: owner => { trendScanOwner = owner; },
    setWorkspaceAgentSnapshot: snapshot => { workspaceAgentSnapshot = snapshot; },
    searchSecurities,
    analyzeSecurity,
    getQuoteSnapshot,
    getMarketSourceHealth,
    getConvertibleBonds,
    getFuyaoReviewData,
    getDataFederation,
    getChart,
    discoverLimitUps,
    discoverRecentLimitUps,
    getPreviousLimitUpFailedBoardSnapshot,
    thsWebView,
    getSectorClassifications,
    getSectorCatalog,
    getSectorQuotes,
    getSectorDetail,
    cancelSectorRequest,
    getLimitUpSectorBoard,
    getSectorStrengthBoard,
    getSectorLimitUpCount,
    searchSectors,
    getConceptChain,
    analyzeSector,
    scanStrategySignals,
    cancelServiceJob,
    getStrategyDefinitions,
    evaluateTrendResearch,
    checkTrendExecution,
    trendScreener,
    runBacktest,
    runPortfolioBacktest,
    aiPayload,
    aiService,
    aiProfiles,
    stockAgent,
    AI_CUSTOM_MAX,
    loadAiStockProfiles,
    latestDate,
    readAiCustomList,
    normalizeAiCustomItem,
    normalizeAiCustomItems,
    readAiFramework,
    normalizeFrameworkState,
    normalizeCustom,
    frameworkCatalog,
    sameOrigin,
    getProfessionalReview,
    buildNewsImpactPromptInput,
    getNewsFeed,
    createReviewSkills,
    situationOf,
    emitAiStream
  });

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
  activeNotifications.clear();
  cancelRendererRecovery();
  trendScanOwner = undefined;
  trendScreener.cancel();
  dailyBarStore?.shutdown?.();
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
