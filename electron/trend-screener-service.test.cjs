"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTrendScreenerService } = require("./trend-screener-service.cjs");

const today = new Date("2026-09-30T08:00:00Z");
const bars = (count = 260, end = "2026-09-30") => {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(last - (count - 1 - index) * 86400000).toISOString().slice(0, 10),
    open: 10, high: 11, low: 9, close: 10, volume: 100000, amount: 300000000
  }));
};
const security = (code, extra = {}) => ({ code, name: code, industry: "制造", ...extra });
const emptyPages = ({ filter }) => ({ total: 0, rows: [] });
const history = async (_, adjustment) => ({ rows: bars(), adjustment });
const evaluator = ({ security: item }) => ({ kind: "excluded", reason: item.code });
async function settle(service, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  while (!["completed", "failed", "cancelled"].includes(service.getStatus().phase)) {
    if (Date.now() > until) throw new Error("scan did not settle");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return service.getStatus();
}

test("a source-wide universe outage stops immediately with actionable failure", async () => {
  let calls = 0;
  const service = createTrendScreenerService({
    now: () => today, fetchHistory: history, fetchBenchmark: async () => bars(80),
    fetchUniversePage: async () => {
      calls += 1;
      throw Object.assign(new Error("东方财富证券名单连接失败，请稍后重试"), { code: "MARKET_DATA_SOURCE_UNAVAILABLE" });
    }
  });
  service.start();
  const result = await settle(service);
  assert.equal(calls, 1);
  assert.equal(result.phase, "failed");
  assert.equal(result.coverageComplete, false);
  assert.match(result.note, /连接失败/);
});

test("a source-wide history outage stops workers from requesting the rest of the universe", async () => {
  let calls = 0;
  const service = createTrendScreenerService({
    now: () => today, fetchBenchmark: async () => bars(80),
    fetchUniversePage: async ({filter}) => filter === "m:0+t:6" ? {total: 20, rows: Array.from({length:20}, (_, n) => security(String(n+1).padStart(6,"0")))} : {total:0, rows:[]},
    fetchHistory: async () => {
      calls += 1;
      throw Object.assign(new Error("行情源连接中断"), {code:"MARKET_DATA_SOURCE_UNAVAILABLE"});
    }
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.phase, "failed");
  assert.ok(calls <= 6, `requests made: ${calls}`);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.coverageComplete, false);
});

test("paginates beyond 100 without a hidden universe cap and processes each distinct eligible code", async () => {
  const codes = Array.from({ length: 225 }, (_, n) => String(n + 1).padStart(6, "0"));
  const requested = [];
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter, page, pageSize }) => {
      requested.push([filter, page]);
      if (filter !== "m:0+t:6") return { total: 0, rows: [] };
      return { total: codes.length, rows: codes.slice((page - 1) * pageSize, page * pageSize).map((code) => security(code)) };
    },
    fetchBenchmark: async () => bars(80), fetchHistory: history,
    evaluateStock: evaluator, rankCandidates: (rows) => rows
  });
  assert.equal(service.start().phase, "loading-universe");
  assert.equal(service.start().jobId, service.getStatus().jobId);
  const result = await settle(service);
  assert.deepEqual(requested.filter(([filter]) => filter === "m:0+t:6").map(([, page]) => page), [1, 2, 3]);
  assert.equal(result.universeExpected, 225);
  assert.equal(result.universeLoaded, 225);
  assert.equal(result.processed, 225);
  assert.equal(result.excluded, 225);
  assert.equal(result.coverageComplete, true);
});

test("rejects a repeated page and reports partial coverage rather than silently skipping securities", async () => {
  const first = Array.from({ length: 100 }, (_, n) => security(String(n + 1).padStart(6, "0")));
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 150, rows: first }
      : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80), fetchHistory: history,
    evaluateStock: evaluator, rankCandidates: (rows) => rows
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.boards.find((board) => board.id === "mainSZ").complete, false);
  assert.equal(result.universeLoaded, 100);
  assert.equal(result.failed, 1);
  assert.ok(result.errors.some((error) => error.stage === "universe"));
});

test("six history workers maximum and malformed or stale histories count unavailable", async () => {
  const codes = Array.from({ length: 12 }, (_, n) => String(n + 1).padStart(6, "0"));
  let active = 0, peak = 0;
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: codes.length, rows: codes.map((code) => security(code)) }
      : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80),
    fetchHistory: async (item, adjustment) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { rows: item.code === "000001" ? bars(200) : item.code === "000002" ? bars(260, "2026-09-29") : bars(), adjustment };
    },
    evaluateStock: evaluator, rankCandidates: (rows) => rows
  });
  service.start();
  const result = await settle(service);
  assert.ok(peak <= 6, `peak ${peak}`);
  assert.equal(result.unavailable, 2);
  assert.equal(result.processed, 12);
  assert.equal(result.coverageComplete, false);
});

test("cancellation stops new requests and ignores late fulfilled requests", async () => {
  let resolveHistory;
  let calls = 0;
  const pending = new Promise((resolve) => { resolveHistory = resolve; });
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 20, rows: Array.from({ length: 20 }, (_, n) => security(String(n + 1).padStart(6, "0"))) }
      : emptyPages({ filter }),
    fetchBenchmark: async () => bars(80),
    fetchHistory: async (_, adjustment) => { calls += 1; await pending; return { rows: bars(), adjustment }; },
    evaluateStock: evaluator, rankCandidates: (rows) => rows
  });
  service.start();
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const cancelled = service.cancel();
  assert.equal(cancelled.phase, "cancelled");
  resolveHistory();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.getStatus().phase, "cancelled");
  assert.equal(service.getStatus().processed, 0);
  assert.ok(calls <= 6);
});

test("missing benchmark fails the job and status snapshots cannot mutate service state", async () => {
  const service = createTrendScreenerService({
    now: () => today, fetchUniversePage: emptyPages,
    fetchBenchmark: async () => bars(79), fetchHistory: history,
    evaluateStock: evaluator, rankCandidates: (rows) => rows
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.phase, "failed");
  assert.equal(result.coverageComplete, false);
  result.errors.push({ stage: "tamper", message: "x" });
  assert.equal(service.getStatus().errors.some((e) => e.stage === "tamper"), false);
});

test("ST, delisting and non-A names are accounted as excluded while scan progress reaches loaded names", async () => {
  const rows = [security("000001"), security("000002", { name: "*ST甲" }),
    security("900001"), security("000003", { name: "退市乙" })];
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: rows.length, rows } : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80), fetchHistory: history,
    evaluateStock: evaluator, rankCandidates: (items) => items
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.universeLoaded, 4);
  assert.equal(result.processed, 4);
  assert.equal(result.excluded, 4);
  assert.equal(result.coverageComplete, true);
});

test("null amount and unconfirmed adjustment are unavailable rather than excluded", async () => {
  const rows = [security("000001"), security("000002")];
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 2, rows } : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80),
    fetchHistory: async (item, adjustment) => ({
      rows: item.code === "000001" ? bars().map((bar) => ({ ...bar, amount: null })) : bars(),
      adjustment: item.code === "000002" ? "none" : adjustment
    }),
    evaluateStock: evaluator, rankCandidates: (items) => items
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.unavailable, 2);
  assert.equal(result.coverageComplete, false);
  assert.deepEqual(result.errors.filter((error) => error.code).map((error) => error.code).sort(), ["000001", "000002"]);
});

test("history request failures are counted separately from unavailable bars", async () => {
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 1, rows: [security("000001")] } : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80),
    fetchHistory: async () => { throw new Error("行情源超时"); },
    evaluateStock: evaluator, rankCandidates: (items) => items
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.failed, 1);
  assert.equal(result.unavailable, 0);
  assert.equal(result.processed, 1);
  assert.equal(result.coverageComplete, false);
  assert.ok(result.errors.some((error) => error.code === "000001" && error.message.includes("超时")));
});

test("an interior malformed or duplicate bar invalidates the history even when 250 other bars remain", async () => {
  const makeRows = (code) => {
    const rows = bars(260);
    if (code === "000001") rows[5] = { ...rows[5], amount: null };
    if (code === "000002") rows.splice(10, 0, { ...rows[10] });
    return rows;
  };
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 2, rows: [security("000001"), security("000002")] } : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80),
    fetchHistory: async (item, adjustment) => ({ rows: makeRows(item.code), adjustment }),
    evaluateStock: evaluator, rankCandidates: (items) => items
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.unavailable, 2);
  assert.equal(result.coverageComplete, false);
});

test("a missing security name is unavailable and a 900 B-share is excluded", async () => {
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 3, rows: [security("000001", { name: "" }), security("900001"), security("000002")] }
      : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80), fetchHistory: history,
    evaluateStock: evaluator, rankCandidates: (items) => items
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.universeLoaded, 3);
  assert.equal(result.processed, 3);
  assert.equal(result.unavailable, 1);
  assert.equal(result.excluded, 2);
  assert.equal(result.coverageComplete, false);
});

test("null totals and an entirely empty market cannot report complete coverage", async () => {
  for (const bad of [null, 0]) {
    const service = createTrendScreenerService({
      now: () => today,
      fetchUniversePage: async () => ({ total: bad, rows: [] }),
      fetchBenchmark: async () => bars(80), fetchHistory: history,
      evaluateStock: evaluator, rankCandidates: (items) => items
    });
    service.start();
    const result = await settle(service);
    assert.equal(result.coverageComplete, false);
    assert.ok(result.errors.length > 0);
  }
});

test("an unknown board total keeps whole-market expected count unknown", async () => {
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:1+t:2"
      ? { total: null, rows: [] }
      : filter === "m:0+t:6" ? { total: 1, rows: [security("000001")] }
      : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80), fetchHistory: history,
    evaluateStock: evaluator, rankCandidates: (items) => items
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.universeExpected, null);
  assert.equal(result.boards.find((board) => board.id === "mainSH").complete, false);
  assert.equal(result.coverageComplete, false);
});

test("same-day benchmark correction invalidates cached candidate and plan", async () => {
  let benchmarkClose = 100;
  let historyCalls = 0;
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 1, rows: [security("000001")] } : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80).map((row, index) => ({ ...row,
      open: index === 79 ? benchmarkClose : 100, high: 110, low: 40,
      close: index === 79 ? benchmarkClose : 100 })),
    fetchHistory: async (_, adjustment) => { historyCalls += 1; return { rows: bars(), adjustment }; },
    evaluateStock: ({ security: item, benchmarkRows }) => ({
      kind: "candidate",
      candidate: { security: item, stage: benchmarkRows.at(-1).close < 100 ? "watch" : "signal",
        plan: benchmarkRows.at(-1).close < 100 ? null : { maxEntry: 10 } }
    }),
    rankCandidates: (items) => items
  });
  service.start();
  const first = await settle(service);
  assert.equal(first.candidates[0].stage, "signal");
  assert.equal(historyCalls, 2);
  benchmarkClose = 50;
  service.start();
  const corrected = await settle(service);
  assert.equal(corrected.marketGate, "blocked");
  assert.equal(corrected.candidates[0].stage, "watch");
  assert.equal(corrected.candidates[0].plan, null);
  assert.equal(historyCalls, 4);
  service.start();
  await settle(service);
  assert.equal(historyCalls, 4);
});

test("a known suspended stock is unavailable rather than an excluded strategy miss", async () => {
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 1, rows: [security("000001", { suspended: true })] } : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80), fetchHistory: history,
    evaluateStock: evaluator, rankCandidates: (items) => items
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.unavailable, 1);
  assert.equal(result.excluded, 0);
  assert.equal(result.processed, 1);
  assert.equal(result.coverageComplete, false);
});

test("calendar-impossible dates invalidate a stock history", async () => {
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 1, rows: [security("000001")] } : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80),
    fetchHistory: async (_, adjustment) => {
      const rows = bars(); rows[3] = { ...rows[3], date: "2026-02-30" };
      return { rows, adjustment };
    },
    evaluateStock: evaluator, rankCandidates: (items) => items
  });
  service.start();
  const result = await settle(service);
  assert.equal(result.unavailable, 1);
  assert.equal(result.excluded, 0);
  assert.equal(result.coverageComplete, false);
});

const singleStockDeps = (extra = {}) => ({
  now: () => today,
  fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
    ? { total: 1, rows: [security("000001")] } : { total: 0, rows: [] },
  fetchBenchmark: async () => bars(80), fetchHistory: history,
  evaluateStock: evaluator, rankCandidates: rows => rows,
  ...extra
});
async function waitUntil(predicate) {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}

test("scan options are validated before replacing any existing status", () => {
  const service = createTrendScreenerService(singleStockDeps());
  for (const options of [null, [], { bogus: true }, { strategyId: "unknown" },
    { forceRefresh: "yes" }, { config: { maxExtensionAtr: 2 } },
    { strategyId: "quality-v2", config: { maxExtensionAtr: NaN } },
    { strategyId: "quality-v2", config: { maxExtensionAtr: Infinity } },
    { strategyId: "quality-v2", config: { minCloseLocation: 0.2 } },
    { strategyId: "quality-v2", config: { surprise: 2 } }]) {
    assert.throws(() => service.start(options), /策略|配置|参数|刷新|扫描/);
    assert.equal(service.getStatus().phase, "idle");
  }
});

test("strategy and configuration isolate cached outcomes and the status is a frozen snapshot", async () => {
  let historyCalls = 0;
  const evaluated = [];
  const service = createTrendScreenerService(singleStockDeps({
    fetchHistory: async (_, adjustment) => { historyCalls += 1; return { rows: bars(), adjustment }; },
    evaluateStock: (_input, options) => { evaluated.push(options); return { kind: "excluded" }; }
  }));
  const options = { strategyId: "quality-v2", config: { maxExtensionAtr: 2 } };
  const initial = service.start(options);
  options.config.maxExtensionAtr = 4;
  assert.equal(initial.strategy.id, "quality-v2");
  assert.equal(initial.strategy.config.maxExtensionAtr, 2);
  initial.strategy.config.maxExtensionAtr = 5;
  const first = await settle(service);
  assert.equal(first.strategy.config.maxExtensionAtr, 2);
  assert.equal(evaluated[0].strategyId, "quality-v2");
  assert.equal(evaluated[0].config.maxExtensionAtr, 2);
  service.start({ strategyId: "quality-v2", config: { maxExtensionAtr: 2 } });
  const warm = await settle(service);
  assert.equal(warm.performance.cacheHits, 1);
  assert.equal(historyCalls, 2);
  service.start(options);
  const differentConfig = await settle(service);
  assert.notEqual(differentConfig.strategy.configHash, first.strategy.configHash);
  assert.equal(historyCalls, 4);
  service.start();
  const classic = await settle(service);
  assert.equal(classic.strategy.id, "classic-v1");
  assert.equal(historyCalls, 6);
});

test("a forced refresh reads a same-day stock correction and ordinary scans have a 15 minute TTL", async () => {
  let clock = new Date(today), close = 10, calls = 0;
  const service = createTrendScreenerService(singleStockDeps({
    now: () => clock,
    fetchHistory: async (_, adjustment) => {
      calls += 1;
      return { rows: bars().map(row => ({ ...row, open: close, close, high: close + 1, low: close - 1 })), adjustment };
    },
    evaluateStock: ({ security: item, rawRows }) => ({ kind: "candidate", candidate: { security: item, close: rawRows.at(-1).close } })
  }));
  service.start(); await settle(service);
  close = 12;
  service.start({ forceRefresh: true });
  const corrected = await settle(service);
  assert.equal(corrected.candidates[0].close, 12);
  assert.equal(calls, 4);
  clock = new Date(today.getTime() + 14 * 60_000);
  service.start();
  assert.equal((await settle(service)).performance.cacheHits, 1);
  clock = new Date(today.getTime() + 15 * 60_000);
  service.start(); await settle(service);
  assert.equal(calls, 6);
});

test("a security metadata correction invalidates its cached candidate", async () => {
  let name = "原名称", industry = "原行业", calls = 0;
  const service = createTrendScreenerService(singleStockDeps({
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6"
      ? { total: 1, rows: [security("000001", { name, industry })] } : { total: 0, rows: [] },
    fetchHistory: async (_, adjustment) => { calls += 1; return { rows: bars(), adjustment }; },
    evaluateStock: ({ security: item }) => ({ kind: "candidate", candidate: { security: item } })
  }));
  service.start(); await settle(service);
  name = "更正名称"; industry = "更正行业";
  service.start();
  const corrected = await settle(service);
  assert.equal(corrected.candidates[0].security.name, name);
  assert.equal(corrected.candidates[0].security.industry, industry);
  assert.equal(calls, 4);
});

test("starting a different strategy while a scan is running reports busy without changing it", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const service = createTrendScreenerService(singleStockDeps({ fetchBenchmark: async () => { await pending; return bars(80); } }));
  const first = service.start({ strategyId: "quality-v2" });
  assert.equal(service.start({ strategyId: "quality-v2" }).jobId, first.jobId);
  assert.throws(() => service.start({ strategyId: "classic-v1" }), /正在|运行|取消|忙/);
  assert.equal(service.getStatus().strategy.id, "quality-v2");
  service.cancel(); release();
});

test("necessary-condition prefilter preserves unavailable data and reduces front requests from 2N to N plus M", async () => {
  const securities = Array.from({ length: 12 }, (_, index) => security(String(index + 1).padStart(6, "0")));
  const makeService = (prefilterStock) => createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6" ? { total: 12, rows: securities } : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80),
    fetchHistory: async (item, adjustment) => {
      const rows = bars();
      if (Number(item.code) <= 2) rows[rows.length - 1] = { ...rows.at(-1), open: 10.5, close: 11, high: 11.2, low: 10.4 };
      return { rows, adjustment };
    },
    ...(prefilterStock ? { prefilterStock } : {})
  });
  const full = makeService(() => null);
  full.start(); const before = await settle(full);
  const optimized = makeService();
  optimized.start(); const after = await settle(optimized);
  assert.deepEqual(after.candidates, before.candidates);
  assert.equal(after.excluded, before.excluded);
  assert.equal(after.coverageComplete, true);
  assert.equal(before.performance.rawRequests, 12);
  assert.equal(before.performance.adjustedRequests, 12);
  assert.equal(after.performance.rawRequests, 12);
  assert.equal(after.performance.adjustedRequests, 2);
  assert.equal(after.performance.prefilterExcluded, 10);
  const invalid = createTrendScreenerService(singleStockDeps({
    prefilterStock: () => ({ kind: "unavailable", reason: "cannot verify limit reference" })
  }));
  invalid.start(); const unavailable = await settle(invalid);
  assert.equal(unavailable.unavailable, 1);
  assert.equal(unavailable.excluded, 0);
  assert.equal(unavailable.performance.adjustedRequests, 0);
  assert.equal(unavailable.coverageComplete, false);
});

test("cancel and restart keep at most six physical history calls even when a fetch ignores cancellation", async () => {
  let physical = 0, peak = 0, calls = 0;
  const releases = [];
  const signals = [];
  const service = createTrendScreenerService(singleStockDeps({
    fetchUniversePage: async ({ filter, signal }) => {
      signals.push(signal);
      return filter === "m:0+t:6" ? { total: 12, rows: Array.from({ length: 12 }, (_, index) => security(String(index + 1).padStart(6, "0"))) } : { total: 0, rows: [] };
    },
    fetchBenchmark: async ({ signal } = {}) => { signals.push(signal); return bars(80); },
    fetchHistory: async (_, adjustment, { signal } = {}) => {
      signals.push(signal); calls += 1; physical += 1; peak = Math.max(peak, physical);
      await new Promise(resolve => { releases.push(resolve); });
      physical -= 1;
      return { rows: bars(), adjustment };
    }
  }));
  service.start(); await waitUntil(() => physical === 6);
  const firstSignal = signals[0];
  service.cancel(); service.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  const observedPeak = peak;
  service.cancel(); releases.forEach(release => release());
  await waitUntil(() => physical === 0);
  assert.equal(observedPeak, 6);
  assert.equal(calls, 6);
  assert.ok(signals.every(signal => signal instanceof AbortSignal));
  assert.equal(firstSignal.aborted, true);
  assert.equal(service.getStatus().phase, "cancelled");
  assert.equal(service.getStatus().processed, 0);
});

const librarySelection = ["quality-v2", "macd-zero-cross-v1", "boll-squeeze-breakout-v1", "dmi-trend-strength-v1",
  "obv-volume-breakout-v1", "kdj-trend-cross-v1", "ma-pullback-resume-v1"].map(strategyId => ({ strategyId }));
const pairSelection = [{ strategyId: "quality-v2" }, { strategyId: "classic-v1" }];

test("batch options reject empty duplicate mixed oversized and malformed strategy sets", () => {
  const service = createTrendScreenerService(singleStockDeps());
  for (const options of [{ strategies: [] }, { strategies: {} }, { strategies: [null] },
    { strategies: [undefined] }, { strategies: [{ strategyId: undefined }] }, { strategies: [{ strategyId: "classic-v1", forceRefresh: true }] },
    { strategies: [{ strategyId: "classic-v1" }, { strategyId: "classic-v1" }] },
    { strategies: Array.from({ length: 9 }, () => ({ strategyId: "classic-v1" })) },
    { strategies: pairSelection, strategyId: "classic-v1" }, { strategies: pairSelection, config: {} }]) {
    assert.throws(() => service.start(options), /策略|配置|参数|扫描/);
    assert.equal(service.getStatus().phase, "idle");
  }
});

test("strategy sets have canonical hashes and equivalent order reuses an active scan and its cache", async () => {
  const { createHash } = require("node:crypto");
  let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const service = createTrendScreenerService(singleStockDeps({
    fetchBenchmark: async () => { await pending; return bars(80); },
    fetchHistory: async (_, adjustment) => { calls += 1; return { rows: bars(), adjustment }; }
  }));
  const first = service.start({ strategies: pairSelection });
  assert.deepEqual(first.strategies.map(item => item.id), ["classic-v1", "quality-v2"]);
  assert.equal(Object.hasOwn(first, "strategy"), false);
  assert.equal(first.strategySetHash, createHash("sha256").update(JSON.stringify(first.strategies)).digest("hex"));
  assert.equal(service.start({ strategies: [...pairSelection].reverse() }).jobId, first.jobId);
  assert.throws(() => service.start({ strategyId: "classic-v1" }), /正在|取消|运行/);
  first.strategies[1].config.maxExtensionAtr = 5;
  release();
  const result = await settle(service);
  assert.equal(result.strategies[1].config.maxExtensionAtr, 2);
  assert.equal(result.processed, 1);
  assert.equal(result.excluded, 1);
  assert.equal(result.strategyStats.length, 2);
  assert.ok(result.strategyStats.every(item => item.processed === 1 && item.excluded === 1 && item.coverageComplete));
  service.start({ strategies: [...pairSelection].reverse() });
  assert.equal((await settle(service)).performance.cacheHits, 1);
  assert.equal(calls, 2);
  service.start({ strategies: [{ strategyId: "classic-v1" }] });
  const single = await settle(service);
  assert.equal(single.strategy.id, "classic-v1");
  assert.equal(single.strategies.length, 1);
  assert.equal(calls, 4);
  service.start(); await settle(service);
  assert.equal(calls, 4, "legacy and singleton array requests share the same frozen strategy set");
});

test("seven production strategies share one raw and adjusted request per stock", async () => {
  let calls = 0;
  const securities = Array.from({ length: 4 }, (_, n) => security(String(n + 1).padStart(6, "0")));
  const service = createTrendScreenerService({
    now: () => today,
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6" ? { total: 4, rows: securities } : { total: 0, rows: [] },
    fetchBenchmark: async () => bars(80),
    fetchHistory: async (_, adjustment) => {
      calls += 1;
      const rows = bars(); rows[rows.length - 1] = { ...rows.at(-1), open: 10.5, close: 11, high: 11.2, low: 10.4 };
      return { rows, adjustment };
    }
  });
  service.start({ strategies: librarySelection });
  const result = await settle(service);
  assert.equal(result.phase, "completed");
  assert.equal(result.processed, 4);
  assert.equal(result.candidates.length, 28);
  assert.equal(new Set(result.candidates.map(item => item.security.code)).size, 4);
  for (const item of securities) assert.equal(new Set(result.candidates.filter(candidate => candidate.security.code === item.code).map(candidate => candidate.strategy.id)).size, 7);
  assert.equal(calls, 8);
  assert.equal(result.performance.rawRequests, 4);
  assert.equal(result.performance.adjustedRequests, 4);
  assert.ok(result.performance.peakHistoryConcurrency <= 6);
  assert.ok(result.strategyStats.every(item => item.processed === 4 && item.candidateCount === 4 && item.coverageComplete));
  assert.equal(result.coverageComplete, true);
});

test("an unavailable strategy preserves another candidate but prevents full coverage and vector caching", async () => {
  let calls = 0;
  const service = createTrendScreenerService(singleStockDeps({
    fetchHistory: async (_, adjustment) => { calls += 1; return { rows: bars(), adjustment }; },
    evaluateStock: ({ security: item }, options) => options.strategyId === "classic-v1"
      ? { kind: "candidate", candidate: { security: item, stage: "watch", metrics: { relativeStrength20: 1 } } }
      : { kind: "unavailable", reason: "strategy indicator cannot be verified" }
  }));
  service.start({ strategies: pairSelection });
  const result = await settle(service);
  assert.equal(result.processed, 1);
  assert.equal(result.unavailable, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.excluded, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].strategy.id, "classic-v1");
  assert.equal(result.coverageComplete, false);
  assert.equal(result.strategyStats.find(item => item.strategy.id === "classic-v1").coverageComplete, true);
  assert.equal(result.strategyStats.find(item => item.strategy.id === "quality-v2").unavailable, 1);
  service.start({ strategies: pairSelection }); await settle(service);
  assert.equal(calls, 4);
});

test("a per-strategy exception counts one failed stock and retains other verified results", async () => {
  const service = createTrendScreenerService(singleStockDeps({
    evaluateStock: ({ security: item }, options) => {
      if (options.strategyId === "quality-v2") throw new Error("indicator computation failed");
      return { kind: "candidate", candidate: { security: item, stage: "signal", metrics: { relativeStrength20: 1 } } };
    }
  }));
  service.start({ strategies: pairSelection });
  const result = await settle(service);
  assert.equal(result.processed, 1); assert.equal(result.failed, 1); assert.equal(result.unavailable, 0);
  assert.equal(result.candidates.length, 1); assert.equal(result.excluded, 0);
  assert.equal(result.strategyStats.find(item => item.strategy.id === "classic-v1").coverageComplete, true);
  assert.equal(result.strategyStats.find(item => item.strategy.id === "quality-v2").failed, 1);
});

test("shared invalid data and universe exclusions are accounted once per stock and in every strategy", async () => {
  const service = createTrendScreenerService(singleStockDeps({
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6" ? { total: 4, rows: [
      security("000001", { name: "*ST示例" }), security("000002", { name: "" }),
      security("000003", { suspended: true }), security("000004")
    ] } : { total: 0, rows: [] },
    fetchHistory: async (_, adjustment) => ({ adjustment, rows: bars().map(row => ({ ...row, amount: null })) })
  }));
  service.start({ strategies: pairSelection }); const result = await settle(service);
  assert.equal(result.processed, 4); assert.equal(result.excluded, 1); assert.equal(result.unavailable, 3);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.strategyStats.every(item => item.processed === 4 && item.excluded === 1 && item.unavailable === 3 && !item.coverageComplete));
});

test("invalid batch length or candidate strategy snapshot fails the complete stock instead of mislabelling results", async () => {
  const { normalizeTrendStrategy } = require("./trend-strategy.cjs");
  for (const badBatch of [() => [{ kind: "excluded" }], () => Array(2),
    ({ security: item }) => [{ kind: "candidate", candidate: { security: item, strategy: normalizeTrendStrategy({ strategyId: "quality-v2" }) } }, { kind: "excluded" }]]) {
    const service = createTrendScreenerService(singleStockDeps({ evaluateBatch: badBatch }));
    service.start({ strategies: pairSelection }); const result = await settle(service);
    assert.equal(result.processed, 1); assert.equal(result.failed, 1);
    assert.equal(result.candidates.length, 0);
    assert.ok(result.strategyStats.every(item => item.failed === 1 && !item.coverageComplete));
  }
});

test("multi-strategy cancel and restart never multiply physical history concurrency", async () => {
  let physical = 0, peak = 0;
  const releases = [];
  const service = createTrendScreenerService(singleStockDeps({
    fetchUniversePage: async ({ filter }) => filter === "m:0+t:6" ? { total: 12, rows: Array.from({ length: 12 }, (_, n) => security(String(n + 1).padStart(6, "0"))) } : { total: 0, rows: [] },
    fetchHistory: async (_, adjustment) => {
      physical++; peak = Math.max(physical, peak);
      await new Promise(resolve => releases.push(resolve));
      physical--; return { rows: bars(), adjustment };
    }
  }));
  service.start({ strategies: pairSelection }); await waitUntil(() => physical === 6);
  service.cancel(); service.start({ strategies: [...pairSelection].reverse() });
  await new Promise(resolve => setTimeout(resolve, 20));
  const observed = peak;
  service.cancel(); releases.forEach(release => release()); await waitUntil(() => physical === 0);
  assert.equal(observed, 6);
  assert.equal(service.getStatus().processed, 0);
  assert.ok(service.getStatus().strategyStats.every(item => item.processed === 0 && !item.coverageComplete));
});

test("a sparse strategy selection is rejected before the scan starts", () => {
  const service = createTrendScreenerService(singleStockDeps());
  assert.throws(() => service.start({ strategies: Array(1) }), /策略|参数/);
  assert.equal(service.getStatus().phase, "idle");
});

test("multi-strategy candidates rank signals first then strength code and strategy identity", async () => {
  const items = [security("000003"), security("000002"), security("000001")];
  const service = createTrendScreenerService(singleStockDeps({
    fetchUniversePage: async ({ filter }) => ({ total: filter === "m:0+t:6" ? items.length : 0, rows: filter === "m:0+t:6" ? items : [] }),
    evaluateStock: ({ security: item }, { strategyId }) => ({ kind: "candidate", candidate: {
      security: item, stage: item.code === "000003" ? "watch" : "signal",
      metrics: { relativeStrength20: item.code === "000003" ? 100 : strategyId === "quality-v2" && item.code === "000002" ? 2 : 1 }
    } })
  }));
  service.start({ strategies: pairSelection });
  const result = await settle(service);
  assert.deepEqual(result.candidates.map(item => `${item.security.code}:${item.strategy.id}`), [
    "000002:quality-v2", "000001:classic-v1", "000001:quality-v2", "000002:classic-v1", "000003:classic-v1", "000003:quality-v2"
  ]);
});

test("benchmark corrections inside the new 80-session window invalidate a strategy-set cache", async () => {
  let calls = 0;
  const benchmark = bars(80);
  const service = createTrendScreenerService(singleStockDeps({
    fetchBenchmark: async () => benchmark,
    fetchHistory: async (_item, adjustment) => { calls++; return { adjustment, rows: bars() }; }
  }));
  service.start({ strategies: pairSelection }); await settle(service);
  service.start({ strategies: pairSelection }); await settle(service);
  assert.equal(calls, 2);
  benchmark[0].close = 10.2;
  service.start({ strategies: pairSelection }); await settle(service);
  assert.equal(calls, 4);
});

test("price-only CSI benchmark is accepted while missing stock amounts remain unavailable", async () => {
  const service = createTrendScreenerService(singleStockDeps({
    fetchBenchmark: async () => bars(80).map(row => ({ ...row, amount: null, volume: null })),
    fetchHistory: async (_item, adjustment) => ({ adjustment, rows: bars().map(row => ({ ...row, amount: null })) })
  }));
  service.start(); const result = await settle(service);
  assert.equal(result.phase, "completed");
  assert.equal(result.unavailable, 1);
  assert.match(result.errors[0].message, /字段缺失/);
  assert.equal(result.diagnostics.funnel.rawValidated, 0);
});

test("fallback data-contract failures count unavailable and retain source diagnostics", async () => {
  const source = { stage: "raw", source: "sohu+tencent-raw", status: "error", successes: 0, failures: 1,
    latestDate: null, detail: "原价不一致", crossCheckedRows: 0 };
  const service = createTrendScreenerService(singleStockDeps({
    fetchHistory: async () => { throw Object.assign(new Error("原价不一致"), { code: "TREND_DATA_UNAVAILABLE" }); },
    getDiagnostics: () => ({ sources: [source] })
  }));
  service.start(); const result = await settle(service);
  assert.equal(result.unavailable, 1); assert.equal(result.failed, 0);
  assert.deepEqual(result.diagnostics.sources, [source]);
  assert.deepEqual(result.diagnostics.reasons, [{ stage: "raw", reason: "原价不一致", count: 1 }]);
  result.diagnostics.sources[0].detail = "mutated";
  assert.equal(service.getStatus().diagnostics.sources[0].detail, "原价不一致");
});

test("stock funnel and reasons deduplicate strategies and replay on warm cache", async () => {
  const items = Array.from({ length: 5 }, (_, i) => security(`00000${i + 1}`));
  const service = createTrendScreenerService(singleStockDeps({
    fetchUniversePage: async ({ filter }) => ({ total: filter === "m:0+t:6" ? 5 : 0, rows: filter === "m:0+t:6" ? items : [] }),
    prefilterStock: ({ security: item }) => item.code === "000001" ? { kind: "excluded", reason: "最近15根交易日没有收盘涨停" } : null,
    evaluateStock: ({ security: item }) => item.code === "000002"
      ? { kind: "excluded", reason: "未满足收盘价>MA20>MA60且MA20上升" }
      : { kind: "candidate", candidate: { security: item, stage: item.code === "000005" ? "signal" : "watch",
        patterns: item.code === "000003" ? [] : ["A"], plan: item.code === "000005" ? { stop: 9, minEntry: 9.01, maxEntry: 10 } : null,
        evidence: item.code === "000004" ? [{ label: "市场门槛", passed: false }] : [] } }
  }));
  service.start({ strategies: pairSelection }); const cold = await settle(service);
  assert.deepEqual(cold.diagnostics.funnel, { universeEligible: 5, rawValidated: 5, recentLimitPassed: 4,
    trendPassed: 3, technicalTriggered: 2, riskPassed: 1 });
  assert.equal(cold.diagnostics.reasons.find(row => row.reason === "市场门槛").count, 1);
  service.start({ strategies: pairSelection }); const warm = await settle(service);
  assert.equal(warm.performance.cacheHits, 5);
  assert.deepEqual(warm.diagnostics.funnel, cold.diagnostics.funnel);
  assert.deepEqual(warm.diagnostics.reasons, cold.diagnostics.reasons);
});

test("an individual fallback 503 remains a partial failure and other securities continue", async () => {
  const service = createTrendScreenerService(singleStockDeps({
    fetchUniversePage: async ({filter}) => filter === "m:0+t:6" ? {total:2,rows:[security("000001"),security("000002")]} : {total:0,rows:[]},
    fetchHistory: async (item, adjustment) => {
      if(item.code === "000001") throw Object.assign(new Error("备用源请求失败：HTTP 503"),{code:"TREND_SOURCE_REQUEST_FAILED",status:503});
      return {adjustment,rows:bars()};
    }
  }));
  service.start(); const result = await settle(service);
  assert.equal(result.phase,"completed"); assert.equal(result.processed,2);
  assert.equal(result.failed,1); assert.equal(result.excluded,1); assert.equal(result.coverageComplete,false);
  assert.match(result.errors[0].message,/503/);
});

test("302 securities from the ChiNext board are eligible for history evaluation",async()=>{
  const service=createTrendScreenerService(singleStockDeps({fetchUniversePage:async({filter})=>filter==="m:0+t:80"?{total:1,rows:[security("302132")]}:{total:0,rows:[]}}));
  service.start();const result=await settle(service);
  assert.equal(result.performance.rawRequests,1);assert.equal(result.diagnostics.funnel.universeEligible,1);
});

test("raw validation funnel rejects malformed limit metadata before counting usable stock history",async()=>{
  const service=createTrendScreenerService(singleStockDeps({fetchHistory:async(_security,adjustment)=>{
    const rows=bars();rows.at(-1).changePct=null;return {adjustment,rows};
  }}));service.start();const result=await settle(service);
  assert.equal(result.unavailable,1);assert.equal(result.diagnostics.funnel.rawValidated,0);
});

test('all fourteen v1.4 strategy selections share history and catalog technical evidence drives the funnel',async()=>{
 const selections=[{strategyId:'classic-v1'},{strategyId:'quality-v2'},...require('../config/trend-strategy-library.json').map(row=>({strategyId:row.id}))];
 const catalog=require('../config/trend-strategy-library.json');
 const service=createTrendScreenerService(singleStockDeps({evaluateStock:({security:item},{strategyId})=>({kind:'candidate',candidate:{security:item,stage:'watch',patterns:[],plan:null,evidence:catalog.find(row=>row.id===strategyId)?.technicalLabels.map(label=>({label,passed:true}))||[]}})}));
 service.start({strategies:selections});const result=await settle(service);
 assert.equal(result.strategies.length,14);assert.equal(result.performance.rawRequests,1);assert.equal(result.performance.adjustedRequests,1);
 assert.equal(result.candidates.length,14);assert.equal(result.diagnostics.funnel.technicalTriggered,1);
 assert.throws(()=>service.start({strategies:[...selections,{strategyId:'classic-v1'}]}),/策略/);
});
