'use strict';
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
let engine, stateModel, rules, settings, restore;
const now = '2026-10-19T02:00:00.000Z';
before(() => {
  restore = require('../../../qa/register-typescript.cjs').registerTypeScript();
  engine = require('./paperSimulationEngine.ts'); stateModel = require('./paperSimulationState.ts');
  settings = { ...require('../../domain/settings.ts').initialSettings, trailingStopPercent: 0, maxHoldingBars: 120, maxDailyRiskPercent: 100, maxPortfolioRiskPercent: 100, slippageBps: 0 };
  mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
});
after(() => { mock.timers.reset(); restore?.(); });
const position = (overrides = {}) => ({ id: 'p', code: '600001', name: '样本', shares: 100, entryPrice: 10, latestPrice: 10, stopPrice: 8, takePrice: 20, holdingBars: 0, highWaterMark: 10, openedAt: '2026-10-16T02:00:00Z', entryFee: 5.01, feeRatePercent: 0.03, ...overrides });
const state = (p = position()) => ({ initialCapital: 100000, cash: 98994.99, openPositions: [p], closedPositions: [], lastTradeDate: '2026-10-19' });
const quote = (latest, overrides = {}) => ({ security: { code: '600001', name: '样本', assetType: 'stock' }, quote: { latest, preClose: 10, volume: 10000, high: latest, low: latest, ...overrides }, history: [], updatedAt: now });
test('P0-09 all automatic/manual/kill exits preserve same Shanghai-day shares', () => {
  const s = state(position({ openedAt: '2026-10-18T17:00:00Z' }));
  const auto = engine.advancePaperSimulationByQuote(s, quote(7), settings);
  assert.equal(auto.state.closedPositions.length, 0); assert.match(auto.message, /T\+1/);
  assert.equal(engine.closePaperSimulationByCode(s, quote(10), settings).state.closedPositions.length, 0);
  assert.equal(engine.closePaperAllSimulationByCode(s, 'KILL_SWITCH', settings).state.closedPositions.length, 0);
});
test('P0-10 suspension, missing liquidity and limit-down cannot liquidate positions', () => {
  for (const q of [quote(7, { volume: 0 }), quote(7, { volume: undefined }), quote(9)]) {
    const result = engine.advancePaperSimulationByQuote(state(position({ stopPrice: 9.5 })), q, settings);
    assert.equal(result.state.closedPositions.length, 0);
    assert.match(result.message, /停牌|成交量|跌停/);
  }
});
test('P1-27 buy/sell fees include commission minimum, transfer fee and seller stamp duty', () => {
  rules = require('./paperTradingRules.ts');
  assert.equal(rules.calcAshareBuyFee(1000, 0.03), 5.01);
  assert.equal(rules.calcAshareSellFee(1000, 0.03), 5.51);
  const result = stateModel.settlePaperPosition(position(), 10, 'MANUAL', now, settings);
  assert.ok(Math.abs(result.record.realizedPnl + 10.52) < 1e-8);
});
test('P1-28 exposure uses current equity and open fees enter net PnL and drawdown', () => {
  const s = state(position({ latestPrice: 5 })); s.cash = 500;
  assert.equal(engine.evaluatePaperKillSwitch(s, settings).portfolioExposurePercent, 50);
  const values = engine.getPaperAccountMetrics(s);
  assert.equal(values.openPnl, -505.01); assert.equal(values.equity, 1000);
  assert.equal(values.maxDrawdownPercent, 99);
});
test('P1-29 observed intraday peak participates in conservative trailing stop', () => {
  const result = engine.advancePaperSimulationByQuote(state(position({ takePrice: 10.5 })), quote(10.6, { high: 12 }), { ...settings, trailingStopPercent: 10 });
  assert.equal(result.state.closedPositions[0].closeReason, 'SL');
  assert.equal(result.state.closedPositions[0].highWaterMark, 12);
});
test('P1-30 explicit ex-right name and changed official reference pause without inventing cash or shares', () => {
  for (const q of [quote(5, { name: 'DR样本', preClose: 5 }), quote(5, { preClose: 5 })]) {
    const result = engine.advancePaperSimulationByQuote(state(position({ lastObservedClose: 10, lastObservedCloseDate: '2026-10-16' })), q, settings);
    assert.equal(result.state.closedPositions.length, 0); assert.equal(result.state.openPositions[0].shares, 100);
    assert.equal(result.state.openPositions[0].entryPrice, 10); assert.match(result.message, /除权|参考价/);
    const restored = stateModel.normalizePaperState(result.state);
    assert.match(restored.openPositions[0].settlementBlockedReason, /除权|参考价/);
  }
});
test('P2 Shanghai daily entry quota excludes overnight positions closed today', () => {
  const s = state(); s.openPositions[0].openedAt = '2026-10-18T17:00:00Z';
  s.closedPositions = [{ ...position(), closeTime: now, realizedPnl: -1 }];
  assert.equal(engine.getPaperDailyTradeSignal(s, settings).todayTradeCount, 1);
  assert.equal(engine.getPaperLossStreakState(s, settings).consecutiveLosses, 1);
});
test('P0-10 price limits honor historical ST boundary and exclude B shares/old third board', () => {
  rules = require('./paperTradingRules.ts');
  assert.equal(rules.paperPriceLimitRate('600001', '*ST样本', '2026-07-03'), .05);
  assert.equal(rules.paperPriceLimitRate('600001', '*ST样本', '2026-07-06'), .1);
  assert.equal(rules.paperPriceLimitRate('920001', '', '2026-10-19'), .3);
  assert.equal(rules.paperPriceLimitRate('900001', '', '2026-10-19'), null);
});
test('P1-28 maximum live drawdown survives recovery and reload', () => {
  const initial = state(position({ latestPrice: 10 })); initial.initialCapital=5000; initial.cash=4000;
  const low = engine.advancePaperSimulationByQuote(initial, quote(9.2), settings).state;
  const recovered = engine.advancePaperSimulationByQuote(stateModel.normalizePaperState(JSON.parse(JSON.stringify(low))), quote(10), settings).state;
  assert.ok(Math.abs(engine.getPaperAccountMetrics(recovered).maxDrawdownPercent - 1.6) < 1e-8);
});
test('P0-09 valid next-day exit settles once, while a stale fallback cannot sell an unquoted other stock', () => {
  const closed=engine.closePaperSimulationByCode(state(),quote(10),settings);
  assert.equal(closed.state.closedPositions.length,1);
  const stale=engine.closePaperSimulationByCode(state(),{...quote(10),security:{code:'600002'}},settings,'MANUAL','600001',10);
  assert.equal(stale.state.closedPositions.length,0);assert.match(stale.message,/今日有效行情/);
});
test('P0-10 signal opening at limit or without volume is blocked before signal execution', () => {
  for(const payload of [quote(11),quote(10,{volume:0}),quote(null)]) {
    const result=engine.openPaperPositionFromSignal({...state(),openPositions:[],cash:100000},payload,settings);
    assert.equal(result.changed,false);assert.match(result.message,/涨停|停牌|价格/);
  }
});
test('P0-10 execution readiness reports a block instead of returning paper state', () => {
  const payload = {
    ...quote(11),
    analysis: { tradePlan: { signal: 'BUY', positionSizePercent: 10, executionFillRatePercent: 100 } }
  };
  const readiness = engine.evaluatePaperExecutionReadinessLocal(
    { ...state(), openPositions: [], cash: 100000 },
    payload,
    { ...settings, minExecutionRatePercent: 40, minQuoteAmount: 0, minTurnoverPercent: 0 }
  );
  assert.equal(readiness.level, 'block');
  assert.equal(readiness.status, 'BLOCK');
  assert.equal(readiness.canExecute, false);
  assert.ok(readiness.reasons.some((reason) => /涨停/.test(reason)));
  assert.equal(Object.hasOwn(readiness, 'state'), false);
});
test('P1-29 quote evidence omits a missing pre-close reference', () => {
  rules = require('./paperTradingRules.ts');
  const evidence = rules.paperQuoteEvidence(quote(10, { preClose: undefined }));
  assert.equal(Object.hasOwn(evidence, 'quotePreClose'), false);
});
test('P1-29 quote evidence preserves missing volume as unknown and explicit zero as suspension', () => {
  rules = require('./paperTradingRules.ts');
  const missing = rules.paperQuoteEvidence(quote(10, { volume: undefined }));
  assert.equal(Object.hasOwn(missing, 'quoteVolume'), false);
  const suspended = rules.paperQuoteEvidence(quote(10, { volume: 0 }));
  assert.equal(suspended.quoteVolume, 0);
});
test('P1-29 state hydration does not invent missing quote references', () => {
  const hydrated = stateModel.normalizePaperState(state(position({ quoteDate: '', quoteVolume: undefined, quotePreClose: undefined })));
  assert.equal(Object.hasOwn(hydrated.openPositions[0], 'quoteVolume'), false);
  assert.equal(Object.hasOwn(hydrated.openPositions[0], 'quotePreClose'), false);
  const suspended = stateModel.normalizePaperState(state(position({ quoteVolume: 0, quotePreClose: 0 })));
  assert.equal(suspended.openPositions[0].quoteVolume, 0);
  assert.equal(suspended.openPositions[0].quotePreClose, 0);
});
test('P1-29 unchanged quote evidence does not force a state write', () => {
  const seeded = state(position({ quoteDate: '2026-10-19', quoteVolume: 10000, quotePreClose: 10, quoteName: '样本' }));
  assert.equal(engine.advancePaperSimulationByQuote(seeded, quote(10), settings).changed, false);
});

test('legacy closes compact once, preserving account and strategy totals across later closes and reload', () => {
  const { paperLifetimeMetrics, CLOSED_DETAIL_LIMIT } = require('./paperClosedHistory.ts');
  const signature = stateModel.buildPaperStrategySignature(settings);
  const records = Array.from({length: 601}, (_, index) => ({
    ...position(), strategySignature: signature, holdingBars: 4, entryExecutionFillRatePercent: 90,
    id: String(index), closeTime: new Date(Date.parse(now) - index * 1000).toISOString(),
    closePrice: 10, closeReason: 'MANUAL', realizedPnl: index % 2 ? -5 : 10, realizedPnlPercent: 1
  }));
  const old = {...state(), closedPositions: records};
  const normalized = stateModel.normalizePaperState(old);
  const restored = stateModel.normalizePaperState(JSON.parse(JSON.stringify(normalized)));
  for (const s of [normalized, restored]) {
    assert.equal(s.closedPositions.length, CLOSED_DETAIL_LIMIT);
    assert.equal(s.closedPositions[0].id, '0'); assert.equal(s.closedPositions.at(-1).id, '499');
    assert.equal(s.closedArchive.total.count, 101);
    assert.deepEqual(paperLifetimeMetrics(s), {closedCount:601,closedWinCount:301,grossProfit:3010,grossLoss:1500,cumulativeRealizedPnl:1510,avgHoldingBars:4});
    const governance = engine.evaluatePaperStrategyGovernance(s, settings);
    assert.equal(governance.tradeCount,601); assert.equal(governance.realizedPnl,1510);
    assert.equal(engine.getPaperDailyTradeSignal(s, settings).todayClosedCount,601);
  }
  const closed = engine.closePaperSimulationByCode(restored, quote(10), settings);
  assert.equal(closed.changed,true); assert.equal(closed.state.closedPositions.length,500);
  assert.equal(paperLifetimeMetrics(closed.state).closedCount,602);
  assert.equal(paperLifetimeMetrics(stateModel.normalizePaperState(closed.state)).closedCount,602);
});

test('invalid archived statistics fail ledger validation so the persistence layer can recover its last-good copy', () => {
  const {isPaperState} = require('../../researchStorage.ts');
  assert.equal(isPaperState({...state(),closedArchive:{total:{grossProfit:'broken'}}}),false);
  assert.equal(isPaperState(state()),true);
});
test('1.6.52 kill switch without a fresh quote still respects the last known suspension or limit-down', () => {
  const stale = { quoteDate: '2026-10-16', quoteName: '样本', quotePreClose: 10 };
  const suspended = engine.closePaperAllSimulationByCode(state(position({ ...stale, quoteVolume: 0, latestPrice: 10 })), 'KILL_SWITCH', settings);
  assert.equal(suspended.state.closedPositions.length, 0, 'last quote was a suspension');
  const limitDown = engine.closePaperAllSimulationByCode(state(position({ ...stale, quoteVolume: 5000, latestPrice: 9 })), 'KILL_SWITCH', settings);
  assert.equal(limitDown.state.closedPositions.length, 0, 'last quote sat at the limit-down price');
  const normal = engine.closePaperAllSimulationByCode(state(position({ ...stale, quoteVolume: 5000, latestPrice: 9.6 })), 'KILL_SWITCH', settings);
  assert.equal(normal.state.closedPositions.length, 1, 'an ordinary last quote can still be closed');
});
