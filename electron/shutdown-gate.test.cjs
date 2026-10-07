"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { createShutdownGate } = require("./shutdown-gate.cjs");

test("repeated quit requests run cleanup once and wait for physical completion", async () => {
  let release;
  const resource = new Promise(resolve => { release = resolve; });
  let cleanups = 0, quits = 0, prevented = 0;
  const gate = createShutdownGate({ cleanup: () => { cleanups++; return resource; }, complete: () => { quits++; }, timeoutMs: 1000 });
  const event = { preventDefault: () => prevented++ };
  const first = gate(event), second = gate(event);
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanups, 1); assert.equal(quits, 0);
  release(); await first;
  assert.equal(quits, 1);
  await gate(event);
  assert.equal(prevented, 2, "the final re-entered quit must be allowed through");
  assert.equal(quits, 1);
});

test("a stuck resource cannot prevent quit indefinitely and late rejection is handled", async () => {
  let reject;
  const errors = [];
  let quits = 0;
  const gate = createShutdownGate({ cleanup: () => new Promise((_, r) => { reject = r; }), complete: () => quits++, onError: e => errors.push(e), timeoutMs: 15 });
  await gate({ preventDefault() {} });
  assert.equal(quits, 1);
  assert.equal(errors[0].code, "SHUTDOWN_TIMEOUT");
  reject(new Error("late worker exit failure"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quits, 1);
  assert.equal(errors.length, 2);
});

test("synchronous cleanup failure and a broken logger still allow quit", async () => {
  let quits = 0;
  const gate = createShutdownGate({ cleanup: () => { throw new Error("cleanup failed"); }, complete: () => quits++, onError: () => { throw new Error("disk unavailable"); } });
  await gate({ preventDefault() {} });
  assert.equal(quits, 1);
});

test("native quit microtask checkpoint cannot re-enter quit before the original event returns", async () => {
  let isQuitting = false;
  let nativeEventOnStack = false;
  let completeDuringNativeEvent = false;
  let completes = 0;
  let shutdowns = 0;
  let windowsClosed = false;
  const context = vm.createContext({
    module: { exports: {} }, setTimeout, clearTimeout, setImmediate,
    complete() {
      completes++;
      completeDuringNativeEvent ||= nativeEventOnStack;
      browserQuit();
    }
  }, { microtaskMode: "afterEvaluate" });
  vm.runInContext(fs.readFileSync(require.resolve("./shutdown-gate.cjs"), "utf8"), context);
  vm.runInContext(`
    const gate = module.exports.createShutdownGate({ cleanup: () => {}, complete });
    let completion;
    let completionSettled = false;
  `, context);

  // Electron's native EventEmitter flushes microtasks before HandleBeforeQuit
  // returns. Browser::Quit assigns is_quitting_ only after that callback returns.
  function browserQuit() {
    if (isQuitting) return;
    let prevented = false;
    context.event = { preventDefault() { prevented = true; } };
    const wasOnStack = nativeEventOnStack;
    nativeEventOnStack = true;
    vm.runInContext(`
      completion = gate(event);
      completion.then(() => { completionSettled = true; });
    `, context);
    nativeEventOnStack = wasOnStack;
    isQuitting = !prevented;
    if (!isQuitting) return;
    setImmediate(() => {
      windowsClosed = true;
      if (isQuitting) shutdowns++;
    });
  }

  browserQuit();
  assert.equal(completes, 0, "immediate cleanup must leave the native event before re-entering quit");
  assert.equal(vm.runInContext("completionSettled", context), false,
    "completion must wait for the deferred complete invocation");
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext("", context); // Flush the isolated realm's completion reaction.
  assert.equal(completes, 1);
  assert.equal(completeDuringNativeEvent, false);
  assert.equal(vm.runInContext("completionSettled", context), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windowsClosed, true);
  assert.equal(shutdowns, 1, "the first prevented quit must not overwrite the final quit state");
});

test("a deferred complete failure rejects completion without another cleanup or uncaught callback", async () => {
  const error = new Error("quit failed");
  let cleanups = 0;
  const gate = createShutdownGate({
    cleanup() { cleanups++; },
    complete() { throw error; }
  });
  const completion = gate({ preventDefault() {} });
  await assert.rejects(completion, actual => actual === error);
  assert.equal(gate({ preventDefault() { assert.fail("final quit must not be prevented"); } }), completion);
  assert.equal(cleanups, 1);
});
