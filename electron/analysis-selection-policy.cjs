"use strict";

// This policy supplements the existing percentage, risk and exact-node gates.
// Only an exact named quick-selection set opts into its mandatory shape rules.
// Membership is checked against the real TS quick presets in the contract test.
const definitions = [
  ["steady", ["support", "avwap", "trend", "contraction", "sector", "sectorLadder"], ["trend"]],
  ["firstBoard", ["firstBoardQuality", "lowFirstBoard", "support", "sectorLadder"], ["lowFirstBoard", "firstBoardQuality"]],
  ["leader", ["sectorLeader", "sector", "sectorLadder", "information", "marketEmotion", "support"], ["sectorLeader"]],
  ["secondWave", ["originBreakout", "vcpCompression", "chipLock", "secondBreakout", "support"], [], [["vcpCompression", "secondBreakout"]]],
  ["turnStrong", ["weakToStrong", "avwap", "sector", "marketEmotion", "volatility"], ["weakToStrong"]],
  ["anchoredTrend", ["support", "avwap", "trend", "volatility"], ["trend", "avwap"]],
  ["volumeSupport", ["support", "avwap", "contraction", "volatility"], ["contraction", "support"]],
  ["breakoutOrigin", ["lowFirstBoard", "originBreakout", "support", "avwap"], ["lowFirstBoard", "originBreakout"]],
  ["compressionWatch", ["vcpCompression", "chipLock", "contraction", "support", "volatility"], ["vcpCompression"]],
  ["lowBaseAccumulation", ["lowFirstBoard", "chipLock", "contraction", "support", "avwap"], ["lowFirstBoard"]],
  ["leaderSupport", ["sectorLeader", "sector", "avwap", "contraction", "support"], ["sectorLeader"]],
  ["sectorBreadth", ["sector", "sectorLadder", "marketEmotion", "trend", "volatility"], ["sectorLadder"]],
  ["catalystTrend", ["information", "trend", "avwap", "sector", "support"], ["information", "trend"]],
  ["firstBoardNode", ["firstBoardQuality", "lowFirstBoard", "exactNode", "avwap", "support"], ["firstBoardQuality", "lowFirstBoard"]],
  ["breakoutFollow", ["secondBreakout", "trend", "avwap", "sectorLeader", "volatility", "support"], ["secondBreakout"]]
];

function selectionKey(ids) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) return null;
  return JSON.stringify([...new Set(ids.filter(id => id !== "riskVeto"))].sort());
}

const bySelection = new Map(definitions.map(([id, factors, requiredAll, requiredAnyGroups = []]) => [
  selectionKey(factors), { id, requiredAll, requiredAnyGroups }
]));

function evaluateAnalysisPresetRequirements(selectedIds, results) {
  const definition = bySelection.get(selectionKey(selectedIds));
  const requiredAll = definition ? [...definition.requiredAll] : [];
  const requiredAnyGroups = definition ? definition.requiredAnyGroups.map(group => [...group]) : [];
  const matches = new Map();
  for (const row of Array.isArray(results) ? results : []) {
    if (typeof row?.id !== "string") continue;
    const matched = row.matched === true;
    matches.set(row.id, matched && (!matches.has(row.id) || matches.get(row.id)));
  }
  const missingFactors = requiredAll.filter(id => matches.get(id) !== true);
  for (const group of requiredAnyGroups) {
    if (!group.some(id => matches.get(id) === true)) missingFactors.push(...group);
  }
  return {
    policyVersion: "1.1.0", presetId: definition?.id ?? null,
    passed: missingFactors.length === 0,
    requiredAll, requiredAnyGroups, missingFactors: [...new Set(missingFactors)]
  };
}

/** The exact named quick-selection preset for a factor set (riskVeto ignored), or null for a free combination. */
function presetForSelection(selectedIds) {
  const definition = bySelection.get(selectionKey(selectedIds));
  return definition ? { id: definition.id, requiredAll: [...definition.requiredAll], requiredAnyGroups: definition.requiredAnyGroups.map(group => [...group]) } : null;
}

module.exports = { evaluateAnalysisPresetRequirements, presetForSelection };
