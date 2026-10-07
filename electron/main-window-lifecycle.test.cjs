"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
const ast = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const createWindow = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "createWindow");
let closeCallback;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "createdWindow.on" && node.arguments[0]?.text === "close") closeCallback = node.arguments[1].getText(ast);
  ts.forEachChild(node, visit);
}
visit(createWindow);
function closeWindow(platform, tray, quitting = false) {
  const result = { prevented: false, hidden: false, trayCalls: 0 };
  const callback = vm.runInNewContext(`(${closeCallback})`, {
    process: { platform }, isQuitting: quitting,
    createdWindow: { isDestroyed: () => false, hide: () => { result.hidden = true; } },
    createTray: () => { result.trayCalls++; return tray; }, debugLog: () => {}
  });
  callback({ preventDefault: () => { result.prevented = true; } });
  return result;
}
test("Windows close retains a reachable visible window when tray creation fails", () => {
  assert.deepEqual(closeWindow("win32", undefined), { prevented: true, hidden: false, trayCalls: 1 });
  assert.deepEqual(closeWindow("win32", { isDestroyed: () => true }), { prevented: true, hidden: false, trayCalls: 1 });
});
test("successful Windows tray hiding and ordinary platform shutdown semantics remain intact", () => {
  assert.deepEqual(closeWindow("win32", { isDestroyed: () => false }), { prevented: true, hidden: true, trayCalls: 1 });
  for (const platform of ["darwin", "linux"]) assert.deepEqual(closeWindow(platform), { prevented: false, hidden: false, trayCalls: 0 });
  assert.deepEqual(closeWindow("win32", undefined, true), { prevented: false, hidden: false, trayCalls: 0 });
});
test("partial tray setup failure destroys the allocated native tray", () => {
  let destroyed = 0;
  const trayFunction = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "createTray").getText(ast);
  const context = {
    process: { env: {} }, tray: undefined,
    Tray: class { setToolTip() {} setContextMenu() { throw Error("isolated menu failure"); } isDestroyed() { return false; } destroy() { destroyed++; } },
    applicationIconPath: () => "fixture.ico", Menu: { buildFromTemplate: value => value },
    showOrCreateMainWindow: () => {}, requestExplicitQuit: () => {}, runtimeErrorLog: () => {}
  };
  vm.runInNewContext(trayFunction, context);
  assert.equal(context.createTray(), undefined);
  assert.equal(destroyed, 1);
});

test("window theme loads before any protected service credentials are requested", () => {
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ["createWindow", "defaultSettings", "normalizeSettings", "clampNumber"].includes(node.name?.text));
  for (const [stored, expected] of [[{theme:"dark",refreshToken:"enc:v1:synthetic"},"dark"],
    [{theme:"light"},"light"], [{theme:"invalid"},"system"], [{},"system"]]) {
    const ready = new Error("window constructed");
    let requestedSecrets = 0, selectedTheme, windowOptions;
    const context = {
      debugLog:()=>{}, app:{isPackaged:true}, __dirname, path,
      readJson:(name,fallback,validate)=>{assert.equal(name,"settings");assert.equal(typeof validate,"function");return stored;},
      isSettingsRecord:()=>true,
      settingsForService:()=>{requestedSecrets++;throw Error("OS keychain approval pending");},
      applyWindowTheme:theme=>{selectedTheme=theme;}, nativeTheme:{shouldUseDarkColors:true},
      process:{platform:"darwin",env:{}}, applicationIconPath:()=>"fixture.icns",
      BrowserWindow:class {constructor(options){windowOptions=options;throw ready;}}
    };
    vm.runInNewContext(functions.map(node=>node.getText(ast)).join("\n"),context);
    assert.throws(()=>context.createWindow(),error=>error===ready);
    assert.equal(requestedSecrets,0);
    assert.equal(selectedTheme,expected);
    assert.equal(windowOptions.show,true);
  }
});
