"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
