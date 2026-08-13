"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  fetchWithPolicy,
  isRetryableRequestError,
  retryAfterMilliseconds
} = require("./http-client.cjs");

test("HTTP client parses Retry-After seconds", () => {
  const response = { headers: { get: () => "2" } };
  assert.equal(retryAfterMilliseconds(response), 2000);
});

test("HTTP client ignores invalid Retry-After values", () => {
  const response = { headers: { get: () => "not-a-date" } };
  assert.equal(retryAfterMilliseconds(response), 0);
});

test("HTTP client caps remote Retry-After delays", () => {
  const response = { headers: { get: () => "3600" } };
  assert.equal(retryAfterMilliseconds(response), 30_000);
});

test("HTTP client does not retry permanent client errors", async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 400, headers: { get: () => null } };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(
    fetchWithPolicy("https://example.test/input", {}, { retries: 3, timeoutMs: 1000 }),
    /HTTP 400/
  );
  assert.equal(calls, 1);
  assert.equal(isRetryableRequestError({ status: 429 }), true);
  assert.equal(isRetryableRequestError({ status: 503 }), true);
});
