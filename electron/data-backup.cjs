"use strict";

// 数据备份（1.6.64）：把本机数据打包成一个文件写到你选的文件夹。选 iCloud 云盘、Google 云端硬盘、坚果云、
// OneDrive 等网盘的同步文件夹，网盘客户端会自动传上去；换电脑时从备份恢复。
// 令牌、API Key 不进备份；可设密码加密（AES-256-GCM，scrypt 派生密钥）。行情缓存、日线库不备份。
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodePath = path;
const { sameOrigin } = require("./ai-profile-store.cjs");

const FORMAT = "a-stock-radar-backup";
const VERSION = 1;
const FILE_PREFIX = "A股雷达备份-";
const FILE_PATTERN = /^A股雷达备份-(\d{8})-(\d{6})\.json$/;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_KEEP = 30;
/** 备份的本机数据（userData 下的 JSON）；行情缓存类（可转债名单、行业索引）不备份。 */
const BACKUP_STORES = Object.freeze(["settings", "watchlist", "holdings", "custom-strategies", "ai-profiles", "ai-framework", "ai-custom-stocks", "ai-selection", "stock-agent"]);
const SECRET_SETTING_KEYS = Object.freeze(["refreshToken", "tushareToken", "fuyaoApiKey", "aiApiKey"]);
/** 浏览器本地存储里属于本软件的键。 */
const isAppLocalKey = key => typeof key === "string" && (key.startsWith("a-stock-radar") || key === "ai-picks-excluded" || key === "astock:display-density:v1");
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD_LENGTH = 8;

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });

function deriveKeyAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 32, SCRYPT, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/** 去掉密钥：设置里的令牌/Key，模型配置里的 apiKey。 */
function sanitizeStore(name, value) {
  if (name === "settings" && isRecord(value)) {
    const copy = { ...value };
    for (const key of SECRET_SETTING_KEYS) delete copy[key];
    return copy;
  }
  if (name === "ai-profiles" && isRecord(value) && Array.isArray(value.profiles)) {
    return { ...value, profiles: value.profiles.map(profile => {
      if (!isRecord(profile)) return profile;
      const { apiKey: _apiKey, ...rest } = profile;
      return rest;
    }) };
  }
  return value;
}

/** 恢复时保留本机密钥。AI 密钥只随原接口来源保留。 */
function mergeForRestore(name, restored, current) {
  if (name === "settings" && isRecord(restored)) {
    const merged = { ...(isRecord(current) ? current : {}), ...sanitizeStore("settings", restored) };
    for (const key of SECRET_SETTING_KEYS) {
      const sameEndpoint = key !== "aiApiKey" || sameOrigin(current?.aiBaseUrl, merged.aiBaseUrl);
      if (sameEndpoint && isRecord(current) && current[key] !== undefined) merged[key] = current[key];
      else delete merged[key];
    }
    return merged;
  }
  if (name === "ai-profiles" && isRecord(restored) && Array.isArray(restored.profiles)) {
    const localProfiles = (isRecord(current) && Array.isArray(current.profiles) ? current.profiles : [])
      .filter(profile => isRecord(profile) && profile.apiKey);
    const keys = new Map(localProfiles.map(profile => [profile.id, profile]));
    return { ...restored, profiles: restored.profiles.map(profile => {
      if (!isRecord(profile)) return profile;
      const { apiKey: _ignored, ...rest } = profile;
      if (keys.has(profile.id)) {
        const currentProfile = keys.get(profile.id);
        return sameOrigin(currentProfile.baseUrl, rest.baseUrl)
          ? { ...rest, apiKey: currentProfile.apiKey }
          : rest;
      }
      const fallbackProfile = localProfiles.find(item => sameOrigin(item.baseUrl, rest.baseUrl) && item.model === rest.model)
        || localProfiles.find(item => sameOrigin(item.baseUrl, rest.baseUrl) && item.name === rest.name)
        || localProfiles.find(item => sameOrigin(item.baseUrl, rest.baseUrl));
      return fallbackProfile
        ? { ...rest, apiKey: fallbackProfile.apiKey }
        : rest;
    }) };
  }
  return restored;
}

function buildBackup({ stores, local, appVersion, now = Date.now() }) {
  const cleanStores = {};
  for (const name of BACKUP_STORES) if (stores[name] !== undefined && stores[name] !== null) cleanStores[name] = sanitizeStore(name, stores[name]);
  const cleanLocal = {};
  for (const [key, value] of Object.entries(isRecord(local) ? local : {})) if (isAppLocalKey(key) && typeof value === "string") cleanLocal[key] = value;
  return { format: FORMAT, version: VERSION, createdAt: new Date(now).toISOString(), appVersion: String(appVersion || ""), stores: cleanStores, local: cleanLocal };
}

async function encryptPayload(text, password) {
  const pwd = typeof password === "string" ? password : String(password || "");
  if (pwd.length < MIN_PASSWORD_LENGTH) {
    throw fail("BACKUP_PASSWORD_SHORT", "备份加密密码至少需要 8 位字符");
  }
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = await deriveKeyAsync(pwd, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { format: FORMAT, version: VERSION, encrypted: true, kdf: "scrypt", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** 编码成文件内容：有密码就加密整个备份。 */
async function encodeBackup(backup, password) {
  const text = JSON.stringify(backup);
  if (!password) return text;
  const encrypted = await encryptPayload(text, password);
  return JSON.stringify({ ...encrypted, createdAt: backup.createdAt, appVersion: backup.appVersion });
}

function decodeEncryptedField(value, expectedBytes) {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buffer = Buffer.from(value, "base64");
  if (expectedBytes !== undefined ? buffer.length !== expectedBytes : buffer.length === 0) return null;
  return buffer;
}

async function decryptPayload(parsed, password) {
  const salt = decodeEncryptedField(parsed?.salt, 16);
  const iv = decodeEncryptedField(parsed?.iv, 12);
  const tag = decodeEncryptedField(parsed?.tag, 16);
  const data = decodeEncryptedField(parsed?.data);
  if (!salt || !iv || !tag || !data) throw fail("BACKUP_INVALID", "备份加密字段损坏");
  if (!password) throw fail("BACKUP_PASSWORD_REQUIRED", "这个备份有密码，请输入备份密码");
  try {
    const key = await deriveKeyAsync(String(password), salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw fail("BACKUP_WRONG_PASSWORD", "备份密码不对");
  }
}

async function decodeBackup(text, password) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw fail("BACKUP_INVALID", "这不是有效的备份文件"); }
  if (!isRecord(parsed) || parsed.format !== FORMAT) throw fail("BACKUP_INVALID", "这不是 A股雷达 的备份文件");
  if (Number(parsed.version) > VERSION) throw fail("BACKUP_TOO_NEW", "备份来自更新版本的软件，请先升级再恢复");
  if (parsed.encrypted) {
    const plain = await decryptPayload(parsed, password);
    try { parsed = JSON.parse(plain); } catch { throw fail("BACKUP_INVALID", "备份内容损坏"); }
    if (!isRecord(parsed) || parsed.format !== FORMAT) throw fail("BACKUP_INVALID", "备份内容损坏");
  }
  if (Number(parsed.version) > VERSION) throw fail("BACKUP_TOO_NEW", "备份来自更新版本的软件，请先升级再恢复");
  if (parsed.version !== VERSION || !isRecord(parsed.stores) || !isRecord(parsed.local) ||
      Object.values(parsed.local).some(value => typeof value !== "string")) {
    throw fail("BACKUP_INVALID", "备份的数据结构不完整，无法恢复");
  }
  return parsed;
}

const pad = value => String(value).padStart(2, "0");
/** 文件名用北京时间，方便在网盘里按名字找。 */
function backupFileName(now = Date.now()) {
  const d = new Date(now + 8 * 3600_000);
  return `${FILE_PREFIX}${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.json`;
}

/** 常见网盘同步文件夹（存在才列出）。 */
function suggestFolders({ home = os.homedir(), platform = process.platform, exists = fs.existsSync, readdir = fs.readdirSync } = {}) {
  // 按目标系统拼路径（测试里在 Windows 上也能模拟 macOS 的目录）。
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const list = [];
  const add = (label, dir) => { if (dir && exists(dir)) list.push({ label, path: path.join(dir, "A股雷达备份") }); };
  if (platform === "darwin") {
    add("iCloud 云盘", path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"));
    const cloud = path.join(home, "Library", "CloudStorage");
    let entries = [];
    try { entries = exists(cloud) ? readdir(cloud) : []; } catch { entries = []; }
    for (const name of entries) {
      const base = path.join(cloud, name);
      if (name.startsWith("GoogleDrive-")) {
        const inner = ["我的云端硬盘", "My Drive"].map(part => path.join(base, part)).find(dir => exists(dir));
        add("Google 云端硬盘", inner || base);
      } else if (name.startsWith("OneDrive")) add("OneDrive", base);
      else if (name.startsWith("Dropbox")) add("Dropbox", base);
    }
  } else if (platform === "win32") {
    add("OneDrive", process.env.OneDrive);
    add("Google 云端硬盘", "G:\\我的云端硬盘");
    add("Google 云端硬盘", "G:\\My Drive");
  }
  add("坚果云", path.join(home, "Nutstore Files", "我的坚果云"));
  return list;
}

/**
 * 备份服务：readStore/writeStore 读写 userData 里的 JSON（带校验），config 记文件夹、自动备份开关、密码（已加密）。
 */
function createBackupService({ readStore, writeStore, validateStore, removeStore, readConfig, writeConfig, encryptSecret, decryptSecret, appVersion, getStorageSummary, localMirror = null, now = Date.now, fsApi = fs }) {
  const config = () => {
    const value = readConfig();
    return { folder: "", auto: true, keep: DEFAULT_KEEP, lastBackupAt: "", lastError: "", password: "", ...(isRecord(value) ? value : {}) };
  };
  const listFiles = folder => {
    if (!folder) return [];
    let names = [];
    try { names = fsApi.readdirSync(folder); } catch { return []; }
    const items = [];
    for (const name of names.filter(item => FILE_PATTERN.test(item)).sort().reverse()) {
      const fullPath = path.join(folder, name);
      try {
        const stat = fsApi.lstatSync ? fsApi.lstatSync(fullPath) : fsApi.statSync(fullPath);
        if (stat?.isSymbolicLink?.()) continue;
        if (typeof stat?.isFile === "function" && !stat.isFile()) continue;
        items.push({ name, size: Number(stat?.size) || 0 });
      } catch {
        // Skip unreadable or vanished entries instead of exposing symlinks or broken files.
      }
    }
    return items;
  };
  const safeFile = (folder, name) => {
    if (!FILE_PATTERN.test(String(name || ""))) throw fail("BACKUP_INVALID", "备份文件名不对");
    return path.join(folder, name);
  };
  const readBackupFile = file => {
    const lstat = fsApi.lstatSync?.(file);
    if (lstat?.isSymbolicLink?.()) {
      throw fail("BACKUP_INVALID", "拒绝读取符号链接备份文件");
    }
    const stat = fsApi.statSync ? fsApi.statSync(file) : lstat;
    if (stat?.isSymbolicLink?.()) {
      throw fail("BACKUP_INVALID", "拒绝读取符号链接备份文件");
    }
    if (lstat && typeof lstat.isFile === "function" && !lstat.isFile()) {
      throw fail("BACKUP_INVALID", "备份路径不是普通文件");
    }
    const size = stat?.size ?? lstat?.size;
    if (typeof size === "number" && size > MAX_FILE_BYTES) {
      throw fail("BACKUP_TOO_LARGE", "备份文件超过 64MB，无法读取");
    }
    return fsApi.readFileSync(file, "utf8");
  };
  const status = () => {
    const current = config();
    let storageSummary;
    if (typeof getStorageSummary === "function") {
      try {
        const raw = getStorageSummary();
        if (isRecord(raw)) {
          storageSummary = {
            userDataBytes: Math.max(0, Math.trunc(Number(raw.userDataBytes) || 0)),
            dailyBarsBytes: Math.max(0, Math.trunc(Number(raw.dailyBarsBytes) || 0)),
            dailyBarsCount: Math.max(0, Math.trunc(Number(raw.dailyBarsCount) || 0)),
            webCacheBytes: Math.max(0, Math.trunc(Number(raw.webCacheBytes) || 0))
          };
        }
      } catch {
        storageSummary = undefined;
      }
    }
    return {
      folder: current.folder,
      auto: current.auto !== false,
      keep: current.keep,
      lastBackupAt: current.lastBackupAt,
      lastError: current.lastError,
      hasPassword: Boolean(current.password),
      files: listFiles(current.folder),
      ...(storageSummary ? { storageSummary } : {})
    };
  };

  function planStores(backup) {
    const plan = [];
    for (const store of BACKUP_STORES) {
      if (backup.stores[store] === undefined) {
        if (store !== "settings" && store !== "ai-profiles" && typeof removeStore === "function") {
          const prev = readStore(store);
          if (prev !== null && prev !== undefined) plan.push({ store, prev, remove: true });
        }
        continue;
      }
      const prev = readStore(store);
      const merged = mergeForRestore(store, backup.stores[store], prev);
      if (typeof validateStore === "function" && !validateStore(store, merged)) {
        throw fail("BACKUP_INVALID", `备份里的「${store}」数据格式不对，已取消恢复`);
      }
      plan.push({ store, prev, merged });
    }
    return plan;
  }

  async function prepareRestore(name, password) {
    const current = config();
    const file = safeFile(current.folder, name);
    const backup = await decodeBackup(readBackupFile(file), password || (current.password ? decryptSecret(current.password) : ""));
    planStores(backup);
    const local = Object.fromEntries(Object.entries(backup.local).filter(([key, value]) => isAppLocalKey(key) && typeof value === "string"));
    return { ...backup, local };
  }

  function syncLocalMirror(local) {
    if (!localMirror) return;
    const keys = localMirror.keys().filter(isAppLocalKey);
    const previous = keys.map(key => [key, localMirror.get(key)]);
    const restore = () => {
      for (const [key, value] of previous) {
        try { if (typeof value === "string") localMirror.set(key, value); else localMirror.remove(key); } catch { /* 尽力回滚 */ }
      }
    };
    try {
      for (const key of keys) {
        if (typeof local[key] === "string") localMirror.set(key, local[key]);
        else localMirror.remove(key);
      }
    } catch (error) {
      restore();
      throw error;
    }
  }

  async function applyRestore(backup) {
    const plan = planStores(backup);
    const written = [];
    try {
      for (const item of plan) {
        if (item.remove) removeStore(item.store);
        else writeStore(item.store, item.merged);
        written.push(item);
      }
      syncLocalMirror(backup.local);
    } catch (error) {
      for (let i = written.length - 1; i >= 0; i -= 1) {
        const item = written[i];
        try {
          if (item.prev !== null && item.prev !== undefined) writeStore(item.store, item.prev);
          else if (typeof removeStore === "function") removeStore(item.store);
          else writeStore(item.store, item.prev);
        } catch { /* 回滚尽力而为，保留原始错误 */ }
      }
      throw error;
    }
    return { createdAt: backup.createdAt, stores: written.filter(item => !item.remove).map(item => item.store), local: backup.local };
  }

  return {
    status,
    suggestions: () => suggestFolders(),
    configure(patch) {
      const current = config();
      const next = { ...current };
      if (typeof patch?.folder === "string") {
        const folder = patch.folder.trim();
        if (folder && !path.isAbsolute(folder)) throw fail("BACKUP_FOLDER", "请选择一个完整的文件夹路径");
        next.folder = folder;
      }
      if (typeof patch?.auto === "boolean") next.auto = patch.auto;
      if (Number.isFinite(Number(patch?.keep)) && patch?.keep !== undefined) next.keep = Math.max(3, Math.min(365, Math.floor(Number(patch.keep))));
      if (typeof patch?.password === "string") {
        if (patch.password.length > 0 && patch.password.length < MIN_PASSWORD_LENGTH) {
          throw fail("BACKUP_PASSWORD_SHORT", "备份加密密码至少需要 8 位字符");
        }
        if (patch.password.length > 200) throw fail("BACKUP_PASSWORD_TOO_LONG", "备份密码最多 200 个字符，请缩短后再试");
        next.password = patch.password ? encryptSecret(patch.password) : "";
      }
      writeConfig(next);
      return status();
    },
    /** local：渲染进程本地存储里本软件的键值。 */
    async run(local, { reason = "manual" } = {}) {
      const current = config();
      if (!current.folder) throw fail("BACKUP_FOLDER", "还没有选择备份文件夹");
      try {
        fsApi.mkdirSync(current.folder, { recursive: true });
        const stores = {};
        for (const name of BACKUP_STORES) stores[name] = readStore(name);
        const backup = buildBackup({ stores, local, appVersion, now: now() });
        let password = "";
        if (current.password) {
          password = decryptSecret(current.password);
          if (!password) throw fail("BACKUP_PASSWORD_UNREADABLE", "无法读取已保存的备份密码，请重新设置备份密码后再试");
        }
        const content = await encodeBackup(backup, password);
        if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw fail("BACKUP_TOO_LARGE", "备份超过 64MB，请先清理 AI 对话或回测历史");
        const name = backupFileName(now());
        const file = path.join(current.folder, name);
        const temp = path.join(current.folder, `.${name}.${process.pid}.${crypto.randomUUID()}.part`);
        try {
          fsApi.writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
          fsApi.renameSync(temp, file);
        } finally {
          try {
            if (!fsApi.existsSync || fsApi.existsSync(temp)) fsApi.unlinkSync?.(temp);
          } catch { /* 清理临时文件失败不覆盖原始错误 */ }
        }
        // 只保留最近 keep 份（只删本软件按规则命名的备份文件）。
        for (const old of listFiles(current.folder).slice(current.keep)) {
          try { fsApi.unlinkSync(path.join(current.folder, old.name)); } catch { /* 网盘占用时下次再删 */ }
        }
        writeConfig({ ...current, lastBackupAt: new Date(now()).toISOString(), lastError: "" });
        return { name, size: Buffer.byteLength(content), reason, status: status() };
      } catch (error) {
        try {
          writeConfig({ ...current, lastError: String(error?.message || error).slice(0, 200) });
        } catch {
          // 写配置失败不能覆盖原始备份错误
        }
        throw error;
      }
    },
    /** 读出备份内容（不写入），用于恢复前预览。 */
    async inspect(name, password) {
      const current = config();
      const file = safeFile(current.folder, name);
      const text = readBackupFile(file);
      const backup = await decodeBackup(text, password || (current.password ? decryptSecret(current.password) : ""));
      return { createdAt: backup.createdAt, appVersion: backup.appVersion, stores: Object.keys(backup.stores), localKeys: Object.keys(backup.local).length };
    },
    prepareRestore,
    applyRestore,
    restore: async (name, password) => applyRestore(await prepareRestore(name, password))
  };
}

module.exports = { BACKUP_STORES, FILE_PATTERN, MIN_PASSWORD_LENGTH, buildBackup, encryptPayload, decryptPayload, encodeBackup, decodeBackup, sanitizeStore, mergeForRestore, backupFileName, suggestFolders, createBackupService, isAppLocalKey };
