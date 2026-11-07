'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t, failLaunch = false) {
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
  fs.writeFileSync(path.join(target, '当前版本.json'), '{"version":"old"}');
  const filename = path.join(__dirname, 'deploy-single-app.cjs'), realRequire = createRequire(filename);
  const receipt = { version: '1.6.29', consistent: true, artifactConsistent: true,
    outputs: {}, productionFiles: 1, unpackedFiles: 1, recordedInputs: 1, currentInputs: 1, changed: [], missingInReceipt: [] };
  const customRequire = id => {
    if (id === 'node:child_process') return { spawnSync(command, args) {
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
    env: { ...process.env, ASTOCK_APP_DIR: target }, stdout: { write() {} } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: customRequire, __dirname: path.join(repo, 'electron'),
    process: processStub, console, setTimeout, clearTimeout
  }, { filename });
  return { main: module.exports.main, root, repo, target, installed };
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
