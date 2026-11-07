"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { simulateSharedAccount } = require("./trend-research-account.cjs");
const calendar = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
const stock = code => ({ security: { code, industry: "A" }, statusHistory: [], rawRows: calendar.map(date => ({ date, close: 10, amount: 1e8 })), rawByDate: new Map(calendar.map(date => [date, { close: 10, amount: 1e8 }])) });
const sample = (code, extra = {}) => ({ code, signalDate: calendar[0], entryDate: calendar[1], entryPrice: 10, plan: { stop: 9 }, status: "censored", exitDate: null, exitPrice: null, ...extra });
const execution = { commissionBps: 0, minCommission: 5, transferFeeBps: 0, sellTaxBps: 0 };
const config = { initialCash: 10005, maxPositionPercent: 1, maxIndustryPercent: 1, maxGrossExposurePercent: 1, maxRiskPercent: 1, riskPerPositionPercent: 1, maxPositions: 6, maxParticipationPercent: 1, gapStressPercent: 0 };
function run(samples, account = {}) { return simulateSharedAccount({ samples, calendar, securities: [stock("600001"), stock("600002")], execution, config: { ...config, ...account } }); }

test("shared account charges minimum commissions inside cash and lot capacity", () => {
  const report = run([sample("600001")]);
  assert.equal(report.trades[0].shares, 1000);
  assert.equal(report.cash, 0);
  assert.equal(report.metrics.modeledFees, 5);
  assert.equal(report.equityCurve.at(-1).equity, 10000);
});
test("cash is shared and unresolved holdings prevent overlapping signals", () => {
  const report = run([sample("600001", { status: "unresolved", reason: "missing_held_bar" }), sample("600002"), sample("600001", { signalDate: calendar[1], entryDate: calendar[2] })]);
  assert.equal(report.trades.length, 1);
  assert.equal(report.metrics.unresolved, 1);
  assert.equal(report.rejections[0].reason, "account_capacity_or_risk");
  assert.equal(report.rejections[1].reason, "already_holding_security");
  assert.equal(report.metrics.completeEquityEvidence, false);
});
test("industry exposure, gross exposure, positions and gap stress risk constrain lots", () => {
  for (const limits of [{ maxIndustryPercent: .15 }, { maxGrossExposurePercent: .15 }, { riskPerPositionPercent: .015 }]) {
    const report = run([sample("600001"), sample("600002")], limits);
    assert.ok(report.trades.reduce((sum, trade) => sum + trade.shares * 10, 0) <= 2000);
  }
  const report = run([sample("600001"), sample("600002")], { maxPositionPercent: .4, maxPositions: 1 });
  assert.equal(report.trades.length, 1);
  assert.equal(report.rejections[0].reason, "max_positions");
});
test("deferred exits retain exposure until actual fill and release cash only then", () => {
  const report = run([sample("600001", { status: "closed", exitDate: calendar[3], exitPrice: 9, delayedExitSessions: 1 }), sample("600001", { signalDate: calendar[1], entryDate: calendar[2] })]);
  assert.equal(report.rejections[0].reason, "already_holding_security");
  assert.equal(report.cash, 8995);
  assert.equal(report.metrics.delayedExitSessions, 1);
  assert.equal(report.metrics.closed, 1);
});

test("shared realized return recomputes fees for actual account-sized trade", () => {
  const report = run([sample("600001", { status: "closed", exitDate: calendar[3], exitPrice: 9 })]);
  assert.equal(report.trades[0].netPnl, -1010);
  assert.ok(Math.abs(report.trades[0].netReturnPercent - (-10.0949525237)) < 1e-6);
});

test("unknown held bars produce explicit stale marks and incomplete equity evidence", () => {
  const security = stock("600001"); security.rawByDate.delete(calendar[2]);
  const report = simulateSharedAccount({ samples: [sample("600001", { status: "unresolved", reason: "missing_held_bar", unresolvedDate: calendar[2] })], calendar, securities: [security], execution, config });
  assert.equal(report.equityCurve[2].staleMarks, 1);
  assert.equal(report.metrics.completeEquityEvidence, false);
  assert.equal(report.holdings[0].markDate, calendar[1]);
});

test("STAR minimum 200 with single-share increments is sized inside shared cash", () => {
  const security = stock("688001");
  const report = simulateSharedAccount({ samples: [sample("688001")], calendar, securities: [security], execution, config: { ...config, initialCash: 2015 } });
  assert.equal(report.trades[0].shares, 201);
  assert.equal(report.cash, 0);
});

test("shared risk reserve includes adverse sell slippage as well as gap stress and both fees", () => {
  const report = simulateSharedAccount({ samples: [sample("600001")], calendar, securities: [stock("600001")], execution: { ...execution, slippageBps: 100 }, config: { ...config, initialCash: 10000, riskPerPositionPercent: .0115 } });
  assert.equal(report.trades.length, 0);
});

test("money rounds half up on the cent instead of losing a cent at the .5 boundary", () => {
  const { money } = require("./trend-research-account.cjs");
  assert.equal(money(2.675), 2.68);
  assert.equal(money(1.005), 1.01);
  assert.equal(money(4.565), 4.57);
  assert.equal(money(1234.565), 1234.57);
  assert.equal(money(5), 5);
  assert.equal(money(0.005), 0.01);
});

test("an unresolved entry remains in coverage and cannot yield complete equity evidence", () => {
  const report = run([sample("600001", { status: "unresolved", entryDate: null, entryPrice: null, reason: "missing_entry_bar" })]);
  assert.equal(report.metrics.independentUnresolved, 1);
  assert.equal(report.metrics.completeEquityEvidence, false);
  assert.equal(report.unenteredSamples[0].reason, "missing_entry_bar");
});
