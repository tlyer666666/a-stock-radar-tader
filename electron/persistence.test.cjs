const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  capItemsPreservingFavorites,
  readJsonWithBackup,
  writeJsonAtomic
} = require("./persistence.cjs");

function createFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a-stock-radar-persistence-"));
}

test("watchlist caps retain favorites before automatic pool entries", () => {
  const automatic = Array.from({ length: 500 }, (_, index) => ({
    code: String(index).padStart(6, "0"),
    autoAdded: true,
    favorite: false
  }));
  const favorites = [
    { code: "600519", autoAdded: true, favorite: true },
    { code: "300750", autoAdded: false, favorite: false }
  ];
  const input = [...automatic, ...favorites];

  const retained = capItemsPreservingFavorites(
    input,
    500,
    (item) => item.favorite === true || item.autoAdded !== true
  );

  assert.equal(retained.length, 500);
  assert.deepEqual(retained.slice(-2).map((item) => item.code), ["600519", "300750"]);
  assert.equal(retained.filter((item) => item.autoAdded && !item.favorite).length, 498);
  assert.equal(input.length, 502, "the helper must not mutate its input");
});

test("favorite entries win when favorites alone exceed the cap", () => {
  const retained = capItemsPreservingFavorites([
    { code: "000001", favorite: false },
    { code: "600519", favorite: true },
    { code: "300750", favorite: true },
    { code: "002594", favorite: true }
  ], 2);

  assert.deepEqual(retained.map((item) => item.code), ["600519", "300750"]);
});

test("the first atomic JSON write immediately creates a recoverable last-good copy", () => {
  const directory = createFixture();
  const primary = path.join(directory, "watchlist.json");
  const backup = path.join(directory, "watchlist.last-good.json");
  try {
    writeJsonAtomic(primary, backup, [{ code: "600519", favorite: true }]);

    assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), [
      { code: "600519", favorite: true }
    ]);
    fs.writeFileSync(primary, "{broken", "utf8");
    assert.deepEqual(readJsonWithBackup(primary, backup, []).value, [
      { code: "600519", favorite: true }
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("atomic JSON writes retain a last-good copy and recover from a corrupt primary", () => {
  const directory = createFixture();
  const primary = path.join(directory, "holdings.json");
  const backup = path.join(directory, "holdings.last-good.json");
  try {
    writeJsonAtomic(primary, backup, [{ code: "600519", shares: 100 }]);
    writeJsonAtomic(primary, backup, [{ code: "300750", shares: 200 }]);
    fs.writeFileSync(primary, "{broken", "utf8");
    const restored = readJsonWithBackup(primary, backup, []);
    assert.equal(restored.recovered, true);
    assert.deepEqual(restored.value, [{ code: "600519", shares: 100 }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed serialization cannot overwrite a previously valid JSON file", () => {
  const directory = createFixture();
  const primary = path.join(directory, "settings.json");
  const backup = path.join(directory, "settings.last-good.json");
  try {
    writeJsonAtomic(primary, backup, { version: 1 });
    assert.throws(() => writeJsonAtomic(primary, backup, { invalid: BigInt(1) }));
    assert.deepEqual(JSON.parse(fs.readFileSync(primary, "utf8")), { version: 1 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt primary cannot replace the last-good backup during a later write", () => {
  const directory = createFixture();
  const primary = path.join(directory, "watchlist.json");
  const backup = path.join(directory, "watchlist.last-good.json");
  try {
    writeJsonAtomic(primary, backup, { version: 1 });
    writeJsonAtomic(primary, backup, { version: 2 });
    fs.writeFileSync(primary, "{broken", "utf8");

    writeJsonAtomic(primary, backup, { version: 3 });

    assert.deepEqual(JSON.parse(fs.readFileSync(primary, "utf8")), { version: 3 });
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), { version: 1 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("schema-invalid JSON recovers from a compatible last-good list without poisoning it on save",()=>{
  const directory=createFixture(),primary=path.join(directory,"watchlist.json"),backup=path.join(directory,"watchlist.last-good.json");
  try{
    const old=[{code:"600000",favorite:true}];
    writeJsonAtomic(primary,backup,old,Array.isArray);
    for(const invalid of [null,{},"wrong-shape",12]){
      fs.writeFileSync(primary,JSON.stringify(invalid));
      const recovered=readJsonWithBackup(primary,backup,[],Array.isArray);
      assert.equal(recovered.recovered,true);assert.deepEqual(recovered.value,old);
    }
    writeJsonAtomic(primary,backup,[{code:"600001"}],Array.isArray);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup,"utf8")),old);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test("schema-rejected writes leave both files intact and legacy calls remain compatible",()=>{
  const directory=createFixture(),primary=path.join(directory,"watchlist.json"),backup=path.join(directory,"watchlist.last-good.json");
  try{
    writeJsonAtomic(primary,backup,[{code:"600000"}],Array.isArray);
    for(const value of [null,{},"text",1])assert.throws(()=>writeJsonAtomic(primary,backup,value,Array.isArray),error=>error.code==="INVALID_JSON_SCHEMA");
    assert.equal(JSON.parse(fs.readFileSync(primary,"utf8")).length,1);
    assert.equal(JSON.parse(fs.readFileSync(backup,"utf8")).length,1);
    assert.equal(fs.readdirSync(directory).filter(name=>name.endsWith(".tmp")).length,0);
    writeJsonAtomic(primary,backup,{legacy:true});
    assert.deepEqual(readJsonWithBackup(primary,backup,{}).value,{legacy:true});
    assert.deepEqual(readJsonWithBackup(primary,backup,[],Array.isArray).value,[{code:"600000"}]);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test("an interrupted backup copy preserves the previous valid backup and cleans temporary files",()=>{
  const directory=createFixture(),primary=path.join(directory,"watchlist.json"),backup=path.join(directory,"watchlist.last-good.json");
  const originalCopy=fs.copyFileSync;
  try{
    writeJsonAtomic(primary,backup,[{version:1}],Array.isArray);
    writeJsonAtomic(primary,backup,[{version:2}],Array.isArray);
    fs.copyFileSync=(source,destination,...args)=>{
      if(source===primary){fs.writeFileSync(destination,"{partial");throw Object.assign(Error("simulated half-copy I/O failure"),{code:"EIO"});}
      return originalCopy(source,destination,...args);
    };
    assert.throws(()=>writeJsonAtomic(primary,backup,[{version:3}],Array.isArray),/half-copy/);
    assert.deepEqual(JSON.parse(fs.readFileSync(primary,"utf8")),[{version:2}]);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup,"utf8")),[{version:1}]);
    assert.equal(fs.readdirSync(directory).filter(name=>name.endsWith(".tmp")).length,0);
  }finally{fs.copyFileSync=originalCopy;fs.rmSync(directory,{recursive:true,force:true});}
});

test("first backup failure reports degraded recovery after commit without falsely rejecting the saved value", () => {
  const directory=createFixture(),primary=path.join(directory,"watchlist.json"),backup=path.join(directory,"watchlist.last-good.json");
  const originalCopy=fs.copyFileSync, reported=[];
  const first=[{version:1}], second=[{version:2}];
  try {
    fs.copyFileSync=()=>{throw Object.assign(Error("first backup unavailable"),{code:"EIO"});};
    assert.equal(writeJsonAtomic(primary,backup,first,Array.isArray,error=>reported.push(error)),first);
    assert.deepEqual(JSON.parse(fs.readFileSync(primary,"utf8")),first);
    assert.equal(fs.existsSync(backup),false);
    assert.equal(reported.length,1);assert.equal(reported[0].code,"EIO");
    assert.equal(fs.readdirSync(directory).filter(name=>name.endsWith(".tmp")).length,0);
    fs.copyFileSync=originalCopy;
    writeJsonAtomic(primary,backup,second,Array.isArray,error=>reported.push(error));
    assert.deepEqual(JSON.parse(fs.readFileSync(primary,"utf8")),second);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup,"utf8")),first);
    assert.equal(reported.length,1);
  } finally {fs.copyFileSync=originalCopy;fs.rmSync(directory,{recursive:true,force:true});}
});

test("a degraded-backup logger failure cannot turn an already committed save into an error", () => {
  const directory=createFixture(),primary=path.join(directory,"watchlist.json"),backup=path.join(directory,"watchlist.last-good.json");
  const originalCopy=fs.copyFileSync;
  try {
    fs.copyFileSync=()=>{throw Error("backup failure");};
    assert.doesNotThrow(()=>writeJsonAtomic(primary,backup,[],Array.isArray,()=>{throw Error("logger failure");}));
    assert.deepEqual(JSON.parse(fs.readFileSync(primary,"utf8")),[]);
  } finally {fs.copyFileSync=originalCopy;fs.rmSync(directory,{recursive:true,force:true});}
});
