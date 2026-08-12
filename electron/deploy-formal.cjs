"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ENTRY_EXECUTABLE = "A股雷达.exe";
const BUILD_MANIFEST = ".a-stock-build-manifest.json";
const ARTIFACT_LOCK = ".a-stock-artifact.lock";
const LOCK_STALE_MS = 30 * 60 * 1000;

function uniqueToken(pid = process.pid, now = Date.now()) {
  return `${now}-${pid}-${crypto.randomBytes(6).toString("hex")}`;
}

function assertDirectChild(parent, target) {
  if (path.dirname(target) !== parent) {
    throw new Error(`Refusing to replace a path outside ${parent}: ${target}`);
  }
}

function requirePath(target, label, fsImpl = fs) {
  if (!fsImpl.existsSync(target)) throw new Error(`${label} does not exist: ${target}`);
}

function copyTree(source, destination, fsImpl = fs) {
  const stat = fsImpl.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to package a symbolic link: ${source}`);
  }
  if (stat.isDirectory()) {
    fsImpl.mkdirSync(destination, { recursive: true });
    for (const name of fsImpl.readdirSync(source).sort()) {
      copyTree(path.join(source, name), path.join(destination, name), fsImpl);
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported artifact entry: ${source}`);
  fsImpl.mkdirSync(path.dirname(destination), { recursive: true });
  fsImpl.copyFileSync(source, destination);
}

function hashFile(file, fsImpl = fs) {
  const hash = crypto.createHash("sha256");
  const handle = fsImpl.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fsImpl.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fsImpl.closeSync(handle);
  }
  return hash.digest("hex");
}

function directoryManifest(root, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const excluded = new Set(
    (options.exclude || []).map((item) => String(item).split(path.sep).join("/"))
  );
  const manifest = new Map();
  const visit = (directory) => {
    for (const entry of fsImpl
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to verify a symbolic link: ${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (excluded.has(relative)) continue;
        manifest.set(relative, `${fsImpl.statSync(absolute).size}:${hashFile(absolute, fsImpl)}`);
      }
    }
  };
  visit(root);
  return manifest;
}

function compareManifests(sourceManifest, destinationManifest, label = "Artifact") {
  if (sourceManifest.size !== destinationManifest.size) {
    throw new Error(
      `${label} file count mismatch: ${sourceManifest.size} != ${destinationManifest.size}`
    );
  }
  for (const [relative, signature] of sourceManifest) {
    if (destinationManifest.get(relative) !== signature) {
      throw new Error(`${label} hash mismatch: ${relative}`);
    }
  }
  return sourceManifest.size;
}

function verifyEqual(source, destination, fsImpl = fs) {
  return compareManifests(
    directoryManifest(source, { fsImpl }),
    directoryManifest(destination, { fsImpl }),
    "Formal deployment"
  );
}

function writeBuildManifest(root, appVersion, fsImpl = fs) {
  const manifestPath = path.join(root, BUILD_MANIFEST);
  const files = Object.fromEntries(
    directoryManifest(root, { fsImpl, exclude: [BUILD_MANIFEST] })
  );
  const payload = {
    schemaVersion: 1,
    appVersion: String(appVersion || ""),
    files
  };
  fsImpl.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function validateBuildManifest(root, fsImpl = fs) {
  const manifestPath = path.join(root, BUILD_MANIFEST);
  requirePath(manifestPath, "Build manifest", fsImpl);
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Build manifest is invalid: ${error?.message || error}`);
  }
  if (
    parsed?.schemaVersion !== 1 ||
    !parsed.files ||
    typeof parsed.files !== "object" ||
    Array.isArray(parsed.files)
  ) {
    throw new Error("Build manifest has an unsupported schema");
  }
  const expected = new Map(Object.entries(parsed.files));
  const actual = directoryManifest(root, { fsImpl, exclude: [BUILD_MANIFEST] });
  compareManifests(expected, actual, "Build manifest");
  return parsed;
}

function validateRunnableAppTree(root, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const entryExecutable = options.entryExecutable || ENTRY_EXECUTABLE;
  const appRoot = path.join(root, "resources", "app");
  const required = [
    path.join(root, entryExecutable),
    path.join(appRoot, "package.json"),
    path.join(appRoot, "dist", "index.html"),
    path.join(appRoot, "electron", "main.cjs"),
    path.join(appRoot, "electron", "preload.cjs")
  ];
  for (const target of required) requirePath(target, "Required application file", fsImpl);
  const executableBytes = fsImpl.statSync(required[0]).size;
  const minimumExecutableBytes = Number(options.minimumExecutableBytes ?? 100_000_000);
  if (executableBytes < minimumExecutableBytes) {
    throw new Error(`Packaged executable is unexpectedly small: ${executableBytes}`);
  }
  let packageJson;
  try {
    packageJson = JSON.parse(fsImpl.readFileSync(required[1], "utf8"));
  } catch (error) {
    throw new Error(`Packaged package.json is invalid: ${error?.message || error}`);
  }
  let manifest = null;
  if (options.requireManifest === true || fsImpl.existsSync(path.join(root, BUILD_MANIFEST))) {
    manifest = validateBuildManifest(root, fsImpl);
    if (String(manifest.appVersion || "") !== String(packageJson.version || "")) {
      throw new Error(
        `Build manifest version mismatch: ${manifest.appVersion || "missing"} != ${packageJson.version || "missing"}`
      );
    }
  }
  return {
    version: String(packageJson.version || ""),
    executableBytes,
    manifest
  };
}

function defaultProcessIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireArtifactLock(projectRoot, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const lockPath = options.lockPath || path.join(projectRoot, ARTIFACT_LOCK);
  const pid = Number(options.pid ?? process.pid);
  const now = Number(options.now ?? Date.now());
  const token = options.token || uniqueToken(pid, now);
  const isProcessRunning = options.isProcessRunning || defaultProcessIsRunning;
  const staleMs = Number(options.staleMs ?? LOCK_STALE_MS);
  let handle;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = fsImpl.openSync(lockPath, "wx");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      let lockInfo = null;
      let ageMs = 0;
      try {
        lockInfo = JSON.parse(fsImpl.readFileSync(lockPath, "utf8"));
        ageMs = Math.max(0, now - fsImpl.statSync(lockPath).mtimeMs);
      } catch {
        try {
          ageMs = Math.max(0, now - fsImpl.statSync(lockPath).mtimeMs);
        } catch {
          ageMs = 0;
        }
      }
      const ownerPid = Number(lockInfo?.pid);
      const ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0
        ? isProcessRunning(ownerPid)
        : ageMs < staleMs;
      if (ownerAlive) {
        throw new Error(
          `Another build or deployment is already running${ownerPid ? ` (PID ${ownerPid})` : ""}`
        );
      }
      fsImpl.unlinkSync(lockPath);
    }
  }

  const payload = JSON.stringify({ pid, token, createdAt: new Date(now).toISOString() });
  try {
    fsImpl.writeFileSync(handle, payload, "utf8");
    fsImpl.fsyncSync(handle);
  } catch (error) {
    try {
      fsImpl.closeSync(handle);
    } catch {
      // Preserve the lock initialization error.
    }
    try {
      fsImpl.unlinkSync(lockPath);
    } catch {
      // A later invocation can recover the stale lock.
    }
    throw error;
  }
  let released = false;
  return {
    path: lockPath,
    token,
    release() {
      if (released) return "";
      released = true;
      let warning = "";
      try {
        fsImpl.closeSync(handle);
      } catch (error) {
        warning = `Failed to close artifact lock: ${error?.message || error}`;
      }
      try {
        const current = JSON.parse(fsImpl.readFileSync(lockPath, "utf8"));
        if (current?.token === token) fsImpl.unlinkSync(lockPath);
      } catch (error) {
        if (fsImpl.existsSync(lockPath)) {
          warning ||= `Failed to release artifact lock: ${error?.message || error}`;
        }
      }
      return warning;
    }
  };
}

function listDirectories(root, prefix, fsImpl = fs) {
  if (!fsImpl.existsSync(root)) return [];
  return fsImpl
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(root, entry.name))
    .sort((left, right) => fsImpl.statSync(right).mtimeMs - fsImpl.statSync(left).mtimeMs);
}

function removeTreeBestEffort(target, warnings, fsImpl = fs) {
  if (!fsImpl.existsSync(target)) return true;
  try {
    fsImpl.rmSync(target, { recursive: true, force: true });
    if (!fsImpl.existsSync(target)) return true;
    warnings.push(`Cleanup retained ${target}: path still exists after removal`);
    return false;
  } catch (error) {
    warnings.push(`Cleanup retained ${target}: ${error?.message || error}`);
    return false;
  }
}

function canValidate(target, validate) {
  try {
    validate(target);
    return true;
  } catch {
    return false;
  }
}

function recoverArtifactOrphans(options) {
  const {
    containerRoot,
    activeRoot,
    stagePrefix,
    previousPrefix,
    brokenPrefix,
    validate,
    token,
    fsImpl = fs
  } = options;
  const warnings = [];
  let recoveredPrevious = "";

  for (const staleStage of listDirectories(containerRoot, stagePrefix, fsImpl)) {
    removeTreeBestEffort(staleStage, warnings, fsImpl);
  }

  let previousDirectories = listDirectories(containerRoot, previousPrefix, fsImpl);
  const activeValid = fsImpl.existsSync(activeRoot) && canValidate(activeRoot, validate);
  if (!activeValid) {
    const recoveryCandidate = previousDirectories.find((candidate) =>
      canValidate(candidate, validate)
    );
    if (recoveryCandidate) {
      let brokenRoot = "";
      if (fsImpl.existsSync(activeRoot)) {
        brokenRoot = path.join(containerRoot, `${brokenPrefix}${token}`);
        assertDirectChild(containerRoot, brokenRoot);
        fsImpl.renameSync(activeRoot, brokenRoot);
      }
      try {
        fsImpl.renameSync(recoveryCandidate, activeRoot);
        validate(activeRoot);
        recoveredPrevious = recoveryCandidate;
      } catch (error) {
        const recoveryErrors = [];
        if (fsImpl.existsSync(activeRoot) && !fsImpl.existsSync(recoveryCandidate)) {
          try {
            fsImpl.renameSync(activeRoot, recoveryCandidate);
          } catch (restoreCandidateError) {
            recoveryErrors.push(
              `cannot retain failed recovery candidate: ${restoreCandidateError?.message || restoreCandidateError}`
            );
          }
        }
        if (brokenRoot && fsImpl.existsSync(brokenRoot) && !fsImpl.existsSync(activeRoot)) {
          try {
            fsImpl.renameSync(brokenRoot, activeRoot);
          } catch (restoreBrokenError) {
            recoveryErrors.push(
              `cannot restore quarantined active tree: ${restoreBrokenError?.message || restoreBrokenError}`
            );
          }
        }
        throw new Error(
          `Failed to recover previous artifact: ${error?.message || error}` +
          (recoveryErrors.length ? `; ${recoveryErrors.join("; ")}` : "")
        );
      }
      if (brokenRoot) removeTreeBestEffort(brokenRoot, warnings, fsImpl);
      previousDirectories = listDirectories(containerRoot, previousPrefix, fsImpl);
    }
  }

  if (fsImpl.existsSync(activeRoot) && canValidate(activeRoot, validate)) {
    for (const oldPrevious of previousDirectories) {
      removeTreeBestEffort(oldPrevious, warnings, fsImpl);
    }
  }
  return { recoveredPrevious, warnings };
}

function publishVerifiedCopy(source, destination, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const entryExecutable = options.entryExecutable || ENTRY_EXECUTABLE;
  const token = options.token || uniqueToken();
  const entryRelative = entryExecutable.split(path.sep).join("/");
  const files = [...directoryManifest(source, { fsImpl }).keys()].sort((left, right) => {
    const rank = (relative) => {
      if (relative === entryRelative) return 2;
      return path.extname(relative).toLowerCase() === ".exe" ? 1 : 0;
    };
    return rank(left) - rank(right) || left.localeCompare(right);
  });
  fsImpl.mkdirSync(destination);
  for (const relative of files) {
    if (relative === entryRelative) continue;
    const target = path.join(destination, ...relative.split("/"));
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.copyFileSync(path.join(source, ...relative.split("/")), target);
  }

  const pendingName = `.${entryExecutable}.${token}.pending`;
  const pendingPath = path.join(destination, pendingName);
  fsImpl.copyFileSync(path.join(source, entryExecutable), pendingPath);

  const sourceManifest = directoryManifest(source, { fsImpl });
  const readyManifest = directoryManifest(destination, { fsImpl });
  if (readyManifest.size !== sourceManifest.size) {
    throw new Error(
      `Verified-copy staging count mismatch: ${readyManifest.size} != ${sourceManifest.size}`
    );
  }
  for (const [relative, signature] of sourceManifest) {
    const readyRelative = relative === entryRelative ? pendingName : relative;
    if (readyManifest.get(readyRelative) !== signature) {
      throw new Error(`Verified-copy staging hash mismatch: ${relative}`);
    }
  }
  fsImpl.renameSync(pendingPath, path.join(destination, entryExecutable));
  return verifyEqual(source, destination, fsImpl);
}

function assertFormalAppNotRunning(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return;
  const run = options.execFileSync || execFileSync;
  try {
    const output = run(
      "tasklist.exe",
      ["/FI", `IMAGENAME eq ${ENTRY_EXECUTABLE}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true }
    );
    if (/A股雷达\.exe/i.test(output)) {
      throw new Error("A股雷达正在运行，请先关闭软件再部署正式版");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("正在运行")) throw error;
    // A later directory rename remains the final lock check if tasklist is unavailable.
  }
}

function rollbackInstallation(options) {
  const {
    formalRoot,
    previousRoot,
    movedPrevious,
    installationStarted,
    validatePrevious,
    fsImpl = fs
  } = options;
  const rollbackErrors = [];
  if (installationStarted && fsImpl.existsSync(formalRoot)) {
    try {
      fsImpl.rmSync(formalRoot, { recursive: true, force: true });
    } catch (error) {
      rollbackErrors.push(`cannot remove incomplete formal tree: ${error?.message || error}`);
    }
  }
  if (movedPrevious && fsImpl.existsSync(previousRoot)) {
    if (fsImpl.existsSync(formalRoot)) {
      rollbackErrors.push(`previous version retained at ${previousRoot}; formal path is still occupied`);
    } else {
      try {
        fsImpl.renameSync(previousRoot, formalRoot);
        validatePrevious(formalRoot);
      } catch (error) {
        try {
          if (fsImpl.existsSync(formalRoot)) {
            fsImpl.rmSync(formalRoot, { recursive: true, force: true });
          }
          publishVerifiedCopy(previousRoot, formalRoot, { fsImpl });
          validatePrevious(formalRoot);
          try {
            fsImpl.rmSync(previousRoot, { recursive: true, force: true });
          } catch {
            // The active formal tree has already been restored and verified.
          }
        } catch (copyRestoreError) {
          rollbackErrors.push(
            `cannot restore previous version: ${error?.message || error}; ` +
            `verified-copy restore failed: ${copyRestoreError?.message || copyRestoreError}`
          );
        }
      }
    }
  }
  return rollbackErrors;
}

function deployFormal(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, ".."));
  const sourceRoot = path.resolve(options.sourceRoot || path.join(projectRoot, "release", "win-unpacked"));
  const formalRoot = path.resolve(options.formalRoot || path.join(projectRoot, "程序"));
  const token = options.token || uniqueToken(options.pid || process.pid, options.now || Date.now());
  const stageRoot = path.join(projectRoot, `.formal-stage-${token}`);
  const previousRoot = path.join(projectRoot, `.formal-previous-${token}`);
  const minimumExecutableBytes = options.minimumExecutableBytes ?? 100_000_000;
  const cleanupWarnings = [];
  const lock = acquireArtifactLock(projectRoot, {
    fsImpl,
    pid: options.pid,
    now: options.now,
    token: options.lockToken,
    isProcessRunning: options.isProcessRunning
  });

  try {
    assertDirectChild(projectRoot, formalRoot);
    assertDirectChild(projectRoot, stageRoot);
    assertDirectChild(projectRoot, previousRoot);
    requirePath(sourceRoot, "Built application", fsImpl);
    validateRunnableAppTree(sourceRoot, {
      fsImpl,
      minimumExecutableBytes,
      requireManifest: true
    });
    (options.assertAppNotRunning || (() => assertFormalAppNotRunning()))();

    const orphanResult = recoverArtifactOrphans({
      containerRoot: projectRoot,
      activeRoot: formalRoot,
      stagePrefix: ".formal-stage-",
      previousPrefix: ".formal-previous-",
      brokenPrefix: ".formal-broken-",
      token,
      fsImpl,
      validate: (target) => validateRunnableAppTree(target, {
        fsImpl,
        minimumExecutableBytes,
        requireManifest: false
      })
    });
    cleanupWarnings.push(...orphanResult.warnings);

    copyTree(sourceRoot, stageRoot, fsImpl);
    const stagedFileCount = verifyEqual(sourceRoot, stageRoot, fsImpl);
    validateRunnableAppTree(stageRoot, {
      fsImpl,
      minimumExecutableBytes,
      requireManifest: true
    });

    let movedPrevious = false;
    let installationStarted = false;
    let installMode = "atomic-rename";
    let installedFileCount = 0;
    try {
      if (fsImpl.existsSync(formalRoot)) {
        try {
          fsImpl.renameSync(formalRoot, previousRoot);
        } catch (renamePreviousError) {
          if (!["EPERM", "EBUSY", "EXDEV"].includes(renamePreviousError?.code)) {
            throw renamePreviousError;
          }
          installMode = "verified-copy";
          copyTree(formalRoot, previousRoot, fsImpl);
          verifyEqual(formalRoot, previousRoot, fsImpl);
          validateRunnableAppTree(previousRoot, {
            fsImpl,
            minimumExecutableBytes,
            requireManifest: false
          });
          movedPrevious = true;
          installationStarted = true;
          fsImpl.rmSync(formalRoot, { recursive: true, force: true });
          if (fsImpl.existsSync(formalRoot)) {
            throw new Error(`Unable to clear the previous formal tree after verified backup: ${formalRoot}`);
          }
        }
        movedPrevious = true;
      }
      installationStarted = true;
      try {
        fsImpl.renameSync(stageRoot, formalRoot);
      } catch (renameError) {
        if (!["EPERM", "EBUSY", "EXDEV"].includes(renameError?.code)) throw renameError;
        installMode = "verified-copy";
        publishVerifiedCopy(stageRoot, formalRoot, {
          fsImpl,
          token,
          entryExecutable: ENTRY_EXECUTABLE
        });
      }
      installedFileCount = verifyEqual(sourceRoot, formalRoot, fsImpl);
      validateRunnableAppTree(formalRoot, {
        fsImpl,
        minimumExecutableBytes,
        requireManifest: true
      });
    } catch (error) {
      const rollbackErrors = rollbackInstallation({
        formalRoot,
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

    // The verified formal tree is committed. Cleanup failures must never roll it back.
    if (movedPrevious) removeTreeBestEffort(previousRoot, cleanupWarnings, fsImpl);
    removeTreeBestEffort(stageRoot, cleanupWarnings, fsImpl);

    return {
      sourceRoot,
      formalRoot,
      installMode,
      stagedFileCount,
      installedFileCount,
      sha256Mismatches: 0,
      recoveredPrevious: orphanResult.recoveredPrevious,
      cleanupWarnings
    };
  } finally {
    const lockWarning = lock.release();
    if (lockWarning) process.stderr.write(`${lockWarning}\n`);
  }
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(deployFormal(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ARTIFACT_LOCK,
  BUILD_MANIFEST,
  ENTRY_EXECUTABLE,
  acquireArtifactLock,
  assertDirectChild,
  copyTree,
  deployFormal,
  directoryManifest,
  publishVerifiedCopy,
  recoverArtifactOrphans,
  removeTreeBestEffort,
  validateBuildManifest,
  validateRunnableAppTree,
  verifyEqual,
  writeBuildManifest
};
