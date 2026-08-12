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
  runPnpm(["build"]);
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

function buildElectronTarget(platform, architecture) {
  cleanOutput();
  runPnpm(["build:web"]);
  const target = platform === "darwin" ? "mac" : "linux";
  runPnpm(["exec", "electron-builder", `--${target}`, `--${architecture}`]);
}

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
  buildElectronTarget(process.platform, architecture);
} else {
  throw new Error(`Unsupported release platform: ${process.platform}`);
}

run(process.execPath, [
  path.join(projectRoot, "qa", "verify-release-artifact.cjs"),
  outputRoot,
  verifyPlatform,
  architecture
]);
