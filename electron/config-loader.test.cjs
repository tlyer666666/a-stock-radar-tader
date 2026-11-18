"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadConfig, loadNamedConfig, validateAllConfigs, SCHEMAS } = require("./config-loader.cjs");

test("validateAllConfigs validates all 7 bundled config schemas cleanly", () => {
  assert.doesNotThrow(() => validateAllConfigs());
  const calendar = loadNamedConfig("a-share-market-calendar");
  assert.equal(Object.isFrozen(calendar), true);
  assert.equal(Object.isFrozen(calendar.closedRanges), true);
  assert.equal(Object.isFrozen(calendar.closedRanges[0]), true);
  assert.throws(() => { calendar.timezone = "UTC"; }, TypeError);
});

test("loadNamedConfig rejects unregistered names cleanly", () => {
  assert.throws(() => loadNamedConfig("non-existent-config"), /未登记的配置：non-existent-config/);
});

test("loadNamedConfig fails at startup with explicit file & field diagnostics on corrupt or invalid config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-loader-qa-"));
  try {
    fs.writeFileSync(path.join(dir, "trend-quality-robust.json"), "{ invalid json");
    assert.throws(
      () => loadNamedConfig("trend-quality-robust", { dir }),
      /配置 trend-quality-robust\.json 读取\/解析失败/
    );

    fs.writeFileSync(path.join(dir, "trend-quality-robust.json"), JSON.stringify({
      maxExtensionAtr: "bad",
      minCloseLocation: 0.7,
      maxVolumeRatio: 3
    }));
    assert.throws(
      () => loadNamedConfig("trend-quality-robust", { dir }),
      /配置 trend-quality-robust\.json 无效：\$\.maxExtensionAtr 期望有限数字/
    );

    fs.writeFileSync(path.join(dir, "trend-strategy-library.json"), JSON.stringify([{ name: "缺 id" }]));
    assert.throws(
      () => loadNamedConfig("trend-strategy-library", { dir }),
      /配置 trend-strategy-library\.json 无效：\$\[0\]\.id 缺失/
    );

    fs.writeFileSync(path.join(dir, "a-share-market-calendar.json"), JSON.stringify({
      version: 1,
      coveredFrom: "2026-01-01",
      coveredTo: "2026-12-31",
      timezone: "Asia/Shanghai",
      closedRanges: []
    }));
    assert.throws(
      () => loadNamedConfig("a-share-market-calendar", { dir }),
      /配置 a-share-market-calendar\.json 无效：\$\.closedRanges 至少需要 1 项/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAllConfigs clears cache before re-reading from disk", () => {
  assert.equal(typeof loadConfig("trend-quality-balanced", SCHEMAS["trend-quality-balanced"]), "object");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-loader-all-"));
  try {
    const srcDir = path.join(__dirname, "..", "config");
    for (const name of Object.keys(SCHEMAS)) {
      fs.copyFileSync(path.join(srcDir, `${name}.json`), path.join(dir, `${name}.json`));
    }
    assert.doesNotThrow(() => validateAllConfigs(dir));
    fs.writeFileSync(path.join(dir, "trend-quality-balanced.json"), JSON.stringify({ maxExtensionAtr: 2 }));
    assert.throws(() => validateAllConfigs(dir), /trend-quality-balanced\.json 无效/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
