"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

const previousCssLoader = require.extensions[".css"];
require.extensions[".css"] = () => {};
const restoreTypeScript = registerTypeScript();
const model = require("./backtestModel.ts");
const { BacktestView } = require("./BacktestView.tsx");
const { initialSettings } = require("../../domain/settings.ts");

const noop = () => {};

test("backtest model retains bounded parameters, valid strategy context, and risk profile defaults", () => {
  const draft = model.normalizeBacktestDraft({
    securityCode: "600519",
    startDate: "2026-10-01",
    lookbackBars: 9999,
    benchmarks: 11,
    benchmark: "invalid",
    minSamples: 0,
    strategyContext: { strategyId: "trend", strategyIds: ["trend", "trend"], minimumVotes: 4 }
  });
  assert.equal(draft.securityCode, "600519");
  assert.equal(draft.lookbackBars, model.MAX_SINGLE_BACKTEST_BARS);
  assert.equal(draft.benchmarks, 10);
  assert.equal(draft.benchmark, "all");
  assert.equal(draft.minSamples, 1);
  assert.deepEqual(draft.strategyContext.strategyIds, ["trend"]);
  assert.equal(draft.strategyContext.minimumVotes, 1);

  const profile = model.normalizeBacktestStrategyProfile(
    { selectedStrategies: ["trend", "trend"], riskProfile: "unknown", minExpectancyPoints: 20 },
    initialSettings,
    draft,
    ["support"]
  );
  assert.deepEqual(profile.selectedStrategies, ["trend"]);
  assert.equal(profile.riskProfile, "balanced");
  assert.equal(profile.minExpectancyPoints, 8);
});

test("backtest feature keeps the single-stock controls and research context", () => {
  const draft = model.normalizeBacktestDraft({ securityCode: "", startDate: "2026-10-01" });
  const executionProfile = model.normalizeBacktestStrategyProfile({}, initialSettings, draft, []);
  const markup = renderToStaticMarkup(React.createElement(BacktestView, {
    draft,
    loading: false,
    error: "",
    result: null,
    history: [],
    profileComparisons: null,
    onDraftChange: noop,
    onInvalidateRun: noop,
    onRun: noop,
    onRunProfileComparisons: noop,
    onApplyProfileComparison: noop,
    onLoadHistory: noop,
    onExportHistory: noop,
    onExportCurrent: noop,
    onApplyCurrent: noop,
    onApplyHistory: noop,
    onClearHistory: noop,
    onBack: noop,
    backLabel: "返回涨停池",
    entryContext: null,
    onTargetChange: noop,
    currentSettings: initialSettings,
    executionProfile,
    profileDiff: () => [],
    evaluateBacktestExecutionReadiness: () => ({ level: "wait", status: "WAIT", score: 0, recommendation: "等待条件确认" }),
    buildBacktestExecutionPlan: () => ({ canExecute: false, confidence: 0, signal: "WAIT", positionSizePercent: 0, stopLossPercent: 0, takeProfitPercent: 0, riskRewardRatio: 0, estimatedHoldingBars: 0, expectedNetEdge: 0, rationale: [] }),
    onOpenPortfolio: noop
  }));

  for (const marker of ["策略单股回测", "回测条件", "回测股票", "开始回测", "返回涨停池"]) {
    assert.ok(markup.includes(marker), `missing backtest marker: ${marker}`);
  }
});

after(() => {
  restoreTypeScript?.();
  if (previousCssLoader) require.extensions[".css"] = previousCssLoader;
  else delete require.extensions[".css"];
});
