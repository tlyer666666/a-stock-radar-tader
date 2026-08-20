"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let logic;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  logic = require("./asyncRequestGate.ts");
});

after(() => restoreTypeScript?.());

test("request gate prevents reentry and rejects an invalidated slow generation", () => {
  const gate = logic.createAsyncRequestGate();
  const slowRequest = gate.begin();

  assert.equal(typeof slowRequest, "number");
  assert.equal(gate.begin(), null, "the same generation must remain single-flight");
  gate.invalidate();

  const currentRequest = gate.begin();
  assert.equal(gate.isCurrent(slowRequest), false);
  assert.equal(gate.finish(slowRequest), false);
  assert.equal(gate.isCurrent(currentRequest), true);
  assert.equal(gate.finish(currentRequest), true);
});
