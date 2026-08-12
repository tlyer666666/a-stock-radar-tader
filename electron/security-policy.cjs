const MASK_CHARACTER = "•";
const MAX_EXTERNAL_URL_LENGTH = 2048;
const SECRET_STORAGE_UNAVAILABLE = "SAFE_STORAGE_UNAVAILABLE";
const BACKTEST_SETTING_KEYS = Object.freeze([
  "selectedStrategies",
  "riskProfile",
  "minProjectedNetEdgePercent",
  "minExpectancyPoints",
  "minTurnoverPercent",
  "minQuoteAmount",
  "maxQuoteAgeSeconds",
  "commissionBps",
  "slippageBps",
  "maxPositionPercent",
  "maxRiskPerTradePercent",
  "stopLossATRMultiple",
  "takeProfitATRMultiple",
  "maxHoldingBars",
  "maxOpenPositions",
  "maxDailyRiskPercent",
  "maxPortfolioRiskPercent",
  "maxSectorExposurePercent",
  "minExecutionRatePercent",
  "trailingStopPercent",
  "maxConsecutiveLossesForStop",
  "lossStreakStepPercent",
  "lossStreakFloorPercent",
  "timeDecayPerBarPercent",
  "minPaperWinRatePercent",
  "minPaperRiskRewardRatio"
]);

function normalizeExternalHttpsUrl(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_EXTERNAL_URL_LENGTH) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function isAllowedRendererNavigation(targetUrl, rendererEntryUrl) {
  if (typeof targetUrl !== "string" || typeof rendererEntryUrl !== "string") {
    return false;
  }
  try {
    const target = new URL(targetUrl);
    const entry = new URL(rendererEntryUrl);
    if (entry.protocol === "file:") {
      return (
        target.protocol === "file:" &&
        target.host.toLowerCase() === entry.host.toLowerCase() &&
        decodeURIComponent(target.pathname).toLowerCase() ===
          decodeURIComponent(entry.pathname).toLowerCase()
      );
    }
    return (
      (entry.protocol === "http:" || entry.protocol === "https:") &&
      target.origin === entry.origin
    );
  } catch {
    return false;
  }
}

function resolveStoredSecret(nextValue, previousEncrypted, encryptSecret) {
  if (typeof nextValue !== "string" || nextValue.includes(MASK_CHARACTER)) {
    return previousEncrypted || "";
  }
  return encryptSecret(nextValue.trim());
}

function resolveTestSecret(nextValue, savedPlaintext) {
  if (typeof nextValue !== "string" || nextValue.includes(MASK_CHARACTER)) {
    return savedPlaintext || "";
  }
  return nextValue.trim();
}

function safeStorageIsAvailable(storage) {
  try {
    return Boolean(storage && storage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function secretStorageUnavailableError() {
  const error = new Error("系统安全存储当前不可用，密钥未保存。请恢复系统安全存储后重试。");
  error.code = SECRET_STORAGE_UNAVAILABLE;
  return error;
}

function encryptSecretForStorage(value, storage) {
  const plaintext = typeof value === "string" ? value : "";
  if (!plaintext) return "";
  if (!safeStorageIsAvailable(storage)) throw secretStorageUnavailableError();
  try {
    const encrypted = storage.encryptString(plaintext);
    if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) {
      throw new TypeError("safeStorage returned an invalid encrypted value");
    }
    const encoded = Buffer.from(encrypted).toString("base64");
    if (!encoded) throw new Error("safeStorage returned an empty encrypted value");
    return `safe:${encoded}`;
  } catch {
    throw secretStorageUnavailableError();
  }
}

function decryptStoredSecret(value, storage) {
  if (typeof value !== "string" || !value) return "";
  if (value.startsWith("safe:")) {
    if (!safeStorageIsAvailable(storage)) return "";
    try {
      return storage.decryptString(Buffer.from(value.slice(5), "base64"));
    } catch {
      return "";
    }
  }
  // Legacy plaintext is migrated (or discarded) before service settings are
  // resolved. Never treat an on-disk plaintext value as a usable credential.
  return "";
}

function migrateLegacyStoredSecrets(settings, secretKeys, storage) {
  const input = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings
    : {};
  const next = { ...input };
  const encryptionAvailable = safeStorageIsAvailable(storage);
  const migratedKeys = [];
  const discardedKeys = [];
  for (const key of Array.isArray(secretKeys) ? secretKeys : []) {
    const stored = next[key];
    if (typeof stored !== "string" || !stored || stored.startsWith("safe:")) continue;
    const plaintext = stored.startsWith("plain:") ? stored.slice(6) : stored;
    migratedKeys.push(key);
    if (!plaintext || !encryptionAvailable) {
      next[key] = "";
      if (plaintext) discardedKeys.push(key);
      continue;
    }
    try {
      next[key] = encryptSecretForStorage(plaintext, storage);
    } catch {
      next[key] = "";
      discardedKeys.push(key);
    }
  }
  return {
    settings: next,
    migrated: migratedKeys.length > 0,
    migratedKeys,
    discardedKeys
  };
}

function pickBacktestSettingOverrides(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const picked = {};
  for (const key of BACKTEST_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) picked[key] = input[key];
  }
  return picked;
}

function isTrustedMainFrameIpcEvent(event, trustedWebContents) {
  if (!event || !trustedWebContents || event.sender !== trustedWebContents) return false;
  try {
    if (
      typeof trustedWebContents.isDestroyed === "function"
      && trustedWebContents.isDestroyed()
    ) {
      return false;
    }
    return Boolean(
      trustedWebContents.mainFrame
      && event.senderFrame
      && event.senderFrame === trustedWebContents.mainFrame
    );
  } catch {
    return false;
  }
}

function createTrustedIpcHandler(handler, getTrustedWebContents) {
  if (typeof handler !== "function" || typeof getTrustedWebContents !== "function") {
    throw new TypeError("Trusted IPC handlers require a handler and a webContents resolver");
  }
  return function trustedIpcHandler(event, ...args) {
    const trustedWebContents = getTrustedWebContents();
    if (!isTrustedMainFrameIpcEvent(event, trustedWebContents)) {
      const error = new Error("已拒绝来自非主窗口或子框架的 IPC 调用");
      error.code = "UNTRUSTED_IPC_SOURCE";
      throw error;
    }
    return handler(event, ...args);
  };
}

function redactRuntimeText(value) {
  return String(value ?? "")
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|authorization|cookie|password|passwd|refresh[_-]?token|client[_-]?secret|secret|token|tushare[_-]?token)=)[^&\s#]*/gi,
      "$1[REDACTED]"
    )
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)\b\s*[:=]\s*[^\r\n]*/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:["']?)(?:access[_-]?token|api[_-]?key|password|passwd|refresh[_-]?token|client[_-]?secret|secret|token|tushare[_-]?token)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/\b(?:plain|safe):[^\s,;"']+/gi, "[REDACTED_SECRET]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .slice(0, 16 * 1024);
}

module.exports = {
  BACKTEST_SETTING_KEYS,
  SECRET_STORAGE_UNAVAILABLE,
  createTrustedIpcHandler,
  decryptStoredSecret,
  encryptSecretForStorage,
  isAllowedRendererNavigation,
  isTrustedMainFrameIpcEvent,
  migrateLegacyStoredSecrets,
  normalizeExternalHttpsUrl,
  pickBacktestSettingOverrides,
  redactRuntimeText,
  resolveStoredSecret,
  resolveTestSecret,
  safeStorageIsAvailable
};
