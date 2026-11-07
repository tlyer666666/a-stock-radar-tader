'use strict';
// 同花顺扶摇接口客户端：字段口径取自官方文档 https://fuyao.aicubes.cn/docs/api-reference/overview/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFuyaoClient, fuyaoThscode, isIndexSecurity, isFuyaoKey } = require('./fuyao-client.cjs');

const KEY = 'sk-fuyao-test_key_000000000000';
const NOW = Date.parse('2026-10-23T07:30:00Z'); // 北京时间 15:30
const dayMs = (date) => Date.parse(`${date}T00:00:00+08:00`);
const bar = (date, close) => ({ date_ms: dayMs(date), open_price: close - 1, high_price: close + 1, low_price: close - 2, close_price: close, volume: 123400, turnover: 5e6 });

function client(routes, calls = []) {
  return createFuyaoClient({ getApiKey: () => KEY, now: () => NOW, fetchJson: async (url, options, policy) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), key: policy.headers['X-api-key'] });
    const route = routes[parsed.pathname];
    if (!route) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    return typeof route === 'function' ? route(parsed) : route;
  } });
}

test('codes map to THS thscodes and indices are recognised', () => {
  assert.equal(fuyaoThscode({ code: '600519', secid: '1.600519' }), '600519.SH');
  assert.equal(fuyaoThscode({ code: '000001', secid: '0.000001' }), '000001.SZ');
  assert.equal(fuyaoThscode({ code: '000985', secid: '1.000985' }), '000985.SH');
  assert.equal(fuyaoThscode({ code: '920001', secid: '0.920001' }), '920001.BJ');
  assert.equal(isIndexSecurity({ code: '000985', secid: '1.000985' }), true);
  assert.equal(isIndexSecurity({ code: '000001', secid: '0.000001' }), false, '平安银行 is a stock');
  assert.equal(isIndexSecurity({ code: '399006', secid: '0.399006' }), true);
  assert.equal(isFuyaoKey(KEY), true);
  assert.equal(isFuyaoKey('abc'), false);
});

test('stock history sends the key, the adjustment and a millisecond window, and converts shares to lots', async () => {
  const calls = [];
  const c = client({ '/api/a-share/prices/historical': { code: 0, data: { timestamp: NOW, item: [bar('2026-10-21', 10), bar('2026-10-22', 11), bar('2026-10-22', 11)] } } }, calls);
  const rows = await c.dailyHistory({ code: '600000', secid: '1.600000' }, { limit: 120, fqt: 0 });
  assert.equal(calls[0].key, KEY);
  assert.equal(calls[0].params.thscode, '600000.SH');
  assert.equal(calls[0].params.interval, '1d');
  assert.equal(calls[0].params.adjust, 'none');
  assert.ok(Number(calls[0].params.end) === NOW && Number(calls[0].params.start) < NOW - 120 * 86400000);
  assert.deepEqual(rows.map((row) => row.date), ['2026-10-21', '2026-10-22'], 'sorted, de-duplicated Shanghai dates');
  assert.equal(rows[0].volume, 1234);
  assert.equal(rows[0].amount, 5e6);
  assert.equal(rows.index, false);
});

test('index history uses the index endpoint without an adjustment (中证全指 000985.SH)', async () => {
  const calls = [];
  const c = client({ '/api/a-share-index/prices/historical': { code: 0, data: { item: [bar('2026-10-22', 5000)] } } }, calls);
  const rows = await c.dailyHistory({ code: '000985', secid: '1.000985' }, { limit: 300, fqt: 1 });
  assert.equal(calls[0].path, '/api/a-share-index/prices/historical');
  assert.equal(calls[0].params.thscode, '000985.SH');
  assert.equal(calls[0].params.adjust, undefined);
  assert.ok(NOW - Number(calls[0].params.start) <= 5 * 365 * 86400000, 'index window stays within five years');
  assert.equal(rows.index, true);
});

test('business errors keep their meaning', async () => {
  await assert.rejects(client({ '/api/a-share/prices/snapshot': { code: 2001, message: 'invalid key' } }).snapshot([{ code: '600000', secid: '1.600000' }]), { code: 'FUYAO_AUTH' });
  await assert.rejects(client({ '/api/a-share/prices/snapshot': { code: 4001, message: 'slow down' } }).snapshot([{ code: '600000', secid: '1.600000' }]), { code: 'FUYAO_RATE_LIMITED' });
  const noKey = createFuyaoClient({ getApiKey: () => '', fetchJson: async () => { throw new Error('must not request'); } });
  assert.equal(noKey.configured(), false);
  await assert.rejects(noKey.snapshot([{ code: '600000', secid: '1.600000' }]), { code: 'FUYAO_NO_KEY' });
});

test('snapshots are batched by thscode and normalised', async () => {
  const calls = [];
  const c = client({ '/api/a-share/prices/snapshot': (url) => ({ code: 0, data: { timestamp: NOW, item: url.searchParams.get('thscodes').split(',').map((thscode) => ({
    thscode, ticker: thscode.slice(0, 6), last_price: 10.5, price_change: 0.5, price_change_ratio_pct: 5, open_price: 10, high_price: 10.6, low_price: 9.9, prev_price: 10, volume: 1e6, turnover: 1.05e7 })) } }) }, calls);
  const securities = Array.from({ length: 60 }, (_, i) => ({ code: String(600000 + i), secid: `1.${600000 + i}` }));
  const quotes = await c.snapshot(securities);
  assert.equal(calls.length, 2, '50 per request');
  assert.equal(quotes.size, 60);
  const first = quotes.get('600000.SH');
  assert.equal(first.latest, 10.5);
  assert.equal(first.changePct, 5);
  assert.equal(first.volume, 10000);
  assert.equal(first.quoteAt, new Date(NOW).toISOString());
});

test('constituents and trading days', async () => {
  const c = client({
    '/api/a-share-index/constituents/ths-stock-list': { code: 0, data: { item: [{ thscode: '600519.SH', ticker: '600519', name: '贵州茅台' }, { thscode: 'X', ticker: '', name: '' }] } },
    '/api/a-share/calendar/trading-days': { code: 0, data: { item: [{ date: '20261022' }, { date: '20261021' }] } }
  });
  assert.deepEqual(await c.constituents('881101.TI'), [{ thscode: '600519.SH', code: '600519', name: '贵州茅台' }]);
  assert.deepEqual(await c.tradingDays(), ['20261021', '20261022']);
});

test('special data: limit-up pool pages by Shanghai day start, ladder tiers and dragon-tiger rows are normalised', async () => {
  const calls = [];
  const c = client({
    '/api/a-share/special-data/limit-up-pool': () => ({ code: 0, data: { timestamp: NOW, pagination: { total: 1 }, item: [{ thscode: '600001.SH', ticker: '600001', name: '甲', is_st: false,
      last_price: 11, price_change_ratio_pct: 10, limit_up_time: '09:31', limit_up_reason: '机器人+业绩', continue_day_text: '3连板', continue_day_cnt: 3, seal_money: 2e8 }] } }),
    '/api/a-share/special-data/limit-up-ladder': { code: 0, data: { timestamp: NOW, item: [{ date: '20261022', boards: { three_board: [{ thscode: '600001.SH', ticker: '600001', name: '甲', board_num: 3, seal_nextday: null }], two_board: [] } }] } },
    '/api/a-share/special-data/dragon-tiger-list': { code: 0, data: { trade_date: '2026-10-22', count: 1, stock_items: [{ thscode: '600002.SH', ticker: '600002', name: '乙', change: 0.0998, net_value: 1.2e8, org_net_value: 5e7, concept_list: ['机器人'] }],
      hot_money_items: [{ name: '某营业部', buying: 3e7, rows: [{ thscode: '600002.SH', ticker: '600002', name: '乙', hot_money_item_net_value: 2e7 }] }] } }
  }, calls);
  const pool = await c.limitUpPool({ date: '2026-10-22' });
  assert.equal(calls[0].params.date_ms, String(Date.parse('2026-10-22T00:00:00+08:00')));
  assert.equal(calls[0].params.size, '200');
  assert.deepEqual({ code: pool.rows[0].code, boards: pool.rows[0].boards, reason: pool.rows[0].reason }, { code: '600001', boards: 3, reason: '机器人+业绩' });
  const ladder = await c.limitUpLadder();
  assert.equal(ladder.days[0].date, '2026-10-22');
  assert.equal(ladder.days[0].tiers.find((tier) => tier.level === 3).stocks[0].name, '甲');
  const lhb = await c.dragonTiger();
  assert.equal(lhb.stocks[0].net, 1.2e8);
  assert.equal(lhb.stocks[0].changePct, 9.98, '龙虎榜 change 是小数比例，换成百分数');
  assert.equal(lhb.desks[0].stocks[0].net, 2e7);
});

test('成交额量纲校验：换手率不会被当成成交额，缺失量/价时保留原值', async () => {
  const daily = (item) => client({ '/api/a-share/prices/historical': { code: 0, data: { item: [item] } } });
  const row = (patch) => ({ date_ms: dayMs('2026-10-22'), open_price: 9, high_price: 11, low_price: 8, close_price: 10, volume: 123400, ...patch });
  const history = (c) => c.dailyHistory({ code: '600000', secid: '1.600000' }, { limit: 10, fqt: 1 });

  // turnover=2.5 是换手率量级（额/量×价 ≈ 2e-6），必须判为「不是成交额」
  assert.equal((await history(daily(row({ turnover: 2.5 })))).at(-1).amount, null);
  // 真实成交额量级（123400 股 × 10 元 = 1.234e6）→ 保留
  assert.equal((await history(daily(row({ turnover: 1.2e6 })))).at(-1).amount, 1.2e6);
  // 成交量缺失时无法核对量纲 → 保留上游值（不猜测）
  assert.equal((await history(daily(row({ volume: null, turnover: 5e6 })))).at(-1).amount, 5e6);
  // 快照路径同样校验
  const snap = client({ '/api/a-share/prices/snapshot': { code: 0, data: { timestamp: NOW, item: [
    { thscode: '600000.SH', ticker: '600000', last_price: 10, volume: 1e6, turnover: 1e7 },
    { thscode: '600001.SH', ticker: '600001', last_price: 10, volume: 1e6, turnover: 3.2 }
  ] } } });
  const quotes = await snap.snapshot([{ code: '600000', secid: '1.600000' }, { code: '600001', secid: '1.600001' }]);
  assert.equal(quotes.get('600000.SH').amount, 1e7);
  assert.equal(quotes.get('600001.SH').amount, null, '换手率量级不得进入快照成交额');
});

test('hot lists follow THS 1-hour / 24-hour tabs and keep the raw heat text', async () => {
  const calls = [];
  const rows = { code: 0, data: { timestamp: NOW, item: [
    { thscode: '600002.SH', ticker: '600002', name: '乙', rank: 2, heat: '8.6万', rank_change: -1, rank_trend: 'down' },
    { thscode: '600001.SH', ticker: '600001', name: '甲', rank: 1, heat: '1.2亿', rank_change: 3, rank_trend: 'up' }] } };
  const c = client({ '/api/a-share/special-data/hot-stock-list': rows, '/api/a-share/special-data/skyrocket-list': rows }, calls);
  const hour = await c.hotStocks({ period: 'hour' });
  await c.skyrocket({ period: 'day' });
  assert.deepEqual(calls.map((call) => call.params.period), ['hour', 'day']);
  assert.deepEqual(hour.map((row) => [row.code, row.rank, row.heat, row.heatText, row.rankChange]), [['600001', 1, 1.2e8, '1.2亿', 3], ['600002', 2, 86000, '8.6万', -1]]);
  await assert.rejects(c.hotStocks({ period: 'week' }), { code: 'FUYAO_UNSUPPORTED' });
});
