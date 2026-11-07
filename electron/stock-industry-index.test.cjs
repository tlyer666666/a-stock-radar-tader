"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStockIndustryIndex } = require("./stock-industry-index.cjs");
const { createFailedBoardHistoryService } = require("./failed-board-history.cjs");

const industries = Array.from({ length: 3 }, (_, i) => ({ code: `88110${i}`, name: ["半导体", "电池", "白酒"][i] }));
const members = { "881100.TI": [{ code: "600001" }, { code: "600002" }], "881101.TI": [{ code: "300750" }, { code: "600002" }], "881102.TI": [{ code: "600519" }] };
const make = (extra = {}) => {
  let clock = 1_000_000, writes = [], memberCalls = 0;
  const index = createStockIndustryIndex({ listIndustries: async () => industries, loadMembers: async (code) => { memberCalls++; return members[code] || []; },
    store: { read: () => extra.stored ?? null, write: value => writes.push(value) }, now: () => clock, minIndustries: 2, minStocks: 3, ...extra.options });
  return { index, writes, advance: ms => { clock += ms; }, calls: () => memberCalls };
};

test("industry index maps each stock to its THS industry board and saves it locally", async () => {
  const h = make();
  await h.index.ensure();
  assert.equal(h.index.lookup("600001"), "半导体");
  assert.equal(h.index.lookup("300750"), "电池");
  assert.equal(h.index.lookup("600002"), "半导体", "first board wins for a stock listed twice");
  assert.equal(h.index.lookup("000000"), "");
  assert.equal(h.writes.length, 1);
  const calls = h.calls(); await h.index.ensure(); assert.equal(h.calls(), calls, "fresh index is not rebuilt");
  h.advance(25 * 3600 * 1000); await h.index.ensure(); assert.ok(h.calls() > calls, "rebuilt after a day");
});

test("an incomplete rebuild keeps the previous saved index instead of erasing industries", async () => {
  const stored = { builtAt: 0, source: "old", industries: { "600001": "旧行业" } };
  const h = make({ stored, options: { loadMembers: async () => [], minIndustries: 2 } });
  await h.index.ensure();
  assert.equal(h.index.lookup("600001"), "旧行业");
  assert.equal(h.writes.length, 0);
});

test("a partial rebuild above the default size thresholds preserves the complete old index and retries soon", async t => {
  for (const failure of ["rejected", "empty", "invalid members"]) await t.test(failure, async () => {
    const listed = Array.from({ length: 41 }, (_, i) => ({ code: String(881100 + i), name: `行业${i}` }));
    const oldMap = Object.fromEntries(listed.flatMap((row, i) => Array.from({ length: 50 }, (_, j) => [String(600000 + i * 50 + j), row.name])));
    const stored = { builtAt: 0, source: "complete-old", industries: oldMap };
    let clock = 2 * 86400000, failing = true, calls = 0;
    const writes = [];
    const index = createStockIndustryIndex({ now: () => clock, listIndustries: async () => listed,
      loadMembers: async code => {
        calls++;
        const i = Number(code.slice(0, 6)) - 881100;
        if (i === 40 && failing) {
          if (failure === "rejected") throw Error("temporary source failure");
          if (failure === "invalid members") return [{ code: "invalid" }];
          return [];
        }
        return Array.from({ length: 50 }, (_, j) => ({ code: String(600000 + i * 50 + j) }));
      }, store: { read: () => stored, write: value => writes.push(value) } });
    await index.ensure();
    assert.equal(index.lookup("602000"), "行业40", "failed industry keeps its previous members");
    assert.equal(index.status().stocks, 2050);
    assert.equal(index.status().builtAt, 0, "partial work is not marked as a complete fresh index");
    assert.equal(writes.length, 0);
    await index.ensure();
    assert.equal(calls, 41, "failure cooldown prevents immediate repeated rebuilds");
    failing = false;
    clock += 31 * 60 * 1000;
    await index.ensure();
    assert.equal(calls, 82, "recovery is retried well before the full-day freshness interval");
    assert.equal(index.lookup("602000"), "行业40");
    assert.equal(index.status().builtAt, clock);
    assert.equal(writes.length, 1);
    await index.ensure();
    assert.equal(calls, 82, "only the complete recovery receives the normal fresh interval");
  });
});

test("failed-board snapshot fills 未分类 rows by code and keeps the label when nothing is known", async () => {
  const dates = ["2026-10-16", "2026-10-15"];
  const pool = (date, rows) => ({ date, serverTradingDate: "2026-10-16", provider: "ths_public_limit_up", providers: ["ths_public_limit_up"], pool: rows });
  const requested = [];
  const service = createFailedBoardHistoryService({
    displayDate: value => String(value || ""), todayInShanghai: () => "2026-10-16",
    isAStockCode: code => /^\d{6}$/.test(code), isRiskStockName: () => false,
    recentLimitUpPools: async () => [pool("2026-10-16", []), pool("2026-10-15", [{ code: "600001", name: "甲", industry: "未分类" }, { code: "600009", name: "丙", industry: "未分类" }])],
    recentTradingDates: async () => dates, selectLimitUpTradingDates: () => dates.slice(0, 1),
    topicPoolForDate: async date => pool(date, [{ code: "600001", name: "甲", industry: "未分类" }, { code: "600009", name: "丙" }]),
    resolveIndustries: async (codes, { dates: asked }) => { requested.push([codes, asked]); return new Map([["600001", "半导体"]]); }
  });
  const result = await service.getPreviousLimitUpFailedBoardSnapshot();
  assert.deepEqual(requested[0][0].sort(), ["600001", "600009"]);
  assert.ok(requested[0][1].includes("2026-10-16"));
  const day = result.failedBoardDays[0];
  assert.equal(day.rows.find(row => row.code === "600001").industry, "半导体");
  assert.equal(day.rows.find(row => row.code === "600009").industry, "未分类");
  const intersection = result.rows.find(row => row.code === "600001");
  if (intersection) assert.equal(intersection.industry, "半导体");
});

const indexGate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const indexTick = () => new Promise(resolve => setImmediate(resolve));

test("index build separates shared subscribers and retains physical capacity through cancellation", async () => {
  const physical = indexGate(); let sourceSignal, starts = 0;
  const index = createStockIndustryIndex({ minIndustries: 2, minStocks: 3,
    listIndustries: ({ signal }) => {
      starts++; sourceSignal = signal;
      if (starts > 1) return Promise.resolve(industries);
      const logical = new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      Object.defineProperty(logical, "drained", { value: physical.promise }); return logical;
    }, loadMembers: async code => members[code] || [] });
  const a = new AbortController(), b = new AbortController();
  const first = index.ensure({ signal: a.signal }), second = index.ensure({ signal: b.signal });
  const firstOutcome = first.catch(error => error), secondOutcome = second.catch(error => error);
  await indexTick();
  try {
    a.abort(new Error("first stopped")); await indexTick();
    assert.equal(sourceSignal.aborted, false, "a caller cannot cancel the shared builder's other subscriber");
    assert.match((await firstOutcome).message, /first stopped/);
    b.abort(new Error("second stopped")); await secondOutcome; await indexTick();
    assert.equal(sourceSignal.aborted, true);
    await assert.rejects(index.ensure(), error => error.code === "SERVICE_BUSY");
    assert.equal(starts, 1, "aborted but undrained work keeps the one builder slot");
  } finally { a.abort(); b.abort(); physical.resolve(); await Promise.allSettled([firstOutcome, secondOutcome]); }
  await first.drained;
  await index.ensure();
  assert.equal(index.lookup("600519"), "白酒", "cancellation does not apply the failure cooldown");
  await index.shutdown();
});

test("background industry rebuild survives a cancelled foreground subscriber", async () => {
  const entered = indexGate(); let sourceSignal;
  const index = createStockIndustryIndex({ minIndustries: 2, minStocks: 3,
    listIndustries: ({ signal }) => { sourceSignal = signal; return entered.promise; }, loadMembers: async code => members[code] || [] });
  const background = index.ensure();
  const controller = new AbortController(); const foreground = index.ensure({ signal: controller.signal }); const outcome = foreground.catch(error => error);
  controller.abort(new Error("stopped")); await indexTick();
  try { assert.equal(sourceSignal.aborted, false); }
  finally { entered.resolve(industries); }
  assert.match((await outcome).message, /stopped/); await background;
  assert.equal(index.lookup("600519"), "白酒"); await index.shutdown();
});
