const fs = require("node:fs");
const path = require("node:path");

function readJsonFile(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error };
  }
}

function readJsonWithBackup(filePath, backupPath, fallback) {
  const primary = readJsonFile(filePath);
  if (primary.ok) return { value: primary.value, recovered: false };
  const backup = readJsonFile(backupPath);
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

function writeJsonAtomic(filePath, backupPath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    const serialized = JSON.stringify(value, null, 2);
    fs.writeFileSync(temporaryPath, serialized, "utf8");
    const handle = fs.openSync(temporaryPath, "r+");
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    const primaryWasValid = readJsonFile(filePath).ok;
    const backupWasValid = readJsonFile(backupPath).ok;
    // Never replace a known-good backup with a corrupt primary file.
    if (primaryWasValid) fs.copyFileSync(filePath, backupPath);
    fs.renameSync(temporaryPath, filePath);
    // The first successful write must also be immediately recoverable. Keep an
    // existing valid backup when the old primary was corrupt or missing.
    if (!primaryWasValid && !backupWasValid) fs.copyFileSync(filePath, backupPath);
    return value;
  } finally {
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
