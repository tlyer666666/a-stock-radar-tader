'use strict';
// F-02 回归：单笔风险上限必须始终生效。
//
// 原实现 `if (sharesByRisk > 0) shares = Math.min(...)`：风险金额不足一手时
// 整手向下去整得 0，条件不成立 → 约束被**静默跳过**，风控形同不存在。
// 实测设置 0.2% 上限、实际风险 1.00%（5 倍）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../../../qa/register-typescript.cjs');
registerTypeScript();
const { openPaperPositionFromSignal } = require('./paperSimulationEngine.ts');
const { normalizeSettings } = require('../../domain/settings.ts');
const { normalizePaperState } = require('./paperSimulationState.ts');

// 小资金 + 宽止损 + 高股价 → 按风险上限可买股数向下取整为 0
const state = () => normalizePaperState({ initialCapital: 5000, cash: 5000 });
const settings = () => normalizeSettings({
  maxRiskPerTradePercent: 0.2,   // 风险金额 = 5000 × 0.2% = 10 元
  maxPositionPercent: 100,
  stopLossATRMultiple: 1.5,
  // 把成交率门槛放到下限，让流程走到本测试要验证的「风险上限」那道闸
  minExecutionRatePercent: 40
});

const payload = () => ({
  security: { code: '600519', secid: '1.600519', name: '贵州茅台', assetType: 'stock' },
  // 用「当前时刻」保证行情不过期（否则会被实时性闸门拦下）
  updatedAt: new Date().toISOString(),
  quote: { name: '贵州茅台', latest: 100, preClose: 100, high: 101, low: 99, volume: 1000000, changePct: 0, amount: 8e8, turnover: 2.5 },
  analysis: {
    tradePlan: { signal: 'BUY', positionSizePercent: 100, stopLossDistancePercent: 25, stopLossPrice: 75, takeProfitPrice: 130, maxHoldingBars: 20 },
    qualityIndex: 80,
    historicalEdge: 10,
    strategyResults: [],
    risks: []
  },
  history: []
});

test('★ 风险上限不足一手时必须拒绝建仓，而不是静默跳过风控', () => {
  const r = openPaperPositionFromSignal(state(), payload(), settings());
  assert.equal(r.changed, false, '不应产生建仓');
  assert.match(String(r.message), /可买不足 1 手/, `应给出明确拒绝原因，实际：${r.message}`);
  assert.equal(r.state.openPositions.length, 0, '不得新增持仓');
});

test('拒绝后现金与持仓完全不变（无副作用）', () => {
  const before = state();
  const r = openPaperPositionFromSignal(before, payload(), settings());
  assert.equal(r.state.cash, before.cash, '现金不得变动');
  assert.equal(r.state.openPositions.length, before.openPositions.length);
});
