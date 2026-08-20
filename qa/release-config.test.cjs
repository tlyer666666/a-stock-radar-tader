"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ENTRY_EXECUTABLE,
  writeBuildManifest
} = require("../electron/deploy-formal.cjs");
const { expectedArtifactName } = require("./verify-release-artifact.cjs");
const { verifyExtractedWindowsRelease } = require("./verify-windows-release-zip.cjs");

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
  assert.match(workflow, /verify-windows-release-zip\.cjs/);
  assert.match(workflow, /packaged-app\.cjs "release-builder\/windows-smoke\/A股雷达\.exe"/);
  assert.match(workflow, /--appimage-extract/);
  assert.match(workflow, /Embedded macOS version mismatch/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /gh release create[^\n]*--draft/);
  assert.match(workflow, /gh release edit[^\n]*--draft=false --latest/);
  assert.match(workflow, /Allow only a recoverable automation draft/);
  assert.match(workflow, /Remove an incomplete automation draft/);
  assert.match(workflow, /gh release delete "\$RELEASE_TAG" --yes/);
  assert.match(workflow, /github-actions\[bot\]/);
  assert.match(workflow, /a-stock-radar-release-workflow/);
  assert.doesNotMatch(workflow, /gh release upload[^\n]*--clobber/);
});

test("release workflow grants write access only to the final publisher", () => {
  const workflow = fs.readFileSync(
    path.join(projectRoot, ".github", "workflows", "release.yml"),
    "utf8"
  );
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.equal((workflow.match(/contents: write/g) || []).length, 1);
  assert.match(
    workflow,
    /publish:\s+name: Publish GitHub Release[\s\S]*?permissions:\s+contents: write/
  );
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 3);
});

test("CI checkouts do not persist credentials and transient build paths stay untracked", () => {
  const qaWorkflow = fs.readFileSync(
    path.join(projectRoot, ".github", "workflows", "qa.yml"),
    "utf8"
  );
  const ignore = fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
  assert.match(qaWorkflow, /actions\/checkout@v4\s+with:\s+persist-credentials: false/);
  assert.match(ignore, /^\.a-stock-artifact\.lock$/m);
  assert.match(ignore, /^tmp\/$/m);
});

test("extracted Windows release verification checks version and the complete manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a-stock-windows-release-"));
  const write = (relative, value) => {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  try {
    write(ENTRY_EXECUTABLE, "fake executable");
    write("resources/app/package.json", JSON.stringify({ version: packageJson.version }));
    write("resources/app/dist/index.html", "<main>release</main>");
    write("resources/app/electron/main.cjs", "// main");
    write("resources/app/electron/preload.cjs", "// preload");
    writeBuildManifest(root, packageJson.version);

    const verified = verifyExtractedWindowsRelease(root, { minimumExecutableBytes: 1 });
    assert.equal(verified.appVersion, packageJson.version);
    assert.equal(verified.executable, path.join(root, ENTRY_EXECUTABLE));
    assert.ok(verified.manifestFileCount >= 5);

    write("resources/app/electron/main.cjs", "// tampered");
    assert.throws(
      () => verifyExtractedWindowsRelease(root, { minimumExecutableBytes: 1 }),
      /Build manifest hash mismatch/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native builder disables implicit publishing and removes update metadata", () => {
  const builder = fs.readFileSync(path.join(projectRoot, "electron", "build-platform.cjs"), "utf8");
  assert.match(builder, /"--publish", "never"/);
  assert.match(builder, /name\.endsWith\("\.blockmap"\)/);
});
