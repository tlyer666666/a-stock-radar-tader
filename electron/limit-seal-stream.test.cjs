"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLimitSealStream, computeSeal } = require("./limit-seal-stream.cjs");
const { parseTencentBatch } = require("./tencent-batch-quote.cjs");

const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise(r => setTimeout(r, 5)); } };
const base = { name: "测试股份", latest: 11, changePct: 10, high: 11, limitUp: 11, limitDown: 9, floatMarketCap: 2e9, quoteAt: "2026-11-26T02:30:00.000Z", quoteDate: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) }; // 快照只返回「今天」的记录，夹具日期跟着真实日期走

test("Tencent five-level book is parsed; empty sell side at limit-up is kept empty", () => {
  const fields = Array(50).fill("");
  Object.assign(fields, { 1: "测试股份", 2: "600001", 3: "11.00", 4: "10.00", 30: "20261126103418", 32: "10.00", 33: "11.00", 34: "10.20", 44: "20", 47: "11.00", 48: "9.00",
    9: "11.00", 10: "52310", 11: "10.99", 12: "120", 13: "10.98", 14: "35", 15: "0.00", 16: "0", 19: "0.00", 20: "0" });
  const quote = parseTencentBatch(`v_sh600001="${fields.join("~")}";`).get("600001");
  assert.deepEqual(quote.bids, [{ price: 11, volumeLots: 52310 }, { price: 10.99, volumeLots: 120 }, { price: 10.98, volumeLots: 35 }]);
  assert.deepEqual(quote.asks, []);
  assert.equal(quote.limitUp, 11);
  assert.equal(quote.floatMarketCap, 2e9);
});

test("seal status: sealed, contested, broken, limit-down sealed and plain open", () => {
  const sealed = computeSeal({ ...base, bids: [{ price: 11, volumeLots: 52310 }], asks: [] });
  assert.equal(sealed.status, "sealed");
  assert.equal(sealed.statusLabel, "封死涨停");
  assert.equal(sealed.sealLots, 52310);
  assert.equal(sealed.sealAmount, 52310 * 100 * 11);
  assert.ok(Math.abs(sealed.sealFloatRatio - (52310 * 1100) / 2e9) < 1e-12);
  const contested = computeSeal({ ...base, bids: [{ price: 11, volumeLots: 800 }], asks: [{ price: 11, volumeLots: 300 }] });
  assert.equal(contested.status, "contested");
  assert.equal(contested.sealLots, 800);
  const broken = computeSeal({ ...base, latest: 10.62, bids: [{ price: 10.61, volumeLots: 10 }], asks: [{ price: 10.62, volumeLots: 5 }] });
  assert.equal(broken.status, "broken");
  assert.equal(broken.sealAmount, null, "a broken board has no seal, not a zero seal");
  const down = computeSeal({ ...base, latest: 9, high: 9.5, bids: [], asks: [{ price: 9, volumeLots: 4000 }] });
  assert.equal(down.status, "downSealed");
  assert.equal(down.sealAmount, 4000 * 100 * 9);
  const open = computeSeal({ ...base, latest: 10.3, high: 10.5, bids: [{ price: 10.29, volumeLots: 1 }], asks: [{ price: 10.3, volumeLots: 1 }] });
  assert.equal(open.status, "open");
  assert.equal(computeSeal({ ...base, floatMarketCap: null, bids: [{ price: 11, volumeLots: 1 }], asks: [] }).sealFloatRatio, null);
});

test("subscribers get only changed codes, with peak, drawdown and one-minute change; history comes back on request", async () => {
  let lots = 50000;
  let clock = Date.parse("2026-11-26T02:30:00.000Z");
  const ticks = [];
  const requested = [];
  const hub = createLimitSealStream({
    pollMs: 10, idlePollMs: 10,
    readBatch: async securities => {
      requested.push(securities.map(item => item.code).join(","));
      const quotes = new Map();
      quotes.set("600001", { ...base, quoteAt: new Date(clock).toISOString(), bids: [{ price: 11, volumeLots: lots }], asks: [] });
      quotes.set("600002", { ...base, name: "平稳股份", bids: [{ price: 11, volumeLots: 1000 }], asks: [] });
      return { quotes };
    },
    emit: tick => ticks.push(tick)
  });
  try {
    const first = hub.subscribe({ owner: "pool", codes: ["600001", "600002", "bad"] });
    assert.equal(first.active, true);
    await until(() => ticks.length >= 1);
    assert.deepEqual(ticks[0].items.map(item => item.code), ["600001", "600002"]);
    await new Promise(r => setTimeout(r, 40));
    assert.equal(ticks.length, 1, "nothing changed, nothing re-sent");
    clock += 61_000; lots = 30000;
    await until(() => ticks.length >= 2);
    const item = ticks[1].items[0];
    assert.equal(ticks[1].items.length, 1);
    assert.equal(item.code, "600001");
    assert.equal(item.sealLots, 30000);
    assert.equal(item.peakAmount, 50000 * 1100);
    assert.ok(Math.abs(item.fromPeakPct - -40) < 1e-9);
    assert.equal(item.change1mAmount, (30000 - 50000) * 1100);
    assert.ok(Math.abs(item.change1mPct - -40) < 1e-9);
    assert.equal(item.point.amount, 30000 * 1100);
    const detail = hub.subscribe({ owner: "detail", codes: ["600001"], withHistory: true });
    assert.deepEqual(detail.items[0].history.map(point => point.amount), [50000 * 1100, 30000 * 1100]);
    assert.ok(requested.at(-1).includes("600001"));
    hub.subscribe({ owner: "pool", active: false });
    hub.subscribe({ owner: "detail", active: false });
    await until(() => !hub.status().active, 1000);
  } finally { hub.shutdown(); }
});

test("leases expire on their own and a failing source never throws into the app", async () => {
  let calls = 0;
  const hub = createLimitSealStream({ pollMs: 10, idlePollMs: 10, leaseMs: 60, readBatch: async () => { calls += 1; throw new Error("offline"); } });
  try {
    hub.subscribe({ owner: "pool", codes: ["600001"] });
    await until(() => calls >= 2);
    await until(() => !hub.status().active, 1000);
    const settled = calls;
    await new Promise(r => setTimeout(r, 40));
    assert.equal(calls, settled, "no requests after the lease ran out");
  } finally { hub.shutdown(); }
  assert.equal(hub.subscribe({ owner: "x", codes: ["600001"] }).active, false, "nothing restarts after shutdown");
});

test("new codes wake idle sleep immediately, peak survives historyMax trimming, and stale 1m drop clears after 60s", async () => {
  let lots = 100000;
  let clock = Date.parse("2026-11-26T02:30:00.000Z");
  const ticks = [];
  const hub = createLimitSealStream({
    pollMs: 10,
    idlePollMs: 5000,
    historyMax: 2,
    readBatch: async securities => {
      const quotes = new Map();
      for (const sec of securities) {
        quotes.set(sec.code, { ...base, quoteAt: new Date(clock).toISOString(), bids: [{ price: 11, volumeLots: lots }], asks: [] });
      }
      return { quotes };
    },
    emit: tick => ticks.push(tick)
  });
  try {
    hub.subscribe({ owner: "pool", codes: ["600001"] });
    await until(() => ticks.length >= 1);
    clock += 61_000; lots = 50000;
    await until(() => ticks.length >= 2);
    assert.equal(ticks[1].items[0].change1mPct, -50);
    // 3rd point (>60s later) trims historyMax=2 (dropping 100000 from history),
    // yet peakAmount must still stay 100000 * 1100 and change1mPct reflects 50000 -> 40000 (-20%).
    clock += 61_000; lots = 40000;
    await until(() => ticks.length >= 3);
    assert.equal(ticks[2].items[0].peakAmount, 100000 * 1100, "peakAmount preserved after history trimming");
    assert.equal(ticks[2].items[0].change1mPct, -20);
    // Unchanged for >60s: stale negative change1mAmount refreshes to 0.
    clock += 65_000;
    await until(() => ticks.length >= 4);
    assert.equal(ticks[3].items[0].change1mAmount, 0, "stale 1m drop clears after 60s of stability");
    // Switching to a new code wakes immediately without waiting for idlePollMs (5000ms).
    const startWake = Date.now();
    hub.subscribe({ owner: "detail", codes: ["600009"] });
    await until(() => ticks.some(t => t.items.some(i => i.code === "600009")), 500);
    assert.ok(Date.now() - startWake < 500, "subscribing a new code wakes sleeping loop immediately");
    // Empty code list removes owner rather than leaving it active.
    hub.subscribe({ owner: "pool", codes: [] });
    hub.subscribe({ owner: "detail", codes: [] });
    assert.equal(hub.status().owners, 0);
  } finally {
    hub.shutdown();
  }
});

test("off-session polling slows down, the detail stock keeps its slot in a full pool, yesterday's record is not served, and a pool row without a seal size is still sealed", async () => {
  let live = false;
  let calls = 0;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const asked = [];
  const emitted = [];
  const hub = createLimitSealStream({
    pollMs: 10, idlePollMs: 10, offSessionPollMs: 400, maxCodes: 3, inSession: () => live, isTradingDate: () => true,
    emit: tick => emitted.push(...tick.items),
    readSeals: async ({ codes, detailCodes }) => { calls += 1; asked.push({ codes, detailCodes });
      return { quotes: new Map(codes.map(code => [code, { ...base, name: code, quoteDate: code === "600009" ? "2020-01-01" : today, bids: [{ price: 11, volumeLots: 100 }], asks: [] }])) }; }
  });
  try {
    hub.subscribe({ owner: "detail", codes: ["600009"] });
    hub.subscribe({ owner: "pool", codes: ["600001", "600002", "600003"] });
    await until(() => calls >= 2);
    assert.ok(asked[1].codes.includes("600009"), "the stock being viewed is polled even when the pool fills the cap");
    assert.equal(asked[1].codes.length, 3);
    assert.deepEqual(asked[1].detailCodes, ["600009"]);
    await new Promise(r => setTimeout(r, 150));
    assert.ok(calls <= 3, `off session the loop waits offSessionPollMs between polls (calls=${calls})`);
    assert.equal(emitted.some(item => item.code === "600009"), false, "stale quoteDate must never be emitted on a trading day");
    assert.deepEqual(hub.subscribe({ owner: "detail", codes: ["600009"] }).items, [], "a record dated another day is not returned as current");
    live = true;
  } finally { hub.shutdown(); }
  const unknown = computeSeal({ ...base, bids: [], asks: [], sealUnknown: true });
  assert.equal(unknown.status, "sealed");
  assert.equal(unknown.sealLots, null, "unknown seal size stays null");
  assert.equal(computeSeal({ ...base, bids: [], asks: [] }).status, "contested", "without the THS-pool marker an empty book at the limit is still treated as contested");
});

test("H2 & H3: consistent weekend/holiday snapshot, pre-open stale rejection, no emit or leaked timers on shutdown mid-read, and off-session wake probe", async () => {
  // 1. Weekend revisit preserves Friday's snapshot consistently across pollOnce() and snapshot()
  const saturdayMs = Date.parse("2026-11-28T03:00:00.000Z"); // 2026-11-28 11:00 Beijing (Saturday)
  const weekendTicks = [];
  const weekendHub = createLimitSealStream({
    pollMs: 10,
    idlePollMs: 10,
    offSessionPollMs: 200,
    now: () => saturdayMs,
    inSession: () => false,
    readBatch: async () => ({
      quotes: new Map([
        ["600001", { ...base, quoteDate: "2026-11-27", quoteAt: "2026-11-27T07:00:00.000Z", bids: [{ price: 11, volumeLots: 25000 }], asks: [] }]
      ])
    }),
    emit: tick => weekendTicks.push(tick)
  });
  try {
    weekendHub.subscribe({ owner: "detail", codes: ["600001"] });
    await until(() => weekendTicks.length >= 1);
    assert.equal(weekendTicks[0].items[0].quoteDate, "2026-11-27");
    // Unsubscribe and revisit the same stock on weekend: snapshot must still serve Friday's record
    weekendHub.subscribe({ owner: "detail", active: false });
    const revisit = weekendHub.subscribe({ owner: "detail", codes: ["600001"] });
    assert.equal(revisit.items.length, 1, "weekend revisit must not blank the panel");
    assert.equal(revisit.items[0].quoteDate, "2026-11-27");
    assert.equal(revisit.items[0].sealLots, 25000);
  } finally {
    weekendHub.shutdown();
  }

  // 2. Shutdown during in-flight read() never emits and leaves zero active timers
  let releaseRead;
  const inFlight = new Promise(resolve => { releaseRead = resolve; });
  const activeTimers = new Set();
  const postShutdownTicks = [];
  let inFlightCalls = 0;
  const raceHub = createLimitSealStream({
    pollMs: 10,
    idlePollMs: 10,
    offSessionPollMs: 30_000,
    inSession: () => false,
    isTradingDate: () => true,
    setTimer: (fn, ms) => {
      const handle = setTimeout(() => { activeTimers.delete(handle); fn(); }, ms);
      activeTimers.add(handle);
      return handle;
    },
    clearTimer: handle => { activeTimers.delete(handle); clearTimeout(handle); },
    readBatch: async () => {
      inFlightCalls += 1;
      await inFlight;
      return { quotes: new Map([["600001", { ...base, bids: [{ price: 11, volumeLots: 1000 }], asks: [] }]]) };
    },
    emit: tick => postShutdownTicks.push(tick)
  });
  raceHub.subscribe({ owner: "pool", codes: ["600001"] });
  await until(() => inFlightCalls === 1);
  raceHub.shutdown();
  releaseRead();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(postShutdownTicks.length, 0, "shutdown during in-flight read must never emit");
  assert.equal(activeTimers.size, 0, "shutdown during in-flight read must not leak sleep or probe timers");

  // 3. Off-session wake probe wakes promptly when session opens without waiting 30s
  let live = false;
  let wakeCalls = 0;
  let enteredLongSleep = false;
  const wakeHub = createLimitSealStream({
    pollMs: 20,
    idlePollMs: 20,
    offSessionPollMs: 30_000,
    inSession: () => live,
    isTradingDate: () => true,
    setTimer: (fn, ms) => {
      if (ms >= 20_000) enteredLongSleep = true;
      return setTimeout(fn, ms);
    },
    readBatch: async () => {
      wakeCalls += 1;
      return { quotes: new Map([["600001", { ...base, bids: [{ price: 11, volumeLots: 1000 + wakeCalls }], asks: [] }]]) };
    }
  });
  try {
    wakeHub.subscribe({ owner: "pool", codes: ["600001"] });
    await until(() => wakeCalls === 1 && enteredLongSleep, 1000);
    const t0 = Date.now();
    live = true;
    await until(() => wakeCalls >= 2, 2500);
    assert.ok(Date.now() - t0 < 2500, "opening session must wake off-session sleep via 1s probe instead of waiting 30s");
  } finally {
    wakeHub.shutdown();
  }
});
