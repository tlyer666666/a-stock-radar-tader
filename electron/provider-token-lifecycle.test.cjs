'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createServiceRuntime } = require('./service-runtime.cjs');
const { producerContext } = require('./service-context.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function load(name, requires = {}, append = '') {
  const filename = path.join(__dirname, name), requireActual = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\n' + append, {
    module, exports: module.exports, require: id => requires[id] || requireActual(id), __dirname, __filename: filename,
    process, console, URL, DOMException, AbortController, AbortSignal, TextDecoder, Buffer,
    setTimeout, clearTimeout, setImmediate, queueMicrotask
  }, { filename });
  return module.exports;
}
const stock = { code: '600000', thscode: '600000.SH', name: '离线银行' };
const quote = { code: 0, data: { fields: ['trade_date', 'close'], items: [['20260930', 10.5]] } };
const token = { data: { access_token: 'shared-access', expires_in: 3600 } };

for (const kind of ['token', 'tushare']) {
  test(`${kind} producer survives one parent cancellation while its peer retains the shared response`, async t => {
    const callers = createServiceRuntime(), gate = deferred();
    let calls = 0, physicalSignal;
    const fetchJson = (_url, options = {}) => {
      calls++; physicalSignal = options.signal || producerContext.getStore()?.signal;
      return new Promise((resolve, reject) => {
        physicalSignal?.addEventListener('abort', () => reject(physicalSignal.reason), { once: true });
        gate.promise.then(resolve);
      });
    };
    const api = kind === 'token' ? load('ths-token-manager.cjs')
      : load('data-federation.cjs', { './http-client.cjs': { fetchJsonWithPolicy: fetchJson } });
    const invoke = () => kind === 'token'
      ? api.getThsAccessToken('fixture-refresh', fetchJson, { cacheKey: 'shared', baseUrl: 'https://offline.invalid' })
      : api.tushareDailyQuote(stock, 'fixture-token');
    const a = callers.run('single', 'first', { requestId: 'first' }, invoke);
    const b = callers.run('single', 'second', { requestId: 'second' }, invoke);
    a.catch(() => {}); b.catch(() => {});
    t.after(async () => { gate.resolve(kind === 'token' ? token : quote); await Promise.allSettled([a, b]); await callers.shutdown(); await (kind === 'token' ? api.shutdownThsTokenManager?.() : api.shutdownDataFederation()); });
    await tick();
    callers.cancel({ owner: 'local', requestId: 'first' });
    await assert.rejects(a, { code: 'JOB_CANCELLED' });
    assert.equal(physicalSignal?.aborted, false);
    gate.resolve(kind === 'token' ? token : quote);
    const result = await b;
    assert.equal(kind === 'token' ? result : result.latest, kind === 'token' ? 'shared-access' : 10.5);
    assert.equal(calls, 1);
  });

  test(`${kind} last parent cancellation aborts physical work and cannot publish the abandoned result`, async t => {
    const callers = createServiceRuntime(), gate = deferred();
    let calls = 0, physicalSignal;
    const fetchJson = (_url, options = {}) => { calls++; physicalSignal = options.signal || producerContext.getStore()?.signal; return calls === 1 ? gate.promise : Promise.resolve(kind === 'token' ? token : quote); };
    const api = kind === 'token' ? load('ths-token-manager.cjs')
      : load('data-federation.cjs', { './http-client.cjs': { fetchJsonWithPolicy: fetchJson } });
    const invoke = () => kind === 'token'
      ? api.getThsAccessToken('fixture-refresh', fetchJson, { cacheKey: 'abandoned', baseUrl: 'https://offline.invalid' })
      : api.tushareDailyQuote(stock, 'fixture-token');
    const job = callers.run('single', 'only', { requestId: 'only' }, invoke); job.catch(() => {});
    t.after(async () => { gate.resolve(kind === 'token' ? token : quote); await Promise.allSettled([job]); await callers.shutdown(); await (kind === 'token' ? api.shutdownThsTokenManager?.() : api.shutdownDataFederation()); });
    await tick();
    callers.cancel({ owner: 'local', requestId: 'only' });
    await assert.rejects(job, { code: 'JOB_CANCELLED' });
    assert.equal(physicalSignal?.aborted, true);
    assert.equal(callers.getDiagnostics().jobs.active, 1, 'physical loader has not settled yet');
    gate.resolve(kind === 'token' ? token : quote); await job.drained;
    await invoke();
    assert.equal(calls, 2, 'the abandoned success must not become a cache hit');
  });
}

test('Tencent cancellation reaches its HTTP boundary and auxiliary downgrade does not restart work', async t => {
  const callers = createServiceRuntime(); let signal, calls = 0;
  const api = load('data-federation.cjs', { './http-client.cjs': { fetchArrayBufferWithPolicy: (_url, options) => {
    calls++; signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } });
  const job = callers.run('single', 'quote', { requestId: 'quote' }, () => api.collectAuxiliarySources(stock)); job.catch(() => {});
  t.after(async () => { await api.shutdownDataFederation(); await callers.shutdown(); });
  await tick(); callers.cancel({ owner: 'local', requestId: 'quote' });
  await assert.rejects(job, { code: 'JOB_CANCELLED' });
  assert.equal(signal.aborted, true);
  await job.drained;
  assert.equal(calls, 1);
});

test('zero-lifetime server tokens are refreshed on the next call rather than extended by cache defaults', async t => {
  const api = load('ths-token-manager.cjs'); t.after(() => api.shutdownThsTokenManager());
  let calls = 0;
  const fetchJson = async () => ({ data: { access_token: `short-${++calls}`, expires_in: 0 } });
  const options = { cacheKey: 'short-expiry', baseUrl: 'https://offline.invalid' };
  assert.equal(await api.getThsAccessToken('refresh', fetchJson, options), 'short-1');
  assert.equal(await api.getThsAccessToken('refresh', fetchJson, options), 'short-2');
});

test('cancelled parent cannot trigger a new token refresh when its old request later rejects authentication', async t => {
  const api = load('ths-token-manager.cjs'), callers = createServiceRuntime(), gate = deferred();
  let tokenCalls = 0, providerCalls = 0;
  const job = callers.run('single', 'auth', { requestId: 'auth' }, () => api.withThsAccessToken('refresh',
    async () => { tokenCalls++; return token; }, async () => {
      providerCalls++; await gate.promise; throw Object.assign(Error('access token expired'), { status: 401 });
    }, { cacheKey: 'cancel-auth', baseUrl: 'https://offline.invalid' }));
  job.catch(() => {});
  t.after(async () => { gate.resolve(); await callers.shutdown(); await api.shutdownThsTokenManager(); });
  await tick(); assert.equal(providerCalls, 1);
  callers.cancel({ owner: 'local', requestId: 'auth' });
  await assert.rejects(job, { code: 'JOB_CANCELLED' });
  gate.resolve(); await job.drained;
  assert.equal(tokenCalls, 1);
  assert.equal(providerCalls, 1);
});

test('federation shutdown also waits for unscoped physical HTTP completion and rejects new work', async t => {
  const gate = deferred(); let signal, calls = 0;
  const api = load('data-federation.cjs', { './http-client.cjs': { fetchArrayBufferWithPolicy: (_url, options) => {
    calls++; signal = options.signal; return gate.promise;
  } } });
  const request = api.tencentQuote(stock); request.catch(() => {});
  t.after(async () => { gate.resolve(new Uint8Array()); await Promise.allSettled([request]); await api.shutdownDataFederation(); });
  let stopped = false;
  const stopping = api.shutdownDataFederation().then(() => { stopped = true; });
  await tick(); assert.equal(signal.aborted, true); assert.equal(stopped, false);
  gate.resolve(new Uint8Array()); await assert.rejects(request, { name: 'AbortError' }); await stopping;
  await assert.rejects(api.tencentQuote(stock), { name: 'AbortError' });
  assert.equal(calls, 1);
});
