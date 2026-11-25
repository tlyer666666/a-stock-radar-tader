"use strict";

// AS1：本机 AES-256-GCM 密文格式（密钥文件在 userData，权限 0600）。
// 生产环境使用 createLocalFirstSecretStorage：新写入用 AS1，不写 macOS 钥匙串。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { renameWithRetrySync } = require("./persistence.cjs");

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAGIC = Buffer.from("AS1");
const AS2_MAGIC = Buffer.from("AS2");
const AS2_VERSION = 0x01;
const AS2_TOTAL_BYTES = AS2_MAGIC.length + 1 + SALT_BYTES + IV_BYTES + TAG_BYTES + KEY_BYTES;
const MASTER_SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const MIN_MASTER_PASSWORD_LENGTH = 8;
const MAX_MASTER_PASSWORD_LENGTH = 200;
const MASTER_BACKOFF_BASE_MS = 200;
const MASTER_BACKOFF_MAX_MS = 15_000;
const LINK_FALLBACK_CODES = new Set(["ENOTSUP", "EPERM", "ENOSYS", "EXDEV"]);

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function lockedStorageError() {
  return Object.assign(new Error("密钥库已锁定，请先输入主密码解锁"), { code: "SECRET_STORAGE_LOCKED" });
}

function invalidMasterPasswordError() {
  return Object.assign(new Error("主密码错误，请重试"), { code: "MASTER_PASSWORD_INVALID" });
}

function isAs2Envelope(bytes) {
  return Buffer.isBuffer(bytes)
    && bytes.length === AS2_TOTAL_BYTES
    && bytes.subarray(0, AS2_MAGIC.length).equals(AS2_MAGIC)
    && bytes[AS2_MAGIC.length] === AS2_VERSION;
}

function deriveMasterEnvelopeKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, KEY_BYTES, MASTER_SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function createLocalSecretStorage({
  keyPath,
  randomBytes = crypto.randomBytes,
  now = () => Date.now(),
  backoffBaseMs = MASTER_BACKOFF_BASE_MS,
  backoffMaxMs = MASTER_BACKOFF_MAX_MS,
  sleep = defaultSleep
} = {}) {
  if (!keyPath) throw new TypeError("缺少本机密钥文件路径");
  let cachedKey = null;
  let masterOpQueue = Promise.resolve();
  let failedMasterAttempts = 0;
  let masterBackoffUntil = 0;

  function runMasterOpSerialized(task) {
    const run = masterOpQueue.then(task, task);
    masterOpQueue = run.then(() => {}, () => {});
    return run;
  }

  function assertKeyPathNotSymlink() {
    try {
      const stat = fs.lstatSync(keyPath);
      if (stat.isSymbolicLink()) {
        throw Object.assign(new TypeError("本机密钥文件路径不能为符号链接"), { code: "INVALID_SECRET_KEY_PATH" });
      }
      if (!stat.isFile()) {
        throw Object.assign(new TypeError("本机密钥文件路径不是普通文件"), { code: "INVALID_SECRET_KEY_PATH" });
      }
      return stat;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  function readKeyFileState() {
    try {
      const stat = assertKeyPathNotSymlink();
      if (!stat) return { kind: "missing" };
      const existing = fs.readFileSync(keyPath);
      if (existing.length === KEY_BYTES) return { kind: "raw", key: existing };
      if (isAs2Envelope(existing)) return { kind: "as2", buffer: existing };
      return { kind: "corrupt", buffer: existing };
    } catch (error) {
      if (error?.code === "ENOENT") return { kind: "missing" };
      throw error;
    }
  }

  function writeKeyFileAtomic(bytes) {
    assertKeyPathNotSymlink();
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${keyPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    const fd = fs.openSync(tmpPath, "wx", 0o600);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      renameWithRetrySync(tmpPath, keyPath);
      if (process.platform !== "win32") {
        try { fs.chmodSync(keyPath, 0o600); } catch { /* 受限文件系统尽力而为 */ }
      }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* 临时文件已不在 */ }
    }
    try {
      const dir = fs.openSync(path.dirname(keyPath), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { /* 部分文件系统不支持目录 fsync */ }
  }

  async function wrapMasterKey(masterKey, password) {
    const salt = Buffer.from(randomBytes(SALT_BYTES));
    const iv = Buffer.from(randomBytes(IV_BYTES));
    const derived = await deriveMasterEnvelopeKey(password, salt);
    try {
      const cipher = crypto.createCipheriv("aes-256-gcm", derived, iv);
      const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([AS2_MAGIC, Buffer.from([AS2_VERSION]), salt, iv, tag, encrypted]);
    } finally {
      if (Buffer.isBuffer(derived)) derived.fill(0);
    }
  }

  async function unwrapMasterKey(envelope, password) {
    if (typeof password !== "string" || !password) throw invalidMasterPasswordError();
    const headerEnd = AS2_MAGIC.length + 1;
    const salt = envelope.subarray(headerEnd, headerEnd + SALT_BYTES);
    const iv = envelope.subarray(headerEnd + SALT_BYTES, headerEnd + SALT_BYTES + IV_BYTES);
    const tag = envelope.subarray(
      headerEnd + SALT_BYTES + IV_BYTES,
      headerEnd + SALT_BYTES + IV_BYTES + TAG_BYTES
    );
    const encrypted = envelope.subarray(headerEnd + SALT_BYTES + IV_BYTES + TAG_BYTES);
    const derived = await deriveMasterEnvelopeKey(password, salt);
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", derived, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      if (plain.length !== KEY_BYTES) throw invalidMasterPasswordError();
      return plain;
    } catch {
      throw invalidMasterPasswordError();
    } finally {
      if (Buffer.isBuffer(derived)) derived.fill(0);
    }
  }

  async function unwrapMasterKeyWithBackoff(envelope, password) {
    const waitMs = masterBackoffUntil - now();
    if (waitMs > 0) await sleep(waitMs);
    try {
      const masterKey = await unwrapMasterKey(envelope, password);
      failedMasterAttempts = 0;
      masterBackoffUntil = 0;
      return masterKey;
    } catch (error) {
      if (error?.code === "MASTER_PASSWORD_INVALID") {
        failedMasterAttempts += 1;
        const base = Number.isFinite(Number(backoffBaseMs)) && Number(backoffBaseMs) >= 0 ? Number(backoffBaseMs) : MASTER_BACKOFF_BASE_MS;
        const max = Number.isFinite(Number(backoffMaxMs)) && Number(backoffMaxMs) >= 0 ? Number(backoffMaxMs) : MASTER_BACKOFF_MAX_MS;
        const delay = Math.min(max, base * (2 ** Math.min(failedMasterAttempts - 1, 10)));
        masterBackoffUntil = now() + delay;
      }
      throw error;
    }
  }

  function isMasterPasswordEnabled() {
    try {
      return readKeyFileState().kind === "as2";
    } catch {
      return false;
    }
  }

  function isLocked() {
    return isMasterPasswordEnabled() && !cachedKey;
  }

  function status() {
    const enabled = isMasterPasswordEnabled();
    return { enabled, locked: enabled && !cachedKey };
  }

  function loadKey(create) {
    if (cachedKey) return cachedKey;
    const state = readKeyFileState();
    if (state.kind === "as2") throw lockedStorageError();
    if (state.kind === "raw") return (cachedKey = state.key);
    const hasCorrupted = state.kind === "corrupt";
    if (!create) return null;
    const key = Buffer.from(randomBytes(KEY_BYTES));
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    // 损坏的密钥文件先改名留存（便于排查/恢复），不直接覆盖。
    if (hasCorrupted) {
      try { renameWithRetrySync(keyPath, `${keyPath}.corrupt-${Date.now()}`); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    // 先写临时文件并落盘（fsync），再用硬链接原子地放到正式位置：
    // 断电不会留下半个密钥；并发启动时不覆盖别人刚写好的密钥。
    const tmpPath = `${keyPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    const fd = fs.openSync(tmpPath, "wx", 0o600);
    try { fs.writeSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      try {
        fs.linkSync(tmpPath, keyPath);
      } catch (linkError) {
        if (!LINK_FALLBACK_CODES.has(linkError?.code)) throw linkError;
        fs.copyFileSync(tmpPath, keyPath, fs.constants.COPYFILE_EXCL);
        if (process.platform !== "win32") {
          try { fs.chmodSync(keyPath, 0o600); } catch { /* 受限文件系统尽力而为 */ }
        }
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return loadKey(false);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* 临时文件已不在 */ }
    }
    try { const dir = fs.openSync(path.dirname(keyPath), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* 部分文件系统不支持目录 fsync */ }
    return (cachedKey = key);
  }

  return {
    isMasterPasswordEnabled,
    isLocked,
    status,
    setMasterPassword(newPassword, currentPassword = "") {
      return runMasterOpSerialized(async () => {
        if (typeof newPassword !== "string" || newPassword.length < MIN_MASTER_PASSWORD_LENGTH) {
          throw Object.assign(new Error("主密码至少需要 8 位字符"), { code: "MASTER_PASSWORD_SHORT" });
        }
        if (newPassword.length > MAX_MASTER_PASSWORD_LENGTH) {
          throw Object.assign(new Error("主密码最多 200 个字符"), { code: "MASTER_PASSWORD_TOO_LONG" });
        }
        const state = readKeyFileState();
        let masterKey;
        if (state.kind === "as2") {
          masterKey = await unwrapMasterKeyWithBackoff(state.buffer, currentPassword);
        } else if (cachedKey) {
          masterKey = cachedKey;
        } else if (state.kind === "raw") {
          masterKey = state.key;
        } else {
          if (state.kind === "corrupt") {
            try { renameWithRetrySync(keyPath, `${keyPath}.corrupt-${Date.now()}`); }
            catch (error) { if (error?.code !== "ENOENT") throw error; }
          }
          masterKey = Buffer.from(randomBytes(KEY_BYTES));
        }
        const envelope = await wrapMasterKey(masterKey, newPassword);
        writeKeyFileAtomic(envelope);
        cachedKey = masterKey;
        return status();
      });
    },
    unlockMasterPassword(password) {
      return runMasterOpSerialized(async () => {
        const state = readKeyFileState();
        if (state.kind !== "as2") {
          if (state.kind === "raw") cachedKey = state.key;
          return status();
        }
        const masterKey = await unwrapMasterKeyWithBackoff(state.buffer, password);
        cachedKey = masterKey;
        return status();
      });
    },
    clearMasterPassword(currentPassword) {
      return runMasterOpSerialized(async () => {
        const state = readKeyFileState();
        if (state.kind !== "as2") {
          if (state.kind === "raw") cachedKey = state.key;
          return status();
        }
        const masterKey = await unwrapMasterKeyWithBackoff(state.buffer, currentPassword);
        writeKeyFileAtomic(masterKey);
        cachedKey = masterKey;
        return status();
      });
    },
    isEncryptionAvailable() {
      try { return Boolean(loadKey(true)); } catch { return false; }
    },
    encryptString(plaintext) {
      if (isLocked()) throw lockedStorageError();
      const key = loadKey(true);
      const iv = randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
    },
    decryptString(buffer) {
      if (isLocked()) throw lockedStorageError();
      const data = Buffer.from(buffer);
      if (data.length < MAGIC.length + IV_BYTES + TAG_BYTES || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error("不是本机密钥加密的数据");
      }
      const key = loadKey(false);
      if (!key) throw new Error("本机密钥不存在");
      const iv = data.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
      const tag = data.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    }
  };
}

function createProtectedSecretStorage(system, legacy) {
  const isLegacy = bytes => bytes.length >= MAGIC.length + IV_BYTES + TAG_BYTES
    && bytes.subarray(0, MAGIC.length).equals(MAGIC);
  const available = () => Boolean(system?.isEncryptionAvailable()
    && system.getSelectedStorageBackend?.() !== "basic_text");
  return {
    isEncryptionAvailable: available,
    isLegacyCiphertext: isLegacy,
    canDecrypt: bytes => isLegacy(bytes) || available(),
    encryptString: value => {
      if (!available()) throw new Error("系统安全存储不可用");
      return system.encryptString(value);
    },
    decryptString: bytes => {
      if (isLegacy(bytes)) return legacy.decryptString(bytes);
      if (!available()) throw new Error("系统安全存储不可用");
      return system.decryptString(bytes);
    }
  };
}

/**
 * 1.6.49：本机优先的密钥存储。
 * 软件每次更新都会重新签名（ad-hoc），macOS 钥匙串按签名识别程序，存在钥匙串里的密钥
 * 每次更新后启动都会弹出“输入登录密码”的提示。所以新写入一律用本机 AS1 加密，不再写钥匙串；
 * 1.6.48 已经存进钥匙串的密文（非 AS1）只在“迁回”那一次用系统安全存储解开，随即改存为 AS1。
 */
function createLocalFirstSecretStorage(local, system) {
  const isLocal = bytes => bytes.length >= MAGIC.length + IV_BYTES + TAG_BYTES
    && bytes.subarray(0, MAGIC.length).equals(MAGIC);
  const systemAvailable = () => {
    try { return Boolean(system?.isEncryptionAvailable() && system.getSelectedStorageBackend?.() !== "basic_text"); }
    catch { return false; }
  };
  return {
    isMasterPasswordEnabled: () => Boolean(local.isMasterPasswordEnabled?.()),
    isLocked: () => Boolean(local.isLocked?.()),
    status: () => (typeof local.status === "function" ? local.status() : { enabled: false, locked: false }),
    setMasterPassword: (...args) => local.setMasterPassword(...args),
    unlockMasterPassword: (...args) => local.unlockMasterPassword(...args),
    clearMasterPassword: (...args) => local.clearMasterPassword(...args),
    isEncryptionAvailable: () => local.isEncryptionAvailable(),
    // 迁移逻辑把“旧格式密文”解开后重新加密；这里旧格式指钥匙串密文，目标格式是本机 AS1。
    isLegacyCiphertext: bytes => !isLocal(bytes),
    canDecrypt: bytes => (isLocal(bytes) ? !local.isLocked?.() : systemAvailable()),
    encryptString: value => local.encryptString(value),
    decryptString: bytes => {
      if (isLocal(bytes)) return local.decryptString(bytes);
      if (!systemAvailable()) throw new Error("系统安全存储不可用");
      return system.decryptString(bytes);
    }
  };
}

/** 设置值里是否还有钥匙串密文（"safe:" 后不是 AS1）。启动早期用来决定这次是否还需要访问钥匙串。 */
function hasSystemCiphertext(value) {
  if (typeof value === "string") {
    if (!value.startsWith("safe:")) return false;
    try { const bytes = Buffer.from(value.slice(5), "base64"); return !(bytes.length >= MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC)); }
    catch { return false; }
  }
  if (Array.isArray(value)) return value.some(hasSystemCiphertext);
  if (value && typeof value === "object") return Object.values(value).some(hasSystemCiphertext);
  return false;
}

module.exports = { createLocalSecretStorage, createProtectedSecretStorage, createLocalFirstSecretStorage, hasSystemCiphertext };
