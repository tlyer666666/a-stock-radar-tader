"use strict";
// 回测中心实用性整理（2026-11-21）：默认口径、结论文案与历史摘要。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let model, restore;
before(() => { restore = registerTypeScript(); model = require("./backtestModel.ts"); });
after(() => restore?.());

test("单股回测默认看近3年，并提供近1/3/5年快捷区间", () => {
  const now = new Date("2026-11-21T02:00:00Z");
  assert.equal(model.DEFAULT_BACKTEST_YEARS, 3);
  assert.equal(model.backtestRangeStartDate(3, now), "2023-11-21");
  assert.equal(model.backtestRangeStartDate(5, now), "2021-11-21");
  assert.equal(model.backtestRangeStartDate(1, new Date("2024-02-29T02:00:00Z")), "2023-02-28", "闰日回退到当月最后一天");
  assert.deepEqual(model.BACKTEST_RANGE_PRESETS.map(item => item.years), [1, 3, 5]);
  const draft = model.normalizeBacktestDraft({});
  assert.equal(draft.startDate, model.defaultBacktestStartDate());
});

test("默认勾选全部未下线的精选策略；没有精选时退回第一套", () => {
  const defs = [
    { id: "a", featured: true }, { id: "b" }, { id: "c", featured: true, retired: true }, { id: "d", featured: true }
  ];
  assert.deepEqual(model.featuredBacktestStrategyIds(defs), ["a", "d"]);
  assert.deepEqual(model.featuredBacktestStrategyIds([{ id: "x" }, { id: "y" }]), ["x"]);
  assert.deepEqual(model.featuredBacktestStrategyIds([]), []);
});

test("结论文案：没有交易时说明原因而不是报失败；有交易时一句话讲清赚亏", () => {
  const empty = model.describeBacktestOutcome({ tradeCount: 0, totalNetReturnPercent: 0 }, { from: "2025-11-21", to: "2026-11-20" });
  assert.equal(empty.tone, "empty");
  assert.match(empty.headline, /2025-11-21 至 2026-11-20，.*没有触发过可成交的买入/);
  assert.match(empty.caution, /不代表策略不好/);
  assert.equal(model.describeBacktestOutcome(null).tone, "empty");

  const few = model.describeBacktestOutcome(
    { tradeCount: 4, profitableTrades: 3, losingTrades: 1, winRatePercent: 75, totalNetReturnPercent: 6.17, maxDrawdownPercent: -0.64 },
    { from: "2023-11-21", to: "2026-11-20" }
  );
  assert.equal(few.tone, "profit");
  assert.equal(few.headline, "2023-11-21 至 2026-11-20 共完成 4 笔交易，3 笔赚、1 笔亏（胜率 75.0%），扣费后累计 +6.17%，期间资金最大回撤 0.64%。");
  assert.match(few.caution, /只有 4 笔交易，样本太少/);

  const loss = model.describeBacktestOutcome({ tradeCount: 12, profitableTrades: 4, losingTrades: 8, winRatePercent: 33.33, totalNetReturnPercent: -8.4 }, {});
  assert.equal(loss.tone, "loss");
  assert.match(loss.headline, /^所选区间内共完成 12 笔交易，4 笔赚、8 笔亏（胜率 33\.3%），扣费后累计 -8\.40%。$/);
  assert.equal(loss.caution, "", "样本够多时不加提醒");

  const missing = model.describeBacktestOutcome({ tradeCount: 6 }, {});
  assert.equal(missing.tone, "flat");
  assert.equal(missing.headline, "所选区间内共完成 6 笔交易。", "缺失的数字不编造");
});

test("历史记录摘要：没有收益汇总时留空，不显示成 0", () => {
  assert.deepEqual(model.summarizeBacktestRecord({ rawResult: null }), { tradeCount: null, winRatePercent: null, netReturnPercent: null, tone: "empty" });
  assert.deepEqual(model.summarizeBacktestRecord({ rawResult: { profitSummary: { tradeCount: 0, winRatePercent: 0, totalNetReturnPercent: 0 } } }),
    { tradeCount: 0, winRatePercent: null, netReturnPercent: null, tone: "empty" });
  assert.deepEqual(model.summarizeBacktestRecord({ rawResult: { profitSummary: { tradeCount: 4, winRatePercent: 75, totalNetReturnPercent: 6.17 } } }),
    { tradeCount: 4, winRatePercent: 75, netReturnPercent: 6.17, tone: "profit" });
});

test("界面接线：精选按钮、区间快捷、空样本补救和中性的收益概览", () => {
  const view = fs.readFileSync(path.join(__dirname, "BacktestView.tsx"), "utf8");
  for (const marker of ["data-backtest-featured-strategies", "data-backtest-range=", "data-backtest-verdict", "data-backtest-retry-featured", "data-backtest-retry-wider", "没有成交样本", "验证与风控明细"]) {
    assert.ok(view.includes(marker), marker);
  }
  assert.match(view, /featuredBacktestStrategyIds\(definitions\)/, "进入页面默认勾选精选策略");
  const css = fs.readFileSync(path.join(__dirname, "../../styles/theme/components.css"), "utf8");
  assert.match(css, /\.backtest-profit-overview \{\s*border-color: var\(--line-2\);\s*background: var\(--surface-2\);/);
});
