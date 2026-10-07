"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
let plan;
let restoreTypeScript;
before(() => { restoreTypeScript = registerTypeScript(); plan = require("./trendPlan.ts"); });
after(() => restoreTypeScript?.());

function position(overrides = {}) {
  return { netAssetValue: 100000, entryPrice: 10, stopPrice: 9.5, maxEntryPrice: 10.2,
    industryExposureRatio: 0, portfolioExposureRatio: 0, openPositions: 0,
    cashAvailable: 100000, feeReserve: 0, minimumBuyQuantity: 100, quantityStep: 100,
    alreadyHeld: false, permissionVerified: true, announcementVerified: true,
    corporateActionAligned: true, marketGate: "open", ...overrides };
}
function exit(overrides = {}) {
  return { stopPrice: 9.5, holdingTradingDays: 2, close: 10, ma20: 9.8,
    previousClose: 10, previousMa20: 9.8, corporateActionAligned: true, ...overrides };
}

test("Word example sizes a 5% stop to 10% of NAV and a 0.5% planned loss", () => {
  const result = plan.calculateTrendPosition(position());
  assert.equal(result.eligible, true);
  assert.equal(result.shares, 1000);
  assert.equal(result.cost, 10000);
  assert.equal(result.plannedLoss, 500);
  assert.equal(result.riskBudget, 500);
  assert.equal(result.positionRatio, 0.1);
});

test("risk, single-stock, industry and total position caps each independently constrain quantity", () => {
  assert.equal(plan.calculateTrendPosition(position({ stopPrice: 9.9 })).shares, 1500);
  assert.equal(plan.calculateTrendPosition(position({ industryExposureRatio: 0.24 })).shares, 100);
  assert.equal(plan.calculateTrendPosition(position({ portfolioExposureRatio: 0.58 })).shares, 200);
  assert.equal(plan.calculateTrendPosition(position({ entryPrice: 10, stopPrice: 9.2 })).shares, 600);
});

test("fees and available cash are reserved before rounding to verified quantity rules", () => {
  assert.equal(plan.calculateTrendPosition(position({ feeReserve: 5 })).shares, 900);
  assert.equal(plan.calculateTrendPosition(position({ feeReserve: 5, cashAvailable: 3500 })).shares, 300);
  assert.equal(plan.calculateTrendPosition(position({ feeReserve: 5, minimumBuyQuantity: 200, quantityStep: 1 })).shares, 999);
  const small = plan.calculateTrendPosition(position({ cashAvailable: 999, feeReserve: 5 }));
  assert.equal(small.eligible, false);
  assert.equal(small.shares, 0);
});

test("six positions, an existing same-stock holding or exhausted caps block new plans", () => {
  for (const values of [{ openPositions: 6 }, { alreadyHeld: true },
    { industryExposureRatio: 0.25 }, { portfolioExposureRatio: 0.6 }]) {
    const result = plan.calculateTrendPosition(position(values));
    assert.equal(result.eligible, false);
    assert.equal(result.shares, 0);
    assert.ok(result.reasons.length > 0);
  }
});

test("unverified permission, announcement, corporate-action basis and market gate fail closed", () => {
  for (const values of [{ permissionVerified: false }, { announcementVerified: false },
    { corporateActionAligned: false }, { marketGate: "blocked" }, { marketGate: "unknown" }]) {
    assert.equal(plan.calculateTrendPosition(position(values)).eligible, false);
  }
});

test("entry must be strictly above frozen stop, at most Pmax and at most 8% planned stop distance", () => {
  for (const values of [{ entryPrice: 9.5 }, { entryPrice: 9.4 }, { entryPrice: 10.21 },
    { entryPrice: 10.4, maxEntryPrice: 11, stopPrice: 9.5 }]) {
    assert.equal(plan.calculateTrendPosition(position(values)).eligible, false);
  }
  assert.equal(plan.calculateTrendPosition(position({ entryPrice: 10.2 })).eligible, true);
});

test("missing or invalid inputs never become a seemingly valid quantity", () => {
  for (const values of [{ netAssetValue: 0 }, { cashAvailable: -1 }, { feeReserve: -1 },
    { minimumBuyQuantity: 0 }, { quantityStep: 0 }, { openPositions: 1.5 },
    { industryExposureRatio: -0.1 }, { portfolioExposureRatio: NaN },
    { permissionVerified: undefined }, { announcementVerified: undefined }]) {
    const result = plan.calculateTrendPosition(position(values));
    assert.equal(result.eligible, false);
    assert.equal(result.shares, 0);
    assert.ok(Number.isFinite(result.budget));
  }
});

test("a close below frozen S exits next open even before the target holding period", () => {
  assert.equal(plan.evaluateTrendExit(exit({ holdingTradingDays: 1, close: 9.49 })).action, "exit-next-open");
  assert.equal(plan.evaluateTrendExit(exit({ close: 9.5, ma20: 9.5 })).action, "hold");
});

test("MA exit requires two consecutive post-entry closes strictly below each corresponding MA20", () => {
  assert.equal(plan.evaluateTrendExit(exit({ close: 9.8, ma20: 10, previousClose: 9.9, previousMa20: 10 })).action, "exit-next-open");
  assert.equal(plan.evaluateTrendExit(exit({ holdingTradingDays: 1, close: 9.8, ma20: 10, previousClose: 9.9, previousMa20: 10 })).action, "hold");
  assert.equal(plan.evaluateTrendExit(exit({ close: 9.8, ma20: 10, previousClose: 10, previousMa20: 10 })).action, "hold");
});

test("entry day counts as day one; 29th closing session plans exit at the next open", () => {
  assert.equal(plan.evaluateTrendExit(exit({ holdingTradingDays: 28 })).action, "hold");
  assert.equal(plan.evaluateTrendExit(exit({ holdingTradingDays: 29 })).action, "exit-next-open");
  assert.equal(plan.evaluateTrendExit(exit({ holdingTradingDays: 32 })).action, "exit-next-open");
});

test("multiple exit triggers combine into one action and never mutate the frozen stop", () => {
  const input = exit({ holdingTradingDays: 29, close: 9.4, ma20: 10, previousClose: 9.8, previousMa20: 10 });
  const result = plan.evaluateTrendExit(input);
  assert.equal(result.action, "exit-next-open");
  assert.equal(result.reasons.length, 3);
  assert.equal(input.stopPrice, 9.5);
});

test("unknown session counts, missing required MA observations or price-basis mismatch cannot say hold", () => {
  for (const values of [{ holdingTradingDays: 0 }, { holdingTradingDays: 1.5 },
    { ma20: NaN }, { close: 9.8, ma20: 10, previousClose: undefined },
    { corporateActionAligned: false }]) {
    assert.equal(plan.evaluateTrendExit(exit(values)).action, "needs-data");
  }
});
