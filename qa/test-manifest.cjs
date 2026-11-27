#!/usr/bin/env node
"use strict";
// Canonical test manifest. Discovers every *.test.cjs under src/, electron/ and
// qa/ from disk and assigns each file to exactly one group:
//
//   ui   - browser/playwright-driven suites, executed by the qa:*:ui scripts
//          (declared explicitly below because they need Chrome).
//   unit - everything else, executed by `pnpm test` (hermetic, node:test).
//
// A new test file that is not declared anywhere automatically lands in `unit`
// and runs in CI. If it actually needs a browser it fails loudly there instead
// of being silently skipped like the previous hand-maintained package.json list.
//
// Usage:
//   node qa/test-manifest.cjs unit      print unit-group files (one per line)
//   node qa/test-manifest.cjs ui        print ui-group files
//   node qa/test-manifest.cjs --check   validate manifest vs disk vs package.json
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["src", "electron", "qa"];

// Browser-driven suites. Must stay in sync with the files referenced by the
// qa:* scripts in package.json; `--check` enforces that.
const UI_TESTS = [
  // qa:fullstack:ui
  "qa/frontend-persistence.test.cjs",
  "src/StockMonitorEditor.test.cjs",
  "src/ProfessionalReviewBrowser.test.cjs",
  "qa/personal-monitor-ui.test.cjs",
  "qa/trend-research-tools.test.cjs",
  "qa/research-workspace-v150.test.cjs",
  "qa/frontend-v150.test.cjs",
  "qa/six-audit-frontend.test.cjs",
  "qa/sector-gainers-ui.test.cjs",
  "qa/beijing-workspace.test.cjs",
  "qa/ai-agent-ui.test.cjs",
  "qa/ai-picks-ui.test.cjs",
  "qa/t-assistant-ui.test.cjs",
  "qa/t-toolbox-ui.test.cjs",
  "qa/notes-ui.test.cjs",
  "qa/backup-ui.test.cjs",
  "qa/leaderboard-ui.test.cjs",
  "qa/decision-center-ui.test.cjs",
  // qa:stability:ui
  "qa/stability-ui.test.cjs",
  // qa:sector:ui
  "qa/sector-panel.test.cjs",
  // qa:modules:independent
  "qa/module-polish-independent.test.cjs",
  // qa:ui-remediation
  "qa/ui-remediation.test.cjs",
  // qa:workflow
  "qa/workspace-v145.test.cjs"
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.cjs")) {
      out.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  }
  return out;
}

function discover() {
  const disk = SCAN_DIRS.flatMap(d => walk(path.join(ROOT, d))).sort();
  const ui = new Set(UI_TESTS);
  const unit = disk.filter(f => !ui.has(f));
  return { disk, ui: [...ui].sort(), unit };
}

function collectScriptFiles(pkg, scriptNames) {
  const files = new Set();
  for (const name of scriptNames) {
    const script = pkg.scripts[name] || "";
    for (const m of script.match(/[\w./-]+\.test\.cjs/g) || []) files.add(m);
  }
  return files;
}

function check() {
  const { disk, ui } = discover();
  const pkg = require(path.join(ROOT, "package.json"));
  const problems = [];

  const diskSet = new Set(disk);
  for (const f of ui) {
    if (!diskSet.has(f)) problems.push(`UI manifest entry does not exist on disk: ${f}`);
  }

  const uiScriptFiles = collectScriptFiles(pkg, [
    "qa:fullstack:ui", "qa:stability:ui", "qa:sector:ui",
    "qa:modules:independent", "qa:ui-remediation", "qa:workflow"
  ]);
  const uiSet = new Set(ui);
  for (const f of uiScriptFiles) {
    if (!uiSet.has(f)) problems.push(`${f} is run by a qa:*:ui script but missing from the manifest UI list`);
  }
  for (const f of uiSet) {
    if (!uiScriptFiles.has(f)) problems.push(`${f} is declared as UI in the manifest but no qa:*:ui script runs it`);
  }

  if (problems.length) {
    console.error("test-manifest check failed:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`test-manifest ok: ${disk.length} test files (${ui.length} ui, ${disk.length - ui.length} unit)`);
}

const arg = process.argv[2];
if (arg === "--check") {
  check();
} else if (arg === "unit") {
  console.log(discover().unit.join("\n"));
} else if (arg === "ui") {
  console.log(discover().ui.join("\n"));
} else {
  console.error("usage: node qa/test-manifest.cjs unit|ui|--check");
  process.exit(2);
}
