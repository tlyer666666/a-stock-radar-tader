"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");

function sha256(file) {
  return require("node:crypto")
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function appResources(appPath) {
  const root = path.resolve(appPath);
  if (path.basename(root) === "app.asar" && fs.existsSync(root)) return path.dirname(root);
  const candidates = [
    path.join(root, "Contents", "Resources"),
    path.join(root, "resources"),
    root
  ];
  const resources = candidates.find(candidate => fs.existsSync(path.join(candidate, "app.asar")));
  if (!resources) throw new Error(`No app.asar found under ${root}`);
  return resources;
}

function loadAsar() {
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  return require(appBuilderRequire.resolve("@electron/asar"));
}

function packagedFile(appPath, relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe packaged path: ${relativePath}`);
  }
  const archive = path.join(appResources(appPath), "app.asar");
  return loadAsar().extractFile(archive, normalized);
}

function readPackagedJson(appPath, relativePath = "package.json") {
  return JSON.parse(packagedFile(appPath, relativePath).toString("utf8"));
}

/** 交付布局有两种：asar（mac/linux）与 unpacked resources/app（Windows）。
 * CI 的产物冒烟检查必须两种都能读，否则 release.yml 只在 Windows 通过。 */
function readPackagedPackageJson(root) {
  const resolved = path.resolve(root);
  try {
    return readPackagedJson(resolved);
  } catch (error) {
    const candidates = [
      path.join(resolved, "resources", "app", "package.json"),
      path.join(resolved, "Contents", "Resources", "app", "package.json")
    ];
    for (const file of candidates) {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    throw new Error(`No packaged package.json found under ${resolved}: ${error.message}`, { cause: error });
  }
}

function verifyProductionFiles(appPath, projectRoot, files) {
  const verified = [];
  for (const source of files) {
    const relative = path.relative(projectRoot, source).split(path.sep).join("/");
    if (!relative || relative.startsWith("../")) throw new Error(`Unsafe production file: ${source}`);
    const packaged = packagedFile(appPath, relative);
    if (sha256(source) !== require("node:crypto").createHash("sha256").update(packaged).digest("hex")) {
      throw new Error(`Packaged source mismatch: ${relative}`);
    }
    verified.push(relative);
  }
  return verified;
}

function verifyPackagedRuntime(appPath, projectRoot, dependencies = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "packaged-runtime.cjs"), path.resolve(appPath)],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      maxBuffer: 1024 * 1024
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Packaged runtime launch failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  let runtime;
  try {
    runtime = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Packaged runtime returned invalid JSON: ${result.stdout.slice(0, 1000)}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  if (runtime.version !== manifest.version) {
    throw new Error(`Packaged version mismatch: expected ${manifest.version}, received ${runtime.version}`);
  }
  const electron = dependencies.electron ?? manifest.devDependencies?.electron;
  if (!electron || runtime.versions?.electron !== electron) {
    throw new Error(`Packaged Electron mismatch: expected ${electron}, received ${runtime.versions?.electron}`);
  }
  const undici = /^(\d+)\.(\d+)\.(\d+)$/.exec(runtime.versions?.undici || "")?.slice(1).map(Number);
  if (
    !undici ||
    undici[0] < 7 ||
    (undici[0] === 7 && (undici[1] < 29 || (undici[1] === 29 && undici[2] < 1)))
  ) {
    throw new Error(`Packaged embedded undici ${runtime.versions?.undici ?? "missing"} is below 7.29.1`);
  }
  return runtime;
}

/**
 * B-02：app bundle 完整性与签名校验。
 *
 * 起因：交付目录里曾出现一个「asar 内容完全正确、但缺 55 个 .lproj locale 目录、
 * 且 Electron Framework 可执行文件缺失」的 zip。原有校验只比对 asar 内部文件哈希，
 * 这类缺陷完全查不出来，用户解压后双击无反应（dyld: Library not loaded）。
 *
 * 这里补上 bundle 层面的结构断言与代码签名验证，让同类问题在交付前就失败。
 */
const REQUIRED_BUNDLE_PATHS = [
  "Contents/Info.plist",
  "Contents/Resources/app.asar",
  "Contents/Frameworks/Electron Framework.framework/Electron Framework",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
];

/** 统计 bundle 内的本地化目录数量。Electron 标准产物应有数十个。 */
function countLocaleDirectories(appPath) {
  const resources = appResources(appPath);
  return fs.readdirSync(resources).filter(name => name.endsWith(".lproj")).length;
}

function verifyAppBundleIntegrity(appPath, options = {}) {
  const root = path.resolve(appPath);
  if (!fs.existsSync(root)) throw new Error(`App bundle not found: ${root}`);

  const missing = REQUIRED_BUNDLE_PATHS.filter(
    relative => !fs.existsSync(path.join(root, relative))
  );
  if (missing.length) {
    throw new Error(`App bundle is incomplete, missing: ${missing.join(", ")}`);
  }

  // Electron Framework 的二进制必须是真实文件或指向 Versions/A 的符号链接。
  // 手工 zip（而非 ditto）会丢掉符号链接，留下一个 0 字节或缺失的目标。
  const framework = path.join(root, "Contents/Frameworks/Electron Framework.framework/Electron Framework");
  const stat = fs.lstatSync(framework);
  const resolved = fs.statSync(framework);
  if (stat.isSymbolicLink() && !fs.existsSync(fs.realpathSync(framework))) {
    throw new Error("Electron Framework symlink is broken");
  }
  if (resolved.size < 1024 * 1024) {
    throw new Error(`Electron Framework binary looks truncated (${resolved.size} bytes)`);
  }

  const locales = countLocaleDirectories(root);
  const minimumLocales = options.minimumLocales ?? 40;
  if (locales < minimumLocales) {
    throw new Error(
      `App bundle has only ${locales} locale directories (expected at least ${minimumLocales}); ` +
      "the archive was likely repacked with zip instead of ditto"
    );
  }

  // macOS 上再验一次真实签名。非 darwin 或未签名环境跳过（ad-hoc 也要求结构完整）。
  if (process.platform === "darwin" && options.verifySignature !== false) {
    const result = spawnSync("codesign", ["--verify", "--deep", "--strict", root], {
      encoding: "utf8",
      timeout: 60_000
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`codesign verification failed: ${(result.stderr || result.stdout || "").trim()}`);
    }
  }

  return { locales, frameworkBytes: resolved.size };
}

module.exports = {
  verifyAppBundleIntegrity,
  countLocaleDirectories,
  appResources,
  packagedFile,
  readPackagedJson,
  readPackagedPackageJson,
  verifyPackagedRuntime,
  verifyProductionFiles
};
