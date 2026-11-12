'use strict';
// 市场宽度、情绪、炸板池：同花顺为主源，东方财富只在同花顺失败时应急。
require('../qa/test-env.cjs'); // 自防御：不依赖运行器预加载，直接 node --test 本文件也禁网
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ALL_A_ROWS = ['2026-10-20', '2026-10-21', '2026-10-22'].map((date, i) => ({ date, open: 1800, high: 1810, low: 1790, close: [1780, 1761.513, 1714.472][i], volume: 1, amount: 1 }));

function load({ fetchJson, quote = async () => ({ changePct: -2.67 }), history = async () => ALL_A_ROWS } = {}) {
  const filename = path.join(__dirname, 'services.cjs'), module = { exports: {} }, realRequire = createRequire(filename);
  const ths = { ...realRequire('./ths-free-market.cjs'), thsFreeQuote: quote, thsFreeDailyHistory: history };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
    module.exports.probe = { wholeMarketSnapshot, marketEmotionSnapshot, topicPoolForDate, recentTradingDates, fuyao,
      setFetch(fn) { fetchJson = fn; } };`, {
    module, exports: module.exports, require: (id) => id === './ths-free-market.cjs' ? ths : realRequire(id), __dirname,
    __filename: filename, process, console, URL, DOMException, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout, setImmediate, Buffer
  }, { filename });
  module.exports.probe.setFetch(fetchJson);
  return module.exports;
}

// 2026-10-22 收盘后同花顺 dq.10jqka.com.cn 涨跌分布的真实响应。
const DISTRIBUTION = { status_code: 0, status_msg: 'success', data: { suspend: 6, last_update_time: '2026-10-22 16:59:46', limit_down: 55, limit_up: 33, flat: 36, up: 535, down: 4999, table: [] } };

test('market breadth comes from the THS up/down distribution and the THS all-A index', async () => {
  const urls = [];
  const s = load({ fetchJson: async (url) => { urls.push(url); return DISTRIBUTION; } });
  try {
    const value = await s.probe.wholeMarketSnapshot({ forceRefresh: true });
    assert.equal(value.source, 'ths_up_down_distribution');
    assert.equal(value.upCount, 535);
    assert.equal(value.downCount, 4999);
    assert.equal(value.flatCount, 36);
    assert.equal(value.stockCount, 5570);
    assert.equal(value.unavailableCount, 6);
    assert.equal(value.averageReturn, -2.67);
    assert.equal(value.benchmarkLabel, '同花顺全A(沪深京)');
    assert.ok(Math.abs(value.breadth - 535 / 5570) < 1e-12);
    assert.deepEqual(urls.map((url) => new URL(url).hostname), ['dq.10jqka.com.cn'], 'no Eastmoney request when THS works');
  } finally { await s.shutdownServiceResources(); }
});

test('a broken THS distribution falls back to Eastmoney and says so', async () => {
  const hosts = [];
  const s = load({ quote: async () => { throw new Error('offline'); }, fetchJson: async (url) => {
    hosts.push(new URL(url).hostname);
    if (url.includes('10jqka')) return { status_code: 0, data: { up: 3, down: 2, flat: 1 } };
    return { data: { total: 0, diff: [] } };
  } });
  try {
    const value = await s.probe.wholeMarketSnapshot({ forceRefresh: true });
    assert.equal(value.source, 'eastmoney_clist');
    assert.match(value.sourceLabel, /应急/);
    assert.ok(hosts.some((host) => host.includes('eastmoney')));
  } finally { await s.shutdownServiceResources(); }
});

test('market emotion uses THS limit-up statistics for the latest trading day', async () => {
  const urls = [];
  const s = load({ fetchJson: async (url) => {
    urls.push(url);
    return { status_code: 0, data: { date: '20261022', info: [], page: { total: 33 },
      limit_up_count: { today: { num: 33 }, yesterday: { num: 50 } }, limit_down_count: { today: { num: 49 }, yesterday: { num: 5 } } } };
  } });
  try {
    const value = await s.probe.marketEmotionSnapshot({ forceRefresh: true });
    assert.equal(value.source, 'ths_limit_up_statistics');
    assert.equal(value.date, '2026-10-22');
    assert.equal(value.limitUpCount, 33);
    assert.equal(value.limitDownCount, 49);
    assert.equal(value.previousLimitUpCount, 50);
    assert.ok(Math.abs(value.indexReturn - ((1714.472 / 1761.513 - 1) * 100)) < 1e-9);
    assert.equal(new URL(urls[0]).searchParams.get('date'), '20261022');
    assert.equal(urls.length, 1);
  } finally { await s.shutdownServiceResources(); }
});

test('THS limit statistics for another day are not used as the latest day', async () => {
  const s = load({ fetchJson: async (url) => {
    if (url.includes('10jqka')) return { status_code: 0, data: { date: '20261021', limit_up_count: { today: { num: 1 }, yesterday: { num: 1 } }, limit_down_count: { today: { num: 1 } } } };
    if (url.includes('kline')) return { data: { code: '000985', klines: Array.from({ length: 10 }, (_, i) => `2026-10-${String(13 + i).padStart(2, '0')},10,10,10,10,1,1,0,0,0,0`) } };
    return { data: { pool: [] } };
  } });
  try {
    const value = await s.probe.marketEmotionSnapshot({ forceRefresh: true });
    assert.equal(value.source, 'eastmoney_topic_pool', 'mismatched THS dates fall back instead of mislabelling the day');
  } finally { await s.shutdownServiceResources(); }
});

test('the failed-board pool reads the THS open-limit pool first and keeps amount and float cap', async () => {
  const urls = [];
  const s = load({ fetchJson: async (url) => {
    urls.push(url);
    return { status_code: 0, data: { date: '20261021', page: { total: 1 }, info: [{ code: '301486', name: '致尚科技', latest: 209.72, change_rate: 17.1228,
      turnover_rate: 15.6016, turnover: 2349440400, currency_value: 15292540000, sum_market_value: 27000033000, last_limit_up_time: '1792548621',
      change_tag: 'LIMIT_FAILED', high_days: null, open_board_count: null }] } };
  } });
  try {
    const pool = await s.probe.topicPoolForDate('2026-10-21', 'failed', { forceRefresh: true });
    assert.equal(pool.provider, 'ths_public_open_limit');
    assert.match(urls[0], /open_limit_pool/);
    assert.equal(pool.serverTradingDate, '2026-10-21');
    assert.equal(pool.pool[0].code, '301486');
    assert.equal(pool.pool[0].amount, 2349440400);
    assert.equal(pool.pool[0].floatMarketCap, 15292540000);
    assert.equal(pool.pool[0].openBoardCount, null, 'a missing open-board count stays unknown');
  } finally { await s.shutdownServiceResources(); }
});

test('a THS pool answered for an earlier day is an empty pool for the requested day, carrying the source date', async () => {
  const s = load({ fetchJson: async () => ({ status_code: 0, data: { date: '20261022', page: { total: 1 }, info: [{ code: '600000', name: '浦发银行', latest: 10 }] } }) });
  try {
    const pool = await s.probe.topicPoolForDate('2026-10-23', 'limit', { forceRefresh: true });
    assert.equal(pool.provider, 'ths_public_limit_up');
    assert.equal(pool.pool.length, 0);
    assert.equal(pool.serverTradingDate, '2026-10-22');
    assert.equal(pool.dateConfirmed, false);
  } finally { await s.shutdownServiceResources(); }
});

test('the trading calendar comes from the THS all-A index', async () => {
  const s = load({ fetchJson: async () => { throw new Error('no Eastmoney'); } });
  try {
    assert.deepEqual([...await s.probe.recentTradingDates(2)], ['20261022', '20261021']);
  } finally { await s.shutdownServiceResources(); }
});

function loadWithFuyao(fake) {
  const filename = path.join(__dirname, 'services.cjs'), module = { exports: {} }, realRequire = createRequire(filename);
  const realFuyao = realRequire('./fuyao-client.cjs');
  const ths = { ...realRequire('./ths-free-market.cjs'), thsFreeDailyHistory: async () => { throw Object.assign(new Error('free THS must not be used'), { code: 'THS_FREE_UNSUPPORTED' }); }, thsFreeQuote: async () => null };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
    module.exports.probe = { eastHistory, loadBacktestHistory, serviceRuntime, setFetch(fn) { fetchJson = fn; } };`, {
    module, exports: module.exports, require: (id) => id === './ths-free-market.cjs' ? ths : id === './fuyao-client.cjs' ? { ...realFuyao, createFuyaoClient: () => fake } : realRequire(id), __dirname,
    __filename: filename, process, console, URL, DOMException, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout, setImmediate, Buffer
  }, { filename });
  module.exports.probe.setFetch(async () => { throw new Error('no Eastmoney'); });
  return module.exports;
}

const WEEKDAYS = Array.from({ length: 60 }, (_, i) => new Date(Date.now() - (59 - i) * 86400000)).filter((d) => d.getUTCDay() % 6 !== 0).map((d) => d.toISOString().slice(0, 10)).slice(-30);
const fuyaoBars = (n, index = false) => Object.assign(WEEKDAYS.slice(0, n).map((date, i) => ({ date, open: 10, high: 20, low: 9, close: 10 + i / 10, volume: 100, volumeUnit: 'lots', amount: 1e5 })), { thscode: index ? '000985.SH' : '600000.SH', index, adjustment: index ? 0 : 1 });

test('with a Fuyao API key, daily history for stocks and 中证全指 comes from Fuyao first', async () => {
  const calls = [];
  const fake = { configured: () => true, snapshot: async () => new Map(), dailyHistory: async (security, options) => { calls.push(`${security.code}:${options.fqt}`); return fuyaoBars(25, security.code === '000985'); } };
  const s = loadWithFuyao(fake);
  try {
    const stock = await s.probe.eastHistory({ code: '600000', secid: '1.600000' }, 25, 1);
    assert.equal(stock.dataSource, 'fuyao_qfq');
    assert.equal(stock.length, 25);
    const index = await s.probe.eastHistory({ code: '000985', secid: '1.000985' }, 25, 1);
    assert.equal(index.dataSource, 'fuyao_index');
    assert.deepEqual(calls, ['600000:1', '000985:1']);
    const lane = s.trendThsLane;
    const benchmark = await lane.benchmark({ code: '000985', secid: '1.000985', thscode: '000985.SH' }, { limit: 25 });
    assert.equal(benchmark.length, 25);
  } finally { await s.shutdownServiceResources(); }
});

test('without a key the Fuyao lane is skipped entirely', async () => {
  const fake = { configured: () => false, dailyHistory: async () => { throw new Error('must not call'); }, snapshot: async () => new Map() };
  const s = loadWithFuyao(fake);
  try {
    assert.equal(await s.trendThsLane.benchmark({ code: '000985', secid: '1.000985' }, { limit: 25 }), null);
    await assert.rejects(s.probe.eastHistory({ code: '600000', secid: '1.600000' }, 25, 1));
  } finally { await s.shutdownServiceResources(); }
});

test('review data from Fuyao: ladder, limit-up reasons, seal rate, hot list and dragon-tiger; one failing block does not sink the rest', async () => {
  const s = (code, name) => ({ code, name, thscode: `${code}.SH` });
  const fake = { configured: () => true, snapshot: async () => new Map(), dailyHistory: async () => { throw new Error('unused'); },
    limitUpPool: async () => ({ total: 3, rows: [
      { ...s('600001', '甲'), boards: 3, boardsText: '3连板', reason: '机器人+业绩增长', sealMoney: 2e8 },
      { ...s('600002', '乙'), boards: 1, boardsText: '首板', reason: '机器人', sealMoney: 1e8 },
      { ...s('600003', '*ST丙'), isSt: true, boards: 1, reason: '摘帽' }] }),
    limitBreakPool: async () => ({ total: 1, rows: [{ ...s('600004', '丁'), changePct: 5 }] }),
    limitDownPool: async () => { throw new Error('HTTP 500'); },
    limitUpLadder: async () => ({ days: [{ date: '2026-10-22', tiers: [{ level: 3, label: '3板', stocks: [{ ...s('600001', '甲'), boards: 3, nextDay: null }] }] }] }),
    hotStocks: async ({ period }) => [{ ...s(period === 'hour' ? '600002' : '600001', period === 'hour' ? '乙' : '甲'), rank: 1, heat: 99, rankChange: 2 }],
    skyrocket: async ({ period }) => period === 'hour' ? [{ ...s('600004', '丁'), rank: 1, heat: 50, rankChange: null }] : [],
    dragonTiger: async () => ({ date: '2026-10-22', count: 2, stocks: [{ ...s('600001', '甲'), net: 1e8 }, { ...s('600002', '乙'), net: 3e8 }], desks: [] }),
    anomalies: async () => ({ rows: [{ ...s('600001', '甲'), tag: '涨停', content: '原因', keywords: [] }] }) };
  const svc = loadWithFuyao(fake);
  try {
    const review = await svc.getFuyaoReviewData({ forceRefresh: true });
    assert.equal(review.available, true);
    assert.equal(review.limitUp.count, 2, 'ST stocks are left out');
    assert.equal(review.limitUp.maxBoards, 3);
    assert.equal(review.limitUp.reasons[0].reason, '机器人');
    assert.equal(review.limitUp.reasons[0].count, 2);
    assert.ok(Math.abs(review.sealRate - 2 / 3) < 1e-12);
    assert.equal(review.limitDown, null);
    assert.match(review.warnings.join(), /跌停池暂不可用/);
    assert.deepEqual([...review.dragonTiger.topNet.map((row) => row.code)], ['600002', '600001']);
    assert.equal(review.ladder.days.length, 1);
    assert.deepEqual(review.hotLists.hour.hot.map((row) => row.code), ['600002'], '1小时 and 24小时 lists are kept apart');
    assert.deepEqual(review.hotLists.day.hot.map((row) => row.code), ['600001']);
    assert.deepEqual(review.hotLists.hour.skyrocket.map((row) => row.code), ['600004']);
    assert.equal(review.hotLists.hour.hot[0].changePct, null, 'no snapshot means no invented change');
  } finally { await svc.shutdownServiceResources(); }
});

test('without a Fuyao key the review section says how to enable it', async () => {
  const svc = loadWithFuyao({ configured: () => false });
  try {
    const review = await svc.getFuyaoReviewData();
    assert.equal(review.available, false);
    assert.match(review.reason, /API Key/);
  } finally { await svc.shutdownServiceResources(); }
});

test('backtest raw history tries THS (Fuyao) before Eastmoney', async () => {
  const calls = [];
  const svc = loadWithFuyao({ configured: () => true, snapshot: async () => new Map(), dailyHistory: async (security, options) => { calls.push(`fuyao:${options.fqt}`); return fuyaoBars(25); } });
  try {
    const rows = await svc.probe.serviceRuntime.run('single', 'bt', { owner: 'bt', requestId: 'bt' }, () =>
      svc.probe.loadBacktestHistory({ code: '600000', secid: '1.600000' }, {}, 25, { eastmoney: async () => { calls.push('east'); return []; } }));
    assert.equal(rows.dataSource, 'fuyao_unadjusted');
    assert.deepEqual(calls, ['fuyao:0']);
  } finally { await svc.shutdownServiceResources(); }
});

test('a Fuyao snapshot is merged as a new daily bar only when its previous close matches the last bar', () => {
  const { fuyaoQuoteBelongsAfter } = require('./services.cjs');
  const rows = [{ date: '2026-10-21', close: 10 }, { date: '2026-10-22', close: 10.5 }];
  const quote = (preClose, date = "2026-10-23") => ({ preClose, latest: 10.8, open: 10.6, volume: 100, amount: 108000, quoteAt: `${date}T07:00:00Z`, quoteAtIsTradeTime: true });
  assert.equal(fuyaoQuoteBelongsAfter(rows, quote(10.5), '2026-10-23'), true, "today's session follows yesterday's close");
  assert.equal(fuyaoQuoteBelongsAfter(rows, quote(10), '2026-10-23'), false, "pre-open snapshot still showing yesterday must not become a fake today bar");
  assert.equal(fuyaoQuoteBelongsAfter(rows, quote(10, '2026-10-22'), '2026-10-22'), true, 'same-day refresh checks against the bar before');
  assert.equal(fuyaoQuoteBelongsAfter(rows, quote(10.5), '2026-10-20'), false, 'older snapshots are ignored');
  assert.equal(fuyaoQuoteBelongsAfter(rows, { preClose: 10.5, latest: 10.8, open: 0 }, '2026-10-23'), false, 'no open yet');
});

test('the THS open-limit pool has no open-board count, so it is filled from the fuyao limit-break pool when a key is set', async () => {
  const s = load({ fetchJson: async () => ({ status_code: 0, data: { date: '20261021', page: { total: 2 }, info: [
    { code: '301486', name: '致尚科技', latest: 209.72, change_rate: 17.1, last_limit_up_time: '1792548621', change_tag: 'LIMIT_FAILED', open_board_count: null },
    { code: '600001', name: '演示一', latest: 10, change_rate: 5, last_limit_up_time: '1792548621', change_tag: 'LIMIT_FAILED', open_board_count: null }] } }) });
  const calls = [];
  s.probe.fuyao.configured = () => true;
  s.probe.fuyao.limitBreakPool = async (options) => { calls.push(options.date); return { rows: [{ code: '301486', openTimes: 3 }], total: 1 }; };
  try {
    const pool = await s.probe.topicPoolForDate('2026-10-21', 'failed', { forceRefresh: true });
    assert.deepEqual(calls, ['2026-10-21']);
    assert.equal(pool.pool.find(row => row.code === '301486').openBoardCount, 3);
    assert.equal(pool.pool.find(row => row.code === '600001').openBoardCount, null, 'a stock fuyao does not list stays unknown');
    await s.probe.topicPoolForDate('2026-10-21', 'failed', { forceRefresh: true });
    assert.equal(calls.length, 1, 'the billed fuyao pool is cached');
  } finally { await s.shutdownServiceResources(); }
});
