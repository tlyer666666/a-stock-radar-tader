#!/usr/bin/env node
"use strict";
// Runs the hermetic (node:test) unit group from qa/test-manifest.cjs.
// Replaces the previous hand-maintained file list in package.json's `test`
// script: every *.test.cjs on disk that is not declared as a browser suite is
// executed here, so new tests can no longer be silently orphaned.
const { spawnSync, execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const files = execFileSync(process.execPath, [path.join(__dirname, "test-manifest.cjs"), "unit"], { cwd: root, encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

if (!files.length) throw new Error("test manifest returned no unit test files");

const result = spawnSync(
  process.execPath,
  ["--require", "./qa/test-env.cjs", "--test", ...files],
  { stdio: "inherit", cwd: root }
);
process.exit(result.status ?? 1);
