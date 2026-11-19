"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const KNOWN_USER_DATA_NAMES = Object.freeze([
  "a-stock-trend-radar",
  "a-stock-monitor",
  "A股雷达趋势版",
  "A股雷达"
]);

const MIGRATION_MARKER = ".user-data-migrated.json";

const SENTINEL_FILES = Object.freeze([
  "settings.json",
  "settings.last-good.json",
  "ai-profiles.json",
  "ai-profiles.last-good.json",
  "watchlist.json",
  "watchlist.last-good.json",
  "holdings.json",
  "holdings.last-good.json",
  "custom-strategies.json",
  "backup-config.json",
  "stock-agent.json",
  "local-secret.key"
]);

const APP_DATA_FILE_RE =
  /^(?:settings|watchlist|holdings|custom-strategies|ai-profiles|ai-selection|ai-custom-stocks|ai-framework|stock-agent|backup-config|external-factors-history|stock-industry-index|convertible-roster|failed-boards|fuyao|strategy-selection)(?:\.last-good)?\.json$/i;

function isAppDataFileName(name) {
  return name === "local-secret.key" || name === "runtime-errors.log" || APP_DATA_FILE_RE.test(name);
}

function isAppDataDirName(name) {
  return name === "daily-bars";
}

function isRegularNonEmptyFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
  } catch {
    return false;
  }
}

function hasDailyBarFiles(dirPath) {
  const barsDir = path.join(dirPath, "daily-bars");
  try {
    const stat = fs.lstatSync(barsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return fs.readdirSync(barsDir).some(name => !name.startsWith("."));
  } catch {
    return false;
  }
}

function hasAppUserData(dirPath) {
  try {
    const stat = fs.lstatSync(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  if (SENTINEL_FILES.some(name => isRegularNonEmptyFile(path.join(dirPath, name)))) {
    return true;
  }
  return hasDailyBarFiles(dirPath);
}

function latestSentinelMtime(dirPath) {
  let latest = 0;
  for (const name of SENTINEL_FILES) {
    try {
      const stat = fs.lstatSync(path.join(dirPath, name));
      if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs > latest) {
        latest = stat.mtimeMs;
      }
    } catch {
      // Missing sentinel file is normal for partial profiles.
    }
  }
  try {
    const barsStat = fs.lstatSync(path.join(dirPath, "daily-bars"));
    if (barsStat.isDirectory() && !barsStat.isSymbolicLink() && barsStat.mtimeMs > latest) {
      latest = barsStat.mtimeMs;
    }
  } catch {
    // Missing daily-bars is fine.
  }
  return latest;
}

function copyFileIfAbsent(srcFile, destFile, options = {}) {
  const srcStat = fs.lstatSync(srcFile);
  if (!srcStat.isFile() || srcStat.isSymbolicLink()) return false;
  if (fs.existsSync(destFile)) return false;
  fs.mkdirSync(path.dirname(destFile), { recursive: true, mode: 0o700 });
  const tempFile = `${destFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const content = fs.readFileSync(srcFile);
    const mode = options.mode !== undefined ? options.mode : 0o600;
    fs.writeFileSync(tempFile, content, { flag: "wx", mode });
    if (process.platform !== "win32") {
      try { fs.chmodSync(tempFile, mode); } catch { /* Best effort on restricted FS. */ }
    }
    fs.renameSync(tempFile, destFile);
    return true;
  } finally {
    try { fs.rmSync(tempFile, { force: true }); } catch { /* Best-effort temp cleanup. */ }
  }
}

function copyDirFilesIfAbsent(srcDir, destDir) {
  let copiedCount = 0;
  const srcStat = fs.lstatSync(srcDir);
  if (!srcStat.isDirectory() || srcStat.isSymbolicLink()) return 0;
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.endsWith(".tmp") || entry.isSymbolicLink()) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copiedCount += copyDirFilesIfAbsent(srcPath, destPath);
    } else if (entry.isFile()) {
      if (copyFileIfAbsent(srcPath, destPath, { mode: 0o600 })) copiedCount += 1;
    }
  }
  return copiedCount;
}

function selectBestLegacyProfile(parentDir, targetName, candidates) {
  const matches = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidateName = candidates[index];
    if (!candidateName || candidateName === targetName) continue;
    const candidateDir = path.join(parentDir, candidateName);
    if (!hasAppUserData(candidateDir)) continue;
    matches.push({
      name: candidateName,
      dir: candidateDir,
      mtimeMs: latestSentinelMtime(candidateDir),
      priority: index
    });
  }
  matches.sort((left, right) => (right.mtimeMs - left.mtimeMs) || (left.priority - right.priority));
  return matches[0] || null;
}

/**
 * 唯一软件/开发构建身份切换时的 userData 安全一次性迁移：
 * 当当前 userData 目录尚未写入业务数据，且同级目录下存在历史身份目录时，
 * 仅复制业务 JSON、本地密钥和日线缓存（绝不复制 Chromium 缓存或锁文件，绝不覆盖已有文件）。
 */
function migrateLegacyUserData(options = {}) {
  const userDataDir = options.userDataDir;
  if (options.disabled || !userDataDir) {
    return { migrated: false, reason: "disabled" };
  }
  const targetDir = path.resolve(userDataDir);
  const markerPath = path.join(targetDir, MIGRATION_MARKER);
  if (fs.existsSync(markerPath)) {
    return { migrated: false, reason: "already-migrated" };
  }
  if (hasAppUserData(targetDir)) {
    return { migrated: false, reason: "already-initialized" };
  }

  const parentDir = path.dirname(targetDir);
  const targetName = path.basename(targetDir);
  const candidates = Array.isArray(options.candidates) && options.candidates.length
    ? options.candidates
    : KNOWN_USER_DATA_NAMES;

  const source = selectBestLegacyProfile(parentDir, targetName, candidates);
  if (!source) {
    return { migrated: false, reason: "no-legacy-profile" };
  }

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const copiedFiles = [];
  const copiedDirs = [];

  for (const entry of fs.readdirSync(source.dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(source.dir, entry.name);
    const destPath = path.join(targetDir, entry.name);
    if (entry.isFile() && isAppDataFileName(entry.name)) {
      if (copyFileIfAbsent(srcPath, destPath, { mode: 0o600 })) {
        copiedFiles.push(entry.name);
      }
    } else if (entry.isDirectory() && isAppDataDirName(entry.name)) {
      const count = copyDirFilesIfAbsent(srcPath, destPath);
      if (count > 0) copiedDirs.push({ name: entry.name, files: count });
    }
  }

  const marker = {
    schemaVersion: 1,
    migratedAt: new Date().toISOString(),
    sourceName: source.name,
    sourceDir: source.dir,
    targetDir,
    copiedFiles,
    copiedDirs
  };
  const tempMarker = `${markerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempMarker, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(tempMarker, markerPath);
  } finally {
    try { fs.rmSync(tempMarker, { force: true }); } catch { /* Best effort. */ }
  }

  return {
    migrated: true,
    reason: "migrated",
    sourceName: source.name,
    sourceDir: source.dir,
    targetDir,
    copiedFiles,
    copiedDirs
  };
}

module.exports = {
  KNOWN_USER_DATA_NAMES,
  MIGRATION_MARKER,
  SENTINEL_FILES,
  hasAppUserData,
  isAppDataDirName,
  isAppDataFileName,
  migrateLegacyUserData
};
