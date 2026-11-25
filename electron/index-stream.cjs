"use strict";

/**
 * 驾驶舱指数实时推送，两路并行、谁先到用谁：
 * 1. 每个指数一条东方财富 stock/sse 推送流（服务端主动推增量字段；免费推送实测约 6 秒一次）；
 * 2. 每 1 秒一次的批量快照（pollQuotes）。交易所指数快照每 3 秒一次（实测 13:36:54、57、00…），
 *    1 秒轮询能在新快照出来后 1 秒内拿到。
 * 两路数据按接口时间戳（f86，秒）合并，旧的不覆盖新的；只有价格等字段真的变了才推给页面，
 * 同一事件循环内到达的多条攒成一批，0ms 定时立刻发——页面收到就重绘，界面端是毫秒级。
 *
 * 说明：交易所 Level-1 行情本身就是每 3 秒一个快照，任何免费源（包括同花顺 App 免费版）都不可能
 * 做到“每毫秒一个新价”；这里做到的是交易所一出新价，1 秒内送到界面。
 *
 * 安全与资源边界（对应 AGENTS 的网络读取约定）：
 * - 单个事件超过 maxEventBytes 视为异常响应，断开重连；单条连接累计超过 maxConnectionBytes 主动重连，内存不会无限增长。
 * - idleMs 内一个字节都没收到（含心跳）就断开重连；失败按 1/2/5/10/30 秒退避。
 * - 租约：页面每 10 秒续一次，leaseMs 内没续（页面关了、切走了、渲染进程崩了）自动停掉全部连接。
 * - 长连接不占 http-client 的传输槽位（槽位只给一次性请求用），所以 openSse 由调用方单独实现。
 */

const { INDEX_BOARD } = require("./index-board.cjs");

const SSE_URL = "https://push2.eastmoney.com/api/qt/stock/sse";
const FIELDS = "f43,f44,f45,f46,f48,f60,f86,f113,f114,f115,f169,f170";
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

const num = value => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() && value !== "-" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const count = value => { const n = num(value); return n !== null && n >= 0 ? Math.round(n) : null; };

function streamUrl(secid) {
  return `${SSE_URL}?fltt=2&invt=2&secid=${secid}&fields=${FIELDS}&mpi=1000`;
}

/** 东方财富 stock 字段 → 指数条字段。只返回本次出现过的字段（增量推送只带变化的字段）。 */
function quoteFromFields(fields, meta) {
  const s = num(fields.f86);
  const stamp = s !== null && s > 0 ? new Date(s * 1000 + 8 * 3600_000).toISOString() : "";
  return {
    code: meta.code, secid: meta.secid, name: meta.name,
    latest: num(fields.f43), change: num(fields.f169), changePct: num(fields.f170),
    high: num(fields.f44), low: num(fields.f45), open: num(fields.f46), preClose: num(fields.f60),
    amount: num(fields.f48), up: count(fields.f113), down: count(fields.f114), flat: count(fields.f115),
    date: stamp.slice(0, 10), time: stamp.slice(11, 19)
  };
}

/**
 * SSE 文本解析：按空行切事件，取 data: 行拼成 JSON。返回 { events, rest }，rest 是还没收完的半个事件。
 */
function parseSseChunk(buffer) {
  const events = [];
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const data = part.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try { events.push(JSON.parse(data)); } catch { /* 坏事件跳过，不中断整条流 */ }
  }
  return { events, rest };
}

function createIndexStream({
  openSse,
  emit = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = handle => clearTimeout(handle),
  leaseMs = 30_000,
  idleMs = 45_000,
  maxEventBytes = 64 * 1024,
  maxConnectionBytes = 16 * 1024 * 1024,
  instruments = INDEX_BOARD,
  pollQuotes = null,
  pollMs = 1000,
  log = () => {}
} = {}) {
  if (typeof openSse !== "function") throw new TypeError("openSse is required");
  const fields = new Map();      // secid → 合并后的原始字段
  const connected = new Set();   // 当前已收到过数据的连接
  let controller = null;
  let leaseUntil = 0;
  let leaseTimer = null;
  let flushTimer = null;
  const pending = new Set();
  let lastTickAt = 0;
  let stopped = false;
  let polled = false;

  const quoteOf = meta => fields.has(meta.secid) ? quoteFromFields(fields.get(meta.secid), meta) : null;

  function flush() {
    flushTimer = null;
    if (!pending.size) return;
    const quotes = instruments.filter(meta => pending.has(meta.secid)).map(quoteOf).filter(Boolean);
    pending.clear();
    lastTickAt = now();
    try { emit({ at: new Date(lastTickAt).toISOString(), atMs: lastTickAt, quotes }); } catch { /* 页面不在不影响推送 */ }
  }

  function accept(meta, event, { fromStream = true } = {}) {
    if (!event || event.rc !== 0 || !event.data || typeof event.data !== "object") return;
    const previous = fields.get(meta.secid) || {};
    const incomingStamp = num(event.data.f86);
    const knownStamp = num(previous.f86);
    // 两路数据合并：接口时间戳更旧的快照不覆盖已有的新数据。
    if (incomingStamp !== null && knownStamp !== null && incomingStamp < knownStamp) return;
    const merged = event.full === 1 && fromStream ? { ...event.data } : { ...previous, ...event.data };
    fields.set(meta.secid, merged);
    if (fromStream) connected.add(meta.secid);
    const changed = Object.keys(merged).some(key => key !== "f86" && merged[key] !== previous[key]);
    if (!changed) return;
    pending.add(meta.secid);
    // 同一轮事件循环里到达的多条（多个指数同一时刻更新）合成一批，0ms 定时即发，不额外等待。
    if (!flushTimer) flushTimer = setTimer(flush, 0);
  }

  async function runOne(meta, signal) {
    let attempt = 0;
    while (!signal.aborted) {
      const connection = new AbortController();
      const onAbort = () => connection.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      let idle = null;
      const armIdle = () => { if (idle) clearTimer(idle); idle = setTimer(() => connection.abort(new Error("idle")), idleMs); };
      let received = 0;
      try {
        armIdle();
        const body = await openSse(streamUrl(meta.secid), { signal: connection.signal });
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        for await (const chunk of body) {
          armIdle();
          const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
          received += bytes;
          buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
          const { events, rest } = parseSseChunk(buffer);
          buffer = rest;
          if (Buffer.byteLength(buffer) > maxEventBytes) throw new Error("事件过大");
          for (const event of events) accept(meta, event);
          if (events.length) attempt = 0;
          if (received > maxConnectionBytes) break; // 主动换一条新连接
        }
      } catch (error) {
        if (signal.aborted) break;
        log(`index-stream ${meta.secid} ${error?.message || error}`);
      } finally {
        if (idle) clearTimer(idle);
        signal.removeEventListener("abort", onAbort);
        connection.abort();
        connected.delete(meta.secid);
      }
      if (signal.aborted) break;
      const wait = received > maxConnectionBytes ? 0 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      await new Promise(resolve => {
        const onStop = () => { clearTimer(timer); resolve(); };
        const timer = setTimer(() => { signal.removeEventListener("abort", onStop); resolve(); }, wait);
        signal.addEventListener("abort", onStop, { once: true });
      });
    }
  }

  async function runPoll(signal) {
    while (!signal.aborted) {
      const started = now();
      try {
        const rows = await pollQuotes({ signal });
        for (const row of Array.isArray(rows) ? rows : []) {
          const meta = instruments.find(item => item.secid === row?.secid);
          if (meta && row.data && typeof row.data === "object") accept(meta, { rc: 0, data: row.data }, { fromStream: false });
        }
        polled = true;
      } catch (error) {
        if (signal.aborted) break;
        log(`index-stream poll ${error?.message || error}`);
      }
      const wait = Math.max(50, pollMs - (now() - started));
      await new Promise(resolve => {
        const onStop = () => { clearTimer(timer); resolve(); };
        const timer = setTimer(() => { signal.removeEventListener("abort", onStop); resolve(); }, wait);
        signal.addEventListener("abort", onStop, { once: true });
      });
    }
  }

  function stop(reason = "stopped") {
    if (leaseTimer) { clearTimer(leaseTimer); leaseTimer = null; }
    if (controller) { controller.abort(new Error(reason)); controller = null; }
    connected.clear();
    polled = false;
  }

  function checkLease() {
    leaseTimer = null;
    if (!controller) return;
    if (now() >= leaseUntil) { stop("lease-expired"); return; }
    leaseTimer = setTimer(checkLease, Math.min(5000, Math.max(50, leaseUntil - now())));
  }

  function status() {
    return {
      active: Boolean(controller),
      connected: connected.size,
      polling: typeof pollQuotes === "function" && Boolean(controller) && polled,
      total: instruments.length,
      lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : "",
      quotes: instruments.map(quoteOf).filter(Boolean)
    };
  }

  /** 页面订阅或续租。active:false 时立即停。 */
  function subscribe({ active = true } = {}) {
    if (stopped) return { ...status(), active: false };
    if (!active) { stop("unsubscribed"); return status(); }
    leaseUntil = now() + leaseMs;
    if (!controller) {
      controller = new AbortController();
      const signal = controller.signal;
      for (const meta of instruments) void runOne(meta, signal);
      if (typeof pollQuotes === "function") void runPoll(signal);
    }
    if (!leaseTimer) leaseTimer = setTimer(checkLease, Math.min(5000, leaseMs));
    return status();
  }

  function shutdown() {
    stopped = true;
    stop("shutdown");
    if (flushTimer) { clearTimer(flushTimer); flushTimer = null; }
  }

  return { subscribe, status, shutdown };
}

/**
 * 真实网络的 openSse：Node/Electron 主进程自带的 fetch，返回响应体（异步可迭代的字节流）。
 * 不经过 http-client 的传输槽位，避免 10 条长连接占满一次性请求的并发。
 */
function createFetchSse({ fetchImpl = globalThis.fetch } = {}) {
  return async (url, { signal } = {}) => {
    if (typeof fetchImpl !== "function") throw new Error("当前环境没有 fetch");
    const response = await fetchImpl(url, { signal, headers: { Accept: "text/event-stream", Referer: "https://quote.eastmoney.com/" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!/event-stream/i.test(String(response.headers.get("content-type") || ""))) throw new Error("不是推送流响应");
    if (!response.body) throw new Error("推送流没有响应体");
    return response.body;
  };
}

module.exports = { createIndexStream, createFetchSse, parseSseChunk, quoteFromFields, streamUrl };
