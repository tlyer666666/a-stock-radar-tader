"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let client;
let restoreTypeScript;
before(() => { restoreTypeScript = registerTypeScript(); client = require("./backupClient.ts"); });
after(() => restoreTypeScript?.());

function memoryStorage(initial, maxBytes = Infinity) {
  const map = new Map(Object.entries(initial));
  const totalBytes = () => [...map.entries()].reduce((sum, [k, v]) => sum + k.length + v.length, 0);
  return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => {
      const next = String(value);
      const prev = map.get(key);
      const delta = (prev === undefined ? key.length + next.length : next.length - prev.length);
      if (totalBytes() + delta > maxBytes) {
        const error = new Error("QuotaExceededError: localStorage 空间不足");
        error.name = "QuotaExceededError";
        throw error;
      }
      map.set(key, next);
    },
    removeItem: key => map.delete(key), dump: () => Object.fromEntries(map) };
}

test("只收集和写回本软件的本地数据，恢复时清掉本软件的旧键、不动别的键", () => {
  const storage = memoryStorage({ "a-stock-radar:notes:v1": "A", "ai-picks-excluded": "B", "other:key": "C" });
  assert.deepEqual(client.collectLocalData(storage), { "a-stock-radar:notes:v1": "A", "ai-picks-excluded": "B" });
  storage.setItem("a-stock-radar:old:v1", "OLD");
  assert.equal(client.restoreLocalData({ "a-stock-radar:notes:v1": "NEW", "evil:key": "X" }, storage), 1);
  assert.deepEqual(storage.dump(), { "other:key": "C", "a-stock-radar:notes:v1": "NEW" });
});

test("恢复配额溢出：优先剔除 :last-good 键重试成功；仍溢出时完整回滚到恢复前快照", () => {
  // 1) 剔除 :last-good 后可放下
  const tight = memoryStorage({ "a-stock-radar:notes:v1": "OLD", "other:key": "KEEP" }, 70);
  const written = client.restoreLocalData({
    "a-stock-radar:notes:v1": "NEW_NOTES_DATA",
    "a-stock-radar:notes:v1:last-good": "BACKUP_NOTES_DATA_THAT_OVERFLOWS_QUOTA"
  }, tight);
  assert.equal(written, 1);
  assert.deepEqual(tight.dump(), { "other:key": "KEEP", "a-stock-radar:notes:v1": "NEW_NOTES_DATA" });

  // 2) 剔除 :last-good 后仍超出配额：必须回滚到 previous 且抛出明确错误
  const initial = { "a-stock-radar:notes:v1": "OLD_1", "ai-picks-excluded": "OLD_2", "other:key": "KEEP" };
  const tooSmall = memoryStorage(initial, 80);
  assert.throws(() => client.restoreLocalData({
    "a-stock-radar:notes:v1": "PARTIAL_OK",
    "a-stock-radar:big": "X".repeat(120),
    "a-stock-radar:notes:v1:last-good": "BACKUP"
  }, tooSmall), /恢复本地数据失败.*回滚/);
  assert.deepEqual(tooSmall.dump(), initial);
});

test("自动备份：开着、选了文件夹、距上次超过 20 小时才备份", () => {
  const now = Date.parse("2026-11-12T16:00:00+08:00");
  assert.equal(client.autoBackupDue({ auto: true, folder: "/x", lastBackupAt: "" }, now), true);
  assert.equal(client.autoBackupDue({ auto: true, folder: "/x", lastBackupAt: new Date(now - 3600_000).toISOString() }, now), false);
  assert.equal(client.autoBackupDue({ auto: true, folder: "/x", lastBackupAt: new Date(now - 21 * 3600_000).toISOString() }, now), true);
  assert.equal(client.autoBackupDue({ auto: false, folder: "/x", lastBackupAt: "" }, now), false);
  assert.equal(client.autoBackupDue({ auto: true, folder: "", lastBackupAt: "" }, now), false);
});

test("本地配额失败时不提交主进程恢复；主进程写入失败时还原本地快照", async () => {
  const key = "a-stock-radar:notes:v1";
  const initial = { [key]: "original", "other:key": "keep" };
  let commits = 0;
  let relaunches = 0;
  const api = {
    prepareRestore: async () => ({ token: "staged", local: { [key]: "x".repeat(160) } }),
    restore: async () => { commits++; throw Error("写入主进程失败"); },
    relaunch: async () => { relaunches++; }
  };
  const small = memoryStorage(initial, 90);
  await assert.rejects(client.restoreBackup(api, "backup", "", small), /恢复本地数据失败/);
  assert.equal(commits, 0);
  assert.deepEqual(small.dump(), initial);
  const normal = memoryStorage(initial);
  await assert.rejects(client.restoreBackup(api, "backup", "", normal), /写入主进程失败/);
  assert.equal(commits, 1);
  assert.equal(relaunches, 0);
  assert.deepEqual(normal.dump(), initial);
});
