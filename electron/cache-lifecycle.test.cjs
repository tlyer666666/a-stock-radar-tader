'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadServiceModule, rebindAll } = require('../qa/service-fixture.cjs');
// P0-2b 拆分后改为共享夹具：services/*.cjs 子模块每次 load 都是全新实例，
// globals（如 Clock）对子模块同样生效；内部实现重绑定统一走 rebindAll（在声明处生效并跨模块传播）。
function load(name, append = '', globals = {}) {
  return loadServiceModule(path.join(__dirname, name), {}, globals, append);
}
const stock = { code: '600000', secid: '1.600000', thscode: '600000.SH' };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('ladder cache reaccounts a completed producer and does not retain its oversized result', async () => {
  const s = load('services.cjs', `module.exports.probe = { currentLadderPools, ladderPoolsCaches: _runtime.ladderPoolsCaches };`);
  s.probe.setLoader = fn => { rebindAll(s, 'recentLimitUpPools', fn); rebindAll(s, 'topicPoolForDate', async () => ({ pool: [] })); };
  s.probe.ladderPoolsCaches.maxBytes = 512;
  s.probe.ladderPoolsCaches.maxEntryBytes = 512;
  let loads = 0;
  s.probe.setLoader(async () => { loads++; return [{ date: '2026-09-30', pool: [{ code: '600000', detail: 'x'.repeat(2000) }] }]; });
  assert.equal((await s.probe.currentLadderPools()).currentPool[0].detail.length, 2000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.probe.ladderPoolsCaches.size, 0);
  await s.probe.currentLadderPools();
  assert.equal(loads, 2);
});

test('credential changes isolate THS history and federation, including token suffix collisions', async () => {
  const s = load('services.cjs', `module.exports.probe = { thsHistoryCached: _backtest.thsHistoryCached };`);
  rebindAll(s, 'thsHistory', async (_, settings) => [{ owner: settings.refreshToken === 'fixture-A' ? 'A' : 'B' }]);
  rebindAll(s, 'getQuoteSnapshot', async () => ({ quote: {} }));
  rebindAll(s, 'quoteFederation', async (_, __, settings) => ({ owner: settings.refreshToken === 'fixture-A' ? 'A' : 'B' }));
  await s.probe.thsHistoryCached(stock, { refreshToken: 'fixture-A' });
  assert.equal((await s.probe.thsHistoryCached(stock, { refreshToken: 'fixture-B' }))[0].owner, 'B');
  await s.getDataFederation(stock, { refreshToken: 'fixture-A' });
  assert.equal((await s.getDataFederation(stock, { refreshToken: 'fixture-B' })).owner, 'B');
  const f = load('data-federation.cjs', `fetchTushareDailyQuote = async (_, token) => ({ owner: token.startsWith('A') ? 'A' : 'B' });`);
  await f.tushareDailyQuote(stock, 'A-SAME1234');
  assert.equal((await f.tushareDailyQuote(stock, 'B-SAME1234')).owner, 'B');
});

for (const [kind, capacity, bars] of [['history', 128, 320], ['chart', 96, 160]]) {
  test(`${kind} cache bounds completed rows, expires idle keys and retains active single-flight`, async () => {
    let now = 1_000_000;
    class Clock extends Date { static now() { return now; } }
    const s = load('services.cjs', `module.exports.probe = { historyCache: _runtime.historyCache, chartCache: _runtime.chartCache, eastHistoryCached: _backtest.eastHistoryCached, eastChartCached: _quotes_and_charts.eastChartCached };`, { Date: Clock });
    let calls = 0;
    const active = deferred();
    const loader = async security => { calls++; return security.code === '600000' ? active.promise : Array(bars).fill({ close: 10 }); };
    rebindAll(s, 'eastHistory', loader);
    rebindAll(s, 'eastChart', loader);
    const call = code => kind === 'history'
      ? s.probe.eastHistoryCached({ ...stock, code, secid: `1.${code}` }, bars, 1, 10)
      : s.probe.eastChartCached({ ...stock, code, secid: `1.${code}` }, '101', bars, 1, 10);
    const first = call('600000');
    for (let i = 1; i <= capacity + 20; i++) await call(String(600000 + i));
    const cache = s.probe[`${kind}Cache`];
    assert.ok(cache.size <= capacity + 1, `retained ${cache.size} entries`);
    const before = calls, duplicate = call('600000');
    assert.equal(calls, before, 'pending work must not be evicted and restarted');
    active.resolve([{ close: 20 }]); await Promise.all([first, duplicate]);
    now += 60_000; await call('699999');
    assert.equal(cache.size, 1);
  });
}

test('bounded retention respects LRU, explicit stale window and clear ownership', () => {
  const { BoundedCache } = require('./bounded-cache.cjs');
  let now = 100;
  const cache = new BoundedCache({ maxEntries: 2, now: () => now });
  cache.set('a', { value: 1, expiresAt: 200 });
  cache.set('b', { value: 2, expiresAt: 200 });
  assert.equal(cache.get('a').value, 1);
  cache.set('c', { value: 3, expiresAt: 200 });
  assert.equal(cache.has('b'), false);
  cache.set('stale', { value: 4, expiresAt: 120, staleUntil: 300 });
  now = 250;
  assert.equal(cache.get('stale').value, 4);
  assert.equal(cache.has('a'), false);
  now = 301;
  assert.equal(cache.get('stale'), undefined);
  cache.clear(); assert.equal(cache.size, 0);
});

test('news first-seen identities have bounded retention while repeated current stories keep original time', () => {
  let now = 1_000_000;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const n = load('news-service.cjs', 'module.exports.probe = { rememberFirstSeen, firstSeen };', { Date: Clock });
  const seen = n.probe.rememberFirstSeen('same'); now += 1000;
  assert.equal(n.probe.rememberFirstSeen('same'), seen);
  for (let i = 0; i < 5500; i++) n.probe.rememberFirstSeen(`item-${i}`);
  assert.ok(n.probe.firstSeen.size <= 5000);
  now += 25 * 60 * 60 * 1000;
  n.probe.rememberFirstSeen('fresh');
  assert.equal(n.probe.firstSeen.size, 1);
});

test('sector lookup stale fallback releases failed promise so the next call can recover', async () => {
  const s = load('services.cjs', `module.exports.probe = { findSector: _sectors.findSector, sectorLookupCache: _runtime.sectorLookupCache };`);
  s.probe.sectorLookupCache.set('银行', { value: { name: 'old' }, expiresAt: Date.now() - 1 });
  rebindAll(s, 'fetchJson', async () => { throw new Error('offline'); });
  assert.equal((await s.probe.findSector('银行')).name, 'old');
  rebindAll(s, 'fetchJson', async () => ({ QuotationCodeTable: { Data: [{ Classify: 'BK', Name: '银行', Code: 'BK001', QuoteID: '90.BK001' }] } }));
  assert.equal((await s.probe.findSector('银行')).code, 'BK001');
});

test('negative cache results expire even when their completed value is null', () => {
  const { BoundedCache } = require('./bounded-cache.cjs');
  let now = 10;
  const cache = new BoundedCache({ now: () => now });
  cache.set('missing', { value: null, expiresAt: 20 });
  assert.equal(cache.has('missing'), true);
  now = 21;
  assert.equal(cache.has('missing'), false);
});

function searchFixture() {
  const s = load('services.cjs');
  rebindAll(s, 'thsSearchSuggestions', async () => []);
  return {
    searchSecurities: (...args) => s.searchSecurities(...args),
    setLoader(fn) { rebindAll(s, 'fetchJson', fn); },
    shutdownServiceResources: () => s.shutdownServiceResources()
  };
}

const searchResponse = { QuotationCodeTable: { Data: [
  { Code: '600000', Name: '浦发银行', Classify: 'AStock', QuoteID: '1.600000', MktNum: '1', SecurityTypeName: '沪A' }
] } };

test('concurrent equivalent security searches share one producer and keep completed result caching', async () => {
  const s = searchFixture(), gate = deferred();
  let requests = 0;
  s.setLoader(async url => {
    assert.equal(new URL(url).searchParams.get('input'), '浦发银行');
    requests++;
    await gate.promise;
    return searchResponse;
  });
  const first = s.searchSecurities('浦发银行');
  const second = s.searchSecurities('  浦发银行  ');
  try {
    // 同花顺搜索先返回空（测试替身），之后才走东方财富；等它到达东方财富这一步。
    for (let i = 0; i < 20 && !requests; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0].code, '600000');
    assert.equal(b[0].name, '浦发银行');
    assert.equal((await s.searchSecurities('浦发银行'))[0].secid, '1.600000');
    assert.equal(requests, 1);
  } finally { gate.resolve(); await Promise.allSettled([first, second]); await s.shutdownServiceResources(); }
});

test('malformed and failed security suggestions are not cached and later searches recover', async () => {
  const s = searchFixture();
  let requests = 0;
  s.setLoader(async () => {
    requests++;
    if (requests === 1) return { QuotationCodeTable: { Data: { unexpected: true } } };
    if (requests === 2) throw new Error('offline fixture');
    return searchResponse;
  });
  try {
    assert.equal((await s.searchSecurities('浦发银行')).length, 0);
    assert.equal((await s.searchSecurities('浦发银行')).length, 0);
    assert.equal((await s.searchSecurities('浦发银行'))[0].code, '600000');
    assert.equal(requests, 3);
  } finally { await s.shutdownServiceResources(); }
});

test('security search skips malformed individual rows while retaining valid suggestions', async () => {
  const s = searchFixture();
  s.setLoader(async () => ({ QuotationCodeTable: {
    Data: [null, 'bad row', [], ...searchResponse.QuotationCodeTable.Data]
  } }));
  try {
    const rows = await s.searchSecurities('浦发银行');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, '600000');
  } finally { await s.shutdownServiceResources(); }
});
