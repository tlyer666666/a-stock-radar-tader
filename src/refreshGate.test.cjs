"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

const restoreTypeScript = registerTypeScript();
const { createRefreshGate } = require("./refreshGate.ts");

after(restoreTypeScript);

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("a forced refresh requested while a background load runs is queued, not dropped", async () => {
  const calls = [];
  const gates = [];
  const gate = createRefreshGate(async force => {
    calls.push(force);
    const next = deferred();
    gates.push(next);
    await next.promise;
  });
  const background = gate.trigger(false);
  const manual = gate.trigger(true);
  assert.deepEqual(calls, [false]);
  gates[0].resolve();
  await background;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [false, true]);
  gates[1].resolve();
  await manual;
  assert.equal(gate.isBusy(), false);
});

test("background triggers during a running load are coalesced away", async () => {
  const calls = [];
  const release = deferred();
  const gate = createRefreshGate(async force => { calls.push(force); await release.promise; });
  const first = gate.trigger(false);
  void gate.trigger(false);
  void gate.trigger(false);
  release.resolve();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [false]);
});

test("several forced clicks during one load collapse into a single follow-up forced load", async () => {
  const calls = [];
  const gates = [];
  const gate = createRefreshGate(async force => { calls.push(force); const next = deferred(); gates.push(next); await next.promise; });
  const first = gate.trigger(false);
  const second = gate.trigger(true);
  const third = gate.trigger(true);
  gates[0].resolve();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  gates[1].resolve();
  await Promise.all([second, third]);
  assert.deepEqual(calls, [false, true]);
});

test("a failing load releases the gate and still runs the queued forced refresh", async () => {
  const calls = [];
  let fail = true;
  const gate = createRefreshGate(async force => {
    calls.push(force);
    if (fail) { fail = false; throw new Error("network"); }
  });
  const first = gate.trigger(false);
  const manual = gate.trigger(true);
  await assert.rejects(first, /network/);
  await manual;
  assert.deepEqual(calls, [false, true]);
  assert.equal(gate.isBusy(), false);
});
