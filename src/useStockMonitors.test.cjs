"use strict";

const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
let polling;
let reconcile;
let evaluate;
let restore;
before(() => { restore = registerTypeScript(); const module = require("./useStockMonitors.ts"); polling = module.createStockMonitorPolling; reconcile = module.reconcileStockMonitorRuntimes; evaluate = require("./stockMonitorRules.ts").evaluateStockMonitor; });
after(() => restore?.());

const config = { enabled: true, mode: "all", cooldownMinutes: 5, conditions: [{ id: "price", field: "latest", operator: "gte", value: 10 }] };
const items = Array.from({ length: 9 }, (_, index) => ({ code: `60000${index}`, name: `股票${index}`, secid: `1.60000${index}` }));
const configs = Object.fromEntries(items.map(item => [item.code, config]));

test("stock polling never exceeds four external requests, including a config change mid-flight", async () => {
  let active = 0;
  let peak = 0;
  let started = 0;
  const gates = [];
  const accepted = [];
  const poller = polling({
    getSnapshot: () => new Promise(resolve => { active += 1; started += 1; peak = Math.max(active, peak); gates.push(() => { active -= 1; resolve({ quote: { latest: 11 } }); }); }),
    onSnapshot: item => accepted.push(item.code),
    onError: () => {},
    onRefreshing: () => {}
  });
  poller.configure(items, configs, true);
  const done = poller.poll();
  assert.equal(started, 4);
  await poller.poll();
  assert.equal(started, 4);
  poller.configure(items.slice(0, 2), configs, true);
  await poller.poll();
  assert.equal(started, 4);
  while (gates.length) { gates.shift()(); await new Promise(resolve => setImmediate(resolve)); }
  await done;
  assert.equal(peak, 4);
  assert.deepEqual(accepted.sort(), ["600000", "600001"]);
});

test("pausing invalidates late quote responses and stops queued securities", async () => {
  const gates = [];
  let accepted = 0;
  let failed = 0;
  const poller = polling({
    getSnapshot: () => new Promise((resolve, reject) => gates.push({ resolve, reject })),
    onSnapshot: () => { accepted += 1; },
    onError: () => { failed += 1; },
    onRefreshing: () => {}
  });
  poller.configure(items, configs, true);
  const done = poller.poll();
  assert.equal(gates.length, 4);
  poller.configure(items, configs, false);
  gates.forEach((gate, index) => index === 0 ? gate.reject(new Error("late failure")) : gate.resolve({ quote: { latest: 11 } }));
  await done;
  assert.equal(accepted, 0);
  assert.equal(failed, 0);
  assert.equal(gates.length, 4);
  await poller.poll();
  assert.equal(gates.length, 4);
});

test("one quote failure does not interrupt later stocks and disabled rules do not request quotes", async () => {
  const accepted = [];
  const failed = [];
  const requested = [];
  const poller = polling({
    getSnapshot: async item => { requested.push(item.code); if (item.code === "600000") throw new Error("offline"); return { quote: { latest: 11 } }; },
    onSnapshot: item => accepted.push(item.code),
    onError: item => failed.push(item.code),
    onRefreshing: () => {}
  });
  poller.configure(items, { ...configs, "600001": { ...config, enabled: false } }, true);
  await poller.poll();
  assert.equal(requested.length, 8);
  assert.equal(accepted.length, 7);
  assert.deepEqual(failed, ["600000"]);
  assert.equal(requested.includes("600001"), false);
});

test("a metadata-only watchlist refresh does not discard in-flight samples", async () => {
  let resolve;
  let accepted = 0;
  let requested = 0;
  const poller = polling({ getSnapshot: () => { requested += 1; return requested === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve({ quote: { latest: 11 } }); }, onSnapshot: () => { accepted += 1; }, onError: () => {}, onRefreshing: () => {} });
  poller.configure(items.slice(0, 1), configs, true);
  const done = poller.poll();
  poller.configure([{ ...items[0], name: "更新后的名称" }], { ...configs }, true);
  resolve({ quote: { latest: 11 } });
  await done;
  assert.equal(requested, 1);
  assert.equal(accepted, 1);
});

test("only a changed stock rule or live pause resets an established baseline", () => {
  const now = Date.parse("2026-09-30T02:00:00Z");
  const quote = (latest, offset) => ({ quote: { latest, source: "eastmoney" }, updatedAt: new Date(now + offset).toISOString() });
  const initial = evaluate(config, quote(9, 0), undefined, now);
  const runtimes = { "600000": initial, "600001": initial };
  const changed = { ...configs, "600001": { ...config, conditions: [{ ...config.conditions[0], value: 12 }] } };
  const reconciled = reconcile(runtimes, items.map(item => ({ ...item })), changed, true);
  assert.equal(reconciled["600000"].runtime.initialized, true);
  assert.equal(reconciled["600001"].runtime.initialized, false);
  assert.equal(evaluate(config, quote(11, 1000), reconciled["600000"].runtime, now + 1000).shouldAlert, true);
  const paused = reconcile(reconciled, items, changed, false);
  assert.equal(paused["600000"].runtime.initialized, false);
  assert.equal(evaluate(config, quote(11, 1000), paused["600000"].runtime, now + 1000).shouldAlert, false);
});

test('monitor storage recovers all-invalid rules, keeps mixed and empty primary, and never writes during recovery', () => {
  const subject = require('./useStockMonitors.ts');
  assert.equal(typeof subject.loadMonitors, 'function');
  const key=subject.STOCK_MONITOR_STORAGE_KEY, backup={configs:{600002:config},alerts:[]};
  for(const [primary, expected] of [[{configs:{600001:null},alerts:[]},['600002']],[{configs:{600001:config,600003:null},alerts:[]},['600001']],[{configs:{},alerts:[]},[]]]) {
    const data=new Map([[key,JSON.stringify(primary)],[key+':last-good',JSON.stringify(backup)]]);
    global.window={localStorage:{getItem:k=>data.get(k)??null,setItem(){throw Error('Recovery must not write');}}};
    try{assert.deepEqual(Object.keys(subject.loadMonitors().configs),expected);assert.equal(data.get(key),JSON.stringify(primary));}finally{delete global.window;}
  }
});

test('saving recovered monitor rules cannot rotate a corrupt primary over a valid backup',()=>{
 const subject=require('./useStockMonitors.ts'),{saveSafeLocalJson}=require('./safeStorage.ts'),key=subject.STOCK_MONITOR_STORAGE_KEY;
 const backup=JSON.stringify({configs:{600002:config},alerts:[]}),data=new Map([[key,JSON.stringify({configs:{600001:null},alerts:[]})],[key+':last-good',backup]]);
 global.window={localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}};
 try{assert.equal(saveSafeLocalJson(key,{configs:{600003:config},alerts:[]},subject.isUsableMonitorStorage),true);assert.equal(data.get(key+':last-good'),backup);assert.deepEqual(Object.keys(subject.loadMonitors().configs),['600003']);}finally{delete global.window;}
});
