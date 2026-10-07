"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRuntimeLogger, RUNTIME_LOG_MAX_BYTES } = require("./runtime-diagnostics.cjs");

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "astock-runtime-log-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = createRuntimeLogger({ isEnabled: () => true, getDirectory: () => directory, ...options });
  return { directory, log, text: () => fs.readFileSync(path.join(directory, "runtime-errors.log"), "utf8") };
}

test("oversized runtime errors respect the rotation budget and cannot throw from logging", (t) => {
  const { directory, log, text } = fixture(t);
  const error = new Error("large provider failure");
  error.stack = `Error: provider failure\n${"x".repeat(1024 * 1024)}`;
  for (let i = 0; i < 40; i++) assert.doesNotThrow(() => log("test-only", error));
  const files = fs.readdirSync(directory);
  assert.deepEqual(files.sort(), ["runtime-errors.log", "runtime-errors.log.1"]);
  for (const name of files) assert.ok(fs.statSync(path.join(directory, name)).size <= RUNTIME_LOG_MAX_BYTES, `${name} exceeds its rotation budget`);
  assert.match(text(), /Error: provider failure/);
  // A disk error remains best-effort: diagnostics must not crash the application.
  fs.rmSync(directory, { recursive: true, force: true });
  assert.doesNotThrow(() => log("unwritable", error));
});

for (const field of ["name", "message", "stack"]) {
  test(`runtime logging contains a throwing ${field} accessor`, (t) => {
    const { log, text } = fixture(t);
    const error = { name: "ProviderError", message: "fixture failure", stack: "Error: fixture failure" };
    Object.defineProperty(error, field, { get() { throw new Error("getter failure"); } });
    assert.doesNotThrow(() => log("provider", error));
    assert.match(text(), /provider/);
    assert.doesNotMatch(text(), /getter failure/);
  });
}

test("error properties are read once and useful fields survive one broken accessor", (t) => {
  const { log, text } = fixture(t);
  let reads = 0;
  const error = {
    get message() { reads++; if (reads > 1) throw new Error("read twice"); return "expected message"; },
    get stack() { throw new Error("stack unavailable"); }
  };
  log("provider", error);
  assert.equal(reads, 1);
  assert.match(text(), /Error: expected message/);
});

test("hostile event metadata and revoked errors cannot break diagnostics", (t) => {
  const { log, text } = fixture(t);
  const hostile = { [Symbol.toPrimitive]() { throw new Error("conversion unavailable"); } };
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.doesNotThrow(() => log(hostile, proxy, hostile));
  assert.match(text(), /\[unprintable diagnostic\]/);
  assert.match(text(), /Error: no message/);
});

test("debug failure does not suppress runtime files and sensitive strings stay redacted", (t) => {
  const { log, text } = fixture(t, { debugLog: () => { throw new Error("debug unavailable"); } });
  log("provider\nforged-event", new Error("refreshToken=SYNTHETIC_SECRET https://user:SYNTHETIC_PASSWORD@invalid.test"), "Authorization: Bearer SYNTHETIC_AUTH");
  const output = text();
  assert.match(output, /provider forged-event/);
  for (const secret of ["SYNTHETIC_SECRET", "SYNTHETIC_PASSWORD", "SYNTHETIC_AUTH"]) assert.equal(output.includes(secret), false);
  assert.match(output, /REDACTED/);
});

test("disabled diagnostics never resolve or create the user data directory", (t) => {
  let resolutions = 0;
  const { directory, log } = fixture(t, {
    isEnabled: () => false,
    getDirectory: () => { resolutions++; throw new Error("profile must not be read"); }
  });
  log("provider", new Error("fixture"));
  assert.equal(resolutions, 0);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("failed rotation never grows the active log or removes an unknown obstacle, and recovers after repair", (t) => {
  const { directory, log } = fixture(t);
  const active = path.join(directory, 'runtime-errors.log');
  const obstacle = active + '.1';
  fs.writeFileSync(active, Buffer.alloc(RUNTIME_LOG_MAX_BYTES, 'x'));
  fs.mkdirSync(obstacle); fs.writeFileSync(path.join(obstacle, 'sentinel'), 'preserve');
  for (let i = 0; i < 3; i++) assert.doesNotThrow(() => log('rotation-blocked', new Error('synthetic')));
  assert.equal(fs.statSync(active).size, RUNTIME_LOG_MAX_BYTES);
  assert.equal(fs.readFileSync(path.join(obstacle, 'sentinel'), 'utf8'), 'preserve');
  fs.renameSync(obstacle, obstacle + '-preserved');
  log('rotation-recovered', new Error('synthetic'));
  assert.match(fs.readFileSync(active, 'utf8'), /rotation-recovered/);
  assert.ok(fs.statSync(active).size <= RUNTIME_LOG_MAX_BYTES);
  assert.equal(fs.statSync(obstacle).size, RUNTIME_LOG_MAX_BYTES);
});
