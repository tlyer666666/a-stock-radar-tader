'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkerRunner } = require('./worker-runner.cjs');
const { buildHistoricalStrategyStats } = require('./strategy-intelligence.cjs');
const filename = path.join(__dirname, 'legacy-analysis-worker.cjs');
function fixture(count = 420) {
  return Array.from({ length: count }, (_, i) => {
    const close = i >= 40 && i % 20 === 0 ? 11 : 10;
    return { date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: 10, high: Math.max(10.2, close), low: 9.9, close, volume: 1000000, amount: 10000000 };
  });
}
test('legacy worker preserves historical output with and without sample details', async t => {
  assert.equal(fs.existsSync(filename), true, 'legacy analysis must have its dedicated worker entry');
  const runner = createWorkerRunner(); t.after(() => runner.shutdown());
  const history = fixture(), benchmarkHistory = history.map(row => ({ ...row, close: 10 }));
  for (const options of [{}, { includeSamples: true }]) {
    const data = { history, code: '600000', name: '离线样本', selectedIds: ['support', 'trend', 'riskVeto', 'sector'], benchmarkHistory, options };
    const expected = buildHistoricalStrategyStats(history, data.code, data.name, data.selectedIds, benchmarkHistory, options);
    const actual = await runner.run(filename, data);
    assert.equal(actual.totalEvents, 19);
    assert.equal(actual.benchmarkAvailable, true);
    assert.deepEqual(actual, expected);
    assert.equal(Object.hasOwn(actual, 'combinationSamples'), !!options.includeSamples);
  }
});
test('legacy worker gives empty history the original safe result', async t => {
  assert.equal(fs.existsSync(filename), true);
  const runner = createWorkerRunner(); t.after(() => runner.shutdown());
  const actual = await runner.run(filename, { history: [], code: '600000', name: '样本', selectedIds: ['trend'], options: { includeSamples: true } });
  assert.equal(actual.totalEvents, 0);
  assert.deepEqual(actual.nodeStats, []);
  assert.deepEqual(actual.combinationSamples, []);
  assert.equal(actual.stats.length, 1);
  assert.equal(actual.stats[0].id, 'trend');
});
test('legacy historical CPU runs outside the caller event loop and errors remain observable', async t => {
  assert.equal(fs.existsSync(filename), true);
  const runner = createWorkerRunner(); t.after(() => runner.shutdown());
  const pending = runner.run(filename, { history: fixture(1200), code: '600000', name: '样本', selectedIds: ['trend'] });
  const first = await Promise.race([pending.then(() => 'result'), new Promise(resolve => setImmediate(() => resolve('heartbeat')))]);
  assert.equal(first, 'heartbeat');
  const result = await pending;
  assert.equal(result.totalEvents, 58);
  await assert.rejects(runner.run(filename, { history: [], selectedIds: null }), /filter/);
});
