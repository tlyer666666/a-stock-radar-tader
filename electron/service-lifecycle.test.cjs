'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise private cache boundaries in isolated module contexts. All providers
// are replaced at their boundary; no test contacts markets or user storage.
function load(name, append = '', globals = {}, requires = {}) {
  const filename = path.join(__dirname, name), realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\n' + append, {
    module, exports: module.exports, require: id => requires[id] || realRequire(id),
    __dirname, __filename: filename, process, console, URL, DOMException,
    AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout,
    setImmediate, queueMicrotask, Buffer, fetch: async () => { throw new Error('Unexpected network'); }, ...globals
  }, { filename });
  return module.exports;
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('curl fallback shares physical HTTP admission and drains every callback', async () => {
  const http = require('./http-client.cjs');
  const callbacks = [];
  let active = 0, peak = 0;
  const s = load('services.cjs', 'module.exports.probe = { fetchJson };', {}, {
    './http-client.cjs': { ...http, fetchJsonWithPolicy: async () => { throw new Error('provider unavailable'); } },
    'node:child_process': { execFile(_file, _args, _options, done) {
      active++; peak = Math.max(peak, active);
      callbacks.push(() => { active--; done(null, '{}', ''); });
    } }
  });
  const jobs = Array.from({ length: 20 }, (_, i) => s.probe.fetchJson(`https://fixture-${i}.eastmoney.com/api/qt`));
  const settled = Promise.allSettled(jobs);
  try {
    await tick();
    assert.ok(peak <= 8, `curl started ${peak} physical subprocesses`);
  } finally {
    for (let i = 0; i < 30; i++) { for (const finish of callbacks.splice(0)) finish(); await tick(); }
    await settled;
  }
  assert.equal(active, 0);
  assert.equal(http.getHttpDiagnostics().active, 0);
});

test('local queue overload cannot amplify provider traffic through curl fallback', async () => {
  let spawned = 0;
  const s = load('services.cjs', 'module.exports.probe = { fetchJson };', {}, {
    './http-client.cjs': { fetchJsonWithPolicy: async () => { throw Object.assign(new Error('full'), { code: 'QUEUE_FULL' }); } },
    'node:child_process': { execFile(_file, _args, _options, done) { spawned++; done(null, '{}', ''); } }
  });
  await assert.rejects(s.probe.fetchJson('https://push2.eastmoney.com/api/qt'), { code: 'QUEUE_FULL' });
  assert.equal(spawned, 0);
});

test('sector stale fallback releases single-flight and expires before the next refresh', async () => {
  let clock = 1_000_000, calls = 0;
  class FakeDate extends Date { static now() { return clock; } }
  const s = load('services.cjs', 'module.exports.probe = { sectorStrengthCache, setLoader(fn) { loadSectorStrength = fn; } };', { Date: FakeDate });
  s.probe.sectorStrengthCache.set('银行', { value: { name: 'old' }, expiresAt: clock - 1, staleUntil: clock + 100 });
  s.probe.setLoader(async () => { calls++; return null; });
  assert.equal((await s.sectorStrength('银行')).partial, true);
  clock += 31 * 60 * 1000;
  s.probe.setLoader(async () => { calls++; return { name: 'recovered' }; });
  assert.equal((await s.sectorStrength('银行', { options: { forceRefresh: true } })).name, 'recovered');
  assert.equal(calls, 2);
});

test('sector thrown failure releases stale fallback so recovered data can load', async () => {
  const s = load('services.cjs', 'module.exports.probe = { sectorStrengthCache, setLoader(fn) { loadSectorStrength = fn; } };');
  s.probe.sectorStrengthCache.set('银行', { value: { name: 'old' }, expiresAt: 0, staleUntil: Date.now() + 10000 });
  s.probe.setLoader(async () => { throw new Error('offline'); });
  assert.equal((await s.sectorStrength('银行')).partial, true);
  s.probe.setLoader(async () => ({ name: 'recovered' }));
  assert.equal((await s.sectorStrength('银行')).name, 'recovered');
});

test('news cold callers share source work and reset prevents an older completion replacing fresh news', async () => {
  const n = load('news-service.cjs', 'module.exports.probe = { cachedSource, sourceCaches };');
  const old = deferred(), fresh = deferred(); let calls = 0;
  const first = n.probe.cachedSource('fast', 6000, () => { calls++; return old.promise; });
  const second = n.probe.cachedSource('fast', 6000, () => { calls++; return old.promise; });
  await tick(); assert.equal(calls, 1);
  n.resetNewsCache();
  const afterReset = n.probe.cachedSource('fast', 6000, () => fresh.promise);
  fresh.resolve(['new']); await afterReset;
  old.resolve(['old']); await Promise.all([first, second]);
  assert.equal(n.probe.sourceCaches.fast.value[0], 'new');
});

test('strategy scans bound distinct active jobs without evicting first job single-flight', async () => {
  const s = load('services.cjs', 'module.exports.probe = { setLoader(fn) { loadStrategySignals = fn; }, strategySignalCache };');
  const gate = deferred(); let calls = 0;
  s.probe.setLoader(() => { calls++; return gate.promise; });
  const first = s.scanStrategySignals({ maxUniverse: 40 });
  const second = s.scanStrategySignals({ maxUniverse: 41 });
  try {
    const third = s.scanStrategySignals({ maxUniverse: 42 });
    const result = await Promise.race([third.then(() => 'resolved', err => err.code), tick().then(() => 'pending')]);
    assert.equal(result, 'SERVICE_BUSY');
    await assert.rejects(s.scanStrategySignals({ maxUniverse: 40, refresh: true }), { code: 'SERVICE_BUSY' });
    const duplicate = s.scanStrategySignals({ maxUniverse: 40 });
    await tick(); assert.equal(calls, 2);
    gate.resolve({ marker: 'complete' });
    await Promise.all([first, second, duplicate]);
    for (let i = 0; i < 15; i++) await s.scanStrategySignals({ maxUniverse: 100 + i });
    assert.ok(s.probe.strategySignalCache.size <= 12);
  } finally { gate.resolve({}); await Promise.all([first, second]); }
});

test('legacy JSON caller abort prevents provider calls and fallback subprocesses', async () => {
  let calls = 0, subprocesses = 0;
  const fakeFetch = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  const s = load('services.cjs', 'module.exports.probe = { fetchJson };', { fetch: fakeFetch }, {
    './http-client.cjs': load('http-client.cjs', '', { fetch: fakeFetch }),
    'node:child_process': { execFile() { subprocesses++; throw new Error('Must not spawn'); } }
  });
  const controller = new AbortController(); controller.abort(new Error('cancelled test'));
  await assert.rejects(s.probe.fetchJson('https://push2.eastmoney.com/api/qt', { signal: controller.signal }), /cancelled test/);
  assert.equal(calls, 0); assert.equal(subprocesses, 0);
});

test('service shutdown aborts active network work and refuses new work', async () => {
  const entered = deferred();
  const fakeFetch = async (_, { signal }) => {
    entered.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const s = load('services.cjs', 'module.exports.probe = { fetchJson };', { fetch: fakeFetch }, {
    './http-client.cjs': load('http-client.cjs', '', { fetch: fakeFetch })
  });
  assert.equal(typeof s.shutdownServiceResources, 'function');
  const pending = s.probe.fetchJson('https://offline.invalid/');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise; await s.shutdownServiceResources(); await rejected;
  await assert.rejects(s.probe.fetchJson('https://offline.invalid/'), { name: 'AbortError' });
});

test('service shutdown waits for an already aborted physical request to settle', async () => {
  const entered = deferred(), released = deferred();
  const fakeFetch = async () => { entered.resolve(); await released.promise; return { ok: true, json: async () => ({}) }; };
  const s = load('services.cjs', 'module.exports.probe = { fetchJson };', { fetch: fakeFetch }, {
    './http-client.cjs': load('http-client.cjs', '', { fetch: fakeFetch })
  });
  const job = s.probe.fetchJson('https://offline.invalid/');
  const rejected = assert.rejects(job, { name: 'AbortError' });
  await entered.promise;
  let finished = false;
  const shutdown = s.shutdownServiceResources().then(() => { finished = true; });
  await tick();
  try { assert.equal(finished, false); }
  finally { released.resolve(); await rejected; await shutdown; }
});

test('single-stock selected replay and per-strategy breakdown compute in a worker with the existing engine contract', async () => {
  const engine = require('./strategy-signal-engine.cjs');
  const s = load('services.cjs', '', {}, { './strategy-signal-engine.cjs': {
    ...engine, buildSelectedStrategyReplay() { throw new Error('Replay must not run on the main thread'); }
  } });
  assert.equal(typeof s.buildSingleStockReplaysInWorker, 'function');
  const { buildSelectedStrategyReplay, STRATEGY_DEFINITIONS } = engine;
  const ids = STRATEGY_DEFINITIONS.slice(0, 2).map(row => row.id);
  const security = { code: '600001', name: '离线样本' };
  const rows = Array.from({ length: 100 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), open: 10, high: 10.2, low: 9.8, close: 10, volume: 100000, amount: 1000000 }));
  let yielded = false;
  const pending = s.buildSingleStockReplaysInWorker(ids, security, rows, rows, {});
  await tick(); yielded = true;
  const result = await pending;
  assert.equal(yielded, true);
  assert.deepEqual(result.replay.samples, buildSelectedStrategyReplay(ids, security, rows, rows, {}).samples);
  for (const id of ids) assert.deepEqual(result.replaysById[id].validation, buildSelectedStrategyReplay([id], security, rows, rows, {}).validation);
});

test('heavy job admission is shared across scan and backtest before any backtest data loads', async () => {
  const s = load('services.cjs', 'module.exports.probe = { setLoader(fn) { loadStrategySignals = fn; } };');
  const gate = deferred(); let loads = 0;
  s.probe.setLoader(() => gate.promise);
  const first = s.scanStrategySignals({ maxUniverse: 40 });
  const second = s.scanStrategySignals({ maxUniverse: 41 });
  try {
    await assert.rejects(s.runPortfolioBacktest({ securities: ['600001'] }, {}, {
      resolveSecurity: async () => { loads++; throw new Error('Must not load'); }
    }), { code: 'SERVICE_BUSY' });
    assert.equal(loads, 0);
  } finally { gate.resolve({}); await Promise.all([first, second]); }
});

test('sector disposal aborts named and anonymous work, drains queue and rejects future requests', async () => {
  const { createSectorExplorer } = require('./sector-explorer.cjs');
  const gate = deferred(); let calls = 0;
  const signals = [];
  const sector = createSectorExplorer({ seeds: [], fetchHtml: async (_, { signal }) => {
    signals.push(signal); calls++; await gate.promise; return '';
  } });
  assert.equal(typeof sector.dispose, 'function');
  const jobs = [sector.getSectorCatalog({ requestId: 'named' }), sector.getSectorCatalog(), sector.getSectorCatalog({ requestId: 'queued' })];
  const rejections = jobs.map(job => assert.rejects(job, { name: 'AbortError' }));
  await tick(); assert.equal(calls, 2);
  const disposing = sector.dispose();
  assert.equal(signals.every(signal => signal.aborted), true);
  await rejections[2];
  await assert.rejects(sector.getSectorCatalog(), { name: 'AbortError' });
  let finished = false; disposing.then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  gate.resolve(); await Promise.all(rejections); await disposing;
  assert.equal(calls, 2);
});

test('news and auxiliary provider shutdown cancels their own active HTTP calls', async () => {
  for (const [filename, hook, append, invoke] of [
    ['news-service.cjs', 'shutdownNewsService', 'module.exports.probe = { fetchJson };', service => service.probe.fetchJson('https://offline.invalid/')],
    ['data-federation.cjs', 'shutdownDataFederation', '', service => service.tencentQuote({ code: '600001', thscode: '600001.SH' })]
  ]) {
    const entered = deferred(); let calls = 0;
    const request = async (_, options) => {
      calls++; entered.resolve();
      options.signal?.throwIfAborted();
      return new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    };
    const service = load(filename, append, {}, { './http-client.cjs': { fetchJsonWithPolicy: request, fetchArrayBufferWithPolicy: request } });
    assert.equal(typeof service[hook], 'function', `${filename} shutdown exists`);
    const job = invoke(service), rejected = assert.rejects(job, { name: 'AbortError' });
    await entered.promise; service[hook](); await rejected;
    await assert.rejects(invoke(service), { name: 'AbortError' });
    assert.equal(calls, 1);
  }
});

test('cancelled curl fallback retains its transport slot until the real subprocess closes', { skip: process.platform === 'win32' }, async () => {
  const childProcess = require('node:child_process');
  const transport = require('./http-client.cjs');
  const ready = deferred(), closed = deferred();
  let child, physicallyClosed = false;
  const s = load('services.cjs', 'module.exports.probe = { fetchJsonWithCurl };', {}, {
    'node:child_process': { execFile(_file, _args, options, callback) {
      child = childProcess.execFile(process.execPath, ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));process.stdout.write('ready');setInterval(()=>{},1000);"], options, callback);
      child.stdout.on('data', () => ready.resolve());
      child.once('close', () => { physicallyClosed = true; closed.resolve(); });
      return child;
    } }
  });
  const controller = new AbortController();
  const pending = s.probe.fetchJsonWithCurl('http://127.0.0.1/offline-child', 1000, '', controller.signal);
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  try {
    await ready.promise; controller.abort(); await tick();
    assert.equal(physicallyClosed, false);
    assert.equal(transport.getHttpDiagnostics().active, 1, 'AbortError callback does not prove physical process exit');
    await closed.promise; await rejection;
    assert.equal(transport.getHttpDiagnostics().active, 0);
  } finally {
    if (child && !physicallyClosed) child.kill('SIGKILL');
    await closed.promise; await rejection; await s.shutdownServiceResources();
  }
});

for (const malformed of [false, true]) test(`curl ${malformed ? 'parse failure' : 'successful JSON'} settles only after real subprocess close`, async () => {
  const childProcess = require('node:child_process');
  let physicallyClosed = false;
  const s = load('services.cjs', 'module.exports.probe = { fetchJsonWithCurl };', {}, {
    'node:child_process': { execFile(_file, _args, options, callback) {
      const script = malformed ? "process.stdout.write('{bad');" : "process.stdout.write(JSON.stringify({ok:true}));";
      const child = childProcess.execFile(process.execPath, ['-e', script], options, callback);
      child.once('close', () => { physicallyClosed = true; });
      return child;
    } }
  });
  try {
    const pending = s.probe.fetchJsonWithCurl('http://127.0.0.1/offline-child', 1000);
    if (malformed) await assert.rejects(pending, /非JSON/);
    else assert.equal((await pending).ok, true);
    assert.equal(physicallyClosed, true);
    assert.equal(require('./http-client.cjs').getHttpDiagnostics().active, 0);
  } finally { await s.shutdownServiceResources(); }
});

test('curl spawn ENOENT without a real pid rejects after close and releases its transport slot', async () => {
  const childProcess = require('node:child_process');
  let child, physicallyClosed = false;
  const s = load('services.cjs', 'module.exports.probe = { fetchJsonWithCurl };', {}, {
    'node:child_process': { execFile(_file, args, options, callback) {
      child = childProcess.execFile(path.join(__dirname, '__synthetic_missing_executable__'), args, options, callback);
      child.once('close', () => { physicallyClosed = true; });
      return child;
    } }
  });
  try {
    await assert.rejects(s.probe.fetchJsonWithCurl('http://127.0.0.1/offline-child', 1000), /ENOENT|行情备用通道失败/);
    assert.equal(child.pid, undefined); assert.equal(physicallyClosed, true);
    assert.equal(require('./http-client.cjs').getHttpDiagnostics().active, 0);
  } finally { await s.shutdownServiceResources(); }
});

test('a synchronous curl spawn failure rejects and releases admission without waiting for a nonexistent child', async () => {
  const s = load('services.cjs', 'module.exports.probe = { fetchJsonWithCurl };', {}, {
    'node:child_process': { execFile() { throw Object.assign(new Error('synthetic spawn failure'), { code: 'SPAWN_SYNTHETIC' }); } }
  });
  try {
    await assert.rejects(s.probe.fetchJsonWithCurl('http://127.0.0.1/offline-child', 1000), { code: 'SPAWN_SYNTHETIC' });
    assert.equal(require('./http-client.cjs').getHttpDiagnostics().active, 0);
  } finally { await s.shutdownServiceResources(); }
});
