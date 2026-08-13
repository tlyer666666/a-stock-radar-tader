"use strict";

const originQueues = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMilliseconds(response, maximumMs = 30_000) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(maximumMs, Math.max(0, seconds * 1000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(maximumMs, Math.max(0, timestamp - Date.now()))
    : 0;
}

function isRetryableRequestError(error) {
  const status = Number(error?.status || 0);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function scheduleOrigin(url, minimumGapMs = 0) {
  if (!(minimumGapMs > 0)) return;
  const origin = new URL(String(url)).origin;
  const state = originQueues.get(origin) || {
    lastRequestAt: 0,
    queue: Promise.resolve()
  };
  originQueues.set(origin, state);
  const scheduled = state.queue.then(async () => {
    const remaining = minimumGapMs - (Date.now() - state.lastRequestAt);
    if (remaining > 0) await sleep(remaining);
    state.lastRequestAt = Date.now();
  });
  state.queue = scheduled.catch(() => {});
  await scheduled;
}

async function runWithPolicy(url, options = {}, policy = {}, consume = async (response) => response) {
  const timeoutMs = Math.max(1000, Number(policy.timeoutMs) || 12000);
  const retries = Math.max(0, Math.min(4, Number(policy.retries) || 0));
  const minimumGapMs = Math.max(0, Number(policy.minimumGapMs) || 0);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await scheduleOrigin(url, minimumGapMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...(policy.headers || {}),
          ...(options.headers || {})
        }
      });
      if (response.ok) return await consume(response);
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableRequestError(error)) break;
      const serverDelay = retryAfterMilliseconds(response);
      const exponentialDelay = Math.min(5000, 300 * (2 ** attempt));
      const jitter = Math.floor(Math.random() * 120);
      await sleep(Math.max(serverDelay, exponentialDelay + jitter));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function fetchWithPolicy(url, options = {}, policy = {}) {
  return runWithPolicy(url, options, policy);
}

async function fetchJsonWithPolicy(url, options = {}, policy = {}) {
  const { headers: policyHeaders = {}, ...restPolicy } = policy;
  return runWithPolicy(url, options, {
    ...restPolicy,
    headers: {
      Accept: "application/json, text/plain, */*",
      ...policyHeaders
    }
  }, (response) => response.json());
}

async function fetchArrayBufferWithPolicy(url, options = {}, policy = {}) {
  return runWithPolicy(url, options, policy, (response) => response.arrayBuffer());
}

module.exports = {
  fetchWithPolicy,
  fetchJsonWithPolicy,
  fetchArrayBufferWithPolicy,
  isRetryableRequestError,
  retryAfterMilliseconds,
  scheduleOrigin
};
