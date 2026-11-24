"use strict";

function registerWorkspaceIpc({
  handleTrustedIpc,
  app,
  fs,
  dialog,
  shell,
  powerMonitor,
  BrowserWindow,
  getMainWindow,
  trustedMainWebContents,
  readJson,
  writeJson,
  jsonPath,
  backupJsonPath,
  normalizeWatchlist,
  normalizeHoldings,
  normalizeHoldingsForSave = normalizeHoldings,
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
  getStorageSummary,
  cleanupStorageCache = async () => ({ ok: false, message: "未启用缓存清理" }),
  kvGet = () => null,
  kvSet = () => false,
  localKvMirror = null,
  getMasterPasswordStatus = () => ({ enabled: false, locked: false }),
  isSecretLocked = () => Boolean(getMasterPasswordStatus?.()?.locked),
  setMasterPassword = async () => { throw new Error("未启用主密码模块"); },
  unlockMasterPassword = async () => { throw new Error("未启用主密码模块"); },
  clearMasterPassword = async () => { throw new Error("未启用主密码模块"); },
  setAppZoomFactor = factor => ({ factor }),
  resetNewsCache,
  resetProfessionalReviewCache,
  applyWindowTheme,
  reviewWindows,
  closeReviewWindow = () => reviewWindows?.closeWindow?.(),
  showSystemNotification,
  intervalReminders,
  noteWatcher,
  redactRuntimeText,
  testProvider,
  normalizeExternalHttpsUrl,
  getRestoredProfilePendingRestart,
  setRestoredProfilePendingRestart,
  setRestoreInProgress = () => {}
}) {
  handleTrustedIpc("watchlist:get", () => normalizeWatchlist(readJson("watchlist", [], usableWatchlist)));
  handleTrustedIpc("watchlist:save", (_, items) => {
    if (!Array.isArray(items)) throw Object.assign(new TypeError("观察池保存参数必须为数组"), { code: "INVALID_IPC_PAYLOAD" });
    if (!usableWatchlist(items)) throw Object.assign(new Error("自选列表没有有效股票"), { code: "INVALID_IPC_PAYLOAD" });
    return writeJson("watchlist", normalizeWatchlist(items), usableWatchlist);
  });
  handleTrustedIpc("holdings:get", () => normalizeHoldings(readJson("holdings", [], usableHoldings)));
  handleTrustedIpc("diagnostics:corrupted-on-load", () => getCorruptedOnLoad());
  handleTrustedIpc("holdings:save", (_, items) => {
    if (!Array.isArray(items)) throw Object.assign(new TypeError("持仓保存参数必须为数组"), { code: "INVALID_IPC_PAYLOAD" });
    if (!usableHoldings(items)) throw Object.assign(new Error("持仓列表没有有效股票"), { code: "INVALID_IPC_PAYLOAD" });
    return writeJson("holdings", normalizeHoldingsForSave(items), usableHoldings);
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
    reviewWindows.broadcastTheme(applyWindowTheme(theme));
  });
  handleTrustedIpc("app:set-zoom", (_, factor) => setAppZoomFactor(factor));
  handleTrustedIpc("storage:kv-get", (_, key) => kvGet(key));
  handleTrustedIpc("storage:kv-set", (_, input) => {
    if (getRestoredProfilePendingRestart()) return false;
    return kvSet(input?.key, input?.value);
  });
  handleTrustedIpc("storage:cleanup", (_, input) => cleanupStorageCache(input));
  handleTrustedIpc("security:master-status", () => getMasterPasswordStatus());
  handleTrustedIpc("security:master-set", (_, input) => setMasterPassword(input));
  handleTrustedIpc("security:master-unlock", (_, input) => unlockMasterPassword(input));
  handleTrustedIpc("security:master-clear", (_, input) => clearMasterPassword(input));
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
    validateStore: (name, value) => Boolean(backupValidators[name]?.(value)),
    removeStore: name => {
      for (const file of [jsonPath(name), backupJsonPath(name)]) {
        try { fs.unlinkSync(file); } catch { /* absent or already removed */ }
      }
    },
    readConfig: () => readMigratedBackupConfig(),
    writeConfig: value => writeJson("backup-config", value, isSettingsRecord, true),
    encryptSecret, decryptSecret, isSecretLocked, appVersion: app.getVersion(),
    ...(typeof getStorageSummary === "function" ? { getStorageSummary } : {}),
    ...(localKvMirror ? { localMirror: localKvMirror } : {})
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
    const result = await dialog.showOpenDialog(getMainWindow(), { title: "选择备份文件夹（选网盘的同步文件夹会自动上传到网盘）", properties: ["openDirectory", "createDirectory"] });
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

  let stagedRestore = null;
  let restoreExpiry;
  let restoreCommitting = false;
  const restoreBusy = () => Object.assign(new Error("正在恢复备份，请稍后再试"), { code: "BACKUP_BUSY" });
  handleTrustedIpc("backup:run", async (_, local, options) => {
    if (stagedRestore || restoreCommitting || getRestoredProfilePendingRestart()) throw restoreBusy();
    const reason = options && options.reason === "auto" ? "auto" : "manual";
    const res = await backup.run(backupLocal(local), { reason });
    return { ...res, status: { ...res.status, suggestions: backup.suggestions() } };
  });
  handleTrustedIpc("backup:inspect", (_, name, password) => backup.inspect(String(name || ""), typeof password === "string" ? password : ""));
  const clearStagedRestore = () => {
    clearTimeout(restoreExpiry);
    restoreExpiry = undefined;
    stagedRestore = null;
    setRestoreInProgress(false);
  };
  handleTrustedIpc("backup:prepare-restore", async (event, name, password) => {
    if (stagedRestore || restoreCommitting || getRestoredProfilePendingRestart()) throw restoreBusy();
    closeReviewWindow?.();
    const snapshot = await backup.prepareRestore(String(name || ""), typeof password === "string" ? password : "");
    const token = require("node:crypto").randomUUID();
    stagedRestore = { token, owner: event.sender.id, snapshot };
    setRestoreInProgress(true);
    restoreExpiry = setTimeout(clearStagedRestore, 60_000);
    restoreExpiry.unref?.();
    return { token, local: snapshot.local };
  });
  handleTrustedIpc("backup:cancel-restore", (event, token) => {
    if (stagedRestore?.owner === event.sender.id && stagedRestore.token === token) clearStagedRestore();
  });
  handleTrustedIpc("backup:restore", async (event, token) => {
    if (!stagedRestore || stagedRestore.token !== token || stagedRestore.owner !== event.sender.id) {
      throw Object.assign(new Error("恢复准备已失效，请重新选择备份"), { code: "BACKUP_EXPIRED" });
    }
    if (restoreCommitting || getRestoredProfilePendingRestart()) throw restoreBusy();
    const { snapshot } = stagedRestore;
    clearStagedRestore();
    restoreCommitting = true;
    setRestoreInProgress(true);
    try {
      closeReviewWindow?.();
      await event.sender.session.flushStorageData();
      if (trustedMainWebContents() !== event.sender) throw restoreBusy();
      closeReviewWindow?.();
      await backup.applyRestore(snapshot);
      loadStoredSettings.cached = undefined;
      settingsForService.cached = undefined;
      setRestoredProfilePendingRestart(true);
      setTimeout(() => { app.relaunch(); app.quit(); }, 200);
      return { ok: true };
    } finally {
      restoreCommitting = false;
      setRestoreInProgress(getRestoredProfilePendingRestart());
    }
  });

  handleTrustedIpc("app:notify", (_, input) => showSystemNotification(input));
  handleTrustedIpc("notes:interval-sync", (_, input) => intervalReminders.sync(input));
  powerMonitor.on("resume", intervalReminders.tick);
  handleTrustedIpc("notes:watch-sync", (_, input) => {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const result = noteWatcher().sync({ items: Array.isArray(value.items) ? value.items.slice(0, 60) : [], systemNotify: value.systemNotify !== false });
    return result?.error ? { ...result, error: redactRuntimeText(result.error) } : result;
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
}

module.exports = { registerWorkspaceIpc };
