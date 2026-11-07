"use strict";

/**
 * 唯一软件部署：所有构建产物直接装进桌面「A股」目录里那一个
 * A股雷达趋势版.app，不再另外生成版本化的 .zip 安装包。
 *
 *   1. 构建（vite 主应用 + 复盘 + electron-builder --dir）
 *   2. 在暂存副本签名，核对双回执、产物与实际 unpacked 文件
 *   3. 停旧进程，保留上一版并切换正式路径，再次核对
 *   4. 原子写版本说明并启动；此前失败均尝试恢复上一版与原说明
 *   5. 完成后清理上一版、dist/ 与 release-builder/
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const PRODUCT = "A股雷达趋势版";
const APP_NAME = `${PRODUCT}.app`;
const EXECUTABLE = path.join("Contents", "MacOS", PRODUCT);
const VERSION = require("../package.json").version;

const log = message => process.stdout.write(`[deploy] ${message}\n`);
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function targetDirectory() {
  const configured = String(process.env.ASTOCK_APP_DIR || "").trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), "Desktop", "A股");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: path.resolve(__dirname, "..") });
  if (result.error) throw new Error(`${command} 无法执行：${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status}`);
}
const node = args => run(process.execPath, args);

function pidsUsingExecutable(executablePath) {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (ps.error || ps.status !== 0) throw new Error("无法查询运行中的应用，已停止部署");
  const pids = [];
  for (const line of String(ps.stdout || "").split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && match[2].includes(executablePath)) pids.push(Number(match[1]));
  }
  return pids;
}

async function stopRunningApp(executablePath) {
  const pids = pidsUsingExecutable(executablePath);
  if (!pids.length) return;
  log(`停止正在运行的旧实例（${pids.length} 个进程）`);
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ } }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!pidsUsingExecutable(executablePath).length) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const pid of pidsUsingExecutable(executablePath)) { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
  await new Promise(resolve => setTimeout(resolve, 400));
  if (pidsUsingExecutable(executablePath).length) throw new Error("旧应用仍在运行，已停止替换");
}

/** Both receipts must describe the actual package. The explicit override only
 * permits current source-tree drift, never altered outputs or runtime modules. */
function verifyBuildReceipt(appPath, repoRoot) {
  return require("../qa/build-artifact-verification.cjs").verifyBuildArtifact(appPath, repoRoot);
}

function enforceReceiptInputs(receipt) {
  if (receipt.consistent) return;
  const detail = `缺少 ${receipt.missingInReceipt.length} 项、未知 ${receipt.unknownInReceipt.length} 项、变化 ${receipt.changed.length} 项`;
  if (!process.argv.includes("--allow-receipt-mismatch")) throw new Error(`构建回执与当前源码输入不一致：${detail}。请重新构建。`);
  log(`警告：仅放行源码输入差异（${detail}）；双入口输出与实际运行文件已强制核对。`);
}

async function writeTextAtomic(file, text) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, text, { flag: "wx" });
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function restoreText(file, text) {
  if (text === null) await fsp.rm(file, { force: true });
  else await writeTextAtomic(file, text);
}

async function removeAfterCommit(file) {
  try { await fsp.rm(file, { recursive: true, force: true }); }
  catch (error) { log(`清理未完成，已保留 ${file}：${error.message}`); }
}

async function main() {
  const repo = path.resolve(__dirname, "..");
  const target = targetDirectory();
  if (!fs.existsSync(target)) throw new Error(`目标目录不存在：${target}`);
  const installed = path.join(target, APP_NAME);
  const built = path.join(repo, "release-builder", "mac-arm64", APP_NAME);
  const stamp = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${crypto.randomUUID()}`;
  const stage = path.join(target, `.${PRODUCT}.${stamp}.staging.app`);
  const previous = path.join(target, `.${APP_NAME}.${stamp}.previous`);
  const rejected = path.join(target, `.${APP_NAME}.${stamp}.rejected`);
  const lock = require("./deploy-formal.cjs").acquireArtifactLock(repo);

  try {

  if (!process.argv.includes("--from-build")) {
    log("构建主应用界面");
    node([path.join(repo, "node_modules", "vite", "bin", "vite.js"), "build"]);
    log("构建复盘界面");
    node([path.join(repo, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "review.vite.config.ts"]);
    log("打包为唯一软件");
    node([
      path.join(repo, "node_modules", "electron-builder", "cli.js"),
      "--dir", "--mac", "--arm64",
      `-c.productName=${PRODUCT}`,
      "-c.appId=com.codex.astocktrend",
      "-c.extraMetadata.name=a-stock-trend-radar"
    ]);
  } else {
    log("使用已构建产物");
  }
  if (!fs.existsSync(built)) throw new Error("构建产物缺失：请先运行构建");

  log("核对构建产物完整性");
  const { verifyAppBundleIntegrity } = require("../qa/delivery-verification.cjs");
  // The staging bundle is signed below; never modify the installed app to sign it.
  verifyAppBundleIntegrity(built, { verifySignature: false });
  const watched = [path.join("Contents", "Resources", "app.asar"), EXECUTABLE];
  const expected = Object.fromEntries(watched.map(rel => [rel, sha256(path.join(built, rel))]));

  log("核对构建回执与本次构建输入");
  enforceReceiptInputs(verifyBuildReceipt(built, repo));

  log("复制到目标目录暂存");
  run("/usr/bin/ditto", [built, stage]);
  for (const [rel, digest] of Object.entries(expected)) {
    if (sha256(path.join(stage, rel)) !== digest) throw new Error(`暂存副本与构建产物不一致：${rel}`);
  }

  // 只替换 app.asar 会让原有签名封条失效（CodeResources 里记录的是旧 asar 的哈希），
  // 结果是 codesign --verify 报 "a sealed resource is missing or invalid"，
  // 换机拷贝 / Time Machine 恢复后被 Gatekeeper 判为"已损坏"。替换后必须重新封签。
  if (process.platform === "darwin") {
    log("重新签名（ad-hoc）");
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", stage]);
  }

  // 签名后的暂存包只核验一遍：macOS 上 verifyMacDelivery 已包含回执和包完整性（含 codesign --verify），
  // 直接复用它的结果；放行开关必须传进去，否则它会先于 enforceReceiptInputs 抛错，开关永远无效。
  const allowSourceDrift = process.argv.includes("--allow-receipt-mismatch");
  const mac = process.platform === 'darwin' ? require('../qa/verify-mac-delivery.cjs').verifyMacDelivery(stage, repo, { allowSourceDrift }) : null;
  const verification = mac?.bundle || verifyAppBundleIntegrity(stage);
  const receipt = mac?.artifact || verifyBuildReceipt(stage, repo);
  enforceReceiptInputs(receipt);
  const infoVersion = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(stage, 'Contents', 'Info.plist')], { encoding: 'utf8' });
  const packageVersionTriple = { repo: VERSION, asar: receipt.version, infoPlist: String(infoVersion.stdout || '').trim() };
  if (infoVersion.error || infoVersion.status !== 0 || Object.values(packageVersionTriple).some(version => version !== VERSION)) {
    throw new Error('源码、应用归档和 Info.plist 版本不一致，已停止部署');
  }
  // 重新签名后再确认一次 Electron 熔断位仍是关闭状态（RunAsNode 等），防止被当作 Node 运行时滥用。
  if (process.platform === "darwin") {
    const executable = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(stage, 'Contents', 'Info.plist')], { encoding: 'utf8' });
    const name = String(executable.stdout || '').trim();
    if (executable.error || executable.status !== 0 || !name) throw new Error('读不到应用可执行文件名，已停止部署');
    await require('./build-runtime-fuses.cjs').verifyRuntimeFuses(path.join(stage, 'Contents', 'MacOS', name));
    log("熔断位核验通过");
  }
  const signedDigests = Object.fromEntries(watched.map(rel => [rel, sha256(path.join(stage, rel))]));

  const appSha = signedDigests[path.join("Contents", "Resources", "app.asar")];
  const metaPath = path.join(target, "当前版本.json");
  const readmePath = path.join(target, "先读我.txt");
  const oldMeta = fs.existsSync(metaPath) ? await fsp.readFile(metaPath, "utf8") : null;
  const oldReadme = fs.existsSync(readmePath) ? await fsp.readFile(readmePath, "utf8") : null;
  let meta = {};
  if (oldMeta !== null) { try { meta = JSON.parse(oldMeta); } catch { meta = {}; } }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
  const priorEvidence = { ...(meta.verification || {}) };
  delete priorEvidence.previousVerification;
  const previousVerification = { historicalOnly: true, metadataVersion: meta.version, record: priorEvidence };
  meta.schemaVersion = meta.schemaVersion || 1;
  meta.generatedAt = new Date().toISOString();
  meta.productName = PRODUCT;
  meta.version = VERSION;
  meta.delivery = "single-app-only";
  meta.current = { app: APP_NAME, appAsarSha256: appSha, archive: null, sha256: null };
  meta.verification = {
    previousVerification,
    unitTests: 'not recorded by installer for this build',
    coverage: 'not measured for this build',
    browserSuites: 'not recorded by installer for this build',
    packageVersionTriple,
    bundleIntegrity: verification,
    buildReceipt: {
      consistent: receipt.consistent,
      artifactConsistent: receipt.artifactConsistent,
      outputs: receipt.outputs,
      productionFiles: receipt.productionFiles,
      unpackedFiles: receipt.unpackedFiles,
      recordedInputs: receipt.recordedInputs,
      currentInputs: receipt.currentInputs,
      changed: receipt.changed.slice(0, 10),
      missingInReceipt: receipt.missingInReceipt.slice(0, 10)
    },
    codeSignature: process.platform === "darwin" ? "adhoc-resealed" : "not-applicable",
    observedAt: meta.generatedAt
  };
  let readme = oldReadme;
  if (readme !== null) {
    readme = readme
      .replace(/^当前版本：[^\r\n]*/m, `当前版本：${VERSION}`)
      .replace(/^- .*\.zip：最新安装包。\n/m, "")
      .replace(/^- 同名 \.zip\.sha256：安装包校验码。\n/m, "");
    if (!readme.includes("只有这一个软件")) {
      readme = readme.replace(
        "双击同目录的「A股雷达趋势版.app」运行。",
        "双击同目录的「A股雷达趋势版.app」运行。\n本目录只有这一个软件，不再另外生成安装包；每次更新直接覆盖它。"
      );
    }
    if (meta.verification?.unitTests) {
      readme = readme.replace(/^全量单测：[^\r\n]*/m, `全量单测：${meta.verification.unitTests}`);
    }
    if (meta.verification?.auditReport) {
      readme = readme.replace(/^本轮审核报告：[^\r\n]*/m, `本轮审核报告：${meta.verification.auditReport}`);
    }
    if (meta.verification?.dependencyAudit) {
      readme = readme.replace(/^在线漏洞审计：[^\r\n]*/m, `在线漏洞审计：${meta.verification.dependencyAudit}`);
    }
  }
  let movedPrevious = false, installedNew = false, metaTouched = false, readmeTouched = false;
  try {
    if (fs.existsSync(installed)) {
      await stopRunningApp(path.join(installed, EXECUTABLE));
      await fsp.rename(installed, previous);
      movedPrevious = true;
    }
    await fsp.rename(stage, installed);
    installedNew = true;
    verifyAppBundleIntegrity(installed);
    enforceReceiptInputs(verifyBuildReceipt(installed, repo));
    for (const [rel, digest] of Object.entries(signedDigests)) {
      if (sha256(path.join(installed, rel)) !== digest) throw new Error(`正式软件与已签名暂存副本不一致：${rel}`);
    }
    metaTouched = true;
    await writeTextAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    if (readme !== null) {
      readmeTouched = true;
      await writeTextAtomic(readmePath, readme);
    }
    run("/usr/bin/open", [installed]);
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (installedNew && fs.existsSync(installed)) {
        await stopRunningApp(path.join(installed, EXECUTABLE));
        await fsp.rename(installed, rejected);
      }
      if (movedPrevious) await fsp.rename(previous, installed);
    } catch (rollbackError) { rollbackErrors.push(`软件恢复失败，旧版本保留于 ${previous}：${rollbackError.message}`); }
    try { if (metaTouched) await restoreText(metaPath, oldMeta); }
    catch (rollbackError) { rollbackErrors.push(`版本说明恢复失败：${rollbackError.message}`); }
    try { if (readmeTouched) await restoreText(readmePath, oldReadme); }
    catch (rollbackError) { rollbackErrors.push(`先读我恢复失败：${rollbackError.message}`); }
    if (!rollbackErrors.length) await removeAfterCommit(rejected);
    throw new Error(`${error.message}${rollbackErrors.length ? `；${rollbackErrors.join("；")}` : "；已恢复部署前的软件与说明文件"}`, { cause: error });
  }
  // Commit includes verification, metadata publication and launch dispatch.
  // Cleanup errors leave recoverable files and do not turn success into failure.
  // Rollback is needed only until the verified replacement and metadata launch.
  // Do not create another permanent app copy after a successful installation.
  await removeAfterCommit(previous);
  for (const name of ["dist", "release-builder"]) await removeAfterCommit(path.join(repo, name));
  log(`完成：${installed}`);
  log(`app.asar SHA256：${appSha}`);
  } finally {
    await removeAfterCommit(stage);
    const warning = lock.release();
    if (warning) log(warning);
  }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`[deploy] 失败：${error.stack || error.message}\n`);
  process.exitCode = 1;
});

module.exports = { main, targetDirectory, verifyBuildReceipt };
