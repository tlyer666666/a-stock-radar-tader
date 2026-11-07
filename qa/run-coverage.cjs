#!/usr/bin/env node
"use strict";
// Run the hermetic suite with the test runner's built-in coverage and enforce the
// floors below. The file list is read from the `test` script so the two cannot drift.
//
// Scope note: this measures the hermetic (Node) suite only. The renderer components
// are additionally exercised by the browser suites (`qa:fullstack:ui`,
// `qa:modules:independent`), which need Chrome and are therefore not part of this run.
//
// Why the line floor is deliberately coarse: measured over three consecutive runs,
// total line coverage ranged 65.4%–68.3%. The whole swing comes from `src/App.tsx`
// (17.25% vs 6.36%), which `src/App.test.cjs` renders through `renderToStaticMarkup`;
// how much of the ~3,200-line component that SSR pass reaches is not stable. Branch and
// function coverage were stable to within 0.02pp across the same runs, so those carry
// the tight floors while lines act as a coarse tripwire. Making the App render path
// deterministic is the real fix and is tracked as a follow-up, not papered over here.
//
// Raise the floors whenever coverage improves; never lower them to make a build pass.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const pkg = require("../package.json");

// 2026-10-24 实测 lines 83.5 / branches 76.9 / functions 82.7：行与函数门槛上调，留出 App.tsx SSR 波动余量。
const FLOORS = { lines: 75, branches: 74, functions: 80 };
const files = pkg.scripts.test.match(/[\w./-]+\.test\.cjs/g) || [];
if (!files.length) throw new Error("no test files found in the `test` script");

const args = [
  "--require", "./qa/test-env.cjs",
  "--test",
  "--experimental-test-coverage",
  "--test-coverage-exclude=**/*.test.cjs",
  `--test-coverage-lines=${FLOORS.lines}`,
  `--test-coverage-branches=${FLOORS.branches}`,
  `--test-coverage-functions=${FLOORS.functions}`,
  ...files
];

const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: path.resolve(__dirname, "..") });
process.exit(result.status ?? 1);
