"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let client;
let restoreTypeScript;
before(() => { restoreTypeScript = registerTypeScript(); client = require("./backupClient.ts"); });
after(() => restoreTypeScript?.());

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial));
  return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), dump: () => Object.fromEntries(map) };
}

test("只收集和写回本软件的本地数据，恢复时清掉本软件的旧键、不动别的键", () => {
  const storage = memoryStorage({ "a-stock-radar:notes:v1": "A", "ai-picks-excluded": "B", "other:key": "C" });
  assert.deepEqual(client.collectLocalData(storage), { "a-stock-radar:notes:v1": "A", "ai-picks-excluded": "B" });
  storage.setItem("a-stock-radar:old:v1", "OLD");
  assert.equal(client.restoreLocalData({ "a-stock-radar:notes:v1": "NEW", "evil:key": "X" }, storage), 1);
  assert.deepEqual(storage.dump(), { "other:key": "C", "a-stock-radar:notes:v1": "NEW" });
});

test("自动备份：开着、选了文件夹、距上次超过 20 小时才备份", () => {
  const now = Date.parse("2026-11-12T16:00:00+08:00");
  assert.equal(client.autoBackupDue({ auto: true, folder: "/x", lastBackupAt: "" }, now), true);
  assert.equal(client.autoBackupDue({ auto: true, folder: "/x", lastBackupAt: new Date(now - 3600_000).toISOString() }, now), false);
  assert.equal(client.autoBackupDue({ auto: true, folder: "/x", lastBackupAt: new Date(now - 21 * 3600_000).toISOString() }, now), true);
  assert.equal(client.autoBackupDue({ auto: false, folder: "/x", lastBackupAt: "" }, now), false);
  assert.equal(client.autoBackupDue({ auto: true, folder: "", lastBackupAt: "" }, now), false);
});
