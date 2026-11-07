'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
let execution, restore;
before(() => { restore = registerTypeScript(); execution = require('./trendExecution.ts'); });
after(() => restore?.());
const now = Date.parse('2026-10-21T01:30:00Z');
const ready = (changes = {}) => ({ checkedAt: '2026-10-21T01:29:50Z', quoteAt: '2026-10-21T01:29:50Z', signalDate: '2026-10-20',
  expectedSignalDate: '2026-10-20', executionDate: '2026-10-21', state: 'ready', reasons: [], latest: 10,
  upperLimit: 11, lowerLimit: 9, suspended: false, priceDate: '2026-10-21', source: 'public quote',
  minimumBuyQuantity: 100, quantityStep: 100, ...changes });
test('only a current matching execution check with complete quote evidence can permit a real plan', () => {
  assert.equal(execution.currentTrendExecution(ready(), '2026-10-20', now).state, 'ready');
  for (const change of [{ latest: null }, { upperLimit: null }, { lowerLimit: null }, { suspended: null },
    { expectedSignalDate: null }, { source: '' }, { quantityStep: 0 }, { state: 'unknown' }]) {
    assert.notEqual(execution.currentTrendExecution(ready(change), '2026-10-20', now).state, 'ready');
  }
  assert.equal(execution.currentTrendExecution(null, '2026-10-20', now).state, 'unknown');
});
test('yesterday checks, stale quotes, wrong signal identity and future timestamps fail closed', () => {
  for (const change of [{ checkedAt: '2026-10-20T01:30:00Z' }, { priceDate: '2026-10-20' },
    { executionDate: '2026-10-20' }, { signalDate: '2026-10-19' }, { expectedSignalDate: '2026-10-19' },
    { checkedAt: '2026-10-21T01:31:00Z' }]) {
    assert.notEqual(execution.currentTrendExecution(ready(change), '2026-10-20', now).state, 'ready');
  }
  assert.equal(execution.currentTrendExecution(ready(), '2026-10-20', now + 61000).state, 'expired');
});
test('board rules derive from the candidate board and missing runtime execution API returns unknown', async () => {
  assert.deepEqual(execution.trendBoardQuantity('star'), { minimumBuyQuantity: 200, quantityStep: 1 });
  assert.deepEqual(execution.trendBoardQuantity('beijing'), { minimumBuyQuantity: 100, quantityStep: 1 });
  assert.deepEqual(execution.trendBoardQuantity('main'), { minimumBuyQuantity: 100, quantityStep: 100 });
  const result = await execution.requestTrendExecution({}, { security: { code: '600001', name: 'a', secid: '1.600001' }, signalDate: '2026-10-20' });
  assert.equal(result.state, 'unknown');
  assert.ok(result.reasons.length);
});

test('client clock failure and malformed ready responses remain unknown instead of throwing or passing', () => {
  assert.equal(execution.currentTrendExecution(ready(), '2026-10-20', NaN).state, 'unknown');
  assert.equal(execution.currentTrendExecution(ready({ reasons: null }), '2026-10-20', now).state, 'unknown');
  assert.equal(execution.currentTrendExecution(ready({ state: 'unexpected' }), '2026-10-20', now).state, 'unknown');
  assert.equal(execution.currentTrendExecution(ready({ quoteAt: '2026-10-21T01:28:00Z' }), '2026-10-20', now).state, 'expired');
});

test('a ready response without a source timestamp remains unknown', () => {
 assert.equal(execution.currentTrendExecution(ready({quoteAt:undefined}), '2026-10-20', now).state, 'unknown');
});
