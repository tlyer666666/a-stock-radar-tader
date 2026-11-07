"use strict";

// AS1：本机 AES-256-GCM 密文格式（密钥文件在 userData，权限 0600）。
// 生产环境使用 createLocalFirstSecretStorage：新写入用 AS1，不写 macOS 钥匙串。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAGIC = Buffer.from("AS1");

function createLocalSecretStorage({ keyPath, randomBytes = crypto.randomBytes } = {}) {
  if (!keyPath) throw new TypeError("缺少本机密钥文件路径");
  let cachedKey = null;

  function loadKey(create) {
    if (cachedKey) return cachedKey;
    let hasCorrupted = false;
    try {
      const existing = fs.readFileSync(keyPath);
      if (existing.length === KEY_BYTES) return (cachedKey = existing);
      hasCorrupted = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!create) return null;
    const key = randomBytes(KEY_BYTES);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    // 损坏的密钥文件先改名留存（便于排查/恢复），不直接覆盖。
    if (hasCorrupted) {
      try { fs.renameSync(keyPath, `${keyPath}.corrupt-${Date.now()}`); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    // 先写临时文件并落盘（fsync），再用硬链接原子地放到正式位置：
    // 断电不会留下半个密钥；并发启动时不覆盖别人刚写好的密钥。
    const tmpPath = `${keyPath}.tmp.${process.pid}.${Date.now()}`;
    const fd = fs.openSync(tmpPath, "wx", 0o600);
    try { fs.writeSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.linkSync(tmpPath, keyPath);
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
    isEncryptionAvailable() {
      try { return Boolean(loadKey(true)); } catch { return false; }
    },
    encryptString(plaintext) {
      const key = loadKey(true);
      const iv = randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
    },
    decryptString(buffer) {
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
    isEncryptionAvailable: () => local.isEncryptionAvailable(),
    // 迁移逻辑把“旧格式密文”解开后重新加密；这里旧格式指钥匙串密文，目标格式是本机 AS1。
    isLegacyCiphertext: bytes => !isLocal(bytes),
    canDecrypt: bytes => isLocal(bytes) || systemAvailable(),
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
