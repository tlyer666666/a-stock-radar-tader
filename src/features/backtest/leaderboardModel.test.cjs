"use strict";
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
let model, restore;
before(() => { restore = registerTypeScript(); model = require("./leaderboardModel.ts"); });
after(() => restore?.());

const row = (id, patch = {}) => ({ id, name: id, horizons: { "5": { sampleCount: 40, winRate: 55, averageReturn: 2, medianReturn: 1, dayWeightedEdge: 1.2, edgeVsBaseline: 1.1, comparedSignalDays: 20 }, "10": { sampleCount: 30, winRate: 50, averageReturn: 3, medianReturn: 2, dayWeightedEdge: 0.5 }, "20": { sampleCount: 20, winRate: 48, averageReturn: 4, medianReturn: 3, dayWeightedEdge: -0.2 } }, verdict: { level: "ahead", text: "多数持有期跑赢基线" }, ...patch });

test("排序、结论标签与排行语句", () => {
  const rows = [row("a", { rank: 1 }), row("b", { rank: 2, horizons: { "5": { sampleCount: 30, winRate: 40, averageReturn: -1, medianReturn: -0.5, dayWeightedEdge: -0.5 } } }), row("c", { rank: 3, horizons: {} })];
  assert.deepEqual(model.sortLeaderboardRows(rows, { column: "edge", direction: "desc" }).map(r => r.id), ["a", "b", "c"]);
  assert.deepEqual(model.sortLeaderboardRows(rows, { column: "winRate", direction: "asc" }).map(r => r.id), ["b", "a", "c"]);
  assert.equal(model.verdictLabel("strong").text, "稳定跑赢");
  assert.equal(model.verdictLabel("insufficient").text, "样本不足");
  assert.equal(model.verdictLabel("x").tone, "muted");
});

test("排行语句：指出最稳的一套、跑赢与跑输数量", () => {
  const report = { stockCount: 5120, primaryHorizon: 5, window: { from: "2025-11-24", to: "2026-11-13" },
    strategies: [
      { ...row("deepBase", { name: "深跌底部首板" }), verdict: { level: "strong", text: "" } },
      { ...row("other", { name: "弱转强" }), verdict: { level: "ahead", text: "" } },
      { ...row("bad", { name: "窄幅整理" }), verdict: { level: "weak", text: "" } },
      { ...row("flat", { name: "持平" }), verdict: { level: "mixed", text: "" } }
    ] };
  const text = model.leaderboardHeadline(report);
  assert.match(text, /2025-11-24 至 2026-11-13/);
  assert.match(text, /最稳的是「深跌底部首板」/);
  assert.match(text, /2 套跑赢基线、1 套跑输/);
  assert.equal(model.leaderboardHeadline(null), "");
});

test("样本范围文字：本机日线落后时提示重新选股", () => {
  const stale = { signalTo: "2026-11-20", dataThrough: "2026-11-13", universe: { localStocks: 5400, replayed: 5120 }, stockCount: 5120 };
  assert.match(model.leaderboardScopeText(stale), /落后于最近交易日 2026-11-20，重新选股可补齐/);
  const fresh = { signalTo: "2026-11-20", dataThrough: "2026-11-20", universe: { localStocks: 5400 }, stockCount: 5120 };
  assert.match(model.leaderboardScopeText(fresh), /数据截至 2026-11-20/);
});
