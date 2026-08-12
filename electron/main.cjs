const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  safeStorage,
  nativeTheme,
  Menu,
  Tray
} = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("node:url");
const {
  capItemsPreservingFavorites,
  readJsonWithBackup,
  writeJsonAtomic
} = require("./persistence.cjs");
const {
  createTrustedIpcHandler,
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
  getQuoteSnapshot,
  getDataFederation,
  getChart,
  discoverLimitUps,
  discoverRecentLimitUps,
  scanStrategySignals,
  getLimitUpSectorBoard,
  searchSectors,
  getConceptChain,
  analyzeSector,
  getNewsFeed,
  resetNewsCache,
  testProvider,
  getStrategyDefinitions,
  runPortfolioBacktest,
  runBacktest
} = require("./services.cjs");
const {
  getProfessionalReview,
  resetProfessionalReviewCache
} = require("./review-service.cjs");

let mainWindow;
let tray;
let themeMode = "system";
let isQuitting = false;
let rendererRecoveryTimer;
const rendererRecoveryAttempts = [];
const RUNTIME_LOG_MAX_BYTES = 512 * 1024;
const RENDERER_RECOVERY_WINDOW_MS = 60 * 1000;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_DELAY_MS = 750;
const SECRET_SETTING_KEYS = Object.freeze(["refreshToken", "tushareToken"]);

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

function describeRuntimeError(error) {
  if (!error || typeof error !== "object") {
    return `non-error ${typeof error}`;
  }
  const name = typeof error.name === "string" ? error.name : "Error";
  const message = typeof error.message === "string" ? error.message : "no message";
  const stack = typeof error.stack === "string" ? error.stack : "";
  return redactRuntimeText(stack || `${name}: ${message}`);
}

function rotateRuntimeLogIfNeeded(logPath, nextBytes) {
  try {
    if (!fs.existsSync(logPath)) return;
    if (fs.statSync(logPath).size + nextBytes <= RUNTIME_LOG_MAX_BYTES) return;
    const rotatedPath = `${logPath}.1`;
    if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
    fs.renameSync(logPath, rotatedPath);
  } catch {
    // Runtime diagnostics must never affect the application.
  }
}

function runtimeErrorLog(eventName, error, metadata = "") {
  const safeEventName = redactRuntimeText(eventName).replace(/[\r\n]+/g, " ").slice(0, 80);
  const safeMetadata = redactRuntimeText(metadata).replace(/[\r\n]+/g, " ").slice(0, 320);
  const detail = describeRuntimeError(error);
  const entry = `${new Date().toISOString()} ${safeEventName}${safeMetadata ? ` ${safeMetadata}` : ""}\n${detail}\n`;
  debugLog(`runtime-error ${safeEventName} ${safeMetadata}`);
  if (!app.isPackaged) return;
  try {
    const logPath = path.join(app.getPath("userData"), "runtime-errors.log");
    const bytes = Buffer.byteLength(entry, "utf8");
    rotateRuntimeLogIfNeeded(logPath, bytes);
    fs.appendFileSync(logPath, entry, "utf8");
  } catch {
    // Runtime diagnostics must never affect the application.
  }
}

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

function readJson(name, fallback) {
  const result = readJsonWithBackup(jsonPath(name), backupJsonPath(name), fallback);
  if (result.recovered) debugLog(`recovered ${name} from last-good backup`);
  return result.value;
}

function writeJson(name, value) {
  return writeJsonAtomic(jsonPath(name), backupJsonPath(name), value);
}

function writeSettings(value, synchronizeBackup = false) {
  const saved = writeJson("settings", value);
  if (!synchronizeBackup) return saved;
  // The second atomic write replaces a last-good file that may still contain
  // a legacy plaintext or a secret the user explicitly cleared.
  return writeJson("settings", value);
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
      code,
      name: String(row?.name || code).trim().slice(0, 80) || code,
      secid: String(row?.secid || "").trim().slice(0, 40),
      thscode: String(row?.thscode || "").trim().slice(0, 40),
      marketName: String(row?.marketName || "").trim().slice(0, 40),
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
      code,
      name: String(row?.name || code).trim().slice(0, 80) || code,
      secid: String(row?.secid || "").trim().slice(0, 40),
      thscode: String(row?.thscode || "").trim().slice(0, 40),
      marketName: String(row?.marketName || "").trim().slice(0, 40),
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

function encryptSecret(value) {
  return encryptSecretForStorage(value, safeStorage);
}

function decryptSecret(value) {
  return decryptStoredSecret(value, safeStorage);
}

function defaultSettings() {
  return {
    provider: "ths",
    riskProfile: "balanced",
    refreshToken: "",
    tushareToken: "",
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
  const stored = normalizeSettings({ ...defaultSettings(), ...readJson("settings", {}) });
  const migration = migrateLegacyStoredSecrets(stored, SECRET_SETTING_KEYS, safeStorage);
  if (!migration.migrated) return stored;
  try {
    const saved = writeSettings(normalizeSettings(migration.settings), true);
    debugLog(
      `migrated legacy secrets count=${migration.migratedKeys.length}` +
      ` discarded=${migration.discardedKeys.length}`
    );
    return saved;
  } catch (error) {
    // Fail closed in memory even if the atomic cleanup cannot reach the disk.
    // A later load retries the migration/cleanup.
    runtimeErrorLog("secret-migration-failed", error);
    return normalizeSettings(migration.settings);
  }
}

function settingsForService(override) {
  const saved = loadStoredSettings();
  const decrypted = {
    ...saved,
    refreshToken: decryptSecret(saved.refreshToken),
    tushareToken: decryptSecret(saved.tushareToken)
  };
  return normalizeSettings({ ...decrypted, ...(override || {}) });
}

function publicSettings() {
  const stored = loadStoredSettings();
  return {
    ...stored,
    refreshToken: stored.refreshToken ? "••••••••••••" : "",
    tushareToken: stored.tushareToken ? "••••••••••••" : ""
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
  if (focusMainWindow()) return true;
  if (!app.isReady()) return false;
  createWindow();
  return focusMainWindow();
}

function requestExplicitQuit() {
  if (isQuitting) return;
  isQuitting = true;
  cancelRendererRecovery();
  app.quit();
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  try {
    const createdTray = new Tray(applicationIconPath(true));
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

function handleTrustedIpc(channel, handler) {
  ipcMain.handle(
    channel,
    createTrustedIpcHandler(handler, trustedMainWebContents)
  );
}

function createWindow() {
  debugLog(`createWindow packaged=${app.isPackaged} dirname=${__dirname}`);
  applyWindowTheme(settingsForService().theme);
  const dark = nativeTheme.shouldUseDarkColors;
  const createdWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: dark ? "#070b14" : "#f4f6fb",
    icon: applicationIconPath(),
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  mainWindow = createdWindow;
  createdWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    createTray();
    if (!createdWindow.isDestroyed()) createdWindow.hide();
    debugLog("window hidden to tray");
  });
  createdWindow.on("closed", () => {
    debugLog("window closed");
    cancelRendererRecovery();
    if (mainWindow === createdWindow) mainWindow = undefined;
  });
  createdWindow.webContents.on("did-finish-load", () => {
    debugLog("did-finish-load");
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

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (isQuitting || focusMainWindow() || !app.isReady()) return;
    createWindow();
    focusMainWindow();
  });

  app.whenReady().then(() => {
  debugLog("app ready");
  nativeTheme.on("updated", updateWindowChrome);
  createTray();
  handleTrustedIpc("market:search", (_, query) => searchSecurities(query));
  handleTrustedIpc("market:analyze", (_, security, options = {}) =>
    analyzeSecurity(security, settingsForService({
      forceRefresh: options?.forceRefresh === true
    }))
  );
  handleTrustedIpc("market:quote", (_, security) =>
    getQuoteSnapshot(security, settingsForService())
  );
  handleTrustedIpc("market:federation", (_, security) =>
    getDataFederation(security, settingsForService())
  );
  handleTrustedIpc("market:chart", (_, security, interval, options) =>
    getChart(security, interval, options)
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
  handleTrustedIpc("strategy:scan", (_, options = {}) => {
    const settings = settingsForService();
    return scanStrategySignals({
      ...(options && typeof options === "object" && !Array.isArray(options) ? options : {}),
      provider: settings.provider,
      fallbackEnabled: settings.fallbackEnabled,
      multiSourceEnabled: settings.multiSourceEnabled
    });
  });
  handleTrustedIpc("strategy:definitions", () => getStrategyDefinitions());
  handleTrustedIpc("market:limit-up-sectors", (_, options = {}) =>
    getLimitUpSectorBoard({
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true
    })
  );
  handleTrustedIpc("market:search-sectors", (_, query) => searchSectors(query));
  handleTrustedIpc("market:concept-chain", (_, query) =>
    getConceptChain(query, settingsForService())
  );
  handleTrustedIpc("market:analyze-sector", (_, sector) =>
    analyzeSector(sector, settingsForService())
  );
  handleTrustedIpc("review:get-market", (_, options = {}) => {
    if (options?.refresh) resetProfessionalReviewCache();
    return getProfessionalReview({
      ...options,
      settings: settingsForService()
    });
  });
  handleTrustedIpc("news:get-feed", (_, input) =>
    getNewsFeed(input || {}, settingsForService())
  );
  handleTrustedIpc("news:refresh", (_, input) => {
    resetNewsCache();
    return getNewsFeed(input || {}, settingsForService());
  });
  handleTrustedIpc("backtest:run", (_, input, options = {}) => {
    const safeOptions = options && typeof options === "object" && !Array.isArray(options)
      ? { ...options }
      : {};
    const allowedOverrides = pickBacktestSettingOverrides(safeOptions.settings);
    const mergedSettings = settingsForService(allowedOverrides);
    safeOptions.settings = pickBacktestSettingOverrides(mergedSettings);
    return runBacktest(input, mergedSettings, safeOptions);
  });
  handleTrustedIpc("backtest:run-portfolio", (_, input = {}) =>
    runPortfolioBacktest(input, settingsForService())
  );
  handleTrustedIpc("watchlist:get", () => normalizeWatchlist(readJson("watchlist", [])));
  handleTrustedIpc("watchlist:save", (_, items) =>
    writeJson("watchlist", normalizeWatchlist(items))
  );
  handleTrustedIpc("holdings:get", () => normalizeHoldings(readJson("holdings", [])));
  handleTrustedIpc("holdings:save", (_, items) =>
    writeJson("holdings", normalizeHoldings(items))
  );
  handleTrustedIpc("settings:get", () => publicSettings());
  handleTrustedIpc("settings:save", (_, next) => {
    const input = next && typeof next === "object" && !Array.isArray(next) ? next : {};
    const previous = loadStoredSettings();
    const refreshToken = resolveStoredSecret(input.refreshToken, previous.refreshToken, encryptSecret);
    const tushareToken = resolveStoredSecret(input.tushareToken, previous.tushareToken, encryptSecret);
    const secretsChanged = refreshToken !== previous.refreshToken
      || tushareToken !== previous.tushareToken;
    const saved = writeSettings(
      normalizeSettings({ ...previous, ...input, refreshToken, tushareToken }),
      secretsChanged
    );
    resetNewsCache();
    resetProfessionalReviewCache();
    applyWindowTheme(saved.theme);
    return publicSettings();
  });
  handleTrustedIpc("app:set-theme", (_, theme) => applyWindowTheme(theme));
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
  handleTrustedIpc("settings:test-provider", (_, next) => {
    const input = next && typeof next === "object" && !Array.isArray(next) ? next : {};
    const saved = settingsForService();
    const merged = settingsForService({
      ...input,
      refreshToken: resolveTestSecret(input.refreshToken, saved.refreshToken),
      tushareToken: resolveTestSecret(input.tushareToken, saved.tushareToken)
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

app.on("before-quit", () => {
  isQuitting = true;
  cancelRendererRecovery();
});

app.on("will-quit", destroyTray);

app.on("window-all-closed", () => {
  debugLog("all windows closed; tray process remains active");
});
