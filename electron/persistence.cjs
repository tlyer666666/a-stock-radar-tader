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

function readJsonWithBackup(filePath, backupPath, fallback, validator) {
  const primary = readJsonFile(filePath, validator);
  if (primary.ok) return { value: primary.value, recovered: false };
  const backup = readJsonFile(backupPath, validator);
  if (backup.ok) return { value: backup.value, recovered: true };
  return { value: fallback, recovered: false };
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
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
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
    else if (primaryWasValid) replaceBackup();
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
  capItemsPreservingFavorites,
  readJsonFile,
  readJsonWithBackup,
  writeJsonAtomic
};
