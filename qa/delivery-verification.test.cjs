"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRequire } = require("node:module");
const {
  appResources,
  packagedFile,
  readPackagedJson,
  verifyProductionFiles
} = require("./delivery-verification.cjs");

async function createAsarFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radar-delivery-asar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const resources = path.join(root, "Fixture.app", "Contents", "Resources");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(source, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const asar = require(appBuilderRequire.resolve("@electron/asar"));
  const archive = path.join(resources, "app.asar");
  await asar.createPackage(source, archive);
  // createPackage 偶尔在文件内容落盘前就返回（Linux CI 上读到过全空白的内容），等到能读回首个文件再继续。
  const [firstName, firstValue] = Object.entries(files)[0];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if (asar.extractFile(archive, firstName).toString() === String(firstValue)) break; } catch { /* 还没写完 */ }
    asar.uncacheAll?.();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { root, source, resources };
}

test("ASAR helpers read packaged JSON and source files from macOS resources", async t => {
  const fixture = await createAsarFixture(t, {
    "package.json": JSON.stringify({ version: "1.5.4" }),
    "dist/index.html": "<main>packaged</main>",
    "electron/main.cjs": "'use strict';\n"
  });
  const app = path.join(fixture.root, "Fixture.app");
  assert.equal(appResources(app), fixture.resources);
  assert.deepEqual(readPackagedJson(app), { version: "1.5.4" });
  assert.equal(packagedFile(app, "dist/index.html").toString(), "<main>packaged</main>");
  assert.deepEqual(
    verifyProductionFiles(app, fixture.source, [
      path.join(fixture.source, "package.json"),
      path.join(fixture.source, "dist", "index.html")
    ]),
    ["package.json", "dist/index.html"]
  );
});

test("ASAR helpers also accept an explicit app.asar and reject traversal", async t => {
  const fixture = await createAsarFixture(t, {
    "package.json": JSON.stringify({ version: "1.5.4" }),
    "dist/index.html": "packaged"
  });
  const archive = path.join(fixture.resources, "app.asar");
  assert.equal(appResources(archive), fixture.resources);
  assert.equal(packagedFile(archive, "/package.json").length > 0, true);
  assert.throws(() => packagedFile(archive, "../package.json"), /Unsafe packaged path/);
  assert.throws(
    () => verifyProductionFiles(path.join(fixture.root, "Fixture.app"), fixture.source, [
      path.join(fixture.root, "outside.txt")
    ]),
    /Unsafe production file/
  );
});

// B-02 回归：app bundle 完整性与签名校验。
// 交付目录里曾出现「asar 正确但缺 locale 目录、缺 Framework 可执行文件」的 zip，
// 用户解压后无法启动，而原有校验（只比对 asar 内文件哈希）查不出来。
test("verifyAppBundleIntegrity rejects bundles that would not launch", async t => {
  const { verifyAppBundleIntegrity } = require("./delivery-verification.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radar-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bundle = path.join(root, "Fixture.app");
  const resources = path.join(bundle, "Contents", "Resources");
  const frameworkDir = path.join(bundle, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A");
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(frameworkDir, { recursive: true });
  fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), "<plist/>");
  fs.writeFileSync(path.join(resources, "app.asar"), "asar");
  // 真实大小的假二进制，避免触发截断判定
  fs.writeFileSync(path.join(frameworkDir, "Electron Framework"), Buffer.alloc(2 * 1024 * 1024));
  // Framework 根目录的入口是符号链接（ditto 会保留，手工 zip 会丢）
  fs.symlinkSync("Versions/A/Electron Framework", path.join(bundle, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"));
  for (const name of ["en", "zh_CN", "ja", "fr", "de"]) {
    fs.mkdirSync(path.join(resources, `${name}.lproj`), { recursive: true });
  }

  // 只有 5 个 locale —— 正是「用 zip 重打」的典型症状
  assert.throws(
    () => verifyAppBundleIntegrity(bundle, { verifySignature: false }),
    /locale directories/,
    "缺少本地化目录必须被拒绝"
  );

  // 补齐 locale 后应通过结构校验
  for (let i = 0; i < 45; i += 1) {
    fs.mkdirSync(path.join(resources, `loc${i}.lproj`), { recursive: true });
  }
  const ok = verifyAppBundleIntegrity(bundle, { verifySignature: false });
  assert.ok(ok.locales >= 40);
  assert.ok(ok.frameworkBytes > 1024 * 1024);

  // 删掉 Framework 可执行文件后必须失败（这就是残缺包的真实形态）
  fs.rmSync(path.join(frameworkDir, "Electron Framework"));
  assert.throws(
    () => verifyAppBundleIntegrity(bundle, { verifySignature: false }),
    /incomplete|missing/i
  );
});
