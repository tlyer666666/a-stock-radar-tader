"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let restoreTypeScript;
let panel;
let model;
before(() => { restoreTypeScript = registerTypeScript(); panel = require("./FactorScreenPanel.tsx"); model = require("./factorScreenModel.ts"); });
after(() => restoreTypeScript?.());

const result = {
  strategy: { id: "quality_value", name: "质量价值", summary: "赚钱能力强、估值不贵", weights: [{ id: "roe", label: "ROE", weight: 30, higher: true }, { id: "pe", label: "滚动市盈率", weight: 25, higher: false }] },
  strategies: [], reportPeriod: "2026-09-30", generatedAt: "2026-11-27T03:00:00.000Z", warnings: ["3 只候选的日线没取到，它们的量价因子缺失"], note: "因子权重是经验设定，没有在本机做过历史回测；这是筛选结果，不是买卖建议。",
  funnel: { universe: 5225, tradable: 2079, passedFilters: 704, scored: 704, candidates: 20, barsFailed: 3, qualified: 12 },
  picks: [{ rank: 1, code: "601336", name: "新华保险", industry: "保险Ⅱ", score: 88.9, coveragePct: 80, latest: 52.3, changePct: -0.14, marketCapYi: 1630,
    factors: { roe: { label: "ROE", unit: "%", value: 18.4, score: 86, weight: 30 }, pe: { label: "滚动市盈率", unit: "倍", value: 6.1, score: 97, weight: 25 }, grossMargin: { label: "毛利率", unit: "%", value: null, score: null, weight: 10 } },
    whySelected: [{ code: "pe", text: "滚动市盈率 6.1倍，全市场前 10%", quality: "observed", source: "业绩报表与行情" }],
    whyNow: [{ code: "awaiting_evidence", text: "日线没取到，量价上的时点证据暂缺", quality: "unknown", source: "" }, { code: "report", text: "2026年三季报披露于 2026-10-31", quality: "observed", source: "业绩报表" }],
    explanationQuality: { whySelected: "ok", whyNow: "partial" }, reportLabel: "2026年三季报", reportPeriod: "2026-09-30" }]
};

test("the funnel and weights are spelled out", () => {
  assert.equal(model.funnelText(result.funnel), "全市场 5225 只 → 能正常交易且不太小 2079 只 → 过基本面条件 704 只 → 进候选 20 只 → 满足量价条件 12 只");
  assert.equal(model.weightsText(result.strategy.weights), "ROE↑ 30% · 滚动市盈率↓ 25%");
  assert.equal(model.FACTOR_STRATEGY_OPTIONS.length, 6);
});

test("each pick shows score, factors, and explanations tagged as observed or missing", () => {
  const html = renderToStaticMarkup(React.createElement(panel.FactorScreenView, { result }));
  for (const text of ["质量价值", "全市场 5225 只", "报表期 2026-09-30", "新华保险", "601336", "88.9", "因子覆盖 80%", "滚动市盈率 6.1倍，全市场前 10%", "观测", "日线没取到，量价上的时点证据暂缺", "缺数据", "2026年三季报披露于 2026-10-31", "没有在本机做过历史回测", "3 只候选的日线没取到"]) assert.ok(html.includes(text), text);
  assert.match(html, /毛利率 <b>--<\/b>/, "a missing factor is shown as --, not 0");
  const empty = renderToStaticMarkup(React.createElement(panel.FactorScreenView, { result: { ...result, picks: [], warnings: ["基本面过关的候选里，现在没有 60 日涨幅为正的"] } }));
  assert.match(empty, /这套策略现在没有选出股票/);
  assert.match(empty, /没有 60 日涨幅为正的/);
});
