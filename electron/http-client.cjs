"use strict";

const { createTransportAdmission } = require("./transport-admission.cjs");
const transport = createTransportAdmission();
const { fetchNative, requiresNativeTransport } = require('./native-http.cjs');
// 单测（qa/test-env.cjs）把传输固定为 fetch，让用例的 fetch 替身在任何 Node/undici 版本上都生效；
// 生产环境不设此变量，仍按 undici 版本决定是否走原生传输（CVE 规避）。原生传输由 native-http.test 单独覆盖。
const nativeTransportRequired = process.env.ASTOCK_HTTP_TRANSPORT === "fetch" ? false : requiresNativeTransport();

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

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function responseTooLargeError(limit) {
  const error = new Error(`响应体超过 ${limit} 字节上限`);
  error.code = "RESPONSE_TOO_LARGE";
  return error;
}

function declaredLength(response) {
  const value = Number(response?.headers?.get?.("content-length"));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function readLimitedBody(response, limit) {
  if (!response.body || typeof response.body.getReader !== "function") return response;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) {
        const error = responseTooLargeError(limit);
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      chunks.push(item.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/**
 * Read a response that was obtained outside runWithPolicy (for example through an
 * injected fetch) under the same byte ceiling: reject on content-length first, then
 * on the streamed total. Returns the raw bytes.
 */
async function readResponseBytesWithinLimit(response, limit = DEFAULT_MAX_RESPONSE_BYTES) {
  const ceiling = Math.max(1, Number(limit) || DEFAULT_MAX_RESPONSE_BYTES);
  const length = declaredLength(response);
  if (length !== null && length > ceiling) {
    try { await response?.body?.cancel?.(); } catch { /* keep the size error */ }
    throw responseTooLargeError(ceiling);
  }
  const limited = await readLimitedBody(response, ceiling);
  const bytes = Buffer.from(await limited.arrayBuffer());
  if (bytes.byteLength > ceiling) throw responseTooLargeError(ceiling);
  return bytes;
}

function isRetryableRequestError(error) {
  if (error instanceof SyntaxError || error?.name === 'SyntaxError' || error?.code === 'ERR_INVALID_URL') return false;
  if (["QUEUE_FULL", "QUEUE_TIMEOUT", "RESPONSE_TOO_LARGE", "INVALID_CONTENT_ENCODING"].includes(error?.code)) return false;
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

function getHttpDiagnostics() {
  // R-05：requiresNativeTransport 按内嵌 undici 版本判断 GHSA-xjj6-f33q-929c 规避区间。
  // Electron 升级会换 undici，把"运行时版本 + 是否走原生"放进诊断，方便升级后复核而不是静默偏离。
  return { ...transport.getDiagnostics(), transportMode: { undici: process.versions.undici || null, native: nativeTransportRequired } };
}

// Keep a raw response's lease and request timer attached to the actual source
// stream. Native Response methods and clone/tee consume this same bounded source.
function responseWithOwnedBody(response, signal, finish, limit = DEFAULT_MAX_RESPONSE_BYTES) {
  if (!response.body || typeof response.body.getReader !== "function") {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  let controller;
  let closed = false;
  let cancellation;
  let received = 0;
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
        } else {
          received += item.value.byteLength;
          if (received > limit) {
            await cancel(responseTooLargeError(limit), true).catch(() => {});
            return;
          }
          value.enqueue(item.value);
        }
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
  const maxResponseBytes = Math.max(1, Number(policy.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES);
  const callerSignal = options.signal;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // Queue cancellation/deadline is independent of the physical request timer.
    // Acquisition failures never enter the retry loop or consume a network slot.
    const release = await transport.acquire(url, {
      minimumGapMs, signal: callerSignal, queueTimeoutMs: policy.queueTimeoutMs
    });
    const controller = new AbortController();
    // 超时要带明确原因：否则表现为无原因的 AbortError，会被 IPC 当成“用户取消”静默吞掉、也不提示重试。
    const timer = setTimeout(() => controller.abort(Object.assign(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`), { name: "TimeoutError", code: "ETIMEDOUT" })), timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    let response;
    let rawOwned = false;
    let retryDelay = 0;
    const finish = () => { clearTimeout(timer); release(); };
    try {
      throwIfAborted(signal);
      const headers = new Headers(policy.headers || {});
      new Headers(options.headers || {}).forEach((value, name) => headers.set(name, value));
      const requestOptions = {
        ...options,
        signal,
        headers: Object.fromEntries(headers)
      };
      response = nativeTransportRequired
        ? await fetchNative(url, requestOptions, maxResponseBytes)
        : await fetch(url, requestOptions);
      throwIfAborted(signal);
      if (response.ok) {
        const length = declaredLength(response);
        if (length !== null && length > maxResponseBytes) throw responseTooLargeError(maxResponseBytes);
        if (!consume) {
          const value = responseWithOwnedBody(response, signal, finish, maxResponseBytes);
          rawOwned = true;
          return value;
        }
        const value = await consume(await readLimitedBody(response, maxResponseBytes));
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
  const headers = new Headers({ Accept: "application/json, text/plain, */*" });
  new Headers(policyHeaders).forEach((value, name) => headers.set(name, value));
  return runWithPolicy(url, options, { ...restPolicy, headers }, (response) => response.json());
}

async function fetchArrayBufferWithPolicy(url, options = {}, policy = {}) {
  return runWithPolicy(url, options, policy, (response) => response.arrayBuffer());
}

module.exports = {
  fetchWithPolicy,
  fetchJsonWithPolicy,
  fetchArrayBufferWithPolicy,
  readResponseBytesWithinLimit,
  DEFAULT_MAX_RESPONSE_BYTES,
  isRetryableRequestError,
  retryAfterMilliseconds,
  scheduleOrigin,
  runWithTransportSlot,
  getHttpDiagnostics
};
