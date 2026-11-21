"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let mergeObservationPool;
let sameWatchlist;
let restoreTypeScript;
before(() => { restoreTypeScript = registerTypeScript(); ({ mergeObservationPool, sameWatchlist } = require("./observationPool.ts")); });
after(() => restoreTypeScript?.());

test("用户自选的 ST/退市股保留，自动加入的涨停观察排除 ST/退", () => {
  const current = [
    { code: "600001", name: "*ST某某", favorite: true, autoAdded: false, createdAt: "2026-11-01" },
    { code: "600002", name: "某某退", favorite: false, autoAdded: false, createdAt: "2026-11-01" },
    { code: "600003", name: "旧自动", favorite: false, autoAdded: true, createdAt: "2026-11-01" }
  ];
  const recent = [
    { code: "600004", name: "ST新涨停", tradingDaysSince: 2, limitDate: "2026-11-05" },
    { code: "600005", name: "正常涨停", tradingDaysSince: 1, limitDate: "2026-11-06" }
  ];
  const codes = mergeObservationPool(current, recent).map(item => item.code).sort();
  assert.deepEqual(codes, ["600001", "600002", "600005"]);
});

test("自动合并只保留需要落盘的字段", () => {
  const recent = [{
    code: "600005", name: "正常涨停", secid: "1.600005", thscode: "600005.SH", marketName: "上海",
    assetType: "stock", limitDate: "2026-11-06", tradingDaysSince: 1, consecutiveBoards: 2,
    raw: { fat: true }, limitStats: { seals: 3 }, firstSealTime: "093000", extra: "drop-me"
  }];
  const [item] = mergeObservationPool([], recent);
  assert.deepEqual(Object.keys(item).sort(), [
    "assetType", "autoAdded", "code", "consecutiveBoards", "createdAt", "limitDate",
    "marketName", "name", "note", "observationNode", "secid", "thscode", "tradingDaysSince"
  ].sort());
  assert.equal(item.autoAdded, true);
  assert.equal(item.observationNode, "T+1");
});

test("同一批涨停数据重复合并内容不变，交易日变化才算不同", () => {
  const recent = [
    { code: "600005", name: "正常涨停", limitDate: "2026-11-06", tradingDaysSince: 1 },
    { code: "600006", name: "第二只", limitDate: "2026-11-05", tradingDaysSince: 2 }
  ];
  const first = mergeObservationPool([], recent);
  const again = mergeObservationPool(first, recent);
  assert.equal(sameWatchlist(again, first), true);
  const moved = mergeObservationPool(
    first,
    recent.map(item => item.code === "600005" ? { ...item, tradingDaysSince: 2 } : item)
  );
  assert.equal(sameWatchlist(moved, first), false);
});
