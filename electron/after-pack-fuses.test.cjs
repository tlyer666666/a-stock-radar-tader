"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const fs = require('node:fs');
const os = require('node:os');

test("macOS after-pack fuse changes request an ad-hoc signature reset", async () => {
  const calls = [];
  const originalLoad = Module._load;
  Module._load = function loadWithFuseSpy(request, parent, isMain) {
    if (request === "@electron/fuses") {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        flipFuses: async (...args) => calls.push(args)
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("./after-pack-fuses.cjs")];
  const afterPack = require("./after-pack-fuses.cjs");
  const appOutDir = path.join(path.sep, "tmp", "a-stock-build");
  const productName = "FuseFixture";

  try {
    await afterPack({
      appOutDir,
      electronPlatformName: "darwin",
      packager: { appInfo: { productFilename: productName } }
    });
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve("./after-pack-fuses.cjs")];
  }

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][0],
    path.join(appOutDir, `${productName}.app`, "Contents", "MacOS", productName)
  );
  assert.equal(calls[0][1].resetAdHocDarwinSignature, true);
});

test('macOS packaging preserves vendor locale folders and licenses and removes the sample app', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-runtime-resources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const resources = path.join(root, 'out', 'Fixture.app', 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(path.join(runtime, 'Electron.app/Contents/Resources/zh_CN.lproj'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'Electron.app/Contents/Resources/en.lproj'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'LICENSE'), 'vendor-electron-license');
  fs.writeFileSync(path.join(runtime, 'LICENSES.chromium.html'), 'vendor-chromium-licenses');
  fs.writeFileSync(path.join(resources, 'app.asar'), 'real-application');
  fs.writeFileSync(path.join(resources, 'default_app.asar'), 'sample');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return request === '@electron/fuses' ? { ...actual, flipFuses: async () => {} } : actual;
  };
  delete require.cache[require.resolve('./after-pack-fuses.cjs')];
  try {
    const hook = require('./after-pack-fuses.cjs');
    await hook({ appOutDir: path.join(root, 'out'), electronPlatformName: 'darwin',
      packager: { projectDir: root, config: { electronDist: 'runtime' }, appInfo: { productFilename: 'Fixture' } } });
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('./after-pack-fuses.cjs')];
  }
  assert.equal(fs.statSync(path.join(resources, 'zh_CN.lproj')).isDirectory(), true);
  assert.equal(fs.statSync(path.join(resources, 'en.lproj')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(resources, 'LICENSE.electron.txt'), 'utf8'), 'vendor-electron-license');
  assert.equal(fs.readFileSync(path.join(resources, 'LICENSES.chromium.html'), 'utf8'), 'vendor-chromium-licenses');
  assert.equal(fs.existsSync(path.join(resources, 'default_app.asar')), false);
  assert.equal(fs.readFileSync(path.join(resources, 'app.asar'), 'utf8'), 'real-application');
});
