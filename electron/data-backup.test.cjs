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
  "ai-profiles": { activeId: "p1", profiles: [{ id: "p1", name: "DeepSeek", baseUrl: "https://api.deepseek.example/v1", model: "deepseek-chat", apiKey: "safe:KEY" }] },
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
  const target = service({ settings: { provider: "eastmoney", refreshToken: "safe:NEW-MACHINE" }, "ai-profiles": { profiles: [{ id: "p1", baseUrl: "https://api.deepseek.example/v2", apiKey: "safe:LOCAL" }] } }, { folder: dir });
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

test("配置了备份密码但解密失败时立即报错，绝不降级写明文；rename 失败时清理 .part 临时文件", () => {
  const dir = tempDir();
  let saved = { folder: dir, password: "safe:CORRUPT_OR_LOCKED", auto: true, keep: 30, lastBackupAt: "", lastError: "" };
  const api = backup.createBackupService({
    readStore: name => structuredClone(STORES[name] ?? null),
    writeStore: () => {},
    readConfig: () => saved,
    writeConfig: value => { saved = value; },
    encryptSecret: value => `enc:${value}`,
    decryptSecret: () => "",
    appVersion: "1.6.64",
    now: () => NOW
  });
  assert.throws(() => api.run({}), { code: "BACKUP_PASSWORD_UNREADABLE" });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.match(saved.lastError, /密码/);

  let renameFailed = false;
  let savedPlain = { folder: dir, password: "", auto: true, keep: 30, lastBackupAt: "", lastError: "" };
  const fsFailRename = {
    ...fs,
    renameSync: () => {
      renameFailed = true;
      throw Object.assign(new Error("rename failed"), { code: "EIO" });
    }
  };
  const api2 = backup.createBackupService({
    readStore: name => structuredClone(STORES[name] ?? null),
    writeStore: () => {},
    readConfig: () => savedPlain,
    writeConfig: value => { savedPlain = value; },
    encryptSecret: value => `enc:${value}`,
    decryptSecret: value => value,
    appVersion: "1.6.64",
    now: () => NOW,
    fsApi: fsFailRename
  });
  assert.throws(() => api2.run({}), { code: "EIO" });
  assert.equal(renameFailed, true);
  assert.deepEqual(fs.readdirSync(dir), [], ".part 临时文件必须在 finally 中被清理");
});

test("损坏的加密字段报 BACKUP_INVALID 而非 BACKUP_WRONG_PASSWORD；超大备份文件在读取前拦截", () => {
  const valid = JSON.parse(backup.encodeBackup(backup.buildBackup({ stores: STORES, local: {}, appVersion: "1.6.64", now: NOW }), "pw123"));
  const badCases = [
    { ...valid, salt: "" },
    { ...valid, salt: "not-valid-base64!" },
    { ...valid, salt: Buffer.alloc(8).toString("base64") },
    { ...valid, iv: Buffer.alloc(4).toString("base64") },
    { ...valid, tag: Buffer.alloc(8).toString("base64") },
    { ...valid, data: "" },
    { ...valid, data: 12345 }
  ];
  for (const broken of badCases) {
    assert.throws(() => backup.decodeBackup(JSON.stringify(broken), "pw123"), { code: "BACKUP_INVALID" });
    assert.throws(() => backup.decodeBackup(JSON.stringify(broken)), { code: "BACKUP_INVALID" });
  }
  assert.throws(() => backup.decodeBackup(JSON.stringify(valid), "wrong"), { code: "BACKUP_WRONG_PASSWORD" });

  const dir = tempDir();
  const fileName = "A股雷达备份-20261112-160509.json";
  fs.writeFileSync(path.join(dir, fileName), "{}");
  let readCalled = false;
  const api = backup.createBackupService({
    readStore: () => null,
    writeStore: () => {},
    readConfig: () => ({ folder: dir }),
    writeConfig: () => {},
    encryptSecret: v => v,
    decryptSecret: v => v,
    appVersion: "1.6.64",
    fsApi: {
      ...fs,
      statSync: () => ({ size: 64 * 1024 * 1024 + 1 }),
      readFileSync: () => { readCalled = true; return "{}"; }
    }
  });
  assert.throws(() => api.inspect(fileName), { code: "BACKUP_TOO_LARGE" });
  assert.throws(() => api.restore(fileName), { code: "BACKUP_TOO_LARGE" });
  assert.equal(readCalled, false, "超过大小上限时不应该调用 readFileSync");
});

test("多文件恢复前全量预校验，写入中途失败时自动回滚已写过的 store", () => {
  const dir = tempDir();
  const source = service(STORES, { folder: dir });
  const { name } = source.api.run({});

  // 1) 预校验失败：在任何 store 写入之前拦截
  const initial = {
    settings: { provider: "eastmoney", theme: "light" },
    holdings: [{ code: "000001", shares: 200, costPrice: 12 }],
    "stock-agent": { conversations: [{ id: "old" }] }
  };
  const precheckData = structuredClone(initial);
  const writes = [];
  const precheckApi = backup.createBackupService({
    readStore: store => structuredClone(precheckData[store] ?? null),
    writeStore: (store, value) => { writes.push(store); precheckData[store] = value; },
    validateStore: store => store !== "stock-agent",
    readConfig: () => ({ folder: dir }),
    writeConfig: () => {},
    encryptSecret: v => v,
    decryptSecret: v => v,
    appVersion: "1.6.64"
  });
  assert.throws(() => precheckApi.restore(name), { code: "BACKUP_INVALID" });
  assert.deepEqual(writes, [], "预校验未通过前不能写入任何 store");
  assert.deepEqual(precheckData, initial);

  // 2) 写入中途失败：回滚已写过的 store 到恢复前状态（包括原本不存在的 store）
  const rollbackData = structuredClone(initial);
  const removed = [];
  const failWriteApi = backup.createBackupService({
    readStore: store => structuredClone(rollbackData[store] ?? null),
    writeStore: (store, value) => {
      if (store === "stock-agent") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      rollbackData[store] = value;
    },
    removeStore: store => { removed.push(store); delete rollbackData[store]; },
    validateStore: () => true,
    readConfig: () => ({ folder: dir }),
    writeConfig: () => {},
    encryptSecret: v => v,
    decryptSecret: v => v,
    appVersion: "1.6.64"
  });
  assert.throws(() => failWriteApi.restore(name), { code: "ENOSPC" });
  assert.deepEqual(rollbackData, initial, "已写过的 settings/holdings 必须回滚到恢复前状态");
  assert.deepEqual(removed, ["ai-profiles"], "原本不存在且已被写入的 store 在回滚时被移除");
});

test("备份恢复只给相同接口来源的 AI 配置沿用本机密钥", () => {
  const local = { activeId: "profile", profiles: [{ id: "profile", baseUrl: "https://current.example/v1", apiKey: "local-key" }] };
  const restored = { activeId: "profile", profiles: [{ id: "profile", baseUrl: "https://old.example/v1", apiKey: "from-backup" }] };
  assert.equal(backup.mergeForRestore("ai-profiles", restored, local).profiles[0].apiKey, undefined);
  restored.profiles[0].baseUrl = "https://current.example/v2";
  assert.equal(backup.mergeForRestore("ai-profiles", restored, local).profiles[0].apiKey, "local-key");
  const currentSettings = { aiBaseUrl: "https://current.example/v1", aiApiKey: "local-key", refreshToken: "local-token" };
  const changed = backup.mergeForRestore("settings", { aiBaseUrl: "https://old.example/v1", aiApiKey: "from-backup" }, currentSettings);
  assert.equal(changed.aiApiKey, undefined);
  assert.equal(changed.refreshToken, "local-token");
  assert.equal(backup.mergeForRestore("settings", { theme: "light" }, currentSettings).aiApiKey, "local-key");
});

test("备份恢复准备不写主进程数据；确认后才写入已验证的内容", () => {
  const dir = tempDir();
  const source = service(STORES, { folder: dir });
  const { name } = source.api.run({ "a-stock-radar:notes:v1": "from-backup" });
  const target = service({ settings: { theme: "light" } }, { folder: dir });
  const plan = target.api.prepareRestore(name);
  assert.deepEqual(target.data, { settings: { theme: "light" } });
  assert.deepEqual(plan.local, { "a-stock-radar:notes:v1": "from-backup" });
  fs.writeFileSync(path.join(dir, name), "备份文件此时已被替换");
  target.api.applyRestore(plan);
  assert.equal(target.data.settings.theme, "dark");
});

test("缺失或损坏的本地数据段不会被恢复为空快照", () => {
  const valid = backup.buildBackup({ stores: {}, local: {}, appVersion: "1.6.71" });
  assert.deepEqual(backup.decodeBackup(JSON.stringify(valid)).local, {});
  for (const local of [undefined, null, [], { "a-stock-radar:notes:v1": null }]) {
    assert.throws(() => backup.decodeBackup(JSON.stringify({ ...valid, local })), { code: "BACKUP_INVALID" });
  }
});

test("超过 200 字符的备份密码显式报错 BACKUP_PASSWORD_TOO_LONG 而不静默截断", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-pwlen-"));
  const { api } = service({}, { folder: dir });
  assert.throws(
    () => api.configure({ password: "p".repeat(201) }),
    { code: "BACKUP_PASSWORD_TOO_LONG" }
  );
  api.configure({ password: "p".repeat(200) });
});
