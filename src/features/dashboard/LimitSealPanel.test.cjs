"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const { createHookHarness, walk } = require("../../../qa/research-hook-harness.cjs");

let restoreTypeScript;
let LimitSealView;
let model;
let useLimitSeals;
let isSealWatchRelevant;
let LimitUpPool;

before(() => {
  restoreTypeScript = registerTypeScript();
  LimitSealView = require("./LimitSealPanel.tsx").LimitSealView;
  model = require("./limitSealModel.ts");
  useLimitSeals = require("./useLimitSeals.ts").useLimitSeals;
  isSealWatchRelevant = require("../market/MarketWorkspace.tsx").isSealWatchRelevant;
  LimitUpPool = require("./LimitUpPool.tsx").default;
});

after(() => restoreTypeScript?.());

const record = (extra = {}) => ({
  code: "002565", name: "顺灏股份", latest: 8.43, changePct: 10.05, high: 8.43, limitUp: 8.43, limitDown: 6.9, floatMarketCap: 8.94e9,
  status: "sealed", statusLabel: "封死涨停", sealLots: 776288, sealAmount: 776288 * 843, sealFloatRatio: (776288 * 843) / 8.94e9,
  peakAmount: 8e8, fromPeakPct: -18.2, change1mAmount: -1.2e7, change1mPct: -1.8,
  bids: [{ price: 8.43, volumeLots: 776288 }, { price: 8.42, volumeLots: 1943 }], asks: [], source: "同花顺涨停池（封单）+ 腾讯实时五档",
  quoteAt: "2026-11-26T02:37:09.000Z", quoteDate: "2026-11-26",
  history: [{ t: 1, amount: 8e8, status: "sealed" }, { t: 2, amount: 6.6e8, status: "sealed" }],
  ...extra
});

test("seal amounts, lots and warnings read like a trading terminal", () => {
  assert.equal(model.formatSealAmount(6.544e8), "6.54亿");
  assert.equal(model.formatSealAmount(1.89e7), "1,890万");
  assert.equal(model.formatSealAmount(null), "--");
  assert.equal(model.formatLots(776288), "77.6万手");
  assert.equal(model.formatLots(24833), "2.48万手");
  assert.equal(model.formatLots(820), "820手");
  assert.equal(model.sealTone("sealed"), "up");
  assert.equal(model.sealTone("broken"), "warn");
  assert.match(model.sealWarning(record({ change1mPct: -35 })), /1 分钟内减少 35%/);
  assert.match(model.sealWarning(record({ fromPeakPct: -60 })), /较今日峰值回落 60%/);
  assert.match(model.sealWarning(record({ status: "broken" })), /已炸板/);
  assert.equal(model.sealWarning(record()), "");
});

test("ticks merge into the table, keep history from the first read and append new points", () => {
  const first = model.mergeSealTick({}, [record()]);
  assert.equal(first["002565"].history.length, 2);
  const next = model.mergeSealTick(first, [record({ history: undefined, sealLots: 700000, point: { t: 3, amount: 5.9e8, status: "sealed" } })]);
  assert.equal(next["002565"].sealLots, 700000);
  assert.deepEqual(next["002565"].history.map(point => point.t), [1, 2, 3]);
  const same = model.mergeSealTick(next, [record({ history: undefined, point: { t: 3, amount: 5.9e8, status: "sealed" } })]);
  assert.equal(same["002565"].history.length, 3, "the same point is not appended twice");
  assert.equal(model.mergeSealTick(next, []), next);
  assert.ok(model.sealSparkline(next["002565"].history));
  assert.equal(model.sealSparkline([{ t: 1, amount: 1, status: "sealed" }]), null);

  // Fresh subscription without pre-existing history still builds sparkline points and resets across trading days.
  const cold1 = model.mergeSealTick({}, [record({ history: undefined, quoteDate: "2026-11-26", point: { t: 10, amount: 8e8, status: "sealed" } })]);
  assert.equal(cold1["002565"].history.length, 1);
  const cold2 = model.mergeSealTick(cold1, [record({ history: undefined, quoteDate: "2026-11-26", point: { t: 20, amount: 7e8, status: "sealed" } })]);
  assert.deepEqual(cold2["002565"].history.map(p => p.t), [10, 20]);
  assert.ok(model.sealSparkline(cold2["002565"].history), "cold-start detail stock draws sparkline once 2 ticks arrive");
  const nextDay = model.mergeSealTick(cold2, [record({ history: undefined, quoteDate: "2026-11-27", point: { t: 30, amount: 6e8, status: "sealed" } })]);
  assert.deepEqual(nextDay["002565"].history.map(p => p.t), [30], "cross-day tick resets prior day history");

  // Shared bid/ask depth scale: tiny ask1 next to huge bid1 renders narrow bar instead of 100%.
  const contestedHtml = renderToStaticMarkup(React.createElement(LimitSealView, {
    record: record({
      status: "contested",
      statusLabel: "涨停有抛压",
      bids: [{ price: 8.43, volumeLots: 100000 }],
      asks: [{ price: 8.43, volumeLots: 100 }]
    }),
    lastTickAt: Date.now()
  }));
  assert.match(contestedHtml, /seal-book-ask[^>]*>.*?width:2%/, "tiny ask bar shares bid max scale (clamped to 2% min width)");
});

test("the seal panel shows amount, lots, ratio, change, peak, the live clock and the order book with the limit row marked", () => {
  const html = renderToStaticMarkup(React.createElement(LimitSealView, { record: record(), lastTickAt: Date.now() }));
  for (const text of ["实时涨停封单", "封死涨停", "6.54亿", "77.6万手 @ 8.43", "封单/流通市值", "7.32%", "1 分钟变化", "-1,200万", "今日峰值", "8.00亿", "回落 18%", "同花顺涨停池（封单）+ 腾讯实时五档 · 行情时间 10:37:09", "封单额走势"]) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /seal-book-bid at-limit/);
  assert.match(html, /776,288/);
  const broken = renderToStaticMarkup(React.createElement(LimitSealView, { record: record({ status: "broken", statusLabel: "炸板", sealLots: null, sealAmount: null, sealFloatRatio: null, asks: [{ price: 8.2, volumeLots: 300 }] }), lastTickAt: 0 }));
  assert.match(broken, /炸板/);
  assert.match(broken, /已炸板：今天摸过涨停、现在打开/);
  assert.match(broken, /<strong>--<\/strong>/, "no seal is shown as --, never 0");
});

test("useLimitSeals clears stale records immediately on disable/empty/empty-snapshot and keeps fresher live ticks over slower snapshot", async () => {
  const prevWindow = global.window;
  const prevDocument = global.document;
  let tickHandler = null;
  const pendingSub = [];
  const subCalls = [];
  global.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  global.window = {
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    stockApi: {
      onLimitSealTick(fn) { tickHandler = fn; return () => { if (tickHandler === fn) tickHandler = null; }; },
      subscribeLimitSeals(input) {
        subCalls.push(input);
        if (input.active === false) return Promise.resolve();
        return new Promise(resolve => pendingSub.push({ input, resolve }));
      }
    }
  };
  try {
    let currentProps = { codes: ["002565"], opts: { owner: "detail", enabled: true, withHistory: true } };
    const harness = createHookHarness(() => useLimitSeals(currentProps.codes, currentProps.opts));
    harness.render();
    assert.equal(subCalls[0].codes[0], "002565");
    // Live tick arrives BEFORE initial subscribeLimitSeals resolves
    tickHandler({ atMs: Date.now(), items: [record({ sealLots: 900000, history: undefined, point: { t: 3, amount: 7.58e8, status: "sealed" } })] });
    harness.render();
    assert.equal(harness.tree.records["002565"].sealLots, 900000);

    // Slower initial snapshot resolves with older sealLots=776288 + history [t:1, t:2]: must keep live sealLots=900000 and backfill history!
    pendingSub.shift().resolve({ items: [record({ sealLots: 776288, history: [{ t: 1, amount: 8e8, status: "sealed" }, { t: 2, amount: 6.6e8, status: "sealed" }] })] });
    await harness.flush();
    assert.equal(harness.tree.records["002565"].sealLots, 900000, "slower initial snapshot does not overwrite fresher live tick");
    assert.deepEqual(harness.tree.records["002565"].history.map(p => p.t), [1, 2, 3], "earlier same-day snapshot history backfills before live point");

    // Disabling immediately clears stale records synchronously
    currentProps = { codes: ["002565"], opts: { owner: "detail", enabled: false, withHistory: true } };
    harness.render();
    harness.render();
    assert.deepEqual(harness.tree.records, {}, "disabling clears stale seal records");

    // Re-enabling on another stock with empty initial snapshot keeps records empty (no stale leak)
    currentProps = { codes: ["600519"], opts: { owner: "detail", enabled: true, withHistory: true } };
    harness.render();
    pendingSub.shift().resolve({ items: [] });
    await harness.flush();
    assert.deepEqual(harness.tree.records, {});

    // Switching back to 002565 after it was sealed, then receiving empty initial snapshot clears any remaining entry
    currentProps = { codes: ["002565"], opts: { owner: "detail", enabled: true, withHistory: true } };
    harness.render();
    pendingSub.shift().resolve({ items: [record()] });
    await harness.flush();
    assert.ok(harness.tree.records["002565"]);
    currentProps = { codes: ["002565"], opts: { owner: "detail-2", enabled: true, withHistory: true } };
    harness.render();
    pendingSub.shift().resolve({ items: [] });
    await harness.flush();
    assert.deepEqual(harness.tree.records, {}, "empty initial snapshot clears stale code");

    harness.dispose();
  } finally {
    global.window = prevWindow;
    global.document = prevDocument;
  }
});

test("LimitSealView schedules one single-shot timeout to clear the live green dot after 60s", () => {
  const prevWindow = global.window;
  const prevNow = Date.now;
  let now = 1_760_000_000_000;
  Date.now = () => now;
  const timeouts = [];
  global.window = {
    setTimeout(fn, delay) { const id = timeouts.length + 1; timeouts.push({ id, fn, delay }); return id; },
    clearTimeout() {}
  };
  try {
    const harness = createHookHarness(LimitSealView, { props: { record: record(), lastTickAt: now - 10_000 } });
    harness.render();
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].delay, 50_050);
    assert.ok(walk(harness.tree).some(node => node.props?.className === "seal-live"));

    now += 50_050;
    timeouts[0].fn();
    harness.render();
    assert.equal(walk(harness.tree).some(node => node.props?.className === "seal-live"), false, "live dot turns off after 60s");
    assert.equal(timeouts.length, 1, "no recurring timer scheduled");
    harness.dispose();
  } finally {
    Date.now = prevNow;
    global.window = prevWindow;
  }
});

test("isSealWatchRelevant ignores zero quotes, fixes IEEE-754 half-up limit bounds, prefers explicit limits and falls back to security.name", () => {
  // Zero low / latest during pre-open or halt must NOT subscribe
  assert.equal(
    isSealWatchRelevant({ code: "600519", name: "贵州茅台", preClose: 1500, high: 0, low: 0, latest: 0 }, { code: "600519", name: "贵州茅台" }),
    false
  );
  // IEEE-754 boundary: preClose = 9.35, rate = 10% -> exchange downLimit is 8.42 (not 8.41), upLimit is 10.29
  assert.equal(
    isSealWatchRelevant({ code: "000001", name: "平安银行", preClose: 9.35, high: 9.2, low: 8.42, latest: 8.42 }, { code: "000001", name: "平安银行" }),
    true
  );
  assert.equal(
    isSealWatchRelevant({ code: "000001", name: "平安银行", preClose: 9.35, high: 10.29, low: 9.4, latest: 10.29 }, { code: "000001", name: "平安银行" }),
    true
  );
  assert.equal(
    isSealWatchRelevant({ code: "000001", name: "平安银行", preClose: 9.35, high: 9.5, low: 8.45, latest: 9.1 }, { code: "000001", name: "平安银行" }),
    false
  );
  // Explicit positive limitDown overrides computed formula
  assert.equal(
    isSealWatchRelevant({ code: "000001", name: "平安银行", preClose: 9.35, high: 9.2, low: 8.5, latest: 8.5, limitDown: 8.5 }, { code: "000001", name: "平安银行" }),
    true
  );
  // Falls back to security.name when quote.name is empty (N-prefix IPO has no price limit -> false)
  assert.equal(
    isSealWatchRelevant({ code: "603999", name: "", preClose: 10, high: 15, low: 9, latest: 14 }, { code: "603999", name: "N新股" }),
    false
  );
});

test("LimitUpPool respects live={false} and does not subscribe to pool limit seals when paused", () => {
  const prevWindow = global.window;
  const prevDocument = global.document;
  const prevResizeObserver = global.ResizeObserver;
  const prevLayoutEffect = React.useLayoutEffect;
  React.useLayoutEffect = (...args) => React.useEffect(...args);
  let subCalls = 0;
  global.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.window = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    stockApi: {
      onLimitSealTick: () => () => {},
      subscribeLimitSeals: async input => { if (input.active !== false) subCalls += 1; return { items: [] }; }
    }
  };
  try {
    const Component = LimitUpPool.type || LimitUpPool;
    const paused = createHookHarness(Component, {
      props: {
        items: [{ code: "002565", name: "顺灏股份", secid: "0.002565", latest: 8.43, changePct: 10.05, consecutiveBoards: 1 }],
        live: false,
        onOpen() {},
        onAdd() {}
      }
    });
    paused.render();
    assert.equal(subCalls, 0, "live={false} disables pool seal subscription");
    paused.dispose();

    const active = createHookHarness(Component, {
      props: {
        items: [{ code: "002565", name: "顺灏股份", secid: "0.002565", latest: 8.43, changePct: 10.05, consecutiveBoards: 1 }],
        live: true,
        onOpen() {},
        onAdd() {}
      }
    });
    active.render();
    assert.equal(subCalls, 1, "live={true} subscribes pool seals");
    active.dispose();
  } finally {
    React.useLayoutEffect = prevLayoutEffect;
    global.window = prevWindow;
    global.document = prevDocument;
    global.ResizeObserver = prevResizeObserver;
  }
});
