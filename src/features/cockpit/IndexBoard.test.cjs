"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

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
  assert.equal(sh.time, "11:16");
  assert.deepEqual(sh.trend, [3548, 3530, 3520, 3515.01]);
  assert.equal(next.indices.find(item => item.code === "000688").latest, 1210.5);
  assert.equal(next.missing, undefined, "an index that starts ticking leaves the missing list");
  assert.equal(next.totals.up, 1300 + 1675);
  assert.equal(next.totals.amount, 3.3e11 + 3.92e11);
  assert.equal(model.applyIndexTick(base, { quotes: [{ code: "999999", latest: 1 }] }), base, "unknown codes change nothing");
  assert.equal(model.applyIndexTick(null, { quotes: [{ code: "000001", latest: 1 }] }), null);
  assert.equal(model.tickClock(Date.parse("2026-11-25T05:31:05.123Z")), "13:31:05.123");
});

test("IndexBoard shows the live push badge with millisecond receive time while ticks arrive", () => {
  const html = renderToStaticMarkup(React.createElement(IndexBoard, { snapshot: SNAPSHOT, state: "ready", today: "2026-11-25", tickAt: Date.parse("2026-11-25T05:31:05.123Z"), onRetry: () => {} }));
  assert.match(html, /实时推送 · 最后跳动 13:31:05\.123/);
  const stale = renderToStaticMarkup(React.createElement(IndexBoard, { snapshot: SNAPSHOT, state: "ready", today: "2026-11-26", tickAt: Date.now(), onRetry: () => {} }));
  assert.doesNotMatch(stale, /实时推送/);
});
