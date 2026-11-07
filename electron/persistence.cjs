const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function jsonSchemaError() {
  return Object.assign(new TypeError("JSON数据结构不符合存储约定"), { code: "INVALID_JSON_SCHEMA" });
}

function readJsonFile(filePath, validator) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof validator === "function" && !validator(value)) throw jsonSchemaError();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * ERR-03 修复：主备文件**同时**损坏时必须让上层知道，不能静默回退。
 *
 * 原实现双损坏时直接返回 fallback 且 recovered=false，与「文件不存在」
 * 无法区分。后果：启动时的自动合并会把默认值写回磁盘，覆盖掉损坏但
 * 仍可能人工恢复的原始数据，造成不可逆丢失（23/23 持久化测试均未覆盖该分支）。
 *
 * 新契约（向后兼容，只增加字段）：
 *   { value, recovered, corrupted }
 *   · corrupted=true 表示「主备都读失败且至少有一份存在过」—— 上层应
 *     备份损坏文件再写，而不是直接覆盖。
 *
 * 备份损坏文件：把读失败的原文件复制为 `<name>.corrupted-<时间戳>`，
 * 保留最后一次人工抢救的机会。
 */
// E-05：损坏副本必须有上限。轮询/高频读取每次遇到损坏文件都会复制一份
// .corrupted-<时间戳>，原实现无上限增长（实测连续 5 次读取产生 5 份）。
// 现按「同一源文件只保留最近 CORRUPTED_COPY_LIMIT 份」清理更早的副本；
// 时间戳由 ISO 派生且定长，按文件名升序即按时间升序。
const CORRUPTED_COPY_LIMIT = 3;

function pruneCorruptedCopies(filePath, limit = CORRUPTED_COPY_LIMIT) {
  try {
    const directory = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}.corrupted-`;
    const keep = Math.max(0, Math.floor(Number(limit) || 0));
    const copies = fs.readdirSync(directory).filter((name) => name.startsWith(prefix)).sort();
    for (const name of copies.slice(0, Math.max(0, copies.length - keep))) {
      fs.rmSync(path.join(directory, name), { force: true });
    }
  } catch {
    // 清理失败不能影响主读取路径：最坏情况是副本多留几份。
  }
}

function quarantineFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let target = `${filePath}.corrupted-${stamp}`;
    // 同一毫秒内连续读取会撞名；撞名时加序号，否则 5 次读取只会留下 1 份。
    for (let sequence = 1; fs.existsSync(target); sequence += 1) {
      target = `${filePath}.corrupted-${stamp}-${sequence}`;
    }
    fs.copyFileSync(filePath, target);
    pruneCorruptedCopies(filePath);
    return target;
  } catch {
    return null;
  }
}

function readJsonWithBackup(filePath, backupPath, fallback, validator) {
  const primary = readJsonFile(filePath, validator);
  if (primary.ok) return { value: primary.value, recovered: false, corrupted: false };
  const backup = readJsonFile(backupPath, validator);
  if (backup.ok) return { value: backup.value, recovered: true, corrupted: false };

  // 双损坏：主备都存在但都读不出来 → 这是真实的数据损坏，
  // 不是「首次运行」。把损坏文件留档，并标记 corrupted 让上层避免静默覆盖。
  const hadPrimary = fs.existsSync(filePath);
  const hadBackup = fs.existsSync(backupPath);
  const corrupted = hadPrimary || hadBackup;
  const quarantined = corrupted
    ? [quarantineFile(filePath), quarantineFile(backupPath)].filter(Boolean)
    : [];
  return { value: fallback, recovered: false, corrupted, quarantined };
}

function capItemsPreservingFavorites(items, limit = 500, isFavorite = (item) => item?.favorite === true) {
  const rows = Array.isArray(items) ? items : [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (rows.length <= cap) return [...rows];

  const favoriteCount = rows.reduce(
    (count, item) => count + (isFavorite(item) ? 1 : 0),
    0
  );
  let favoriteSlots = Math.min(cap, favoriteCount);
  let regularSlots = Math.max(0, cap - favoriteSlots);
  const retained = [];

  for (const item of rows) {
    if (isFavorite(item)) {
      if (favoriteSlots <= 0) continue;
      favoriteSlots -= 1;
      retained.push(item);
      continue;
    }
    if (regularSlots <= 0) continue;
    regularSlots -= 1;
    retained.push(item);
  }
  return retained;
}

function writeJsonAtomic(filePath, backupPath, value, validator, onBackupError, options = {}) {
  if (typeof validator === "function" && !validator(value)) throw jsonSchemaError();
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const previousBackupPath = path.join(path.dirname(backupPath), `.${path.basename(backupPath)}.${process.pid}.${randomUUID()}.rollback.tmp`);
  let backupWasReplaced = false;
  let backupPreviouslyExisted = false;
  let preservePreviousBackup = false;
  const replaceBackup = (sourcePath = filePath) => {
    const backupTemporaryPath = path.join(path.dirname(backupPath), `.${path.basename(backupPath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.copyFileSync(sourcePath, backupTemporaryPath);
      const handle = fs.openSync(backupTemporaryPath, "r+");
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(backupTemporaryPath, backupPath);
    } finally {
      try { fs.unlinkSync(backupTemporaryPath); } catch { /* Already renamed or cleanup failed; preserve the original error. */ }
    }
  };
  try {
    const serialized = JSON.stringify(value, null, 2);
    fs.writeFileSync(temporaryPath, serialized, "utf8");
    const handle = fs.openSync(temporaryPath, "r+");
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    const primaryWasValid = readJsonFile(filePath, validator).ok;
    const backupWasValid = readJsonFile(backupPath, validator).ok;
    // Sensitive settings need a recovery copy of the new state (including
    // cleared secrets). Prepare it before the single primary commit so a
    // backup failure cannot falsely reject an already committed save.
    if (options.synchronizeBackup === true) {
      backupPreviouslyExisted = fs.existsSync(backupPath);
      if (backupPreviouslyExisted) fs.copyFileSync(backupPath, previousBackupPath);
      replaceBackup(temporaryPath);
      backupWasReplaced = true;
    }
    // Never replace a known-good backup with a corrupt primary file.
    else if (primaryWasValid) {
      try { replaceBackup(); }
      catch (error) {
        try { if (typeof onBackupError === 'function') onBackupError(error); }
        catch { /* Optional diagnostics cannot prevent the primary commit. */ }
      }
    }
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      // A failed primary commit must not make a newly prepared recovery copy
      // look like an accepted save on the next load, especially when the old
      // primary was corrupt. Restore the exact pre-save backup if possible.
      if (backupWasReplaced) {
        try {
          if (backupPreviouslyExisted) fs.renameSync(previousBackupPath, backupPath);
          else fs.unlinkSync(backupPath);
        } catch (rollbackError) {
          preservePreviousBackup = backupPreviouslyExisted;
          try { if (typeof onBackupError === "function") onBackupError(rollbackError); }
          catch { /* Preserve the primary commit failure. */ }
        }
      }
      throw error;
    }
    // Primary rename is the commit point. A first backup failure degrades
    // recovery, but cannot truthfully turn this committed save into a failure.
    // Keep an existing valid backup when the old primary was corrupt or missing.
    if (options.synchronizeBackup !== true && !primaryWasValid && !backupWasValid) {
      try { replaceBackup(); }
      catch (error) {
        try { if (typeof onBackupError === "function") onBackupError(error); }
        catch { /* Diagnostic failures cannot change the committed result. */ }
      }
    }
    return value;
  } finally {
    if (!preservePreviousBackup) {
      try { fs.unlinkSync(previousBackupPath); } catch { /* Absent or already restored. */ }
    }
    if (fs.existsSync(temporaryPath)) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // A failed cleanup must not hide the original persistence error.
      }
    }
  }
}

module.exports = {
  CORRUPTED_COPY_LIMIT,
  capItemsPreservingFavorites,
  readJsonWithBackup,
  writeJsonAtomic
};
