"use strict";
// Execute actual main-process normalization/IPC callbacks in isolation. Electron
// startup and all network modules are intentionally not evaluated.
//
// Which functions get evaluated is derived, not hand-listed: we start from the
// identifiers referenced by the registered IPC callbacks (plus the accessors this
// harness hands back) and transitively include every function declaration they can
// reach. Adding a helper to main.cjs therefore no longer requires editing this file,
// which is exactly how the previous fixed name list broke.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const ts = require("typescript");
const repo = path.resolve(__dirname, "..");
const persistence = require(path.join(repo, "electron/persistence.cjs"));
const policy = require(path.join(repo, "electron/security-policy.cjs"));

const CHANNELS = ["watchlist:get","watchlist:save","holdings:get","holdings:save","settings:get","settings:save","review:get-market"];
// Handed back to the caller, so they must be evaluated even if no callback uses them.
const EXPOSED = ["normalizeSettings"];
// The isolated context supplies these itself; emitting a declaration would shadow it.
const CONTEXT_PROVIDED = new Set(["debugLog","runtimeErrorLog","resetNewsCache","getProfessionalReview","resetProfessionalReviewCache","applyWindowTheme","reviewWindows","handleTrustedIpc"]);

/** Every function declaration in the source, in source order. */
function collectDeclarations(ast) {
  const declarations = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.push({ name: node.name.text, text: node.getText(ast) });
    ts.forEachChild(node, visit);
  })(ast);
  return declarations;
}

/** Identifiers referenced anywhere inside the given source fragments. */
function referencedNames(fragments) {
  const names = new Set();
  for (const fragment of fragments) {
    const parsed = ts.createSourceFile("fragment.js", fragment, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    (function visit(node) {
      if (ts.isIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, visit);
    })(parsed);
  }
  return names;
}

/** Transitive closure over the declarations reachable from `roots`, emitted in source order. */
function closureDeclarations(declarations, roots) {
  const byName = new Map();
  for (const entry of declarations) {
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push(entry.text);
  }
  const included = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop();
    if (included.has(name) || !byName.has(name) || CONTEXT_PROVIDED.has(name)) continue;
    included.add(name);
    for (const referenced of referencedNames(byName.get(name))) {
      if (!included.has(referenced) && byName.has(referenced)) queue.push(referenced);
    }
  }
  return { included, texts: declarations.filter((entry) => included.has(entry.name)).map((entry) => entry.text) };
}

function createHarness(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "astock-v141-isolated-"));
  const source = fs.readFileSync(path.join(repo, "electron/main.cjs"), "utf8");
  const ast = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = collectDeclarations(ast);

  const registrations = [];
  (function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast)==="handleTrustedIpc" && ts.isStringLiteral(node.arguments[0]) && CHANNELS.includes(node.arguments[0].text)) registrations.push(node.getText(ast)+";");
    ts.forEachChild(node,visit);
  })(ast);

  const { included, texts: functions } = closureDeclarations(declarations, referencedNames([...registrations, ...EXPOSED]));
  for (const name of EXPOSED) {
    if (!included.has(name)) throw new Error(`main-process harness: ${name} was not reachable from the registered IPC callbacks`);
  }

  const handlers = new Map(), logs = [];
  const mainFrame = {id:"isolated-main",url:"file:///isolated-app/dist/index.html"};
  const contents = {mainFrame,isDestroyed:()=>false};
  const context = {
    fs,path,...persistence,...policy,
    app:{getPath:name=>{if(name!=="userData")throw Error("Only isolated userData is allowed");return directory;}},
    // Use an isolated fake secure store. The test must never touch the OS keychain.
    localSecretStorage:{isEncryptionAvailable:()=>options.secureStoreAvailable !== false,encryptString:value=>Buffer.from(`ISOLATED:${value}`),decryptString:value=>value.toString().replace(/^ISOLATED:/,"")},
    createLocalSecretStorage:()=>{throw Error("isolated harness must use the provided local secret storage");},
    SECRET_SETTING_KEYS:["refreshToken","tushareToken","fuyaoApiKey","aiApiKey"],
    debugLog:()=>{},runtimeErrorLog:(...args)=>logs.push(args),resetNewsCache:()=>{},
    getProfessionalReview: options.getProfessionalReview,
    resetProfessionalReviewCache: options.resetProfessionalReviewCache || (()=>{}),applyWindowTheme:()=>{},
    reviewWindows:{ getWebContents:()=>undefined, broadcastTheme:()=>false, open:()=>Promise.resolve({ ok: true }) },
    handleTrustedIpc:(channel,handler)=>handlers.set(channel,policy.createTrustedIpcHandler(handler,()=>contents,channel,mainFrame.url))
  };
  vm.runInNewContext([...functions,...registrations].join("\n"),context,{filename:"isolated-main-excerpts.cjs"});
  return {directory, logs, normalizeSettings:context.normalizeSettings, invoke:(channel,...args)=>handlers.get(channel)({sender:contents,senderFrame:mainFrame},...args),
    json:name=>JSON.parse(fs.readFileSync(path.join(directory,`${name}.json`),"utf8")),
    cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
module.exports = {createHarness};
