'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../../../qa/register-typescript.cjs');
const restore = registerTypeScript();
const { paperSessionBlock, paperMatchBlock } = require('./paperTradingRules.ts');
const { openPaperPositionFromSignal, advancePaperSimulationByQuote } = require('./paperSimulationEngine.ts');
const { normalizeSettings } = require('../../domain/settings.ts');
const { normalizePaperState } = require('./paperSimulationState.ts');
test.after(restore);

const at = text => new Date(text);

test('模拟撮合只在连续竞价与收盘集合竞价时段放行（交易日 9:30–11:30、13:00–15:00）', () => {
  for (const time of ['2026-11-19T09:30:00+08:00', '2026-11-19T11:30:00+08:00', '2026-11-19T13:00:00+08:00', '2026-11-19T14:59:59+08:00']) {
    assert.equal(paperSessionBlock(at(time)), '', time);
  }
});

test('盘前、午休、收盘后不撮合，避免收盘后按收盘价成交让模拟业绩虚高', () => {
  for (const time of ['2026-11-19T09:25:00+08:00', '2026-11-19T12:00:00+08:00', '2026-11-19T15:00:01+08:00', '2026-11-19T22:53:00+08:00']) {
    assert.match(paperSessionBlock(at(time)), /非交易时段/, time);
  }
});

test('周末和法定休市日不撮合', () => {
  assert.match(paperSessionBlock(at('2026-11-21T10:00:00+08:00')), /休市/);
  assert.match(paperSessionBlock(at('2026-10-05T10:00:00+08:00')), /休市/);
});

test('paperMatchBlock 在传入非交易时刻或报价自带收盘后 quoteAt 时拒绝撮合', () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const pos = { code: '600519', name: '贵州茅台', latestPrice: 1500, openedAt: '2026-01-05T02:00:00Z', quoteDate: today, quoteName: '贵州茅台', quoteVolume: 10000, quotePreClose: 1490 };
  assert.match(paperMatchBlock(pos, 'buy', 1500, at('2026-11-19T22:53:00+08:00')), /非交易时段/);
  assert.match(paperMatchBlock({ ...pos, quoteAt: `${today}T15:05:00+08:00` }, 'buy', 1500), /非交易时段|休市/);
});

test('收盘后的真实报价快照不能触发模拟买入或自动止损平仓', () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const settings = normalizeSettings({ minExecutionRatePercent: 40 });
  const afterCloseQuoteAt = `${today}T15:02:00+08:00`;
  const payload = {
    security: { code: '600519', secid: '1.600519', name: '贵州茅台', assetType: 'stock' },
    updatedAt: new Date().toISOString(),
    quote: { name: '贵州茅台', latest: 100, preClose: 100, high: 101, low: 99, volume: 1000000, changePct: 0, amount: 8e8, turnover: 2.5, quoteAt: afterCloseQuoteAt },
    analysis: { tradePlan: { signal: 'BUY', positionSizePercent: 20, stopLossDistancePercent: 5, stopLossPrice: 95, takeProfitPrice: 112 }, qualityIndex: 85, historicalEdge: 10, strategyResults: [], risks: [] },
    history: []
  };
  const opened = openPaperPositionFromSignal(normalizePaperState({ initialCapital: 100000, cash: 100000 }), payload, settings);
  assert.equal(opened.changed, false);
  assert.match(opened.message, /非交易时段|休市/);

  const held = normalizePaperState({
    initialCapital: 100000, cash: 99000,
    openPositions: [{ id: 'p1', code: '600519', name: '贵州茅台', shares: 100, entryPrice: 100, latestPrice: 100, stopPrice: 98, takePrice: 120, holdingBars: 1, highWaterMark: 100, openedAt: '2026-01-05T02:00:00Z', quoteDate: today, quotePreClose: 100, quoteVolume: 10000 }]
  });
  const stopped = advancePaperSimulationByQuote(held, { ...payload, quote: { ...payload.quote, latest: 96 } }, settings);
  assert.equal(stopped.state.openPositions.length, 1);
  assert.equal(stopped.state.closedPositions.length, 0);
  assert.match(stopped.message, /非交易时段|休市/);
});
