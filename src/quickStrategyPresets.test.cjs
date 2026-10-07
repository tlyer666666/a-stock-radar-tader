"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let settings;
let quickStrategyPresets;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  settings = require("./domain/settings.ts");
  ({ quickStrategyPresets } = require("./quickStrategyPresets.ts"));
});

after(() => restoreTypeScript?.());

test("expanded quick choices remain distinct after the real settings normalization", () => {
  assert.ok(quickStrategyPresets.length >= settings.strategyPresets.length + 8,
    "add at least eight independently selectable combinations");
  const knownStrategies = new Set(settings.strategyOptions.map((item) => item.id));
  const ids = new Set();
  const signatures = new Set();
  for (const preset of quickStrategyPresets) {
    assert.ok(!ids.has(preset.id), `duplicate menu identity: ${preset.id}`);
    ids.add(preset.id);
    assert.ok(preset.strategies.includes("riskVeto"), `${preset.id} must retain the risk gate`);
    assert.equal(new Set(preset.strategies).size, preset.strategies.length, preset.id);
    for (const strategy of preset.strategies) {
      assert.ok(knownStrategies.has(strategy), `${preset.id} uses unsupported factor ${strategy}`);
    }
    const normalized = settings.normalizeSettings({
      ...settings.initialSettings,
      selectedStrategies: preset.strategies
    });
    assert.deepEqual(normalized.selectedStrategies, preset.strategies,
      `${preset.id} must survive persistence normalization unchanged`);
    const signature = [...normalized.selectedStrategies].sort().join("|");
    assert.ok(!signatures.has(signature), `${preset.id} duplicates an existing choice`);
    signatures.add(signature);
  }
});

test("saved selections still resolve to their original quick-combination identity", () => {
  for (const original of settings.strategyPresets) {
    const recognized = quickStrategyPresets.find((preset) =>
      settings.sameStrategySet([...original.strategies].reverse(), preset.strategies));
    assert.ok(recognized, `missing saved selection: ${original.id}`);
    assert.equal(recognized.id, original.id);
    assert.equal(recognized.name, original.name);
  }
});

test("quick choices expose every available factor without contradictory volume requirements", () => {
  const coveredFactors = new Set(quickStrategyPresets.flatMap((preset) => preset.strategies));
  for (const option of settings.strategyOptions) {
    assert.ok(coveredFactors.has(option.id), `no quick choice exposes ${option.id}`);
  }
  for (const preset of quickStrategyPresets) {
    assert.ok(!(preset.strategies.includes("contraction") && preset.strategies.includes("secondBreakout")),
      `${preset.id} requires both shrinking volume and expanding breakout volume`);
    assert.ok(preset.strategies.some((id) => id !== "riskVeto" && id !== "exactNode"),
      `${preset.id} has gates but no scoring factor`);
  }
});
