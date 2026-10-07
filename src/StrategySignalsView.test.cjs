"use strict";
const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
let restore, view;
before(() => { restore = registerTypeScript(); view = require("./StrategySignalsView.tsx"); });
after(() => restore?.());
test("signal reports retain the new source version and named component contract", () => {
  const { buildStrategySignalReport } = require("../electron/strategy-signal-engine.cjs");
  const report = view.normalizeSignalReport(buildStrategySignalReport());
  const combo = report.strategies.find(item => item.id === "limit_boll_breakout_resonance");
  assert.equal(combo.version, "1.0.0");
  assert.equal(combo.sources.length, 2);
  assert.equal(combo.componentNames.length, 3);
  assert.equal(combo.parameters.widthLookback, 60);
  assert.match(combo.adaptationNote, /五日诊断不能替代2–6周/);
});
test("sources render as official provenance with fixed parameters and no fabricated performance claim", () => {
  const group = require("../config/strategy-signal-combinations.json")[0];
  const html = renderToStaticMarkup(React.createElement(view.StrategyRuleSources, { group }));
  assert.match(html, /公式来源与适配/);
  assert.match(html, /通达信公式系统/);
  assert.match(html, /同花顺股民学校/);
  assert.match(html, /固定参数/);
  assert.match(html, /1\.0\.0/);
  assert.match(html, /未经收益优越性验证/);
});
