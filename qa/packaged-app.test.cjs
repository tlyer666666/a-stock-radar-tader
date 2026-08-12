"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cleanupPackagedScreenshots } = require("./packaged-app.cjs");

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
