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

test('editing an existing secret mask is rejected explicitly rather than silently ignored',()=>{
 for(const input of ['••••new-token','new-token••••']){
  assert.throws(()=>resolveStoredSecret(input,'old',value=>value),{code:'INVALID_SECRET_MASK'});
  assert.throws(()=>resolveTestSecret(input,'old'),{code:'INVALID_SECRET_MASK'});
 }
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

test("already protected or empty settings never initialize the OS keychain just to inspect migration", () => {
  let checks = 0;
  const protectedStorage = {isEncryptionAvailable(){checks++;throw Error("OS approval pending");}};
  for (const input of [{}, {refreshToken:"",tushareToken:""},
    {refreshToken:"safe:synthetic",tushareToken:"safe:other"}, {refreshToken:"plain:"}]) {
    const result = migrateLegacyStoredSecrets(input,["refreshToken","tushareToken"],protectedStorage);
    assert.equal(checks,0);
    assert.equal(result.settings.refreshToken, input.refreshToken === "plain:" ? "" : input.refreshToken);
  }
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
  assert.deepEqual(result.deferredKeys, []);
  assert.equal(decryptStoredSecret("plain:legacy-refresh", storage), "");
  assert.equal(decryptStoredSecret("legacy-raw", storage), "");
});

test("legacy plaintext migration is deferred while safeStorage is unavailable", () => {
  const input = { refreshToken: "plain:legacy-refresh" };
  const result = migrateLegacyStoredSecrets(input, ["refreshToken"], fakeSafeStorage(false));
  assert.equal(result.migrated, false);
  assert.equal(result.settings.refreshToken, input.refreshToken);
  assert.notEqual(result.settings, input);
  assert.deepEqual(result.deferredKeys, ["refreshToken"]);
  assert.equal(input.refreshToken, "plain:legacy-refresh");
  assert.equal(decryptStoredSecret("plain:legacy-refresh", fakeSafeStorage(false)), "");
  assert.equal(decryptStoredSecret("safe:not-readable", fakeSafeStorage(false)), "");
});

test("legacy plaintext is preserved if an advertised safeStorage backend fails", () => {
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
  assert.equal(result.settings.tushareToken, "legacy-token");
  assert.deepEqual(result.deferredKeys, ["tushareToken"]);
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
  assert.deepEqual(result.deferredKeys, []);
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
  const entry = "file:///app/dist/index.html";
  const mainFrame = { id: "main-frame", url: entry };
  const trustedWebContents = {
    mainFrame,
    isDestroyed: () => false
  };
  const validEvent = { sender: trustedWebContents, senderFrame: mainFrame };
  assert.equal(isTrustedMainFrameIpcEvent(validEvent, trustedWebContents, entry), true);
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
    () => trustedWebContents, "IPC", entry
  );
  assert.equal(handler(validEvent, "payload"), "accepted:payload");
  assert.throws(
    () => handler({ sender: trustedWebContents, senderFrame: {} }, "payload"),
    (error) => error?.code === "UNTRUSTED_IPC_SOURCE"
  );
  for (const url of ["https://other.test/", "file:///app/dist/Index.html", "file:///app/dist/review/review.html", "about:blank", "", "file:///app/dist/index.html?other=1"]) {
    mainFrame.url = url;
    assert.throws(() => handler(validEvent, "payload"), { code: "UNTRUSTED_IPC_SOURCE" });
  }
  mainFrame.url = entry + "#selection";
  assert.equal(handler(validEvent, "payload"), "accepted:payload");
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
    [...preloadSource.matchAll(/\binvoke\("([^"]+)"/g)]
      .map((match) => match[1])
  )].sort();
  const trustedChannels = [...mainSource.matchAll(/handleTrustedIpc\("([^"]+)"/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(trustedChannels, invokedChannels);
  assert.equal((mainSource.match(/ipcMain\.handle\(/g) || []).length, 1);
  assert.match(mainSource, /getTrustedWebContents = trustedMainWebContents/);
  assert.match(mainSource, /createTrustedIpcHandler\(handler, getTrustedWebContents, channel, entry\)/);
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
  assert.match(mainSource, /return encryptSecretForStorage\(value, secretStorage\(\)\);/);
  assert.match(mainSource, /migrateLegacyStoredSecrets\(stored, SECRET_SETTING_KEYS, secretStorage\(\)\)/);
  assert.match(mainSource, /keychainMigrationPending \? safeStorage : null/, "the system keychain is only consulted to move 1.6.48 secrets back");
  assert.doesNotMatch(mainSource, /applyFuyaoSeed/);
  assert.doesNotMatch(mainSource, /return\s+`plain:/);
  assert.match(mainSource, /const safeMessage = redactRuntimeText\(message\)/);

  const backtestHandler = mainSource.match(
    /handleTrustedIpc\("backtest:run",([\s\S]*?)\n {2}\}\);/
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

// E-02 回归：IPC 载荷规模上限。
// 原缺陷：保存类通道只校验类型，不校验规模，百万级数组会让主进程同步卡死。
test("trusted IPC wrapper rejects oversized collections and strings", () => {
  const { assertIpcPayloadBounded, MAX_IPC_COLLECTION_ITEMS, MAX_IPC_STRING_LENGTH } =
    require("./security-policy.cjs");
  assert.equal(typeof assertIpcPayloadBounded, "function");

  // 正常规模应放行
  assert.doesNotThrow(() => assertIpcPayloadBounded([{ code: "600519" }]));
  assert.doesNotThrow(() => assertIpcPayloadBounded({ items: new Array(10).fill(1) }));
  assert.doesNotThrow(() => assertIpcPayloadBounded(null));
  assert.doesNotThrow(() => assertIpcPayloadBounded(undefined));
  assert.doesNotThrow(() => assertIpcPayloadBounded(42));

  // 超长数组必须拒绝
  const tooMany = new Array(MAX_IPC_COLLECTION_ITEMS + 1).fill({ code: "600519" });
  assert.throws(() => assertIpcPayloadBounded(tooMany), /数组元素过多/);

  // 嵌套数组同样受限（防止用嵌套绕过）
  assert.throws(
    () => assertIpcPayloadBounded([{ nested: tooMany }]),
    /数组元素过多/
  );

  // 超长字符串必须拒绝
  assert.throws(
    () => assertIpcPayloadBounded("x".repeat(MAX_IPC_STRING_LENGTH + 1)),
    /字符串过长/
  );

  // 嵌套过深必须拒绝（防止递归爆栈）
  let deep = [];
  for (let i = 0; i < 20; i += 1) deep = [deep];
  assert.throws(() => assertIpcPayloadBounded(deep), /嵌套过深/);
});

test("both sandboxed preloads return domain results unchanged and preserve safe error categories", async () => {
  const vm = require("node:vm");
  const { withIpcResult } = require("./security-policy.cjs");
  const success = {ok:false, error:"domain result"}, logged = [];
  let failed = false;
  const ipc = withIpcResult(() => {
    if (!failed) return success;
    throw Object.assign(new Error("限额 Bearer private-fixture"),{code:"SERVICE_BUSY"});
  }, code => logged.push(code));
  for (const name of ["preload.cjs", "review-preload.cjs"]) {
    let api;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,name),"utf8"),{
      process:{platform:"test"}, require:() => ({
        ipcRenderer:{invoke:ipc}, contextBridge:{exposeInMainWorld:(_,value) => {api=value;}}
      })
    });
    failed=false;
    assert.deepEqual(await api.search("synthetic"),success);
    failed=true;
    await assert.rejects(api.search("synthetic"),error =>
      error.code === "SERVICE_BUSY" && error.retryable && !/private-fixture/.test(error.message));
  }
  assert.deepEqual(logged,["SERVICE_BUSY","SERVICE_BUSY"]);
});

test("local development IPC requires the configured document including its path", () => {
  const frame = {url:"http://127.0.0.1:5173/review.html"};
  const contents = {mainFrame:frame};
  const event = {sender:contents,senderFrame:frame};
  assert.equal(isTrustedMainFrameIpcEvent(event, contents, "http://127.0.0.1:5173/"), false);
  assert.equal(isTrustedMainFrameIpcEvent(event, contents, frame.url), true);
  assert.equal(isTrustedMainFrameIpcEvent(event, contents, undefined), false);
});
