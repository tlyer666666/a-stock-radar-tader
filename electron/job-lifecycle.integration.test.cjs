'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), { spawn } = require('node:child_process'), { Worker } = require('node:worker_threads');
const { createJobLifecycle } = require('./job-lifecycle.cjs');
const { createWorkerRunner } = require('./worker-runner.cjs');
const { fetchJsonWithPolicy, runWithTransportSlot, getHttpDiagnostics } = require('./http-client.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(predicate, timeout = 3000) { const end = performance.now() + timeout; while (!predicate()) { assert.ok(performance.now() < end, 'bounded integration wait expired'); await delay(5); } }
function request(id, more = {}) { return { owner: 1, requestId: id, operation: 'single', key: 'shared', ...more }; }
async function server(t, handler) {
  const instance = http.createServer(handler); await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}
test('shared real HTTP body survives one subscriber cancel and physical counters drain after its peer reads it', async t => {
  let response, received = 0;
  const url = await server(t, (_req, res) => { received++; response = res; res.writeHead(200); res.write('{"value":'); });
  const jobs = createJobLifecycle(); t.after(() => jobs.shutdown());
  const a = jobs.subscribe(request('a'), ctx => ctx.track(() => fetchJsonWithPolicy(url, { signal: ctx.signal })));
  const b = jobs.subscribe(request('b', { owner: 2 }), () => { throw new Error('must share'); });
  await until(() => response);
  const rejected = assert.rejects(a, { code: 'JOB_CANCELLED' }); jobs.cancel({ owner: 1, requestId: 'a' }); await rejected;
  assert.equal(getHttpDiagnostics().active, 1); assert.equal(received, 1);
  response.end('7}'); assert.deepEqual(await b, { value: 7 }); await a.drained;
  assert.equal(jobs.getDiagnostics().active, 0); assert.equal(getHttpDiagnostics().active, 0);
});
test('cancelled job waiting behind eight real HTTP bodies issues no later request', async t => {
  let received = 0;
  const url = await server(t, (_req, res) => { received++; res.writeHead(200); res.write('{'); });
  const blockers = new AbortController();
  const held = Array.from({ length: 8 }, () => fetchJsonWithPolicy(url, { signal: blockers.signal }).catch(error => error));
  const jobs = createJobLifecycle();
  try {
    await until(() => received === 8);
    const queued = jobs.subscribe(request('queued'), ctx => ctx.track(() => fetchJsonWithPolicy(url + '/never', { signal: ctx.signal })));
    await until(() => getHttpDiagnostics().pending === 1);
    const rejected = assert.rejects(queued, { code: 'JOB_CANCELLED' }); jobs.cancel({ owner: 1, requestId: 'queued' }); await rejected; await queued.drained;
    blockers.abort(); await Promise.all(held); await delay(20);
    assert.equal(received, 8); assert.equal(getHttpDiagnostics().pending, 0); assert.equal(jobs.getDiagnostics().active, 0);
  } finally { blockers.abort(); await Promise.all(held); await jobs.shutdown(); }
});
test('job deadline interrupts HTTP Retry-After and prevents the next physical attempt', async t => {
  let calls = 0;
  const url = await server(t, (_req, res) => { calls++; res.writeHead(429, { 'Retry-After': '1' }); res.end('retry later'); });
  const jobs = createJobLifecycle({ operationTimeouts: { single: 250 } });
  const job = jobs.subscribe(request('deadline'), ctx => ctx.track(() => fetchJsonWithPolicy(url, { signal: ctx.signal }, { retries: 4 })));
  await assert.rejects(job, { code: 'JOB_TIMEOUT' }); await job.drained;
  assert.equal(calls, 1); assert.equal(getHttpDiagnostics().active, 0); assert.equal(jobs.getDiagnostics().active, 0);
});
test('job cancellation returns promptly while a real SIGTERM subprocess keeps both job and transport leases until close', { skip: process.platform === 'win32' }, async () => {
  const jobs = createJobLifecycle({ maxActive: 1 }), ready = deferred(); let child, closed = false;
  const job = jobs.subscribe(request('child'), ctx => ctx.track(() => runWithTransportSlot(() => new Promise(resolve => {
    child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));process.stdout.write('ready');setInterval(()=>{},1000);"], { signal: ctx.signal });
    child.on('error', () => {}); child.stdout.once('data', ready.resolve);
    child.once('close', () => { closed = true; resolve(); });
  }), { url: 'http://child.local', signal: ctx.signal })));
  try {
    await ready.promise;
    const rejected = assert.rejects(job, { code: 'JOB_CANCELLED' }); jobs.cancel({ owner: 1, requestId: 'child' }); await rejected;
    assert.equal(closed, false); assert.equal(jobs.getDiagnostics().active, 1); assert.equal(getHttpDiagnostics().active, 1);
    await job.drained; assert.equal(closed, true); assert.equal(jobs.getDiagnostics().active, 0); assert.equal(getHttpDiagnostics().active, 0);
  } finally { if (child && !closed) child.kill('SIGKILL'); await jobs.shutdown(); }
});
test('real worker termination is tracked past logical cancellation and no heavy slot is returned before exit', async () => {
  let worker, exited = false;
  class ObservedWorker extends Worker { constructor(...args) { super(...args); worker = this; this.once('exit', () => { exited = true; }); } }
  const runner = createWorkerRunner({ WorkerClass: ObservedWorker, maxConcurrent: 1 }), jobs = createJobLifecycle({ maxActive: 1 });
  const ready = new Int32Array(new SharedArrayBuffer(4));
  const source = "import { workerData } from 'node:worker_threads'; Atomics.store(new Int32Array(workerData.ready),0,1); while(true) {}";
  const job = jobs.subscribe(request('worker'), ctx => ctx.track(() => runner.run(new URL('data:text/javascript,' + encodeURIComponent(source)), { ready: ready.buffer }, { signal: ctx.signal })));
  try {
    await until(() => Atomics.load(ready, 0) === 1);
    const rejected = assert.rejects(job, { code: 'JOB_CANCELLED' }); jobs.cancel({ owner: 1, requestId: 'worker' }); await rejected;
    assert.equal(exited, false); assert.equal(jobs.getDiagnostics().active, 1);
    await job.drained; assert.equal(exited, true); assert.equal(jobs.getDiagnostics().active, 0);
  } finally { if (worker && !exited) await worker.terminate(); await runner.shutdown(); await jobs.shutdown(); }
});
test('producer-only async scopes isolate shared cache HTTP cancellation while parent leases conservatively await child drain', async t => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const scopes = new AsyncLocalStorage(), parents = createJobLifecycle(), cache = createJobLifecycle();
  let response, physicalSignal, firstParentSignal, calls = 0;
  const url = await server(t, (_req, res) => { calls++; response = res; res.writeHead(200); res.write('{"shared":'); });
  const load = ctx => scopes.run(ctx, () => {
    const parentContext = scopes.getStore();
    return parentContext.track(() => cache.subscribe({ owner: 1, requestId: `child-${parentContext === firstContext ? 'one' : 'two'}`, operation: 'cache', key: 'common', signal: parentContext.signal }, childContext => scopes.run(childContext, () => {
      physicalSignal = scopes.getStore().signal;
      return childContext.track(() => fetchJsonWithPolicy(url, { signal: physicalSignal }));
    })));
  });
  let firstContext;
  const a = parents.subscribe(request('one', { key: 'parent-one' }), ctx => { firstContext = ctx; firstParentSignal = ctx.signal; return load(ctx); });
  const b = parents.subscribe(request('two', { key: 'parent-two' }), load);
  try {
    await until(() => response);
    assert.notEqual(firstParentSignal, physicalSignal);
    const rejected = assert.rejects(a, { code: 'JOB_CANCELLED' }); parents.cancel({ owner: 1, requestId: 'one' }); await rejected;
    assert.equal(physicalSignal.aborted, false); assert.equal(parents.getDiagnostics().active, 2); assert.equal(cache.getDiagnostics().active, 1);
    response.end('true}'); assert.deepEqual(await b, { shared: true }); await Promise.all([a.drained, b.drained]);
    assert.equal(calls, 1); assert.equal(parents.getDiagnostics().active, 0); assert.equal(cache.getDiagnostics().active, 0);
  } finally { await Promise.all([parents.shutdown(), cache.shutdown()]); }
});
