"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getThsAccessToken,
  invalidateThsAccessToken,
  isThsAuthenticationError,
  thsProviderError,
  withThsAccessToken,
  tokenExpiry
} = require("./ths-token-manager.cjs");

test("THS token manager honors server expiry and shares a token by cache key", async () => {
  let requests = 0;
  const fetchJson = async () => {
    requests += 1;
    return { data: { access_token: "access-1", expires_in: 3600 } };
  };
  const options = { baseUrl: "https://example.test", cacheKey: "test-expiry" };
  assert.equal(await getThsAccessToken("refresh-1", fetchJson, options), "access-1");
  assert.equal(await getThsAccessToken("refresh-1", fetchJson, options), "access-1");
  assert.equal(requests, 1);
  assert.ok(tokenExpiry({ data: { expires_in: 3600 } }, 0) >= 3_500_000);
});

test("THS token manager shares a concurrent refresh request", async () => {
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchJson = async () => {
    requests += 1;
    await gate;
    return { data: { access_token: "shared-token", expires_in: 3600 } };
  };
  const options = { baseUrl: "https://example.test", cacheKey: "test-concurrent" };
  const first = getThsAccessToken("refresh-shared", fetchJson, options);
  const second = getThsAccessToken("refresh-shared", fetchJson, options);
  release();

  assert.deepEqual(await Promise.all([first, second]), ["shared-token", "shared-token"]);
  assert.equal(requests, 1);
});

test("THS token manager can invalidate a rejected access token", async () => {
  let requests = 0;
  const fetchJson = async () => ({
    data: { access_token: `access-${++requests}`, expires_in: 3600 }
  });
  const options = { baseUrl: "https://example.test", cacheKey: "test-invalidate" };
  assert.equal(await getThsAccessToken("refresh-2", fetchJson, options), "access-1");
  invalidateThsAccessToken("refresh-2", "test-invalidate");
  assert.equal(await getThsAccessToken("refresh-2", fetchJson, options), "access-2");
});

test("a stale rejection cannot invalidate a newer THS token", async () => {
  let requests = 0;
  const fetchJson = async () => ({
    data: { access_token: `fresh-${++requests}`, expires_in: 3600 }
  });
  const options = { baseUrl: "https://example.test", cacheKey: "test-stale-rejection" };
  assert.equal(await getThsAccessToken("refresh-stale", fetchJson, options), "fresh-1");
  invalidateThsAccessToken("refresh-stale", "test-stale-rejection", "fresh-1");
  assert.equal(await getThsAccessToken("refresh-stale", fetchJson, options), "fresh-2");
  invalidateThsAccessToken("refresh-stale", "test-stale-rejection", "fresh-1");
  assert.equal(await getThsAccessToken("refresh-stale", fetchJson, options), "fresh-2");
  assert.equal(requests, 2);
});

test("THS token manager refreshes once after an authentication rejection", async () => {
  let tokenCalls = 0;
  const fetchJson = async () => ({
    data: { access_token: `token-${++tokenCalls}`, expires_in: 3600 }
  });
  const observed = [];
  const result = await withThsAccessToken("refresh-retry", fetchJson, async (accessToken) => {
    observed.push(accessToken);
    if (observed.length === 1) {
      const error = new Error("access token 已失效");
      error.status = 401;
      throw error;
    }
    return "ok";
  }, { baseUrl: "https://example.test", cacheKey: "retry-test" });

  assert.equal(result, "ok");
  assert.deepEqual(observed, ["token-1", "token-2"]);
  assert.equal(tokenCalls, 2);
  assert.equal(isThsAuthenticationError(new Error("network timeout")), false);
  assert.equal(isThsAuthenticationError(thsProviderError({ errorcode: 1001, message: "认证失败" })), true);
});
