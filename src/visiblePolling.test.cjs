"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let whenVisible;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  ({ whenVisible } = require("./visiblePolling.ts"));
});

after(() => restoreTypeScript?.());

test("a visibility-gated poll skips its work while the window is hidden", () => {
  const page = { hidden: true };
  let calls = 0;
  const poll = whenVisible(() => { calls += 1; }, page);
  poll();
  assert.equal(calls, 0);
  page.hidden = false;
  poll();
  assert.equal(calls, 1);
});

test("a visibility-gated poll forwards its result when visible", () => {
  const poll = whenVisible(() => "loaded", { hidden: false });
  assert.equal(poll(), "loaded");
});
