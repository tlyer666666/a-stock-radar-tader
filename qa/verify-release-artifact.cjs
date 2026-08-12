"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionByPlatform = Object.freeze({ win: ".zip", mac: ".zip", linux: ".AppImage" });
const platformLabels = Object.freeze({ win: "Windows", mac: "macOS", linux: "Linux" });

function expectedArtifactName(version, platform, architecture) {
  const platformLabel = platformLabels[platform];
  const extension = extensionByPlatform[platform];
  assert.ok(platformLabel && extension, `Unsupported release platform: ${platform}`);
  assert.ok(["x64", "arm64"].includes(architecture), `Unsupported release architecture: ${architecture}`);
  const publicArchitecture = platform === "linux" && architecture === "x64"
    ? "x86_64"
    : architecture;
  return `A-Share-Quant-Radar-v${version}-${platformLabel}-${publicArchitecture}` +
    `${platform === "win" ? "-Portable" : ""}${extension}`;
}

function verifyArtifact(outputArgument, platform, architecture) {
  const outputRoot = path.resolve(outputArgument);
  assert.ok(fs.existsSync(outputRoot), `Release output does not exist: ${outputRoot}`);

  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")
  );
  const expectedName = expectedArtifactName(packageJson.version, platform, architecture);
  const artifactPath = path.join(outputRoot, expectedName);

  assert.ok(fs.existsSync(artifactPath), `Expected release artifact is missing: ${expectedName}`);
  const bytes = fs.statSync(artifactPath).size;
  assert.ok(bytes >= 50_000_000, `Release artifact is unexpectedly small: ${bytes} bytes`);

  const matchingArtifacts = fs.readdirSync(outputRoot).filter((name) =>
    name.startsWith("A-Share-Quant-Radar-")
  );
  assert.deepEqual(matchingArtifacts, [expectedName], "Release output contains unexpected public artifacts");
  return { artifact: expectedName, bytes };
}

if (require.main === module) {
  const [outputArgument = "release-builder", platform = "", architecture = ""] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(verifyArtifact(outputArgument, platform, architecture))}\n`);
}

module.exports = { expectedArtifactName, verifyArtifact };
