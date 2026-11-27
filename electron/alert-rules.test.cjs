"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAlertRules, evaluateIndicator, marketLight, normalizeRule, describeRule, rsi, isAlertStore } = require("./alert-rules.cjs");

const cn = text => Date.parse(`${text}+08:00`);
const day = index => new Date(Date.UTC(2026, 7, 3) + index * 86_400_000).toISOString().slice(0, 10);
const series = closes => closes.map((close, index) => ({ date: day(index), close, high: close * 1.01, low: close * 0.99 }));
const rule = (type, params, extra = {}) => normalizeRule({ type, scope: "symbol", code: "600519", params, ...extra }, { id: "r1" });

test("rules are validated and described in plain words", () => {
  assert.equal(describeRule(rule("ma_cross", { direction: "above", window: 20 }, { name: "贵州茅台" })), "贵州茅台 600519：收盘价上穿 20 日线");
  assert.equal(describeRule(normalizeRule({ type: "macd", scope: "watchlist", params: { direction: "bearish" } })), "全部自选：MACD 死叉");
  assert.equal(describeRule(normalizeRule({ type: "market_light", params: { statuses: ["red", "green"] } })), "大盘：大盘转红灯");
  assert.equal(normalizeRule({ type: "market_light", scope: "symbol" }).scope, "market");
  assert.throws(() => normalizeRule({ type: "rsi", scope: "holdings", params: { threshold: 120 } }), /RSI 阈值/);
  assert.throws(() => normalizeRule({ type: "ma_cross", scope: "symbol", code: "abc" }), /6 位股票代码/);
  assert.throws(() => normalizeRule({ type: "ma_cross" }), /范围/);
  assert.throws(() => normalizeRule({ type: "nope", scope: "symbol", code: "600519" }), /不支持/);
  assert.equal(rule("ma_cross", { window: 9999 }).params.window, 20, "out-of-range window falls back");
});

test("indicators fire only on the bar where the cross happens, not while the state merely persists", () => {
  const flat = Array(25).fill(10);
  const up = evaluateIndicator(rule("ma_cross", { direction: "above", window: 5 }), series([...flat, 9.8, 10.6]));
  assert.equal(up.status, "triggered");
  assert.match(up.detail, /上穿 5 日线/);
  const stillAbove = evaluateIndicator(rule("ma_cross", { direction: "above", window: 5 }), series([...flat, 9.8, 10.6, 10.9]));
  assert.equal(stillAbove.status, "not_triggered", "already above yesterday → no new alert");
  const down = evaluateIndicator(rule("ma_cross", { direction: "below", window: 5 }), series([...flat, 10.3, 9.2]));
  assert.equal(down.status, "triggered");
  const few = evaluateIndicator(rule("ma_cross", { window: 20 }), series([10, 11, 12]));
  assert.equal(few.status, "degraded");
  assert.match(few.detail, /至少需要 21 根/);
  const falling = Array.from({ length: 30 }, (_, i) => 20 - i * 0.3);
  const rsiRule = rule("rsi", { direction: "above", period: 6, threshold: 30 });
  const rebound = evaluateIndicator(rsiRule, series([...falling, 11.9, 12.6]));
  assert.equal(rebound.status, "triggered");
  assert.match(rebound.detail, /上穿 30/);
  const wilder = rsi([1, 2, 3, 4, 5, 6, 7], 6);
  assert.equal(wilder[5], null, "warm-up stays null");
  assert.equal(wilder[6], 100);
  const longDown = Array.from({ length: 90 }, (_, i) => 40 - i * 0.2);
  const golden = evaluateIndicator(rule("macd", { direction: "bullish" }), series([...longDown, 22.8, 23.9, 25.3]));
  assert.ok(["triggered", "not_triggered"].includes(golden.status));
  const crossIndex = [1, 2, 3, 4, 5].map(extra => evaluateIndicator(rule("macd", { direction: "bullish" }), series([...longDown, ...[22.8, 23.9, 25.3, 26.5, 27.5].slice(0, extra)])).status);
  assert.equal(crossIndex.filter(status => status === "triggered").length, 1, "a MACD golden cross is reported exactly once as the rebound unfolds");
  const kdj = [1, 2, 3, 4, 5].map(extra => evaluateIndicator(rule("kdj", { direction: "bullish" }), series([...longDown.slice(0, 40), ...[32.5, 33.5, 34.5, 35, 36].slice(0, extra)])).status);
  assert.equal(kdj.filter(status => status === "triggered").length, 1);
  const cciHit = evaluateIndicator(rule("cci", { direction: "above", period: 14, threshold: 100 }), series([...Array.from({ length: 20 }, (_, i) => i % 2 ? 10.2 : 10), 10.1, 11.5]));
  assert.equal(cciHit.status, "triggered");
});

test("market light scores index moves and breadth, and refuses to judge with no data", () => {
  const board = { tradingDate: "2026-11-26", indices: [{ code: "000001", changePct: -1.5 }, { code: "399001", changePct: -2 }, { code: "000688", changePct: 9 }], totals: { up: 800, down: 4200 } };
  const red = marketLight(board);
  assert.equal(red.status, "red");
  assert.equal(red.partial, false);
  assert.equal(marketLight({ indices: [{ code: "000001", changePct: 1.2 }], totals: { up: 4000, down: 1000 } }).status, "green");
  const partial = marketLight({ indices: [{ code: "000001", changePct: 0 }], totals: null });
  assert.equal(partial.status, "yellow");
  assert.equal(partial.partial, true);
  assert.equal(marketLight({ indices: [], totals: null }), null);
});

function engine({ bars, targets = { watchlist: [], holdings: [] }, board = null, start = cn("2026-11-26T15:30:00") } = {}) {
  let state = null;
  let clock = start;
  let seq = 0;
  const notices = [];
  const loads = [];
  const api = createAlertRules({
    store: { read: () => state, write: value => { state = structuredClone(value); } },
    loadBars: async target => { loads.push(target.code); if (!bars[target.code]) throw new Error("no bars"); return bars[target.code]; },
    loadTargets: async () => targets, loadBoard: async () => { if (!board) throw new Error("no board"); return board; },
    notify: value => notices.push(value), now: () => clock, id: () => `id${++seq}`
  });
  return { api, notices, loads, set: value => { clock = value; }, bars };
}
const crossBars = (lastDate, closes) => closes.map((close, index, list) => ({ date: new Date(Date.parse(`${lastDate}T00:00:00Z`) - (list.length - 1 - index) * 86_400_000).toISOString().slice(0, 10), close, high: close * 1.01, low: close * 0.99 }));

test("a group rule runs over the whole watchlist, notifies once, respects cooldown, and reports missing data instead of silence", async () => {
  const flat = Array(25).fill(10);
  const bars = { "600519": crossBars("2026-11-26", [...flat, 9.8, 10.6]), "000001": crossBars("2026-11-26", [...flat, 10, 9.9]) };
  const ctx = engine({ bars, targets: { watchlist: [{ code: "600519", name: "贵州茅台" }, { code: "000001", name: "平安银行" }, { code: "300750", name: "宁德时代" }], holdings: [] } });
  ctx.api.saveRule({ type: "ma_cross", scope: "watchlist", params: { direction: "above", window: 5 }, cooldownHours: 48 });
  const first = await ctx.api.run();
  assert.equal(first.triggered, 1);
  assert.equal(ctx.notices.length, 1);
  assert.match(ctx.notices[0].body, /贵州茅台：收盘 10.6 上穿 5 日线/);
  let { history, lastRunAt } = ctx.api.list();
  assert.ok(lastRunAt);
  assert.deepEqual(history.map(item => [item.target, item.status]).sort(), [["宁德时代", "degraded"], ["贵州茅台", "triggered"]]);
  await ctx.api.run();
  assert.equal(ctx.notices.length, 1, "the same bar is not reported twice");
  assert.equal(ctx.api.list().history.length, 2);
  // 第二天又一次上穿：冷却 48 小时内只记不通知
  ctx.set(cn("2026-11-27T15:30:00"));
  ctx.bars["600519"] = crossBars("2026-11-27", [...flat, 9.8, 10.6, 9.7, 10.8]);
  await ctx.api.run();
  assert.equal(ctx.notices.length, 1);
  assert.ok(ctx.api.list().history.some(item => item.target === "贵州茅台" && item.status === "cooldown"), "second cross inside the cooldown is logged but not notified");
  const dry = await ctx.api.run({ dryRuleId: ctx.api.list().rules[0].id });
  assert.equal(dry.dry, true);
  assert.equal(dry.results.length, 3);
  assert.equal(ctx.api.clearHistory().history.length, 0);
  assert.equal(ctx.api.removeRule(ctx.api.list().rules[0].id).rules.length, 0);
});

test("today's unfinished bar is ignored before the close, and market-only runs skip stock rules", async () => {
  const flat = Array(25).fill(10);
  const bars = { "600519": crossBars("2026-11-26", [...flat, 9.8, 10.6]) };
  const ctx = engine({ bars, start: cn("2026-11-26T10:30:00"), board: { tradingDate: "2026-11-26", indices: [{ code: "000001", changePct: -2 }], totals: { up: 500, down: 4500 } } });
  ctx.api.saveRule({ type: "ma_cross", scope: "symbol", code: "600519", name: "贵州茅台", params: { direction: "above", window: 5 } });
  ctx.api.saveRule({ type: "market_light", params: { statuses: ["red"] } });
  const intraday = await ctx.api.run({ onlyMarket: true });
  assert.equal(ctx.loads.length, 0, "stock bars are not read on market-only runs");
  assert.equal(intraday.triggered, 1);
  assert.match(ctx.notices[0].body, /大盘：红灯/);
  const full = await ctx.api.run();
  assert.equal(full.results.find(item => item.code === "600519").status, "not_triggered", "10:30 — today's bar is not closed, so the cross is not confirmed yet");
  ctx.set(cn("2026-11-26T15:10:00"));
  const closed = await ctx.api.run();
  assert.equal(closed.results.find(item => item.code === "600519").status, "triggered");
});

test("changes made while a run is loading bars are kept, a run with no usable data does not count as done, and bad stored rules are dropped", async () => {
  let state = { version: 1, rules: [{ id: "bad", type: "ma_cross", scope: "symbol", code: "600519" }, { id: "broken", type: "nope" }, null], history: [], cooldowns: null, lastRunAt: "" };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let fail = true;
  let seq = 0;
  const api = createAlertRules({
    store: { read: () => structuredClone(state), write: value => { state = structuredClone(value); } },
    loadBars: async () => { await gate; if (fail) throw new Error("offline"); return crossBars("2026-11-26", [...Array(25).fill(10), 9.8, 10.6]); },
    loadTargets: async () => ({ watchlist: [], holdings: [] }), loadBoard: async () => { throw new Error("x"); },
    now: () => cn("2026-11-26T15:30:00"), id: () => `x${++seq}`
  });
  assert.deepEqual(api.list().rules.map(rule => rule.id), ["bad"], "a rule of an unknown type and a null entry are dropped on read; missing params get defaults");
  assert.equal(api.list().rules[0].params.window, 20);
  const running = api.run();
  api.saveRule({ type: "macd", scope: "watchlist", params: { direction: "bullish" } }); // 评估期间新增一条
  release();
  await running;
  assert.equal(api.list().rules.length, 2, "the rule added during the run is not overwritten");
  assert.equal(api.list().lastRunAt, "", "every bar load failed → not counted as evaluated, the scheduler will retry");
  assert.equal(api.list().history[0].status, "degraded");
  fail = false;
  await api.run();
  assert.ok(api.list().lastRunAt);
});

test("a market-light trigger inside the cooldown is logged once per day and can fire again the same day once the cooldown ends", async () => {
  let clock = cn("2026-11-26T14:00:00");
  let state = null;
  let seq = 0;
  const notices = [];
  const board = { tradingDate: "", indices: [{ code: "000001", changePct: -2 }], totals: { up: 500, down: 4500 } };
  const api = createAlertRules({ store: { read: () => state && structuredClone(state), write: value => { state = structuredClone(value); } }, loadBars: async () => [], loadTargets: async () => ({ watchlist: [], holdings: [] }),
    loadBoard: async () => board, notify: value => notices.push(value), now: () => clock, id: () => `m${++seq}` });
  api.saveRule({ type: "market_light", params: { statuses: ["red"] }, cooldownHours: 24 });
  await api.run({ onlyMarket: true });
  assert.equal(notices.length, 1);
  clock = cn("2026-11-26T14:10:00");
  await api.run({ onlyMarket: true });
  assert.equal(api.list().history.length, 1, "no trading date in the feed → today's Beijing date is used, so the same day is not logged again");
  clock = cn("2026-11-27T10:00:00");
  await api.run({ onlyMarket: true });
  await api.run({ onlyMarket: true });
  assert.deepEqual(api.list().history.map(item => item.status), ["cooldown", "triggered"], "one cooldown entry for the new day, not one every 10 minutes");
  clock = cn("2026-11-27T14:05:00");
  await api.run({ onlyMarket: true });
  assert.equal(notices.length, 2, "after the 24h cooldown the same day can alert again");
  const full = api.run();
  const market = api.run({ onlyMarket: true });
  assert.equal(await market, await full, "a market-only request during a full run shares that run");
});

test("H5, H6, M4 & L2: flat RSI is 50, abort does not write degraded/lastRunAt, cooldowns prune, store caps, OHLC/date dedup, Beijing-day dedup, market-only degraded skips lastRunAt", async () => {
  // H6: flat series gives RSI = 50, not 100
  const flatRsi = rsi([10, 10, 10, 10, 10, 10, 10, 10], 6);
  assert.equal(flatRsi[6], 50);
  assert.equal(flatRsi[7], 50);

  // M4: OHLC validation (high > 0, low > 0) and duplicate date dedup
  const baseRows = series([...Array(25).fill(10), 9.8, 10.6]);
  const withBadAndDup = [
    ...baseRows.slice(0, -1),
    { date: baseRows.at(-1).date, close: 9.0, high: 9.1, low: 8.9 },
    baseRows.at(-1), // duplicate date keeps last
    { date: "2026-12-01", close: 10, high: 0, low: 9.5 }, // bad high <= 0 dropped
    { date: "2026-12-02", close: 10, high: 10.5, low: 0 } // bad low <= 0 dropped
  ];
  assert.equal(evaluateIndicator(rule("ma_cross", { direction: "above", window: 5 }), withBadAndDup).status, "triggered");

  // M4: isAlertStore enforces caps
  assert.equal(isAlertStore({ version: 1, rules: Array(61).fill({}), history: [] }), false);
  assert.equal(isAlertStore({ version: 1, rules: [], history: Array(301).fill({}) }), false);
  assert.equal(isAlertStore({ version: 1, rules: [], history: [] }), true);

  // H5: AbortError during bars or board aborts cleanly without writing degraded history or lastRunAt
  let persisted = 0;
  let state = { version: 1, rules: [rule("ma_cross", { direction: "above", window: 5 }), normalizeRule({ type: "market_light", params: { statuses: ["red"] } }, { id: "m1" })], history: [], cooldowns: { "orphan|600519": { until: Date.now(), date: "2026-11-26" }, "r1|old": { until: cn("2026-09-01T15:00:00"), date: "2026-09-01" } }, lastRunAt: "" };
  const ac = new AbortController();
  const apiAbort = createAlertRules({
    store: { read: () => structuredClone(state), write: value => { persisted += 1; state = structuredClone(value); } },
    loadBars: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
    loadTargets: async () => ({ watchlist: [], holdings: [] }),
    loadBoard: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
    now: () => cn("2026-11-26T15:30:00")
  });
  await assert.rejects(apiAbort.run({ signal: ac.signal }), { name: "AbortError" });
  assert.equal(persisted, 0, "aborted run never writes degraded entries or lastRunAt");
  assert.equal(state.history.length, 0);
  assert.equal(state.lastRunAt, "");

  // M4: cooldown pruning on save (orphans + >30d old removed)
  apiAbort.clearHistory();
  assert.deepEqual(state.cooldowns, {}, "orphaned and expired (>30d) cooldowns are pruned on save");

  // L2: market_light-only failed run does not stamp lastRunAt; degraded dedup uses Beijing day
  let state2 = { version: 1, rules: [normalizeRule({ type: "market_light", params: { statuses: ["red"] } }, { id: "m1" })], history: [], cooldowns: {}, lastRunAt: "" };
  let clock2 = cn("2026-11-26T00:30:00"); // 2026-11-25T16:30Z (prev UTC date, same CN date as 09:00)
  const api2 = createAlertRules({
    store: { read: () => structuredClone(state2), write: value => { state2 = structuredClone(value); } },
    loadBars: async () => [],
    loadTargets: async () => ({ watchlist: [], holdings: [] }),
    loadBoard: async () => { throw new Error("network down"); },
    now: () => clock2
  });
  await api2.run();
  assert.equal(state2.lastRunAt, "", "failed market_light-only run does not stamp lastRunAt");
  assert.equal(state2.history.length, 1);
  clock2 = cn("2026-11-26T09:00:00"); // 2026-11-26T01:00Z (different UTC date, SAME Beijing date)
  await api2.run();
  assert.equal(state2.history.length, 1, "degraded dedup uses Beijing date, not UTC date");
});
