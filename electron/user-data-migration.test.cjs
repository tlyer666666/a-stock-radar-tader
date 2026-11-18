"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MIGRATION_MARKER,
  hasAppUserData,
  isAppDataDirName,
  isAppDataFileName,
  migrateLegacyUserData
} = require("./user-data-migration.cjs");

function mkTempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `a-stock-udm-${label}-`));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("migrates business stores, secret key and daily bars while skipping Chromium caches and symlinks", () => {
  const root = mkTempRoot("basic");
  try {
    const legacyDir = path.join(root, "a-stock-monitor");
    const targetDir = path.join(root, "a-stock-trend-radar");
    write(path.join(legacyDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    write(path.join(legacyDir, "settings.last-good.json"), JSON.stringify({ theme: "dark" }));
    write(path.join(legacyDir, "watchlist.json"), JSON.stringify([{ code: "000001" }]));
    write(path.join(legacyDir, "holdings.json"), JSON.stringify([{ code: "600000", shares: 100 }]));
    write(path.join(legacyDir, "ai-profiles.json"), JSON.stringify({ activeId: "p1", profiles: [] }));
    write(path.join(legacyDir, "local-secret.key"), "secret-key-bytes");
    write(path.join(legacyDir, "daily-bars", "000001.json"), JSON.stringify({ bars: [] }));
    // Chromium runtime artifacts and temp files must NOT be migrated.
    write(path.join(legacyDir, "Cache", "data_0"), "chrome-cache");
    write(path.join(legacyDir, "GPUCache", "index"), "gpu-cache");
    write(path.join(legacyDir, "Preferences"), "{}");
    write(path.join(legacyDir, "SingletonSocket"), "socket");
    write(path.join(legacyDir, "settings.json.tmp"), "partial");
    // Symlink must NOT be followed outside legacyDir.
    const outsideFile = path.join(root, "outside-secret.json");
    write(outsideFile, "outside");
    fs.symlinkSync(outsideFile, path.join(legacyDir, "backup-config.json"));

    // Existing Chromium cache in target must not block migration when target has no business data.
    write(path.join(targetDir, "Preferences"), "{\"browser\":true}");

    const first = migrateLegacyUserData({ userDataDir: targetDir });
    assert.equal(first.migrated, true);
    assert.equal(first.reason, "migrated");
    assert.equal(first.sourceName, "a-stock-monitor");
    assert.ok(first.copiedFiles.includes("settings.json"));
    assert.ok(first.copiedFiles.includes("local-secret.key"));
    assert.ok(first.copiedFiles.includes("watchlist.json"));
    assert.ok(first.copiedFiles.includes("holdings.json"));
    assert.ok(first.copiedFiles.includes("ai-profiles.json"));
    assert.equal(fs.existsSync(path.join(targetDir, "daily-bars", "000001.json")), true);
    assert.equal(fs.existsSync(path.join(targetDir, "Cache")), false);
    assert.equal(fs.existsSync(path.join(targetDir, "GPUCache")), false);
    assert.equal(fs.existsSync(path.join(targetDir, "SingletonSocket")), false);
    assert.equal(fs.existsSync(path.join(targetDir, "settings.json.tmp")), false);
    assert.equal(fs.existsSync(path.join(targetDir, "backup-config.json")), false);
    assert.equal(fs.readFileSync(path.join(targetDir, "Preferences"), "utf8"), "{\"browser\":true}");
    if (process.platform !== "win32") {
      const mode = fs.statSync(path.join(targetDir, "local-secret.key")).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    // Mutate target and modify legacy again; second run must be an idempotent no-op.
    write(path.join(targetDir, "settings.json"), JSON.stringify({ theme: "light" }));
    write(path.join(legacyDir, "settings.json"), JSON.stringify({ theme: "should-not-overwrite" }));
    const second = migrateLegacyUserData({ userDataDir: targetDir });
    assert.equal(second.migrated, false);
    assert.equal(second.reason, "already-migrated");
    assert.equal(JSON.parse(fs.readFileSync(path.join(targetDir, "settings.json"), "utf8")).theme, "light");
    assert.equal(fs.existsSync(path.join(targetDir, MIGRATION_MARKER)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skips initialized target and respects disabled option for isolated E2E runs", () => {
  const root = mkTempRoot("guards");
  try {
    const legacyDir = path.join(root, "a-stock-trend-radar");
    const targetDir = path.join(root, "a-stock-monitor");
    write(path.join(legacyDir, "settings.json"), JSON.stringify({ riskProfile: "aggressive" }));
    write(path.join(targetDir, "settings.json"), JSON.stringify({ riskProfile: "conservative" }));

    const blockedDisabled = migrateLegacyUserData({ userDataDir: path.join(root, "e2e-empty"), disabled: true });
    assert.equal(blockedDisabled.migrated, false);
    assert.equal(blockedDisabled.reason, "disabled");

    const blockedInitialized = migrateLegacyUserData({ userDataDir: targetDir });
    assert.equal(blockedInitialized.migrated, false);
    assert.equal(blockedInitialized.reason, "already-initialized");
    assert.equal(JSON.parse(fs.readFileSync(path.join(targetDir, "settings.json"), "utf8")).riskProfile, "conservative");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prefers the most recently active sibling profile when multiple legacy directories contain data", () => {
  const root = mkTempRoot("recency");
  try {
    const olderDir = path.join(root, "a-stock-monitor");
    const newerDir = path.join(root, "a-stock-trend-radar");
    const targetDir = path.join(root, "A股雷达");
    write(path.join(olderDir, "settings.json"), JSON.stringify({ marker: "older" }));
    write(path.join(newerDir, "settings.json"), JSON.stringify({ marker: "newer" }));
    const past = new Date(Date.now() - 86_400_000);
    fs.utimesSync(path.join(olderDir, "settings.json"), past, past);

    const result = migrateLegacyUserData({ userDataDir: targetDir });
    assert.equal(result.migrated, true);
    assert.equal(result.sourceName, "a-stock-trend-radar");
    assert.equal(JSON.parse(fs.readFileSync(path.join(targetDir, "settings.json"), "utf8")).marker, "newer");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recognizes daily-bars-only profiles, rejects empty sibling roots, and validates file/dir allowlists", () => {
  const root = mkTempRoot("helpers");
  try {
    const emptyTarget = path.join(root, "a-stock-monitor");
    const dailyOnlyLegacy = path.join(root, "a-stock-trend-radar");
    assert.equal(migrateLegacyUserData({ userDataDir: emptyTarget }).reason, "no-legacy-profile");

    assert.equal(isAppDataFileName("settings.json"), true);
    assert.equal(isAppDataFileName("settings.last-good.json"), true);
    assert.equal(isAppDataFileName("local-secret.key"), true);
    assert.equal(isAppDataFileName("Preferences"), false);
    assert.equal(isAppDataDirName("daily-bars"), true);
    assert.equal(isAppDataDirName("Cache"), false);

    assert.equal(hasAppUserData(dailyOnlyLegacy), false);
    write(path.join(dailyOnlyLegacy, "daily-bars", "600000.json"), JSON.stringify({ bars: [] }));
    assert.equal(hasAppUserData(dailyOnlyLegacy), true);

    const migrated = migrateLegacyUserData({ userDataDir: emptyTarget });
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.copiedDirs.length, 1);
    assert.equal(fs.existsSync(path.join(emptyTarget, "daily-bars", "600000.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
