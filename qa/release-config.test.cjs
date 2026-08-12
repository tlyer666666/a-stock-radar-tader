"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { expectedArtifactName } = require("./verify-release-artifact.cjs");

const projectRoot = path.resolve(__dirname, "..");

test("release artifact names match every native platform", () => {
  assert.equal(
    expectedArtifactName("0.9.20", "win", "x64"),
    "A-Share-Quant-Radar-v0.9.20-Windows-x64-Portable.zip"
  );
  assert.equal(
    expectedArtifactName("0.9.20", "mac", "arm64"),
    "A-Share-Quant-Radar-v0.9.20-macOS-arm64.zip"
  );
  assert.equal(
    expectedArtifactName("0.9.20", "mac", "x64"),
    "A-Share-Quant-Radar-v0.9.20-macOS-x64.zip"
  );
  assert.equal(
    expectedArtifactName("0.9.20", "linux", "x64"),
    "A-Share-Quant-Radar-v0.9.20-Linux-x86_64.AppImage"
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
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /gh release upload/);
});

test("native builder disables implicit publishing and removes update metadata", () => {
  const builder = fs.readFileSync(path.join(projectRoot, "electron", "build-platform.cjs"), "utf8");
  assert.match(builder, /"--publish", "never"/);
  assert.match(builder, /name\.endsWith\("\.blockmap"\)/);
});
