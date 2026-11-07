"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");
const test = require("node:test");
const { expectedArtifactName } = require("./verify-release-artifact.cjs");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

test("release artifact names match every native platform", () => {
  assert.equal(
    expectedArtifactName(packageJson.version, "win", "x64"),
    `A-Share-Quant-Radar-v${packageJson.version}-Windows-x64-Portable.zip`
  );
  assert.equal(
    expectedArtifactName(packageJson.version, "mac", "arm64"),
    `A-Share-Quant-Radar-v${packageJson.version}-macOS-arm64.zip`
  );
  assert.equal(
    expectedArtifactName(packageJson.version, "mac", "x64"),
    `A-Share-Quant-Radar-v${packageJson.version}-macOS-x64.zip`
  );
  assert.equal(
    expectedArtifactName(packageJson.version, "linux", "x64"),
    `A-Share-Quant-Radar-v${packageJson.version}-Linux-x86_64.AppImage`
  );
});

test("release workflow uses four native runners and one final publisher", () => {
  const workflow = fs.readFileSync(
    path.join(projectRoot, ".github", "workflows", "release.yml"),
    "utf8"
  );
  for (const runner of ["windows-latest", "macos-15", "macos-15-intel", "ubuntu-latest"]) {
    assert.match(workflow, new RegExp(`runner: ${runner.replaceAll("-", "\\-")}`));
  }
  assert.match(workflow, /group: release-\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(workflow, /build:\s+name: \$\{\{ matrix\.label \}\}\s+needs: verify/);
  assert.match(workflow, /needs: \[verify, build\]/);
  assert.match(workflow, /pnpm verify:release/);
  assert.match(workflow, /--appimage-extract/);
  assert.match(workflow, /Embedded macOS version mismatch/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /gh release create[^\n]*--draft/);
  assert.match(workflow, /gh release edit[^\n]*--draft=false --latest/);
  assert.match(workflow, /Refuse to overwrite an existing release/);
  assert.doesNotMatch(workflow, /gh release upload[^\n]*--clobber/);
});

test("native builder disables implicit publishing and removes update metadata", () => {
  const builder = fs.readFileSync(path.join(projectRoot, "electron", "build-platform.cjs"), "utf8");
  assert.match(builder, /"--publish", "never"/);
  assert.match(builder, /name\.endsWith\("\.blockmap"\)/);
});

const appBuildEntryPoints = [
  "build", "build:app", "build:deploy", "build:trend:mac",
  "dist:platform", "verify:release", "verify:trend:mac",
];

function expandScript(script, seen = new Set()) {
  assert.ok(!seen.has(script), `Script cycle: ${script}`);
  const next = new Set([...seen, script]);
  return packageJson.scripts[script].split(/\s*&&\s*/).flatMap((command) => {
    const nested = command.match(/^pnpm ([\w:-]+)$/)?.[1];
    if (nested && packageJson.scripts[nested]) return expandScript(nested, next);
    if (command === "node electron/build-platform.cjs") {
      // Inspect the platform dispatcher's real runPnpm calls too: the Windows
      // branch used to call the public build script, causing repeated audits.
      const source = ts.createSourceFile("build-platform.cjs", fs.readFileSync(path.join(projectRoot, "electron/build-platform.cjs"), "utf8"), ts.ScriptTarget.Latest, true);
      const descendants = [];
      function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(source) === "runPnpm" && ts.isArrayLiteralExpression(node.arguments[0])) {
          const first = node.arguments[0].elements[0];
          if (first && ts.isStringLiteral(first) && packageJson.scripts[first.text]) descendants.push(...expandScript(first.text, next));
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      return [command, ...descendants];
    }
    return [command];
  });
}

for (const script of appBuildEntryPoints) {
  test(`${script} audits exactly once before packaging`, () => {
    const commands = expandScript(script);
    const audits = commands.map((command, index) => command === "node qa/verify-dependencies.cjs --audit" ? index : -1).filter((index) => index >= 0);
    const builder = commands.findIndex((command) => /(?:build-unpacked|build-platform)\.cjs|electron-builder/.test(command));
    assert.equal(audits.length, 1, `${script} must audit once through its shared chain`);
    assert.ok(builder > audits[0], `${script} packages before dependency security review`);
  });
}

// Run the actual npm-script command strings with only executable boundaries
// replaced. No compiler, network request, user profile or real package is used.
function runWithRejectedAudit(script, t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radar-release-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
  const runner = path.join(root, "fixture-runner.cjs");
  fs.writeFileSync(runner, `const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const [tool,...args]=process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_GATE_EVENTS,JSON.stringify({tool,args})+'\\n');
if(tool==='pnpm') {
  const scripts=require('./package.json').scripts;
  if(!scripts[args[0]]) throw new Error('Unexpected script '+args[0]);
  const result=spawnSync(scripts[args[0]],{shell:true,stdio:'inherit',env:process.env,cwd:__dirname});
  if(result.error) throw result.error;
  process.exit(result.status??99);
}
process.exit(tool==='node'&&args[0]==='qa/verify-dependencies.cjs'&&args.includes('--audit')?23:0);
`);
  // 夹具只替换"可执行文件边界"：发布链里出现的每个工具都要有桩，否则真实 PATH 上
  // 找不到时会被误判成链路失败。1.6.0 起 verify:release 也跑 lint，故补 eslint 桩。
  for (const tool of ["pnpm", "node", "vite", "tsc", "eslint", "electron-builder", "install-electron"]) {
    const executable = path.join(root, tool + (process.platform === "win32" ? ".cmd" : ""));
    const content = process.platform === "win32"
      ? `@"${process.execPath}" "${runner}" "${tool}" %*\r\n`
      : `#!${process.execPath}\nprocess.argv.splice(2,0,${JSON.stringify(tool)});require(${JSON.stringify(runner)});\n`;
    fs.writeFileSync(executable, content, { mode: 0o755 });
  }
  const eventsPath = path.join(root, "events.jsonl");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  const result = spawnSync(packageJson.scripts[script], { shell: true, cwd: root, encoding: "utf8", timeout: 15000, env: { ...process.env, [pathKey]: root + path.delimiter + process.env[pathKey], RELEASE_GATE_EVENTS: eventsPath } });
  assert.ifError(result.error);
  assert.equal(result.status, 23, `${script}: ${result.stderr}`);
  return fs.readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

for (const script of appBuildEntryPoints) {
  test(`${script} stops its real command chain when the audit rejects`, (t) => {
    const events = runWithRejectedAudit(script, t);
    assert.equal(events.filter(({ tool, args }) => tool === "node" && args[0] === "qa/verify-dependencies.cjs" && args.includes("--audit")).length, 1);
    assert.deepEqual(events.filter(({ tool, args }) => tool === "vite" || tool === "electron-builder" || (tool === "node" && /(?:build-unpacked|build-platform|deploy-formal)\.cjs/.test(args[0] || ""))), []);
  });
}

test("web-only builds remain usable offline and fullstack verification includes independent probes", () => {
  for (const script of ["build:web", "build:review"]) assert.equal(expandScript(script).some((command) => command.includes("verify-dependencies")), false);
  assert.ok(expandScript("verify:fullstack").includes("node --test qa/module-polish-independent.test.cjs"));
  assert.ok(expandScript("verify:fullstack").includes("node --test qa/ui-remediation.test.cjs"));
  assert.equal(packageJson.scripts.test.includes("module-polish-independent.test.cjs"), false);
});

test("six-dimension audit regressions stay in the release test gates", () => {
  const unitTests = packageJson.scripts.test.split(/\s+/);
  for (const file of [
    "electron/market-audit.test.cjs",
    "electron/quant-audit-remediation.test.cjs",
    "src/features/paper-simulation/sixAuditPaper.test.cjs",
  ]) assert.ok(unitTests.includes(file), `${file} must run in pnpm test`);
  const uiTests = packageJson.scripts["qa:fullstack:ui"].split(/\s+/);
  assert.ok(uiTests.includes("qa/six-audit-frontend.test.cjs"));
  assert.ok(uiTests.includes("--test-concurrency=1"), "renderer suites must not race separate Vite servers");
});

for (const suite of ['qa:fullstack:ui','qa:modules:independent']) test(`release includes ${suite} before packaging`,()=>{
 const commands=expandScript('verify:release'), suiteCommands=expandScript(suite);
 const gate=commands.indexOf(suiteCommands[0]);const pack=commands.findIndex(x=>/build-unpacked\.cjs|electron-builder/.test(x));
 assert.ok(gate>=0&&gate<pack,`${suite} must run before packaging`);
});
for(const script of ['build','build:app','internal:build:unpacked','build:trend:mac'])test(`${script} compiles the independent review before packaging`,()=>{
 const commands=expandScript(script),review=commands.findIndex(x=>x==='vite build --config review.vite.config.ts');const pack=commands.findIndex(x=>/build-unpacked\.cjs|electron-builder/.test(x));
 assert.ok(review>=0&&review<pack);
});

test('packaged style verification accepts one global stylesheet plus referenced lazy page styles', () => {
  const { verifyStylesheets } = require('./verify-review-build.cjs');
  const content = {
    'dist/index.html': '<link rel="stylesheet" href="./assets/index.css">',
    'dist/assets/index.css': 'body{margin:0}',
    'dist/assets/SectorView.css': '.sector{display:flex}',
    'dist/assets/index.js': 'const pages=["./SectorView.css"];'
  };
  assert.doesNotThrow(() => verifyStylesheets(Object.keys(content), file => content[file]));
  assert.throws(() => verifyStylesheets(Object.keys(content), file => file.endsWith('index.html') ? '<link rel="stylesheet" href="./assets/missing.css">' : content[file]), /stylesheet.*missing|Missing.*stylesheet/i);
  assert.throws(() => verifyStylesheets(Object.keys(content), file => file.endsWith('index.js') ? '' : content[file]), /Unreferenced.*SectorView/);
  assert.throws(() => verifyStylesheets(Object.keys(content), file => file.endsWith('index.html') ? content[file] + '<link rel="stylesheet" href="./assets/SectorView.css">' : content[file]), /one ordered main stylesheet/);
});
