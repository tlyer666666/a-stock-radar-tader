"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let engine;
let restoreTypeScript;
before(() => { restoreTypeScript = registerTypeScript(); engine = require("./tEngine.ts"); });
after(() => restoreTypeScript?.());

const slotTime = slot => {
  const minutes = slot <= 120 ? 9 * 60 + 30 + slot : 13 * 60 + (slot - 120);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};
/** 用价格序列造一份分时：每分钟等量成交，均价为累计平均价。 */
function share(prices, { preClose = 10, volumes } = {}) {
  let sum = 0;
  const points = prices.map((price, slot) => {
    sum += price;
    return { slot, time: slotTime(slot), price, average: sum / (slot + 1), volume: volumes ? volumes[slot] : 100, amount: null, changePercent: (price / preClose - 1) * 100, rising: true };
  });
  return { date: "2026-11-09", preClose, preCloseSource: "source", points, high: Math.max(...prices), low: Math.min(...prices), scale: { min: 9, max: 11, maxPercent: 10 }, totalVolume: 0, totalAmount: null };
}
const config = (overrides = {}) => engine.normalizeTConfig({ baseShares: 3000, sellableShares: 3000, costPrice: 10.5, tShares: 1000, style: "balanced", minSpreadPct: 1, ...overrides }, "600000");
const ctx = { code: "600000", name: "浦发银行" };

test("震荡日：回放能在冲高时卖出、回落时接回，并且赚钱", () => {
  const prices = Array.from({ length: 200 }, (_, i) => Number((10 + 0.18 * Math.sin(i / 9)).toFixed(2)));
  const replay = engine.replayT(share(prices), ctx, config());
  assert.ok(replay.markers.some(marker => marker.side === "sell"), "应出现高抛");
  assert.ok(replay.markers.some(marker => marker.side === "buy"), "应出现接回或低吸");
  assert.ok(replay.rounds >= 1);
  assert.ok(replay.realized > 0, `模拟盈亏应为正，实际 ${replay.realized}`);
});

test("单边上涨日：不给倒T高抛信号", () => {
  const prices = Array.from({ length: 180 }, (_, i) => Number((10 + i * 0.004 + (i % 3 === 0 ? 0.01 : 0)).toFixed(2)));
  const replay = engine.replayT(share(prices), ctx, config());
  assert.equal(replay.markers.filter(marker => marker.side === "sell" && marker.label.startsWith("高抛")).length, 0);
  const now = engine.analyzeT(share(prices), ctx, config(), []);
  assert.equal(now.regime, "up");
});

test("登记成交：倒T一卖一买算出盈亏、手续费和降低后的成本", () => {
  const { open, stats } = engine.settleTrades([
    { id: "1", side: "sell", price: 10.5, shares: 1000, time: "10:05" },
    { id: "2", side: "buy", price: 10.2, shares: 1000, time: "13:40" }
  ], config());
  assert.equal(open, null);
  assert.equal(stats.rounds, 1);
  assert.ok(stats.fees > 10 && stats.fees < 20, `手续费 ${stats.fees}`);
  assert.ok(Math.abs(stats.realized - (300 - stats.fees)) < 1e-6);
  assert.ok(Math.abs(stats.newCost - (10.5 - stats.realized / 3000)) < 1e-9);
});

test("未接回的倒T：14:45 以后提示尾盘接回，股数等于卖出的股数", () => {
  const prices = Array.from({ length: 230 }, (_, i) => Number((10 + 0.05 * Math.sin(i / 7)).toFixed(2)));
  const result = engine.analyzeT(share(prices), ctx, config(), [{ id: "1", side: "sell", price: 10.1, shares: 800, time: "10:30" }]);
  assert.equal(result.open.kind, "reverse");
  assert.equal(result.signal.action, "closeBuyBack");
  assert.equal(result.signal.shares, 800);
});

test("正T买入后：反弹到卖出价并拐头时提示卖出底仓", () => {
  const prices = [...Array.from({ length: 60 }, () => 10), ...Array.from({ length: 20 }, (_, i) => 10 - i * 0.01), ...Array.from({ length: 25 }, (_, i) => 9.81 + i * 0.012), 10.09, 10.07];
  const result = engine.analyzeT(share(prices), ctx, config(), [{ id: "1", side: "buy", price: 9.82, shares: 1000, time: "10:50" }]);
  assert.equal(result.open.kind, "forward");
  assert.equal(result.signal.action, "sellBack");
});

test("没有可卖底仓时不给开仓信号；涨停封板时不做倒T", () => {
  const prices = Array.from({ length: 120 }, (_, i) => Number((10 + 0.2 * Math.sin(i / 8)).toFixed(2)));
  const none = engine.analyzeT(share(prices), ctx, config({ baseShares: 0, sellableShares: 0 }), []);
  assert.equal(none.signal.action, "wait");
  assert.equal(none.signal.title, "先填底仓");
  const sealed = [...Array.from({ length: 100 }, (_, i) => 10 + i * 0.008), ...Array.from({ length: 30 }, () => 11)];
  const result = engine.analyzeT(share(sealed.map(v => Number(v.toFixed(2)))), ctx, config(), []);
  assert.notEqual(result.signal.action, "sell");
});

test("配置归一：可卖不超过底仓，默认每次做T三分之一并按手取整", () => {
  const value = engine.normalizeTConfig({ baseShares: 2500, sellableShares: 9000 }, "600000");
  assert.equal(value.sellableShares, 2500);
  assert.equal(value.tShares, 800);
  assert.equal(engine.normalizeTConfig({ baseShares: 1000 }, "688001").tShares, 333);
});

test("T+1：今天卖出的底仓不再算可卖，卖完后不再提示开新T", () => {
  const prices = Array.from({ length: 150 }, (_, i) => Number((10 + 0.2 * Math.sin(i / 8)).toFixed(2)));
  const trades = [
    { id: "1", side: "sell", price: 10.2, shares: 600, time: "09:45" },
    { id: "2", side: "buy", price: 10.0, shares: 600, time: "10:05" }
  ];
  const result = engine.analyzeT(share(prices), ctx, config({ baseShares: 600, sellableShares: 600, tShares: 600 }), trades);
  assert.equal(result.stats.soldShares, 600);
  assert.equal(result.signal.action, "wait");
  assert.equal(result.signal.title, "可卖底仓已用完");
  const half = engine.analyzeT(share(prices), ctx, config({ baseShares: 900, sellableShares: 900, tShares: 600 }), trades);
  assert.notEqual(half.signal.title, "可卖底仓已用完");
  const replay = engine.replayT(share(prices), ctx, config({ baseShares: 600, sellableShares: 600, tShares: 600 }));
  assert.ok(replay.markers.filter(marker => marker.side === "sell").length <= 1, "回放也只能卖一次");
});

test("倒T卖出后均价线离得远：有最小价差并反弹时提示先接回；亏损了结过的方向当天不再提示", () => {
  // 一路走高到 11.0 卖出，回落到 10.8（均价线还在 10.5 附近）后反弹
  const prices = [...Array.from({ length: 100 }, (_, i) => 10 + i * 0.01), ...Array.from({ length: 20 }, (_, i) => 11 - (i + 1) * 0.01), 10.76, 10.8, 10.84];
  const result = engine.analyzeT(share(prices.map(v => Number(v.toFixed(2)))), ctx, config(), [{ id: "1", side: "sell", price: 11, shares: 1000, time: "11:09" }]);
  assert.ok(result.levels.buyTarget < result.price, "均价线目标还没到");
  assert.equal(result.signal.action, "buyBack");
  const { stats } = engine.settleTrades([
    { id: "1", side: "sell", price: 10, shares: 500, time: "10:00" }, { id: "2", side: "buy", price: 10.3, shares: 500, time: "10:20" },
    { id: "3", side: "buy", price: 10, shares: 500, time: "11:00" }, { id: "4", side: "sell", price: 10.2, shares: 500, time: "11:20" }
  ], config());
  assert.deepEqual(stats.lost, { reverse: true, forward: false });
});
