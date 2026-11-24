"use strict";

// 本地 SQLite 键值库：基于 Node 内置 node:sqlite（DatabaseSync），零外部依赖。
// 用于替代渲染进程 localStorage 中较大的持久化数据，支持 WAL 模式与 0600 权限收敛。
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_DB_FILENAME = "radar-store.sqlite";
const KEY_PATTERN = /^[a-zA-Z0-9:._-]+$/;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_BYTES = 32 * 1024 * 1024;

function fail(ErrorCtor, code, message) {
  return Object.assign(new ErrorCtor(message), { code });
}

function validateKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
    throw fail(TypeError, "INVALID_KV_KEY", "本地键值库键名无效（需为 1-128 位字母、数字或 :._-）");
  }
  return key;
}

function validateValue(value) {
  if (typeof value !== "string") {
    throw fail(TypeError, "INVALID_KV_VALUE", "本地键值库仅接受字符串值");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_VALUE_BYTES) {
    throw fail(RangeError, "KV_VALUE_TOO_LARGE", "本地键值库单个键值超过 32MB 上限");
  }
  return value;
}

function safeChmod(targetPath, mode) {
  if (process.platform === "win32" || !targetPath || targetPath === ":memory:") return false;
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) return false;
    fs.chmodSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function tightenDbFiles(filePath) {
  if (process.platform === "win32" || !filePath || filePath === ":memory:") return;
  for (const suffix of ["", "-wal", "-shm"]) {
    safeChmod(`${filePath}${suffix}`, 0o600);
  }
}

function resolveDbPath({ filePath, userDataDir } = {}) {
  if (typeof filePath === "string" && filePath.trim()) {
    return filePath.trim();
  }
  if (typeof userDataDir === "string" && userDataDir.trim()) {
    return path.join(userDataDir.trim(), DEFAULT_DB_FILENAME);
  }
  throw fail(TypeError, "INVALID_KV_PATH", "缺少本地键值库文件路径");
}

function createLocalKvStore({ filePath, userDataDir, now = () => Date.now() } = {}) {
  const resolvedPath = resolveDbPath({ filePath, userDataDir });
  const isMemory = resolvedPath === ":memory:";

  if (!isMemory) {
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    safeChmod(dir, 0o700);
    let targetIsSymlink = false;
    try {
      targetIsSymlink = fs.lstatSync(resolvedPath).isSymbolicLink();
    } catch {
      targetIsSymlink = false;
    }
    if (targetIsSymlink) {
      throw fail(TypeError, "INVALID_KV_PATH", "本地键值库路径不能为符号链接");
    }
  }

  const db = new DatabaseSync(resolvedPath);
  let closed = false;

  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    tightenDbFiles(resolvedPath);
  } catch (error) {
    closed = true;
    try { db.close(); } catch { /* ignore */ }
    throw error;
  }

  const stmtGet = db.prepare("SELECT value FROM kv_store WHERE key = ?");
  const stmtSet = db.prepare(`
    INSERT INTO kv_store (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
  const stmtRemove = db.prepare("DELETE FROM kv_store WHERE key = ?");
  const stmtKeys = db.prepare("SELECT key FROM kv_store ORDER BY key ASC");
  const stmtStats = db.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS totalBytes FROM kv_store"
  );

  function ensureOpen() {
    if (closed) {
      throw fail(Error, "KV_STORE_CLOSED", "本地键值库已关闭");
    }
  }

  return {
    get(key) {
      ensureOpen();
      const validKey = validateKey(key);
      const row = stmtGet.get(validKey);
      return row ? String(row.value) : null;
    },
    set(key, value) {
      ensureOpen();
      const validKey = validateKey(key);
      const validValue = validateValue(value);
      const timestamp = Number.isFinite(Number(now())) ? Math.trunc(Number(now())) : Date.now();
      stmtSet.run(validKey, validValue, timestamp);
      tightenDbFiles(resolvedPath);
      return true;
    },
    remove(key) {
      ensureOpen();
      const validKey = validateKey(key);
      const result = stmtRemove.run(validKey);
      return Number(result?.changes || 0) > 0;
    },
    keys() {
      ensureOpen();
      return stmtKeys.all().map((row) => String(row.key));
    },
    stats() {
      ensureOpen();
      const row = stmtStats.get() || { count: 0, totalBytes: 0 };
      let fileBytes = 0;
      if (!isMemory) {
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            const stat = fs.statSync(`${resolvedPath}${suffix}`);
            if (stat.isFile()) fileBytes += Number(stat.size) || 0;
          } catch {
            // Sidecar files may not exist yet.
          }
        }
      }
      return {
        keyCount: Number(row.count) || 0,
        totalBytes: Number(row.totalBytes) || 0,
        fileBytes,
        filePath: resolvedPath
      };
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        // Never leak exceptions on close.
      }
    }
  };
}

module.exports = {
  DEFAULT_DB_FILENAME,
  KEY_PATTERN,
  MAX_KEY_LENGTH,
  MAX_VALUE_BYTES,
  createLocalKvStore
};
