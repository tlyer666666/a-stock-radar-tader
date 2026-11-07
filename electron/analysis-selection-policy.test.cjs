"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
const { evaluateAnalysisPresetRequirements } = require("./analysis-selection-policy.cjs");

let presets;
let restoreTypeScript;
before(() => {
  restoreTypeScript = registerTypeScript();
  ({ quickStrategyPresets: presets } = require("../src/quickStrategyPresets.ts"));
});
after(() => restoreTypeScript?.());

const requirements = {
  steady: ["trend"],
  firstBoard: ["lowFirstBoard", "firstBoardQuality"],
  leader: ["sectorLeader"],
  secondWave: [],
  turnStrong: ["weakToStrong"],
  anchoredTrend: ["trend", "avwap"],
  volumeSupport: ["contraction", "support"],
  breakoutOrigin: ["lowFirstBoard", "originBreakout"],
  compressionWatch: ["vcpCompression"],
  lowBaseAccumulation: ["lowFirstBoard"],
  leaderSupport: ["sectorLeader"],
  sectorBreadth: ["sectorLadder"],
  catalystTrend: ["information", "trend"],
  firstBoardNode: ["firstBoardQuality", "lowFirstBoard"],
  breakoutFollow: ["secondBreakout"]
};
const allMatched = preset => preset.strategies.map(id => ({ id, matched: true }));

test("all fifteen actual quick selections resolve to the intended versioned mandatory requirements", () => {
  assert.equal(presets.length, 15);
  for (const preset of presets) {
    const actual = evaluateAnalysisPresetRequirements(preset.strategies, allMatched(preset));
    assert.equal(actual.policyVersion, "1.1.0", preset.id);
    assert.equal(actual.presetId, preset.id, `${preset.id} factor membership drifted from its production selection`);
    assert.deepEqual(actual.requiredAll, requirements[preset.id], preset.id);
    assert.deepEqual(actual.requiredAnyGroups, preset.id === "secondWave" ? [["vcpCompression", "secondBreakout"]] : [], preset.id);
    assert.equal(actual.passed, true, preset.id);
    assert.deepEqual(actual.missingFactors, [], preset.id);
  }
});

test("a named core cannot be substituted by a high percentage of the remaining factors", () => {
  for (const preset of presets) {
    for (const requiredId of requirements[preset.id]) {
      const results = allMatched(preset).map(row => row.id === requiredId ? { ...row, matched: false } : row);
      const actual = evaluateAnalysisPresetRequirements(preset.strategies, results);
      assert.equal(actual.passed, false, `${preset.id} accepted missing ${requiredId}`);
      assert.deepEqual(actual.missingFactors, [requiredId], preset.id);
    }
  }
});

test("second-wave continuation accepts compression or breakout without requiring opposite phases together", () => {
  const preset = presets.find(row => row.id === "secondWave");
  for (const matchedId of ["vcpCompression", "secondBreakout"]) {
    const results = allMatched(preset).map(row => ["vcpCompression", "secondBreakout"].includes(row.id)
      ? { ...row, matched: row.id === matchedId } : row);
    assert.equal(evaluateAnalysisPresetRequirements(preset.strategies, results).passed, true, matchedId);
  }
  const neither = allMatched(preset).map(row => ["vcpCompression", "secondBreakout"].includes(row.id)
    ? { ...row, matched: false } : row);
  const denied = evaluateAnalysisPresetRequirements(preset.strategies, neither);
  assert.equal(denied.passed, false);
  assert.deepEqual(denied.missingFactors, ["vcpCompression", "secondBreakout"]);
});

test("policy identity ignores selection order, duplicate selections and the separate risk veto", () => {
  for (const preset of presets) {
    const selected = [...preset.strategies].reverse().filter(id => id !== "riskVeto");
    selected.push(selected[0]);
    const actual = evaluateAnalysisPresetRequirements(selected, allMatched(preset));
    assert.equal(actual.presetId, preset.id);
    assert.equal(actual.passed, true);
  }
});

test("custom factor sets never acquire a named preset's additional policy", () => {
  const examples = [undefined, null, [], ["riskVeto"], ["lowFirstBoard", "riskVeto"],
    ["support", "avwap", "trend", "volatility", "riskVeto", "customFactor"],
    ["support", "avwap", "trend", "riskVeto"], ["support", "avwap", "trend", "volatility", "riskVeto", null]];
  for (const selected of examples) {
    assert.deepEqual(evaluateAnalysisPresetRequirements(selected, []), {
      policyVersion: "1.1.0", presetId: null, passed: true,
      requiredAll: [], requiredAnyGroups: [], missingFactors: []
    });
  }
});

test("missing, unknown and truthy non-boolean results cannot satisfy a mandatory factor", () => {
  const preset = presets.find(row => row.id === "anchoredTrend");
  for (const result of [undefined, null, false, 1, "true", {}, { matched: true }]) {
    const results = allMatched(preset).filter(row => row.id !== "trend");
    if (result !== undefined) results.push({ id: "trend", matched: result });
    const actual = evaluateAnalysisPresetRequirements(preset.strategies, results);
    assert.equal(actual.passed, false);
    assert.deepEqual(actual.missingFactors, ["trend"]);
  }
  assert.equal(evaluateAnalysisPresetRequirements(preset.strategies, null).passed, false);
});

test("contradictory duplicate evidence cannot turn an unknown required factor into a pass", () => {
  const preset = presets.find(row => row.id === "leader");
  for (const results of [
    [...allMatched(preset), { id: "sectorLeader", matched: null }],
    [{ id: "sectorLeader", matched: false }, ...allMatched(preset)]
  ]) {
    const actual = evaluateAnalysisPresetRequirements(preset.strategies, results);
    assert.equal(actual.passed, false);
    assert.deepEqual(actual.missingFactors, ["sectorLeader"]);
  }
});

test("evaluation preserves its inputs and returning mutable evidence cannot change future policy", () => {
  const preset = presets.find(row => row.id === "firstBoard");
  const selected = Object.freeze([...preset.strategies]);
  const results = Object.freeze(allMatched(preset).map(Object.freeze));
  const actual = evaluateAnalysisPresetRequirements(selected, results);
  actual.requiredAll.length = 0;
  actual.missingFactors.push("invented");
  const next = evaluateAnalysisPresetRequirements(selected, results);
  assert.deepEqual(next.requiredAll, ["lowFirstBoard", "firstBoardQuality"]);
  assert.deepEqual(next.missingFactors, []);
  const secondWave = presets.find(row => row.id === "secondWave");
  const wave = evaluateAnalysisPresetRequirements(secondWave.strategies, allMatched(secondWave));
  wave.requiredAnyGroups[0].length = 0;
  assert.deepEqual(evaluateAnalysisPresetRequirements(secondWave.strategies, []).requiredAnyGroups,
    [["vcpCompression", "secondBreakout"]]);
});
