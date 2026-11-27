"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const { createHookHarness, find, walk } = require("../../../qa/research-hook-harness.cjs");

let restoreTypeScript;
let panel;
let model;
before(() => { restoreTypeScript = registerTypeScript(); panel = require("./EtfRotationPanel.tsx"); model = require("./etfRotationModel.ts"); });
after(() => restoreTypeScript?.());

const config = { pool: ["510300", "513100"], safeAsset: "511880", lookback: 60, rebalance: "weekly", topN: 2, bufferPct: 2, costBps: 10, years: 8 };
const m = extra => ({ totalPct: 80, years: 6, maxDrawdownPct: 12.5, annualPct: 10.2, volPct: 14, sharpe: 0.73, calmar: 0.82, ...extra });

test("the sweep verdict says whether results depend on the chosen window", () => {
  const row = (lookback, annualPct) => ({ lookback, annualPct, maxDrawdownPct: 10, sharpe: 1, current: false });
  assert.match(model.sweepVerdict([row(20, 9), row(60, 11), row(120, 10)]), /参数比较稳/);
  assert.match(model.sweepVerdict([row(20, 2), row(60, 18), row(120, 6)]), /对参数敏感/);
  assert.match(model.sweepVerdict([row(20, -4), row(60, -2), row(120, 3)]), /历史表现不好/);
  assert.match(model.sweepVerdict([row(20, 9)]), /太少/);
  assert.equal(model.signedPct(null), "--");
  assert.equal(model.signedPct(-1.234), "-1.23%");
  assert.ok(model.curvePaths([{ date: "a", strategy: 1, benchmark: 1 }, { date: "b", strategy: 1.2, benchmark: 1.1 }]));
  assert.equal(model.curvePaths([{ date: "a", strategy: 1, benchmark: 1 }]), null);
});

test("the rotation report shows target holdings, ranking, performance versus equal weight and warnings", () => {
  const report = { config, warnings: ["黄金ETF 在 2026-03-02 单日涨跌超过 15%，可能是拆分或复权缺失，结论要打折扣"], asOf: "2026-11-26",
    signal: { asOf: "2026-11-26", holdings: [{ code: "513100", name: "纳指ETF", safe: false }], targets: [{ code: "513100", name: "纳指ETF", weightPct: 50 }], idleWeightPct: 50, idleTo: "银华日利（货币）", needRebalance: false, isRebalanceDay: false,
      ranking: [{ code: "513100", name: "纳指ETF", momentumPct: 8.2, selected: true, positive: true }, { code: "510300", name: "沪深300ETF", momentumPct: -3.1, selected: false, positive: false }] },
    performance: { from: "2019-01-02", to: "2026-11-26", strategy: m(), benchmark: m({ annualPct: 6.1, maxDrawdownPct: 30 }) },
    yearly: [{ year: "2025", strategyPct: 12.3, benchmarkPct: 8.8, partial: false }], sweep: [{ lookback: 60, annualPct: 10.2, maxDrawdownPct: 12.5, sharpe: 0.73, current: true }],
    rebalances: [{ signalDate: "2026-11-20", tradeDate: "2026-11-23", out: ["沪深300ETF"], in: [], holdings: ["纳指ETF"], costPct: 0.05 }], rebalanceCount: 41,
    curve: [{ date: "2019-01-02", strategy: 1, benchmark: 1 }, { date: "2026-11-26", strategy: 1.8, benchmark: 1.5 }] };
  const html = renderToStaticMarkup(React.createElement(panel.EtfRotationView, { report }));
  for (const text of ["纳指ETF 50% + 银华日利（货币） 50%", "目标和持仓一致", "目标只作参考，要等本周最后一个交易日收盘再定", "动量为负，不持有", "+8.20%", "轮动策略", "风险池等权持有", "+10.20%", "-12.50%", "共调仓 41 次", "60 日（当前）", "2026-11-23", "单日涨跌超过 15%", "回测不代表未来收益"]) assert.ok(html.includes(text), text);
  const bare = renderToStaticMarkup(React.createElement(panel.EtfRotationView, { report: { config, warnings: ["可回测区间不足 1 年，年化类指标没有参考意义，只保留最新信号"], asOf: "", signal: null, performance: null, yearly: [], sweep: [], rebalances: [] } }));
  assert.match(bare, /不足 1 年/);
  assert.doesNotMatch(bare, /轮动策略<\/b>/);
});

test("boundary formatting avoids --%, -0.00%, false rise tone and awkward all-defensive copy", () => {
  assert.equal(model.plainPct(null), "--");
  assert.equal(model.plainPct(Number.NaN), "--");
  assert.equal(model.drawdownPct(0, 2), "0.00%");
  assert.equal(model.drawdownPct(0, 1), "0.0%");
  assert.equal(model.drawdownPct(12.5, 2), "-12.50%");
  assert.equal(model.valueTone(null), "");
  assert.equal(model.valueTone(0), "");
  assert.equal(model.valueTone(Number.NaN), "");
  assert.equal(model.valueTone(1.2), "rise");
  assert.equal(model.valueTone(-0.5), "fall");
  assert.equal(model.curvePaths([{ date: "a", strategy: Number.NaN, benchmark: 1 }, { date: "b", strategy: 1.2, benchmark: 1.1 }]), null);

  const defensive = {
    config,
    warnings: ["重复告警", "重复告警"],
    asOf: "2026-11-26",
    signal: {
      asOf: "2026-11-26",
      holdings: [],
      targets: [],
      idleWeightPct: 100,
      idleTo: "银华日利（货币）",
      needRebalance: false,
      isRebalanceDay: false,
      ranking: [{ code: "510300", name: "沪深300ETF", momentumPct: 0, selected: false, positive: false }]
    },
    performance: {
      from: "2025-01-02",
      to: "2026-11-26",
      strategy: m({ maxDrawdownPct: 0, volPct: null, sharpe: Number.NaN, calmar: Infinity }),
      benchmark: m({ maxDrawdownPct: 0, volPct: null })
    },
    yearly: [{ year: "2026", strategyPct: 0, benchmarkPct: null, partial: true }],
    sweep: [{ lookback: 60, annualPct: 0, maxDrawdownPct: 0, sharpe: null, current: true }],
    rebalances: [],
    curve: []
  };
  const html = renderToStaticMarkup(React.createElement(panel.EtfRotationView, { report: defensive }));
  assert.match(html, /全部防守：银华日利（货币） 100%/);
  assert.doesNotMatch(html, /全部空仓 \+/);
  assert.doesNotMatch(html, /--%/);
  assert.doesNotMatch(html, /-0\.00%/);
  assert.doesNotMatch(html, /-0\.0%/);
  assert.doesNotMatch(html, /class="rise">0\.00%/);
  assert.match(html, /class="bond-table-wrap"/);
});

test("EtfRotationPanel caches lookback, topN, rebalance together with report across remounts", async () => {
  const prevWindow = global.window;
  panel.resetEtfRotationCache();
  const customReport = {
    config: { ...config, lookback: 40, topN: 3, rebalance: "monthly" },
    warnings: [],
    asOf: "2026-11-26",
    signal: null,
    performance: null,
    yearly: [],
    sweep: [],
    rebalances: [],
    curve: []
  };
  let requested = null;
  global.window = {
    stockApi: {
      async getEtfRotation(input) {
        requested = input;
        return customReport;
      }
    }
  };
  try {
    const first = createHookHarness(panel.default, { props: {} });
    first.render();
    const inputs = walk(first.tree).filter(node => node.type === "input");
    const select = find(first.tree, node => node.type === "select");
    inputs[0].props.onChange({ target: { value: "40" } });
    inputs[1].props.onChange({ target: { value: "3" } });
    select.props.onChange({ target: { value: "monthly" } });
    first.render();
    find(first.tree, node => node.type === "button").props.onClick();
    await first.flush();
    assert.deepEqual(requested, { lookback: 40, topN: 3, rebalance: "monthly" });
    first.dispose();

    const remounted = createHookHarness(panel.default, { props: {} });
    remounted.render();
    const restoredInputs = walk(remounted.tree).filter(node => node.type === "input");
    const restoredSelect = find(remounted.tree, node => node.type === "select");
    assert.equal(restoredInputs[0].props.value, "40");
    assert.equal(restoredInputs[1].props.value, "3");
    assert.equal(restoredSelect.props.value, "monthly");
    assert.ok(walk(remounted.tree).some(node => node.type === panel.EtfRotationView && node.props.report === customReport));
    remounted.dispose();
  } finally {
    panel.resetEtfRotationCache();
    global.window = prevWindow;
  }
});
