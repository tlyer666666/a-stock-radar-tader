"use strict";

const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let rules;
let restore;
before(() => { restore = registerTypeScript(); rules = require("./stockMonitorRules.ts"); });
after(() => restore?.());

const now = Date.parse("2026-09-30T02:00:00Z");
const condition = (field, operator, value, id = field) => ({ id, field, operator, value });
const config = (conditions = [condition("latest", "gte", 10)], extra = {}) => ({ enabled: true, mode: "all", cooldownMinutes: 5, conditions, ...extra });
const snapshot = (quote = {}, at = now, extra = {}) => ({ quote: { code: "600000", latest: 9, changePct: 0, turnover: 1, amount: 50000, source: "eastmoney", ...quote }, updatedAt: new Date(at).toISOString(), actualProvider: "eastmoney", ...extra });

test("normalization rejects malformed thresholds and keeps valid zero-percent conditions", () => {
  assert.equal(rules.normalizeStockMonitorConfig(config([condition("latest", "gte", "")])), null);
  assert.equal(rules.normalizeStockMonitorConfig(config([condition("latest", "gte", 0)])), null);
  assert.equal(rules.normalizeStockMonitorConfig(config([condition("amount", "gte", Infinity)])), null);
  assert.equal(rules.normalizeStockMonitorConfig(config([condition("latest", "gt", 10)])), null);
  assert.equal(rules.normalizeStockMonitorConfig(config([], { enabled: true })), null);
  assert.equal(rules.normalizeStockMonitorConfig(config([condition("latest", "gte", 10)], { cooldownMinutes: 0 })), null);
  assert.deepEqual(rules.normalizeStockMonitorRules({ "600000": config([condition("changePct", "lte", 0)]), bad: config(), "000001": null }), { "600000": config([condition("changePct", "lte", 0)]) });
});

test("first fresh quote establishes a baseline even when a condition is already true", () => {
  const result = rules.evaluateStockMonitor(config(), snapshot({ latest: 11 }), undefined, now);
  assert.equal(result.shouldAlert, false);
  assert.equal(result.status, "baseline");
  assert.equal(result.runtime.matched, true);
  assert.equal(rules.evaluateStockMonitor(config(), snapshot({ latest: 11 }, now + 1000), result.runtime, now + 1000).shouldAlert, false);
});

test("inclusive ALL and ANY conditions alert only on a false-to-true transition", () => {
  const conditions = [condition("latest", "gte", 10), condition("changePct", "lte", -2)];
  const all = config(conditions);
  const initial = rules.evaluateStockMonitor(all, snapshot({ latest: 9, changePct: 0 }), undefined, now);
  const partial = rules.evaluateStockMonitor(all, snapshot({ latest: 10, changePct: 0 }, now + 1000), initial.runtime, now + 1000);
  assert.equal(partial.shouldAlert, false);
  const hit = rules.evaluateStockMonitor(all, snapshot({ latest: 10, changePct: -2 }, now + 2000), partial.runtime, now + 2000);
  assert.equal(hit.shouldAlert, true);
  assert.equal(hit.status, "triggered");
  const any = config(conditions, { mode: "any" });
  const firstAny = rules.evaluateStockMonitor(any, snapshot(), undefined, now);
  assert.equal(rules.evaluateStockMonitor(any, snapshot({ changePct: -2 }, now + 1000), firstAny.runtime, now + 1000).shouldAlert, true);
});

test("cooldown suppresses recrossing and does not turn a sustained match into repeated alerts", () => {
  const rule = config();
  const seeded = rules.evaluateStockMonitor(rule, snapshot(), undefined, now);
  const hit = rules.evaluateStockMonitor(rule, snapshot({ latest: 11 }, now + 1000), seeded.runtime, now + 1000);
  const reset = rules.evaluateStockMonitor(rule, snapshot({}, now + 2000), hit.runtime, now + 2000);
  const suppressed = rules.evaluateStockMonitor(rule, snapshot({ latest: 11 }, now + 3000), reset.runtime, now + 3000);
  assert.equal(suppressed.shouldAlert, false);
  assert.equal(suppressed.status, "cooldown");
  const held = rules.evaluateStockMonitor(rule, snapshot({ latest: 11 }, now + 400000), suppressed.runtime, now + 400000);
  assert.equal(held.shouldAlert, false);
  const resetAgain = rules.evaluateStockMonitor(rule, snapshot({}, now + 401000), held.runtime, now + 401000);
  assert.equal(rules.evaluateStockMonitor(rule, snapshot({ latest: 11 }, now + 402000), resetAgain.runtime, now + 402000).shouldAlert, true);
});

test("missing values, explicit stale source quotes and stale fetches cannot trigger or reset a match", () => {
  const rule = config([condition("changePct", "lte", 0)]);
  const seeded = rules.evaluateStockMonitor(rule, snapshot({ changePct: -1 }), undefined, now);
  for (const input of [snapshot({ changePct: null }), snapshot({ changePct: "" }), snapshot({ changePct: NaN }), snapshot({ changePct: 1 }, now - 121000), snapshot({ changePct: 1, updatedAt: new Date(now - 121000).toISOString() })]) {
    const result = rules.evaluateStockMonitor(rule, input, seeded.runtime, now);
    assert.equal(result.shouldAlert, false);
    assert.equal(result.runtime.matched, true);
    assert.ok(["stale", "unavailable"].includes(result.status));
  }
  assert.equal(rules.evaluateStockMonitor(rule, snapshot({ changePct: 1 }, now + 60000), seeded.runtime, now).status, "stale");
});

test("ANY remains unarmed when another configured field is unavailable", () => {
  const rule = config([condition("latest", "gte", 10), condition("turnover", "gte", 2)], { mode: "any" });
  const initial = rules.evaluateStockMonitor(rule, snapshot(), undefined, now);
  const result = rules.evaluateStockMonitor(rule, snapshot({ latest: 11, turnover: null }, now + 1000), initial.runtime, now + 1000);
  assert.equal(result.shouldAlert, false);
  assert.equal(result.status, "unavailable");
  assert.equal(result.runtime.matched, false);
});

test("provider missing-field metadata cannot be turned into a zero-percent or zero-turnover alert", () => {
  const rule = config([condition("changePct", "lte", 0), condition("turnover", "lte", 1)], { mode: "any" });
  const initial = rules.evaluateStockMonitor(rule, snapshot({ changePct: 1, turnover: 2 }), undefined, now);
  for (const missingFields of [["changePct"], ["turnover"], ["latest"]]) {
    const result = rules.evaluateStockMonitor(rule, snapshot({ changePct: 0, turnover: 0, missingFields }, now + 1000), initial.runtime, now + 1000);
    assert.equal(result.shouldAlert, false);
    assert.equal(result.status, "unavailable");
    assert.equal(result.runtime.matched, false);
  }
});

test("preview data, disabled rules and duplicate/out-of-order samples cannot alert", () => {
  const rule = config();
  const initial = rules.evaluateStockMonitor(rule, snapshot(), undefined, now);
  assert.equal(rules.evaluateStockMonitor(rule, snapshot({ latest: 11, source: "preview" }, now + 1000), initial.runtime, now + 1000).shouldAlert, false);
  assert.equal(rules.evaluateStockMonitor(rule, snapshot({ latest: 11 }, now + 1000, { actualProvider: "", provider: "preview" }), initial.runtime, now + 1000).shouldAlert, false);
  assert.equal(rules.evaluateStockMonitor(rule, snapshot({ latest: 11 }), initial.runtime, now + 1000).shouldAlert, false);
  assert.equal(rules.evaluateStockMonitor(config(undefined, { enabled: false }), snapshot({ latest: 11 }), initial.runtime, now).status, "disabled");
});

test("editing a rule resets its baseline and yuan amount conditions use exact source units", () => {
  const initial = rules.evaluateStockMonitor(config(), snapshot(), undefined, now);
  const edited = config([condition("amount", "gte", 50000)]);
  const baseline = rules.evaluateStockMonitor(edited, snapshot({}, now + 1000), initial.runtime, now + 1000);
  assert.equal(baseline.shouldAlert, false);
  assert.equal(baseline.runtime.matched, true);
  assert.match(rules.summarizeStockMonitor(edited), /5.*万元/);
});

test('monitor mode and comparison must be primitive enums, never coercible arrays',()=>{
 const {normalizeStockMonitorConfig}=require('./stockMonitorRules.ts');
 const good={enabled:true,mode:'all',cooldownMinutes:1,conditions:[{id:'p',field:'latest',operator:'gte',value:10}]};
 assert.ok(normalizeStockMonitorConfig(good));
 for(const mode of [['all'],['any'],{toString:()=> 'all'}])assert.equal(normalizeStockMonitorConfig({...good,mode}),null);
 for(const operator of [['gte'],['lte'],{toString:()=> 'gte'}])assert.equal(normalizeStockMonitorConfig({...good,conditions:[{...good.conditions[0],operator}]}),null);
});
