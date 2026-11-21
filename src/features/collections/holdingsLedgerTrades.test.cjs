"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

const restoreTypeScript = registerTypeScript();
const L = require("./holdingsLedger.ts");
after(restoreTypeScript);

const memory = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); } }; };
const holding = (extra = {}) => ({ code: "600519", name: "贵州茅台", secid: "1.600519", shares: 1000, costPrice: 10, note: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra });
const sell = (i, realizedPnl) => ({ id: `t${i}`, tradedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), code: "600519", name: "x", side: "sell", shares: 100, price: 10, realizedPnl });

test("trades beyond the detail cap keep their realized PnL and win count in the cumulative summary", () => {
  const storage = memory();
  const total = L.MAX_HOLDING_TRADES + 5;
  for (let i = 0; i < total; i += 1) L.appendHoldingTradeRecord(sell(i, i === 0 ? 5000 : 1), storage);
  const ledger = L.loadHoldingTradeLedger(storage);
  assert.equal(ledger.records.length, L.MAX_HOLDING_TRADES);
  const summary = L.summarizeHoldingTrades(ledger.records, ledger.archived);
  assert.equal(summary.totalCount, total);
  assert.equal(summary.sellCount, total);
  assert.equal(summary.winCount, total);
  assert.equal(summary.cumulativeRealizedPnl, 5000 + (total - 1));
});

test("a storage failure is reported instead of pretending the trade was recorded", () => {
  const broken = { getItem: () => "[]", setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.throws(() => L.appendHoldingTradeRecord({ code: "600519", name: "x", side: "buy", shares: 100, price: 10, realizedPnl: null }, broken), /成交流水未能保存/);
});

test("the legacy plain-array ledger format still loads", () => {
  const storage = memory();
  storage.setItem(L.HOLDING_TRADES_STORAGE_KEY, JSON.stringify([sell(1, 20)]));
  const ledger = L.loadHoldingTradeLedger(storage);
  assert.equal(ledger.records.length, 1);
  assert.equal(L.summarizeHoldingTrades(ledger.records, ledger.archived).cumulativeRealizedPnl, 20);
});

test("selling reduces the broker-reported sellable shares; buying today does not add sellable shares", () => {
  const sold = L.applyHoldingTrade({ items: [holding({ sellableShares: 700 })], code: "600519", side: "sell", shares: 600, price: 11 });
  assert.equal(sold.nextItems[0].shares, 400);
  assert.equal(sold.nextItems[0].sellableShares, 100);
  const bought = L.applyHoldingTrade({ items: [holding({ sellableShares: 700 })], code: "600519", side: "buy", shares: 500, price: 9 });
  assert.equal(bought.nextItems[0].sellableShares, 700);
  const noBroker = L.applyHoldingTrade({ items: [holding()], code: "600519", side: "sell", shares: 100, price: 11 });
  assert.equal(noBroker.nextItems[0].sellableShares, undefined);
});

test("a profitable sell folded into cost counts as a win and is reported separately from realized PnL", () => {
  const result = L.applyHoldingTrade({ items: [holding()], code: "600519", side: "sell", shares: 500, price: 12, diluteCost: true });
  assert.equal(result.realizedPnl, 0);
  assert.equal(result.dilutedPnl, 1000);
  const summary = L.summarizeHoldingTrades([{ ...sell(1, result.realizedPnl), shares: 500, price: 12, dilutedPnl: result.dilutedPnl }]);
  assert.equal(summary.sellCount, 1);
  assert.equal(summary.winCount, 1);
  assert.equal(summary.cumulativeRealizedPnl, 0);
  assert.equal(summary.cumulativeDilutedPnl, 1000);
});

test("clearing the ledger also clears the archived totals", () => {
  const storage = memory();
  for (let i = 0; i < L.MAX_HOLDING_TRADES + 2; i += 1) L.appendHoldingTradeRecord(sell(i, 1), storage);
  L.clearHoldingTrades(storage);
  const ledger = L.loadHoldingTradeLedger(storage);
  assert.equal(L.summarizeHoldingTrades(ledger.records, ledger.archived).totalCount, 0);
});

test("clampHoldingCostPrice rounds to 3 decimals and enforces the 0.001 RMB floor across all callers", () => {
  assert.equal(L.clampHoldingCostPrice(12.3456), 12.346);
  assert.equal(L.clampHoldingCostPrice(0), 0.001);
  assert.equal(L.clampHoldingCostPrice(-8.5), 0.001);
  assert.equal(L.clampHoldingCostPrice(Number.NaN), 0.001);
});
