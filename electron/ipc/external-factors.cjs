"use strict";

const {
  compactExternalSnapshot,
  normalizeExternalFactorStore,
  mergeExternalFactorSnapshot,
  computeRegimeWeightProfile
} = require("../strategy-intelligence.cjs");

const STORE_NAME = "external-factors-history";

const isExternalFactorStore = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && value.snapshots && typeof value.snapshots === "object";

function createExternalFactorArchive({ readJson, writeJson }) {
  const readStore = () => normalizeExternalFactorStore(readJson(STORE_NAME, { version: 1, snapshots: {} }, isExternalFactorStore));

  const recordSnapshot = ({ review = null, sectorBoard = null } = {}) => {
    try {
      const snap = compactExternalSnapshot({ review, sectorBoard });
      if (!snap) return null;
      const current = readStore();
      const next = mergeExternalFactorSnapshot(current, snap);
      writeJson(STORE_NAME, next, isExternalFactorStore);
      return next;
    } catch {
      return null;
    }
  };

  const summary = () => {
    const store = readStore();
    const dates = Object.keys(store.snapshots).sort().reverse();
    const latestDate = dates[0] || "";
    const latestSnapshot = latestDate ? store.snapshots[latestDate] : null;
    return {
      days: dates.length,
      latestDate,
      latestSnapshot,
      regimeAdvice: computeRegimeWeightProfile(latestSnapshot)
    };
  };

  return {
    readStore,
    recordSnapshot,
    summary
  };
}

module.exports = { createExternalFactorArchive };
