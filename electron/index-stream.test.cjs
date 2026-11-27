"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createIndexStream, createFetchSse, parseSseChunk, quoteFromFields, streamUrl } = require("./index-stream.cjs");

const SH = { secid: "1.000001", code: "000001", name: "上证指数", major: true };
const SZ = { secid: "0.399001", code: "399001", name: "深证成指", major: true };
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise(r => setTimeout(r, 5)); } };
const sse = obj => `data: ${JSON.stringify(obj)}\n\n`;

/** 可控的假推送流：测试往里 push 文本，close 结束，abort 时抛出。 */
function fakeStream(signal) {
  const queue = [];
  let wake = null;
  let done = false;
  signal?.addEventListener("abort", () => { done = true; wake?.(); }, { once: true });
  return {
    push(text) { queue.push(new TextEncoder().encode(text)); wake?.(); },
    close() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) { yield queue.shift(); continue; }
        if (done) { if (signal?.aborted) throw signal.reason ?? new Error("aborted"); return; }
        await new Promise(resolve => { wake = resolve; });
        wake = null;
      }
    }
  };
}

test("SSE chunks split into events across packet boundaries, bad events are skipped", () => {
  const first = parseSseChunk('data: {"rc":0,"full":1,"data":{"f43":3500}}\n\ndata: {"rc":0,"da');
  assert.deepEqual(first.events, [{ rc: 0, full: 1, data: { f43: 3500 } }]);
  const second = parseSseChunk(`${first.rest}ta":{"f43":3501}}\r\n\r\ndata: not-json\n\n`);
  assert.deepEqual(second.events, [{ rc: 0, data: { f43: 3501 } }]);
  assert.equal(second.rest, "");
  assert.match(streamUrl("1.000688"), /stock\/sse\?fltt=2&invt=2&secid=1\.000688&fields=f43/);
});

test("eastmoney stock fields map to the index board fields with Beijing time to the second", () => {
  const quote = quoteFromFields({ f43: 3503.26, f44: 3526.34, f45: 3496.59, f46: 3522.59, f48: 4.12e11, f60: 3548.37, f86: 1795584633, f113: 573, f114: 1683, f115: 99, f169: -45.11, f170: -1.27 }, SH);
  assert.equal(quote.latest, 3503.26);
  assert.equal(quote.changePct, -1.27);
  assert.equal(quote.up, 573);
  assert.equal(quote.date, "2026-11-25");
  assert.match(quote.time, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(quoteFromFields({ f43: "-" }, SH).latest, null);
  assert.equal(quoteFromFields({ f43: 0 }, SH).latest, null);
  assert.equal(quoteFromFields({ f43: -12 }, SH).latest, null);
});

test("pushes are merged per index and delivered in one batch as soon as they arrive", async () => {
  const streams = new Map();
  const ticks = [];
  const hub = createIndexStream({
    instruments: [SH, SZ],
    openSse: async (url, { signal }) => { const stream = fakeStream(signal); streams.set(url.match(/secid=([^&]+)/)[1], stream); return stream; },
    emit: tick => ticks.push(tick)
  });
  try {
    const first = hub.subscribe();
    assert.equal(first.active, true);
    await until(() => streams.size === 2);
    streams.get("1.000001").push(sse({ rc: 0, full: 1, data: { f43: 3500, f170: -1.4, f60: 3548.37, f86: 1795584633 } }));
    streams.get("0.399001").push(sse({ rc: 0, full: 1, data: { f43: 10300, f170: -1.2 } }));
    await until(() => ticks.reduce((n, tick) => n + tick.quotes.length, 0) >= 2);
    streams.get("1.000001").push(sse({ rc: 0, full: 0, data: { f43: 3501.5 } }));
    await until(() => ticks.some(tick => tick.quotes.some(q => q.latest === 3501.5)));
    const last = ticks.at(-1).quotes.find(q => q.code === "000001");
    assert.equal(last.latest, 3501.5);
    assert.equal(last.changePct, -1.4, "a delta keeps fields it did not carry");
    assert.equal(last.preClose, 3548.37);
    streams.get("1.000001").push(sse({ rc: 0, data: null }));
    const before = ticks.length;
    await new Promise(r => setTimeout(r, 30));
    assert.equal(ticks.length, before, "heartbeats do not emit");
    const status = hub.status();
    assert.equal(status.connected, 2);
    assert.equal(status.quotes.length, 2);
    assert.ok(status.lastTickAt);
  } finally { hub.shutdown(); }
});

test("a dropped connection reconnects, an oversized event is rejected, and the lease stops everything", async () => {
  const opened = [];
  const hub = createIndexStream({
    instruments: [SH],
    leaseMs: 150,
    idleMs: 10_000,
    maxEventBytes: 200,
    openSse: async (_url, { signal }) => { const stream = fakeStream(signal); opened.push({ stream, signal }); return stream; },
    emit: () => {}
  });
  try {
    hub.subscribe();
    const renew = setInterval(() => hub.subscribe(), 40); // 页面在、按时续租
    await until(() => opened.length === 1);
    opened[0].stream.close(); // 服务端断开
    await until(() => opened.length === 2, 3000);
    opened[1].stream.push(`data: {"rc":0,"data":{"f43":1,"pad":"${"x".repeat(400)}`); // 没有结尾的超大事件
    await until(() => opened[1].signal.aborted, 1000);
    clearInterval(renew); // 页面关了，不再续租
    await until(() => !hub.status().active, 2000);
    assert.equal(hub.status().active, false, "no renewal within the lease stops the streams");
  } finally { hub.shutdown(); }
});

test("idle connections are recycled and unsubscribe / shutdown abort at once", async () => {
  const opened = [];
  const hub = createIndexStream({ instruments: [SH], idleMs: 40, openSse: async (_url, { signal }) => { const stream = fakeStream(signal); opened.push(signal); return stream; } });
  hub.subscribe();
  await until(() => opened.length >= 1);
  await until(() => opened[0].aborted, 1000);
  hub.subscribe({ active: false });
  assert.equal(hub.status().active, false);
  hub.shutdown();
  assert.equal(hub.subscribe().active, false, "after shutdown nothing restarts");
});

test("fetch-based opener rejects non-stream responses and cancels unused bodies", async () => {
  let cancelledNonStream = 0;
  const open = createFetchSse({
    fetchImpl: async () => ({ ok: true, headers: new Map([["content-type", "application/json"]]), body: { cancel: async () => { cancelledNonStream += 1; } } })
  });
  await assert.rejects(open("https://example.invalid"), /不是推送流/);
  assert.equal(cancelledNonStream, 1, "wrong content-type must cancel response.body");

  let cancelledError = 0;
  const bad = createFetchSse({
    fetchImpl: async () => ({ ok: false, status: 503, headers: new Map(), body: { cancel: async () => { cancelledError += 1; } } })
  });
  await assert.rejects(bad("https://example.invalid"), /HTTP 503/);
  assert.equal(cancelledError, 1, "non-OK response must cancel response.body");
});

test("the 1-second snapshot poll and the push stream merge by timestamp; unchanged snapshots are not re-sent", async () => {
  const ticks = [];
  let poll = 0;
  const snapshots = [
    [{ secid: "1.000001", data: { f43: 3500, f170: -1.4, f86: 100 } }],
    [{ secid: "1.000001", data: { f43: 3500, f170: -1.4, f86: 100 } }],          // 同一快照：不重复推
    [{ secid: "1.000001", data: { f43: 3502, f170: -1.3, f86: 103 } }],          // 3 秒后新快照
    [{ secid: "1.000001", data: { f43: 3490, f170: -1.6, f86: 97 } }]            // 更旧的快照：忽略
  ];
  const streams = [];
  const hub = createIndexStream({
    instruments: [SH], pollMs: 20,
    pollQuotes: async () => snapshots[Math.min(poll++, snapshots.length - 1)],
    openSse: async (_url, { signal }) => { const stream = fakeStream(signal); streams.push(stream); return stream; },
    emit: tick => ticks.push(tick)
  });
  try {
    hub.subscribe();
    await until(() => poll >= 5 && streams.length === 1);
    const prices = ticks.flatMap(tick => tick.quotes.map(q => q.latest));
    assert.deepEqual(prices, [3500, 3502]);
    assert.equal(hub.status().polling, true);
    streams[0].push(sse({ rc: 0, full: 0, data: { f43: 3503.5, f86: 104 } })); // 推送更快到达
    await until(() => ticks.at(-1).quotes[0].latest === 3503.5);
    assert.equal(ticks.at(-1).quotes[0].changePct, -1.3, "push deltas keep the polled fields");
  } finally { hub.shutdown(); }
});

test("off-session the stream never connects and the poll cadence switches between pollMs and idlePollMs", async () => {
  let live = false;
  let opened = 0;
  let poll = 0;
  const ticks = [];
  const streams = [];
  const hub = createIndexStream({
    instruments: [SH], pollMs: 10, idlePollMs: 120, sessionCheckMs: 50,
    inSession: () => live,
    pollQuotes: async () => { poll += 1; return [{ secid: "1.000001", data: { f43: 3500, f86: poll } }]; },
    openSse: async (_url, { signal }) => { opened += 1; const stream = fakeStream(signal); streams.push({ stream, signal }); return stream; },
    emit: tick => ticks.push(tick)
  });
  try {
    hub.subscribe();
    await until(() => poll >= 3);
    assert.equal(opened, 0, "盘外不连推送流");
    const at = poll;
    await new Promise(r => setTimeout(r, 260));
    assert.ok(poll - at <= 3, `盘外轮询放慢到 idlePollMs（260ms 内新增 ${poll - at} 次）`);
    live = true;
    await until(() => opened === 1, 2500);
    assert.ok(opened === 1, "开盘后推送流连上");
    // 推送一条真实 SSE 数据，确认 connected 升至 1（避免测试原本就为 0 而恒成立）
    streams[0].stream.push(sse({ rc: 0, full: 1, data: { f43: 3501.5, f86: 999 } }));
    await until(() => hub.status().connected === 1, 1500);
    assert.equal(hub.status().connected, 1);
    const baseline = poll;
    await until(() => poll > baseline, 1500); // 等盘内轮询循环醒来
    const inSessionAt = poll;
    await new Promise(r => setTimeout(r, 200));
    assert.ok(poll - inSessionAt >= 2, `盘内恢复高频轮询（200ms 内新增 ${poll - inSessionAt} 次）`);
    // 收盘：即使服务端静默不发任何字节，连接也应迅速断开并中止 signal，且不再重连
    live = false;
    await until(() => hub.status().connected === 0 && streams[0].signal.aborted, 1500);
    assert.equal(hub.status().connected, 0);
    assert.equal(streams[0].signal.aborted, true, "收盘后推送流应主动中止");
    await new Promise(r => setTimeout(r, 150));
    assert.ok(opened <= 1, `收盘后不再频繁重连（opened=${opened}）`);
  } finally { hub.shutdown(); }
});

test("H3, M4 & L3: abort mid-poll leaks zero timers, stop->restart isolates connected state, zero latest is rejected, and 16MB/RESPONSE_TOO_LARGE rotates cleanly", async () => {
  // 1. Abort mid-poll: no post-shutdown emit and zero leaked timers
  let releasePoll;
  const pollGate = new Promise(resolve => { releasePoll = resolve; });
  const activeTimers = new Set();
  const postShutdownTicks = [];
  let pollStarted = false;
  const pollHub = createIndexStream({
    instruments: [SH],
    pollMs: 10,
    idlePollMs: 60_000,
    inSession: () => false,
    setTimer: (fn, ms) => {
      const handle = setTimeout(() => { activeTimers.delete(handle); fn(); }, ms);
      activeTimers.add(handle);
      return handle;
    },
    clearTimer: handle => { activeTimers.delete(handle); clearTimeout(handle); },
    openSse: async (_url, { signal }) => fakeStream(signal),
    pollQuotes: async () => {
      pollStarted = true;
      await pollGate;
      return [{ secid: "1.000001", data: { f43: 3550, f86: 200 } }];
    },
    emit: tick => postShutdownTicks.push(tick)
  });
  pollHub.subscribe();
  await until(() => pollStarted);
  pollHub.shutdown();
  releasePoll();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(postShutdownTicks.length, 0, "shutdown mid-poll must never emit");
  assert.equal(activeTimers.size, 0, "shutdown mid-poll must leak zero timers");

  // 2. Fast stop -> restart isolates connected count from old runOne finally
  let releaseOldOpen;
  const oldOpenGate = new Promise(resolve => { releaseOldOpen = resolve; });
  let openIndex = 0;
  const sessionStreams = [];
  const isoHub = createIndexStream({
    instruments: [SH],
    openSse: async (_url, { signal }) => {
      const idx = ++openIndex;
      if (idx === 1) {
        await oldOpenGate;
        throw new Error("old session cancelled");
      }
      const stream = fakeStream(signal);
      sessionStreams.push(stream);
      return stream;
    }
  });
  try {
    isoHub.subscribe();
    await until(() => openIndex === 1);
    isoHub.subscribe({ active: false });
    isoHub.subscribe({ active: true });
    await until(() => sessionStreams.length === 1);
    sessionStreams[0].push(sse({ rc: 0, full: 1, data: { f43: 3600, f86: 300 } }));
    await until(() => isoHub.status().connected === 1);
    // Now let old session 1 settle and execute its finally block
    releaseOldOpen();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(isoHub.status().connected, 1, "old runOne finally must not delete new session connected state");
    // L3: zero latest delta must not overwrite positive latest or emit 0
    const beforeZero = isoHub.status().quotes[0].latest;
    assert.equal(beforeZero, 3600);
    sessionStreams[0].push(sse({ rc: 0, full: 0, data: { f43: 0, f86: 301 } }));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(isoHub.status().quotes[0].latest, 3600, "zero f43 delta must not clobber positive latest");
  } finally {
    isoHub.shutdown();
  }

  // 3. Clean rotation on maxConnectionBytes and RESPONSE_TOO_LARGE (no backoff delay, no error logged)
  const logs = [];
  let rotOpens = 0;
  const rotHub = createIndexStream({
    instruments: [SH],
    maxConnectionBytes: 128,
    log: msg => logs.push(msg),
    openSse: async (_url, { signal }) => {
      rotOpens += 1;
      if (rotOpens === 1) {
        return {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode(sse({ rc: 0, full: 1, data: { f43: 3500, pad: "x".repeat(200) } }));
          }
        };
      }
      if (rotOpens === 2) {
        let step = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                if (step === 0) {
                  step += 1;
                  return { done: false, value: new TextEncoder().encode(sse({ rc: 0, full: 1, data: { f43: 3501 } })) };
                }
                throw Object.assign(new Error("响应体超过字节上限"), { code: "RESPONSE_TOO_LARGE" });
              }
            };
          }
        };
      }
      return fakeStream(signal);
    }
  });
  try {
    const t0 = Date.now();
    rotHub.subscribe();
    await until(() => rotOpens >= 3, 500);
    assert.ok(Date.now() - t0 < 500, "both maxConnectionBytes and post-data RESPONSE_TOO_LARGE must rotate immediately without 1s backoff");
    assert.deepEqual(logs, [], "post-data RESPONSE_TOO_LARGE rotation must not log as an error");
  } finally {
    rotHub.shutdown();
  }

  // 4. Zero-byte RESPONSE_TOO_LARGE (oversized Content-Length header) must log and back off instead of spin-looping
  const spinLogs = [];
  let spinOpens = 0;
  const spinHub = createIndexStream({
    instruments: [SH],
    log: msg => spinLogs.push(msg),
    openSse: async () => {
      spinOpens += 1;
      throw Object.assign(new Error("响应体超过字节上限"), { code: "RESPONSE_TOO_LARGE" });
    }
  });
  try {
    spinHub.subscribe();
    await until(() => spinLogs.length >= 1, 500);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(spinOpens, 1, "zero-byte RESPONSE_TOO_LARGE must enter backoff instead of tight zero-delay spin");
    assert.equal(spinLogs.length, 1);
  } finally {
    spinHub.shutdown();
  }
});

