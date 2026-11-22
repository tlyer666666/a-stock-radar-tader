'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSectorLimitCounts } = require('./sector-limit-counts.cjs');
const day = '2026-11-11';
const board = { boardType: 'concept', code: '885959', conceptCid: '308832', name: 'PCB概念' };
const stock = code => ({ code, name: `股票${code}` });
function fixture(overrides = {}) {
  let time = Date.parse(`${day}T10:00:00+08:00`), membersCalls = 0, poolCalls = 0;
  const service = createSectorLimitCounts({ now: () => time,
    loadMembers: async () => { membersCalls++; return { members: [stock('300001'), stock('300002')], complete: true }; },
    loadPool: async () => { poolCalls++; return { stocks: [stock('300001'), stock('300002'), stock('600001')], complete: true, asOfDate: day }; }, ...overrides });
  return { service, advance: ms => { time += ms; }, calls: () => [membersCalls, poolCalls] };
}
test('all actual members count independently of leader/reason and duplicate pool rows', async t => {
  const { service } = fixture({ loadPool: async () => ({ stocks: [stock('300001'), stock('300002'), stock('300002'), stock('600001')], complete: true, asOfDate: day }) });
  t.after(() => service.shutdown());
  const result = await service.count(board);
  assert.equal(result.limitUps, 2); assert.equal(result.countComplete, true);
  assert.deepEqual(result.limitUpStocks.map(x => x.code), ['300001', '300002']);
});
test('all matched stocks are returned and source freshness time is preserved', async t => {
  const stocks = Array.from({ length: 100 }, (_, i) => stock(String(300000 + i)));
  const fetchedAt = '2026-11-11T09:59:50+08:00';
  const { service } = fixture({ loadMembers: async () => ({ members: stocks, complete: true }),
    loadPool: async () => ({ stocks, complete: true, asOfDate: day, fetchedAt }) });
  t.after(() => service.shutdown()); const result = await service.count(board);
  assert.equal(result.limitUps, 100); assert.equal(result.limitUpStocks.length, 100); assert.equal(result.fetchedAt, fetchedAt);
});
test('zero requires complete members and pool, partial members provide only a positive lower bound', async t => {
  for (const [membersComplete, poolComplete, matching, expected, complete] of [
    [true, true, false, 0, true], [false, true, true, 1, false], [false, true, false, null, false],
    [true, false, true, null, false], [true, false, false, null, false]
  ]) {
    const { service } = fixture({ loadMembers: async () => ({ members: [stock('300001')], complete: membersComplete }),
      loadPool: async () => ({ stocks: matching ? [stock('300001')] : [], complete: poolComplete, asOfDate: day }) });
    t.after(() => service.shutdown()); const result = await service.count(board);
    assert.equal(result.limitUps, expected); assert.equal(result.countComplete, complete);
  }
});
test('member totals and invalid rows prevent false confirmed zero', async t => {
  const { service } = fixture({ loadMembers: async () => ({ members: [stock('bad')], complete: true }) });
  t.after(() => service.shutdown()); assert.equal((await service.count({ ...board, memberCount: 100 })).limitUps, null);
});
test('failures are unknown and retryable; same simultaneous request is shared', async t => {
  let calls = 0;
  const { service } = fixture({ loadMembers: async () => { calls++; if (calls === 1) throw new Error('offline'); return { members: [stock('300001')], complete: true }; } });
  t.after(() => service.shutdown());
  const failed = await Promise.all([service.count(board), service.count(Object.fromEntries(Object.entries(board).reverse()))]);
  assert.equal(calls, 1); assert.equal(failed[0].limitUps, null);
  assert.equal((await service.count(board)).limitUps, 1); assert.equal(calls, 2);
});
test('60-second pool cache and force refresh reuse four-hour members', async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  await f.service.count(board); await f.service.count(board); assert.deepEqual(f.calls(), [1, 1]);
  await Promise.all([f.service.count(board, { forceRefresh: true }), f.service.count(board, { forceRefresh: true })]);
  assert.deepEqual(f.calls(), [1, 2]);
  f.advance(61000); await f.service.count(board); assert.deepEqual(f.calls(), [1, 3]);
  f.advance(4 * 3600000); await f.service.count(board); assert.deepEqual(f.calls(), [2, 4]);
});
test('Shanghai midnight partitions both caches and rejects yesterday pool', async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  await f.service.count(board); f.advance(14 * 3600000);
  const result = await f.service.count(board); assert.deepEqual(f.calls(), [2, 2]);
  assert.equal(result.limitUps, null); assert.equal(result.countComplete, false);
});
test('date mismatch and stale pools never produce a confirmed count', async t => {
  for (const override of [{ asOfDate: '2026-11-10' }, { asOfDate: day, stale: true }, { asOfDate: 'bad' }]) {
    const { service } = fixture({ loadPool: async () => ({ stocks: [], complete: true, ...override }) });
    t.after(() => service.shutdown()); assert.equal((await service.count(board)).limitUps, null);
  }
  const { service } = fixture({ loadMembers: async () => ({ members: [stock('300001')], complete: true, asOfDate: '2026-11-10' }) });
  t.after(() => service.shutdown()); assert.equal((await service.count(board)).limitUps, null);
});
test('weekends use the last exchange trading date and compact pool dates are accepted', async t => {
  const { service } = fixture({ now: () => Date.parse('2026-11-14T10:00:00+08:00'),
    loadPool: async () => ({ stocks: [], complete: true, asOfDate: '20261113' }) });
  t.after(() => service.shutdown()); const result = await service.count(board);
  assert.equal(result.limitUps, 0); assert.equal(result.asOfDate, '2026-11-13');
});
test('partial membership and failed pool remain retryable, while different boards share the pool', async t => {
  let membersCalls = 0, poolCalls = 0;
  const { service } = fixture({
    loadMembers: async () => ({ members: [stock('300001')], complete: ++membersCalls > 1 }),
    loadPool: async () => { if (++poolCalls === 1) throw new Error('pool offline'); return { stocks: [stock('300001')], complete: true, asOfDate: day }; }
  });
  t.after(() => service.shutdown());
  assert.equal((await service.count(board)).limitUps, null);
  assert.equal((await service.count(board)).limitUps, 1);
  assert.equal(membersCalls, 2); assert.equal(poolCalls, 2);
  await service.count({ boardType: 'industry', code: '881270' });
  assert.equal(membersCalls, 3); assert.equal(poolCalls, 2);
});
test('clear invalidates in-flight output and cannot repopulate an old cache generation', async t => {
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const { service } = fixture({ loadMembers: async () => { calls++; if (calls === 1) await gate; return { members: [stock('300001')], complete: true }; } });
  t.after(() => service.shutdown()); const first = service.count(board);
  await new Promise(setImmediate); service.clear(); release();
  assert.equal((await first).limitUps, null);
  assert.equal((await service.count(board)).limitUps, 1); assert.equal(calls, 2);
});
test('strict identity rejects arbitrary codes, missing concept ID and conflicting industry identity', async t => {
  const f = fixture(); t.after(() => f.service.shutdown());
  for (const input of [{ ...board, conceptCid: '' }, { ...board, code: '../../secret' }, { ...board, conceptCid: 'x' },
    { boardType: 'industry', code: '885959' }, { boardType: 'industry', code: '881270', indexCode: '881001' }, { code: '881270' }]) {
    await assert.rejects(f.service.count(input), /板块|概念|行业/);
  }
  assert.deepEqual(f.calls(), [0, 0]);
  assert.equal((await f.service.count({ boardType: 'industry', code: '881270' })).limitUps, 2);
});
test('one cancelled subscriber does not abort shared members for remaining subscriber', async t => {
  let release, signal, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const { service } = fixture({ loadMembers: async (_, options) => { calls++; signal = options.signal; await gate; return { members: [stock('300001')], complete: true }; } });
  t.after(() => service.shutdown()); const controller = new AbortController();
  const first = service.count(board, { signal: controller.signal }); const second = service.count(board);
  const rejected = assert.rejects(first, /abort|取消/i); await new Promise(setImmediate); controller.abort();
  assert.equal(signal.aborted, false); release(); await rejected;
  assert.equal((await second).limitUps, 1); assert.equal(calls, 1);
});
test('shutdown aborts loaders and waits for physical completion; concurrency and queue are bounded', async () => {
  const releases = [], signals = []; let active = 0, peak = 0;
  const { service } = fixture({ loadMembers: (_, { signal }) => new Promise(resolve => {
    signals.push(signal); active++; peak = Math.max(peak, active);
    releases.push(() => { active--; resolve({ members: [stock('300001')], complete: true }); });
  }) });
  const requests = Array.from({ length: 43 }, (_, i) => service.count({ boardType: 'industry', code: String(881000 + i) }).then(() => 'ok', error => error.code || error.name));
  await new Promise(setImmediate); assert.equal(peak, 2); assert.equal(await requests[42], 'SERVICE_BUSY');
  let drained = false; const closing = service.shutdown().then(() => { drained = true; });
  await new Promise(setImmediate); assert.equal(drained, false); assert.ok(signals.every(signal => signal.aborted));
  releases.forEach(release => release()); await closing; await Promise.all(requests);
  assert.equal(service.getDiagnostics().jobs.active, 0);
  await assert.rejects(service.count(board), /退出|取消|abort/i);
});

test('sortSectorBoardRows ranks verified 0-limit-up sectors ahead of unmapped null sectors on ties', () => {
  const { sortSectorBoardRows } = require('./services/sectors.cjs');
  const sorted = sortSectorBoardRows([
    { name: '未映射未知', memberAverageReturn: 2.5, poolLimitUps: null },
    { name: '确认零涨停', memberAverageReturn: 2.5, poolLimitUps: 0 },
    { name: '两只涨停', memberAverageReturn: 2.5, poolLimitUps: 2 },
    { name: '无涨幅未知', memberAverageReturn: null, poolLimitUps: null },
    { name: '无涨幅零涨停', memberAverageReturn: null, poolLimitUps: 0 }
  ]);
  assert.deepEqual(
    sorted.map(row => row.name),
    ['两只涨停', '确认零涨停', '未映射未知', '无涨幅零涨停', '无涨幅未知']
  );
  assert.deepEqual(sorted.map(row => row.rank), [1, 2, 3, 4, 5]);
});

test('getLimitUpSectorBoardUncached degrades cleanly when discoverLimitUps fails and primary sector table is healthy', async t => {
  const sectors = require('./services/sectors.cjs');
  const limitPool = require('./services/limit-pool.cjs');
  const thsOfficial = require('./ths-quote.cjs');
  const originalFetch = global.fetch;
  const originalFundFlow = thsOfficial.fetchThsFundFlow;
  const originalDiscover = limitPool.discoverLimitUps;
  sectors.sectorProviderHealth.clear();
  t.after(() => {
    global.fetch = originalFetch;
    thsOfficial.fetchThsFundFlow = originalFundFlow;
    limitPool.discoverLimitUps = originalDiscover;
    sectors.sectorProviderHealth.clear();
  });
  limitPool.discoverLimitUps = async () => { throw new Error('limit-up pool unavailable'); };
  thsOfficial.fetchThsFundFlow = async () => [
    { code: '881121', name: '半导体', changePct: 3.2, inflow: 50, outflow: 30, netInflow: 20, companyCount: 120, leaderName: '中芯国际', leaderChangePct: 6.5, leaderPrice: 90 },
    { code: '881155', name: '银行', changePct: 1.1, inflow: 20, outflow: 18, netInflow: 2, companyCount: 42, leaderName: '招商银行', leaderChangePct: 2.1, leaderPrice: 38 }
  ];
  global.fetch = async () => new Response('upstream failure', { status: 503 });
  const rows = await sectors.getLimitUpSectorBoardUncached({});
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.name), ['半导体', '银行']);
  assert.equal(rows[0].poolLimitUps, null, 'unknown limit-up count stays null when limit-up pool fails');
  assert.equal(rows[1].poolLimitUps, null);
});
