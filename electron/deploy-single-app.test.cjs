'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t, options = false) {
  const opts = typeof options === 'boolean' ? { failLaunch: options } : (options || {});
  const failLaunch = Boolean(opts.failLaunch);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-single-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), target = path.join(root, 'target');
  const appName = 'A股雷达趋势版.app';
  const built = path.join(repo, 'release-builder', 'mac-arm64', appName);
  const installed = path.join(target, appName);
  for (const [app, marker] of [[built, 'new'], [installed, 'old']]) {
    for (const [file, value] of [['Contents/Resources/app.asar', marker], ['Contents/MacOS/A股雷达趋势版', marker]]) {
      fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
      fs.writeFileSync(path.join(app, file), value);
    }
  }
  fs.mkdirSync(path.join(repo, 'dist'));
  fs.mkdirSync(path.join(target, '升级备份'));
  fs.writeFileSync(path.join(target, '升级备份', 'existing'), 'preserve');
  fs.writeFileSync(path.join(target, '当前版本.json'), opts.initialMeta || '{"version":"old"}');
  const filename = path.join(__dirname, 'deploy-single-app.cjs'), realRequire = createRequire(filename);
  const receipt = { version: '1.6.29', consistent: true, artifactConsistent: true,
    outputs: {}, productionFiles: 1, unpackedFiles: 1, recordedInputs: 1, currentInputs: 1, changed: [], missingInReceipt: [] };
  const psCalls = [];
  const customRequire = id => {
    if (id === 'node:child_process') return { spawnSync(command, args) {
      if (command === 'ps') {
        psCalls.push(args);
        const stdout = typeof opts.psOutput === 'function' ? opts.psOutput(args) : '';
        return { status: 0, stdout };
      }
      if (command === 'git' && typeof opts.gitOutput === 'function') return opts.gitOutput(args);
      if (command === '/usr/bin/ditto') fs.cpSync(args[0], args[1], { recursive: true });
      if (command === '/usr/libexec/PlistBuddy') return { status: 0, stdout: '1.6.29\n' };
      if (command === '/usr/bin/open' && failLaunch) return { status: 1 };
      return { status: 0, stdout: '' };
    } };
    if (id === '../package.json') return { version: '1.6.29' };
    if (id === '../qa/delivery-verification.cjs') return { verifyAppBundleIntegrity: () => ({ passed: true }) };
    // These fixtures contain marker bytes and exercise atomic publication only.
    // Actual plist, asar integrity and signatures use the separate native gate.
    if (id === '../qa/verify-mac-delivery.cjs') return { verifyMacDelivery: () => ({ passed: true }) };
    if (id === '../qa/build-artifact-verification.cjs') return { verifyBuildArtifact: () => receipt };
    if (id === './deploy-formal.cjs') return { acquireArtifactLock: () => ({ release: () => null }) };
    // 夹具里的可执行文件是标记字节，熔断位核验由 build-runtime-fuses 自己的测试覆盖。
    if (id === './build-runtime-fuses.cjs') return { verifyRuntimeFuses: async () => ({ passed: true, disabled: 3 }) };
    return realRequire(id);
  };
  const module = { exports: {} };
  const processStub = { ...process, argv: ['node', filename, '--from-build'],
    env: { ...process.env, ASTOCK_RELEASE_GATE: '', ...(opts.env || {}), ASTOCK_APP_DIR: target }, stdout: { write() {} },
    ...(opts.kill ? { kill: opts.kill } : {}) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: customRequire, __dirname: path.join(repo, 'electron'),
    process: processStub, console, setTimeout, clearTimeout
  }, { filename });
  return { main: module.exports.main, pidsUsingExecutable: module.exports.pidsUsingExecutable, psCalls, root, repo, target, installed };
}

test('successful single-app installation removes only its temporary rollback copy and preserves existing backups', async t => {
  const f = fixture(t);
  await f.main();
  assert.equal(fs.readFileSync(path.join(f.installed, 'Contents/Resources/app.asar'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(path.join(f.target, '升级备份')), ['existing']);
  assert.equal(fs.readFileSync(path.join(f.target, '升级备份', 'existing'), 'utf8'), 'preserve');
  assert.equal(fs.readdirSync(f.target).some(name => /\.(?:previous|rejected)$|\.staging\.app$/.test(name)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, '当前版本.json'))).version, '1.6.29');
  assert.equal(fs.existsSync(path.join(f.repo, 'release-builder')), false);
});

test('failed launch restores the original app and metadata before removing the rejected copy', async t => {
  const f = fixture(t, true);
  await assert.rejects(f.main(), /已恢复部署前/);
  assert.equal(fs.readFileSync(path.join(f.installed, 'Contents/Resources/app.asar'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(f.target, '当前版本.json'), 'utf8'), '{"version":"old"}');
  assert.deepEqual(fs.readdirSync(path.join(f.target, '升级备份')), ['existing']);
  assert.equal(fs.readdirSync(f.target).some(name => /\.(?:previous|rejected)$|\.staging\.app$/.test(name)), false);
});

test('pidsUsingExecutable matches only the target executable path and excludes self/ppid and argument-only processes', async t => {
  const killed = [];
  let appRunning = true;
  let exePath;
  const f = fixture(t, {
    psOutput: () => [
      `${process.pid} ${exePath}`,
      `${process.ppid} ${exePath}`,
      `91001 /bin/zsh -c "${exePath}"`,
      `91002 /usr/bin/open ${exePath}`,
      `91003 ${exePath} Helper`,
      `91004 /other/place/A股雷达趋势版.app/Contents/MacOS/A股雷达趋势版`,
      ...(appRunning ? [`91005 ${exePath}`] : [])
    ].join('\n'),
    kill: (pid, signal) => {
      killed.push({ pid, signal });
      if (pid === 91005) appRunning = false;
    }
  });
  exePath = path.join(f.installed, 'Contents/MacOS/A股雷达趋势版');
  assert.deepEqual([...f.pidsUsingExecutable(exePath)], [91005]);
  assert.deepEqual([...f.psCalls[0]], ['-axo', 'pid=,comm=']);

  // Also verify via symlink / non-normalized path
  const linkApp = path.join(f.root, 'link.app');
  fs.symlinkSync(f.installed, linkApp);
  assert.deepEqual([...f.pidsUsingExecutable(path.join(linkApp, 'Contents', 'MacOS', '.', 'A股雷达趋势版'))], [91005]);

  await f.main();
  assert.deepEqual(killed, [{ pid: 91005, signal: 'SIGTERM' }]);
});

test('version metadata records the release gate truthfully instead of claiming tests passed', async t => {
  const ungated = fixture(t);
  await ungated.main();
  const plain = JSON.parse(fs.readFileSync(path.join(ungated.target, '当前版本.json')));
  assert.match(plain.verification.unitTests, /未运行/);
  assert.doesNotMatch(plain.verification.unitTests, /已通过/);
  const gated = fixture(t, { env: { ASTOCK_RELEASE_GATE: 'typecheck,lint,test' } });
  await gated.main();
  const meta = JSON.parse(fs.readFileSync(path.join(gated.target, '当前版本.json')));
  assert.match(meta.verification.unitTests, /^已通过（本次部署前运行：类型检查、lint、全量单测/);
});

test('H9: workingTreeClean, dirtyFiles and -dirty provenance are computed from real git status rather than inherited', async t => {
  const dirty = fixture(t, {
    initialMeta: JSON.stringify({ version: '1.6.28', workingTreeClean: true }),
    gitOutput: args => {
      if (args.includes('status')) return { status: 0, stdout: ' M electron/main.cjs\n?? src/new.ts\n' };
      if (args.includes('--short')) return { status: 0, stdout: '17b8059\n' };
      if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'main\n' };
      return { status: 0, stdout: '' };
    }
  });
  await dirty.main();
  const dirtyMeta = JSON.parse(fs.readFileSync(path.join(dirty.target, '当前版本.json'), 'utf8'));
  assert.equal(dirtyMeta.workingTreeClean, false, 'stale workingTreeClean: true must be overwritten');
  assert.equal(dirtyMeta.sourceCommit, '17b8059-dirty');
  assert.equal(dirtyMeta.source.commit, '17b8059-dirty');
  assert.equal(dirtyMeta.source.dirtyFiles, 2);
  assert.match(dirtyMeta.notes['1.6.29'], /17b8059-dirty/);

  const clean = fixture(t, {
    initialMeta: JSON.stringify({ version: '1.6.28', workingTreeClean: false }),
    gitOutput: args => {
      if (args.includes('status')) return { status: 0, stdout: '?? .a-stock-artifact.lock\n' };
      if (args.includes('--short')) return { status: 0, stdout: 'abcdef1\n' };
      if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'main\n' };
      return { status: 0, stdout: '' };
    }
  });
  await clean.main();
  const cleanMeta = JSON.parse(fs.readFileSync(path.join(clean.target, '当前版本.json'), 'utf8'));
  assert.equal(cleanMeta.workingTreeClean, true);
  assert.equal(cleanMeta.sourceCommit, 'abcdef1');
  assert.equal(cleanMeta.source.commit, 'abcdef1');
  assert.equal(cleanMeta.source.dirtyFiles, undefined);
  assert.doesNotMatch(cleanMeta.notes['1.6.29'], /-dirty/);
});
