"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const {
  fetchWithPolicy,
  scheduleOrigin,
  isRetryableRequestError,
  retryAfterMilliseconds
} = require("./http-client.cjs");

test("HTTP client parses Retry-After seconds", () => {
  const response = { headers: { get: () => "2" } };
  assert.equal(retryAfterMilliseconds(response), 2000);
});

test("an already cancelled caller never starts an HTTP request", async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true }; };
  t.after(() => { global.fetch = originalFetch; });
  const controller = new AbortController();
  const reason = new Error("scan cancelled");
  controller.abort(reason);
  await assert.rejects(fetchWithPolicy("https://cancel-before.test/data", { signal: controller.signal }, { retries: 2 }), error => error === reason);
  assert.equal(calls, 0);
});

test("caller cancellation aborts an active HTTP request without retrying", async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  global.fetch = async (_url, options) => {
    calls += 1;
    started();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true }), 80);
      options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    });
  };
  t.after(() => { global.fetch = originalFetch; });
  const controller = new AbortController();
  const reason = new Error("cancel active scan");
  const request = fetchWithPolicy("https://cancel-active.test/data", { signal: controller.signal }, { retries: 3 });
  await entered;
  controller.abort(reason);
  await assert.rejects(request, error => error === reason);
  assert.equal(calls, 1);
});

test("caller cancellation interrupts Retry-After instead of issuing another request", async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  global.fetch = async () => {
    calls += 1; started();
    return { ok: false, status: 429, headers: { get: () => "0.2" } };
  };
  t.after(() => { global.fetch = originalFetch; });
  const controller = new AbortController();
  const request = fetchWithPolicy("https://cancel-retry.test/data", { signal: controller.signal }, { retries: 1 });
  await entered;
  await new Promise(resolve => setImmediate(resolve));
  const reason = new Error("cancel retry");
  controller.abort(reason);
  await assert.rejects(request, error => error === reason);
  assert.equal(calls, 1);
});

test("cancelled origin queue entries finish promptly without blocking the next request", async () => {
  const url = "https://cancel-queue.test/data";
  await scheduleOrigin(url, 120);
  const controller = new AbortController();
  const reason = new Error("cancel queued request");
  const queued = scheduleOrigin(url, 120, controller.signal);
  const rejected = assert.rejects(queued, error => error === reason);
  controller.abort(reason);
  const result = await Promise.race([rejected.then(() => "cancelled"), new Promise(resolve => setTimeout(() => resolve("still waiting"), 60))]);
  assert.equal(result, "cancelled");
  await scheduleOrigin(url, 1);
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

test("an unsuccessful streaming response releases its socket before returning", async (t) => {
  let streamClosed = false;
  const server = http.createServer((_request, response) => {
    response.writeHead(503, { "Content-Type": "text/plain" });
    response.write("provider unavailable\n");
    const timer = setInterval(() => response.write("still streaming\n"), 20);
    response.on("close", () => { streamClosed = true; clearInterval(timer); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await assert.rejects(fetchWithPolicy(`http://127.0.0.1:${server.address().port}/error`, {}, { retries: 0 }), /HTTP 503/);
  const deadline = Date.now() + 500;
  while (!streamClosed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(streamClosed, true, "failed response must not leave an unread stream and connection active");
});

test("cleanup rejection preserves the original HTTP status and permanent-error policy", async (t) => {
  const originalFetch = global.fetch;
  let cancels = 0;
  let calls = 0;
  global.fetch = async () => ({ ok: false, status: (++calls, 400), body: { cancel: async () => { cancels++; throw new Error("already closed"); } } });
  t.after(() => { global.fetch = originalFetch; });
  await assert.rejects(fetchWithPolicy("https://cleanup.test/", {}, { retries: 2 }), /HTTP 400/);
  assert.equal(calls, 1);
  assert.equal(cancels, 1);
});

test("a successful raw response keeps its body available to the caller", async (t) => {
  const originalFetch = global.fetch;
  const response = new Response("successful payload");
  global.fetch = async () => response;
  t.after(() => { global.fetch = originalFetch; });
  const actual = await fetchWithPolicy("https://success.test/", {}, { retries: 0 });
  assert.ok(actual instanceof Response);
  assert.equal(actual.status, response.status);
  assert.equal(await actual.text(), "successful payload");
});
