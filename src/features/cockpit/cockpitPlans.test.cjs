"use strict";
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let workspace, cockpitAdd, restore;
before(() => {
  restore = registerTypeScript();
  workspace = require("../../trendWorkspace.ts");
  cockpitAdd = require("./cockpitAdd.ts");
});
after(() => restore?.());

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

function quick(store, code, savedAt, extra = {}) {
  const result = workspace.saveQuickObservationPlan(store, { code, name: `股票${code}`, referencePrice: 10, asOf: savedAt.slice(0, 10), ...extra });
  assert.equal(result.ok, true);
  const read = workspace.readTrendPlans(store);
  assert.equal(workspace.writeTrendPlans(store, read.plans.map(plan => plan.id === result.plan.id ? { ...plan, savedAt } : plan)), true);
  return result.plan;
}

test("quick plans remember where they were added from and survive a storage round-trip", () => {
  const store = storage();
  const saved = workspace.saveQuickObservationPlan(store, { code: "600519", name: "贵州茅台", referencePrice: 1500, source: "AI 打分" });
  assert.equal(saved.ok, true);
  assert.equal(saved.plan.source, "AI 打分");
  const read = workspace.readTrendPlans(store);
  assert.equal(read.error, "");
  assert.equal(read.plans[0].source, "AI 打分");
});

test("plans with a malformed source are rejected instead of corrupting the whole store", () => {
  const store = storage();
  const saved = workspace.saveQuickObservationPlan(store, { code: "600519", name: "贵州茅台", referencePrice: 1500 });
  assert.equal(workspace.writeTrendPlans(store, [{ ...saved.plan, source: 42 }]), false);
  assert.equal(workspace.readTrendPlans(store).plans.length, 1);
});

test("a plan stays in the cockpit for 5 trading days after it was added and is archived on the 6th", () => {
  const store = storage();
  quick(store, "600519", "2026-11-13T07:30:00.000Z");
  quick(store, "000001", "2026-11-19T07:30:00.000Z");

  assert.equal(workspace.expireStaleTrendPlans(store, "2026-11-20"), 0);
  assert.equal(workspace.readTrendPlans(store).plans.filter(plan => !plan.archivedAt).length, 2);

  const archived = workspace.expireStaleTrendPlans(store, "2026-11-23", "2026-11-23T01:00:00.000Z");
  assert.equal(archived, 1);
  const plans = workspace.readTrendPlans(store).plans;
  const old = plans.find(plan => plan.candidate.security.code === "600519");
  assert.equal(old.archivedAt, "2026-11-23T01:00:00.000Z");
  assert.equal(old.archivedReason, "到期自动移出");
  assert.equal(plans.find(plan => plan.candidate.security.code === "000001").archivedAt, undefined);
  assert.equal(workspace.expireStaleTrendPlans(store, "2026-11-23"), 0);
});

test("weekends and exchange holidays do not count toward the 5 trading days", () => {
  const store = storage();
  quick(store, "600519", "2026-09-29T07:30:00.000Z");
  assert.equal(workspace.expireStaleTrendPlans(store, "2026-10-09"), 0);
  assert.equal(workspace.expireStaleTrendPlans(store, "2026-10-14"), 1);
});

test("removing a plan from the cockpit archives it and re-adding the same stock brings it back", () => {
  const store = storage();
  const plan = quick(store, "600519", "2026-11-19T07:30:00.000Z");
  assert.equal(workspace.archiveTrendPlan(store, plan.id, "2026-11-20T02:00:00.000Z"), true);
  const archived = workspace.readTrendPlans(store).plans[0];
  assert.equal(archived.archivedAt, "2026-11-20T02:00:00.000Z");
  assert.equal(archived.archivedReason, "手动移出驾驶舱");
  assert.equal(workspace.archiveTrendPlan(store, "missing", "2026-11-20T02:00:00.000Z"), false);

  const again = workspace.saveQuickObservationPlan(store, { code: "600519", name: "股票600519", referencePrice: 11 });
  assert.equal(again.ok, true);
  assert.equal(again.created, true);
  assert.equal(workspace.readTrendPlans(store).plans.filter(item => !item.archivedAt).length, 1);
});

test("quick-add candidates are recognised so their placeholder averages are never shown as real data", () => {
  const store = storage();
  const plan = quick(store, "600519", "2026-11-19T07:30:00.000Z");
  assert.equal(workspace.isQuickObservationCandidate(plan.candidate), true);
  const preview = require("../../trendScreenerPreview.ts").createTrendPreviewStatus();
  assert.equal(workspace.isQuickObservationCandidate(preview.candidates[0]), false);
});

test("one-click add uses the visible price, otherwise fetches a quote, and reports existing entries", async () => {
  const store = storage();
  let fetched = 0;
  const fetchPrice = async () => { fetched += 1; return 8.88; };

  const first = await cockpitAdd.addToCockpit(store, { code: "600519", name: "贵州茅台", referencePrice: 1500 }, "AI 打分", fetchPrice);
  assert.deepEqual([first.ok, first.created, fetched], [true, true, 0]);
  assert.match(first.message, /已加入今日驾驶舱/);
  const plan = workspace.readTrendPlans(store).plans[0];
  assert.equal(plan.source, "AI 打分");
  assert.equal(plan.candidate.plan.stop, 1410);
  assert.equal(plan.candidate.plan.minEntry, 1485);
  assert.equal(plan.candidate.plan.maxEntry, 1530);

  const second = await cockpitAdd.addToCockpit(store, { code: "000001", name: "平安银行" }, "涨停池", fetchPrice);
  assert.deepEqual([second.ok, second.created, fetched], [true, true, 1]);

  const duplicate = await cockpitAdd.addToCockpit(store, { code: "600519", name: "贵州茅台", referencePrice: 1500 }, "AI 打分", fetchPrice);
  assert.deepEqual([duplicate.ok, duplicate.created], [true, false]);
  assert.match(duplicate.message, /已在今日驾驶舱/);

  const noPrice = await cockpitAdd.addToCockpit(store, { code: "300059", name: "东方财富" }, "资讯", async () => null);
  assert.equal(noPrice.ok, false);
  assert.match(noPrice.message, /现价/);
});

test("restoring an archived plan restarts its 5 trading days instead of expiring it again immediately", () => {
  const store = storage();
  quick(store, "600519", "2026-11-02T07:30:00.000Z");
  assert.equal(workspace.expireStaleTrendPlans(store, "2026-11-20", "2026-11-20T01:00:00.000Z"), 1);
  const restored = workspace.restoreTrendPlan(workspace.readTrendPlans(store).plans[0], "2026-11-20T02:00:00.000Z");
  assert.equal(restored.archivedAt, undefined);
  assert.equal(restored.archivedReason, undefined);
  assert.equal(workspace.writeTrendPlans(store, [restored]), true);
  assert.equal(workspace.expireStaleTrendPlans(store, "2026-11-27"), 0);
  assert.equal(workspace.expireStaleTrendPlans(store, "2026-11-30"), 1);
});

test("CSV export leaves quick-add placeholder averages blank instead of repeating the reference price", () => {
  const store = storage();
  const plan = quick(store, "600519", "2026-11-19T07:30:00.000Z");
  const csv = workspace.trendCandidatesCsv([plan]);
  const row = csv.split(/\r?\n/)[1];
  assert.match(row, /"10","","","","",""/);
});
