"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let restore;
let whenVisible;
let startVisibleInterval;

before(() => {
  restore = registerTypeScript();
  ({ whenVisible, startVisibleInterval } = require("./visiblePolling.ts"));
});

after(() => restore?.());

test("whenVisible suppresses execution while hidden and runs when visible", () => {
  let runs = 0;
  const page = { hidden: true };
  const gated = whenVisible(() => ++runs, page);
  assert.equal(gated(), undefined);
  assert.equal(runs, 0);

  page.hidden = false;
  assert.equal(gated(), 1);
  assert.equal(runs, 1);
});

test("startVisibleInterval gates ticks by visibility, resumes on reveal, and cleans up", () => {
  const previousWindow = global.window;
  let nextId = 0;
  const intervals = new Map();
  const listeners = new Map();
  const page = {
    hidden: false,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    }
  };

  global.window = {
    setInterval(fn, ms) {
      const id = ++nextId;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    }
  };

  try {
    let calls = 0;
    const stop = startVisibleInterval(() => { calls += 1; }, 5000, {
      immediate: true,
      resumeOnVisible: true,
      page
    });

    assert.equal(calls, 1);
    assert.equal(intervals.size, 1);
    assert.equal(intervals.get(1).ms, 5000);
    assert.ok(listeners.has("visibilitychange"));

    page.hidden = true;
    intervals.get(1).fn();
    listeners.get("visibilitychange")();
    assert.equal(calls, 1);

    page.hidden = false;
    intervals.get(1).fn();
    assert.equal(calls, 2);

    listeners.get("visibilitychange")();
    assert.equal(calls, 3);

    stop();
    assert.equal(intervals.size, 0);
    assert.equal(listeners.size, 0);
  } finally {
    global.window = previousWindow;
  }
});
