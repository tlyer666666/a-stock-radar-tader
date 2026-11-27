"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const { createHookHarness, text } = require("../../../qa/research-hook-harness.cjs");

let restoreTypeScript;
let IndexBoard;
let model;

before(() => {
  restoreTypeScript = registerTypeScript();
  IndexBoard = require("./IndexBoard.tsx").default;
  model = require("./indexBoardModel.ts");
});

after(() => restoreTypeScript?.());

const quote = (code, name, latest, changePct, extra = {}) => ({
  code, secid: `1.${code}`, name, major: true, latest, change: latest === null ? null : Math.round(latest * changePct) / 100, changePct,
  open: latest, high: latest, low: latest, preClose: latest === null ? null : latest / (1 + changePct / 100), amount: 3.3e11,
  up: null, down: null, flat: null, date: "2026-11-25", time: "11:15", trend: [], ...extra
});
const SNAPSHOT = {
  fetchedAt: "2026-11-25T03:20:05.000Z",
  tradingDate: "2026-11-25",
  indices: [
    quote("000001", "上证指数", 3513.26, -0.99, { up: 1226, down: 1071, flat: 58, trend: [3548, 3530, 3520, 3513.26] }),
    quote("399006", "创业板指", 2244.32, -1.52),
    quote("899050", "北证50", 783.12, 1.32),
    quote("000688", "科创50", null, null)
  ],
  totals: { amount: 7.238e11, up: 2901, down: 2273, flat: 119, scope: "沪深两市（不含北交所）" },
  missing: ["科创50"],
  source: "东方财富指数行情"
};

test("amounts, signs and red-up/green-down tones follow A-share conventions", () => {
  assert.equal(model.formatAmount(7.238e11), "7,238亿");
  assert.equal(model.formatAmount(1.25e12), "1.25万亿");
  assert.equal(model.formatAmount(null), "--");
  assert.equal(model.formatSigned(-0.99, 2, "%"), "-0.99%");
  assert.equal(model.formatSigned(1.3, 2, "%"), "+1.30%");
  assert.equal(model.indexTone(0.2), "up");
  assert.equal(model.indexTone(-0.2), "down");
  assert.equal(model.indexTone(0), "flat");
  assert.equal(model.indexTone(null), "flat");
});

test("sparkline is centred on the previous close and a half day only fills half the width", () => {
  const path = model.sparklinePath([100, 101, 99, 100.5], 100, { width: 120, height: 36, slots: 121 });
  assert.ok(path);
  assert.equal(path.baseline, 18);
  assert.match(path.line, /^M0\.0,18\.0 /);
  const lastX = Number(path.line.split(" ").at(-1).slice(1).split(",")[0]);
  assert.ok(lastX < 5, "4 points out of 121 slots stay at the left edge");
  assert.equal(model.sparklinePath([100], 100), null);
});

test("headline names the strongest and weakest index and the two-market breadth", () => {
  const text = model.indexBoardHeadline(SNAPSHOT);
  assert.match(text, /^1 涨 2 跌/);
  assert.match(text, /北证50最强（\+1\.32%）/);
  assert.match(text, /创业板指最弱（-1\.52%）/);
  assert.match(text, /个股 2901 涨 \/ 2273 跌/);
  assert.equal(model.indexBoardStale(SNAPSHOT, "2026-11-26"), true);
  assert.equal(model.indexBoardStale(SNAPSHOT, "2026-11-25"), false);
});

test("IndexBoard renders cards, totals, trend tags and an honest missing list", () => {
  const html = renderToStaticMarkup(React.createElement(IndexBoard, {
    snapshot: SNAPSHOT, state: "ready", today: "2026-11-25", trendByName: { "上证指数": "跌破20日线" }, onRetry: () => {}
  }));
  for (const text of ["指数", "两市成交", "7,238亿", "涨 2901", "跌 2273", "上证指数", "3513.26", "-0.99%", "跌破20日线", "北证50", "+1.32%", "未取到：科创50"]) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /index-card tone-down major/);
  assert.match(html, /index-card tone-up major/);
  assert.match(html, /<svg class="index-card-spark tone-down"/);
  assert.match(html, /aria-label="科创50 未取到，--"/);
});

test("IndexBoard shows loading, error-with-retry, and last-session labels", () => {
  const loading = renderToStaticMarkup(React.createElement(IndexBoard, { snapshot: null, state: "loading", today: "2026-11-25", onRetry: () => {} }));
  assert.match(loading, /正在读取指数行情/);
  const failed = renderToStaticMarkup(React.createElement(IndexBoard, { snapshot: null, state: "error", today: "2026-11-25", onRetry: () => {} }));
  assert.match(failed, /指数行情暂时没取到/);
  assert.match(failed, /重试/);
  const stale = renderToStaticMarkup(React.createElement(IndexBoard, { snapshot: SNAPSHOT, state: "ready", today: "2026-11-26", onRetry: () => {} }));
  assert.match(stale, /上个交易日 2026-11-25 收盘/);
});

test("a pushed tick merges only the fields it carries, moves the sparkline tip and recomputes two-market totals", () => {
  const base = { ...SNAPSHOT, indices: [...SNAPSHOT.indices, quote("399001", "深证成指", 10312.64, -1.06, { up: 1675, down: 1202, flat: 61, amount: 3.92e11 })] };
  const next = model.applyIndexTick(base, { quotes: [
    { code: "000001", latest: 3515.01, change: -33.36, changePct: -0.94, high: null, up: 1300, down: 1000, time: "11:16:03", date: "2026-11-25" },
    { code: "000688", latest: 1210.5, changePct: -3.17 },
    { code: "999999", latest: 1 }
  ] });
  assert.notEqual(next, base);
  const sh = next.indices[0];
  assert.equal(sh.latest, 3515.01);
  assert.equal(sh.high, 3513.26, "null in a tick never overwrites a known value");
  assert.equal(sh.time, "11:16:03", "tick preserves second precision for snapshot comparison");
  assert.deepEqual(sh.trend, [3548, 3530, 3520, 3515.01]);
  const rendered = renderToStaticMarkup(React.createElement(IndexBoard, { snapshot: next, state: "ready", today: "2026-11-25", onRetry: () => {} }));
  assert.match(rendered, /2026-11-25 11:16\b/, "display still renders HH:mm");
  assert.doesNotMatch(rendered, /11:16:03/);
  assert.equal(next.indices.find(item => item.code === "000688").latest, 1210.5);
  assert.equal(next.missing, undefined, "an index that starts ticking leaves the missing list");
  assert.equal(next.totals.up, 1300 + 1675);
  assert.equal(next.totals.amount, 3.3e11 + 3.92e11);
  assert.equal(model.applyIndexTick(base, { quotes: [{ code: "999999", latest: 1 }] }), base, "unknown codes change nothing");
  assert.equal(model.applyIndexTick(null, { quotes: [{ code: "000001", latest: 1 }] }), null);
  assert.equal(model.tickClock(Date.parse("2026-11-25T05:31:05.123Z")), "13:31:05.123");
});

test("mergeIndexSnapshot keeps newer same-minute SSE tick over HH:mm snapshot and syncs adopted sparkline tip", () => {
  const afterTick = model.applyIndexTick(SNAPSHOT, {
    quotes: [{ code: "000001", latest: 3522.88, changePct: -0.71, time: "11:16:03", date: "2026-11-25" }]
  });
  const stalePoll = {
    ...SNAPSHOT,
    indices: SNAPSHOT.indices.map(item => item.code === "000001"
      ? { ...item, latest: 3514.0, changePct: -0.96, time: "11:16", trend: [3548, 3535, 3530, 3520, 3514.0] }
      : item)
  };
  const merged = model.mergeIndexSnapshot(afterTick, stalePoll);
  const sh = merged.indices[0];
  assert.equal(sh.latest, 3522.88, "11:16:03 SSE push beats 11:16 HTTP poll");
  assert.equal(sh.time, "11:16:03");
  assert.deepEqual(sh.trend, [3548, 3535, 3530, 3520, 3522.88], "longer snapshot trend adopts earlier.latest as tip");

  const newerPoll = {
    ...SNAPSHOT,
    indices: SNAPSHOT.indices.map(item => item.code === "000001"
      ? { ...item, latest: 3525.5, changePct: -0.64, time: "11:17", trend: [3548, 3535, 3530, 3520, 3525.5] }
      : item)
  };
  const superseded = model.mergeIndexSnapshot(merged, newerPoll);
  assert.equal(superseded.indices[0].latest, 3525.5, "11:17 HTTP poll supersedes 11:16:03 SSE push");
});

test("inMarketStreamWindow mirrors main process 09:15-11:35 / 12:55-15:05 trading-day stream window", () => {
  assert.equal(model.inMarketStreamWindow(Date.parse("2026-11-25T09:14:00+08:00")), false);
  assert.equal(model.inMarketStreamWindow(Date.parse("2026-11-25T09:15:00+08:00")), true);
  assert.equal(model.inMarketStreamWindow(Date.parse("2026-11-25T11:35:00+08:00")), true);
  assert.equal(model.inMarketStreamWindow(Date.parse("2026-11-25T11:36:00+08:00")), false);
  assert.equal(model.inMarketStreamWindow(Date.parse("2026-11-25T12:55:00+08:00")), true);
  assert.equal(model.inMarketStreamWindow(Date.parse("2026-11-25T15:05:00+08:00")), true);
  assert.equal(model.inMarketStreamWindow(Date.parse("2026-11-25T15:06:00+08:00")), false);
  assert.equal(model.inMarketStreamWindow(Date.parse("2026-11-28T10:00:00+08:00")), false, "Saturday closed");
  assert.equal(model.inMarketStreamWindow(Date.parse("2026-10-01T10:00:00+08:00")), false, "National Day closed");
});

test("IndexBoard schedules a single one-shot setTimeout to expire the live badge instead of a forever setInterval", () => {
  const prevWindow = global.window;
  const prevNow = Date.now;
  let now = 1_760_000_000_000;
  Date.now = () => now;
  const timeouts = [];
  let intervalCalls = 0;
  global.window = {
    setTimeout(fn, delay) { const id = timeouts.length + 1; timeouts.push({ id, fn, delay, cleared: false }); return id; },
    clearTimeout(id) { const item = timeouts.find(t => t.id === id); if (item) item.cleared = true; },
    setInterval() { intervalCalls += 1; return 1; },
    clearInterval() {}
  };
  try {
    const harness = createHookHarness(IndexBoard, {
      props: { snapshot: SNAPSHOT, state: "ready", today: "2026-11-25", tickAt: now - 5_000, onRetry: () => {} }
    });
    harness.render();
    assert.equal(intervalCalls, 0, "never starts a forever setInterval");
    assert.equal(timeouts.length, 1, "schedules exactly one timeout");
    assert.equal(timeouts[0].delay, 55_050);
    assert.match(text(harness.tree), /实时推送/);

    now += 55_050;
    timeouts[0].fn();
    harness.render();
    assert.doesNotMatch(text(harness.tree), /实时推送/, "badge clears after 60s expiry");
    assert.equal(timeouts.length, 1, "no further timers scheduled after expiry");
    harness.dispose();
  } finally {
    Date.now = prevNow;
    global.window = prevWindow;
  }
});

test("TodayCockpitView throttles failed getIndexBoard retries to 5m off-session and 60s in-session instead of 2s", async () => {
  const TodayCockpitView = require("./TodayCockpitView.tsx").default;
  const prevWindow = global.window;
  const prevDocument = global.document;
  const prevNow = Date.now;
  // 2026-11-25 (Wednesday, trading day) 20:00 Beijing (off-session)
  let now = Date.parse("2026-11-25T20:00:00+08:00");
  Date.now = () => now;
  const intervals = [];
  let indexCalls = 0;
  let shouldFail = true;
  global.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  global.window = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval(fn, delay) { const id = intervals.length + 1; intervals.push({ id, fn, delay, cleared: false }); return id; },
    clearInterval(id) { const item = intervals.find(entry => entry.id === id); if (item) item.cleared = true; },
    addEventListener() {},
    removeEventListener() {},
    stockApi: {
      getIndexBoard: async () => {
        indexCalls += 1;
        if (shouldFail) throw new Error("network down");
        return SNAPSHOT;
      },
      subscribeIndexStream: async () => ({}),
      onIndexTick: () => () => {}
    }
  };
  try {
    const harness = createHookHarness(TodayCockpitView, {
      props: {
        phase: { id: "closed", label: "休市", hint: "" },
        holdings: [],
        favorites: [],
        watchlist: [],
        limitUps: [],
        notesApi: { store: { notes: [], voice: false, systemNotify: false, aiAuto: false }, awaiting: [], addNote() {}, updateNote() {}, removeNote() {}, markDone() {} },
        tAssistant: { store: { items: [], trades: {} }, runtimes: {}, activeCode: null, setActiveCode() {}, addStock() {}, removeStock() {}, updateParams() {}, logTrade() {} },
        stockMonitors: { configs: {}, runtimes: {}, latestQuotes: {}, alerts: [] },
        paperSummary: { normalized: { cash: 100000, openPositions: [] }, equity: 100000, openValue: 0, openPnl: 0, openPnlPercent: 0, cumulativeRealizedPnl: 0, closedCount: 0, winCount: 0 },
        copilotAlerts: [],
        live: true,
        isDefaultView: false,
        onToggleDefaultView() {},
        onOpenStock() {},
        onNavigate() {}
      }
    });
    harness.render();
    await harness.flush();
    assert.equal(indexCalls, 1, "initial mount attempts getIndexBoard once");

    const fallback = intervals.find(entry => entry.delay === 2_000 && !entry.cleared);
    assert.ok(fallback, "2s fallback interval registered");

    // Off-session: advancing 10s must NOT retry after failure (throttled to 5 min)
    now += 10_000;
    fallback.fn();
    await harness.flush();
    assert.equal(indexCalls, 1, "off-session failed getIndexBoard does not spam every 2s");

    // Advancing past 5m retries once off-session
    now += 5 * 60_000;
    fallback.fn();
    await harness.flush();
    assert.equal(indexCalls, 2, "off-session retries after 5 minutes");

    // In-session (09:20 Beijing, inside marketStreamWindow): failed retry throttles to 60s
    now = Date.parse("2026-11-26T09:20:00+08:00");
    fallback.fn();
    await harness.flush();
    assert.equal(indexCalls, 3);
    now += 10_000;
    fallback.fn();
    await harness.flush();
    assert.equal(indexCalls, 3, "in-session failed getIndexBoard throttles to 60s instead of retrying at 10s");

    now += 55_000;
    shouldFail = false;
    fallback.fn();
    await harness.flush();
    assert.equal(indexCalls, 4, "in-session retries after 60s and recovers on success");
    harness.dispose();
  } finally {
    Date.now = prevNow;
    global.window = prevWindow;
    global.document = prevDocument;
  }
});

test("IndexBoard shows the live push badge with millisecond receive time while ticks arrive", () => {
  const html = renderToStaticMarkup(React.createElement(IndexBoard, { snapshot: SNAPSHOT, state: "ready", today: "2026-11-25", tickAt: Date.now() - 5_000, onRetry: () => {} }));
  assert.match(html, /实时推送 · 最后跳动/);
  // 一分钟以上没有新跳动：推送已断或已收盘，不再显示「实时推送」标识
  const quiet = renderToStaticMarkup(React.createElement(IndexBoard, { snapshot: SNAPSHOT, state: "ready", today: "2026-11-25", tickAt: Date.now() - 61_000, onRetry: () => {} }));
  assert.doesNotMatch(quiet, /实时推送/);
  const stale = renderToStaticMarkup(React.createElement(IndexBoard, { snapshot: SNAPSHOT, state: "ready", today: "2026-11-26", tickAt: Date.now(), onRetry: () => {} }));
  assert.doesNotMatch(stale, /实时推送/);
});
