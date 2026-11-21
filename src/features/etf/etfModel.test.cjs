"use strict";
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
let model, restore;
before(() => { restore = registerTypeScript(); model = require("./etfModel.ts"); });
after(() => restore?.());

const item = (code, patch) => ({ code, name: `ETF${code}`, secid: `1.${code}`, category: "宽基", latest: 1, changePct: 0, volume: 1, amount: 1, turnover: 1, volumeRatio: 1, open: 1, preClose: 1, scale: 1, iopv: 1, premiumPct: 0, ...patch });

test("filtering by category and search, sorting with missing values always last", () => {
  const items = [item("510300", { changePct: 1, amount: 3 }), item("512880", { category: "行业主题", changePct: 4, amount: 2 }), item("513310", { category: "跨境", changePct: null, amount: 9 }), item("588000", { changePct: -2, amount: 1 })];
  assert.deepEqual(model.selectEtfs(items).map(x => x.code), ["513310", "510300", "512880", "588000"]);
  assert.deepEqual(model.selectEtfs(items, { sort: { column: "change", direction: "desc" } }).map(x => x.code), ["512880", "510300", "588000", "513310"]);
  assert.deepEqual(model.selectEtfs(items, { sort: { column: "change", direction: "asc" } }).map(x => x.code), ["588000", "510300", "512880", "513310"]);
  assert.deepEqual(model.selectEtfs(items, { category: "宽基" }).map(x => x.code), ["510300", "588000"]);
  assert.deepEqual(model.selectEtfs(items, { query: "5128" }).map(x => x.code), ["512880"]);
  assert.deepEqual(model.toggleEtfSort({ column: "change", direction: "desc" }, "change"), { column: "change", direction: "asc" });
  assert.deepEqual(model.toggleEtfSort({ column: "change", direction: "asc" }, "amount"), { column: "amount", direction: "desc" });
});

test("premium warnings explain the risk in plain words and stay quiet inside the threshold", () => {
  assert.match(model.premiumWarning(item("513310", { premiumPct: 9.41 }), 3), /高 9\.41%.*追高/);
  assert.match(model.premiumWarning(item("513310", { premiumPct: -4 }), 3), /低 4\.00%/);
  assert.equal(model.premiumWarning(item("510300", { premiumPct: 0.4 }), 3), "");
  assert.equal(model.premiumWarning(item("511880", { premiumPct: null }), 3), "");
  assert.equal(model.etfSecurity(item("510300")).assetType, "etf");
});

test("T+0 filter, counts and the active board", () => {
  const items = [
    item("510300", { amount: 9e9 }),
    item("513180", { category: "跨境", t0: true, amount: 3e9, amplitude: 2.4 }),
    item("518880", { category: "商品", amount: 2e9 }),
    item("511880", { category: "货币", t0: true, amount: 8e9 }),
    item("511260", { category: "债券", t0: true, amount: 1e7 }),
    item("513999", { category: "跨境", t0: true, amount: 6e8, latest: null })
  ];
  assert.equal(model.isT0Etf(items[2]), true, "older snapshots without t0 fall back to the category rule");
  assert.equal(model.isT0Etf(items[0]), false);
  assert.deepEqual(model.selectEtfs(items, { category: "T+0" }).map(x => x.code), ["511880", "513180", "518880", "513999", "511260"]);
  assert.equal(model.countByFilter(items, "T+0"), 5);
  assert.equal(model.countByFilter(items, "跨境"), 2);
  assert.equal(model.countByFilter(items, "all"), 6);
  assert.deepEqual(model.t0ActiveEtfs(items).map(x => x.code), ["513180", "518880"], "no money funds, no thin or unpriced rows");
  assert.deepEqual(model.selectEtfs(items, { sort: { column: "amplitude", direction: "desc" } })[0].code, "513180");
  assert.ok(model.ETF_CATEGORY_FILTERS.indexOf("T+0") === 1);
});
