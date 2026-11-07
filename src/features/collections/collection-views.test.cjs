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

  for (const marker of ["自选板块", "贵州茅台", "设置条件", "最近提醒"]) {
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

after(() => {
  restoreTypeScript?.();
  if (previousCssLoader) require.extensions[".css"] = previousCssLoader;
  else delete require.extensions[".css"];
});
