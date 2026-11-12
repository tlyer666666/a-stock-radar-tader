'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t, members, read) {
  const filename = path.join(__dirname, 'services.cjs'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
    module.exports.fixture = {
      setup(members, read) {
        sectorStrength = async () => ({ name: '元件', code: '881270', constituents: members, score: 65 });
        eastHistoryCached = async () => [];
        wholeMarketSnapshot = async () => ({ breadth: .5, averageReturn: 0, stockCount: 0 });
        currentLadderPools = async () => ({ currentPool: [], previousPool: [], failedPool: [] });
        fetchJson = read;
      },
      close: () => serviceRuntime.shutdown()
    };`, {
    module, exports: module.exports, require: createRequire(filename), __dirname, __filename: filename,
    process, console, URL, URLSearchParams, DOMException, AbortController, AbortSignal, TextDecoder,
    setTimeout, clearTimeout, setImmediate, queueMicrotask, Buffer,
    fetch: async () => { throw Error('Unexpected direct network'); }
  }, { filename });
  const service = module.exports;
  service.fixture.setup(members, read);
  t.after(() => service.fixture.close());
  return options => service.analyzeSector({ code: '881270', name: '元件', ...options });
}
const member = (code, extra = {}) => ({ code, name: code, latest: 10, changePct: 1, ...extra });
const epoch = Math.floor(Date.now() / 1000) - 10;
const payload = rows => ({ rc: 0, data: { total: rows.length, diff: rows } });
const money = (code, value, market = 1) => ({ f12: code, f13: market, f62: value, f124: epoch });

test('THS sector stocks receive independent Eastmoney main-net amounts in yuan without changing prices or scores', async t => {
  const original = [member('600519'), member('688981')];
  const load = fixture(t, original, async url => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('fltt'), '2');
    assert.equal(query.get('secids'), '1.600519,1.688981');
    assert.ok(query.get('fields').split(',').includes('f62'));
    return payload([money('600519', 60852848), money('688981', -3474000)]);
  });
  const result = await load();
  assert.equal(result.constituents[0].mainNetInflow, 60852848);
  assert.equal(result.constituents[1].mainNetInflow, -3474000);
  assert.equal(result.constituents[0].latest, 10);
  assert.equal(result.score, 65);
  assert.equal(result.fundFlow.loaded, 2);
  assert.equal(result.fundFlow.status, 'ready');
  assert.equal(result.constituents[0].fundFlowSource, '东方财富');
  assert.equal(result.constituents[0].fundFlowAsOf, new Date(epoch * 1000).toISOString());
  assert.equal(original[0].mainNetInflow, undefined);
});

test('missing amounts remain unknown, explicit zero survives, and exchange mismatches cannot attach money to another security', async t => {
  const load = fixture(t, [member('600519'), member('688981'), member('000001'), member('920096')], async () => payload([
    money('600519', 900, 0), money('688981', '--'), money('000001', 0, 0), money('920096', -10000, 0), money('600999', 1234)
  ]));
  const result = await load();
  assert.equal(result.constituents[0].mainNetInflow, null);
  assert.equal(result.constituents[1].mainNetInflow, null);
  assert.equal(result.constituents[2].mainNetInflow, 0);
  assert.equal(result.constituents[3].mainNetInflow, -10000);
  assert.equal(result.fundFlow.status, 'partial');
  assert.equal(result.fundFlow.loaded, 2);
});

test('primary funds failure uses the independent delayed endpoint and retains source provenance', async t => {
  const origins = [];
  const load = fixture(t, [member('600519')], async url => {
    origins.push(new URL(url).hostname);
    if (origins.length === 1) throw Error('primary offline');
    return payload([money('600519', 1000)]);
  });
  const result = await load();
  assert.deepEqual(origins, ['push2.eastmoney.com', 'push2delay.eastmoney.com']);
  assert.equal(result.constituents[0].mainNetInflow, 1000);
  assert.match(result.constituents[0].fundFlowSource, /延迟/);
});

test('funds outages preserve stock rows and unknown values, and the next request can recover', async t => {
  let failed = true;
  const load = fixture(t, [member('600519')], async () => {
    if (failed) throw Error('funds unavailable');
    return payload([money('600519', 500)]);
  });
  const first = await load();
  assert.equal(first.constituents.length, 1);
  assert.equal(first.constituents[0].latest, 10);
  assert.equal(first.constituents[0].mainNetInflow, null);
  assert.equal(first.fundFlow.status, 'unavailable');
  failed = false;
  assert.equal((await load()).constituents[0].mainNetInflow, 500);
});

test('identical concurrent requests share funds work and explicit refresh bypasses its minute cache', async t => {
  let calls = 0;
  const load = fixture(t, [member('600519')], async () => {
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    return payload([money('600519', calls * 100)]);
  });
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(calls, 1);
  assert.equal(a.constituents[0].mainNetInflow, 100);
  assert.equal(b.constituents[0].mainNetInflow, 100);
  assert.equal((await load()).constituents[0].mainNetInflow, 100);
  assert.equal((await load({ forceRefresh: true })).constituents[0].mainNetInflow, 200);
  assert.equal(calls, 2);
});

test('large sectors use batches of at most 100 with at most two physical loaders', async t => {
  let active = 0, peak = 0, calls = 0;
  const stocks = Array.from({ length: 251 }, (_, i) => member(String(600100 + i)));
  const load = fixture(t, stocks, async url => {
    calls++; peak = Math.max(peak, ++active);
    const ids = new URL(url).searchParams.get('secids').split(',');
    assert.ok(ids.length <= 100);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return payload(ids.map(id => money(id.split('.')[1], 100)));
  });
  const result = await load();
  assert.equal(result.fundFlow.loaded, 251);
  assert.equal(calls, 3);
  assert.ok(peak <= 2);
});

test('local transport overload and oversized responses cannot trigger extra fallback traffic', async t => {
  for (const code of ['QUEUE_FULL', 'QUEUE_TIMEOUT', 'RESPONSE_TOO_LARGE']) {
    let calls = 0;
    const load = fixture(t, [member('600519')], async () => {
      calls++;
      throw Object.assign(new Error('local transport rejection'), { code });
    });
    assert.equal((await load()).fundFlow.status, 'unavailable');
    assert.equal(calls, 1, code);
  }
});

test('live quotes from the same request replace the member page values (pre-open the page still shows yesterday), and limit-ups follow the live price', async t => {
  const stale = [member('600519', { latest: 12.79, changePct: 3.23, amount: 1.94e8, turnover: 5.27 }), member('000001', { latest: 9, changePct: 1, amount: 5e8, turnover: 2 })];
  const load = fixture(t, stale, async url => {
    const query = new URL(url).searchParams;
    assert.match(query.get('fields'), /f2,f3,f5,f6,f8/);
    return payload([{ f12: '600519', f13: 1, f62: 0, f124: epoch, f2: 13.2, f3: 10, f6: 3.1e6, f8: 0.08, f18: 12 },
      { f12: '000001', f13: 0, f62: 0, f124: epoch - 86400 * 2, f2: 9.1, f3: 1.1, f6: 6e8, f8: 2.1, f18: 9 }]);
  });
  const result = await load();
  const live = result.constituents.find(row => row.code === '600519');
  assert.deepEqual([live.latest, live.changePct, live.amount, live.turnover, live.quoteStatus], [13.2, 10, 3.1e6, 0.08, 'live']);
  assert.equal(live.isLimitUp, true, 'limit-up by today\'s price against the live previous close');
  const old = result.constituents.find(row => row.code === '000001');
  assert.equal(old.amount, 5e8, 'a quote not stamped today does not overwrite the page values');
  assert.equal(old.quoteStatus, undefined);
  assert.deepEqual([result.fundFlow.quotes.loaded, result.fundFlow.quotes.total], [1, 2]);
  assert.equal(result.constituents[0].code, '600519', 'members are re-sorted by the live change');
  assert.equal(result.limitUps, null, 'individual live quotes cannot establish the full sector count without a complete membership/pool snapshot');
  assert.equal(result.countComplete, false);
});
