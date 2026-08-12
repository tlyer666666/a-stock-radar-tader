"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  ENTRY_EXECUTABLE,
  acquireArtifactLock,
  assertDirectChild,
  copyTree,
  directoryManifest,
  publishVerifiedCopy,
  recoverArtifactOrphans,
  removeTreeBestEffort,
  validateRunnableAppTree,
  verifyEqual,
  writeBuildManifest
} = require("./deploy-formal.cjs");

function buildToken(pid = process.pid, now = Date.now()) {
  return `${now}-${pid}`;
}

function requirePath(target, label, fsImpl = fs) {
  if (!fsImpl.existsSync(target)) throw new Error(`${label} does not exist: ${target}`);
}

function cleanupObsoleteReleaseArtifacts(releaseRoot, outputRoot, warnings, fsImpl = fs) {
  const activeRoot = path.resolve(outputRoot);
  const removed = [];
  for (const entry of fsImpl.readdirSync(releaseRoot, { withFileTypes: true })) {
    const target = path.join(releaseRoot, entry.name);
    if (path.resolve(target) === activeRoot) continue;
    assertDirectChild(releaseRoot, target);
    if (removeTreeBestEffort(target, warnings, fsImpl)) removed.push(entry.name);
  }
  const retained = fsImpl
    .readdirSync(releaseRoot, { withFileTypes: true })
    .map((entry) => path.join(releaseRoot, entry.name))
    .filter((target) => path.resolve(target) !== activeRoot);
  if (retained.length) {
    throw new Error(
      `Obsolete release artifacts could not be removed: ${retained.join(", ")}`
    );
  }
  return removed.sort();
}

function rollbackBuild(options) {
  const {
    outputRoot,
    previousRoot,
    movedPrevious,
    installationStarted,
    validatePrevious,
    fsImpl = fs
  } = options;
  const rollbackErrors = [];
  if (installationStarted && fsImpl.existsSync(outputRoot)) {
    try {
      fsImpl.rmSync(outputRoot, { recursive: true, force: true });
    } catch (error) {
      rollbackErrors.push(`cannot remove incomplete build: ${error?.message || error}`);
    }
  }
  if (movedPrevious && fsImpl.existsSync(previousRoot)) {
    if (fsImpl.existsSync(outputRoot)) {
      rollbackErrors.push(`previous build retained at ${previousRoot}; output path is occupied`);
    } else {
      try {
        fsImpl.renameSync(previousRoot, outputRoot);
        validatePrevious(outputRoot);
      } catch (error) {
        try {
          if (fsImpl.existsSync(outputRoot)) {
            fsImpl.rmSync(outputRoot, { recursive: true, force: true });
          }
          publishVerifiedCopy(previousRoot, outputRoot, { fsImpl });
          validatePrevious(outputRoot);
          try {
            fsImpl.rmSync(previousRoot, { recursive: true, force: true });
          } catch {
            // The active build has already been restored and verified.
          }
        } catch (copyRestoreError) {
          rollbackErrors.push(
            `cannot restore previous build: ${error?.message || error}; ` +
            `verified-copy restore failed: ${copyRestoreError?.message || copyRestoreError}`
          );
        }
      }
    }
  }
  return rollbackErrors;
}

function buildUnpacked(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, ".."));
  const releaseRoot = path.resolve(options.releaseRoot || path.join(projectRoot, "release"));
  const outputRoot = path.resolve(options.outputRoot || path.join(releaseRoot, "win-unpacked"));
  const electronDist = path.resolve(
    options.electronDist || path.join(projectRoot, "node_modules", "electron", "dist")
  );
  const packagePath = path.resolve(options.packagePath || path.join(projectRoot, "package.json"));
  const token = options.token || buildToken(options.pid || process.pid, options.now || Date.now());
  const stageRoot = path.join(releaseRoot, `.win-unpacked-stage-${token}`);
  const previousRoot = path.join(releaseRoot, `.win-unpacked-previous-${token}`);
  const minimumExecutableBytes = options.minimumExecutableBytes ?? 100_000_000;
  const cleanupWarnings = [];

  fsImpl.mkdirSync(releaseRoot, { recursive: true });
  assertDirectChild(releaseRoot, outputRoot);
  assertDirectChild(releaseRoot, stageRoot);
  assertDirectChild(releaseRoot, previousRoot);
  const lock = acquireArtifactLock(projectRoot, {
    fsImpl,
    pid: options.pid,
    now: options.now,
    token: options.lockToken,
    isProcessRunning: options.isProcessRunning
  });

  try {
    requirePath(path.join(electronDist, "electron.exe"), "Electron runtime", fsImpl);
    requirePath(path.join(projectRoot, "dist", "index.html"), "Web production build", fsImpl);
    requirePath(path.join(projectRoot, "electron", "main.cjs"), "Electron main process", fsImpl);
    requirePath(path.join(projectRoot, "electron", "preload.cjs"), "Electron preload", fsImpl);
    requirePath(packagePath, "package.json", fsImpl);
    const packageJson = JSON.parse(fsImpl.readFileSync(packagePath, "utf8"));

    const orphanResult = recoverArtifactOrphans({
      containerRoot: releaseRoot,
      activeRoot: outputRoot,
      stagePrefix: ".win-unpacked-stage-",
      previousPrefix: ".win-unpacked-previous-",
      brokenPrefix: ".win-unpacked-broken-",
      token,
      fsImpl,
      validate: (target) => validateRunnableAppTree(target, {
        fsImpl,
        minimumExecutableBytes,
        requireManifest: false
      })
    });
    cleanupWarnings.push(...orphanResult.warnings);

    fsImpl.mkdirSync(stageRoot, { recursive: true });
    try {
      for (const name of fsImpl.readdirSync(electronDist).sort()) {
        copyTree(path.join(electronDist, name), path.join(stageRoot, name), fsImpl);
      }

      fsImpl.rmSync(path.join(stageRoot, "resources", "default_app.asar"), { force: true });

      const executablePath = path.join(stageRoot, "electron.exe");
      const productExecutablePath = path.join(stageRoot, ENTRY_EXECUTABLE);
      fsImpl.renameSync(executablePath, productExecutablePath);

      const appRoot = path.join(stageRoot, "resources", "app");
      fsImpl.mkdirSync(appRoot, { recursive: true });
      for (const name of ["dist", "electron", "assets"]) {
        const source = path.join(projectRoot, name);
        requirePath(source, name, fsImpl);
        copyTree(source, path.join(appRoot, name), fsImpl);
      }
      fsImpl.copyFileSync(packagePath, path.join(appRoot, "package.json"));

      for (const name of fsImpl.readdirSync(path.join(appRoot, "electron"))) {
        if (
          name.endsWith(".test.cjs") ||
          name === "build-unpacked.cjs" ||
          name === "build-platform.cjs" ||
          name === "deploy-formal.cjs"
        ) {
          fsImpl.rmSync(path.join(appRoot, "electron", name), { force: true });
        }
      }

      writeBuildManifest(stageRoot, packageJson.version, fsImpl);
      validateRunnableAppTree(stageRoot, {
        fsImpl,
        minimumExecutableBytes,
        requireManifest: true
      });
    } catch (error) {
      removeTreeBestEffort(stageRoot, cleanupWarnings, fsImpl);
      throw error;
    }

    let movedPrevious = false;
    let installationStarted = false;
    let installMode = "atomic-rename";
    let installedFileCount = 0;
    try {
      if (fsImpl.existsSync(outputRoot)) {
        try {
          fsImpl.renameSync(outputRoot, previousRoot);
        } catch (renamePreviousError) {
          if (!['EPERM', 'EBUSY', 'EXDEV'].includes(renamePreviousError?.code)) {
            throw renamePreviousError;
          }
          installMode = "verified-copy";
          copyTree(outputRoot, previousRoot, fsImpl);
          verifyEqual(outputRoot, previousRoot, fsImpl);
          validateRunnableAppTree(previousRoot, {
            fsImpl,
            minimumExecutableBytes,
            requireManifest: false
          });
          movedPrevious = true;
          installationStarted = true;
          fsImpl.rmSync(outputRoot, { recursive: true, force: true });
          if (fsImpl.existsSync(outputRoot)) {
            throw new Error(`Unable to clear the previous build after verified backup: ${outputRoot}`);
          }
        }
        movedPrevious = true;
      }
      installationStarted = true;
      try {
        fsImpl.renameSync(stageRoot, outputRoot);
      } catch (renameStageError) {
        if (!['EPERM', 'EBUSY', 'EXDEV'].includes(renameStageError?.code)) {
          throw renameStageError;
        }
        installMode = "verified-copy";
        publishVerifiedCopy(stageRoot, outputRoot, { fsImpl });
      }
      validateRunnableAppTree(outputRoot, {
        fsImpl,
        minimumExecutableBytes,
        requireManifest: true
      });
      installedFileCount = directoryManifest(outputRoot, { fsImpl }).size;
    } catch (error) {
      const rollbackErrors = rollbackBuild({
        outputRoot,
        previousRoot,
        movedPrevious,
        installationStarted,
        fsImpl,
        validatePrevious: (target) => validateRunnableAppTree(target, {
          fsImpl,
          minimumExecutableBytes,
          requireManifest: false
        })
      });
      removeTreeBestEffort(stageRoot, cleanupWarnings, fsImpl);
      if (rollbackErrors.length) {
        const wrapped = new Error(
          `${error?.message || error}; rollback warnings: ${rollbackErrors.join("; ")}`
        );
        wrapped.cause = error;
        wrapped.rollbackErrors = rollbackErrors;
        throw wrapped;
      }
      throw error;
    }

    // The new build is committed. Old-build cleanup is deliberately non-transactional.
    if (movedPrevious) removeTreeBestEffort(previousRoot, cleanupWarnings, fsImpl);
    removeTreeBestEffort(stageRoot, cleanupWarnings, fsImpl);
    const removedObsoleteArtifacts = cleanupObsoleteReleaseArtifacts(
      releaseRoot,
      outputRoot,
      cleanupWarnings,
      fsImpl
    );

    return {
      outputRoot,
      appVersion: String(packageJson.version || ""),
      installMode,
      executableBytes: fsImpl.statSync(path.join(outputRoot, ENTRY_EXECUTABLE)).size,
      runtime: fsImpl.readFileSync(path.join(outputRoot, "version"), "utf8").trim(),
      installedFileCount,
      recoveredPrevious: orphanResult.recoveredPrevious,
      removedObsoleteArtifacts,
      cleanupWarnings
    };
  } finally {
    const lockWarning = lock.release();
    if (lockWarning) process.stderr.write(`${lockWarning}\n`);
  }
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(buildUnpacked(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildUnpacked,
  cleanupObsoleteReleaseArtifacts
};
