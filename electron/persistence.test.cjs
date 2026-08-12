const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  capItemsPreservingFavorites,
  readJsonWithBackup,
  writeJsonAtomic
} = require("./persistence.cjs");

function createFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a-stock-radar-persistence-"));
}

test("watchlist caps retain favorites before automatic pool entries", () => {
  const automatic = Array.from({ length: 500 }, (_, index) => ({
    code: String(index).padStart(6, "0"),
    autoAdded: true,
    favorite: false
  }));
  const favorites = [
    { code: "600519", autoAdded: true, favorite: true },
    { code: "300750", autoAdded: false, favorite: false }
  ];
  const input = [...automatic, ...favorites];

  const retained = capItemsPreservingFavorites(
    input,
    500,
    (item) => item.favorite === true || item.autoAdded !== true
  );

  assert.equal(retained.length, 500);
  assert.deepEqual(retained.slice(-2).map((item) => item.code), ["600519", "300750"]);
  assert.equal(retained.filter((item) => item.autoAdded && !item.favorite).length, 498);
  assert.equal(input.length, 502, "the helper must not mutate its input");
});

test("favorite entries win when favorites alone exceed the cap", () => {
  const retained = capItemsPreservingFavorites([
    { code: "000001", favorite: false },
    { code: "600519", favorite: true },
    { code: "300750", favorite: true },
    { code: "002594", favorite: true }
  ], 2);

  assert.deepEqual(retained.map((item) => item.code), ["600519", "300750"]);
});

test("the first atomic JSON write immediately creates a recoverable last-good copy", () => {
  const directory = createFixture();
  const primary = path.join(directory, "watchlist.json");
  const backup = path.join(directory, "watchlist.last-good.json");
  try {
    writeJsonAtomic(primary, backup, [{ code: "600519", favorite: true }]);

    assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), [
      { code: "600519", favorite: true }
    ]);
    fs.writeFileSync(primary, "{broken", "utf8");
    assert.deepEqual(readJsonWithBackup(primary, backup, []).value, [
      { code: "600519", favorite: true }
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("atomic JSON writes retain a last-good copy and recover from a corrupt primary", () => {
  const directory = createFixture();
  const primary = path.join(directory, "holdings.json");
  const backup = path.join(directory, "holdings.last-good.json");
  try {
    writeJsonAtomic(primary, backup, [{ code: "600519", shares: 100 }]);
    writeJsonAtomic(primary, backup, [{ code: "300750", shares: 200 }]);
    fs.writeFileSync(primary, "{broken", "utf8");
    const restored = readJsonWithBackup(primary, backup, []);
    assert.equal(restored.recovered, true);
    assert.deepEqual(restored.value, [{ code: "600519", shares: 100 }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed serialization cannot overwrite a previously valid JSON file", () => {
  const directory = createFixture();
  const primary = path.join(directory, "settings.json");
  const backup = path.join(directory, "settings.last-good.json");
  try {
    writeJsonAtomic(primary, backup, { version: 1 });
    assert.throws(() => writeJsonAtomic(primary, backup, { invalid: BigInt(1) }));
    assert.deepEqual(JSON.parse(fs.readFileSync(primary, "utf8")), { version: 1 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt primary cannot replace the last-good backup during a later write", () => {
  const directory = createFixture();
  const primary = path.join(directory, "watchlist.json");
  const backup = path.join(directory, "watchlist.last-good.json");
  try {
    writeJsonAtomic(primary, backup, { version: 1 });
    writeJsonAtomic(primary, backup, { version: 2 });
    fs.writeFileSync(primary, "{broken", "utf8");

    writeJsonAtomic(primary, backup, { version: 3 });

    assert.deepEqual(JSON.parse(fs.readFileSync(primary, "utf8")), { version: 3 });
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), { version: 1 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
