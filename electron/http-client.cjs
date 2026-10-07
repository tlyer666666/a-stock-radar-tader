"use strict";

const { createTransportAdmission } = require("./transport-admission.cjs");
const transport = createTransportAdmission();

function abortReason(signal) {
  return signal.reason ?? new DOMException("Request cancelled", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(abortReason(signal)); };
    signal?.addEventListener("abort", abort, { once: true });
  });
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
  if (["QUEUE_FULL", "QUEUE_TIMEOUT"].includes(error?.code)) return false;
  const status = Number(error?.status || 0);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function scheduleOrigin(url, minimumGapMs = 0, signal) {
  throwIfAborted(signal);
  if (!(minimumGapMs > 0)) return;
  const release = await transport.acquire(url, { minimumGapMs, signal });
  release();
}

async function runWithTransportSlot(task, { url, minimumGapMs = 0, signal, queueTimeoutMs = 30000 } = {}) {
  const release = await transport.acquire(url, { minimumGapMs, signal, queueTimeoutMs });
  try {
    throwIfAborted(signal);
    const value = await task();
    throwIfAborted(signal);
    return value;
  } finally {
    release();
  }
}

function getHttpDiagnostics() { return transport.getDiagnostics(); }

// Keep a raw response's lease and request timer attached to the actual source
// stream. Native Response methods and clone/tee consume this same bounded source.
function responseWithOwnedBody(response, signal, finish) {
  if (!response.body || typeof response.body.getReader !== "function") {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  let controller;
  let closed = false;
  let cancellation;
  const complete = () => {
    signal.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch { /* a pending read may still hold it */ }
    finish();
  };
  const cancel = (reason, errorStream) => {
    if (cancellation) return cancellation;
    if (closed) return Promise.resolve();
    closed = true;
    if (errorStream) controller.error(reason);
    cancellation = Promise.resolve().then(() => reader.cancel(reason)).finally(complete);
    return cancellation;
  };
  const abort = () => { void cancel(abortReason(signal), true).catch(() => {}); };
  const stream = new ReadableStream({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      try {
        const item = await reader.read();
        if (closed) return;
        if (item.done) {
          closed = true;
          value.close();
          complete();
        } else value.enqueue(item.value);
      } catch (error) {
        if (closed) return;
        closed = true;
        value.error(error);
        complete();
      }
    },
    cancel(reason) { return cancel(reason, false); }
  });
  function preserveMetadata(value) {
    for (const key of ["url", "redirected", "type"]) {
      Object.defineProperty(value, key, { value: response[key], configurable: true });
    }
    const clone = value.clone.bind(value);
    Object.defineProperty(value, "clone", { value: () => preserveMetadata(clone()), configurable: true });
    return value;
  }
  return preserveMetadata(new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers }));
}

async function runWithPolicy(url, options = {}, policy = {}, consume = null) {
  const timeoutMs = Math.max(1000, Number(policy.timeoutMs) || 12000);
  const retries = Math.max(0, Math.min(4, Number(policy.retries) || 0));
  const minimumGapMs = Math.max(0, Number(policy.minimumGapMs) || 0);
  const callerSignal = options.signal;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // Queue cancellation/deadline is independent of the physical request timer.
    // Acquisition failures never enter the retry loop or consume a network slot.
    const release = await transport.acquire(url, {
      minimumGapMs, signal: callerSignal, queueTimeoutMs: policy.queueTimeoutMs
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    let response;
    let rawOwned = false;
    let retryDelay = 0;
    const finish = () => { clearTimeout(timer); release(); };
    try {
      throwIfAborted(signal);
      response = await fetch(url, {
        ...options,
        signal,
        headers: { ...(policy.headers || {}), ...(options.headers || {}) }
      });
      throwIfAborted(signal);
      if (response.ok) {
        if (!consume) {
          const value = responseWithOwnedBody(response, signal, finish);
          rawOwned = true;
          return value;
        }
        const value = await consume(response);
        throwIfAborted(signal);
        return value;
      }
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    } catch (error) {
      // Failed and cancelled attempts have no body owner. Wait for cleanup
      // before freeing the physical slot, including before any retry backoff.
      try { await response?.body?.cancel(); } catch { /* preserve original error */ }
      throwIfAborted(callerSignal);
      lastError = error;
      if (attempt >= retries || !isRetryableRequestError(error)) break;
      const serverDelay = retryAfterMilliseconds(response);
      const exponentialDelay = Math.min(5000, 300 * (2 ** attempt));
      const jitter = Math.floor(Math.random() * 120);
      retryDelay = Math.max(serverDelay, exponentialDelay + jitter);
    } finally {
      if (!rawOwned) finish();
    }
    await sleep(retryDelay, callerSignal);
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
  scheduleOrigin,
  runWithTransportSlot,
  getHttpDiagnostics
};
