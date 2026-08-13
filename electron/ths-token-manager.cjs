"use strict";

const tokenCaches = new Map();

function tokenExpiry(json, now = Date.now()) {
  const raw = Number(
    json?.data?.expires_in
      ?? json?.data?.expiresIn
      ?? json?.expires_in
      ?? json?.expiresIn
  );
  const ttlMs = Number.isFinite(raw) && raw > 0
    ? raw * (raw > 10_000_000 ? 1 : 1000)
    : 6.5 * 24 * 60 * 60 * 1000;
  return now + Math.max(60_000, ttlMs - 60_000);
}

async function getThsAccessToken(refreshToken, fetchJson, options = {}) {
  const normalizedToken = String(refreshToken || "");
  if (!normalizedToken) throw new Error(options.missingMessage || "请先填写同花顺 refresh token");
  const cacheKey = String(options.cacheKey || "default");
  const cached = tokenCaches.get(cacheKey);
  if (
    cached?.refreshToken === normalizedToken &&
    cached.accessToken &&
    cached.expiresAt > Date.now()
  ) {
    return cached.accessToken;
  }
  if (cached?.refreshToken === normalizedToken && cached.promise) {
    return cached.promise;
  }
  const promise = (async () => {
    const json = await fetchJson(`${options.baseUrl}/get_access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        refresh_token: normalizedToken
      }
    });
    const accessToken = String(json?.data?.access_token || "");
    if (!accessToken) throw new Error(json?.message || options.failureMessage || "同花顺 access token 获取失败");
    tokenCaches.set(cacheKey, {
      refreshToken: normalizedToken,
      accessToken,
      expiresAt: tokenExpiry(json)
    });
    return accessToken;
  })().catch((error) => {
    if (tokenCaches.get(cacheKey)?.promise === promise) tokenCaches.delete(cacheKey);
    throw error;
  });
  tokenCaches.set(cacheKey, { refreshToken: normalizedToken, promise });
  return promise;
}

function invalidateThsAccessToken(refreshToken, cacheKey = "default", rejectedAccessToken = "") {
  const cached = tokenCaches.get(String(cacheKey));
  const refreshTokenMatches = !refreshToken || cached?.refreshToken === String(refreshToken);
  const accessTokenMatches = !rejectedAccessToken || cached?.accessToken === String(rejectedAccessToken);
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
    try {
      return await request(accessToken);
    } catch (error) {
      if (attempt > 0 || !isThsAuthenticationError(error)) throw error;
      invalidateThsAccessToken(refreshToken, cacheKey, accessToken);
    }
  }
  throw new Error(options.failureMessage || "同花顺授权失败");
}

module.exports = {
  getThsAccessToken,
  invalidateThsAccessToken,
  isThsAuthenticationError,
  thsProviderError,
  withThsAccessToken,
  tokenExpiry
};
