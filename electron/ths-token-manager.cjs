"use strict";

const { BoundedCache } = require("./bounded-cache.cjs");
const { createServiceRuntime } = require("./service-runtime.cjs");
const tokenCaches = new BoundedCache({ maxEntries: 128, maxBytes: 512 * 1024 });
const tokenRuntime = createServiceRuntime();

function tokenExpiry(json, now = Date.now()) {
  const value = (
    json?.data?.expires_in
      ?? json?.data?.expiresIn
      ?? json?.expires_in
      ?? json?.expiresIn
  );
  const raw = value === null || value === undefined || value === "" ? NaN : Number(value);
  const ttlMs = Number.isFinite(raw) && raw >= 0
    ? raw * (raw > 10_000_000 ? 1 : 1000)
    : 6.5 * 24 * 60 * 60 * 1000;
  // Refresh early, but never extend a short server lifetime into a one-minute
  // cache entry. Explicit zero means immediately expired; absent TTL has fallback.
  return now + Math.max(0, ttlMs - Math.min(60_000, ttlMs * 0.1));
}

async function getThsAccessToken(refreshToken, fetchJson, options = {}) {
  const normalizedToken = String(refreshToken || "");
  if (!normalizedToken) throw new Error(options.missingMessage || "请先填写同花顺 refresh token");
  tokenRuntime.checkpoint();
  const cacheKey = String(options.cacheKey || "default");
  const cached = tokenCaches.get(cacheKey);
  const credential = cached?.value?.refreshToken ?? cached?.refreshToken;
  if (credential && credential !== normalizedToken) tokenCaches.delete(cacheKey);
  const subscription = tokenRuntime.cached(tokenCaches, cacheKey,
    value => Math.max(0, value.expiresAt - Date.now()), async () => {
    const json = await tokenRuntime.track(() => fetchJson(`${options.baseUrl}/get_access_token`, {
      signal: tokenRuntime.signal(),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        refresh_token: normalizedToken
      }
    }));
    tokenRuntime.checkpoint();
    const accessToken = String(json?.data?.access_token || "");
    if (!accessToken) throw new Error(json?.message || options.failureMessage || "同花顺 access token 获取失败");
    return { refreshToken: normalizedToken, accessToken, expiresAt: tokenExpiry(json) };
  });
  // Pending metadata identifies the credential before any token value exists.
  const pending = tokenCaches.get(cacheKey);
  if (pending?.promise) pending.refreshToken = normalizedToken;
  return (await subscription).accessToken;
}

function invalidateThsAccessToken(refreshToken, cacheKey = "default", rejectedAccessToken = "") {
  const cached = tokenCaches.get(String(cacheKey));
  const refreshTokenMatches = !refreshToken || (cached?.value?.refreshToken ?? cached?.refreshToken) === String(refreshToken);
  const accessTokenMatches = !rejectedAccessToken || cached?.value?.accessToken === String(rejectedAccessToken);
  if (refreshTokenMatches && accessTokenMatches) {
    tokenCaches.delete(String(cacheKey));
  }
}

function isThsAuthenticationError(error) {
  const status = Number(error?.status || 0);
  if (status === 401 || status === 403) return true;
  const providerCode = String(error?.providerCode || error?.code || "").trim().toLowerCase();
  if (/^(?:401|403|1001|1002|1003|1004|1005|1006)$/.test(providerCode)) return true;
  const message = String(error?.message || error || "").toLowerCase();
  return /(?:access[_ ]?token|鉴权|授权|令牌|token).*(?:失效|无效|过期|expired|invalid)|(?:失效|无效|过期|expired|invalid).*(?:access[_ ]?token|鉴权|授权|令牌|token)/i.test(message);
}

function thsProviderError(json, fallbackMessage = "同花顺接口请求失败") {
  const error = new Error(json?.errmsg || json?.message || fallbackMessage);
  error.providerCode = json?.errorcode ?? json?.code ?? "";
  return error;
}

async function withThsAccessToken(refreshToken, fetchJson, request, options = {}) {
  const cacheKey = String(options.cacheKey || "default");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await getThsAccessToken(refreshToken, fetchJson, options);
    tokenRuntime.checkpoint();
    try {
      const value = await request(accessToken);
      tokenRuntime.checkpoint();
      return value;
    } catch (error) {
      tokenRuntime.checkpoint();
      if (attempt > 0 || !isThsAuthenticationError(error)) throw error;
      invalidateThsAccessToken(refreshToken, cacheKey, accessToken);
    }
  }
  throw new Error(options.failureMessage || "同花顺授权失败");
}

function shutdownThsTokenManager() {
  const stopping = tokenRuntime.shutdown();
  tokenCaches.clear();
  return stopping;
}

module.exports = {
  getThsAccessToken,
  invalidateThsAccessToken,
  isThsAuthenticationError,
  thsProviderError,
  withThsAccessToken,
  shutdownThsTokenManager,
  tokenExpiry
};
