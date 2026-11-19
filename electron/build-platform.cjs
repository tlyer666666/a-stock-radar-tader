"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const outputRoot = path.join(projectRoot, "release-builder");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function runPnpm(args) {
  const pnpmScript = process.env.npm_execpath;
  if (pnpmScript && fs.existsSync(pnpmScript)) {
    run(process.execPath, [pnpmScript, ...args]);
    return;
  }
  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args);
}

function cleanOutput() {
  if (path.dirname(outputRoot) !== projectRoot) {
    throw new Error(`Refusing to clean unexpected release path: ${outputRoot}`);
  }
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildWindowsZip(architecture) {
  // dist:platform already installed and audited dependencies. This private
  // compilation core avoids auditing twice in the same Windows release chain.
  // Invoke the public package script dist:platform for a release build.
  runPnpm(["internal:build:unpacked"]);
  cleanOutput();
  const sourcePattern = path.join(projectRoot, "release", "win-unpacked", "*");
  const artifact = path.join(
    outputRoot,
    `A-Share-Quant-Radar-v${packageJson.version}-Windows-${architecture}-Portable.zip`
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Compress-Archive -Path ${powershellLiteral(sourcePattern)} -DestinationPath ${powershellLiteral(artifact)} -CompressionLevel Optimal`
  ].join("; ");
  run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
}

function planBuildSteps(platform = process.platform, architecture = process.arch, version = packageJson.version) {
  if (!["x64", "arm64"].includes(architecture)) {
    throw new Error(`Unsupported release architecture: ${architecture}`);
  }
  if (platform === "win32") {
    return {
      verifyPlatform: "win",
      steps: ["internal:build:unpacked", "compress-archive"],
      artifactName: `A-Share-Quant-Radar-v${version}-Windows-${architecture}-Portable.zip`
    };
  }
  if (platform === "darwin") {
    return {
      verifyPlatform: "mac",
      builderArgs: ["electron-builder", "--mac", `--${architecture}`, "--dir", "--publish", "never"],
      macDirName: architecture === "x64" ? "mac" : `mac-${architecture}`,
      steps: ["build:web", "build:review", "electron-builder --dir", "codesign", "verifyMacDelivery", "verifyRuntimeFuses", "ditto"],
      artifactName: `A-Share-Quant-Radar-v${version}-macOS-${architecture}.zip`
    };
  }
  if (platform === "linux") {
    return {
      verifyPlatform: "linux",
      builderArgs: ["electron-builder", "--linux", `--${architecture}`, "--publish", "never"],
      steps: ["build:web", "build:review", "electron-builder"],
      artifactName: `A-Share-Quant-Radar-v${version}-Linux-${architecture === "x64" ? "x86_64" : architecture}.AppImage`
    };
  }
  throw new Error(`Unsupported release platform: ${platform}`);
}

async function buildElectronTarget(platform, architecture, deps = {}) {
  const rootDir = deps.rootDir || projectRoot;
  const outDir = deps.outputRoot || (rootDir === projectRoot ? outputRoot : path.join(rootDir, "release-builder"));
  const version = deps.version || packageJson.version;
  const productName = deps.productName || packageJson.build?.productName || "A股雷达";
  const runCmd = deps.run || run;
  const customPnpm = deps.runPnpm;
  const verifyMac = deps.verifyMacDelivery || ((appPath, repoRoot) => {
    const { verifyMacDelivery } = require("../qa/verify-mac-delivery.cjs");
    return verifyMacDelivery(appPath, repoRoot);
  });
  const verifyFuses = deps.verifyRuntimeFuses || ((binaryPath) => {
    const { verifyRuntimeFuses } = require("./build-runtime-fuses.cjs");
    return verifyRuntimeFuses(binaryPath);
  });

  if (outDir === outputRoot && !deps.outputRoot) {
    cleanOutput();
  } else {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
  }
  if (customPnpm) {
    customPnpm(["build:web"]);
    customPnpm(["build:review"]);
  } else {
    runPnpm(["build:web"]);
    runPnpm(["build:review"]);
  }
  if (platform === "darwin") {
    const macBuilderArgs = ["exec", "electron-builder", "--mac", `--${architecture}`, "--dir", "--publish", "never"];
    if (customPnpm) customPnpm(macBuilderArgs);
    else runPnpm(macBuilderArgs);

    const macOutDir = path.join(outDir, architecture === "x64" ? "mac" : `mac-${architecture}`);
    const preferredApp = `${productName}.app`;
    const appEntry = fs.existsSync(path.join(macOutDir, preferredApp))
      ? preferredApp
      : fs.readdirSync(macOutDir).find((name) => name.endsWith(".app"));
    if (!appEntry) {
      throw new Error(`Unable to locate packaged macOS .app inside ${macOutDir}`);
    }
    const appPath = path.join(macOutDir, appEntry);
    runCmd("codesign", ["--force", "--deep", "--sign", "-", appPath]);
    if (fs.existsSync(path.join(rootDir, "qa/verify-mac-delivery.cjs"))) {
      verifyMac(appPath, rootDir);
    }
    const executableName = path.basename(appPath, ".app");
    await verifyFuses(path.join(appPath, "Contents", "MacOS", executableName));

    const zipPath = path.join(outDir, `A-Share-Quant-Radar-v${version}-macOS-${architecture}.zip`);
    fs.rmSync(zipPath, { force: true });
    runCmd("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
  } else {
    const linuxBuilderArgs = ["exec", "electron-builder", "--linux", `--${architecture}`, "--publish", "never"];
    if (customPnpm) customPnpm(linuxBuilderArgs);
    else runPnpm(linuxBuilderArgs);
  }
  for (const name of fs.readdirSync(outDir)) {
    if (name.endsWith(".blockmap")) {
      fs.rmSync(path.join(outDir, name), { force: true });
    }
  }
}

async function main() {
  const architecture = process.arch;
  if (!["x64", "arm64"].includes(architecture)) {
    throw new Error(`Unsupported release architecture: ${architecture}`);
  }

  let verifyPlatform;
  if (process.platform === "win32") {
    verifyPlatform = "win";
    buildWindowsZip(architecture);
  } else if (process.platform === "darwin" || process.platform === "linux") {
    verifyPlatform = process.platform === "darwin" ? "mac" : "linux";
    await buildElectronTarget(process.platform, architecture);
  } else {
    throw new Error(`Unsupported release platform: ${process.platform}`);
  }

  run(process.execPath, [
    path.join(projectRoot, "qa", "verify-release-artifact.cjs"),
    outputRoot,
    verifyPlatform,
    architecture
  ]);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildElectronTarget,
  buildWindowsZip,
  planBuildSteps
};
