'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServices } = require('../qa/service-fixture.cjs');
const history = Array.from({ length: 420 }, (_, i) => {
  const close = i >= 40 && i % 20 === 0 ? 11 : 10;
  return { date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10), open: 10, high: Math.max(10.2, close), low: 9.9, close, volume: 1000000, amount: 10000000 };
});
// P0-2b 拆分后改为共享夹具：子模块每次加载都是全新实例，worker/serviceRuntime
// 不会被上一个用例 shutdown 的真实单例污染；内部实现重绑定统一走 rebindAll。
const { rebindAll } = require('../qa/service-fixture.cjs');
function service() {
  const s = loadServices('', { fixtureHistory: history }, {
    './strategy-intelligence.cjs': { ...require('./strategy-intelligence.cjs'), buildHistoricalStrategyStats() { throw new Error('Legacy history CPU executed on the main thread'); } }
  });
  rebindAll(s, 'dataByProvider', async () => ({ quote: { code: '600000', name: '离线银行', latest: 10, preClose: 10, industry: '银行' }, history, actualProvider: 'eastmoney' }));
  rebindAll(s, 'announcements', async () => []);
  rebindAll(s, 'marketEmotionSnapshot', async () => null);
  rebindAll(s, 'wholeMarketSnapshot', async () => ({ breadth: 0.5, averageReturn: 0 }));
  rebindAll(s, 'currentLadderPools', async () => ({ currentPool: [], previousPool: [], failedPool: [] }));
  rebindAll(s, 'eastHistoryCached', async () => history);
  rebindAll(s, 'quoteFederation', async () => ({}));
  rebindAll(s, 'sectorStrength', async () => null);
  rebindAll(s, 'topicPoolForDate', async () => ({ pool: [] }));
  rebindAll(s, 'loadBacktestHistory', async () => history);
  return s;
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
