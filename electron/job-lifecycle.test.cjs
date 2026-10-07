'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let createJobLifecycle;
try { ({ createJobLifecycle } = require('./job-lifecycle.cjs')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function group(options = {}) { assert.equal(typeof createJobLifecycle, 'function', 'job lifecycle implementation exists'); return createJobLifecycle(options); }
function request(requestId, overrides = {}) { return { operation: 'single', key: 'same', owner: 1, requestId, ...overrides }; }
function aborted(signal) { if (signal.aborted) return Promise.reject(signal.reason); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }

test('same-key peers share one producer while cancelling one owner leaves its peer alive', async () => {
  const jobs = group(), gate = deferred(); let calls = 0, signal;
  const a = jobs.subscribe(request('a'), ctx => { calls++; signal = ctx.signal; return gate.promise; });
  const b = jobs.subscribe(request('a', { owner: 2 }), () => { throw new Error('must share producer'); });
  const rejected = assert.rejects(a, { code: 'JOB_CANCELLED', name: 'AbortError' });
  assert.equal(jobs.cancel({ owner: 1, requestId: 'a' }), true); await rejected;
  assert.equal(signal.aborted, false); assert.equal(calls, 1);
  gate.resolve('shared'); assert.equal(await b, 'shared'); await a.drained;
  assert.equal(jobs.getDiagnostics().active, 0); assert.equal(jobs.getDiagnostics().requests, 0);
});
test('first subscriber deadline does not become a shared producer deadline', async () => {
  const jobs = group(), gate = deferred(); let signal;
  const a = jobs.subscribe(request('short', { timeoutMs: 10 }), ctx => { signal = ctx.signal; return gate.promise; });
  const b = jobs.subscribe(request('peer'), () => { throw new Error('must share'); });
  await assert.rejects(a, { code: 'JOB_TIMEOUT' }); assert.equal(signal.aborted, false);
  gate.resolve(42); assert.equal(await b, 42); await b.drained;
});
test('producer operation deadline aborts every subscriber without resetting for a later join', async () => {
  const jobs = group({ operationTimeouts: { single: 30 } }); let signal;
  const a = jobs.subscribe(request('first'), ctx => { signal = ctx.signal; return aborted(ctx.signal); });
  const rejectedA = assert.rejects(a, { code: 'JOB_TIMEOUT' });
  await delay(5);
  const b = jobs.subscribe(request('later', { timeoutMs: 180000 }), () => {});
  await Promise.all([rejectedA, assert.rejects(b, { code: 'JOB_TIMEOUT' })]);
  assert.equal(signal.aborted, true); await a.drained; assert.equal(jobs.getDiagnostics().active, 0);
});
test('cancel rejects promptly but tracked noncooperative work retains physical admission until settled', async () => {
  const jobs = group({ maxActive: 1 }), physical = deferred(); let ctx;
  const job = jobs.subscribe(request('cancel'), context => { ctx = context; context.track(physical.promise); return aborted(context.signal); });
  const rejected = assert.rejects(job, { code: 'JOB_CANCELLED' }); jobs.cancel({ owner: 1, requestId: 'cancel' }); await rejected;
  await tick(); assert.equal(ctx.signal.aborted, true); assert.equal(jobs.getDiagnostics().active, 1);
  await assert.rejects(jobs.subscribe(request('next', { key: 'new' }), () => 1), { code: 'SERVICE_BUSY' });
  physical.resolve(); await job.drained; assert.equal(jobs.getDiagnostics().active, 0);
  assert.equal(await jobs.subscribe(request('next', { key: 'new' }), () => 2), 2); await jobs.shutdown();
});
test('queued cancellation removes work before its factory can start', async () => {
  const jobs = group({ maxActive: 1, maxQueued: 1 }), gate = deferred(); let started = 0;
  const first = jobs.subscribe(request('first'), () => gate.promise);
  const queued = jobs.subscribe(request('queued', { key: 'queued' }), () => { started++; });
  const rejected = assert.rejects(queued, { code: 'JOB_CANCELLED' }); jobs.cancel({ owner: 1, requestId: 'queued' }); await rejected; await queued.drained;
  assert.equal(jobs.getDiagnostics().pending, 0); assert.equal(started, 0);
  gate.resolve(); await first; await first.drained; assert.equal(started, 0);
});
test('subscription exposes the producer signal so queued cache identities can observe synchronous cancellation', async () => {
  const jobs = group({ maxActive: 1, maxQueued: 1 }), gate = deferred();
  const first = jobs.subscribe(request('first'), () => gate.promise);
  const queued = jobs.subscribe(request('queued', { key: 'queued' }), () => {});
  const rejected = assert.rejects(queued, { code: 'JOB_CANCELLED' });
  try {
    assert.ok(queued.producerSignal instanceof AbortSignal);
    jobs.cancel({ owner: 1, requestId: 'queued' });
    assert.equal(queued.producerSignal.aborted, true); await rejected;
  } finally { jobs.cancel({ owner: 1, requestId: 'queued' }); gate.resolve(); await rejected; await first; await jobs.shutdown(); }
});
test('total operation deadline includes queue wait and does not start expired work', async () => {
  const jobs = group({ maxActive: 1, maxQueued: 1, operationTimeouts: { portfolio: 10 } }), gate = deferred(); let started = 0;
  const first = jobs.subscribe(request('first'), () => gate.promise);
  const queued = jobs.subscribe(request('queued', { key: 'queued', operation: 'portfolio' }), () => { started++; });
  await assert.rejects(queued, { code: 'JOB_TIMEOUT' }); await queued.drained;
  assert.equal(started, 0); gate.resolve(); await first; await first.drained; assert.equal(started, 0);
});
test('duplicate request ids remain reserved until physical drain and different owners are isolated', async () => {
  const jobs = group(), gate = deferred();
  const a = jobs.subscribe(request('id'), () => gate.promise), b = jobs.subscribe(request('id', { owner: 2 }), () => {});
  await assert.rejects(jobs.subscribe(request('id', { key: 'other' }), () => {}), { code: 'JOB_DUPLICATE_REQUEST' });
  const rejected = assert.rejects(a, { code: 'JOB_CANCELLED' }); assert.equal(jobs.cancelOwner(1), 1); await rejected;
  assert.equal(jobs.cancelOwner(1), 0);
  await assert.rejects(jobs.subscribe(request('id'), () => {}), { code: 'JOB_DUPLICATE_REQUEST' });
  gate.resolve('peer'); assert.equal(await b, 'peer'); await b.drained;
  assert.equal(await jobs.subscribe(request('id'), () => 'reused'), 'reused'); await jobs.shutdown();
});
test('shutdown rejects callers promptly but waits for producer and tracked resource drain', async () => {
  const jobs = group(), physical = deferred();
  const job = jobs.subscribe(request('one'), ctx => { ctx.track(physical.promise); return aborted(ctx.signal); });
  const rejected = assert.rejects(job, { code: 'JOB_SHUTDOWN' });
  const stopping = jobs.shutdown(); assert.equal(jobs.shutdown(), stopping); await rejected;
  let drained = false; stopping.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  await assert.rejects(jobs.subscribe(request('new'), () => {}), { code: 'JOB_SHUTDOWN' });
  physical.resolve(); await stopping; assert.equal(jobs.getDiagnostics().active, 0); assert.equal(jobs.getDiagnostics().requests, 0);
});
test('track factory checks cancelled producer before starting another stage', async () => {
  const jobs = group(); let starts = 0;
  const job = jobs.subscribe(request('stages'), async ctx => {
    try { await aborted(ctx.signal); } catch {}
    return ctx.track(() => { starts++; return Promise.resolve(); });
  });
  const rejected = assert.rejects(job, { code: 'JOB_CANCELLED' }); jobs.cancel({ owner: 1, requestId: 'stages' }); await rejected; await job.drained;
  assert.equal(starts, 0);
});
test('physical ownership survives a producer synchronous failure and tracked rejection is handled', async () => {
  const jobs = group({ maxActive: 1 }), physical = deferred();
  const job = jobs.subscribe(request('bad'), ctx => { ctx.track(physical.promise); throw new Error('producer failed'); });
  await assert.rejects(job, /producer failed/); assert.equal(jobs.getDiagnostics().active, 1);
  physical.reject(new Error('late physical failure')); await job.drained; assert.equal(jobs.getDiagnostics().active, 0);
  assert.equal(await jobs.subscribe(request('good'), () => 'ok'), 'ok'); await jobs.shutdown();
});
test('request registry is bounded even when cancelled subscribers remain physically undrained', async () => {
  const jobs = group({ maxSubscribers: 2 }), gate = deferred();
  const a = jobs.subscribe(request('a'), () => gate.promise), b = jobs.subscribe(request('b'), () => {});
  const rejected = assert.rejects(a, { code: 'JOB_CANCELLED' }); jobs.cancel({ owner: 1, requestId: 'a' }); await rejected;
  await assert.rejects(jobs.subscribe(request('c'), () => {}), { code: 'SERVICE_BUSY' });
  assert.equal(jobs.getDiagnostics().requests, 2); gate.resolve(); await b; await a.drained; assert.equal(jobs.getDiagnostics().requests, 0);
});
test('operation and key both participate in shared producer identity', async () => {
  const jobs = group(), a = deferred(), b = deferred(); let calls = 0;
  const first = jobs.subscribe(request('a'), () => { calls++; return a.promise; });
  const second = jobs.subscribe(request('b', { operation: 'scan' }), () => { calls++; return b.promise; });
  assert.equal(calls, 2); a.resolve('single'); b.resolve('scan');
  assert.deepEqual(await Promise.all([first, second]), ['single', 'scan']); await jobs.shutdown();
});
test('invalid identities and already cancelled requests do not invoke producers', async () => {
  const jobs = group(); let calls = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(jobs.subscribe(request('', { owner: null }), () => { calls++; }), /owner|requestId/);
  await assert.rejects(jobs.subscribe(request('cancelled', { signal: controller.signal }), () => { calls++; }), { name: 'AbortError' });
  assert.equal(calls, 0); assert.equal(jobs.getDiagnostics().active, 0);
});
test('nonfinite queue configuration cannot create unbounded admission', async () => {
  const jobs = group({ maxActive: 1, maxQueued: Infinity }), gate = deferred();
  const first = jobs.subscribe(request('first'), () => gate.promise);
  const second = jobs.subscribe(request('second', { key: 'second' }), () => {}).then(() => 'started', error => error.code);
  try { assert.equal(await Promise.race([second, delay(30).then(() => 'still queued')]), 'SERVICE_BUSY'); }
  finally { gate.resolve(); await first; await jobs.shutdown(); }
});
test('explicit null cancellation reason still rejects instead of resolving a cancelled subscriber', async () => {
  const jobs = group(), gate = deferred();
  const job = jobs.subscribe(request('cancel'), () => gate.promise);
  const rejected = assert.rejects(job, { code: 'JOB_CANCELLED' });
  jobs.cancel({ owner: 1, requestId: 'cancel' }, null);
  try { await rejected; } finally { gate.resolve(); await job.drained; }
});
test('producer rejection without an Error value remains a failure', async () => {
  const jobs = group();
  const job = jobs.subscribe(request('reject'), () => Promise.reject(null));
  await assert.rejects(job, { code: 'JOB_FAILED' }); await job.drained;
});
test('total deadline is checked when producer returns even if synchronous work delayed its timer', async () => {
  const jobs = group({ operationTimeouts: { single: 5 } });
  const job = jobs.subscribe(request('late-result'), () => { const end = performance.now() + 15; while (performance.now() < end) {} return 'too late'; });
  await assert.rejects(job, { code: 'JOB_TIMEOUT' }); await job.drained;
});
test('subscriber deadline is checked at delivery when synchronous work delayed its timer', async () => {
  const jobs = group();
  const job = jobs.subscribe(request('short', { timeoutMs: 5 }), () => { const end = performance.now() + 15; while (performance.now() < end) {} return 'too late'; });
  await assert.rejects(job, { code: 'JOB_TIMEOUT' }); await job.drained;
});
test('already-started physical promise is still registered when deadline elapsed before tracking it', async () => {
  // Keep admission at t=0 even when the full suite pauses this process. Advance
  // only inside the producer: this case concerns work already started, not a
  // deadline that validly expires before admission.
  let now = 0, starts = 0;
  const fixture = { exports: {} };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('./job-lifecycle.cjs'), 'utf8'), {
    module: fixture, AbortController, setTimeout, clearTimeout,
    require: name => name === 'node:perf_hooks' ? { performance: { now: () => now } } : require(name)
  });
  const jobs = fixture.exports.createJobLifecycle({ operationTimeouts: { single: 5 } }), physical = deferred();
  const job = jobs.subscribe(request('late-track'), ctx => {
    starts++; now = 15;
    ctx.track(physical.promise); return 'late';
  });
  try {
    assert.equal(starts, 1, 'the producer must start before its deadline advances');
    await assert.rejects(job, { code: 'JOB_TIMEOUT' });
    assert.equal(jobs.getDiagnostics().active, 1, 'started work must not lose ownership when checkpoint throws');
  }
  finally { physical.resolve(); await job.drained; await jobs.shutdown(); }
});
test('repeated completed and cancelled subscriptions remove external signal listeners and request registrations', async () => {
  const { getEventListeners } = require('node:events');
  const jobs = group(), signal = new AbortController().signal;
  for (let i = 0; i < 80; i++) {
    const job = jobs.subscribe(request('reusable', { signal }), () => i);
    assert.equal(await job, i); await job.drained;
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  }
  assert.equal(jobs.getDiagnostics().requests, 0); assert.equal(jobs.getDiagnostics().subscribers, 0); assert.equal(jobs.getDiagnostics().active, 0);
});

for (const reason of [false, 0, '', null, undefined]) test('falsy rejection remains a rejection and drains physical work: '+String(reason), async () => {
  const jobs = group(), controller = new AbortController(), gate = deferred();
  const job = jobs.subscribe(request('falsy', {signal: controller.signal}), () => gate.promise);
  const outcome = job.then(value => ({ok:true,value}), error => ({ok:false,error}));
  controller.abort(reason);
  const result = await outcome;
  try {
    assert.equal(result.ok, false);
    if (reason === null) assert.equal(result.error.code, 'JOB_CANCELLED');
    else assert.equal(result.error, controller.signal.reason);
    assert.equal(jobs.getDiagnostics().active, 1);
  } finally { gate.resolve('late'); await job.drained; await jobs.shutdown(); }
  assert.equal(jobs.getDiagnostics().requests, 0);
});
for (const reason of [false, 0, '', null, undefined]) test('producer falsy rejection remains a normalized failure: '+String(reason), async () => {
  const jobs = group();
  const job = jobs.subscribe(request('rejected'), () => Promise.reject(reason));
  const result = await job.then(value => ({ok:true,value}), error => ({ok:false,error}));
  await job.drained; await jobs.shutdown();
  assert.equal(result.ok, false); assert.equal(result.error.code, 'JOB_FAILED');
});
