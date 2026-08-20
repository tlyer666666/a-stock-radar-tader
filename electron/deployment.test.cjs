"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ARTIFACT_LOCK,
  BUILD_MANIFEST,
  ENTRY_EXECUTABLE,
  acquireArtifactLock,
  deployFormal,
  recoverArtifactOrphans,
  resolveSourceCommit,
  validateBuildManifest,
  validateRunnableAppTree,
  writeBuildManifest
} = require("./deploy-formal.cjs");

test("formal Windows build explicitly installs the Electron runtime", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")
  );
  assert.equal(packageJson.scripts["ensure:electron"], "install-electron");
  assert.match(packageJson.scripts.build, /pnpm ensure:electron/);
  assert.ok(packageJson.build.files.includes("!electron/build-platform.cjs"));
  assert.equal(packageJson.desktopName, "A-Share Quant Radar");
  assert.equal(packageJson.build.linux.syncDesktopName, true);
  const platformBuilder = fs.readFileSync(
    path.resolve(__dirname, "build-platform.cjs"),
    "utf8"
  );
  assert.match(platformBuilder, /"--publish", "never"/);
});
const { buildUnpacked } = require("./build-unpacked.cjs");

function temporaryRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `a-stock-${label}-`));
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function createRunnableTree(root, version, marker, options = {}) {
  write(path.join(root, ENTRY_EXECUTABLE), `entry-${marker}`);
  write(path.join(root, "resources", "helper.exe"), `helper-${marker}`);
  write(
    path.join(root, "resources", "app", "package.json"),
    JSON.stringify({ name: "a-stock-monitor", version })
  );
  write(path.join(root, "resources", "app", "dist", "index.html"), `<p>${marker}</p>`);
  write(path.join(root, "resources", "app", "electron", "main.cjs"), `// main ${marker}`);
  write(path.join(root, "resources", "app", "electron", "preload.cjs"), `// preload ${marker}`);
  write(path.join(root, "resources", "app", "marker.txt"), marker);
  write(path.join(root, "version"), "43.3.0\n");
  if (options.manifest !== false) writeBuildManifest(root, version);
  return root;
}

function createBuildInputs(projectRoot, version = "0.9.13") {
  write(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "a-stock-monitor", version, main: "electron/main.cjs" })
  );
  write(path.join(projectRoot, "dist", "index.html"), "<main>new build</main>");
  write(path.join(projectRoot, "dist", "assets", "index.js"), "console.log('new')");
  write(path.join(projectRoot, "electron", "main.cjs"), "// current main");
  write(path.join(projectRoot, "electron", "preload.cjs"), "// current preload");
  write(path.join(projectRoot, "electron", "runtime-helper.cjs"), "// helper");
  write(path.join(projectRoot, "assets", "icon.png"), "png");
  const electronDist = path.join(projectRoot, "fake-electron-dist");
  write(path.join(electronDist, "electron.exe"), "runtime-entry");
  write(path.join(electronDist, "resources", "helper.exe"), "runtime-helper");
  write(path.join(electronDist, "resources", "default_app.asar"), "unused-default-app");
  write(path.join(electronDist, "version"), "43.3.0\n");
  return electronDist;
}

function proxyFs(overrides) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return overrides[property];
      }
      return Reflect.get(target, property);
    }
  });
}

function appMarker(root) {
  return fs.readFileSync(path.join(root, "resources", "app", "marker.txt"), "utf8");
}

test("build manifests record a deterministic CI source identity", () => {
  const root = temporaryRoot("build-identity");
  try {
    const payload = writeBuildManifest(root, "1.2.3", fs, {
      builtAt: "2026-08-20T09:10:11Z",
      env: {
        GITHUB_SHA: "A".repeat(40),
        CI_COMMIT_SHA: "B".repeat(40)
      },
      execFileSync() {
        throw new Error("git must not run when GITHUB_SHA is valid");
      }
    });
    assert.equal(payload.builtAt, "2026-08-20T09:10:11.000Z");
    assert.equal(payload.sourceCommit, "a".repeat(40));
    assert.equal(payload.buildId, `1.2.3+${"a".repeat(12)}`);
    assert.deepEqual(
      validateBuildManifest(root, fs, { requireBuildIdentity: true }),
      payload
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source identity falls back from CI variables to a safe git lookup and unknown", () => {
  const root = temporaryRoot("source-identity");
  try {
    let gitCalls = 0;
    const fromGit = resolveSourceCommit({
      env: {},
      projectRoot: root,
      execFileSync(command, args, options) {
        gitCalls += 1;
        assert.equal(command, "git");
        assert.deepEqual(args, ["rev-parse", "--verify", "HEAD"]);
        assert.equal(options.cwd, root);
        assert.equal(options.windowsHide, true);
        return `${"c".repeat(40)}\n`;
      }
    });
    assert.equal(fromGit, "c".repeat(40));
    assert.equal(gitCalls, 1);
    assert.equal(
      resolveSourceCommit({
        env: { GITHUB_SHA: "invalid", CI_COMMIT_SHA: "D".repeat(40) },
        execFileSync() {
          throw new Error("git must not run when CI_COMMIT_SHA is valid");
        }
      }),
      "d".repeat(40)
    );
    assert.equal(
      resolveSourceCommit({
        env: {},
        projectRoot: root,
        execFileSync() {
          throw new Error("git unavailable");
        }
      }),
      "unknown"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy manifests remain readable but cannot satisfy a new formal build", () => {
  const root = temporaryRoot("legacy-manifest");
  const manifestPath = path.join(root, BUILD_MANIFEST);
  try {
    const legacy = { schemaVersion: 1, appVersion: "0.9.12", files: {} };
    fs.writeFileSync(manifestPath, `${JSON.stringify(legacy)}\n`, "utf8");
    assert.deepEqual(validateBuildManifest(root), legacy);
    assert.throws(
      () => validateBuildManifest(root, fs, { requireBuildIdentity: true }),
      /identity is required/
    );

    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...legacy, builtAt: 42, sourceCommit: "unknown", buildId: "legacy" })}\n`,
      "utf8"
    );
    assert.throws(() => validateBuildManifest(root), /identity is invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact lock rejects a live concurrent owner and is released safely", () => {
  const root = temporaryRoot("artifact-lock");
  try {
    const first = acquireArtifactLock(root, { token: "first-lock" });
    assert.throws(
      () => acquireArtifactLock(root, { token: "second-lock" }),
      /already running/
    );
    assert.equal(first.release(), "");
    assert.equal(fs.existsSync(path.join(root, ARTIFACT_LOCK)), false);
    const next = acquireArtifactLock(root, { token: "third-lock" });
    assert.equal(next.release(), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("orphan recovery restores a valid previous tree when the active tree is missing", () => {
  const root = temporaryRoot("orphan-recovery");
  try {
    const formalRoot = path.join(root, "程序");
    const previousRoot = createRunnableTree(
      path.join(root, ".formal-previous-crashed"),
      "0.9.12",
      "previous"
    );
    write(path.join(root, ".formal-stage-crashed", "partial.txt"), "partial");
    const result = recoverArtifactOrphans({
      containerRoot: root,
      activeRoot: formalRoot,
      stagePrefix: ".formal-stage-",
      previousPrefix: ".formal-previous-",
      brokenPrefix: ".formal-broken-",
      token: "recovery-test",
      validate: (target) => validateRunnableAppTree(target, {
        minimumExecutableBytes: 1,
        requireManifest: false
      })
    });
    assert.equal(result.recoveredPrevious, previousRoot);
    assert.equal(appMarker(formalRoot), "previous");
    assert.equal(fs.existsSync(path.join(root, ".formal-stage-crashed")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verified-copy publishes non-executables first and the entry executable last", () => {
  const root = temporaryRoot("verified-copy");
  try {
    const sourceRoot = createRunnableTree(
      path.join(root, "release", "win-unpacked"),
      "0.9.13",
      "new"
    );
    const formalRoot = createRunnableTree(path.join(root, "程序"), "0.9.12", "old");
    const stageRoot = path.join(root, ".formal-stage-fallback-test");
    const copiedToFormal = [];
    let forcedFallback = false;
    const fsImpl = proxyFs({
      renameSync(source, destination) {
        if (
          !forcedFallback &&
          path.resolve(source) === path.resolve(stageRoot) &&
          path.resolve(destination) === path.resolve(formalRoot)
        ) {
          forcedFallback = true;
          const error = new Error("simulated rename lock");
          error.code = "EPERM";
          throw error;
        }
        return fs.renameSync(source, destination);
      },
      copyFileSync(source, destination) {
        if (
          path.resolve(source).startsWith(`${path.resolve(stageRoot)}${path.sep}`) &&
          path.resolve(destination).startsWith(`${path.resolve(formalRoot)}${path.sep}`)
        ) {
          copiedToFormal.push(path.relative(stageRoot, source).split(path.sep).join("/"));
        }
        return fs.copyFileSync(source, destination);
      }
    });
    const result = deployFormal({
      projectRoot: root,
      sourceRoot,
      formalRoot,
      token: "fallback-test",
      minimumExecutableBytes: 1,
      assertAppNotRunning() {},
      fsImpl
    });
    assert.equal(result.installMode, "verified-copy");
    assert.equal(appMarker(formalRoot), "new");
    assert.equal(copiedToFormal.at(-1), ENTRY_EXECUTABLE);
    const firstExecutable = copiedToFormal.findIndex((item) => path.extname(item) === ".exe");
    assert.ok(firstExecutable > 0);
    assert.ok(copiedToFormal.slice(0, firstExecutable).every((item) => path.extname(item) !== ".exe"));
    assert.equal(
      fs.readdirSync(formalRoot).some((name) => name.endsWith(".pending")),
      false
    );
    assert.equal(validateBuildManifest(formalRoot).appVersion, "0.9.13");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a post-commit previous cleanup failure never rolls back the verified formal tree", () => {
  const root = temporaryRoot("cleanup-failure");
  try {
    const sourceRoot = createRunnableTree(
      path.join(root, "release", "win-unpacked"),
      "0.9.13",
      "new"
    );
    const formalRoot = createRunnableTree(path.join(root, "程序"), "0.9.12", "old");
    let cleanupFailed = false;
    const fsImpl = proxyFs({
      rmSync(target, options) {
        if (!cleanupFailed && path.basename(target).startsWith(".formal-previous-cleanup-test")) {
          cleanupFailed = true;
          throw new Error("simulated antivirus cleanup failure");
        }
        return fs.rmSync(target, options);
      }
    });
    const result = deployFormal({
      projectRoot: root,
      sourceRoot,
      formalRoot,
      token: "cleanup-test",
      minimumExecutableBytes: 1,
      assertAppNotRunning() {},
      fsImpl
    });
    assert.equal(appMarker(formalRoot), "new");
    assert.equal(result.cleanupWarnings.length, 1);
    assert.match(result.cleanupWarnings[0], /simulated antivirus cleanup failure/);
    assert.equal(
      fs.readdirSync(root).some((name) => name.startsWith(".formal-previous-cleanup-test")),
      true
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("formal deploy falls back to a verified copy when Windows cannot rename the previous directory", () => {
  const root = temporaryRoot("formal-copy-fallback");
  try {
    const sourceRoot = createRunnableTree(
      path.join(root, "release", "win-unpacked"),
      "0.9.14",
      "new"
    );
    const formalRoot = createRunnableTree(path.join(root, "程序"), "0.9.13", "old");
    let injected = false;
    const fsImpl = proxyFs({
      renameSync(source, destination) {
        if (
          !injected &&
          path.resolve(source) === path.resolve(formalRoot) &&
          path.basename(destination).startsWith(".formal-previous-")
        ) {
          injected = true;
          const error = new Error("simulated Windows formal-directory rename lock");
          error.code = "EPERM";
          throw error;
        }
        return fs.renameSync(source, destination);
      }
    });

    const result = deployFormal({
      projectRoot: root,
      sourceRoot,
      formalRoot,
      token: "formal-copy-fallback-test",
      minimumExecutableBytes: 1,
      assertAppNotRunning() {},
      fsImpl
    });

    assert.equal(result.installMode, "verified-copy");
    assert.equal(appMarker(formalRoot), "new");
    assert.equal(validateBuildManifest(formalRoot).appVersion, "0.9.14");
    assert.equal(
      fs.readdirSync(root).some((name) => name.startsWith(".formal-previous-")),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a verified-copy failure before executable publication restores the complete previous version", () => {
  const root = temporaryRoot("verified-copy-rollback");
  try {
    const sourceRoot = createRunnableTree(
      path.join(root, "release", "win-unpacked"),
      "0.9.13",
      "new"
    );
    const formalRoot = createRunnableTree(path.join(root, "程序"), "0.9.12", "old");
    const stageRoot = path.join(root, ".formal-stage-copy-rollback-test");
    let forcedFallback = false;
    let forcedCopyFailure = false;
    const fsImpl = proxyFs({
      renameSync(source, destination) {
        if (
          !forcedFallback &&
          path.resolve(source) === path.resolve(stageRoot) &&
          path.resolve(destination) === path.resolve(formalRoot)
        ) {
          forcedFallback = true;
          const error = new Error("simulated rename lock");
          error.code = "EPERM";
          throw error;
        }
        return fs.renameSync(source, destination);
      },
      copyFileSync(source, destination) {
        if (
          !forcedCopyFailure &&
          path.resolve(source).startsWith(`${path.resolve(stageRoot)}${path.sep}`) &&
          path.resolve(destination).startsWith(`${path.resolve(formalRoot)}${path.sep}`) &&
          path.basename(destination) === "index.html"
        ) {
          forcedCopyFailure = true;
          throw new Error("simulated verified-copy interruption");
        }
        return fs.copyFileSync(source, destination);
      }
    });
    assert.throws(
      () => deployFormal({
        projectRoot: root,
        sourceRoot,
        formalRoot,
        token: "copy-rollback-test",
        minimumExecutableBytes: 1,
        assertAppNotRunning() {},
        fsImpl
      }),
      /simulated verified-copy interruption/
    );
    assert.equal(appMarker(formalRoot), "old");
    assert.equal(
      fs.readdirSync(root).some((name) => name.startsWith(".formal-previous-")),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a staging copy failure preserves the last good unpacked build", () => {
  const root = temporaryRoot("build-preserve");
  try {
    const electronDist = createBuildInputs(root);
    const outputRoot = createRunnableTree(
      path.join(root, "release", "win-unpacked"),
      "0.9.12",
      "last-good"
    );
    const failingSource = path.join(root, "dist", "index.html");
    let injected = false;
    const fsImpl = proxyFs({
      copyFileSync(source, destination) {
        if (!injected && path.resolve(source) === path.resolve(failingSource)) {
          injected = true;
          throw new Error("simulated staging copy failure");
        }
        return fs.copyFileSync(source, destination);
      }
    });
    assert.throws(
      () => buildUnpacked({
        projectRoot: root,
        electronDist,
        minimumExecutableBytes: 1,
        token: "failed-build",
        fsImpl
      }),
      /simulated staging copy failure/
    );
    assert.equal(appMarker(outputRoot), "last-good");
    assert.equal(
      fs.readdirSync(path.join(root, "release")).some((name) =>
        name.startsWith(".win-unpacked-stage-")
      ),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a successful staged build has a complete self-verifying manifest", () => {
  const root = temporaryRoot("build-success");
  try {
    const electronDist = createBuildInputs(root, "0.9.13");
    createRunnableTree(
      path.join(root, "release", "win-unpacked"),
      "0.9.12",
      "old-build"
    );
    write(path.join(root, "release", "builder-debug.yml"), "obsolete metadata");
    write(path.join(root, "release", "A股雷达-old-setup.exe"), "obsolete installer");
    const result = buildUnpacked({
      projectRoot: root,
      electronDist,
      minimumExecutableBytes: 1,
      token: "successful-build",
      now: Date.parse("2026-08-20T10:11:12Z"),
      env: { GITHUB_SHA: "E".repeat(40) }
    });
    assert.equal(result.appVersion, "0.9.13");
    assert.equal(fs.existsSync(path.join(result.outputRoot, BUILD_MANIFEST)), true);
    assert.equal(
      fs.existsSync(path.join(result.outputRoot, "resources", "default_app.asar")),
      false
    );
    const manifest = validateBuildManifest(result.outputRoot, fs, {
      requireBuildIdentity: true
    });
    assert.equal(manifest.appVersion, "0.9.13");
    assert.equal(manifest.builtAt, "2026-08-20T10:11:12.000Z");
    assert.equal(manifest.sourceCommit, "e".repeat(40));
    assert.equal(manifest.buildId, `0.9.13+${"e".repeat(12)}`);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(result.outputRoot, "resources", "app", "package.json"), "utf8")
      ).version,
      "0.9.13"
    );
    assert.deepEqual(result.removedObsoleteArtifacts, [
      "A股雷达-old-setup.exe",
      "builder-debug.yml"
    ]);
    assert.deepEqual(fs.readdirSync(path.join(root, "release")), ["win-unpacked"]);
    assert.equal(fs.existsSync(path.join(root, ARTIFACT_LOCK)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an atomic build publication failure restores the previous complete build", () => {
  const root = temporaryRoot("build-rollback");
  try {
    const electronDist = createBuildInputs(root, "0.9.13");
    const outputRoot = createRunnableTree(
      path.join(root, "release", "win-unpacked"),
      "0.9.12",
      "old-build"
    );
    const stageRoot = path.join(root, "release", ".win-unpacked-stage-build-rollback-test");
    let injected = false;
    const fsImpl = proxyFs({
      renameSync(source, destination) {
        if (
          !injected &&
          path.resolve(source) === path.resolve(stageRoot) &&
          path.resolve(destination) === path.resolve(outputRoot)
        ) {
          injected = true;
          const error = new Error("simulated atomic build publication failure");
          error.code = "EACCES";
          throw error;
        }
        return fs.renameSync(source, destination);
      }
    });
    assert.throws(
      () => buildUnpacked({
        projectRoot: root,
        electronDist,
        minimumExecutableBytes: 1,
        token: "build-rollback-test",
        fsImpl
      }),
      /simulated atomic build publication failure/
    );
    assert.equal(appMarker(outputRoot), "old-build");
    assert.equal(
      fs.readdirSync(path.join(root, "release")).some((name) =>
        name.startsWith(".win-unpacked-previous-")
      ),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("build falls back to a verified copy when Windows cannot rename the previous directory", () => {
  const root = temporaryRoot("build-copy-fallback");
  try {
    const electronDist = createBuildInputs(root, "0.9.14");
    const outputRoot = createRunnableTree(
      path.join(root, "release", "win-unpacked"),
      "0.9.13",
      "old-build"
    );
    let injected = false;
    const fsImpl = proxyFs({
      renameSync(source, destination) {
        if (
          !injected &&
          path.resolve(source) === path.resolve(outputRoot) &&
          path.basename(destination).startsWith(".win-unpacked-previous-")
        ) {
          injected = true;
          const error = new Error("simulated Windows directory rename lock");
          error.code = "EPERM";
          throw error;
        }
        return fs.renameSync(source, destination);
      }
    });

    const result = buildUnpacked({
      projectRoot: root,
      electronDist,
      minimumExecutableBytes: 1,
      token: "copy-fallback-test",
      fsImpl
    });

    assert.equal(result.installMode, "verified-copy");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(outputRoot, "resources", "app", "package.json"), "utf8")).version,
      "0.9.14"
    );
    assert.equal(validateBuildManifest(outputRoot).appVersion, "0.9.14");
    assert.equal(
      fs.readdirSync(path.join(root, "release")).some((name) =>
        name.startsWith(".win-unpacked-previous-")
      ),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the retired v0.6.8 migration is a non-destructive hard-stop stub", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "qa", "migrate-to-d-v068.ps1"), "utf8");
  assert.match(source, /永久停用/);
  assert.match(source, /\bthrow\b/i);
  assert.doesNotMatch(source, /\b(?:Remove-Item|Copy-Item|Move-Item|CreateShortcut)\b/i);
});
