"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let dateUtils;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  dateUtils = require("./dateUtils.ts");
});

after(() => restoreTypeScript?.());

test("Shanghai date remains on the local trading day across the UTC boundary", () => {
  assert.equal(dateUtils.shanghaiDateTag(new Date("2026-08-12T15:59:59Z")), "2026-08-12");
  assert.equal(dateUtils.shanghaiDateTag(new Date("2026-08-12T16:00:00Z")), "2026-08-13");
});

test("backtest defaults shift calendar years without using the runner timezone", () => {
  assert.equal(dateUtils.shiftShanghaiDate(-1, new Date("2026-08-12T16:30:00Z")), "2025-08-13");
  assert.equal(dateUtils.shiftShanghaiDate(-1, new Date("2024-02-29T04:00:00Z")), "2023-02-28");
});
