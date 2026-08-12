"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let restoreTypeScript;
let csp;

before(() => {
  restoreTypeScript = registerTypeScript();
  csp = require("./contentSecurityPolicy.ts");
});

after(() => restoreTypeScript?.());

test("production CSP excludes development HTTP and WebSocket origins", () => {
  const html = csp.injectCspConnectSources(
    '<meta content="connect-src __CSP_CONNECT_SRC__; object-src \'none\'">',
    "build"
  );
  assert.match(html, /connect-src 'self';/);
  assert.doesNotMatch(html, /localhost|127\.0\.0\.1|ws:/);
  assert.doesNotMatch(html, /__CSP_CONNECT_SRC__/);
});

test("development CSP keeps the Vite HMR origin available", () => {
  const sources = csp.cspConnectSources("serve");
  assert.match(sources, /http:\/\/127\.0\.0\.1:5173/);
  assert.match(sources, /ws:\/\/127\.0\.0\.1:5173/);
});
