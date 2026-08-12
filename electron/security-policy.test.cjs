const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  SECRET_STORAGE_UNAVAILABLE,
  createTrustedIpcHandler,
  decryptStoredSecret,
  encryptSecretForStorage,
  isAllowedRendererNavigation,
  isTrustedMainFrameIpcEvent,
  migrateLegacyStoredSecrets,
  normalizeExternalHttpsUrl,
  pickBacktestSettingOverrides,
  redactRuntimeText,
  resolveStoredSecret,
  resolveTestSecret
} = require("./security-policy.cjs");

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, "")
  };
}

test("external links accept only credential-free HTTPS URLs", () => {
  assert.equal(
    normalizeExternalHttpsUrl(" https://example.com/report?q=1 "),
    "https://example.com/report?q=1"
  );
  assert.equal(normalizeExternalHttpsUrl("http://example.com"), null);
  assert.equal(normalizeExternalHttpsUrl("javascript:alert(1)"), null);
  assert.equal(normalizeExternalHttpsUrl("https://user:pass@example.com"), null);
  assert.equal(normalizeExternalHttpsUrl("not a url"), null);
});

test("renderer navigation stays on the configured application entry", () => {
  assert.equal(
    isAllowedRendererNavigation(
      "http://127.0.0.1:5173/strategy#latest",
      "http://127.0.0.1:5173"
    ),
    true
  );
  assert.equal(
    isAllowedRendererNavigation(
      "http://127.0.0.1:5174/strategy",
      "http://127.0.0.1:5173"
    ),
    false
  );
  assert.equal(
    isAllowedRendererNavigation(
      "file:///D:/app/dist/index.html#settings",
      "file:///D:/app/dist/index.html"
    ),
    true
  );
  assert.equal(
    isAllowedRendererNavigation(
      "file:///D:/other/index.html",
      "file:///D:/app/dist/index.html"
    ),
    false
  );
});

test("saving settings preserves masked secrets and permits an explicit clear", () => {
  const encrypt = (value) => (value ? `encrypted:${value}` : "");
  assert.equal(resolveStoredSecret("••••••", "encrypted:old", encrypt), "encrypted:old");
  assert.equal(resolveStoredSecret(undefined, "encrypted:old", encrypt), "encrypted:old");
  assert.equal(resolveStoredSecret("", "encrypted:old", encrypt), "");
  assert.equal(resolveStoredSecret("  new-token  ", "encrypted:old", encrypt), "encrypted:new-token");
});

test("provider tests use edited plaintext while masked fields reuse saved secrets", () => {
  assert.equal(resolveTestSecret("••••••", "saved-token"), "saved-token");
  assert.equal(resolveTestSecret(undefined, "saved-token"), "saved-token");
  assert.equal(resolveTestSecret("", "saved-token"), "");
  assert.equal(resolveTestSecret("  next-token  ", "saved-token"), "next-token");
});

test("new secrets are never downgraded to plaintext when safeStorage is unavailable", () => {
  let encryptCalls = 0;
  const unavailable = {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      encryptCalls += 1;
      return Buffer.from("must-not-run");
    }
  };

  assert.throws(
    () => encryptSecretForStorage("new-secret", unavailable),
    (error) => error?.code === SECRET_STORAGE_UNAVAILABLE
  );
  assert.equal(encryptCalls, 0);
  assert.equal(encryptSecretForStorage("", unavailable), "");
});

test("legacy plaintext secrets migrate atomically to safe values", () => {
  const storage = fakeSafeStorage();
  const input = {
    provider: "ths",
    refreshToken: "plain:legacy-refresh",
    tushareToken: "legacy-tushare"
  };
  const result = migrateLegacyStoredSecrets(
    input,
    ["refreshToken", "tushareToken"],
    storage
  );

  assert.equal(result.migrated, true);
  assert.deepEqual(result.migratedKeys, ["refreshToken", "tushareToken"]);
  assert.match(result.settings.refreshToken, /^safe:/);
  assert.match(result.settings.tushareToken, /^safe:/);
  assert.equal(decryptStoredSecret(result.settings.refreshToken, storage), "legacy-refresh");
  assert.equal(decryptStoredSecret(result.settings.tushareToken, storage), "legacy-tushare");
  assert.equal(input.refreshToken, "plain:legacy-refresh");
  assert.deepEqual(result.discardedKeys, []);
  assert.equal(decryptStoredSecret("plain:legacy-refresh", storage), "");
  assert.equal(decryptStoredSecret("legacy-raw", storage), "");
});

test("legacy plaintext is discarded when safeStorage is unavailable", () => {
  const input = { refreshToken: "plain:legacy-refresh" };
  const result = migrateLegacyStoredSecrets(input, ["refreshToken"], fakeSafeStorage(false));
  assert.equal(result.migrated, true);
  assert.equal(result.settings.refreshToken, "");
  assert.notEqual(result.settings, input);
  assert.deepEqual(result.discardedKeys, ["refreshToken"]);
  assert.equal(input.refreshToken, "plain:legacy-refresh");
  assert.equal(decryptStoredSecret("plain:legacy-refresh", fakeSafeStorage(false)), "");
  assert.equal(decryptStoredSecret("safe:not-readable", fakeSafeStorage(false)), "");
});

test("legacy plaintext is discarded when an advertised safeStorage backend fails", () => {
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: () => {
      throw new Error("keyring failure");
    }
  };
  const result = migrateLegacyStoredSecrets(
    { tushareToken: "legacy-token" },
    ["tushareToken"],
    storage
  );
  assert.equal(result.settings.tushareToken, "");
  assert.deepEqual(result.discardedKeys, ["tushareToken"]);
});

test("migration clears empty legacy markers and never partially mutates its input", () => {
  const storage = fakeSafeStorage();
  const input = { refreshToken: "plain:", tushareToken: "safe:YWxyZWFkeQ==" };
  const result = migrateLegacyStoredSecrets(
    input,
    ["refreshToken", "tushareToken"],
    storage
  );
  assert.equal(result.settings.refreshToken, "");
  assert.equal(result.settings.tushareToken, input.tushareToken);
  assert.equal(input.refreshToken, "plain:");
  assert.deepEqual(result.discardedKeys, []);
});

test("backtest renderer overrides include only explicit non-sensitive fields", () => {
  const picked = pickBacktestSettingOverrides({
    provider: "evil-provider",
    refreshToken: "stolen-refresh",
    tushareToken: "stolen-tushare",
    fallbackEnabled: false,
    selectedStrategies: ["trend"],
    commissionBps: 9,
    maxHoldingBars: 20,
    unknown: true
  });

  assert.deepEqual(picked, {
    selectedStrategies: ["trend"],
    commissionBps: 9,
    maxHoldingBars: 20
  });
  assert.equal(Object.hasOwn(picked, "provider"), false);
  assert.equal(Object.hasOwn(picked, "refreshToken"), false);
  assert.equal(Object.hasOwn(picked, "tushareToken"), false);
});

test("trusted IPC accepts only the current main window mainFrame", () => {
  const mainFrame = { id: "main-frame" };
  const trustedWebContents = {
    mainFrame,
    isDestroyed: () => false
  };
  const validEvent = { sender: trustedWebContents, senderFrame: mainFrame };
  assert.equal(isTrustedMainFrameIpcEvent(validEvent, trustedWebContents), true);
  assert.equal(
    isTrustedMainFrameIpcEvent(
      { sender: trustedWebContents, senderFrame: { id: "child-frame" } },
      trustedWebContents
    ),
    false
  );
  assert.equal(
    isTrustedMainFrameIpcEvent(
      { sender: { mainFrame }, senderFrame: mainFrame },
      trustedWebContents
    ),
    false
  );

  const handler = createTrustedIpcHandler(
    (_, value) => `accepted:${value}`,
    () => trustedWebContents
  );
  assert.equal(handler(validEvent, "payload"), "accepted:payload");
  assert.throws(
    () => handler({ sender: trustedWebContents, senderFrame: {} }, "payload"),
    (error) => error?.code === "UNTRUSTED_IPC_SOURCE"
  );
  trustedWebContents.isDestroyed = () => true;
  assert.throws(
    () => handler(validEvent, "payload"),
    (error) => error?.code === "UNTRUSTED_IPC_SOURCE"
  );
});

test("runtime and debug text redaction covers URLs, headers, JSON and legacy secret formats", () => {
  const redacted = redactRuntimeText(
    "https://user:pass@example.com/api?token=query-secret&api_key=query-key\n" +
    "Authorization: Bearer header-secret\n" +
    '{"refreshToken":"json-refresh","tushareToken":"json-tushare","password":"pw"}\n' +
    "stored=plain:legacy-secret encrypted=safe:YWJjZA=="
  );

  for (const secret of [
    "user:pass",
    "query-secret",
    "query-key",
    "header-secret",
    "json-refresh",
    "json-tushare",
    "legacy-secret",
    "YWJjZA=="
  ]) {
    assert.equal(redacted.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /\[REDACTED_SECRET\]/);
});

test("every preload IPC channel is registered through the trusted wrapper", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const invokedChannels = [...new Set(
    [...preloadSource.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)]
      .map((match) => match[1])
  )].sort();
  const trustedChannels = [...mainSource.matchAll(/handleTrustedIpc\("([^"]+)"/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(trustedChannels, invokedChannels);
  assert.equal((mainSource.match(/ipcMain\.handle\(/g) || []).length, 1);
  assert.match(mainSource, /createTrustedIpcHandler\(handler, trustedMainWebContents\)/);
});

test("both renderer limit-up APIs expose the same serializable snapshot contract", () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const serviceSource = fs.readFileSync(path.join(__dirname, "services.cjs"), "utf8");
  assert.match(preloadSource, /discoverLimitUps: getLimitUpPoolSnapshot/);
  assert.match(preloadSource, /getLimitUpPoolSnapshot,\s*\n/);
  assert.doesNotMatch(preloadSource, /Array\.isArray\(result\)/);
  assert.doesNotMatch(serviceSource, /Object\.defineProperty\(rows, "pool(?:Meta|Providers)"/);
  assert.match(serviceSource, /return \{\s*rows,\s*meta:/);
});

test("main process wires secret storage, backtest filtering and debug logging through policy helpers", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(mainSource, /return encryptSecretForStorage\(value, safeStorage\);/);
  assert.match(mainSource, /migrateLegacyStoredSecrets\(stored, SECRET_SETTING_KEYS, safeStorage\)/);
  assert.doesNotMatch(mainSource, /return\s+`plain:/);
  assert.match(mainSource, /const safeMessage = redactRuntimeText\(message\)/);

  const backtestHandler = mainSource.match(
    /handleTrustedIpc\("backtest:run",([\s\S]*?)\n  \}\);/
  );
  assert.ok(backtestHandler);
  assert.match(backtestHandler[1], /pickBacktestSettingOverrides\(safeOptions\.settings\)/);
  assert.match(backtestHandler[1], /safeOptions\.settings = pickBacktestSettingOverrides\(mergedSettings\)/);
  assert.doesNotMatch(backtestHandler[1], /\.\.\.\(options\?\.settings/);
});

test("desktop lifecycle uses the Windows tray, macOS Dock, and Linux normal quit", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(mainSource, /new Tray\(applicationIconPath\(true\)\)/);
  assert.match(mainSource, /label: "显示 A股雷达"/);
  assert.match(mainSource, /label: "退出"/);
  assert.match(mainSource, /label: "退出",\s*click: requestExplicitQuit/);
  assert.match(mainSource, /createdTray\.on\("click", \(\) => showOrCreateMainWindow\(\)\)/);
  assert.match(
    mainSource,
    /function requestExplicitQuit\(\)[\s\S]*?isQuitting = true;[\s\S]*?app\.quit\(\);/
  );
  assert.match(
    mainSource,
    /createdWindow\.on\("close",[\s\S]*?process\.platform !== "win32"[\s\S]*?event\.preventDefault\(\);[\s\S]*?createdWindow\.hide\(\)/
  );
  const allClosedHandler = mainSource.match(
    /app\.on\("window-all-closed", \(\) => \{([\s\S]*?)\n\}\);/
  );
  assert.ok(allClosedHandler);
  assert.match(allClosedHandler[1], /process\.platform === "darwin"[\s\S]*?return;/);
  assert.match(allClosedHandler[1], /process\.platform !== "win32"[\s\S]*?app\.quit\(\)/);
  assert.match(allClosedHandler[1], /tray process remains active/);
});
