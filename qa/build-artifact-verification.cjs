"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { appResources } = require("./delivery-verification.cjs");
const { snapshotBuildInputs } = require("./build-provenance.cjs");

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const productionPath = name => /^(?:electron|config|assets)\//.test(name);
function safeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")
    || value.split("/").some(part => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Unsafe receipt/archive path: ${String(value)}`);
  }
  return value;
}
function hashManifest(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw new Error(`Missing ${label}`);
  for (const [name, hash] of Object.entries(value)) {
    safeRelative(name);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid ${label} hash: ${name}`);
  }
  return value;
}
function sameNames(actual, expected, label) {
  const wanted = new Set(expected), found = new Set(actual);
  const missing = [...wanted].filter(name => !found.has(name));
  const extra = [...found].filter(name => !wanted.has(name));
  if (missing.length || extra.length) throw new Error(`${label} file set mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}`);
}
function regularFileWithin(root, relative) {
  let target = root;
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Unpacked root is a symlink: ${root}`);
  for (const part of safeRelative(relative).split("/")) {
    target = path.join(target, part);
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Unpacked file path contains a symlink: ${relative}`);
  }
  if (!fs.statSync(target).isFile()) throw new Error(`Unpacked file is not regular: ${relative}`);
  return target;
}

/** Verify actual package bytes. Source-tree drift is reported separately and
 * is the only condition deploy's explicit receipt override may permit. */
function verifyBuildArtifact(appPath, repoRoot) {
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const asar = appBuilderRequire("@electron/asar");
  const { minimatch } = appBuilderRequire("minimatch");
  const archive = path.join(appResources(appPath), "app.asar");
  const unpacked = `${archive}.unpacked`;
  if (fs.existsSync(path.join(unpacked, 'config/fuyao-seed.json'))) throw new Error('Packaged credential seed is forbidden');
  // A stage may have been replaced at the same pathname during an earlier run.
  asar.uncache(archive);
  const entries = new Map();
  for (const entry of asar.listPackage(archive)) {
    const name = safeRelative(entry.replace(/^\//, ""));
    const stat = asar.statFile(archive, name, false);
    if (stat.link) throw new Error(`Archive links are not allowed: ${name}`);
    if (!stat.files) entries.set(name, stat);
  }
  if (entries.has('config/fuyao-seed.json')) throw new Error('Packaged credential seed is forbidden');
  const read = name => {
    const stat = entries.get(safeRelative(name));
    if (!stat) throw new Error(`Missing packaged file: ${name}`);
    const bytes = stat.unpacked
      ? fs.readFileSync(regularFileWithin(unpacked, name))
      : asar.extractFile(archive, name, false);
    if (bytes.length !== stat.size) throw new Error(`Packaged file size mismatch: ${name}`);
    return bytes;
  };
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const packagedPackage = JSON.parse(read("package.json").toString("utf8"));
  if (packagedPackage.version !== sourcePackage.version || packagedPackage.main !== sourcePackage.main) {
    throw new Error("Packaged version/main does not match the release manifest");
  }
  const current = snapshotBuildInputs(repoRoot);
  const receipts = [], expectedDist = [], outputCounts = {};
  for (const kind of ["web", "review"]) {
    const prefix = kind === "web" ? "dist/" : "dist/review/";
    const receiptPath = `${prefix}build-provenance.json`;
    const receipt = JSON.parse(read(receiptPath).toString("utf8"));
    if (receipt.schemaVersion !== 1 || receipt.kind !== kind || receipt.status !== "passed" || receipt.version !== sourcePackage.version) {
      throw new Error(`Invalid ${kind} build receipt schema/kind/status/version`);
    }
    hashManifest(receipt.sourceHashes, `${kind} source manifest`);
    hashManifest(receipt.outputHashes, `${kind} output manifest`);
    if (kind === "review" && JSON.stringify(Object.entries(receipt.sourceHashes).sort()) !== JSON.stringify(Object.entries(receipts[0].sourceHashes).sort())) {
      throw new Error("Web and review were compiled from different input snapshots");
    }
    for (const [name, hash] of Object.entries(receipt.outputHashes)) {
      if (name === "build-provenance.json" || (kind === "web" && name.startsWith("review/"))) throw new Error(`Invalid ${kind} output entry: ${name}`);
      const packagedName = `${prefix}${name}`;
      if (digest(read(packagedName)) !== hash) throw new Error(`Packaged ${kind} output mismatch: ${name}`);
      expectedDist.push(packagedName);
    }
    const required = kind === "web" ? ["index.html"] : ["review.html", "review-module.js", "review-style.css"];
    for (const name of required) if (!Object.hasOwn(receipt.outputHashes, name)) throw new Error(`Missing ${kind} entry output: ${name}`);
    expectedDist.push(receiptPath);
    outputCounts[kind] = Object.keys(receipt.outputHashes).length;
    receipts.push(receipt);
  }
  sameNames([...entries.keys()].filter(name => name.startsWith("dist/")), expectedDist, "Renderer outputs");
  const recorded = receipts[0].sourceHashes;
  const patterns = sourcePackage.build?.files;
  const unpackPatterns = sourcePackage.build?.asarUnpack || [];
  if (!Array.isArray(patterns) || patterns.some(item => typeof item !== "string") || !Array.isArray(unpackPatterns)
    || unpackPatterns.some(item => typeof item !== "string")) throw new Error("Unsupported production file selection; explicit string patterns are required");
  const matches = (name, pattern) => minimatch(name, pattern, { dot: true });
  const included = name => patterns.some(pattern => !pattern.startsWith("!") && matches(name, pattern))
    && !patterns.some(pattern => pattern.startsWith("!") && matches(name, pattern.slice(1)));
  const expectedProduction = Object.keys(recorded).filter(name => productionPath(name) && included(name));
  if (!expectedProduction.includes(sourcePackage.main)) throw new Error("Production manifest does not include the Electron entry");
  sameNames([...entries.keys()].filter(productionPath), expectedProduction, "Production modules/assets");
  for (const name of expectedProduction) {
    if (digest(read(name)) !== recorded[name]) throw new Error(`Packaged production source mismatch: ${name}`);
    if (unpackPatterns.some(pattern => matches(name, pattern)) && !entries.get(name).unpacked) throw new Error(`Required unpacked file is packed: ${name}`);
  }
  const actualUnpacked = [];
  const walkUnpacked = (directory, relative = "") => {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Unpacked directory is a symlink: ${directory}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      safeRelative(name);
      if (entry.isSymbolicLink()) throw new Error(`Unpacked entry is a symlink: ${name}`);
      if (entry.isDirectory()) walkUnpacked(path.join(directory, entry.name), name);
      else if (entry.isFile()) actualUnpacked.push(name);
      else throw new Error(`Unsupported unpacked entry: ${name}`);
    }
  };
  const expectedUnpacked = [...entries].filter(([, stat]) => stat.unpacked).map(([name]) => name);
  if (fs.existsSync(unpacked)) walkUnpacked(unpacked);
  sameNames(actualUnpacked, expectedUnpacked, "Unpacked runtime");
  // All unpacked renderer/production bytes were read above; do not accept an
  // unverified native/runtime addition outside this app's declared inputs.
  for (const name of expectedUnpacked) {
    if (!productionPath(name) && !expectedDist.includes(name)) throw new Error(`Unverified unpacked runtime file: ${name}`);
  }
  const missingInReceipt = Object.keys(current).filter(key => !Object.hasOwn(recorded, key));
  const unknownInReceipt = Object.keys(recorded).filter(key => !Object.hasOwn(current, key));
  const changed = Object.keys(current).filter(key => Object.hasOwn(recorded, key) && current[key] !== recorded[key]);
  return { version: receipts[0].version, status: "passed", recordedInputs: Object.keys(recorded).length,
    currentInputs: Object.keys(current).length, missingInReceipt, unknownInReceipt, changed,
    consistent: !missingInReceipt.length && !unknownInReceipt.length && !changed.length,
    artifactConsistent: true, outputs: outputCounts, productionFiles: expectedProduction.length, unpackedFiles: expectedUnpacked.length };
}

module.exports = { verifyBuildArtifact };
