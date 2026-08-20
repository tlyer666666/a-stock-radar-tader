"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  ENTRY_EXECUTABLE,
  assertDirectChild,
  validateRunnableAppTree
} = require("../electron/deploy-formal.cjs");
const { expectedArtifactName } = require("./verify-release-artifact.cjs");

const projectRoot = path.resolve(__dirname, "..");
const projectPackage = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
);

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(script) {
  for (const command of ["pwsh.exe", "powershell.exe"]) {
    const result = spawnSync(
      command,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { cwd: projectRoot, encoding: "utf8", windowsHide: true }
    );
    if (result.error?.code === "ENOENT") continue;
    return result;
  }
  throw new Error("PowerShell is required to inspect the Windows release ZIP");
}

function verifyExtractedWindowsRelease(extractRoot, options = {}) {
  const absoluteRoot = path.resolve(extractRoot);
  const expectedVersion = String(options.expectedVersion ?? projectPackage.version ?? "");
  const result = validateRunnableAppTree(absoluteRoot, {
    minimumExecutableBytes: options.minimumExecutableBytes ?? 100_000_000,
    requireManifest: true
  });
  assert.equal(
    result.version,
    expectedVersion,
    `Embedded Windows package version mismatch: ${result.version} != ${expectedVersion}`
  );
  return {
    extractRoot: absoluteRoot,
    executable: path.join(absoluteRoot, ENTRY_EXECUTABLE),
    appVersion: result.version,
    executableBytes: result.executableBytes,
    manifestFileCount: Object.keys(result.manifest?.files || {}).length
  };
}

function extractAndVerifyWindowsRelease(outputArgument = "release-builder", architecture = "x64") {
  const outputRoot = path.resolve(outputArgument);
  assert.ok(fs.existsSync(outputRoot), `Release output does not exist: ${outputRoot}`);
  const artifactName = expectedArtifactName(
    String(projectPackage.version || ""),
    "win",
    architecture
  );
  const archivePath = path.join(outputRoot, artifactName);
  assert.ok(fs.existsSync(archivePath), `Windows release ZIP does not exist: ${archivePath}`);

  const extractRoot = path.join(outputRoot, "windows-smoke");
  assertDirectChild(outputRoot, extractRoot);
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Expand-Archive -LiteralPath ${powershellLiteral(archivePath)} ` +
      `-DestinationPath ${powershellLiteral(extractRoot)} -Force`
  ].join("; ");
  const extraction = runPowerShell(script);
  if (extraction.error) throw extraction.error;
  if (extraction.status !== 0) {
    throw new Error(
      `Unable to extract Windows release ZIP: ${extraction.stderr || extraction.stdout || extraction.status}`
    );
  }

  return {
    archive: archivePath,
    ...verifyExtractedWindowsRelease(extractRoot)
  };
}

if (require.main === module) {
  try {
    const [outputArgument = "release-builder", architecture = "x64"] = process.argv.slice(2);
    process.stdout.write(
      `${JSON.stringify(extractAndVerifyWindowsRelease(outputArgument, architecture), null, 2)}\n`
    );
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  extractAndVerifyWindowsRelease,
  verifyExtractedWindowsRelease
};
