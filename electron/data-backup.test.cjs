"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const backup = require("./data-backup.cjs");

const NOW = Date.parse("2026-11-12T16:05:09+08:00");
function service(stores, { folder, config = {} } = {}) {
  let saved = { folder, ...config };
  const data = structuredClone(stores);
  const api = backup.createBackupService({
    readStore: name => structuredClone(data[name] ?? null),
    writeStore: (name, value) => { data[name] = value; },
    readConfig: () => saved, writeConfig: value => { saved = value; },
    encryptSecret: value => `enc:${value}`, decryptSecret: value => value.replace(/^enc:/, ""),
    appVersion: "1.6.64", now: () => NOW
  });
  return { api, data, config: () => saved };
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "astock-backup-"));
const STORES = {
  settings: { provider: "ths", theme: "dark", refreshToken: "safe:REFRESH", aiApiKey: "safe:AI" },
  holdings: [{ code: "600519", shares: 100, costPrice: 1500 }],
  "ai-profiles": { activeId: "p1", profiles: [{ id: "p1", name: "DeepSeek", model: "deepseek-chat", apiKey: "safe:KEY" }] },
  "stock-agent": { conversations: [{ id: "c1" }] }
};

test("备份文件不含令牌和 API Key，含本地存储里本软件的数据，按北京时间命名", () => {
  const dir = tempDir();
  const { api } = service(STORES, { folder: dir });
  const result = api.run({ "a-stock-radar:notes:v1": "{\"notes\":[]}", "other-site": "x", "ai-picks-excluded": "[]" });
  assert.equal(result.name, "A股雷达备份-20261112-160509.json");
  const text = fs.readFileSync(path.join(dir, result.name), "utf8");
  assert.doesNotMatch(text, /REFRESH|safe:AI|safe:KEY/);
  const parsed = backup.decodeBackup(text);
  assert.equal(parsed.stores.settings.theme, "dark");
  assert.equal(parsed.stores.holdings[0].code, "600519");
  assert.deepEqual(Object.keys(parsed.local).sort(), ["a-stock-radar:notes:v1", "ai-picks-excluded"]);
  assert.equal(api.status().files.length, 1);
});

test("设了密码就整份加密；密码不对或没给密码时拒绝，给对了能读", () => {
  const dir = tempDir();
  const { api } = service(STORES, { folder: dir });
  api.configure({ password: "我的密码123" });
  const { name } = api.run({});
  const text = fs.readFileSync(path.join(dir, name), "utf8");
  assert.doesNotMatch(text, /600519|deepseek/);
  assert.throws(() => backup.decodeBackup(text), { code: "BACKUP_PASSWORD_REQUIRED" });
  assert.throws(() => backup.decodeBackup(text, "错的"), { code: "BACKUP_WRONG_PASSWORD" });
  assert.equal(backup.decodeBackup(text, "我的密码123").stores.holdings[0].code, "600519");
  assert.equal(api.inspect(name).stores.includes("holdings"), true, "本机记着密码，预览不用再输");
});

test("恢复：写回数据但保留本机现有的密钥；返回本地存储键值", () => {
  const dir = tempDir();
  const source = service(STORES, { folder: dir });
  const { name } = source.api.run({ "a-stock-radar:notes:v1": "{\"notes\":[1]}" });
  const target = service({ settings: { provider: "eastmoney", refreshToken: "safe:NEW-MACHINE" }, "ai-profiles": { profiles: [{ id: "p1", apiKey: "safe:LOCAL" }] } }, { folder: dir });
  const result = target.api.restore(name);
  assert.deepEqual(result.local, { "a-stock-radar:notes:v1": "{\"notes\":[1]}" });
  assert.equal(target.data.settings.provider, "ths");
  assert.equal(target.data.settings.refreshToken, "safe:NEW-MACHINE", "本机令牌不被覆盖");
  assert.equal(target.data.settings.aiApiKey, undefined);
  assert.equal(target.data["ai-profiles"].profiles[0].apiKey, "safe:LOCAL");
  assert.equal(target.data.holdings[0].shares, 100);
});

test("只保留最近 N 份，只删本软件命名的备份；不认识的文件名拒绝恢复", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "我的其他文件.json"), "{}");
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dir, `A股雷达备份-2026110${i}-090000.json`), "{}");
  const { api } = service(STORES, { folder: dir, config: { keep: 3 } });
  api.run({});
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.filter(name => backup.FILE_PATTERN.test(name)).length, 3);
  assert.ok(names.includes("我的其他文件.json"));
  assert.throws(() => api.restore("../settings.json"), { code: "BACKUP_INVALID" });
  assert.throws(() => backup.decodeBackup("{\"format\":\"x\"}"), { code: "BACKUP_INVALID" });
});

test("没选文件夹时不能备份，并记下失败原因", () => {
  const { api, config } = service(STORES, { folder: "" });
  assert.throws(() => api.run({}), { code: "BACKUP_FOLDER" });
  assert.throws(() => api.configure({ folder: "relative/dir" }), { code: "BACKUP_FOLDER" });
  const dir = path.join(tempDir(), "不存在的子目录");
  api.configure({ folder: dir });
  api.run({});
  assert.ok(fs.existsSync(dir), "文件夹不存在时自动创建");
  assert.equal(config().lastError, "");
});

test("常见网盘文件夹：iCloud、Google 云端硬盘", () => {
  const home = "/Users/u";
  const existing = new Set([`${home}/Library/Mobile Documents/com~apple~CloudDocs`, `${home}/Library/CloudStorage`, `${home}/Library/CloudStorage/GoogleDrive-a@b.com/我的云端硬盘`]);
  const list = backup.suggestFolders({ home, platform: "darwin", exists: dir => existing.has(dir), readdir: () => ["GoogleDrive-a@b.com"] });
  assert.deepEqual(list.map(item => item.label), ["iCloud 云盘", "Google 云端硬盘"]);
  assert.match(list[1].path, /我的云端硬盘\/A股雷达备份$/);
});
