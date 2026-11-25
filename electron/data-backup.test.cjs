"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { after } = require("node:test");
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
const tempDirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astock-backup-"));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {}
  }
});
const STORES = {
  settings: { provider: "ths", theme: "dark", refreshToken: "safe:REFRESH", aiApiKey: "safe:AI" },
  holdings: [{ code: "600519", shares: 100, costPrice: 1500 }],
  "ai-profiles": { activeId: "p1", profiles: [{ id: "p1", name: "DeepSeek", baseUrl: "https://api.deepseek.example/v1", model: "deepseek-chat", apiKey: "safe:KEY" }] },
  "stock-agent": { conversations: [{ id: "c1" }] }
};

test("备份文件不含令牌和 API Key，含本地存储里本软件的数据，按北京时间命名", async () => {
  const dir = tempDir();
  const { api } = service(STORES, { folder: dir });
  const result = await api.run({ "a-stock-radar:notes:v1": "{\"notes\":[]}", "other-site": "x", "ai-picks-excluded": "[]" });
  assert.equal(result.name, "A股雷达备份-20261112-160509.json");
  const text = fs.readFileSync(path.join(dir, result.name), "utf8");
  assert.doesNotMatch(text, /REFRESH|safe:AI|safe:KEY/);
  const parsed = await backup.decodeBackup(text);
  assert.equal(parsed.stores.settings.theme, "dark");
  assert.equal(parsed.stores.holdings[0].code, "600519");
  assert.deepEqual(Object.keys(parsed.local).sort(), ["a-stock-radar:notes:v1", "ai-picks-excluded"]);
  assert.equal(api.status().files.length, 1);
});

test("设了密码就整份加密；密码不对或没给密码时拒绝，给对了能读", async () => {
  const dir = tempDir();
  const { api } = service(STORES, { folder: dir });
  api.configure({ password: "我的密码1234" });
  const { name } = await api.run({});
  const text = fs.readFileSync(path.join(dir, name), "utf8");
  assert.doesNotMatch(text, /600519|deepseek/);
  await assert.rejects(() => backup.decodeBackup(text), { code: "BACKUP_PASSWORD_REQUIRED" });
  await assert.rejects(() => backup.decodeBackup(text, "错的密码1234"), { code: "BACKUP_WRONG_PASSWORD" });
  assert.equal((await backup.decodeBackup(text, "我的密码1234")).stores.holdings[0].code, "600519");
  assert.equal((await api.inspect(name)).stores.includes("holdings"), true, "本机记着密码，预览不用再输");
});

test("新备份强制至少 8 位密码，但历史 6-7 位密码的旧备份仍可正常解密恢复", async () => {
  const dir = tempDir();
  const { api } = service(STORES, { folder: dir });
  assert.throws(
    () => api.configure({ password: "1234567" }),
    (err) => err.code === "BACKUP_PASSWORD_SHORT" && err.message === "备份加密密码至少需要 8 位字符"
  );
  const rawBackup = backup.buildBackup({ stores: STORES, local: { "a-stock-radar:notes:v1": "legacy" }, appVersion: "1.6.64", now: NOW });
  await assert.rejects(
    () => backup.encodeBackup(rawBackup, "123456"),
    (err) => err.code === "BACKUP_PASSWORD_SHORT" && err.message === "备份加密密码至少需要 8 位字符"
  );

  // 构造一份旧版 6 位密码加密的历史备份，确认 decodeBackup / decryptPayload 仍能解开
  const legacyPassword = "old6pw";
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(legacyPassword, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(rawBackup), "utf8"), cipher.final()]);
  const legacyEnvelope = JSON.stringify({
    format: "a-stock-radar-backup",
    version: 1,
    encrypted: true,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    createdAt: rawBackup.createdAt,
    appVersion: rawBackup.appVersion
  });
  const decoded = await backup.decodeBackup(legacyEnvelope, legacyPassword);
  assert.equal(decoded.stores.holdings[0].code, "600519");
  assert.equal(decoded.local["a-stock-radar:notes:v1"], "legacy");
});

test("恢复：写回数据但保留本机现有的密钥；返回本地存储键值", async () => {
  const dir = tempDir();
  const source = service(STORES, { folder: dir });
  const { name } = await source.api.run({ "a-stock-radar:notes:v1": "{\"notes\":[1]}" });
  const target = service({ settings: { provider: "eastmoney", refreshToken: "safe:NEW-MACHINE" }, "ai-profiles": { profiles: [{ id: "p1", baseUrl: "https://api.deepseek.example/v2", apiKey: "safe:LOCAL" }] } }, { folder: dir });
  const result = await target.api.restore(name);
  assert.deepEqual(result.local, { "a-stock-radar:notes:v1": "{\"notes\":[1]}" });
  assert.equal(target.data.settings.provider, "ths");
  assert.equal(target.data.settings.refreshToken, "safe:NEW-MACHINE", "本机令牌不被覆盖");
  assert.equal(target.data.settings.aiApiKey, undefined);
  assert.equal(target.data["ai-profiles"].profiles[0].apiKey, "safe:LOCAL");
  assert.equal(target.data.holdings[0].shares, 100);
});

test("只保留最近 N 份，只删本软件命名的备份；不认识的文件名拒绝恢复", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "我的其他文件.json"), "{}");
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dir, `A股雷达备份-2026110${i}-090000.json`), "{}");
  const { api } = service(STORES, { folder: dir, config: { keep: 3 } });
  await api.run({});
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.filter(name => backup.FILE_PATTERN.test(name)).length, 3);
  assert.ok(names.includes("我的其他文件.json"));
  await assert.rejects(() => api.restore("../settings.json"), { code: "BACKUP_INVALID" });
  await assert.rejects(() => backup.decodeBackup("{\"format\":\"x\"}"), { code: "BACKUP_INVALID" });
});

test("没选文件夹时不能备份，并记下失败原因", async () => {
  const { api, config } = service(STORES, { folder: "" });
  await assert.rejects(() => api.run({}), { code: "BACKUP_FOLDER" });
  assert.throws(() => api.configure({ folder: "relative/dir" }), { code: "BACKUP_FOLDER" });
  const dir = path.join(tempDir(), "不存在的子目录");
  api.configure({ folder: dir });
  await api.run({});
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

test("配置了备份密码但解密失败时立即报错，绝不降级写明文；rename 失败时清理 .part 临时文件", async () => {
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
  await assert.rejects(() => api.run({}), { code: "BACKUP_PASSWORD_UNREADABLE" });
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
  await assert.rejects(() => api2.run({}), { code: "EIO" });
  assert.equal(renameFailed, true);
  assert.deepEqual(fs.readdirSync(dir), [], ".part 临时文件必须在 finally 中被清理");
});

test("损坏的加密字段报 BACKUP_INVALID 而非 BACKUP_WRONG_PASSWORD；超大备份文件在读取前拦截", async () => {
  const valid = JSON.parse(await backup.encodeBackup(backup.buildBackup({ stores: STORES, local: {}, appVersion: "1.6.64", now: NOW }), "pw123456"));
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
    await assert.rejects(() => backup.decodeBackup(JSON.stringify(broken), "pw123456"), { code: "BACKUP_INVALID" });
    await assert.rejects(() => backup.decodeBackup(JSON.stringify(broken)), { code: "BACKUP_INVALID" });
  }
  await assert.rejects(() => backup.decodeBackup(JSON.stringify(valid), "wrongpass"), { code: "BACKUP_WRONG_PASSWORD" });

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
  await assert.rejects(() => api.inspect(fileName), { code: "BACKUP_TOO_LARGE" });
  await assert.rejects(() => api.restore(fileName), { code: "BACKUP_TOO_LARGE" });
  assert.equal(readCalled, false, "超过大小上限时不应该调用 readFileSync");
});

test("多文件恢复前全量预校验，写入中途失败时自动回滚已写过的 store", async () => {
  const dir = tempDir();
  const source = service(STORES, { folder: dir });
  const { name } = await source.api.run({});

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
  await assert.rejects(() => precheckApi.restore(name), { code: "BACKUP_INVALID" });
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
  await assert.rejects(() => failWriteApi.restore(name), { code: "ENOSPC" });
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

test("备份恢复准备不写主进程数据；确认后才写入已验证的内容", async () => {
  const dir = tempDir();
  const source = service(STORES, { folder: dir });
  const { name } = await source.api.run({ "a-stock-radar:notes:v1": "from-backup" });
  const target = service({ settings: { theme: "light" } }, { folder: dir });
  const plan = await target.api.prepareRestore(name);
  assert.deepEqual(target.data, { settings: { theme: "light" } });
  assert.deepEqual(plan.local, { "a-stock-radar:notes:v1": "from-backup" });
  fs.writeFileSync(path.join(dir, name), "备份文件此时已被替换");
  await target.api.applyRestore(plan);
  assert.equal(target.data.settings.theme, "dark");
});

test("缺失或损坏的本地数据段不会被恢复为空快照", async () => {
  const valid = backup.buildBackup({ stores: {}, local: {}, appVersion: "1.6.71" });
  assert.deepEqual((await backup.decodeBackup(JSON.stringify(valid))).local, {});
  for (const local of [undefined, null, [], { "a-stock-radar:notes:v1": null }]) {
    await assert.rejects(() => backup.decodeBackup(JSON.stringify({ ...valid, local })), { code: "BACKUP_INVALID" });
  }
});

test("超过 200 字符的备份密码显式报错 BACKUP_PASSWORD_TOO_LONG 而不静默截断", () => {
  const dir = tempDir();
  const { api } = service({}, { folder: dir });
  assert.throws(
    () => api.configure({ password: "p".repeat(201) }),
    { code: "BACKUP_PASSWORD_TOO_LONG" }
  );
  api.configure({ password: "p".repeat(200) });
});

function mirror(initial) {
  const values = new Map(Object.entries(initial));
  return { values, keys: () => [...values.keys()], get: key => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); return true; }, remove: key => values.delete(key) };
}

test("恢复后本机键值库与备份一致：备份里没有的随心记/复盘档案被清掉，不会在重启后复活", async () => {
  const dir = tempDir();
  const source = service(STORES, { folder: dir });
  const { name } = await source.api.run({ "a-stock-radar:review-archive:v2": "[{\"id\":\"r-new\"}]", "a-stock-radar:default-view": "\"cockpit\"" });
  const kv = mirror({ "a-stock-radar:notes:v1": "{\"notes\":[{\"id\":\"old\"}]}", "a-stock-radar:review-archive:v2": "[{\"id\":\"r-old\"}]", "unrelated:key": "keep" });
  let data = structuredClone(STORES);
  const api = backup.createBackupService({
    readStore: store => structuredClone(data[store] ?? null), writeStore: (store, value) => { data[store] = value; },
    readConfig: () => ({ folder: dir }), writeConfig: () => {}, encryptSecret: v => v, decryptSecret: v => v,
    appVersion: "1.6.71", now: () => NOW, localMirror: kv
  });
  await api.restore(name);
  assert.equal(kv.values.has("a-stock-radar:notes:v1"), false);
  assert.equal(kv.values.get("a-stock-radar:review-archive:v2"), "[{\"id\":\"r-new\"}]");
  assert.equal(kv.values.get("unrelated:key"), "keep");
});

test("键值库同步失败时整次恢复回滚，已写的数据和键值都恢复原样", async () => {
  const dir = tempDir();
  const source = service(STORES, { folder: dir });
  const { name } = await source.api.run({ "a-stock-radar:notes:v1": "{\"notes\":[{\"id\":\"new\"}]}" });
  const kv = mirror({ "a-stock-radar:notes:v1": "{\"notes\":[{\"id\":\"old\"}]}", "a-stock-radar:review-archive:v2": "[1]" });
  const realRemove = kv.remove;
  kv.remove = () => { throw new Error("disk full"); };
  const data = { holdings: [{ code: "000001", shares: 200, costPrice: 10 }] };
  const api = backup.createBackupService({
    readStore: store => structuredClone(data[store] ?? null), writeStore: (store, value) => { data[store] = value; }, removeStore: store => { delete data[store]; },
    readConfig: () => ({ folder: dir }), writeConfig: () => {}, encryptSecret: v => v, decryptSecret: v => v,
    appVersion: "1.6.71", now: () => NOW, localMirror: kv
  });
  await assert.rejects(api.restore(name), /disk full/);
  kv.remove = realRemove;
  assert.equal(data.holdings[0].code, "000001");
  assert.equal(kv.values.get("a-stock-radar:notes:v1"), "{\"notes\":[{\"id\":\"old\"}]}");
  assert.equal(kv.values.get("a-stock-radar:review-archive:v2"), "[1]");
});

test("前后端对“本软件的本地存储键”判断一致（含显示密度）", () => {
  for (const key of ["a-stock-radar:notes:v1", "ai-picks-excluded", "astock:display-density:v1"]) assert.equal(backup.isAppLocalKey(key), true, key);
  const client = fs.readFileSync(path.join(__dirname, "..", "src", "features", "backup", "backupClient.ts"), "utf8");
  for (const literal of client.match(/key === "([^"]+)"/g) || []) assert.equal(backup.isAppLocalKey(literal.slice(9, -1)), true, literal);
});

test("备份时合并 SQLite localMirror 中缺失于 localStorage 的应用键，且渲染进程新值优先", async () => {
  const dir = tempDir();
  const kv = mirror({
    "a-stock-radar:notes:v1": "{\"notes\":[{\"id\":\"sqlite-only\"}]}",
    "a-stock-radar:review-archive:v2": "[{\"id\":\"from-sqlite\"}]",
    "unrelated:key": "should-not-backup"
  });
  let saved = { folder: dir, auto: true, keep: 30, lastBackupAt: "", lastError: "", password: "" };
  const api = backup.createBackupService({
    readStore: name => structuredClone(STORES[name] ?? null),
    writeStore: () => {},
    readConfig: () => saved,
    writeConfig: value => { saved = value; },
    encryptSecret: value => `enc:${value}`,
    decryptSecret: value => value.replace(/^enc:/, ""),
    appVersion: "1.6.71",
    localMirror: kv,
    now: () => NOW
  });
  const { name } = await api.run({
    "a-stock-radar:review-archive:v2": "[{\"id\":\"fresh-from-renderer\"}]",
    "astock:display-density:v1": "compact"
  });
  const decoded = await backup.decodeBackup(fs.readFileSync(path.join(dir, name), "utf8"));
  assert.equal(decoded.local["a-stock-radar:notes:v1"], "{\"notes\":[{\"id\":\"sqlite-only\"}]}");
  assert.equal(decoded.local["a-stock-radar:review-archive:v2"], "[{\"id\":\"fresh-from-renderer\"}]");
  assert.equal(decoded.local["astock:display-density:v1"], "compact");
  assert.equal(decoded.local["unrelated:key"], undefined);
});

test("恢复时 syncLocalMirror 按并集写入备份新增键，失败时回滚删除新增键并跳过非法键名", async () => {
  const dir = tempDir();
  const source = service(STORES, { folder: dir });
  const { name } = await source.api.run({
    "a-stock-radar:notes:v1": "{\"notes\":[{\"id\":\"added-from-backup\"}]}",
    "a-stock-radar:review-archive:v2": "[{\"id\":\"updated\"}]",
    "a-stock-radar:bad key with spaces": "ignored"
  });

  // 1) 成功恢复：备份新增键被写入 SQLite mirror，非法键名被安全忽略
  const kv = mirror({ "a-stock-radar:review-archive:v2": "[{\"id\":\"old\"}]", "a-stock-radar:obsolete": "drop" });
  const data = structuredClone(STORES);
  const api = backup.createBackupService({
    readStore: store => structuredClone(data[store] ?? null),
    writeStore: (store, value) => { data[store] = value; },
    readConfig: () => ({ folder: dir }),
    writeConfig: () => {},
    encryptSecret: v => v,
    decryptSecret: v => v,
    appVersion: "1.6.71",
    now: () => NOW,
    localMirror: kv
  });
  await api.restore(name);
  assert.equal(kv.values.get("a-stock-radar:notes:v1"), "{\"notes\":[{\"id\":\"added-from-backup\"}]}");
  assert.equal(kv.values.get("a-stock-radar:review-archive:v2"), "[{\"id\":\"updated\"}]");
  assert.equal(kv.values.has("a-stock-radar:obsolete"), false);
  assert.equal(kv.values.has("a-stock-radar:bad key with spaces"), false);

  // 2) 中途写入失败时：新建的键通过 remove 回滚，既有键恢复旧值
  const kv2 = mirror({ "a-stock-radar:review-archive:v2": "[{\"id\":\"old\"}]" });
  const origSet = kv2.set;
  let sets = 0;
  kv2.set = (key, value) => {
    sets += 1;
    if (sets === 2) throw new Error("sqlite busy");
    return origSet(key, value);
  };
  const data2 = structuredClone(STORES);
  const api2 = backup.createBackupService({
    readStore: store => structuredClone(data2[store] ?? null),
    writeStore: (store, value) => { data2[store] = value; },
    readConfig: () => ({ folder: dir }),
    writeConfig: () => {},
    encryptSecret: v => v,
    decryptSecret: v => v,
    appVersion: "1.6.71",
    now: () => NOW,
    localMirror: kv2
  });
  await assert.rejects(() => api2.restore(name), /sqlite busy/);
  kv2.set = origSet;
  assert.equal(kv2.values.has("a-stock-radar:notes:v1"), false, "新增键在回滚时必须被移除");
  assert.equal(kv2.values.get("a-stock-radar:review-archive:v2"), "[{\"id\":\"old\"}]");
});

test("主密码锁定时加密备份的 run/inspect/prepareRestore 抛出 SECRET_STORAGE_LOCKED 且不覆盖 lastError", async () => {
  const dir = tempDir();
  let locked = false;
  let saved = { folder: dir, auto: true, keep: 30, lastBackupAt: "", lastError: "保留原有状态", password: "" };
  const api = backup.createBackupService({
    readStore: name => structuredClone(STORES[name] ?? null),
    writeStore: () => {},
    readConfig: () => saved,
    writeConfig: value => { saved = value; },
    encryptSecret: value => `enc:${value}`,
    decryptSecret: value => (locked ? "" : value.replace(/^enc:/, "")),
    isSecretLocked: () => locked,
    appVersion: "1.6.71",
    now: () => NOW
  });
  api.configure({ password: "BackupPass#2026" });
  const { name } = await api.run({});
  saved = { ...saved, lastError: "kept-prev-error" };

  locked = true;
  await assert.rejects(
    () => api.run({}),
    (err) => err?.code === "SECRET_STORAGE_LOCKED" && err?.message === "密钥库已锁定，请先输入主密码解锁"
  );
  assert.equal(saved.lastError, "kept-prev-error", "锁定时不得覆写 lastError 为误导性的重设密码错误");

  await assert.rejects(
    () => api.inspect(name),
    (err) => err?.code === "SECRET_STORAGE_LOCKED" && err?.message === "密钥库已锁定，请先输入主密码解锁"
  );
  await assert.rejects(
    () => api.prepareRestore(name),
    (err) => err?.code === "SECRET_STORAGE_LOCKED" && err?.message === "密钥库已锁定，请先输入主密码解锁"
  );

  // 显式传入密码时即使密钥库锁定也可预览/准备恢复
  assert.equal((await api.inspect(name, "BackupPass#2026")).stores.includes("holdings"), true);
  assert.equal((await api.prepareRestore(name, "BackupPass#2026")).stores.holdings[0].code, "600519");

  // H-1: 密钥库锁定时禁止用空字符串清空已有备份密码
  assert.throws(
    () => api.configure({ password: "" }),
    (err) => err?.code === "SECRET_STORAGE_LOCKED"
  );
  assert.ok(saved.password, "existing encrypted backup password must be preserved when locked");

  // 解锁后允许清空备份密码
  locked = false;
  api.configure({ password: "" });
  assert.equal(saved.password, "");
});

test("H-2 & L-4: syncLocalMirror uses transactional replaceKeys when available and inspect/prepareRestore guard empty folder", async () => {
  const { createLocalKvStore } = require("./local-kv-sqlite.cjs");
  const dir = tempDir();
  const emptyFolderService = service(STORES, { folder: "" });
  await assert.rejects(
    () => emptyFolderService.api.inspect("A股雷达备份-20261112-160509.json"),
    { code: "BACKUP_FOLDER" }
  );
  await assert.rejects(
    () => emptyFolderService.api.prepareRestore("A股雷达备份-20261112-160509.json"),
    { code: "BACKUP_FOLDER" }
  );

  const source = service(STORES, { folder: dir });
  const { name } = await source.api.run({ "a-stock-radar:notes:v1": "{\"notes\":[\"tx\"]}" });
  const kvStore = createLocalKvStore({ userDataDir: tempDir() });
  let replaceKeysCalls = 0;
  const wrappedMirror = {
    keys: () => kvStore.keys(),
    get: k => kvStore.get(k),
    set: (k, v) => kvStore.set(k, v),
    remove: k => kvStore.remove(k),
    replaceKeys: (entries, removeKeys) => {
      replaceKeysCalls += 1;
      return kvStore.replaceKeys(entries, removeKeys);
    }
  };
  try {
    kvStore.set("a-stock-radar:obsolete", "old");
    kvStore.set("other:keep", "keep");
    const data = structuredClone(STORES);
    const api = backup.createBackupService({
      readStore: store => structuredClone(data[store] ?? null),
      writeStore: (store, value) => { data[store] = value; },
      readConfig: () => ({ folder: dir }),
      writeConfig: () => {},
      encryptSecret: v => v,
      decryptSecret: v => v,
      appVersion: "1.6.71",
      now: () => NOW,
      localMirror: wrappedMirror
    });
    await api.restore(name);
    assert.equal(replaceKeysCalls, 1);
    assert.equal(kvStore.get("a-stock-radar:notes:v1"), "{\"notes\":[\"tx\"]}");
    assert.equal(kvStore.get("a-stock-radar:obsolete"), null);
    assert.equal(kvStore.get("other:keep"), "keep");
  } finally {
    kvStore.close();
  }
});
