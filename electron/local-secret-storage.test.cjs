"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalSecretStorage } = require("./local-secret-storage.cjs");
const { encryptSecretForStorage, decryptStoredSecret, migrateLegacyStoredSecrets } = require("./security-policy.cjs");

const tempKey = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "astock-secret-")), "local-secret.key");

test("secrets round-trip through the local key without the OS keychain, and the settings file never holds plaintext", () => {
  const keyPath = tempKey();
  const storage = createLocalSecretStorage({ keyPath });
  const stored = encryptSecretForStorage("sk-fuyao-example_key_0000000000", storage);
  assert.match(stored, /^safe:/);
  assert.ok(!stored.includes("sk-fuyao"));
  assert.equal(decryptStoredSecret(stored, storage), "sk-fuyao-example_key_0000000000");
  assert.equal(fs.statSync(keyPath).size, 32);
  if (process.platform !== "win32") assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  // A new process reads the same key file.
  assert.equal(decryptStoredSecret(stored, createLocalSecretStorage({ keyPath })), "sk-fuyao-example_key_0000000000");
});

test("old keychain ciphertext, tampering or a lost key read as 'not configured' instead of prompting or crashing", () => {
  const keyPath = tempKey();
  const storage = createLocalSecretStorage({ keyPath });
  assert.equal(decryptStoredSecret(`safe:${Buffer.from("v10-keychain-bytes").toString("base64")}`, storage), "");
  const stored = encryptSecretForStorage("secret", storage);
  const bytes = Buffer.from(stored.slice(5), "base64"); bytes[bytes.length - 1] ^= 1;
  assert.equal(decryptStoredSecret(`safe:${bytes.toString("base64")}`, storage), "");
  assert.equal(decryptStoredSecret(stored, createLocalSecretStorage({ keyPath: tempKey() })), "", "another machine's key cannot decrypt");
});

test("legacy plaintext settings migrate into the local store", () => {
  const storage = createLocalSecretStorage({ keyPath: tempKey() });
  const result = migrateLegacyStoredSecrets({ refreshToken: "legacy-refresh" }, ["refreshToken"], storage);
  assert.equal(decryptStoredSecret(result.settings.refreshToken, storage), "legacy-refresh");
});

test('new writes use secure OS storage, old AS1 remains readable and can be rewrapped after unlocking', () => {
  const { createProtectedSecretStorage } = require('./local-secret-storage.cjs');
  const legacy = createLocalSecretStorage({keyPath:tempKey()});
  const original = encryptSecretForStorage('synthetic-old', legacy);
  let unlocked = false;
  const system = { isEncryptionAvailable: () => unlocked, getSelectedStorageBackend: () => 'keychain',
    encryptString: v => Buffer.from('OS:' + v), decryptString: b => b.toString().slice(3) };
  const storage = createProtectedSecretStorage(system, legacy);
  assert.equal(decryptStoredSecret(original, storage), 'synthetic-old');
  assert.throws(() => encryptSecretForStorage('new', storage), {code:'SAFE_STORAGE_UNAVAILABLE'});
  assert.equal(migrateLegacyStoredSecrets({key:original}, ['key'], storage).settings.key, original);
  unlocked = true;
  const migrated = migrateLegacyStoredSecrets({key:original}, ['key'], storage);
  assert.equal(Buffer.from(migrated.settings.key.slice(5), 'base64').toString(), 'OS:synthetic-old');
  assert.equal(decryptStoredSecret(migrated.settings.key, storage), 'synthetic-old');
  system.getSelectedStorageBackend = () => 'basic_text';
  assert.throws(() => encryptSecretForStorage('new', storage), {code:'SAFE_STORAGE_UNAVAILABLE'});
});

test('AI profile migration never reports an uncommitted write and retries after storage recovers', () => {
  const { createAiProfileStore } = require('./ai-profile-store.cjs');
  let stored = null, reads = 0, failRead = true, failWrite = true;
  const store = createAiProfileStore({
    read() { reads++; if (failRead) throw Error('read failure'); return stored; },
    write(next) { if (failWrite) throw Error('write failure'); stored = next; },
    encrypt: () => 'safe:c3ludGhldGlj', decrypt: () => 'synthetic',
    legacy: () => ({baseUrl:'https://synthetic.test',model:'test',apiKey:'synthetic'})
  });
  assert.throws(() => store.list(), /read failure/); assert.equal(stored,null);
  failRead = false;
  assert.throws(() => store.list(), /write failure/); assert.equal(stored,null);
  failWrite = false;
  assert.equal(store.list().profiles.length,1);
  assert.equal(stored.profiles.length,1); assert.equal(reads,3);
});

test("1.6.49 local-first storage writes AS1, reads keychain ciphertext only to move it back, and never needs the keychain afterwards", () => {
  const { createLocalFirstSecretStorage, hasSystemCiphertext } = require("./local-secret-storage.cjs");
  const { encryptSecretForStorage, decryptStoredSecret, migrateLegacyStoredSecrets } = require("./security-policy.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-first-"));
  try {
    const local = createLocalSecretStorage({ keyPath: path.join(dir, "local-secret.key") });
    let systemCalls = 0;
    const keychain = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "keychain",
      encryptString: value => Buffer.from(`v10${value}`), decryptString: bytes => { systemCalls++; return Buffer.from(bytes).toString().slice(3); } };
    const migrating = createLocalFirstSecretStorage(local, keychain);
    const fromKeychain = `safe:${Buffer.from("v10FUYAO-KEY").toString("base64")}`;
    assert.equal(hasSystemCiphertext({ fuyaoApiKey: fromKeychain }), true);
    const moved = migrateLegacyStoredSecrets({ fuyaoApiKey: fromKeychain, aiApiKey: "" }, ["fuyaoApiKey", "aiApiKey"], migrating);
    assert.deepEqual(moved.migratedKeys, ["fuyaoApiKey"]);
    assert.equal(hasSystemCiphertext(moved.settings), false, "the moved secret is stored as local AS1");
    assert.equal(systemCalls, 1);
    const later = createLocalFirstSecretStorage(local, null);
    assert.equal(decryptStoredSecret(moved.settings.fuyaoApiKey, later), "FUYAO-KEY", "later launches read it without the keychain");
    const fresh = encryptSecretForStorage("NEW", later);
    assert.equal(hasSystemCiphertext({ k: fresh }), false, "new secrets are never written to the keychain");
    assert.equal(decryptStoredSecret(fromKeychain, later), "", "without the keychain an unmigrated value reads as empty rather than throwing");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('损坏的本机密钥文件改名留存后再生成新密钥', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { createLocalSecretStorage } = require('./local-secret-storage.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-'));
  const keyPath = path.join(dir, 'local-secret.key');
  fs.writeFileSync(keyPath, 'short');
  const storage = createLocalSecretStorage({ keyPath });
  assert.equal(storage.decryptString(storage.encryptString('hi')), 'hi');
  const names = fs.readdirSync(dir);
  assert.equal(fs.readFileSync(keyPath).length, 32);
  assert.ok(names.some(name => name.startsWith('local-secret.key.corrupt-')));
  assert.ok(!names.some(name => name.includes('.tmp.')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("主密码 AS2 信封：设置、重启锁定、错误密码拒绝、解锁后可读旧密文、改密与清除回退 32 字节裸密钥", async (t) => {
  const { createLocalFirstSecretStorage } = require("./local-secret-storage.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astock-master-pw-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyPath = path.join(dir, "local-secret.key");

  // 1) 未启用主密码：向后兼容 32 字节裸密钥
  const first = createLocalSecretStorage({ keyPath });
  assert.equal(first.isMasterPasswordEnabled(), false);
  assert.equal(first.isLocked(), false);
  assert.deepEqual(first.status(), { enabled: false, locked: false });
  const cipherBefore = first.encryptString("sk-secret-before-master-pw");
  assert.equal(fs.statSync(keyPath).size, 32);

  // 2) 短密码被拒；设置主密码后写出 80 字节 AS2 信封，且当前进程保持已解锁
  await assert.rejects(() => first.setMasterPassword("short77"), { code: "MASTER_PASSWORD_SHORT" });
  const enabledStatus = await first.setMasterPassword("MasterPass#2026");
  assert.deepEqual(enabledStatus, { enabled: true, locked: false });
  assert.equal(first.isMasterPasswordEnabled(), true);
  assert.equal(first.isLocked(), false);
  const rawEnvelope = fs.readFileSync(keyPath);
  assert.equal(rawEnvelope.length, 80);
  assert.equal(rawEnvelope.subarray(0, 3).toString("utf8"), "AS2");
  assert.equal(rawEnvelope[3], 0x01);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  }
  assert.equal(first.decryptString(cipherBefore), "sk-secret-before-master-pw");

  // 3) 重启后新实例默认锁定，读写抛 SECRET_STORAGE_LOCKED
  const second = createLocalSecretStorage({ keyPath });
  const wrappedSecond = createLocalFirstSecretStorage(second, null);
  assert.equal(wrappedSecond.isMasterPasswordEnabled(), true);
  assert.equal(wrappedSecond.isLocked(), true);
  assert.deepEqual(wrappedSecond.status(), { enabled: true, locked: true });
  assert.equal(wrappedSecond.isEncryptionAvailable(), false);
  assert.throws(() => wrappedSecond.encryptString("blocked"), (err) => err.code === "SECRET_STORAGE_LOCKED" && err.message === "密钥库已锁定，请先输入主密码解锁");
  assert.throws(() => wrappedSecond.decryptString(cipherBefore), (err) => err.code === "SECRET_STORAGE_LOCKED" && err.message === "密钥库已锁定，请先输入主密码解锁");

  // 4) 错误主密码拒绝且仍保持锁定
  await assert.rejects(() => wrappedSecond.unlockMasterPassword("WrongPassword!"), (err) => err.message === "主密码错误，请重试");
  assert.equal(wrappedSecond.isLocked(), true);

  // 5) 正确主密码解锁，原有 AS1 密文可正常解密
  const unlockedStatus = await wrappedSecond.unlockMasterPassword("MasterPass#2026");
  assert.deepEqual(unlockedStatus, { enabled: true, locked: false });
  assert.equal(wrappedSecond.decryptString(cipherBefore), "sk-secret-before-master-pw");
  const cipherAfter = wrappedSecond.encryptString("sk-secret-after-unlock");
  assert.equal(wrappedSecond.decryptString(cipherAfter), "sk-secret-after-unlock");

  // 6) 修改主密码需校验旧密码
  await assert.rejects(() => wrappedSecond.setMasterPassword("NewMaster#2026", "BadCurrentPw"), (err) => err.message === "主密码错误，请重试");
  await wrappedSecond.setMasterPassword("NewMaster#2026", "MasterPass#2026");
  const third = createLocalSecretStorage({ keyPath });
  await assert.rejects(() => third.unlockMasterPassword("MasterPass#2026"), (err) => err.message === "主密码错误，请重试");
  await third.unlockMasterPassword("NewMaster#2026");
  assert.equal(third.decryptString(cipherAfter), "sk-secret-after-unlock");

  // 7) 清除主密码：校验当前主密码后写回 32 字节裸密钥
  await assert.rejects(() => third.clearMasterPassword("WrongPw123"), (err) => err.message === "主密码错误，请重试");
  const clearedStatus = await third.clearMasterPassword("NewMaster#2026");
  assert.deepEqual(clearedStatus, { enabled: false, locked: false });
  assert.equal(fs.statSync(keyPath).size, 32);
  const fourth = createLocalSecretStorage({ keyPath });
  assert.equal(fourth.isMasterPasswordEnabled(), false);
  assert.equal(fourth.isLocked(), false);
  assert.equal(fourth.decryptString(cipherBefore), "sk-secret-before-master-pw");
  assert.equal(fourth.decryptString(cipherAfter), "sk-secret-after-unlock");
});
