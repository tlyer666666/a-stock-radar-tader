"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let mergeObservationPool;
let restoreTypeScript;
before(() => { restoreTypeScript = registerTypeScript(); ({ mergeObservationPool } = require("./observationPool.ts")); });
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
