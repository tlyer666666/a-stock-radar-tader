"use strict";
// Execute actual main-process normalization/IPC callbacks in isolation. Electron
// startup and all network modules are intentionally not evaluated.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const ts = require("typescript");
const repo = path.resolve(__dirname, "..");
const persistence = require(path.join(repo, "electron/persistence.cjs"));
const policy = require(path.join(repo, "electron/security-policy.cjs"));
function createHarness(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "astock-v141-isolated-"));
  const source = fs.readFileSync(path.join(repo, "electron/main.cjs"), "utf8");
  const ast = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(["jsonPath","backupJsonPath","readJson","writeJson","writeSettings","isSettingsRecord","normalizeHoldings","normalizeWatchlist","usableHoldings","usableWatchlist","clampNumber","defaultSettings","normalizeSettings","encryptSecret","decryptSecret","loadStoredSettings","settingsForService","publicSettings"]);
  const channels = new Set(["watchlist:get","watchlist:save","holdings:get","holdings:save","settings:get","settings:save","review:get-market"]);
  const functions = [], registrations = [], handlers = new Map(), logs = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) functions.push(node.getText(ast));
    if (ts.isCallExpression(node) && node.expression.getText(ast)==="handleTrustedIpc" && ts.isStringLiteral(node.arguments[0]) && channels.has(node.arguments[0].text)) registrations.push(node.getText(ast)+";");
    ts.forEachChild(node,visit);
  }
  visit(ast);
  const mainFrame = {id:"isolated-main"};
  const contents = {mainFrame,isDestroyed:()=>false};
  const context = {
    fs,path,...persistence,...policy,
    app:{getPath:name=>{if(name!=="userData")throw Error("Only isolated userData is allowed");return directory;}},
    safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(`ISOLATED:${value}`),decryptString:value=>value.toString().replace(/^ISOLATED:/,"")},
    SECRET_SETTING_KEYS:["refreshToken","tushareToken"],
    debugLog:()=>{},runtimeErrorLog:(...args)=>logs.push(args),resetNewsCache:()=>{},
    getProfessionalReview: options.getProfessionalReview,
    resetProfessionalReviewCache: options.resetProfessionalReviewCache || (()=>{}),applyWindowTheme:()=>{},
    handleTrustedIpc:(channel,handler)=>handlers.set(channel,policy.createTrustedIpcHandler(handler,()=>contents))
  };
  vm.runInNewContext([...functions,...registrations].join("\n"),context,{filename:"isolated-main-excerpts.cjs"});
  return {directory, logs, normalizeSettings:context.normalizeSettings, invoke:(channel,...args)=>handlers.get(channel)({sender:contents,senderFrame:mainFrame},...args),
    json:name=>JSON.parse(fs.readFileSync(path.join(directory,`${name}.json`),"utf8")),
    cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
module.exports = {createHarness};
