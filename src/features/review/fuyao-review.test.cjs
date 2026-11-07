"use strict";
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const restore = registerTypeScript();
after(() => restore?.());
const FuyaoReviewSection = require("./FuyaoReviewSection.tsx").default;

const stock = (code, name) => ({ code, name, thscode: `${code}.SH` });

test("without a key the review shows one line on how to enable Fuyao data", () => {
  const html = renderToStaticMarkup(React.createElement(FuyaoReviewSection, { data: { available: false, reason: "未配置同花顺扶摇 API Key" }, onOpenStock() {} }));
  assert.match(html, /同花顺扶摇数据（连板天梯、涨停原因、热股榜、龙虎榜、异动解读）：未配置同花顺扶摇 API Key/);
});

test("the review renders seal rate, ladder, reasons, hot list, dragon-tiger and anomaly cards; missing blocks are skipped", () => {
  const html = renderToStaticMarkup(React.createElement(FuyaoReviewSection, { onOpenStock() {}, data: {
    available: true, source: "同花顺扶摇官方数据接口", fetchedAt: "2026-10-23T07:00:00Z", sealRate: 0.68, warnings: ["跌停池暂不可用：HTTP 500"],
    limitUp: { count: 2, maxBoards: 3, boardCounts: [{ level: 1, label: "首板", count: 1 }], reasons: [{ reason: "机器人", count: 2, stocks: [stock("600001", "甲")] }], leaders: [{ ...stock("600001", "甲"), boards: 3, boardsText: "3连板" }] },
    limitBreak: { count: 1, top: [] }, limitDown: null,
    ladder: { days: [{ date: "2026-10-22", tiers: [{ level: 3, label: "3板", stocks: [{ ...stock("600001", "甲"), boards: 3, nextDay: null }] }] }] },
    hot: [{ ...stock("600001", "甲"), rank: 1, heat: 99, rankChange: 2 }], skyrocket: [],
    dragonTiger: { date: "2026-10-22", count: 1, topNet: [{ ...stock("600002", "乙"), changePct: 9.98, net: 1.2e8, orgNet: null, hotMoneyNet: null }], desks: [] },
    anomalies: [{ ...stock("600001", "甲"), tag: "涨停", content: "原因说明", keywords: ["机器人"] }]
  } }));
  for (const marker of ["封板率", "68.0%", "3板", "涨停原因", "机器人", "同花顺热榜", "↑2", "龙虎榜净买入", "异动解读", "原因说明", "跌停池暂不可用", "炸板 1 · 跌停 --"]) {
    assert.ok(html.includes(marker), `missing ${marker}`);
  }
});

test("the THS hot list has 1-hour and 24-hour tabs with hot and skyrocket lists, price change and heat", () => {
  const row = (code, name, rank, extra = {}) => ({ ...stock(code, name), rank, heat: 120000, heatText: "12.0万", rankChange: 3, latest: 10.5, changePct: 2.5, ...extra });
  const data = { available: true, hotLists: { hour: { hot: [row("600001", "一小时甲", 1)], skyrocket: [row("600003", "飙升丙", 1, { rankChange: -4 })] },
    day: { hot: [row("600002", "全天乙", 1)], skyrocket: [] } } };
  const html = renderToStaticMarkup(React.createElement(FuyaoReviewSection, { onOpenStock() {}, data }));
  for (const marker of ["同花顺热榜", "1小时", "24小时", "热股榜", "飙升榜", "一小时甲", "+2.50%", "12.0万", "↑3", "10.50"]) assert.ok(html.includes(marker), `missing ${marker}`);
  assert.ok(!html.includes("全天乙"), "the 1-hour tab is shown first, like THS");
  const legacy = renderToStaticMarkup(React.createElement(FuyaoReviewSection, { onOpenStock() {}, data: { available: true, hot: [row("600009", "旧数据", 1)] } }));
  assert.ok(legacy.includes("旧数据") && legacy.includes("24小时热股榜"), "older payloads still show as the 24-hour list");
});

test("on the limit-up monitor the ecology blocks are laid out as one row of names, folded until one is opened", () => {
  const data = {
    available: true, source: "同花顺扶摇官方数据接口", fetchedAt: "2026-10-23T07:00:00Z", sealRate: 0.68,
    limitUp: { count: 2, maxBoards: 3, boardCounts: [], reasons: [{ reason: "机器人", count: 2, stocks: [stock("600001", "甲")] }], leaders: [] },
    ladder: { days: [{ date: "2026-10-22", tiers: [{ level: 3, label: "3板", stocks: [{ ...stock("600001", "甲"), boards: 3, nextDay: null }] }] }] },
    hot: [{ ...stock("600001", "甲"), rank: 1, heat: 99, rankChange: 2 }],
    dragonTiger: { date: "2026-10-22", count: 5, topNet: [{ ...stock("600002", "乙"), changePct: 9.98, net: 1.2e8, orgNet: null, hotMoneyNet: null }], desks: [] },
    anomalies: [{ ...stock("600001", "甲"), tag: "涨停", content: "原因说明", keywords: [] }]
  };
  const html = renderToStaticMarkup(React.createElement(FuyaoReviewSection, { onOpenStock() {}, data, layout: "tabs", extra: React.createElement("div", { className: "ai-interpret" }, "AI 解读内容") }));
  const tabs = [...html.matchAll(/role="tab"[^>]*>.*?<span>([^<]+)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(tabs, ["涨停结构", "连板天梯", "涨停原因", "同花顺热榜", "龙虎榜", "异动解读", "AI 解读"]);
  assert.match(html, /最高 3 板/); assert.match(html, /5 条/);
  assert.equal(html.includes("role=\"tabpanel\""), false, "nothing is expanded until a name is clicked");
  assert.equal(html.includes("原因说明") || html.includes("AI 解读内容"), false);
});
