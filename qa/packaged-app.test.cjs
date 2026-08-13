"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cleanupPackagedScreenshots } = require("./packaged-app.cjs");

const projectRoot = path.resolve(__dirname, "..");

test("packaged E2E removes screenshots left by older package runs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a-stock-e2e-screenshots-"));
  try {
    for (const name of [
      "v068-professional-review-dark.png",
      "packaged-0.9.16-professional-review-light.png",
      "packaged-0.9.17-professional-review-dark.png",
      "packaged-0.9.18-backtest-layout.png",
      "keep-notes.txt"
    ]) {
      fs.writeFileSync(path.join(root, name), name);
    }
    assert.deepEqual(cleanupPackagedScreenshots(root), [
      "packaged-0.9.16-professional-review-light.png",
      "packaged-0.9.17-professional-review-dark.png",
      "packaged-0.9.18-backtest-layout.png",
      "v068-professional-review-dark.png"
    ]);
    assert.deepEqual(fs.readdirSync(root), ["keep-notes.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged E2E runs with the desktop window hidden by default", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  const main = fs.readFileSync(path.join(projectRoot, "electron", "main.cjs"), "utf8");

  assert.match(runner, /PACKAGED_E2E_VISIBLE !== "1"/);
  assert.match(runner, /A_STOCK_E2E_HIDDEN: hiddenE2E \? "1" : "0"/);
  assert.match(runner, /A_STOCK_E2E_USER_DATA: isolatedUserData/);
  assert.match(runner, /a-stock-e2e-/);
  assert.match(runner, /--disable-gpu/);
  assert.match(runner, /Minimize control did not minimize the BrowserWindow/);
  assert.match(runner, /Maximize control did not maximize the BrowserWindow/);
  assert.match(main, /show: !hiddenE2E/);
});
