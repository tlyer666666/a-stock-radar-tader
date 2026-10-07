"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {createHarness}=require("../qa/main-ipc-test-harness.cjs");

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
