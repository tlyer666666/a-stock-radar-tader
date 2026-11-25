"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {createHarness}=require("../qa/main-ipc-test-harness.cjs");
const {loadElectronIpcSources}=require("../qa/ipc-source-loader.cjs");

test('repeated settings and service reads use one in-memory snapshot until a successful save',()=>{
 const observed=[];const h=createHarness({getProfessionalReview:input=>{observed.push(input.settings);return {};}});
 const originalRead=fs.readFileSync;let reads=0;
 try {
  h.invoke('settings:save',{refreshToken:'first',tushareToken:'second'});
  fs.readFileSync=(file,...args)=>{if(String(file)===path.join(h.directory,'settings.json'))reads++;return originalRead(file,...args);};
  for(let i=0;i<5;i++){h.invoke('settings:get');h.invoke('review:get-market');}
  assert.equal(reads,0);assert.equal(observed[0].refreshToken,'first');
  h.invoke('settings:save',{refreshToken:'changed'});
  h.invoke('review:get-market');assert.equal(observed.at(-1).refreshToken,'changed');
 } finally {fs.readFileSync=originalRead;h.cleanup();}
});

for(const resource of ["watchlist","holdings"])test(`malformed ${resource} save must reject without erasing saved rows`,()=>{
  const h=createHarness();try{
    const row={code:"600000",name:"ISOLATED_SYNTHETIC",shares:100,costPrice:10,favorite:true};
    h.invoke(`${resource}:save`,[row]);
    assert.throws(()=>h.invoke(`${resource}:save`,null),error=>error.code==="INVALID_IPC_PAYLOAD");
    assert.equal(h.json(resource).length,1);
  }finally{h.cleanup();}
});

for(const resource of ["watchlist","holdings"])test(`valid JSON with wrong ${resource} shape should recover the valid backup`,()=>{
  const h=createHarness();try{
    const row={code:"600000",name:"ISOLATED_SYNTHETIC",shares:100,costPrice:10,favorite:true};
    h.invoke(`${resource}:save`,[row]);
    fs.writeFileSync(path.join(h.directory,`${resource}.json`),"null");
    const recovered=h.invoke(`${resource}:get`);
    assert.equal(recovered.length,1,"syntax-valid null must not shadow a good list backup");
  }finally{h.cleanup();}
});

test("control: explicit empty list remains a legitimate clear and malformed JSON uses backup",()=>{
  const h=createHarness();try{
    h.invoke("watchlist:save",[{code:"600000",favorite:true}]);
    fs.writeFileSync(path.join(h.directory,"watchlist.json"),"{broken");
    assert.equal(h.invoke("watchlist:get").length,1);
    h.invoke("watchlist:save",[]);assert.equal(h.json("watchlist").length,0);
  }finally{h.cleanup();}
});

test("a committed initial save acknowledges success and records a recoverability warning when backup creation fails",()=>{
  const h=createHarness(),originalCopy=fs.copyFileSync;
  try {
    fs.copyFileSync=()=>{throw Object.assign(Error("isolated backup failure"),{code:"EIO"});};
    const result=h.invoke("watchlist:save",[{code:"600000",favorite:true}]);
    assert.equal(result.length,1);assert.equal(h.json("watchlist").length,1);
    assert.equal(h.logs.length,1);
    assert.equal(h.logs[0][0],"persistence-backup-degraded");
    assert.equal(h.logs[0][1].code,"EIO");assert.equal(h.logs[0][2],"watchlist");
  } finally {fs.copyFileSync=originalCopy;h.cleanup();}
});

for (const invalid of [null, [], "wrong-shape"]) test(`settings recover last-good when primary is ${JSON.stringify(invalid)}`, () => {
  const h = createHarness();
  try {
    h.invoke("settings:save", { quoteRefreshSeconds: 17, theme: "dark" });
    h.invoke("settings:save", { quoteRefreshSeconds: 17, theme: "dark" });
    fs.writeFileSync(path.join(h.directory, "settings.json"), JSON.stringify(invalid));
    const saved = h.invoke("settings:get");
    assert.equal(saved.quoteRefreshSeconds, 17);
    assert.equal(saved.theme, "dark");
    h.invoke("settings:save", { alertScore: 80 });
    assert.equal(h.json("settings").quoteRefreshSeconds, 17);
    assert.equal(h.json("settings.last-good").theme, "dark");
  } finally { h.cleanup(); }
});

test("secret changes have one primary commit and both recovery copies contain the new state", () => {
  const h = createHarness(), originalRename = fs.renameSync;
  let commits = 0;
  try {
    h.invoke("settings:save", { refreshToken: "SYNTHETIC_OLD", theme: "dark" });
    fs.renameSync = (from, to) => {
      if (to === path.join(h.directory, "settings.json")) {
        commits++;
        if (commits > 1) throw Object.assign(Error("unexpected second commit"), { code: "EIO" });
      }
      return originalRename(from, to);
    };
    const result = h.invoke("settings:save", { refreshToken: "", quoteRefreshSeconds: 17 });
    assert.equal(result.refreshToken, "");
    assert.equal(commits, 1);
    assert.equal(h.json("settings").refreshToken, "");
    assert.deepEqual(h.json("settings.last-good"), h.json("settings"));
  } finally { fs.renameSync = originalRename; h.cleanup(); }
});

test("a failed sensitive backup preparation rejects before committing primary settings", () => {
  const h = createHarness(), originalCopy = fs.copyFileSync;
  try {
    h.invoke("settings:save", { refreshToken: "SYNTHETIC_OLD", quoteRefreshSeconds: 17 });
    const before = h.json("settings"), backup = h.json("settings.last-good");
    fs.copyFileSync = () => { throw Object.assign(Error("isolated backup prepare failure"), { code: "EIO" }); };
    assert.throws(() => h.invoke("settings:save", { refreshToken: "", quoteRefreshSeconds: 6 }), { code: "EIO" });
    assert.deepEqual(h.json("settings"), before);
    assert.deepEqual(h.json("settings.last-good"), backup);
    assert.equal(fs.readdirSync(h.directory).some(name => name.endsWith(".tmp")), false);
  } finally { fs.copyFileSync = originalCopy; h.cleanup(); }
});

for (const corruptPrimary of [false, true]) test(`sensitive primary rename failure restores the previous backup with corruptPrimary=${corruptPrimary}`, () => {
  const h = createHarness(), originalRename = fs.renameSync;
  try {
    h.invoke("settings:save", { refreshToken: "SYNTHETIC_OLD", quoteRefreshSeconds: 17 });
    if (corruptPrimary) fs.writeFileSync(path.join(h.directory, "settings.json"), "null");
    const before = h.json("settings"), backup = h.json("settings.last-good");
    fs.renameSync = (from, to) => {
      if (to === path.join(h.directory, "settings.json")) throw Object.assign(Error("isolated primary commit failure"), { code: "EIO" });
      return originalRename(from, to);
    };
    assert.throws(() => h.invoke("settings:save", { refreshToken: "", quoteRefreshSeconds: 6 }), { code: "EIO" });
    assert.deepEqual(h.json("settings"), before);
    assert.deepEqual(h.json("settings.last-good"), backup);
    assert.equal(h.invoke("settings:get").quoteRefreshSeconds, 17);
    assert.equal(fs.readdirSync(h.directory).some(name => name.endsWith(".tmp")), false);
  } finally { fs.renameSync = originalRename; h.cleanup(); }
});

test("a second filesystem failure during backup rollback retains the old recovery file and reports degradation", () => {
  const h = createHarness(), originalRename = fs.renameSync;
  try {
    h.invoke("settings:save", { refreshToken: "SYNTHETIC_OLD", quoteRefreshSeconds: 17 });
    const previousBackup = h.json("settings.last-good");
    fs.renameSync = (from, to) => {
      if (to === path.join(h.directory, "settings.json") || from.endsWith(".rollback.tmp")) throw Object.assign(Error("isolated commit and rollback failure"), { code: "EIO" });
      return originalRename(from, to);
    };
    assert.throws(() => h.invoke("settings:save", { refreshToken: "", quoteRefreshSeconds: 6 }), { code: "EIO" });
    assert.equal(h.json("settings").quoteRefreshSeconds, 17);
    const recoverable = fs.readdirSync(h.directory).filter(name => name.endsWith(".rollback.tmp"));
    assert.equal(recoverable.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.directory, recoverable[0]), "utf8")), previousBackup);
    assert.equal(h.logs.at(-1)[0], "persistence-backup-degraded");
  } finally { fs.renameSync = originalRename; h.cleanup(); }
});

test("sensitive backup promotion failure leaves both committed copies untouched", () => {
  const h = createHarness(), originalRename = fs.renameSync;
  try {
    h.invoke("settings:save", { refreshToken: "SYNTHETIC_OLD", quoteRefreshSeconds: 17 });
    const before = h.json("settings"), backup = h.json("settings.last-good");
    fs.renameSync = (from, to) => {
      if (to === path.join(h.directory, "settings.last-good.json")) throw Object.assign(Error("isolated backup promotion failure"), { code: "EIO" });
      return originalRename(from, to);
    };
    assert.throws(() => h.invoke("settings:save", { refreshToken: "" }), { code: "EIO" });
    assert.deepEqual(h.json("settings"), before);
    assert.deepEqual(h.json("settings.last-good"), backup);
    assert.equal(fs.readdirSync(h.directory).some(name => name.endsWith(".tmp")), false);
  } finally { fs.renameSync = originalRename; h.cleanup(); }
});

test("failed initial sensitive primary commit removes the uncommitted backup", () => {
  const h = createHarness(), originalRename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (to === path.join(h.directory, "settings.json")) throw Object.assign(Error("isolated initial commit failure"), { code: "EIO" });
      return originalRename(from, to);
    };
    assert.throws(() => h.invoke("settings:save", { refreshToken: "SYNTHETIC_NEW" }), { code: "EIO" });
    assert.deepEqual(fs.readdirSync(h.directory), []);
  } finally { fs.renameSync = originalRename; h.cleanup(); }
});

for(const kind of ['watchlist','holdings'])test('R3 all-invalid '+kind+' primary must not hide a valid backup',()=>{const h=createHarness();try{const good={code:'600001',name:'synthetic-backup',shares:100,costPrice:10};const primary='[null,{"code":"bad","shares":0}]',backup=JSON.stringify([good]);fs.writeFileSync(path.join(h.directory,kind+'.json'),primary);fs.writeFileSync(path.join(h.directory,kind+'.last-good.json'),backup);const rows=JSON.parse(JSON.stringify(h.invoke(kind+':get')));console.log('R3 INVALID PRIMARY',JSON.stringify({kind,rows,backupCode:good.code}));assert.equal(fs.readFileSync(path.join(h.directory,kind+'.json'),'utf8'),primary);assert.equal(fs.readFileSync(path.join(h.directory,kind+'.last-good.json'),'utf8'),backup);assert.deepEqual(rows.map(x=>x.code),['600001']);}finally{h.cleanup();}});
for(const kind of ['watchlist','holdings'])test('control mixed and intentionally empty '+kind+' primary retain authority',()=>{const h=createHarness();try{const good={code:'600003',name:'synthetic-primary',shares:100,costPrice:10},backup=[{...good,code:'600004'}];fs.writeFileSync(path.join(h.directory,kind+'.last-good.json'),JSON.stringify(backup));for(const [value,expected] of [[[null,good],['600003']],[[],[]]]){fs.writeFileSync(path.join(h.directory,kind+'.json'),JSON.stringify(value));assert.deepEqual(Array.from(h.invoke(kind+':get'),x=>x.code),expected);}}finally{h.cleanup();}});
for(const kind of ['watchlist','holdings'])test('R3 successful '+kind+' save must not rotate wholly corrupt primary over last-good',()=>{const h=createHarness();try{const good={code:'600005',name:'synthetic-backup',shares:100,costPrice:10},backup=JSON.stringify([good]);fs.writeFileSync(path.join(h.directory,kind+'.json'),'[null]');fs.writeFileSync(path.join(h.directory,kind+'.last-good.json'),backup);h.invoke(kind+':save',[{...good,code:'600006'}]);const retained=JSON.parse(fs.readFileSync(path.join(h.directory,kind+'.last-good.json'),'utf8'));console.log('R3 BACKUP ROTATION',JSON.stringify({kind,retained}));assert.deepEqual(retained,[good]);}finally{h.cleanup();}});

test("application startup cannot read or write bundled Fuyao credentials", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(source, /fuyao-seed|applyFuyaoSeed/);
  // 1.6.49：只有本机还留着钥匙串密文需要迁回时才不启用模拟钥匙串。
  assert.match(source, /if \(process\.platform === "darwin" && !keychainMigrationPending\) app\.commandLine\?\.appendSwitch\?\.\("use-mock-keychain"\);/);
});

test("explicit Fuyao secret edits persist to both controlled settings files", () => {
  const h = createHarness();
  try {
    h.invoke("settings:save", {fuyaoApiKey:"SYNTHETIC_MANUAL_KEY"});
    const primary = h.json("settings");
    assert.match(primary.fuyaoApiKey, /^safe:/);
    assert.equal(h.json("settings.last-good").fuyaoApiKey, primary.fuyaoApiKey);
    h.invoke("settings:save", {fuyaoApiKey:""});
    assert.equal(h.json("settings").fuyaoApiKey, "");
    assert.equal(h.json("settings.last-good").fuyaoApiKey, "");
  } finally { h.cleanup(); }
});

test("a temporarily locked keychain preserves old files, and ordinary saves cannot copy legacy plaintext into the backup", () => {
  const h = createHarness({ secureStoreAvailable: false });
  try {
    const old = JSON.stringify({refreshToken:"plain:SYNTHETIC_ONLY",theme:"dark"});
    fs.writeFileSync(path.join(h.directory,"settings.json"),old);
    assert.match(h.invoke("settings:get").refreshToken, /^•+$/);
    assert.throws(() => h.invoke("settings:save", {theme:"light"}), {code:"SAFE_STORAGE_UNAVAILABLE"});
    assert.equal(fs.readFileSync(path.join(h.directory,"settings.json"),"utf8"),old);
    assert.equal(fs.existsSync(path.join(h.directory,"settings.last-good.json")),false);
    h.invoke("settings:save",{refreshToken:""});
    assert.equal(h.json("settings").refreshToken,"");
    assert.equal(h.json("settings.last-good").refreshToken,"");
  } finally { h.cleanup(); }
});

test("main process migrates system ciphertext on all platforms, syncs stock-agent backups, restores windows on notification click, invalidates settings cache on backup restore, and redacts noteWatcher errors", () => {
  const { combinedSource: source } = loadElectronIpcSources();
  const pendingBlock = source.match(/const keychainMigrationPending = \(\(\) => \{([\s\S]*?)\}\)\(\);/);
  assert.ok(pendingBlock);
  assert.doesNotMatch(pendingBlock[1], /process\.platform\s*!==\s*["']darwin["']/);
  assert.match(source, /writeJson\("stock-agent",\s*value,\s*isAgentStore,\s*true\)/);
  assert.match(source, /notification\.on\("click",\s*\(\)\s*=>\s*showOrCreateMainWindow\(\)\)/);
  assert.match(
    source,
    /handleTrustedIpc\("backup:restore",[\s\S]*?loadStoredSettings\.cached\s*=\s*undefined;[\s\S]*?settingsForService\.cached\s*=\s*undefined;/
  );
  assert.match(
    source,
    /handleTrustedIpc\("notes:watch-sync",[\s\S]*?redactRuntimeText\(result\.error\)/
  );
});

test("stock-agent deletion with synchronized backup prevents deleted conversations from resurrecting on primary corruption", () => {
  const os = require("node:os");
  const { writeJsonAtomic, readJsonWithBackup } = require("./persistence.cjs");
  const { isAgentStore } = require("./stock-agent.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astock-agent-sync-"));
  try {
    const primary = path.join(dir, "stock-agent.json");
    const backup = path.join(dir, "stock-agent.last-good.json");
    writeJsonAtomic(primary, backup, { version: 1, conversations: [{ id: "c1", messages: [] }] }, isAgentStore, undefined, { synchronizeBackup: true });
    writeJsonAtomic(primary, backup, { version: 1, conversations: [] }, isAgentStore, undefined, { synchronizeBackup: true });
    fs.writeFileSync(primary, "{broken");
    const loaded = readJsonWithBackup(primary, backup, null, isAgentStore);
    assert.equal(loaded.recovered, true);
    assert.deepEqual(loaded.value.conversations, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("pending restart after backup restore rejects late writes from the old app state", () => {
  const h = createHarness({ restoredProfilePendingRestart: true });
  try {
    fs.writeFileSync(path.join(h.directory, "watchlist.json"), JSON.stringify([{ code: "600000", favorite: true }]));
    assert.throws(() => h.invoke("watchlist:save", []), { code: "BACKUP_RESTARTING" });
    assert.equal(h.json("watchlist")[0].code, "600000");
  } finally { h.cleanup(); }
});

test("saving more than 80 distinct holdings throws explicitly instead of silently dropping positions", () => {
  const h = createHarness();
  try {
    const eighty = Array.from({ length: 80 }, (_, idx) => ({ code: String(600000 + idx), name: `样本${idx}`, shares: 100, costPrice: 10 }));
    assert.equal(h.invoke("holdings:save", eighty).length, 80);
    const eightyOne = [...eighty, { code: "600080", name: "第81只", shares: 100, costPrice: 10 }];
    assert.throws(() => h.invoke("holdings:save", eightyOne), { code: "HOLDINGS_LIMIT_EXCEEDED" });
    assert.equal(h.json("holdings").length, 80);
  } finally { h.cleanup(); }
});

test("main.cjs cleanupStorageCache uses removedOrphans and master password handlers invalidate caches and wire isLocked", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(mainSource, /removedStale/);
  assert.match(mainSource, /removedOrphans\s*\?\?\s*0/);
  assert.match(mainSource, /removedTmp\s*\?\?\s*0/);
  assert.match(mainSource, /createAiProfileStore\(\{[\s\S]*?isLocked:\s*\(\)\s*=>\s*secretStorage\(\)\.isLocked\(\)/);
  assert.match(mainSource, /isSecretLocked:\s*\(\)\s*=>\s*secretStorage\(\)\.isLocked\(\)/);
  assert.match(mainSource, /setMasterPassword:\s*async\s+input\s*=>[\s\S]*?loadStoredSettings\.cached\s*=\s*undefined;[\s\S]*?settingsForService\.cached\s*=\s*undefined;/);
  assert.match(mainSource, /clearMasterPassword:\s*async\s+input\s*=>[\s\S]*?loadStoredSettings\.cached\s*=\s*undefined;[\s\S]*?settingsForService\.cached\s*=\s*undefined;/);
  assert.match(mainSource, /unlockMasterPassword:\s*async\s+input\s*=>[\s\S]*?resetMarketSourceHealth\(\)[\s\S]*?resetNewsCache\(\)[\s\S]*?resetProfessionalReviewCache\(\)/);
});

test("storage:kv-set is a no-op during post-restore restart window and settings:save strips unknown keys", () => {
  const { registerWorkspaceIpc } = require("./ipc/workspace.ipc.cjs");
  const handlers = new Map();
  let kvSetCalls = 0;
  registerWorkspaceIpc({
    handleTrustedIpc: (channel, handler) => handlers.set(channel, handler),
    app: { getVersion: () => "1.0.0" },
    createBackupService: () => ({}),
    powerMonitor: { on: () => {} },
    intervalReminders: { tick: () => {} },
    getRestoredProfilePendingRestart: () => true,
    kvSet: () => { kvSetCalls += 1; return true; }
  });
  assert.equal(handlers.get("storage:kv-set")({}, { key: "a-stock-radar:k", value: "v" }), false);
  assert.equal(kvSetCalls, 0);

  const h = createHarness();
  try {
    h.invoke("settings:save", { theme: "dark", unknownExtraField: "should-not-persist" });
    const saved = h.json("settings");
    assert.equal(saved.theme, "dark");
    assert.equal(Object.hasOwn(saved, "unknownExtraField"), false);
  } finally { h.cleanup(); }
});

test("main.cjs closes SQLite synchronously on before-quit and defensively on will-quit, saves bounds on every close, scopes reviewSkills per run, and hardens debugLog", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const beforeQuitBlock = mainSource.match(/app\.on\("before-quit",\s*\(event\)\s*=>\s*\{([\s\S]*?)\n\}\);/);
  assert.ok(beforeQuitBlock);
  const quitFlagIdx = beforeQuitBlock[1].indexOf("isQuitting = true;");
  const closeIdx = beforeQuitBlock[1].indexOf("localKvStoreInstance?.close?.()");
  const finishIdx = beforeQuitBlock[1].indexOf("finishShutdown(event);");
  assert.ok(quitFlagIdx >= 0 && closeIdx > quitFlagIdx && closeIdx < finishIdx, "SQLite must close synchronously right after isQuitting = true before async finishShutdown");

  const willQuitBlock = mainSource.match(/app\.on\("will-quit",\s*\(\)\s*=>\s*\{([\s\S]*?)\n\}\);/);
  assert.ok(willQuitBlock && willQuitBlock[1].includes("localKvStoreInstance?.close?.()"));

  assert.match(mainSource, /createdWindow\.on\?\.\("close",\s*\(\)\s*=>\s*\{[\s\S]*?saveMainBounds\(\);/);
  assert.match(mainSource, /renameWithRetrySync\(tmpBoundsFile,\s*boundsFile\)/);
  assert.doesNotMatch(mainSource, /let reviewSkillsInstance;/);
  assert.match(mainSource, /const reviewSkillsByLifecycle = new WeakMap\(\);/);
  assert.match(mainSource, /reviewSkill:\s*\(skill,\s*args,\s*lifecycle\)\s*=>\s*reviewSkillsFor\(lifecycle\)\.runSkill\(skill,\s*args,\s*\{\s*signal:\s*lifecycle\?\.signal\s*\}\)/);
  assert.match(mainSource, /marketNews:\s*lifecycle\s*=>\s*getNewsFeed\(\{\s*scope:\s*"all",\s*limit:\s*80\s*\},\s*settingsForService\(\),\s*\{\s*signal:\s*lifecycle\?\.signal\s*\}\)/);
  assert.match(mainSource, /kvSet:\s*\(key,\s*value\)\s*=>\s*\{\s*if\s*\(restoredProfilePendingRestart\s*\|\|\s*isQuitting\s*\|\|\s*restoreCommitting\)\s*return false;/);
  assert.match(mainSource, /function debugLog\(message\)[\s\S]*?app\.getPath\("userData"\)[\s\S]*?lstatSync\(logPath\)[\s\S]*?DEBUG_LOG_MAX_BYTES[\s\S]*?0o600/);
});

test("M-5: settings:save rejects changing aiBaseUrl to a different origin without a new aiApiKey", () => {
  const h = createHarness();
  try {
    h.invoke("settings:save", { aiBaseUrl: "https://api.deepseek.com/v1", aiApiKey: "sk-deepseek-key" });
    assert.match(h.json("settings").aiApiKey, /^safe:/);

    // Same-origin path change preserves saved key
    h.invoke("settings:save", { aiBaseUrl: "https://api.deepseek.com/v2", aiApiKey: "••••••••••••" });
    assert.equal(h.json("settings").aiBaseUrl, "https://api.deepseek.com/v2");
    assert.match(h.json("settings").aiApiKey, /^safe:/);

    // Different origin without a new key (omitted or masked) must be rejected
    assert.throws(
      () => h.invoke("settings:save", { aiBaseUrl: "https://other-provider.example/v1" }),
      { code: "INVALID_AI_PROFILE" }
    );
    assert.throws(
      () => h.invoke("settings:save", { aiBaseUrl: "https://other-provider.example/v1", aiApiKey: "••••••••••••" }),
      { code: "INVALID_AI_PROFILE" }
    );
    assert.equal(h.json("settings").aiBaseUrl, "https://api.deepseek.com/v2");

    // Different origin WITH a new key succeeds
    h.invoke("settings:save", { aiBaseUrl: "https://other-provider.example/v1", aiApiKey: "sk-other-provider-key" });
    assert.equal(h.json("settings").aiBaseUrl, "https://other-provider.example/v1");
  } finally {
    h.cleanup();
  }
});

test("M-1: backup:prepare-restore sets restoreInProgress synchronously, rejects concurrent prepares, and blocks kv-set during commit", async () => {
  const { registerWorkspaceIpc } = require("./ipc/workspace.ipc.cjs");
  const handlers = new Map();
  let restoreInProgress = false;
  let restoreCommitting = false;
  let restoredPending = false;
  let kvSetCalls = 0;
  let resolvePrepare;
  let resolveApply;
  let writeStoreAllowFlag = null;

  registerWorkspaceIpc({
    handleTrustedIpc: (channel, handler) => handlers.set(channel, handler),
    app: { getVersion: () => "1.0.0", relaunch: () => {}, quit: () => {} },
    fs: { unlinkSync: () => {} },
    dialog: {},
    shell: {},
    powerMonitor: { on: () => {} },
    BrowserWindow: {},
    getMainWindow: () => null,
    trustedMainWebContents: () => fakeSender,
    readJson: () => null,
    writeJson: (_name, _val, _validator, _sync, opts) => { writeStoreAllowFlag = opts?.allowDuringRestoreCommit === true; },
    jsonPath: n => n,
    backupJsonPath: n => n,
    isSettingsRecord: () => true,
    usableWatchlist: () => true,
    usableHoldings: () => true,
    isCustomStrategyStore: () => true,
    isAiProfileStore: () => true,
    isAiFrameworkState: () => true,
    isAiCustomList: () => true,
    isAiStore: () => true,
    isAgentStore: () => true,
    createBackupService: ({ writeStore }) => ({
      status: () => ({}),
      suggestions: () => [],
      prepareRestore: () => new Promise((resolve, reject) => { resolvePrepare = { resolve, reject }; }),
      applyRestore: async () => {
        writeStore("settings", {});
        await new Promise(resolve => { resolveApply = resolve; });
      }
    }),
    readMigratedBackupConfig: () => ({}),
    loadStoredSettings: () => ({}),
    settingsForService: () => ({}),
    intervalReminders: { tick: () => {} },
    getRestoredProfilePendingRestart: () => restoredPending,
    setRestoredProfilePendingRestart: value => { restoredPending = Boolean(value); },
    setRestoreInProgress: value => { restoreInProgress = Boolean(value); },
    setRestoreCommitting: value => { restoreCommitting = Boolean(value); },
    kvSet: () => { kvSetCalls += 1; return true; }
  });

  const fakeSender = { id: 7, session: { flushStorageData: async () => {} } };
  const event = { sender: fakeSender };

  // 1) prepare-restore sets restoreInProgress synchronously BEFORE await and blocks concurrent prepare
  const firstPrepare = handlers.get("backup:prepare-restore")(event, "A股雷达备份-20261112-160509.json", "");
  assert.equal(restoreInProgress, true);
  await assert.rejects(() => handlers.get("backup:prepare-restore")(event, "A股雷达备份-20261112-160509.json", ""), { code: "BACKUP_BUSY" });

  // 2) failed prepare resets restoreInProgress
  resolvePrepare.reject(new Error("bad backup"));
  await assert.rejects(firstPrepare, /bad backup/);
  assert.equal(restoreInProgress, false);

  // 3) successful prepare -> restore blocks storage:kv-set while committing and passes allowDuringRestoreCommit to writeJson
  const secondPrepare = handlers.get("backup:prepare-restore")(event, "A股雷达备份-20261112-160509.json", "");
  resolvePrepare.resolve({ local: {}, stores: {} });
  const { token } = await secondPrepare;
  const commitPromise = handlers.get("backup:restore")(event, token);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restoreCommitting, true);
  assert.equal(writeStoreAllowFlag, true);
  assert.equal(handlers.get("storage:kv-set")(event, { key: "a-stock-radar:k", value: "v" }), false);
  assert.equal(kvSetCalls, 0);
  resolveApply();
  const commitResult = await commitPromise;
  assert.equal(commitResult.ok, true);
  assert.equal(restoreCommitting, false);
  assert.equal(restoredPending, true);
});
