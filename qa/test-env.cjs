"use strict";
// 幂等：本文件既是 node --require 的预加载，也会被网络敏感用例在文件内 require
// （否则直接跑 `node --test electron/xxx.test.cjs` 时守卫不生效，测试会真连外网）。
// 重复执行会二次包装 fetch/http，导致 origin 检查叠加，故只执行一次。
if (globalThis.__ASTOCK_TEST_ENV_READY__) return;
globalThis.__ASTOCK_TEST_ENV_READY__ = true;
// 单测统一的密闭环境（node --require 预加载，会传给 node --test 的每个子进程）：
// 东方财富 curl 逃生通道会绕过 fetch 替身直连真实网络，测试里默认关闭。
// 专门测试 curl 兜底的用例可在文件内把 ASTOCK_DISABLE_CURL 设回空串。
if (process.env.ASTOCK_DISABLE_CURL === undefined) process.env.ASTOCK_DISABLE_CURL = "1";
// 用例用 fetch 替身模拟行情源；undici 落在 CVE 规避区间的 Node 上 http-client 会改走原生传输，
// 替身就失效（曾导致 50 个用例只在这类环境失败）。测试统一固定为 fetch 传输。
if (process.env.ASTOCK_HTTP_TRANSPORT === undefined) process.env.ASTOCK_HTTP_TRANSPORT = "fetch";

// Public fallback providers can bypass an individual test's injected adapter.
// Fail closed at both shared transports; localhost fixtures stay usable.
const { URL } = require('node:url');
const allowed = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function checkTarget(input) {
  let host;
  if (typeof input === 'string' || input instanceof URL) host = new URL(String(input)).hostname;
  else {
    host = String(input?.hostname || input?.host || 'localhost');
    if (!allowed.has(host.toLowerCase())) host = new URL(`http://${host}`).hostname;
  }
  if (!allowed.has(host.toLowerCase())) throw Object.assign(new Error(`单测禁止访问外部网络：${host}`), { code: 'TEST_NETWORK_BLOCKED', status: 400 });
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => { checkTarget(input instanceof Request ? input.url : input); return originalFetch(input, options); };
for (const transport of [require('node:http'), require('node:https')]) {
  for (const method of ['request', 'get']) {
    const original = transport[method];
    transport[method] = function(input, ...args) {
      checkTarget(input);
      // request(url, options) 时 options 里的 hostname/host 会覆盖 url，也要检查。
      const options = args[0];
      if ((typeof input === 'string' || input instanceof URL) && options && typeof options === 'object' && (options.hostname || options.host)) checkTarget(options);
      return Reflect.apply(original, this, [input, ...args]);
    };
  }
}
