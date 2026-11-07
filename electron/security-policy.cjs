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
  if (typeof nextValue === 'string' && nextValue.includes(MASK_CHARACTER) && !/^•+$/.test(nextValue.trim())) {
    throw Object.assign(new TypeError('请清空掩码后完整输入新密钥'), { code: 'INVALID_SECRET_MASK' });
  }
  if (typeof nextValue !== "string" || /^•+$/.test(nextValue.trim())) {
    return previousEncrypted || "";
  }
  return encryptSecret(nextValue.trim());
}

function resolveTestSecret(nextValue, savedPlaintext) {
  if (typeof nextValue === 'string' && nextValue.includes(MASK_CHARACTER) && !/^•+$/.test(nextValue.trim())) {
    throw Object.assign(new TypeError('请清空掩码后完整输入新密钥'), { code: 'INVALID_SECRET_MASK' });
  }
  if (typeof nextValue !== "string" || /^•+$/.test(nextValue.trim())) {
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
    try {
      const encrypted = Buffer.from(value.slice(5), "base64");
      if (!(storage?.canDecrypt ? storage.canDecrypt(encrypted) : safeStorageIsAvailable(storage))) return "";
      return storage.decryptString(encrypted);
    } catch {
      return "";
    }
  }
  // Legacy plaintext is migrated before service settings are
  // resolved. Never treat an on-disk plaintext value as a usable credential.
  return "";
}

function migrateLegacyStoredSecrets(settings, secretKeys, storage) {
  const input = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings
    : {};
  const next = { ...input };
  // Even an availability probe may initialize the OS keychain. Public settings
  // reads need no protected storage when there is no legacy secret to migrate.
  let encryptionAvailable;
  const migratedKeys = [];
  const deferredKeys = [];
  for (const key of Array.isArray(secretKeys) ? secretKeys : []) {
    const stored = next[key];
    if (typeof stored !== "string" || !stored) continue;
    if (stored.startsWith("safe:")) {
      if (!storage?.isLegacyCiphertext?.(Buffer.from(stored.slice(5), "base64"))) continue;
      // Locked keychain, lost legacy key or corrupt ciphertext: preserve the
      // original encrypted bytes for a later recovery attempt.
      const plaintext = decryptStoredSecret(stored, storage);
      if (!plaintext || !safeStorageIsAvailable(storage)) continue;
      try { next[key] = encryptSecretForStorage(plaintext, storage); }
      catch { continue; }
      migratedKeys.push(key);
      continue;
    }
    const plaintext = stored.startsWith("plain:") ? stored.slice(6) : stored;
    if (!plaintext) {
      next[key] = "";
      migratedKeys.push(key);
      continue;
    }
    encryptionAvailable ??= safeStorageIsAvailable(storage);
    if (!encryptionAvailable) {
      deferredKeys.push(key);
      continue;
    }
    try {
      next[key] = encryptSecretForStorage(plaintext, storage);
      migratedKeys.push(key);
    } catch { deferredKeys.push(key); }

  }
  return {
    settings: next,
    migrated: migratedKeys.length > 0,
    migratedKeys,
    deferredKeys
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

function isExpectedRendererEntry(value, entryUrl) {
  if (typeof value !== "string" || typeof entryUrl !== "string") return false;
  try {
    const target = new URL(value);
    const entry = new URL(entryUrl);
    if (entry.protocol !== "file:" && !(["http:", "https:"].includes(entry.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(entry.hostname))) return false;
    target.hash = "";
    entry.hash = "";
    return target.href === entry.href;
  } catch { return false; }
}

function isTrustedMainFrameIpcEvent(event, trustedWebContents, entryUrl) {
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
      && isExpectedRendererEntry(event.senderFrame.url, entryUrl)
    );
  } catch {
    return false;
  }
}

/**
 * E-02：IPC 载荷规模上限。
 *
 * 之前保存类通道只校验类型与元素有效性，不校验规模。渲染进程异常或被注入时，
 * 百万级数组会让主进程在主线程上同步跑归一化 + JSON.stringify + 写盘，界面卡死，
 * 写出的超大 JSON 还会拖慢后续读取。
 *
 * 放在这个统一入口，所有走 trusted wrapper 的通道自动受保护，新增通道无需各自记得加。
 */
const MAX_IPC_COLLECTION_ITEMS = 5000;
const MAX_IPC_STRING_LENGTH = 65536;
const IPC_PAYLOAD_LIMITS = Object.freeze({ nodes: 1_000_000, keys: 500_000, bytes: 32 * 1024 * 1024 });
// Research already accepts at most 16 MiB of JSON / 250,000 OHLC rows.
// Its structural budget accommodates that contract, including short numbers
// whose in-memory accounting is larger than their JSON representation.
const RESEARCH_IPC_PAYLOAD_LIMITS = Object.freeze({ nodes: 10_000_000, keys: 4_000_000, bytes: 96 * 1024 * 1024 });

function createIpcPayloadBudget(channel) {
  return { nodes: 0, keys: 0, bytes: 0,
    limits: channel === "trend-screener:research" ? RESEARCH_IPC_PAYLOAD_LIMITS : IPC_PAYLOAD_LIMITS };
}

/** One budget covers every argument and nested value; never clone a wide object. */
function assertIpcPayloadBounded(value, channel = "IPC", depth = 0, budget = createIpcPayloadBudget(channel)) {
  const invalid = message => { throw Object.assign(new TypeError(`${channel} ${message}`), { code: "INVALID_IPC_PAYLOAD" }); };
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") invalid("不支持此类载荷");
  const chargeBytes = bytes => {
    budget.bytes += bytes;
    if (budget.bytes > budget.limits.bytes) invalid("载荷累计字节数超过上限");
  };
  if (++budget.nodes > budget.limits.nodes) invalid("载荷累计节点数超过上限");
  chargeBytes(1);
  // 12 层：涨停天梯 AI 解读（input→data→ladder→day→tiers→tier→stocks→stock→字段）已用到 8 层，留出余量；仍足以防止递归爆栈。
  if (depth > 12) {
    throw Object.assign(new TypeError(`${channel} 载荷嵌套过深`), { code: "INVALID_IPC_PAYLOAD" });
  }
  if (typeof value === "string") {
    if (value.length > MAX_IPC_STRING_LENGTH) {
      throw Object.assign(
        new TypeError(`${channel} 字符串过长（上限 ${MAX_IPC_STRING_LENGTH} 字符）`),
        { code: "INVALID_IPC_PAYLOAD" }
      );
    }
    chargeBytes(Buffer.byteLength(value, "utf8"));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_IPC_COLLECTION_ITEMS) {
      throw Object.assign(
        new TypeError(`${channel} 数组元素过多（上限 ${MAX_IPC_COLLECTION_ITEMS}）`),
        { code: "INVALID_IPC_PAYLOAD" }
      );
    }
    for (const item of value) assertIpcPayloadBounded(item, channel, depth + 1, budget);
    return;
  }
  if (value && typeof value === "object") {
    let objectKeys = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++objectKeys > MAX_IPC_COLLECTION_ITEMS) invalid("对象属性过多");
      if (++budget.keys > budget.limits.keys) invalid("载荷累计对象属性数超过上限");
      if (key.length > MAX_IPC_STRING_LENGTH) invalid("对象属性名过长");
      chargeBytes(Buffer.byteLength(key, "utf8"));
      assertIpcPayloadBounded(value[key], channel, depth + 1, budget);
    }
    // Typed buffers and opaque containers are outside the JSON-like IPC API.
    if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)
      && !(value instanceof Map) && !(value instanceof Set) && !(value instanceof Date)) return;
    invalid("不支持二进制或非普通对象载荷");
  }
  if (typeof value === "number") chargeBytes(8);
}

function createTrustedIpcHandler(handler, getTrustedWebContents, channel, entryUrl) {
  if (typeof handler !== "function" || typeof getTrustedWebContents !== "function") {
    throw new TypeError("Trusted IPC handlers require a handler and a webContents resolver");
  }
  return function trustedIpcHandler(event, ...args) {
    const trustedWebContents = getTrustedWebContents();
    if (!isTrustedMainFrameIpcEvent(event, trustedWebContents, entryUrl)) {
      const error = new Error("已拒绝来自非主窗口或子框架的 IPC 调用");
      error.code = "UNTRUSTED_IPC_SOURCE";
      throw error;
    }
    const budget = createIpcPayloadBudget(channel);
    for (const arg of args) assertIpcPayloadBounded(arg, channel, 0, budget);
    return handler(event, ...args);
  };
}

// Electron only transports thrown error messages across ipcMain.handle. A
// plain envelope retains the safe category for preloads without exposing a stack.
function withIpcResult(handler, report) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (reason) {
      let code = "IPC_FAILED", message = "操作失败，请稍后再试";
      try {
        if (typeof reason?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason.code)) code = reason.code;
        else if (reason?.name === "AbortError") code = "JOB_CANCELLED";
        else if (reason?.name === "TimeoutError") code = "JOB_TIMEOUT";
        if (typeof reason?.message === "string") message = redactRuntimeText(reason.message).slice(0, 512) || message;
      } catch { /* Error accessors may themselves throw; use the safe defaults. */ }
      const retryable = ["SERVICE_BUSY", "QUEUE_TIMEOUT", "QUEUE_FULL", "JOB_TIMEOUT", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code);
      try { if (code !== "JOB_CANCELLED") report?.(code); } catch { /* Isolate the diagnostic sink. */ }
      return { ok: false, error: { code, message, retryable } };
    }
  };
}

function redactRuntimeText(value) {
  return String(value ?? "")
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|authorization|cookie|password|passwd|refresh[_-]?token|client[_-]?secret|secret|token|tushare[_-]?token)=)[^&\s#]*/gi,
      "$1[REDACTED]"
    )
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)\b\s*[:=]\s*[^\r\n]*/gi, "$1=[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED_KEY]")
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
  SECRET_STORAGE_UNAVAILABLE,
  createTrustedIpcHandler,
  withIpcResult,
  assertIpcPayloadBounded,
  MAX_IPC_COLLECTION_ITEMS,
  MAX_IPC_STRING_LENGTH,
  decryptStoredSecret,
  encryptSecretForStorage,
  isAllowedRendererNavigation,
  isTrustedMainFrameIpcEvent,
  migrateLegacyStoredSecrets,
  normalizeExternalHttpsUrl,
  pickBacktestSettingOverrides,
  redactRuntimeText,
  resolveStoredSecret,
  resolveTestSecret
};
