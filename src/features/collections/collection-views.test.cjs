"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

const previousCssLoader = require.extensions[".css"];
require.extensions[".css"] = () => {};
const restoreTypeScript = registerTypeScript();
const { FavoritesView, HoldingsView, WatchlistView } = require("./CollectionViews.tsx");
const { initialSettings } = require("../../domain/settings.ts");

const noop = () => {};

test("favorites feature retains monitor status, stock actions, and alert content", () => {
  const markup = renderToStaticMarkup(React.createElement(FavoritesView, {
    items: [{ code: "600519", name: "贵州茅台", thscode: "600519.SH", createdAt: "2026-10-17T00:00:00.000Z" }],
    monitors: {
      configs: {}, runtimes: {}, latestQuotes: {}, refreshing: false, storageError: "", save: noop,
      alerts: [{ id: "alert-1", name: "贵州茅台", code: "600519", triggeredAt: "2026-10-17T00:00:00.000Z", detail: "涨幅达到提醒阈值" }]
    },
    live: false,
    onOpen: noop,
    onRemove: noop
  }));

  for (const marker of ["自选监控", "贵州茅台", "设置条件", "最近提醒"]) {
    assert.ok(markup.includes(marker), `missing favorites marker: ${marker}`);
  }
});

test("holdings feature retains summary, entry form, table, and empty state", () => {
  const markup = renderToStaticMarkup(React.createElement(HoldingsView, {
    items: [],
    settings: initialSettings,
    live: false,
    onSave: async () => true,
    onOpen: noop
  }));

  for (const marker of ["持仓总览", "持仓市值", "录入或更新持仓", "保存持仓", "持仓明细", "还没有录入持仓"]) {
    assert.ok(markup.includes(marker), `missing holdings marker: ${marker}`);
  }
});

test("watchlist feature retains node filters and stock rows; the ladder lives on the limit-up monitor", () => {
  const markup = renderToStaticMarkup(React.createElement(WatchlistView, {
    items: [{ code: "600519", name: "贵州茅台", thscode: "600519.SH", createdAt: "2026-10-17T00:00:00.000Z", observationNode: "T+1", limitDate: "2026-10-16" }],
    activeNode: "all",
    onNodeChange: noop,
    onOpen: noop,
    onRemove: noop
  }));

  for (const marker of ["十日观察池", "全部十日", "T+10", "贵州茅台"]) {
    assert.ok(markup.includes(marker), `missing watchlist marker: ${marker}`);
  }
  assert.equal(markup.includes("连板梯队"), false, "连板梯队已移到涨停监控，观察池只保留观察表");
});


test("observation filtering exposes visible coverage and links the trading-day explanation to the table", () => {
  const items = [
    { code: "600001", name: "第一只", observationNode: "T+1", limitDate: "2026-10-23", consecutiveBoards: 2 },
    { code: "600002", name: "第二只", observationNode: "T+1", limitDate: "2026-10-23" },
    { code: "600003", name: "第三只", observationNode: "T+2", limitDate: "2026-10-22" }
  ];
  const markup = renderToStaticMarkup(React.createElement(WatchlistView, { items, activeNode: "T+1", onNodeChange: noop, onOpen: noop, onRemove: noop }));
  const describedBy = markup.match(/<table[^>]*aria-describedby="([^"]+)"/);
  assert.ok(describedBy, "the table must expose the meaning of T+n and historical board counts");
  const description = markup.match(new RegExp('<p[^>]*id="'+describedBy[1]+'"[^>]*>([\\s\\S]*?)</p>'));
  assert.ok(description, "the linked explanation is visible alongside the table");
  assert.match(description[1], /2.*3.*T\+1.*交易日.*连板.*涨停日/);
  assert.equal((markup.match(/class="watch-row-number"/g) || []).length, 2);
  assert.doesNotMatch(markup, /第三只<\/strong>/);
});

test("watchlist renders sortable quote columns and a quote status line", () => {
  const items = [
    { code: "300059", name: "东方财富", thscode: "300059.SZ", observationNode: "T+1", limitDate: "2026-11-19" },
    { code: "600001", name: "停牌股", thscode: "600001.SH", observationNode: "T+1", limitDate: "2026-11-19" }
  ];
  const markup = renderToStaticMarkup(React.createElement(WatchlistView, {
    items,
    activeNode: "all",
    quotes: { "300059": { latest: 22.5, changePct: 3.21 }, "600001": { latest: 11, changePct: 0, tradeStatus: "suspended" } },
    onNodeChange: noop,
    onOpen: noop,
    onRemove: noop
  }));
  assert.match(markup, /aria-sort="none"/, "未排序列仍给出 aria-sort");
  assert.match(markup, /watch-sort-btn/, "现价与涨跌幅表头是可点击的排序按钮");
  const status = markup.match(/<p[^>]*class="watch-quote-status"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(status, "行情状态行紧贴在说明文字下方");
  assert.match(status[1], /行情 2\/2 只/);
  assert.match(status[1], /上涨 1 · 下跌 0 · 平 1 · 涨停 0/);
  assert.match(markup, /停牌/);
});

test("holdings view exposes entry mode tabs, stop-loss banner, and privacy mask mode", () => {
  const markup = renderToStaticMarkup(React.createElement(HoldingsView, {
    items: [{ code: "600519", name: "贵州茅台", secid: "1.600519", shares: 300, costPrice: 1450, createdAt: "", updatedAt: "" }],
    settings: initialSettings,
    live: false,
    privacyMask: true,
    monitors: { configs: {}, runtimes: {}, latestQuotes: {}, alerts: [], refreshing: false, storageError: "", save: noop, remove: noop },
    onTransferToT: noop,
    onSave: async () => true,
    onOpen: noop
  }));

  for (const marker of ["加减仓记账", "粘贴批量导入", "一键加 -5% 止损", "转做T", "*** 股", "未设止损预警"]) {
    assert.ok(markup.includes(marker), `missing enhanced holdings marker: ${marker}`);
  }
  assert.equal(markup.includes("300 股"), false, "privacyMask should mask share count");
});

test("HoldingsView preserves and clamps sellableShares on edit and batch-clears holding alerts via clearAlerts(codes)", async () => {
  const { createHookHarness, find, walk, text } = require("../../../qa/research-hook-harness.cjs");
  const prevWindow = global.window;
  const savedSnapshots = [];
  const clearAlertsCalls = [];
  const ackAlertCalls = [];
  let currentItems = [
    { code: "600519", name: "贵州茅台", secid: "1.600519", shares: 500, sellableShares: 300, costPrice: 1450, note: "底仓", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
  ];
  global.window = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    removeEventListener() {},
    stockApi: {
      search: async (q) => q === "600519" ? [{ code: "600519", name: "贵州茅台", secid: "1.600519" }] : [],
      getQuoteSnapshot: async () => ({ quote: { latest: 1500, preClose: 1480, changePct: 1.35 }, updatedAt: "2026-11-22T02:00:00.000Z" })
    }
  };
  try {
    const harness = createHookHarness(() => HoldingsView({
      items: currentItems,
      settings: initialSettings,
      live: false,
      monitors: {
        configs: {},
        runtimes: {},
        latestQuotes: {},
        refreshing: false,
        storageError: "",
        save: () => true,
        remove: () => true,
        alerts: [
          { id: "a1", code: "600519", name: "贵州茅台", triggeredAt: "2026-11-22T02:00:00.000Z", detail: "跌破止损" },
          { id: "a2", code: "600519", name: "贵州茅台", triggeredAt: "2026-11-22T02:05:00.000Z", detail: "涨超 3%" },
          { id: "a3", code: "000001", name: "平安银行", triggeredAt: "2026-11-22T02:06:00.000Z", detail: "非持仓预警" }
        ],
        ackAlert: (id) => ackAlertCalls.push(id),
        clearAlerts: (codes) => clearAlertsCalls.push(codes)
      },
      onSave: async (updater) => {
        currentItems = updater(currentItems);
        savedSnapshots.push(currentItems);
        return true;
      },
      onOpen: noop
    }), { runEffects: false });
    harness.render();

    // 1. Batch clear holding alerts must use clearAlerts([...holdingCodeSet]) once instead of N ackAlert calls
    const clearBtn = find(harness.tree, n => n.type === "button" && /清空持仓预警/.test(text(n)));
    assert.ok(clearBtn, "should render clear holding alerts button");
    clearBtn.props.onClick();
    assert.deepEqual(clearAlertsCalls, [["600519"]]);
    assert.deepEqual(ackAlertCalls, []);

    // 2. Editing cost/note must preserve sellableShares (300)
    const editBtn = find(harness.tree, n => n.type === "button" && text(n).trim() === "编辑");
    editBtn.props.onClick();
    harness.render();
    const formInputs = walk(harness.tree).filter(n => n.type === "input");
    const costInput = formInputs.find(n => String(n.props.value) === "1450");
    assert.ok(costInput, "cost input should be populated");
    costInput.props.onChange({ target: { value: "1460" } });
    harness.render();
    const form = find(harness.tree, n => n.type === "form");
    await form.props.onSubmit({ preventDefault() {} });
    assert.equal(savedSnapshots.length, 1);
    assert.equal(savedSnapshots[0][0].costPrice, 1460);
    assert.equal(savedSnapshots[0][0].sellableShares, 300, "editing cost must preserve sellableShares");

    // 3. Reducing shares below sellableShares must clamp sellableShares to new shares
    harness.render();
    const editBtn2 = find(harness.tree, n => n.type === "button" && text(n).trim() === "编辑");
    editBtn2.props.onClick();
    harness.render();
    const sharesInput = walk(harness.tree).find(n => n.type === "input" && String(n.props.value) === "500");
    assert.ok(sharesInput, "shares input should be populated");
    sharesInput.props.onChange({ target: { value: "200" } });
    harness.render();
    const form2 = find(harness.tree, n => n.type === "form");
    await form2.props.onSubmit({ preventDefault() {} });
    assert.equal(savedSnapshots.length, 2);
    assert.equal(savedSnapshots[1][0].shares, 200);
    assert.equal(savedSnapshots[1][0].sellableShares, 200, "reducing shares must clamp sellableShares");

    harness.dispose();
  } finally {
    if (prevWindow === undefined) delete global.window;
    else global.window = prevWindow;
  }
});

after(() => {
  restoreTypeScript?.();
  if (previousCssLoader) require.extensions[".css"] = previousCssLoader;
  else delete require.extensions[".css"];
});
