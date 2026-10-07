"use strict";
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
let workspace, preview, restore;
before(() => {
  restore = registerTypeScript();
  workspace = require("./trendWorkspace.ts");
  preview = require("./trendScreenerPreview.ts");
});
after(() => restore?.());
function storage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
test("saved plans round-trip with dated provenance and no reference to a later-mutated scan", () => {
  const status = preview.createTrendPreviewStatus();
  const plan = workspace.createSavedTrendPlan(status.candidates[0], status, "2026-09-30T01:00:00Z");
  const initialClose = plan.candidate.metrics.close;
  status.candidates[0].metrics.close = 999;
  assert.equal(plan.candidate.metrics.close, initialClose);
  status.candidates[0].metrics.close = initialClose;
  assert.equal(plan.isPreview, true);
  assert.equal(plan.coverageComplete, false);
  assert.equal(plan.candidate.asOf, "2026-09-29");
  const store = storage();
  assert.equal(workspace.writeTrendPlans(store, [plan]), true);
  assert.deepEqual(workspace.readTrendPlans(store), { plans: [plan], error: "" });
  assert.notEqual(plan.id, workspace.trendPlanId(plan.candidate, false));
});
test("corrupt nested snapshots and unavailable storage produce an explicit error and keep raw records", () => {
  const store = storage();
  const raw = JSON.stringify({ version: 1, plans: [{ candidate: { security: { code: "600001" } } }] });
  store.setItem(workspace.TREND_PLAN_STORAGE_KEY, raw);
  assert.ok(workspace.readTrendPlans(store).error);
  assert.equal(store.getItem(workspace.TREND_PLAN_STORAGE_KEY), raw);
  assert.ok(workspace.readTrendPlans({ getItem() { throw new Error("denied"); } }).error);
  assert.equal(workspace.writeTrendPlans({ setItem() { throw new Error("quota"); } }, []), false);
});
test("CSV blocks formulas and escapes commas, quotes and newlines while preserving numeric codes", () => {
  for (const cell of ["=HYPERLINK(\"evil\")", "+cmd", "-cmd", "@SUM(1)", "  =evil", "\tplain", "\n=evil"]) {
    assert.ok(workspace.csvCell(cell).startsWith("\"'"), cell);
  }
  assert.equal(workspace.csvCell('名称,"一"\n二'), '"名称,""一""\n二"');
  const status = preview.createTrendPreviewStatus();
  const candidate = JSON.parse(JSON.stringify(status.candidates[0]));
  candidate.security.code = "000001";
  candidate.security.name = "=SUM(1)";
  const csv = workspace.trendCandidatesCsv([workspace.createSavedTrendPlan(candidate, status)]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"\'000001"'));
  assert.ok(csv.includes('"\'=SUM(1)"'));
  assert.ok(csv.includes("DEMO 虚构演示"));
  assert.ok(csv.includes("2026-09-29"));
  assert.ok(csv.includes("不自动下单或退出"));
});
