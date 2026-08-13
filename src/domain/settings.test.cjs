"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../../qa/register-typescript.cjs");

let settings;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  settings = require("./settings.ts");
});

after(() => restoreTypeScript?.());

test("settings normalization keeps the fixed provider and required risk veto", () => {
  const normalized = settings.normalizeSettings({
    ...settings.initialSettings,
    provider: "eastmoney",
    selectedStrategies: ["trend", "trend"],
    quoteRefreshSeconds: 1,
    stopLossATRMultiple: 4.9,
    takeProfitATRMultiple: 1
  });

  assert.equal(normalized.provider, "ths");
  assert.deepEqual(normalized.selectedStrategies, ["trend", "riskVeto"]);
  assert.equal(normalized.quoteRefreshSeconds, 3);
  assert.ok(normalized.takeProfitATRMultiple > normalized.stopLossATRMultiple);
});

test("risk profile presets apply through the same normalization boundary", () => {
  const conservative = settings.buildSettingsByRiskProfile(settings.initialSettings, "conservative");

  assert.equal(conservative.riskProfile, "conservative");
  assert.equal(conservative.maxPositionPercent, 20);
  assert.equal(conservative.maxDailyTrades, 6);
  assert.ok(conservative.selectedStrategies.includes("riskVeto"));
});
