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

test("fetch-based opener rejects non-stream responses", async () => {
  const open = createFetchSse({ fetchImpl: async () => ({ ok: true, headers: new Map([["content-type", "application/json"]]), body: {} }) });
  await assert.rejects(open("https://example.invalid"), /不是推送流/);
  const bad = createFetchSse({ fetchImpl: async () => ({ ok: false, status: 503, headers: new Map(), body: null }) });
  await assert.rejects(bad("https://example.invalid"), /HTTP 503/);
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
