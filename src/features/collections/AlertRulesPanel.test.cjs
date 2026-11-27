"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const { createHookHarness } = require("../../../qa/research-hook-harness.cjs");

let restoreTypeScript;
let panel;
let model;
before(() => { restoreTypeScript = registerTypeScript(); panel = require("./AlertRulesPanel.tsx"); model = require("./alertRulesModel.ts"); });
after(() => restoreTypeScript?.());

test("default parameters match each indicator and times read in Beijing time", () => {
  assert.deepEqual(model.defaultParams("ma_cross"), { direction: "above", window: 20 });
  assert.deepEqual(model.defaultParams("rsi"), { direction: "below", period: 12, threshold: 30 });
  assert.deepEqual(model.defaultParams("market_light"), { statuses: ["red", "yellow"] });
  assert.equal(model.alertTime("2026-11-26T07:12:00.000Z"), "11-26 15:12");
  assert.equal(model.alertTime("bad"), "");
});

test("the panel lists rules, a dry run and honest history states", () => {
  const state = {
    rules: [{ id: "r1", type: "ma_cross", scope: "watchlist", code: "", name: "", params: { direction: "above", window: 20 }, enabled: true, cooldownHours: 24, createdAt: "", text: "全部自选：收盘价上穿 20 日线" },
      { id: "r2", type: "market_light", scope: "market", code: "", name: "", params: { statuses: ["red"] }, enabled: false, cooldownHours: 24, createdAt: "", text: "大盘：大盘转红灯" }],
    history: [{ id: "h1", at: "2026-11-26T07:12:00.000Z", ruleId: "r1", ruleText: "全部自选：收盘价上穿 20 日线", target: "贵州茅台", code: "600519", status: "triggered", detail: "收盘 1480 上穿 20 日线 1466", date: "2026-11-26" },
      { id: "h2", at: "2026-11-26T07:12:00.000Z", ruleId: "r1", ruleText: "", target: "宁德时代", code: "300750", status: "degraded", detail: "日线没取到", date: "" }],
    lastRunAt: "2026-11-26T07:12:00.000Z", types: {},
    dry: [{ ruleId: "r1", target: "平安银行", code: "000001", status: "not_triggered", detail: "收盘 12.4，20 日线 12.6" }]
  };
  const html = renderToStaticMarkup(React.createElement(panel.AlertRulesView, { state, busy: false, message: "评估了 3 项，1 条触发", onRequest() {} }));
  for (const text of ["指标预警", "2 条规则", "上次 11-26 15:12", "全部自选：收盘价上穿 20 日线", "大盘：大盘转红灯", "冷却 24 小时", "试跑结果（不发通知、不记历史）", "平安银行：未触发", "贵州茅台 600519", "已触发", "数据不足", "日线没取到", "评估了 3 项，1 条触发"]) assert.ok(html.includes(text), text);
  const empty = renderToStaticMarkup(React.createElement(panel.AlertRulesView, { state: { rules: [], history: [], lastRunAt: "", types: {} }, busy: false, message: "", onRequest() {} }));
  assert.match(empty, /还没有记录。正常没触发不会记在这里/);
  assert.match(html, /aria-label="暂停规则：全部自选：收盘价上穿 20 日线"/);
  assert.match(html, /<\/summary>.*<\/details>.*清空/);
  const errored = renderToStaticMarkup(React.createElement(panel.AlertRulesView, { state, busy: true, message: "", error: "网络连接失败", onRequest() {} }));
  assert.match(errored, /role="alert"[^>]*>网络连接失败/);
  assert.match(errored, /class="link-btn alert-rules-clear" disabled=""/);
});

test("draft validator supports negative CCI threshold, zero cooldown and rejects out-of-range inputs", () => {
  const cci = model.validateAlertRuleDraft({ type: "cci", direction: "below", windowDraft: "20", periodDraft: "14", thresholdDraft: "-100", cooldownDraft: "0" });
  assert.equal(cci.ok, true);
  assert.deepEqual(cci.params, { direction: "below", period: 14, threshold: -100 });
  assert.equal(cci.cooldownHours, 0);

  const partialNeg = model.validateAlertRuleDraft({ type: "cci", direction: "below", windowDraft: "20", periodDraft: "14", thresholdDraft: "-", cooldownDraft: "24" });
  assert.equal(partialNeg.ok, false);

  const badRsi = model.validateAlertRuleDraft({ type: "rsi", direction: "below", windowDraft: "20", periodDraft: "12", thresholdDraft: "100", cooldownDraft: "24" });
  assert.equal(badRsi.ok, false);

  const badMa = model.validateAlertRuleDraft({ type: "ma_cross", direction: "above", windowDraft: "1", periodDraft: "14", thresholdDraft: "0", cooldownDraft: "24" });
  assert.equal(badMa.ok, false);

  const badCooldown = model.validateAlertRuleDraft({ type: "ma_cross", direction: "above", windowDraft: "20", periodDraft: "14", thresholdDraft: "0", cooldownDraft: "241" });
  assert.equal(badCooldown.ok, false);
});

test("AlertRulesPanel silent focus refresh preserves dry-run & message, never cancels in-flight run, throttles burst events, and skips when inactive", async () => {
  const prevWindow = global.window;
  const prevDocument = global.document;
  const prevNow = Date.now;
  let now = 1_760_000_000_000;
  Date.now = () => now;
  const windowListeners = new Map();
  const docListeners = new Map();
  const calls = [];
  const pending = [];
  const baseRule = { id: "r1", type: "ma_cross", scope: "watchlist", code: "", name: "", params: { direction: "above", window: 20 }, enabled: true, cooldownHours: 24, createdAt: "", text: "全部自选：收盘价上穿 20 日线" };

  global.window = {
    addEventListener(type, fn) { windowListeners.set(type, fn); },
    removeEventListener(type, fn) { if (windowListeners.get(type) === fn) windowListeners.delete(type); },
    stockApi: {
      alertRules(input) {
        calls.push(input);
        return new Promise((resolve, reject) => pending.push({ input, resolve, reject }));
      }
    }
  };
  global.document = {
    visibilityState: "visible",
    addEventListener(type, fn) { docListeners.set(type, fn); },
    removeEventListener(type, fn) { if (docListeners.get(type) === fn) docListeners.delete(type); }
  };

  try {
    // 1) Active panel: initial list, dry-run, then focus + visibilitychange burst
    const harness = createHookHarness(panel.default, { props: { active: true } });
    harness.render();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, "list");
    pending.shift().resolve({ rules: [baseRule], history: [], lastRunAt: "", types: {} });
    await harness.flush();

    // Trigger dry-run
    harness.tree.props.onRequest({ op: "dry", id: "r1" });
    harness.render();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].op, "dry");
    pending.shift().resolve({
      rules: [baseRule],
      history: [],
      lastRunAt: "",
      types: {},
      dry: [{ ruleId: "r1", target: "平安银行", code: "000001", status: "not_triggered", detail: "未触发" }]
    });
    await harness.flush();
    assert.equal(harness.tree.props.state.dry.length, 1);

    // Focus fires silent background list; visibilitychange 100ms later is throttled
    windowListeners.get("focus")();
    now += 100;
    docListeners.get("visibilitychange")();
    assert.equal(calls.length, 3, "visibilitychange within 1500ms is throttled");
    assert.equal(harness.tree.props.busy, false, "silent refresh never flips busy");
    pending.shift().resolve({
      rules: [baseRule],
      history: [{ id: "h1", at: "2026-11-26T07:12:00.000Z", ruleId: "r1", ruleText: baseRule.text, target: "贵州茅台", code: "600519", status: "triggered", detail: "上穿", date: "2026-11-26" }],
      lastRunAt: "2026-11-26T07:12:00.000Z",
      types: {}
    });
    await harness.flush();
    assert.equal(harness.tree.props.state.dry.length, 1, "silent refresh preserves dry-run output");
    assert.equal(harness.tree.props.state.history.length, 1, "silent refresh merges updated history");
    assert.equal(harness.tree.props.state.lastRunAt, "2026-11-26T07:12:00.000Z");

    // Start a slow foreground run; focus after 2000ms must NOT start silent refresh or cancel the run
    now += 2_000;
    harness.tree.props.onRequest({ op: "run" });
    harness.render();
    assert.equal(calls.length, 4);
    assert.equal(harness.tree.props.busy, true);
    windowListeners.get("focus")();
    assert.equal(calls.length, 4, "in-flight foreground run suppresses silent refresh");
    pending.shift().resolve({
      rules: [baseRule],
      history: [],
      lastRunAt: "2026-11-26T07:15:00.000Z",
      types: {},
      run: { at: "2026-11-26T07:15:00.000Z", evaluated: 2, triggered: 1 }
    });
    await harness.flush();
    assert.equal(harness.tree.props.busy, false);
    assert.match(harness.tree.props.message, /评估了 2 项，1 条触发/);

    // Foreground request started while a silent refresh is in flight aborts stale silent apply
    now += 2_000;
    windowListeners.get("focus")();
    assert.equal(calls.length, 5);
    const silentReq = pending.shift();
    harness.tree.props.onRequest({ op: "clear" });
    harness.render();
    const clearReq = pending.shift();
    clearReq.resolve({ rules: [baseRule], history: [], lastRunAt: "2026-11-26T07:20:00.000Z", types: {} });
    await harness.flush();
    silentReq.resolve({
      rules: [baseRule],
      history: [{ id: "stale", at: "2026-11-26T07:12:00.000Z", ruleId: "r1", ruleText: "", target: "旧记录", code: "000001", status: "triggered", detail: "", date: "2026-11-26" }],
      lastRunAt: "2026-11-26T07:12:00.000Z",
      types: {}
    });
    await harness.flush();
    assert.equal(harness.tree.props.state.history.length, 0, "stale silent refresh aborts when seqRef advanced");
    harness.dispose();

    // 2) Inactive panel: registers no focus/visibility refresh
    calls.length = 0;
    windowListeners.clear();
    docListeners.clear();
    const inactive = createHookHarness(panel.default, { props: { active: false } });
    inactive.render();
    assert.equal(calls.length, 1, "initial mount still fetches list once");
    pending.shift().resolve({ rules: [], history: [], lastRunAt: "", types: {} });
    await inactive.flush();
    assert.equal(windowListeners.size, 0, "inactive panel does not subscribe to window focus");
    assert.equal(docListeners.size, 0, "inactive panel does not subscribe to document visibilitychange");
    inactive.dispose();
  } finally {
    Date.now = prevNow;
    global.window = prevWindow;
    global.document = prevDocument;
  }
});
