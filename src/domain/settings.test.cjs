"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../../qa/register-typescript.cjs");
const { createHarness } = require("../../qa/main-ipc-test-harness.cjs");

let settings;
let restoreTypeScript;
let main;

before(() => {
  restoreTypeScript = registerTypeScript();
  settings = require("./settings.ts");
  main = createHarness();
});

after(() => { main?.cleanup(); restoreTypeScript?.(); });

function assertMainContract(input) {
  const actual = settings.normalizeSettings(input);
  // The real main-process normalizer is a separate authority, executed without
  // Electron startup, providers or any access to the user's profile.
  assert.deepEqual(actual, structuredClone(main.normalizeSettings(input)));
  return actual;
}

test("renderer settings preserve the full legal default and risk preset contracts", () => {
  assert.deepEqual(assertMainContract(settings.initialSettings), settings.initialSettings);
  for (const preset of settings.riskProfilePresets) {
    assertMainContract({ ...settings.initialSettings, ...preset.settings, riskProfile: preset.id });
  }
});

test("renderer settings reject non-object schemas and match main missing-field defaults", () => {
  for (const input of [undefined, null, [], ["unexpected"], false, true, 42, "dark", {}]) {
    const actual = assertMainContract(input);
    assert.equal(actual.provider, "ths");
    assert.equal(actual.stopLossATRMultiple, 2);
    assert.equal(actual.takeProfitATRMultiple, 2.4);
    assert.equal(actual.refreshToken, "");
  }
});

test("renderer numeric settings match main for undefined, null, malformed and clamped values", () => {
  const numericKeys = Object.keys(settings.initialSettings).filter(key => typeof settings.initialSettings[key] === "number");
  for (const value of [undefined, null, "bad", "", "3", -1e12, 1e12, -Infinity, Infinity, NaN]) {
    for (const key of numericKeys) assertMainContract({ ...settings.initialSettings, [key]: value });
  }
  assert.equal(assertMainContract({ ...settings.initialSettings, stopLossATRMultiple: "bad" }).stopLossATRMultiple, 2);
  assert.equal(assertMainContract({ ...settings.initialSettings, maxDailyRiskPercent: null }).maxDailyRiskPercent, 0.3);
  const limits = assertMainContract({ ...settings.initialSettings, quoteRefreshSeconds: 20, maxHoldingBars: 120,
    stopLossATRMultiple: 5, takeProfitATRMultiple: 2, maxOpenPositions: 10, minProjectedNetEdgePercent: -2 });
  assert.equal(limits.takeProfitATRMultiple, 5.4);
  assert.equal(limits.quoteRefreshSeconds, 20);
  assert.equal(limits.maxHoldingBars, 120);
});

test("renderer boolean settings require true for gates and only false disables default-on options", () => {
  const gates = ["exactNodesOnly", "strictGate"];
  const defaultOn = ["multiSourceEnabled", "fallbackEnabled", "newsVoiceEnabled", "enabledPaperSim"];
  for (const value of [undefined, null, true, false, "false", "true", 0, 1, [], {}]) {
    const actual = assertMainContract({ ...settings.initialSettings, ...Object.fromEntries([...gates, ...defaultOn].map(key => [key, value])) });
    for (const key of gates) assert.equal(actual[key], value === true);
    for (const key of defaultOn) assert.equal(actual[key], value !== false);
  }
});

test("renderer token and enum settings reject coercion of malformed storage values", () => {
  for (const value of [undefined, null, 123, true, [], {}, "", "edited-token", "••••••••••••"]) {
    const actual = assertMainContract({ ...settings.initialSettings, refreshToken: value, tushareToken: value,
      theme: value, riskProfile: value, provider: value });
    assert.equal(actual.refreshToken, typeof value === "string" ? value : "");
    assert.equal(actual.tushareToken, typeof value === "string" ? value : "");
  }
  for (const theme of ["light", "dark", "system"]) assert.equal(assertMainContract({ theme }).theme, theme);
  for (const riskProfile of ["conservative", "balanced", "aggressive"]) assert.equal(assertMainContract({ riskProfile }).riskProfile, riskProfile);
});

test("renderer strategy IDs trim, cap, remove empty entries and dedupe before risk veto", () => {
  for (const selectedStrategies of [undefined, null, "trend", [], [null, 2], [""], ["riskVeto", "riskVeto"]]) {
    assertMainContract({ ...settings.initialSettings, selectedStrategies });
  }
  const longId = "x".repeat(64);
  const actual = assertMainContract({ ...settings.initialSettings,
    selectedStrategies: [" trend ", "trend", "", "   ", `${longId}a`, `${longId}b`, " riskVeto ", null] });
  assert.deepEqual(actual.selectedStrategies, ["trend", longId, "riskVeto"]);
});

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
