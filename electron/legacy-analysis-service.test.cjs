'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const history = Array.from({ length: 420 }, (_, i) => {
  const close = i >= 40 && i % 20 === 0 ? 11 : 10;
  return { date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10), open: 10, high: Math.max(10.2, close), low: 9.9, close, volume: 1000000, amount: 10000000 };
});
function service() {
  const filename = path.join(__dirname, 'services.cjs'), realRequire = createRequire(filename), module = { exports: {} };
  const code = fs.readFileSync(filename, 'utf8') + `
    dataByProvider = async () => ({ quote: { code: '600000', name: '离线银行', latest: 10, preClose: 10, industry: '银行' }, history: fixtureHistory, actualProvider: 'eastmoney' });
    announcements = async () => [];
    marketEmotionSnapshot = async () => null;
    wholeMarketSnapshot = async () => ({ breadth: 0.5, averageReturn: 0 });
    currentLadderPools = async () => ({ currentPool: [], previousPool: [], failedPool: [] });
    eastHistoryCached = async () => fixtureHistory;
    quoteFederation = async () => ({});
    sectorStrength = async () => null;
    topicPoolForDate = async () => ({ pool: [] });
    loadBacktestHistory = async () => fixtureHistory;
  `;
  vm.runInNewContext(code, { module, exports: module.exports, __dirname, __filename: filename,
    require: id => id === './strategy-intelligence.cjs'
      ? { ...realRequire(id), buildHistoricalStrategyStats() { throw new Error('Legacy history CPU executed on the main thread'); } }
      : realRequire(id),
    fixtureHistory: history, process, console, URL, DOMException, AbortController, AbortSignal,
    TextDecoder, setTimeout, clearTimeout, setImmediate, queueMicrotask, Buffer,
    fetch: async () => { throw new Error('Unexpected live network'); }
  }, { filename });
  return module.exports;
}
const stock = { code: '600000', name: '离线银行', secid: '1.600000', thscode: '600000.SH', assetType: 'stock' };
test('stock analysis loads offline data but sends legacy historical CPU to the real worker', async t => {
  const api = service(); t.after(() => api.shutdownServiceResources());
  const value = await api.analyzeSecurity(stock, { selectedStrategies: ['support', 'trend'] });
  assert.equal(value.analysis.historicalStats.totalEvents, 19);
  assert.equal(value.security.code, '600000');
});
test('legacy non-verified backtest uses the worker without changing its result contract', async t => {
  const api = service(); t.after(() => api.shutdownServiceResources());
  const value = await api.runBacktest(stock, { selectedStrategies: ['support', 'trend'] }, { lookbackBars: 420 });
  assert.equal(value.rawStats.totalEvents, 19);
  assert.equal(value.metrics.totalSignals, 19);
  assert.equal(value.security.code, '600000');
  assert.ok(value.historicalSamplePath);
  assert.equal(Object.hasOwn(value.rawStats, 'combinationSamples'), false);
});
