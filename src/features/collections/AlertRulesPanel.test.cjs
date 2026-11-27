"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

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
