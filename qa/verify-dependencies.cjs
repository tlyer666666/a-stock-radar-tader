"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const unquote = (value) => value.replace(/^(['"])(.*)\1$/, "$2");

// pnpm emits this deliberately small subset for a root importer's exact pins.
// Reject unfamiliar formats instead of guessing a version and passing a release.
function parseRootImporter(text) {
  if (!/^lockfileVersion:\s*['"]?9\.0['"]?\s*$/m.test(text)) {
    throw new Error("Unsupported pnpm lock format; expected lockfileVersion 9.0");
  }
  const importers = text.match(/^importers:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1];
  const root = importers?.match(/^  \.:\s*\n([\s\S]*?)(?=^  \S|$(?![\s\S]))/m)?.[1];
  if (!root) throw new Error("Missing root lock importer");
  const result = {};
  let dependency;
  for (const line of root.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^    (?:devDependencies|dependencies|optionalDependencies):\s*$/.test(line)) {
      dependency = undefined;
      continue;
    }
    const heading = line.match(/^      (.+):\s*$/);
    if (heading) {
      dependency = unquote(heading[1]);
      if (Object.hasOwn(result, dependency)) throw new Error(`Duplicate lock dependency ${dependency}`);
      result[dependency] = {};
      continue;
    }
    const field = line.match(/^        (specifier|version):\s*(.+)\s*$/);
    if (!dependency || !field) throw new Error(`Unsupported root lock importer line: ${line.trim()}`);
    if (Object.hasOwn(result[dependency], field[1])) throw new Error(`Duplicate lock ${field[1]}: ${dependency}`);
    const value = unquote(field[2].trim());
    result[dependency][field[1]] = field[1] === "version" ? value.split("(", 1)[0] : value;
  }
  for (const [name, entry] of Object.entries(result)) {
    if (!entry.specifier || !entry.version) throw new Error(`Missing lock specifier/version: ${name}`);
  }
  return result;
}

function verifyVersions({ manifest, importer, installed, runtime }) {
  const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
  const entries = Object.entries(declared);
  if (!entries.length) throw new Error("No direct dependencies declared");
  for (const [name, expected] of entries) {
    if (!EXACT_VERSION.test(expected)) throw new Error(`${name} must use an exact pinned version, received ${expected}`);
    const locked = importer[name];
    if (locked?.specifier !== expected || locked?.version !== expected) {
      throw new Error(`${name} lock mismatch: manifest ${expected}, lock ${JSON.stringify(locked)}`);
    }
    if (installed[name] !== expected) {
      throw new Error(`${name} installed mismatch: manifest ${expected}, installed ${installed[name] ?? "missing"}`);
    }
  }
  for (const name of Object.keys(importer)) {
    if (!Object.hasOwn(declared, name)) throw new Error(`Stale lock dependency not declared: ${name}`);
  }
  if (!declared.electron || runtime?.electron !== declared.electron) {
    throw new Error(`Electron runtime mismatch: expected ${declared.electron}, runtime ${runtime?.electron ?? "missing"}`);
  }
  // npm audit cannot inspect Node's built-in undici. Electron 43.5.0 is clean
  // at npm level but still embeds 7.29.0; Node 24.21.0 carries the fixed 7.29.1.
  // https://nodejs.org/en/blog/release/v24.21.0
  const undici = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(runtime.undici || "")?.slice(1).map(Number);
  if (!undici || undici[0] < 7 || (undici[0] === 7 && (undici[1] < 29 || (undici[1] === 29 && undici[2] < 1)))) {
    throw new Error(`Embedded undici ${runtime.undici ?? "missing"} is below the reviewed fixed floor 7.29.1`);
  }
  return { directDependencies: entries.length, versions: declared, runtime };
}

function evaluateAudit(payload, exitCode) {
  if (exitCode !== 0 && exitCode !== 1) throw new Error(`Dependency audit command exit ${exitCode}`);
  const advisories = payload?.advisories;
  const counts = payload?.metadata?.vulnerabilities;
  if (payload?.error || !advisories || Array.isArray(advisories) || typeof advisories !== "object" || !counts) {
    throw new Error("Dependency audit failed or returned an unsupported audit payload");
  }
  if (Object.keys(counts).some((key) => !SEVERITIES.includes(key))) throw new Error("Unknown audit severity");
  const severity = Object.fromEntries(SEVERITIES.map((name) => [name, 0]));
  const records = Object.values(advisories);
  for (const advisory of records) {
    if (!SEVERITIES.includes(advisory?.severity) || typeof advisory.module_name !== "string" || !Array.isArray(advisory.findings)) {
      throw new Error("Invalid dependency audit advisory");
    }
    severity[advisory.severity] += 1;
  }
  for (const name of SEVERITIES) {
    if (!Number.isSafeInteger(counts[name]) || counts[name] < 0 || counts[name] !== severity[name]) {
      throw new Error(`Dependency audit count mismatch: ${name}`);
    }
  }
  if ((exitCode === 0) !== (records.length === 0)) throw new Error("Dependency audit exit code disagrees with advisory count");
  // Electron and compiled renderer libraries are devDependencies but ship in the
  // application. No dev/optional/bundled exclusion is safe for this release gate.
  const blocked = records.filter((item) => item.severity === "high" || item.severity === "critical");
  if (blocked.length) {
    throw new Error(`Dependency security review required; high/critical findings block release:\n${blocked.map((item) => `${item.severity}: ${item.module_name} ${item.github_advisory_id || item.id} ${item.url || ""}`).join("\n")}`);
  }
  return { records: records.length, uniqueAdvisories: new Set(records.map((item) => item.github_advisory_id || item.id)).size, severity };
}

function run(root, { audit = false } = {}) {
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const importer = parseRootImporter(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const installed = {};
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })) {
    const packagePath = path.join(root, "node_modules", name, "package.json");
    if (fs.existsSync(packagePath)) installed[name] = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
  }
  // Inspect exactly the installed binary selected by packaging. Requiring the
  // Electron package can silently download a missing binary or honor an override.
  const electronDirectory = path.join(root, "node_modules", "electron");
  const electronPathFile = path.join(electronDirectory, "path.txt");
  if (!fs.existsSync(electronPathFile)) throw new Error("Electron binary is not installed; run pnpm ensure:electron first");
  const binaryRelative = fs.readFileSync(electronPathFile, "utf8").trim();
  const electronDist = path.resolve(electronDirectory, "dist");
  const electronPath = path.resolve(electronDist, binaryRelative);
  if (!binaryRelative || !electronPath.startsWith(electronDist + path.sep) || !fs.existsSync(electronPath)) {
    throw new Error("Electron binary path is missing or outside its installed distribution");
  }
  const runtimeResult = spawnSync(electronPath, ["-p", "JSON.stringify(process.versions)"], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 20000, windowsHide: true,
  });
  if (runtimeResult.error || runtimeResult.status !== 0) throw new Error(`Cannot inspect Electron binary: ${runtimeResult.error?.message || runtimeResult.stderr || runtimeResult.status}`);
  const runtime = JSON.parse(runtimeResult.stdout.trim());
  const report = { ...verifyVersions({ manifest, importer, installed, runtime }), audit: "not requested" };
  if (audit) {
    // Fixed arguments only. Windows needs a shell to execute pnpm.cmd.
    const auditResult = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["audit", "--json"], {
      cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: process.platform === "win32",
    });
    if (auditResult.error) throw new Error(`Dependency audit could not complete: ${auditResult.error.message}`);
    let payload;
    try { payload = JSON.parse(auditResult.stdout); } catch { throw new Error(`Dependency audit returned invalid JSON (exit ${auditResult.status})`); }
    report.audit = evaluateAudit(payload, auditResult.status);
  }
  return report;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--audit")) throw new Error("Usage: node qa/verify-dependencies.cjs [--audit]");
    console.log(JSON.stringify(run(path.resolve(__dirname, ".."), { audit: args.includes("--audit") }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseRootImporter, verifyVersions, evaluateAudit, run };
