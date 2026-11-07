'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Worker } = require('node:worker_threads');
const os = require('node:os');
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function loadFile(name, append = '', globals = {}, requires = {}) {
  const filename = path.join(__dirname, name), module = { exports: {} }, realRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\n' + append, { module, exports: module.exports,
    require: id => Object.hasOwn(requires, id) ? requires[id] : realRequire(id), __dirname, __filename: filename,
    process, console, URL, DOMException, AbortController, AbortSignal, TextDecoder, Headers, Response, ReadableStream, Buffer,
    setTimeout, clearTimeout, setImmediate, queueMicrotask, fetch: () => { throw new Error('Unexpected external fetch'); }, ...globals }, { filename });
  return module.exports;
}
function payload(close = 10) {
  return { data: { klines: Array.from({ length: 90 }, (_, i) => `${new Date(Date.now() - (89 - i) * 86400000).toISOString().slice(0, 10)},${close},${close},${close + 0.1},${close - 0.1},100000,100000000,1,0,0,1`) } };
}
function response(value) { return { ok: true, status: 200, json: async () => value }; }
function service({ fetch, requires = {}, append = '' } = {}) {
  const network = loadFile('http-client.cjs', '', { fetch: fetch || (() => { throw new Error('Unexpected network'); }) });
  return loadFile('services.cjs', `
    module.exports.probe = { serviceRuntime, eastHistoryCached, historyCache, loadBacktestHistory, tencentHistory, fetchJsonWithCurl,
      setScanToCachedHistory() { loadStrategySignals = async () => ({ rows: await eastHistoryCached({code:'600000',secid:'1.600000'},90,1) }); },
      worker(filename) { return serviceRuntime.run('single','worker',{owner:'worker',requestId:'worker'},()=>serviceRuntime.track(()=>workerRunner.run(filename,{}, {signal:serviceSignal()}))); }
    }; ${append}`, {}, {
    './http-client.cjs': network,
    './news-service.cjs': { getNewsFeed() { throw new Error('Unexpected news'); }, resetNewsCache() {}, shutdownNewsService: async () => {}, classifyEvent() {} },
    './data-federation.cjs': { tencentQuote() { throw new Error('Unexpected external Tencent quote'); }, collectAuxiliarySources() {}, buildQuoteConsensus() {}, shutdownDataFederation: async () => {} },
    'node:child_process': { execFile() { throw new Error('Unexpected curl fallback'); } },
    // 这些用例验证东方财富/腾讯应急链的取消语义；同花顺主源在这里视为不支持，直接进入应急链。
    './ths-free-market.cjs': { ...require('./ths-free-market.cjs'), thsFreeSupports: () => false,
      thsFreeQuote: async () => { throw Object.assign(new Error('ths offline fixture'), { code: 'THS_FREE_UNSUPPORTED' }); },
      thsFreeDailyHistory: async () => { throw Object.assign(new Error('ths offline fixture'), { code: 'THS_FREE_UNSUPPORTED' }); },
      thsFreeKline: async () => { throw Object.assign(new Error('ths offline fixture'), { code: 'THS_FREE_UNSUPPORTED' }); } },
    ...requires
  });
}

test('two distinct scan jobs share real cached history; cancelling A cannot abort B or release A before physical drain', { timeout: 5000 }, async t => {
  const gate = deferred(), entered = deferred(); let calls = 0, requestSignal;
  const s = service({ fetch: async (_, options) => { calls++; requestSignal = options.signal; entered.resolve(); await gate.promise; return response(payload()); } });
  s.probe.setScanToCachedHistory();
  const a = s.scanStrategySignals({ maxUniverse: 40 }, { owner: 'A', requestId: 'same-id' });
  const b = s.scanStrategySignals({ maxUniverse: 41 }, { owner: 'B', requestId: 'same-id' });
  t.after(async () => { gate.resolve(); await Promise.allSettled([a, b]); await s.shutdownServiceResources(); });
  await entered.promise;
  const rejected = assert.rejects(a, { code: 'JOB_CANCELLED' });
  assert.equal(s.cancelServiceJob({ owner: 'A', requestId: 'same-id' }), true);
  await rejected;
  assert.equal(requestSignal.aborted, false);
  assert.equal(s.getServiceDiagnostics().jobs.active, 2);
  let drained = false; a.drained.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  gate.resolve(); assert.equal((await b).rows.length, 90); await Promise.all([a.drained, b.drained]);
  assert.equal(calls, 1); assert.equal(s.getServiceDiagnostics().jobs.active, 0);
});

test('same scan semantics run once and a shorter subscriber timeout does not extend or abort its peer', { timeout: 5000 }, async t => {
  const gate = deferred(), entered = deferred(); let calls = 0, signal;
  const s = service({ fetch: async (_, options) => { calls++; signal = options.signal; entered.resolve(); await gate.promise; return response(payload()); } });
  s.probe.setScanToCachedHistory();
  const a = s.scanStrategySignals({ maxUniverse: 40 }, { owner: 'A', requestId: 'short', timeoutMs: 80 });
  const rejected = assert.rejects(a, { code: 'JOB_TIMEOUT' });
  const b = s.scanStrategySignals({ maxUniverse: 40 }, { owner: 'B', requestId: 'long' });
  t.after(async () => { gate.resolve(); await Promise.allSettled([a, b]); await s.shutdownServiceResources(); });
  await entered.promise; await rejected;
  assert.equal(signal.aborted, false); assert.equal(s.getServiceDiagnostics().jobs.active, 1);
  gate.resolve(); assert.equal((await b).rows[0].close, 10); await b.drained; assert.equal(calls, 1);
});

test('forced history generation wins even if the previous physical response arrives later', { timeout: 5000 }, async t => {
  const old = deferred(), fresh = deferred(), oldEntered = deferred();
  // Capture the response value at request admission, not at resolution.
  let requestIndex = 0;
  const exact = service({ fetch: async () => { const index = ++requestIndex; if (index === 1) oldEntered.resolve(); await (index === 1 ? old.promise : fresh.promise); return response(payload(index === 1 ? 10 : 12)); } });
  t.after(async () => { old.resolve(); fresh.resolve(); await exact.shutdownServiceResources(); });
  const security = { code: '600000', secid: '1.600000' };
  const first = exact.probe.eastHistoryCached(security, 90, 1);
  await oldEntered.promise;
  const newer = exact.probe.eastHistoryCached(security, 90, 1, 60000, { forceRefresh: true });
  fresh.resolve(); assert.equal((await newer)[0].close, 12);
  old.resolve(); assert.equal((await first)[0].close, 10);
  assert.equal((await exact.probe.eastHistoryCached(security, 90, 1))[0].close, 12);
  assert.equal(requestIndex, 2);
});

test('total producer deadline cancels Retry-After backoff without a second fetch or curl fallback', { timeout: 5000 }, async t => {
  let requests = 0, curl = 0;
  const factory = require('./service-runtime.cjs');
  const s = service({ fetch: async () => { requests++; return { ok: false, status: 503, headers: new Headers({ 'retry-after': '1' }), body: new ReadableStream({ start(controller) { controller.close(); } }) }; },
    requires: { './service-runtime.cjs': { ...factory, createServiceRuntime: options => factory.createServiceRuntime({ ...options, jobOptions: { operationTimeouts: { scan: 200, selection: 200 } } }) },
      'node:child_process': { execFile() { curl++; throw new Error('Unexpected fallback after cancellation'); } } } });
  s.probe.setScanToCachedHistory(); t.after(() => s.shutdownServiceResources());
  const pending = s.scanStrategySignals({}, { owner: 'deadline', requestId: 'deadline' });
  await assert.rejects(pending, { code: 'JOB_TIMEOUT' }); await pending.drained;
  await delay(1100);
  assert.equal(requests, 1); assert.equal(curl, 0);
  assert.equal(s.getServiceDiagnostics().jobs.active, 0);
});

test('cancellation during incomplete history does not start a new verified raw fallback', { timeout: 5000 }, async t => {
  const entered = deferred(); let completeRawCalls = 0;
  const s = service(); t.after(() => s.shutdownServiceResources());
  const load = () => new Promise((_, reject) => { const signal = s.probe.serviceRuntime.signal(); entered.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const pending = s.probe.serviceRuntime.run('single', 'amount', { owner: 'amount', requestId: 'amount' }, () =>
    s.probe.loadBacktestHistory({ code: '600000', secid: '1.600000' }, {}, 90,
      { eastmoney: load, public: async () => { throw new Error('unavailable'); }, completeRaw: async () => { completeRawCalls++; throw new Error('must not fetch after abort'); } }, { requireAmount: true }));
  await entered.promise; const rejected = assert.rejects(pending, { code: 'JOB_CANCELLED' });
  s.cancelServiceJob({ owner: 'amount', requestId: 'amount' }); await rejected; await pending.drained;
  assert.equal(completeRawCalls, 0);
});

test('cancellation of Tencent fetch cannot start curl under a service-only signal', { timeout: 5000 }, async t => {
  const entered = deferred(); let curl = 0;
  const s = service({ fetch: async (_, options) => { entered.resolve(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); },
    requires: { 'node:child_process': { execFile() { curl++; throw new Error('post-cancel curl'); } } } });
  t.after(() => s.shutdownServiceResources());
  const pending = s.probe.serviceRuntime.run('single', 'tencent', { owner: 'tencent', requestId: 'tencent' }, () => s.probe.tencentHistory({ code: '600000', secid: '1.600000' }, 90, 0));
  await entered.promise; const rejected = assert.rejects(pending, { code: 'JOB_CANCELLED' });
  s.cancelServiceJob({ owner: 'tencent', requestId: 'tencent' }); await rejected; await pending.drained;
  assert.equal(curl, 0);
});

test('verified raw adapter receives the producer signal and keeps cancelled ownership until its physical request settles', { timeout: 5000 }, async t => {
  const entered = deferred(), physical = deferred(); let signal;
  const s = service({ requires: { './trend-screener-adapter.cjs': { createTrendMarketData() { return {
    fetchHistory: async (_security, _adjustment, options) => { signal = options?.signal; entered.resolve(); await physical.promise; throw new Error('physical request settled'); }
  }; } } } });
  const pending = s.probe.serviceRuntime.run('single', 'verified', { owner: 'verified', requestId: 'verified' }, () =>
    s.probe.loadBacktestHistory({ code: '600000', secid: '1.600000' }, {}, 90,
      { eastmoney: async () => [], public: async () => [] }, { requireAmount: true }));
  t.after(async () => { physical.resolve(); await Promise.allSettled([pending]); await s.shutdownServiceResources(); });
  await entered.promise; const rejected = assert.rejects(pending, { code: 'JOB_CANCELLED' });
  s.cancelServiceJob({ owner: 'verified', requestId: 'verified' }); await rejected;
  assert.ok(signal, 'raw adapter must receive a producer AbortSignal'); assert.equal(signal.aborted, true);
  assert.equal(s.getServiceDiagnostics().jobs.active, 1);
  let drained = false; pending.drained.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  physical.resolve(); await pending.drained; assert.equal(s.getServiceDiagnostics().jobs.active, 0);
});

test('service job retains ownership while a real worker terminates after logical cancellation', { timeout: 5000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-service-worker-'));
  const filename = path.join(directory, 'worker.cjs'); fs.writeFileSync(filename, "setInterval(()=>{},1000);");
  const physical = new Set(), terminationGate = deferred(); let terminationRequested;
  const entered = deferred();
  class SlowTermination extends Worker {
    constructor(...args) { super(...args); physical.add(this); this.once('online', () => entered.resolve()); this.once('exit', () => physical.delete(this)); }
    terminate() { terminationRequested = true; return terminationGate.promise.then(() => super.terminate()); }
  }
  const actual = require('./worker-runner.cjs');
  const s = service({ requires: { './worker-runner.cjs': { ...actual, createWorkerRunner: () => actual.createWorkerRunner({ WorkerClass: SlowTermination }) } } });
  const pending = s.probe.worker(filename);
  t.after(async () => { terminationGate.resolve(); await Promise.allSettled([pending]); await s.shutdownServiceResources(); fs.rmSync(directory, { recursive: true, force: true }); });
  await entered.promise; const rejected = assert.rejects(pending, { code: 'JOB_CANCELLED' });
  s.cancelServiceJob({ owner: 'worker', requestId: 'worker' }); await rejected;
  assert.equal(terminationRequested, true); assert.equal(physical.size, 1); assert.equal(s.getServiceDiagnostics().jobs.active, 1);
  let drained = false; pending.drained.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  terminationGate.resolve(); await pending.drained; assert.equal(physical.size, 0); assert.equal(s.getServiceDiagnostics().jobs.active, 0);
});

test('standalone curl outside any job remains in shutdown ownership until a real delayed child close', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
  const real = require('node:child_process'), ready = deferred(); let child, closed = false;
  const s = service({ requires: { 'node:child_process': { execFile(_file, _args, options, callback) {
    child = real.execFile(process.execPath, ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));process.stdout.write('READY');setInterval(()=>{},1000);"], options, callback);
    child.stdout.on('data', () => ready.resolve()); child.once('close', () => { closed = true; }); return child;
  } } } });
  const request = s.probe.fetchJsonWithCurl('https://offline.invalid/history', 1000);
  const rejection = assert.rejects(request, { name: 'AbortError' });
  t.after(async () => { if (!closed) child?.kill('SIGTERM'); await Promise.allSettled([request]); await s.shutdownServiceResources(); });
  await ready.promise;
  let complete = false; const shutdown = s.shutdownServiceResources().then(() => { complete = true; });
  await delay(30); assert.equal(closed, false); assert.equal(complete, false);
  await shutdown; await rejection; assert.equal(closed, true); assert.equal(complete, true);
});

test('selection adapter cancellation retains every slow physical market request until drained', {timeout:5000},async t=>{
 const physical=deferred(),entered=deferred();let count=0;const start=()=>{if(++count===2)entered.resolve();};
 const actual=require('./strategy-selection-service.cjs');
 const s=service({requires:{
  './strategy-selection-service.cjs':{...actual,createStrategySelectionService:deps=>actual.createStrategySelectionService({...deps,now:()=>new Date('2026-10-21T02:00:00Z')})},
  './trend-screener-adapter.cjs':{createTrendMarketData:()=>({
   fetchUniversePage:async({filter})=>filter==='m:1+t:2'?{total:1,rows:[{code:'600001',name:'样本',secid:'1.600001',industry:'电子'}]}:{total:0,rows:[]},
   fetchBenchmark:()=>{start();return physical.promise;},
   fetchHistory:(_security,_basis,{signal})=>{start();return new Promise((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
  })}
 },append:`topicPoolForDate=async date=>({date,provider:'fixture',sourceDateVerified:true,pool:date==='2026-10-20'?[{code:'600001',name:'样本'}]:[]});`});
 const pending=s.scanStrategySignals({}, {owner:'selection-drain',requestId:'selection-drain'});
 t.after(async()=>{physical.resolve([]);await Promise.allSettled([pending]);await s.shutdownServiceResources();});
 await entered.promise;
 const rejected=assert.rejects(pending,{code:'JOB_CANCELLED'});s.cancelServiceJob({owner:'selection-drain',requestId:'selection-drain'});await rejected;
 let drained=false;pending.drained.then(()=>{drained=true;});await tick();await tick();
 assert.equal(drained,false,'a caller cancellation must not release ownership of an unfinished benchmark request');
 physical.resolve([]);await pending.drained;assert.equal(s.getServiceDiagnostics().jobs.active,0);
});

for (const mode of ['cancel', 'timeout']) test(`sector ${mode} aborts the real composed industry transport without starting another page`, { timeout: 3000 }, async t => {
  const actualExplorer = require('./sector-explorer.cjs'), entered = deferred();
  let calls = 0, signal, bodyCancelled = false;
  const s = service({
    fetch: async (url, options) => {
      assert.match(url, /data\.10jqka\.com\.cn\/funds\/hyzjl\//);
      calls++; signal = options.signal;
      const body = new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from('<tr><td>1</td><td>Industry</td><td>100</td><td>1</td><td>2</td><td>1</td><td>1</td><td>10</td></tr>')); },
        cancel() { bodyCancelled = true; }
      });
      entered.resolve();
      return new Response(body);
    },
    requires: { './sector-explorer.cjs': { createSectorExplorer: options => actualExplorer.createSectorExplorer({ ...options, fetchHtml: async () => '' }) } }
  });
  t.after(() => s.shutdownServiceResources());
  const pending = s.getSectorQuotes({ requestId: `industry-${mode}`, timeoutMs: mode === 'timeout' ? 50 : 1000 });
  const rejected = assert.rejects(pending, mode === 'timeout' ? { code: 'JOB_TIMEOUT' } : { name: 'AbortError' });
  await entered.promise;
  await tick(); // Let the independent concept branch finish before cancellation.
  if (mode === 'cancel') assert.equal((await s.cancelSectorRequest(`industry-${mode}`)).cancelled, true);
  await rejected;
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(bodyCancelled, true);
  assert.equal(calls, 1);
});

test('cancelled THS text keeps producer ownership until its original HTTP request drains', { timeout: 3000 }, async t => {
  const entered = deferred(), physical = deferred();
  const network = loadFile('http-client.cjs', '', { fetch: async () => {
    entered.resolve(); await physical.promise;
    return new Response('callback({"data":"20251024,1,1,1,1,1,1"})');
  } });
  const ths = loadFile('ths-quote.cjs', '', {}, { './http-client.cjs': network });
  const runtime = require('./service-runtime.cjs').createServiceRuntime();
  const pending = runtime.run('single', 'ths-drain', { owner: 'ths-drain', requestId: 'ths-drain' }, () =>
    ths.fetchThsDailyHistory(network.fetchWithPolicy, '881121', { signal: runtime.signal() }));
  const rejected = assert.rejects(pending, { code: 'JOB_CANCELLED' });
  t.after(async () => { physical.resolve(); await Promise.allSettled([pending]); await runtime.shutdown(); });
  await entered.promise;
  runtime.cancel({ owner: 'ths-drain', requestId: 'ths-drain' });
  await rejected;
  let drained = false;
  pending.drained.then(() => { drained = true; });
  await tick();
  assert.equal(network.getHttpDiagnostics().active, 1);
  assert.equal(drained, false, 'logical cancellation must not release unfinished HTTP work');
  assert.equal(runtime.getDiagnostics().jobs.active, 1);
  physical.resolve();
  await pending.drained;
  assert.equal(network.getHttpDiagnostics().active, 0);
  assert.equal(runtime.getDiagnostics().jobs.active, 0);
});

test('sector index cancellation outside producer context remains in module drain ownership', { timeout: 3000 }, async t => {
  const entered = deferred(), physical = deferred();
  const network = loadFile('http-client.cjs', '', { fetch: async () => {
    entered.resolve(); await physical.promise;
    return new Response('callback({"data":"20251024,1,1,1,1,1,1"})');
  } });
  const ths = loadFile('ths-quote.cjs', '', {}, { './http-client.cjs': network });
  const headers = ['序号', '代码', '名称', '现价', '涨跌幅', '涨跌', '涨速', '换手', '量比', '振幅', '成交额', '流通股', '流通市值', '市盈率'];
  const detail = `<input id="baseUrl" value="thshy/detail"><input id="requestQuery" value="code/881121"><table class="m-pager-table"><tr>${headers.map(value => `<th>${value}</th>`).join('')}</tr><tr>${['1', '600000', 'Fixture', '10', '1', '1', '1', '1', '1', '1', '100', '100', '100', '10'].map(value => `<td>${value}</td>`).join('')}</tr></table><span class="page_info">1/1</span>`;
  const explorer = require('./sector-explorer.cjs').createSectorExplorer({
    fetchHtml: async url => url.includes('/detail/') ? detail : '<a href="https://q.10jqka.com.cn/thshy/detail/code/881121/">Fixture</a>',
    loadIndexHistory: (code, { signal }) => ths.fetchThsDailyHistory(network.fetchWithPolicy, code, { signal })
  });
  t.after(async () => { physical.resolve(); await explorer.dispose(); await ths.drainThsQuoteRequests?.(); });
  const catalog = await explorer.getSectorCatalog();
  const pending = explorer.getSectorDetail({ id: catalog.entries[0].id, requestId: 'sector-index-drain' });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  await explorer.cancelSectorRequest('sector-index-drain');
  await rejected;
  await explorer.dispose();
  let drained = false;
  const draining = Promise.resolve(ths.drainThsQuoteRequests?.()).then(() => { drained = true; });
  await tick();
  assert.equal(network.getHttpDiagnostics().active, 1);
  assert.equal(drained, false, 'module drain must retain index work after explorer logical disposal');
  physical.resolve();
  await draining;
  assert.equal(network.getHttpDiagnostics().active, 0);
});

for (const kind of ['index text', 'fund flow']) test(`THS ${kind} retains physical drain after headers when body cancellation is delayed`, { timeout: 3000 }, async t => {
  const entered = deferred(), physical = deferred();
  let bodyController, cancelling = false;
  const network = loadFile('http-client.cjs', '', { fetch: async () => new Response(new ReadableStream({
    start(controller) { bodyController = controller; controller.enqueue(Buffer.from('partial body')); entered.resolve(); },
    cancel() { cancelling = true; return physical.promise; }
  })) });
  const ths = loadFile('ths-quote.cjs', '', {}, { './http-client.cjs': network });
  const runtime = require('./service-runtime.cjs').createServiceRuntime();
  const release = () => { if (!cancelling) { try { bodyController?.close(); } catch { /* Already closed. */ } } physical.resolve(); };
  const pending = runtime.run('single', `ths-body-${kind}`, { owner: 'ths-body', requestId: kind }, () => kind === 'index text'
    ? ths.fetchThsDailyHistory(network.fetchWithPolicy, '881121', { signal: runtime.signal() })
    : ths.fetchThsFundFlow(network.fetchWithPolicy, 'industry', { signal: runtime.signal() }));
  const rejected = assert.rejects(pending, { code: 'JOB_CANCELLED' });
  t.after(async () => { release(); await Promise.allSettled([pending]); await ths.drainThsQuoteRequests(); await runtime.shutdown(); });
  await entered.promise;
  await tick(); // Ensure the Response has returned and its body reader is active.
  runtime.cancel({ owner: 'ths-body', requestId: kind });
  await rejected;
  let jobDrained = false, moduleDrained = false;
  pending.drained.then(() => { jobDrained = true; });
  const draining = ths.drainThsQuoteRequests().then(() => { moduleDrained = true; });
  await tick();
  assert.equal(network.getHttpDiagnostics().active, 1);
  assert.equal(jobDrained, false, 'headers must not transfer unfinished source ownership to a logical race');
  assert.equal(moduleDrained, false);
  assert.equal(runtime.getDiagnostics().jobs.active, 1);
  release();
  await Promise.all([pending.drained, draining]);
  assert.equal(network.getHttpDiagnostics().active, 0);
  assert.equal(runtime.getDiagnostics().jobs.active, 0);
});
