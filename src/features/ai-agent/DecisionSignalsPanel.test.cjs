"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const { createHookHarness, find } = require("../../../qa/research-hook-harness.cjs");

let restoreTypeScript;
let panel;
let model;
before(() => { restoreTypeScript = registerTypeScript(); panel = require("./DecisionSignalsPanel.tsx"); model = require("./decisionSignalModel.ts"); });
after(() => restoreTypeScript?.());

const summary = extra => ({ total: 0, completed: 0, hit: 0, miss: 0, neutral: 0, unable: 0, enough: false, minSample: 10, hitRatePct: null, avgReturnPct: null, maxAdversePct: null, ...extra });
const signal = extra => ({
  id: "s1", code: "600519", name: "贵州茅台", assetType: "stock", status: "active", createdAt: "2026-11-20T02:00:00.000Z", updatedAt: "2026-11-20T02:00:00.000Z", expiresAt: "2026-11-28T02:00:00.000Z",
  action: "buy", horizon: "5d", entryLow: 1450, entryHigh: 1470, stopLoss: 1400, targetPrice: 1560, invalidation: "跌破 1400", watch: ["放量过 1480"], reason: "回踩企稳", guardrail: "",
  stance: "偏多", confidence: "中", referencePrice: 1466.5, source: { conversationId: "c", messageId: "", model: "m", skills: [] },
  outcomes: { 1: { status: "done", verdict: "hit", returnPct: 2.1, maxAdversePct: 0.4, stopHit: false, targetHit: false, endDate: "2026-11-23", endClose: 1497, startPrice: 1466.5 }, 3: { status: "done", verdict: "miss", returnPct: -5, maxAdversePct: 5, stopHit: true, targetHit: false, endDate: "2026-11-25", endClose: 1393, startPrice: 1466.5 } },
  feedback: "useful", ...extra
});

test("plan and outcome text read plainly; thin samples never show a hit rate", () => {
  assert.equal(model.planText(signal()), "入场 1450–1470 · 止损 1400 · 目标 1560");
  assert.equal(model.planText({ entryLow: null, entryHigh: null, stopLoss: null, targetPrice: null }), "");
  assert.deepEqual(model.outcomeText(signal().outcomes[1]), { text: "对 +2.1%", tone: "good" });
  assert.deepEqual(model.outcomeText(signal().outcomes[3]), { text: "破止损 -5.0%", tone: "bad" });
  assert.deepEqual(model.outcomeText(undefined), { text: "待评", tone: "muted" });
  assert.deepEqual(model.outcomeText({ status: "unable", reason: "x" }), { text: "不评", tone: "muted" });
  assert.match(model.summaryText(summary({ completed: 4 })), /已评 4 条，不足 10 条，暂不给命中率/);
  assert.match(model.summaryText(summary({ completed: 12, enough: true, hit: 7, miss: 3, neutral: 2, hitRatePct: 70, avgReturnPct: 1.3 })), /命中率 70%（对 7 \/ 错 3 \/ 平 2）· 平均涨跌 \+1.3%/);
  assert.equal(model.actionTone("avoid"), "down");
  assert.equal(model.actionTone("watch"), "muted");
});

test("the advice table shows plan, per-horizon results, status, guardrail and an honest stats row", () => {
  const data = { signals: [signal(), signal({ id: "s2", action: "watch", rawAction: "buy", guardrail: "没有给出止损价或失效条件，按观望记录", status: "expired", outcomes: {}, feedback: null })],
    stats: { total: 2, active: 1, byDays: { 1: summary({ completed: 1 }), 3: summary({ completed: 1 }), 5: summary(), 10: summary({ completed: 12, enough: true, hit: 7, miss: 3, neutral: 2, hitRatePct: 70, avgReturnPct: 1.3 }) }, byAction: {}, feedback: { useful: 1, notUseful: 0 }, minSample: 10, hitPct: 1 },
    evaluation: { evaluated: 1, failed: 2 } };
  const html = renderToStaticMarkup(React.createElement(panel.DecisionSignalsTable, { data, busy: false, filter: "", onFilter() {}, onRefresh() {}, onUpdate() {} }));
  for (const text of ["AI 建议", "贵州茅台", "买入", "入场 1450–1470 · 止损 1400 · 目标 1560", "失效：跌破 1400", "对 +2.1%", "破止损 -5.0%", "待评", "生效中", "已过期", "没有给出止损价或失效条件，按观望记录", "70%", "不足 10 条", "有 2 只股票的日线没读到"]) assert.ok(html.includes(text), text);
  const empty = renderToStaticMarkup(React.createElement(panel.DecisionSignalsTable, { data: { signals: [], stats: null, evaluation: null }, busy: false, filter: "", onFilter() {}, onRefresh() {}, onUpdate() {} }));
  assert.match(empty, /还没有建议/);
  const card = renderToStaticMarkup(React.createElement(panel.DecisionCard, { decision: { id: "s1", action: "buy", actionLabel: "买入", horizon: "5d", horizonLabel: "5 个交易日", entryLow: 1450, entryHigh: 1470, stopLoss: 1400, targetPrice: 1560, invalidation: "跌破 1400", watch: [], guardrail: "", expiresAt: "", created: true } }));
  assert.match(card, /已记入 AI 建议/);
  assert.match(card, /管 5 个交易日/);
  const cardWithOpen = renderToStaticMarkup(React.createElement(panel.DecisionCard, { decision: { id: "s1", action: "buy", actionLabel: "买入", horizon: "5d", horizonLabel: "5 个交易日", entryLow: 1450, entryHigh: 1470, stopLoss: 1400, targetPrice: 1560, invalidation: "跌破 1400", watch: [], guardrail: "", expiresAt: "", created: true }, onOpen() {} }));
  assert.match(cardWithOpen, /查看全部建议/);
});

test("handles failed evaluation, all-neutral summaries, non-finite numbers, capped totals and tabpanel a11y", () => {
  assert.equal(model.planText({ entryLow: Number.NaN, entryHigh: Infinity, stopLoss: Number.NaN, targetPrice: null }), "");
  assert.deepEqual(model.outcomeText({ status: "done", verdict: "neutral", returnPct: Number.NaN, maxAdversePct: null, stopHit: false, targetHit: false, endDate: "", endClose: null, startPrice: 10 }), { text: "平", tone: "muted" });
  const allNeutral = summary({ completed: 10, enough: true, hit: 0, miss: 0, neutral: 10, hitRatePct: null, avgReturnPct: 0.1 });
  assert.match(model.summaryText(allNeutral), /全持平（平 10）/);
  assert.doesNotMatch(model.summaryText(allNeutral), /命中率 --%/);

  const failedData = {
    signals: [signal()],
    stats: { total: 350, active: 12, byDays: { 1: allNeutral, 3: summary(), 5: summary(), 10: summary() }, byAction: {}, feedback: { useful: 0, notUseful: 0 }, minSample: 10, hitPct: 1 },
    evaluation: { evaluated: 0, failed: -1 }
  };
  const html = renderToStaticMarkup(React.createElement(panel.DecisionSignalsTable, { data: failedData, busy: false, filter: "", onFilter() {}, onRefresh() {}, onUpdate() {} }));
  assert.match(html, /role="alert"[^>]*>事后验证未能完成，请稍后重试/);
  assert.match(html, /全部 350/);
  assert.match(html, /列表最多展示最近 1 条，共 350 条记录/);
  assert.match(html, /<strong>全持平<\/strong>/);
  assert.match(html, /aria-controls="agent-signals-tabpanel"/);
  assert.match(html, /role="tabpanel"/);
});

test("DecisionSignalsPanel prevents slow load from overwriting newer mutation and caches filter + data within 60s", async () => {
  const prevWindow = global.window;
  const prevNow = Date.now;
  let now = 1_760_000_000_000;
  Date.now = () => now;
  panel.resetDecisionSignalsCache();

  const signalCalls = [];
  const pendingSignals = [];
  const pendingUpdates = [];
  const s1 = signal({ id: "s1", status: "active" });
  const s2 = signal({ id: "s2", code: "300750", name: "宁德时代", status: "closed" });

  global.window = {
    stockApi: {
      ai: {
        agent: {
          signals(input) {
            signalCalls.push(input);
            return new Promise((resolve, reject) => pendingSignals.push({ input, resolve, reject }));
          },
          updateSignal(input) {
            return new Promise((resolve, reject) => pendingUpdates.push({ input, resolve, reject }));
          }
        }
      }
    }
  };

  try {
    const first = createHookHarness(panel.default, { props: {} });
    first.render();
    first.render();
    assert.deepEqual(signalCalls, [{ evaluate: true }]);
    const table = () => find(first.tree, node => node.type === panel.DecisionSignalsTable);
    assert.equal(table().props.busy, true);

    // While slow initial load is in flight, user closes s1 via updateSignal
    table().props.onUpdate({ id: "s1", status: "closed" });
    pendingUpdates.shift().resolve({ signals: [s2], stats: null, evaluation: null });
    await first.flush();
    assert.deepEqual(table().props.data.signals.map(item => item.id), ["s2"]);

    // Slow initial load now resolves with stale [s1, s2]: must NOT overwrite [s2], but MUST clear busy
    pendingSignals.shift().resolve({ signals: [s1, s2], stats: null, evaluation: null });
    await first.flush();
    assert.deepEqual(table().props.data.signals.map(item => item.id), ["s2"], "stale load does not overwrite newer mutation");
    assert.equal(table().props.busy, false, "finally still clears busy");

    // Manual refresh always evaluates and populates cache; filter is also cached
    table().props.onFilter("closed");
    first.render();
    table().props.onRefresh();
    first.render();
    assert.deepEqual(signalCalls.at(-1), { evaluate: true });
    pendingSignals.shift().resolve({ signals: [s2], stats: null, evaluation: null });
    await first.flush();
    first.dispose();

    // Remount within 60s restores filter + data immediately and skips evaluate: true
    now += 15_000;
    const second = createHookHarness(panel.default, { props: {} });
    second.render();
    const secondTable = () => find(second.tree, node => node.type === panel.DecisionSignalsTable);
    assert.equal(secondTable().props.filter, "closed", "cached filter restored immediately");
    assert.deepEqual(secondTable().props.data.signals.map(item => item.id), ["s2"], "cached data restored immediately");
    assert.deepEqual(signalCalls.at(-1), { evaluate: false }, "remount within 60s skips redundant evaluate:true");
    pendingSignals.shift().resolve({ signals: [s2], stats: null, evaluation: null });
    await second.flush();

    // Manual refresh still runs evaluate: true even within 60s
    secondTable().props.onRefresh();
    second.render();
    assert.deepEqual(signalCalls.at(-1), { evaluate: true }, "manual refresh always runs evaluate:true");
    pendingSignals.shift().resolve({ signals: [s2], stats: null, evaluation: null });
    await second.flush();
    second.dispose();

    // Remount after 60s runs evaluate: true again
    now += 61_000;
    const third = createHookHarness(panel.default, { props: {} });
    third.render();
    assert.deepEqual(signalCalls.at(-1), { evaluate: true }, "remount after 60s evaluates again");
    pendingSignals.shift().resolve({ signals: [s2], stats: null, evaluation: null });
    await third.flush();
    third.dispose();
  } finally {
    panel.resetDecisionSignalsCache();
    Date.now = prevNow;
    global.window = prevWindow;
  }
});
