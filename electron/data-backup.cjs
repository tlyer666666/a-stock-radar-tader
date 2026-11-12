"use strict";

// 数据备份（1.6.64）：把本机数据打包成一个文件写到你选的文件夹。选 iCloud 云盘、Google 云端硬盘、坚果云、
// OneDrive 等网盘的同步文件夹，网盘客户端会自动传上去；换电脑时从备份恢复。
// 令牌、API Key 不进备份；可设密码加密（AES-256-GCM，scrypt 派生密钥）。行情缓存、日线库不备份。
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodePath = path;

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
const isAppLocalKey = key => typeof key === "string" && (key.startsWith("a-stock-radar") || key === "ai-picks-excluded");
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });

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

/** 恢复时：设置和模型配置保留本机现有的密钥。 */
function mergeForRestore(name, restored, current) {
  if (name === "settings" && isRecord(restored)) {
    const merged = { ...(isRecord(current) ? current : {}), ...sanitizeStore("settings", restored) };
    for (const key of SECRET_SETTING_KEYS) {
      if (isRecord(current) && current[key] !== undefined) merged[key] = current[key];
      else delete merged[key];
    }
    return merged;
  }
  if (name === "ai-profiles" && isRecord(restored) && Array.isArray(restored.profiles)) {
    const keys = new Map((isRecord(current) && Array.isArray(current.profiles) ? current.profiles : [])
      .filter(profile => isRecord(profile) && profile.apiKey).map(profile => [profile.id, profile.apiKey]));
    return { ...restored, profiles: restored.profiles.map(profile => {
      if (!isRecord(profile)) return profile;
      const { apiKey: _ignored, ...rest } = profile;
      return keys.has(profile.id) ? { ...rest, apiKey: keys.get(profile.id) } : rest;
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

function encryptText(text, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { format: FORMAT, version: VERSION, encrypted: true, kdf: "scrypt", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** 编码成文件内容：有密码就加密整个备份。 */
function encodeBackup(backup, password) {
  const text = JSON.stringify(backup);
  return JSON.stringify(password ? { ...encryptText(text, password), createdAt: backup.createdAt, appVersion: backup.appVersion } : backup);
}

function decodeBackup(text, password) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw fail("BACKUP_INVALID", "这不是有效的备份文件"); }
  if (!isRecord(parsed) || parsed.format !== FORMAT) throw fail("BACKUP_INVALID", "这不是 A股雷达 的备份文件");
  if (Number(parsed.version) > VERSION) throw fail("BACKUP_TOO_NEW", "备份来自更新版本的软件，请先升级再恢复");
  if (parsed.encrypted) {
    if (!password) throw fail("BACKUP_PASSWORD_REQUIRED", "这个备份有密码，请输入备份密码");
    try {
      const key = crypto.scryptSync(String(password), Buffer.from(parsed.salt, "base64"), 32, SCRYPT);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
      parsed = JSON.parse(plain);
    } catch { throw fail("BACKUP_WRONG_PASSWORD", "备份密码不对"); }
    if (!isRecord(parsed) || parsed.format !== FORMAT) throw fail("BACKUP_INVALID", "备份内容损坏");
  }
  return { ...parsed, stores: isRecord(parsed.stores) ? parsed.stores : {}, local: isRecord(parsed.local) ? parsed.local : {} };
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
function createBackupService({ readStore, writeStore, readConfig, writeConfig, encryptSecret, decryptSecret, appVersion, now = Date.now, fsApi = fs }) {
  const config = () => {
    const value = readConfig();
    return { folder: "", auto: true, keep: DEFAULT_KEEP, lastBackupAt: "", lastError: "", password: "", ...(isRecord(value) ? value : {}) };
  };
  const listFiles = folder => {
    if (!folder) return [];
    let names = [];
    try { names = fsApi.readdirSync(folder); } catch { return []; }
    return names.filter(name => FILE_PATTERN.test(name)).sort().reverse().map(name => {
      let size = 0;
      try { size = fsApi.statSync(path.join(folder, name)).size; } catch { size = 0; }
      return { name, size };
    });
  };
  const safeFile = (folder, name) => {
    if (!FILE_PATTERN.test(String(name || ""))) throw fail("BACKUP_INVALID", "备份文件名不对");
    return path.join(folder, name);
  };
  const status = () => {
    const current = config();
    return { folder: current.folder, auto: current.auto !== false, keep: current.keep, lastBackupAt: current.lastBackupAt, lastError: current.lastError,
      hasPassword: Boolean(current.password), files: listFiles(current.folder) };
  };

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
      if (typeof patch?.password === "string") next.password = patch.password ? encryptSecret(patch.password.slice(0, 200)) : "";
      writeConfig(next);
      return status();
    },
    /** local：渲染进程本地存储里本软件的键值。 */
    run(local, { reason = "manual" } = {}) {
      const current = config();
      if (!current.folder) throw fail("BACKUP_FOLDER", "还没有选择备份文件夹");
      try {
        fsApi.mkdirSync(current.folder, { recursive: true });
        const stores = {};
        for (const name of BACKUP_STORES) stores[name] = readStore(name);
        const backup = buildBackup({ stores, local, appVersion, now: now() });
        const password = current.password ? decryptSecret(current.password) : "";
        const content = encodeBackup(backup, password);
        if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw fail("BACKUP_TOO_LARGE", "备份超过 64MB，请先清理 AI 对话或回测历史");
        const name = backupFileName(now());
        const file = path.join(current.folder, name);
        const temp = `${file}.part`;
        fsApi.writeFileSync(temp, content, { mode: 0o600 });
        fsApi.renameSync(temp, file);
        // 只保留最近 keep 份（只删本软件按规则命名的备份文件）。
        for (const old of listFiles(current.folder).slice(current.keep)) {
          try { fsApi.unlinkSync(path.join(current.folder, old.name)); } catch { /* 网盘占用时下次再删 */ }
        }
        writeConfig({ ...current, lastBackupAt: new Date(now()).toISOString(), lastError: "" });
        return { name, size: Buffer.byteLength(content), reason, status: status() };
      } catch (error) {
        writeConfig({ ...current, lastError: String(error?.message || error).slice(0, 200) });
        throw error;
      }
    },
    /** 读出备份内容（不写入），用于恢复前预览。 */
    inspect(name, password) {
      const current = config();
      const file = safeFile(current.folder, name);
      const text = fsApi.readFileSync(file, "utf8");
      const backup = decodeBackup(text, password || (current.password ? decryptSecret(current.password) : ""));
      return { createdAt: backup.createdAt, appVersion: backup.appVersion, stores: Object.keys(backup.stores), localKeys: Object.keys(backup.local).length };
    },
    /** 恢复：写回 userData 的数据，返回本地存储的键值由渲染进程写回，然后重启软件。 */
    restore(name, password) {
      const current = config();
      const file = safeFile(current.folder, name);
      const backup = decodeBackup(fsApi.readFileSync(file, "utf8"), password || (current.password ? decryptSecret(current.password) : ""));
      const written = [];
      for (const store of BACKUP_STORES) {
        if (backup.stores[store] === undefined) continue;
        writeStore(store, mergeForRestore(store, backup.stores[store], readStore(store)));
        written.push(store);
      }
      const local = {};
      for (const [key, value] of Object.entries(backup.local)) if (isAppLocalKey(key) && typeof value === "string") local[key] = value;
      return { createdAt: backup.createdAt, stores: written, local };
    }
  };
}

module.exports = { BACKUP_STORES, FILE_PATTERN, buildBackup, encodeBackup, decodeBackup, sanitizeStore, mergeForRestore, backupFileName, suggestFolders, createBackupService, isAppLocalKey };
