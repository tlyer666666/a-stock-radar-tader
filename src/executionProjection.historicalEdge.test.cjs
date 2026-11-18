'use strict';
// R-01 回归：服务端 analysis.historicalEdge 是对象，不是数字。
// 原实现 `Number.isFinite(edge) ? edge : clampNumber((edge || …))` 对对象恒得 0
// → 「历史边界」永远显示 0%，与同屏「历史通过/未通过」自相矛盾。
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
const restore = registerTypeScript();
const { computeExecutionProjection } = require('./App.tsx');
const { normalizeSettings } = require('./domain/settings.ts');

const settings = normalizeSettings({ strictGate: true });
const quote = { latest: 100, preClose: 100, totalMarketCap: 2e11 };

// 服务端真实返回形状（electron/services.cjs:1762-1773 的 edgeGateFromStats）
const edgeObject = (over = {}) => ({
  passed: true, sampleCount: 45, winRate5: 61.2, average5: 3.42,
  worstMdd5: -8.1, confidence: '充足', minimumSamples: 30, penalty: 0, reasons: [], ...over
});

test('★ 对象型 historicalEdge 必须取 average5，而不是恒为 0', () => {
  const r = computeExecutionProjection({ historicalEdge: edgeObject() }, quote, settings);
  assert.equal(r.historicalEdge, 3.42, `应取 average5=3.42，实际 ${r.historicalEdge}`);
  assert.notEqual(r.historicalEdge, 0, '不得恒为 0');
});

test('★ passed 取对象的权威判定', () => {
  const pass = computeExecutionProjection({ historicalEdge: edgeObject({ passed: true }) }, quote, settings);
  assert.equal(pass.historicalEdgePassed, true);
  const fail = computeExecutionProjection({ historicalEdge: edgeObject({ passed: false, average5: 5 }) }, quote, settings);
  assert.equal(fail.historicalEdgePassed, false, 'passed=false 时必须为 false（即使 average5 很高）');
});

test('average5 缺失时回落 winRate5', () => {
  const r = computeExecutionProjection({ historicalEdge: edgeObject({ average5: null }) }, quote, settings);
  assert.equal(r.historicalEdge, 61.2, `应回落 winRate5=61.2，实际 ${r.historicalEdge}`);
});

test('数字型 historicalEdge 仍按原逻辑处理（向后兼容）', () => {
  const r = computeExecutionProjection({ historicalEdge: 6.5 }, quote, settings);
  assert.equal(r.historicalEdge, 6.5);
  assert.equal(r.historicalEdgePassed, true);
});

test('null historicalEdge 回落 edge/marketScore', () => {
  const r = computeExecutionProjection({ historicalEdge: null, edge: 4.2 }, quote, settings);
  assert.equal(r.historicalEdge, 4.2);
});

test('无任何历史数据时仍为 0 且不通过', () => {
  const r = computeExecutionProjection({}, quote, settings);
  assert.equal(r.historicalEdge, 0);
  assert.equal(r.historicalEdgePassed, false);
});

test('historicalStats.currentCombination 有至少 10 条已结算样本时融合实盘胜率校准 tpBaseRate', () => {
  const buySettings = normalizeSettings({ strictGate: false, alertScore: 70 });
  const baseAnalysis = { mrs: 88, strategyMatchRate: 85, alertQualified: true, historicalEdge: edgeObject({ passed: true, average5: 3.4 }) };
  const withoutEmpirical = computeExecutionProjection(baseAnalysis, quote, buySettings);
  assert.equal(withoutEmpirical.tradePlan.signal, 'BUY');
  const withHighEmpirical = computeExecutionProjection({
    ...baseAnalysis,
    historicalStats: { currentCombination: { id: 'currentCombination', sampleCount: 25, n5: 25, winRate5: 80 } }
  }, quote, buySettings);
  assert.ok(
    withHighEmpirical.tradeProjection.probabilityTakeProfit > withoutEmpirical.tradeProjection.probabilityTakeProfit,
    'high empirical winRate5 should raise tradeProjection.probabilityTakeProfit'
  );
  const smallSample = computeExecutionProjection({
    ...baseAnalysis,
    historicalStats: { currentCombination: { id: 'currentCombination', sampleCount: 6, n5: 6, winRate5: 90 } }
  }, quote, buySettings);
  assert.equal(
    smallSample.tradeProjection.probabilityTakeProfit,
    withoutEmpirical.tradeProjection.probabilityTakeProfit,
    'samples < 10 must not alter projection'
  );
});

test.after(() => restore?.());
