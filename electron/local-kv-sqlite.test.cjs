"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_DB_FILENAME,
  MAX_KEY_LENGTH,
  MAX_VALUE_BYTES,
  createLocalKvStore
} = require("./local-kv-sqlite.cjs");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astock-kv-sqlite-"));
  const closers = [];
  // node:test t.after runs in FIFO registration order: close SQLite handles
  // explicitly before removing the directory so Windows never sees EBUSY.
  t.after(() => {
    for (const close of closers.splice(0).reverse()) {
      try { close(); } catch { /* ignore */ }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    dir,
    track(store) {
      closers.push(() => store.close());
      return store;
    }
  };
}

test("creates radar-store.sqlite under userDataDir with strict permissions and persists values across reopen", (t) => {
  const { dir, track } = tempDir(t);
  const root = path.join(dir, "nested-user-data");
  let clock = 1_700_000_000_000;
  const store = track(createLocalKvStore({ userDataDir: root, now: () => clock }));
  const expectedPath = path.join(root, DEFAULT_DB_FILENAME);

  assert.equal(fs.existsSync(expectedPath), true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(expectedPath).mode & 0o777, 0o600);
  }

  assert.equal(store.get("a-stock-radar:notes:v1"), null);
  assert.equal(store.set("a-stock-radar:notes:v1", JSON.stringify({ notes: ["茅台复盘"] })), true);
  clock += 1000;
  assert.equal(store.set("ai-picks-excluded", "[\"600519\"]"), true);
  assert.deepEqual(store.keys(), ["a-stock-radar:notes:v1", "ai-picks-excluded"]);

  const stats = store.stats();
  assert.equal(stats.keyCount, 2);
  assert.equal(
    stats.totalBytes,
    Buffer.byteLength(JSON.stringify({ notes: ["茅台复盘"] }), "utf8") + Buffer.byteLength("[\"600519\"]", "utf8")
  );
  assert.ok(stats.fileBytes > 0);
  assert.equal(stats.filePath, expectedPath);

  assert.equal(store.set("ai-picks-excluded", "[]"), true);
  assert.equal(store.get("ai-picks-excluded"), "[]");
  assert.equal(store.remove("ai-picks-excluded"), true);
  assert.equal(store.remove("ai-picks-excluded"), false);
  assert.equal(store.get("ai-picks-excluded"), null);

  store.close();
  // Reopen using explicit filePath
  const reopened = track(createLocalKvStore({ filePath: expectedPath }));
  assert.equal(reopened.get("a-stock-radar:notes:v1"), JSON.stringify({ notes: ["茅台复盘"] }));
  assert.deepEqual(reopened.keys(), ["a-stock-radar:notes:v1"]);
});

test("fails closed on invalid keys, non-string values, oversized payloads and missing path", (t) => {
  assert.throws(() => createLocalKvStore({}), { code: "INVALID_KV_PATH" });

  const { dir, track } = tempDir(t);
  const filePath = path.join(dir, "kv.sqlite");
  const store = track(createLocalKvStore({ filePath }));

  for (const badKey of ["", "   ", "has space", "a/b", "a\\b", "key;DROP TABLE kv_store", "k".repeat(MAX_KEY_LENGTH + 1), null, 123]) {
    assert.throws(() => store.get(badKey), { code: "INVALID_KV_KEY" });
    assert.throws(() => store.set(badKey, "ok"), { code: "INVALID_KV_KEY" });
    assert.throws(() => store.remove(badKey), { code: "INVALID_KV_KEY" });
  }

  for (const badValue of [null, undefined, 42, { a: 1 }, ["x"]]) {
    assert.throws(() => store.set("valid.key_1:a-b", badValue), { code: "INVALID_KV_VALUE" });
  }

  const oversized = "a".repeat(MAX_VALUE_BYTES + 1);
  assert.throws(() => store.set("oversized:key", oversized), { code: "KV_VALUE_TOO_LARGE" });
  assert.equal(store.get("oversized:key"), null);
});

test("close is idempotent, never leaks exceptions, and blocks subsequent calls", (t) => {
  const { dir, track } = tempDir(t);
  const filePath = path.join(dir, "close-test.sqlite");
  const store = track(createLocalKvStore({ filePath }));
  store.set("k1", "v1");
  assert.doesNotThrow(() => store.close());
  assert.doesNotThrow(() => store.close());
  assert.throws(() => store.get("k1"), { code: "KV_STORE_CLOSED" });
  assert.throws(() => store.set("k1", "v2"), { code: "KV_STORE_CLOSED" });
  assert.throws(() => store.remove("k1"), { code: "KV_STORE_CLOSED" });
  assert.throws(() => store.keys(), { code: "KV_STORE_CLOSED" });
  assert.throws(() => store.stats(), { code: "KV_STORE_CLOSED" });
});

test("rejects symlinked database path", (t) => {
  const { dir } = tempDir(t);
  const realTarget = path.join(dir, "real.sqlite");
  const symlinkPath = path.join(dir, "link.sqlite");
  fs.writeFileSync(realTarget, "");
  try {
    fs.symlinkSync(realTarget, symlinkPath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "ENOTSUP") return;
    throw error;
  }
  assert.throws(() => createLocalKvStore({ filePath: symlinkPath }), { code: "INVALID_KV_PATH" });
});

test("H-2 & M-2: enforces key-count cap, total byte quota, control-char rejection, transactional replaceKeys, and WAL checkpoint on close", (t) => {
  const { dir, track } = tempDir(t);
  const filePath = path.join(dir, "quota.sqlite");
  const store = track(createLocalKvStore({ filePath, maxKeys: 3, maxTotalBytes: 20 }));

  // Rejects control characters in keys
  assert.throws(() => store.set("a\x00b", "v"), { code: "INVALID_KV_KEY" });
  assert.throws(() => store.set("a\nb", "v"), { code: "INVALID_KV_KEY" });

  // Key count cap: 3 distinct keys allowed, 4th rejected, updating existing key allowed
  store.set("k1", "aaaa");
  store.set("k2", "bbbb");
  store.set("k3", "cccc");
  assert.throws(() => store.set("k4", "d"), { code: "KV_KEY_LIMIT_EXCEEDED" });
  assert.equal(store.set("k3", "dddd"), true);

  // Total byte quota: 4 + 4 + 4 = 12; updating k3 to 13 bytes -> total 21 > 20 -> rejected
  assert.throws(() => store.set("k3", "x".repeat(13)), { code: "KV_QUOTA_EXCEEDED" });
  assert.equal(store.get("k3"), "dddd");
  // Updating k3 to 12 bytes -> total 20 <= 20 -> allowed
  assert.equal(store.set("k3", "x".repeat(12)), true);

  // Transactional replaceKeys: succeeds atomically
  assert.equal(store.replaceKeys([["k1", "11"], ["k4", "44"]], ["k2", "k3"]), true);
  assert.deepEqual(store.keys(), ["k1", "k4"]);
  assert.equal(store.get("k4"), "44");

  // Transactional replaceKeys: rolls back completely if quota exceeded
  assert.throws(
    () => store.replaceKeys([["k1", "NEW"], ["k5", "x".repeat(19)]], ["k4"]),
    { code: "KV_QUOTA_EXCEEDED" }
  );
  assert.deepEqual(store.keys(), ["k1", "k4"], "failed replaceKeys must roll back removals and writes");
  assert.equal(store.get("k1"), "11");
  assert.equal(store.get("k4"), "44");

  // Close runs WAL checkpoint(TRUNCATE) so main sqlite file holds all data cleanly
  store.close();
  const walPath = `${filePath}-wal`;
  if (fs.existsSync(walPath)) {
    assert.equal(fs.statSync(walPath).size, 0, "WAL must be truncated on close");
  }
  const reopened = track(createLocalKvStore({ filePath }));
  assert.equal(reopened.get("k1"), "11");
  assert.equal(reopened.get("k4"), "44");
});
