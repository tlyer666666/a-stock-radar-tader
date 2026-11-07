'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDailyBarStore, lotsConsistent } = require('./daily-bar-store.cjs');
const { createTradingCalendar } = require('./trend-trading-calendar.cjs');

const calendar = createTradingCalendar();
const security = { code: '600001', secid: '1.600001', name: '样本' };
// volume 为手：10 元 × 1000 手 × 100 = 100 万元。
const bar = (date, close = 10) => ({ date, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000, amount: close * 1000 * 100, changePct: 0 });
const download = (through, { close = 10, count = 330 } = {}) => {
  const rows = calendar.sessionsThrough(through, count).map(date => bar(date, close));
  return { rows, adjustment: 'none', source: 'ths-free' };
};
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-bars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function store(dir, extra = {}) {
  return createDailyBarStore({ directory: dir, previousSession: date => calendar.previousSession(date), nextSession: date => calendar.nextSession(date), ...extra });
}
// 2026-10-21 收盘后（上海 15:20）取得的快照。
const AFTER_CLOSE = Date.parse('2026-10-21T15:20:00+08:00');
const snapshot = (overrides = {}) => ({ latest: 10.5, open: 10.1, high: 10.6, low: 10, preClose: 10, volume: 2000, amount: 10.3 * 2000 * 100,
  quoteAt: new Date(AFTER_CLOSE).toISOString(), fetchedAt: AFTER_CLOSE, ...overrides });

test('a first download is saved and the same completed day is then served locally', async t => {
  const dir = tempDir(t); let downloads = 0;
  const first = store(dir);
  const result = await first.history(security, '2026-10-20', async () => { downloads++; return download('2026-10-20'); }, { bars: 320 });
  assert.equal(result.rows.length, 330);
  assert.ok(fs.existsSync(path.join(dir, '600001.json')));
  const second = store(dir);
  const local = await second.history(security, '2026-10-20', async () => { downloads++; throw Error('must not download'); }, { bars: 320 });
  assert.equal(downloads, 1);
  assert.equal(local.rows.length, 330);
  assert.deepEqual(local.rows.at(-1), bar('2026-10-20'));
  assert.equal(local.adjustment, 'none');
  assert.equal(local.provenance.cache, 'local');
});

test('the next session is appended from a verified after-close snapshot instead of downloading again', async t => {
  const dir = tempDir(t);
  await store(dir).history(security, '2026-10-20', async () => download('2026-10-20'), { bars: 320 });
  const quotes = new Map([['600001', snapshot()]]);
  const next = store(dir, { snapshot: async list => { assert.deepEqual(list.map(item => item.code), ['600001']); return quotes; } });
  assert.deepEqual(await next.prepareDay([security, { code: '000002' }], '2026-10-21'), { requested: 1, received: 1 });
  const result = await next.history(security, '2026-10-21', async () => { throw Error('must not download'); }, { bars: 320 });
  const last = result.rows.at(-1);
  assert.equal(last.date, '2026-10-21');
  assert.equal(last.close, 10.5);
  assert.equal(last.preClose, 10);
  assert.ok(Math.abs(last.changePct - 5) < 1e-9);
  assert.equal(result.provenance.cache, 'local+snapshot');
  assert.equal(next.stats().appended, 1);
  const reread = await store(dir).history(security, '2026-10-21', async () => { throw Error('must not download'); }, { bars: 320 });
  assert.equal(reread.rows.at(-1).date, '2026-10-21');
});

test('snapshots that cannot prove a completed, continuous, same-unit bar fall back to a full download', async t => {
  const cases = {
    'ex-rights preClose mismatch': snapshot({ preClose: 8 }),
    'delayed intraday trade time': snapshot({ quoteAt: '2026-10-21T06:57:00.000Z', quoteAtIsTradeTime: true }),
    'suspended stock': snapshot({ volume: 0, amount: 0 }),
    'fetched before the close': snapshot({ fetchedAt: Date.parse('2026-10-21T14:30:00+08:00'), quoteAt: '2026-10-21T06:30:00.000Z' }),
    'fetched after the next open': snapshot({ fetchedAt: Date.parse('2026-10-22T09:40:00+08:00'), quoteAt: '2026-10-22T01:40:00.000Z' }),
    'volume in shares instead of lots': snapshot({ volume: 200000 }),
    'inconsistent high/low': snapshot({ high: 10.2 })
  };
  for (const [label, quote] of Object.entries(cases)) {
    const dir = tempDir(t);
    await store(dir).history(security, '2026-10-20', async () => download('2026-10-20'), { bars: 320 });
    const next = store(dir, { snapshot: async () => new Map([['600001', quote]]) });
    await next.prepareDay([security], '2026-10-21');
    let downloads = 0;
    const result = await next.history(security, '2026-10-21', async () => { downloads++; return download('2026-10-21', { close: 8 }); }, { bars: 320 });
    assert.equal(downloads, 1, label);
    assert.equal(result.rows.at(-1).close, 8, label);
  }
});

test('an eastmoney close snapshot with an after-close trade time is accepted', async t => {
  const dir = tempDir(t);
  await store(dir).history(security, '2026-10-20', async () => download('2026-10-20'), { bars: 320 });
  const next = store(dir, { snapshot: async () => new Map([['600001', snapshot({ quoteAt: '2026-10-21T07:00:03.000Z', quoteAtIsTradeTime: true })]]) });
  await next.prepareDay([security], '2026-10-21');
  const result = await next.history(security, '2026-10-21', async () => { throw Error('must not download'); }, { bars: 320 });
  assert.equal(result.rows.at(-1).date, '2026-10-21');
});

test('a longer history request, a missing day or a corrupt file triggers a full download', async t => {
  const dir = tempDir(t); let downloads = 0;
  const fetch = (through, count = 330) => async () => { downloads++; return download(through, { count }); };
  await store(dir).history(security, '2026-10-20', fetch('2026-10-20', 200), { bars: 200 });
  await store(dir).history(security, '2026-10-20', fetch('2026-10-20'), { bars: 320 });
  assert.equal(downloads, 2, 'stored with fewer requested bars');
  await store(dir).history(security, '2026-10-22', fetch('2026-10-22'), { bars: 320 });
  assert.equal(downloads, 3, 'two sessions behind without a snapshot');
  fs.writeFileSync(path.join(dir, '600001.json'), '{broken');
  await store(dir).history(security, '2026-10-22', fetch('2026-10-22'), { bars: 320 });
  assert.equal(downloads, 4, 'corrupt cache is ignored');
});

test('a recently checked stale stock is reused briefly and other bases are never stored', async t => {
  const dir = tempDir(t); let downloads = 0;
  const suspended = async () => { downloads++; return download('2026-10-16'); };
  const day = store(dir);
  await day.history(security, '2026-10-20', suspended, { bars: 320 });
  const again = await store(dir).history(security, '2026-10-20', suspended, { bars: 320 });
  assert.equal(downloads, 1);
  assert.equal(again.rows.at(-1).date, '2026-10-16');
  const other = { code: '600009', secid: '1.600009' };
  await store(dir).history(other, '2026-10-20', async () => ({ ...download('2026-10-20'), adjustment: 'front' }), { bars: 320 });
  assert.equal(fs.existsSync(path.join(dir, '600009.json')), false);
});

test('a stale tail retries after a short cooldown across store restarts and recovers the same day', async t => {
  const dir = tempDir(t);
  let clock = AFTER_CLOSE, downloads = 0;
  const delayed = async () => { downloads++; return download('2026-10-20'); };
  await store(dir, { now: () => clock }).history(security, '2026-10-21', delayed, { bars: 320 });
  clock += 4 * 60 * 1000;
  const waiting = await store(dir, { now: () => clock }).history(security, '2026-10-21', delayed, { bars: 320 });
  assert.equal(waiting.rows.at(-1).date, '2026-10-20');
  assert.equal(downloads, 1, 'short cooldown survives restart without hammering the provider');
  clock += 2 * 60 * 1000;
  const recovered = await store(dir, { now: () => clock }).history(security, '2026-10-21', async () => {
    downloads++;
    return download('2026-10-21');
  }, { bars: 320 });
  assert.equal(recovered.rows.at(-1).date, '2026-10-21');
  assert.equal(downloads, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '600001.json'), 'utf8')).rows.at(-1)[0], '2026-10-21');
});

test('legacy checkedAsOf files without retry evidence cannot pin stale history for the day', async t => {
  const dir = tempDir(t);
  await store(dir, { now: () => AFTER_CLOSE }).history(security, '2026-10-21', async () => download('2026-10-20'), { bars: 320 });
  const file = path.join(dir, '600001.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.checkedAt;
  fs.writeFileSync(file, JSON.stringify(legacy));
  let downloads = 0;
  const recovered = await store(dir, { now: () => AFTER_CLOSE }).history(security, '2026-10-21', async () => {
    downloads++;
    return download('2026-10-21');
  }, { bars: 320 });
  assert.equal(recovered.rows.at(-1).date, '2026-10-21');
  assert.equal(downloads, 1);
});

test('a verified prepared snapshot can recover a stale tail during its download cooldown', async t => {
  const dir = tempDir(t);
  await store(dir, { now: () => AFTER_CLOSE }).history(security, '2026-10-21', async () => download('2026-10-20'), { bars: 320 });
  const day = store(dir, { now: () => AFTER_CLOSE, snapshot: async () => new Map([['600001', snapshot()]]) });
  await day.prepareDay([security], '2026-10-21');
  const recovered = await day.history(security, '2026-10-21', async () => { throw Error('verified snapshot should suffice'); }, { bars: 320 });
  assert.equal(recovered.rows.at(-1).date, '2026-10-21');
  assert.equal(recovered.rows.at(-1).close, 10.5);
  assert.equal(recovered.provenance.cache, 'local+snapshot');
});

test('a confirmed short listing at asOf does not repeatedly download to satisfy a larger bar request', async t => {
  const dir = tempDir(t);
  let downloads = 0;
  await store(dir, { now: () => AFTER_CLOSE }).history(security, '2026-10-21', async () => {
    downloads++;
    return download('2026-10-21', { count: 20 });
  }, { bars: 320 });
  const local = await store(dir, { now: () => AFTER_CLOSE + 24 * 3600 * 1000 }).history(security, '2026-10-21', async () => {
    downloads++;
    throw Error('the complete short listing was already fetched');
  }, { bars: 320 });
  assert.equal(local.rows.length, 20);
  assert.equal(local.rows.at(-1).date, '2026-10-21');
  assert.equal(downloads, 1);
});

test('preparing the same day twice keeps earlier snapshots and only asks for new codes', async t => {
  const dir = tempDir(t);
  for (const code of ['600001', '600002']) await store(dir).history({ code }, '2026-10-20', async () => download('2026-10-20'), { bars: 320 });
  const asked = [];
  const day = store(dir, { snapshot: async list => { asked.push(list.map(item => item.code)); return new Map(list.map(item => [item.code, snapshot()])); } });
  await day.prepareDay([{ code: '600001' }], '2026-10-21');
  await day.prepareDay([{ code: '600001' }, { code: '600002' }], '2026-10-21');
  assert.deepEqual(asked, [['600001'], ['600002']]);
  for (const code of ['600001', '600002']) {
    const result = await day.history({ code }, '2026-10-21', async () => { throw Error('must not download'); }, { bars: 320 });
    assert.equal(result.rows.at(-1).date, '2026-10-21');
  }
});

test('a failing snapshot source and an unwritable directory never break history reads', async t => {
  const file = path.join(tempDir(t), 'not-a-directory');
  fs.writeFileSync(file, 'x');
  const broken = store(file, { snapshot: async () => { throw Error('rate limited'); } });
  assert.deepEqual(await broken.prepareDay([security], '2026-10-21'), { requested: 0, received: 0 });
  const result = await broken.history(security, '2026-10-20', async () => download('2026-10-20'), { bars: 320 });
  assert.equal(result.rows.length, 330);
  assert.equal(broken.stats().writeFailures, 1);
  assert.equal(lotsConsistent(bar('2026-10-20')), true);
  assert.equal(lotsConsistent({ ...bar('2026-10-20'), volume: 100000 }), false);
});

test('1.6.52: an appended snapshot bar keeps the turnover rate (own value, or derived from the previous bar)', async t => {
  const dir = tempDir(t);
  const withTurnover = date => async () => { const result = download(date); result.rows = result.rows.map(row => ({ ...row, turnover: 2 })); return result; };
  await store(dir).history(security, '2026-10-20', withTurnover('2026-10-20'), { bars: 320 });
  const own = store(dir, { snapshot: async () => new Map([['600001', snapshot({ turnover: 3.25 })]]) });
  await own.prepareDay([security], '2026-10-21');
  assert.equal((await own.history(security, '2026-10-21', async () => { throw Error('no download'); }, { bars: 320 })).rows.at(-1).turnover, 3.25);
  const dir2 = tempDir(t);
  await store(dir2).history(security, '2026-10-20', withTurnover('2026-10-20'), { bars: 320 });
  const derived = store(dir2, { snapshot: async () => new Map([['600001', snapshot()]]) });
  await derived.prepareDay([security], '2026-10-21');
  const row = (await derived.history(security, '2026-10-21', async () => { throw Error('no download'); }, { bars: 320 })).rows.at(-1);
  assert.equal(row.turnover, 4, 'twice the previous volume at the same float shares');
});

for (const [label, corrupt] of [
  ['OHLC conflict', rows => { rows.at(-1).high = 9; }],
  ['duplicate date', rows => { rows.at(-1).date = rows.at(-2).date; }],
  ['missing activity', rows => { delete rows.at(-1).amount; }],
  ['invalid date', rows => { rows.at(-1).date = '2026-02-30'; }]
]) test(`A06 store never persists ${label}, including bad rows after the cutoff`, async t => {
  const dir = tempDir(t), day = store(dir);
  const bad = download('2026-10-21'); corrupt(bad.rows);
  await assert.rejects(day.history(security, '2026-10-20', async () => bad, { bars: 320 }), { code: 'TREND_DATA_UNAVAILABLE' });
  assert.equal(fs.existsSync(path.join(dir, '600001.json')), false);
  const repaired = await day.history(security, '2026-10-20', async () => download('2026-10-20'), { bars: 320 });
  assert.equal(repaired.rows.at(-1).high, 10.1);
  const local = await day.history(security, '2026-10-20', async () => { throw Error('must remain cached'); }, { bars: 320 });
  assert.equal(local.provenance.cache, 'local');
});

for (const [label, corrupt] of [
  ['OHLC conflict', rows => { rows.at(-1)[2] = 9; }],
  ['duplicate date', rows => { rows.at(-1)[0] = rows.at(-2)[0]; }],
  ['missing volume', rows => { rows.at(-1)[5] = null; }],
  ['missing amount', rows => { rows.at(-1)[6] = null; }],
  ['invalid date', rows => { rows.at(-1)[0] = '2026-02-30'; }]
]) test(`A06 semantically corrupt JSON (${label}) is ignored before snapshot preparation and refetched`, async t => {
  const dir = tempDir(t);
  await store(dir).history(security, '2026-10-20', async () => download('2026-10-20'), { bars: 320 });
  const file = path.join(dir, '600001.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  corrupt(saved.rows); fs.writeFileSync(file, JSON.stringify(saved));
  let snapshots = 0, downloads = 0;
  const day = store(dir, { snapshot: async () => { snapshots++; return new Map([['600001', snapshot()]]); } });
  assert.deepEqual(await day.prepareDay([security], '2026-10-21'), { requested: 0, received: 0 });
  const result = await day.history(security, '2026-10-20', async () => { downloads++; return download('2026-10-20'); }, { bars: 320 });
  assert.equal(result.rows.at(-1).high, 10.1);
  assert.equal(downloads, 1); assert.equal(snapshots, 0);
  const reread = await store(dir).history(security, '2026-10-20', async () => { throw Error('repaired cache must persist'); }, { bars: 320 });
  assert.equal(reread.provenance.cache, 'local');
});

test('A06 zero-activity suspension rows and gapped young histories remain valid cache evidence', async t => {
  const dir = tempDir(t), day = store(dir);
  const short = download('2026-10-20', { count: 20 });
  short.rows.splice(5, 1);
  Object.assign(short.rows[8], { volume: 0, amount: 0 });
  await day.history(security, '2026-10-20', async () => short, { bars: 320 });
  const result = await store(dir).history(security, '2026-10-20', async () => { throw Error('listing and suspension policy belongs to engine'); }, { bars: 320 });
  assert.equal(result.rows.length, 19);
  assert.equal(result.rows[8].volume, 0);
  assert.equal(result.rows[8].amount, 0);
});
