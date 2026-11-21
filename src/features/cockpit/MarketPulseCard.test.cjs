"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let restoreTypeScript;
let MarketPulseCard;
let buildMarketPulse;

before(() => {
  restoreTypeScript = registerTypeScript();
  MarketPulseCard = require("./MarketPulseCard.tsx").default;
  buildMarketPulse = require("./cockpitModel.ts").buildMarketPulse;
});

after(() => restoreTypeScript?.());

const noop = () => {};
const REAL_REVIEW = {
  date: "2026-11-20",
  session: "收盘复盘",
  generatedAt: "2026-11-20T07:10:00.000Z",
  regime: { id: "retreat", name: "退潮防守", tone: "defense", posture: "现金优先，等待风险释放" },
  decision: { status: "blocked", headline: "今天大盘偏弱，先别开新仓" },
  market: { available: true, upCount: 313, downCount: 5236, flatCount: 23, breadth: 0.056, averageReturn: -4.76 },
  ecology: { available: true, limitUpCount: 28, limitDownCount: 58, failedRate: 0.2, maxHeight: 4 },
  emotion: { limitUpCount: 28, limitDownCount: 58, state: "情绪退潮" },
  indices: [{ name: "上证指数", close: 3533.79, returns: { r1: -1.2251 }, trend: "偏弱", available: true }],
  focusSectors: [{ name: "保险", leaderName: "中国太保" }],
  riskSignals: ["上涨广度不足45%，赚钱效应偏弱"]
};

test("MarketPulseCard renders a real review pulse with counts, indices and actions", () => {
  const html = renderToStaticMarkup(React.createElement(MarketPulseCard, {
    pulse: buildMarketPulse(REAL_REVIEW),
    state: "ready",
    onRetry: noop,
    onOpenReview: noop,
    onAskAi: noop
  }));
  for (const marker of ["今日大盘", "退潮防守", "今天大盘偏弱，先别开新仓", "现金优先，等待风险释放",
    "上涨 313 家", "下跌 5236 家", "涨停 28 · 跌停 58", "炸板率 20%", "最高 4 板",
    "上证指数", "3533.79", "-1.23%", "要留意：上涨广度不足45%，赚钱效应偏弱", "较强方向：保险（中国太保）",
    "看完整复盘", "问 AI 怎么看大盘", "数据 2026-11-20 收盘复盘"]) {
    assert.ok(html.includes(marker), `missing marker: ${marker}`);
  }
  assert.match(html, /role="img" aria-label="上涨 313 家，下跌 5236 家"/);
});

test("MarketPulseCard shows loading and error fallbacks without a pulse", () => {
  const loading = renderToStaticMarkup(React.createElement(MarketPulseCard, { pulse: null, state: "loading", onRetry: noop, onOpenReview: noop }));
  assert.match(loading, /正在读取今天的大盘数据…/);
  const error = renderToStaticMarkup(React.createElement(MarketPulseCard, { pulse: null, state: "error", onRetry: noop, onOpenReview: noop }));
  assert.match(error, /大盘数据暂时没取到/);
  assert.match(error, /重试/);
});

test("MarketPulseCard marks partial data and keeps an older pulse on error", () => {
  const partial = buildMarketPulse({ regime: { name: "测试", tone: "neutral", posture: "观望" }, market: { available: false } });
  const html = renderToStaticMarkup(React.createElement(MarketPulseCard, { pulse: partial, state: "error", onRetry: noop, onOpenReview: noop }));
  assert.equal((html.match(/暂未取到/g) || []).length >= 2, true, "缺数据的区块显示暂未取到");
  assert.match(html, /测试：观望/);
  const provisional = renderToStaticMarkup(React.createElement(MarketPulseCard, {
    pulse: buildMarketPulse({ ...REAL_REVIEW, decision: { status: "watch" } }),
    state: "ready", onRetry: noop, onOpenReview: noop
  }));
  assert.match(provisional, /盘中暂看「退潮防守」/);
  assert.match(provisional, /15:00 收盘后给出正式结论/);
});

test("MarketPulseCard labels yesterday's pulse as 上个交易日 without the session word", () => {
  const pulse = buildMarketPulse(REAL_REVIEW, "2026-11-21");
  const html = renderToStaticMarkup(React.createElement(MarketPulseCard, {
    pulse, state: "ready", onRetry: noop, onOpenReview: noop
  }));
  assert.match(html, /上个交易日 2026-11-20 收盘数据/);
  assert.match(html, /开盘后自动换成今天的/);
  assert.match(html, /上个交易日大盘偏弱/);
  assert.equal(html.includes("收盘复盘"), false);
});
