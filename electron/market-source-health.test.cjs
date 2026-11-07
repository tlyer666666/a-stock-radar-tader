"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMarketSourceHealth, isProviderFault, BASE_OPEN_MS, MAX_OPEN_MS } = require("./market-source-health.cjs");

function clock(start = Date.parse("2026-10-22T02:00:00Z")) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test("two consecutive line faults open the breaker, later calls skip that line and it recovers after the pause", async () => {
  const time = clock();
  const health = createMarketSourceHealth({ now: time.now });
  const calls = [];
  const steps = (thsOk) => [
    { id: "ths_free", run: async () => { calls.push("ths"); if (!thsOk) throw httpError(503); return "ths"; } },
    { id: "eastmoney", run: async () => { calls.push("east"); return "east"; } }
  ];
  assert.equal((await health.runChain(steps(false))).id, "eastmoney");
  assert.equal(health.isOpen("ths_free"), false, "one failure is not enough");
  assert.equal((await health.runChain(steps(false))).id, "eastmoney");
  assert.equal(health.isOpen("ths_free"), true);
  calls.length = 0;
  const skipped = await health.runChain(steps(true));
  assert.deepEqual(calls, ["east"], "an open line is not requested at all");
  assert.equal(skipped.attempts[0].skipped, true);
  time.advance(BASE_OPEN_MS + 1);
  const recovered = await health.runChain(steps(true));
  assert.equal(recovered.id, "ths_free", "after the pause the preferred line is tried again and wins");
  assert.equal(health.snapshot(["ths_free"])[0].status, "ok");
});

test("the pause doubles on repeated faults and is capped", () => {
  const time = clock();
  const health = createMarketSourceHealth({ now: time.now });
  const pauses = [];
  for (let index = 0; index < 8; index += 1) {
    health.recordFailure("eastmoney", httpError(429));
    const retryAt = Date.parse(health.snapshot(["eastmoney"])[0].retryAt || "");
    if (Number.isFinite(retryAt)) pauses.push(retryAt - time.now());
  }
  assert.deepEqual(pauses.slice(0, 4), [BASE_OPEN_MS, BASE_OPEN_MS * 2, BASE_OPEN_MS * 4, BASE_OPEN_MS * 8]);
  assert.equal(Math.max(...pauses), MAX_OPEN_MS);
});

test("missing data for one stock does not count against the line", async () => {
  const health = createMarketSourceHealth();
  for (let index = 0; index < 5; index += 1) health.recordFailure("eastmoney", new Error("未找到股票行情"));
  assert.equal(health.isOpen("eastmoney"), false);
  assert.equal(health.snapshot(["eastmoney"])[0].status, "idle");
  assert.equal(isProviderFault(new Error("未找到股票行情")), false);
  assert.equal(isProviderFault(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })), true, "timeouts surface as AbortError and are line faults");
  assert.equal(isProviderFault(new SyntaxError("Unexpected token <")), true, "an anti-bot HTML page is a line fault");
  assert.equal(isProviderFault(Object.assign(new Error("stale"), { code: "THS_FREE_STALE" })), true);
});

test("when every line is paused the chain still tries them in order instead of returning nothing", async () => {
  const health = createMarketSourceHealth();
  for (const id of ["ths_free", "eastmoney"]) { health.recordFailure(id, httpError(500)); health.recordFailure(id, httpError(500)); }
  const result = await health.runChain([
    { id: "ths_free", run: async () => { throw httpError(500); } },
    { id: "eastmoney", run: async () => "east" }
  ]);
  assert.equal(result.id, "eastmoney");
});

test("a stop request aborts the chain immediately, and total failure lists every line", async () => {
  const health = createMarketSourceHealth();
  const abort = Object.assign(new Error("应用正在退出"), { name: "AbortError" });
  let laterCalled = false;
  await assert.rejects(health.runChain([
    { id: "ths_free", run: async () => { throw abort; } },
    { id: "eastmoney", run: async () => { laterCalled = true; return "east"; } }
  ], { shouldStop: () => true }), /退出/);
  assert.equal(laterCalled, false);
  await assert.rejects(health.runChain([
    { id: "ths_free", run: async () => { throw httpError(502); } },
    { id: "tencent", run: async () => { throw new Error("fetch failed"); } }
  ]), (error) => /同花顺免费行情：HTTP 502/.test(error.message) && /腾讯行情：fetch failed/.test(error.message) && error.attempts.length === 2);
});


test('caller cancellation preserves source health and stops fallback even when a late provider returns data', async () => {
  for(const lateFailure of [false,true]) {
    const health=createMarketSourceHealth(), ctrl=new AbortController(); let fallback=0;
    await assert.rejects(health.runChain([
      {id:'ths_free', run:async()=>{ctrl.abort(); if(lateFailure)throw new Error('network error');return 9;}},
      {id:'eastmoney',run:async()=>{fallback++;return 1;}}
    ],{signal:ctrl.signal}),{name:'AbortError'});
    health.recordFailure('ths_free', new Error('timeout'),20,ctrl.signal);
    const state=health.snapshot(['ths_free'])[0]; assert.equal(state.failureCount,0); assert.equal(state.successCount,0);assert.equal(fallback,0);
  }
});
