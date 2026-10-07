'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
let createWorkerRunner;
try { ({ createWorkerRunner } = require('./worker-runner.cjs')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  assert.equal(typeof createWorkerRunner, 'function', 'bounded worker runner exists');
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(file, config) { super(); this.config = config; workers.push(this); }
    terminate() { this.terminating = true; return new Promise(resolve => { this.finishTermination = () => { this.emit('exit', 1); resolve(1); }; }); }
  }
  return { runner: createWorkerRunner({ WorkerClass: FakeWorker, maxConcurrent: 2, maxQueued: 2, timeoutMs: 5000, ...options }), workers };
}
test('runner limits physical workers until termination settles and rejects queue overflow', async () => {
  const { runner, workers } = fixture();
  const jobs = Array.from({ length: 4 }, () => runner.run('worker.cjs', {}));
  assert.equal(workers.length, 2);
  await assert.rejects(runner.run('worker.cjs', {}), { code: 'SERVICE_BUSY' });
  workers[0].emit('message', { ok: true, value: 'one' });
  assert.equal(await jobs[0], 'one');
  assert.equal(workers.length, 2);
  workers[0].finishTermination(); await tick(); assert.equal(workers.length, 3);
  workers[1].emit('message', { ok: true, value: 'two' }); workers[1].finishTermination(); await tick();
  workers[2].emit('message', { ok: true, value: 'three' }); workers[2].finishTermination();
  workers[3].emit('message', { ok: true, value: 'four' }); workers[3].finishTermination();
  await Promise.all(jobs); await runner.shutdown();
});
test('worker zero exit without result rejects promptly instead of waiting for timeout', async () => {
  const { runner, workers } = fixture();
  const result = runner.run('worker.cjs', {});
  const rejected = assert.rejects(result, /未返回结果|without.*result/);
  workers[0].emit('exit', 0); await rejected; await runner.shutdown();
});
test('cancelling queued and active jobs preserves physical worker cap and shutdown waits for termination', async () => {
  const { runner, workers } = fixture({ maxConcurrent: 1 });
  const active = new AbortController(), queued = new AbortController();
  const first = runner.run('worker.cjs', {}, { signal: active.signal });
  const second = runner.run('worker.cjs', {}, { signal: queued.signal });
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const secondRejected = assert.rejects(second, { name: 'AbortError' });
  queued.abort(); await secondRejected;
  active.abort(); await firstRejected; assert.equal(workers.length, 1);
  const shutdown = runner.shutdown(); let finished = false; shutdown.then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  workers[0].finishTermination(); await shutdown;
  await assert.rejects(runner.run('worker.cjs', {}), { name: 'AbortError' });
});
test('worker errors and timeouts reject once while keeping a listener until physical exit', async () => {
  const { runner, workers } = fixture({ timeoutMs: 10 });
  const job = runner.run('worker.cjs', {});
  await assert.rejects(job, /超时|timeout/);
  assert.doesNotThrow(() => workers[0].emit('error', new Error('late worker error')));
  workers[0].finishTermination(); await runner.shutdown();
});
test('worker caller promise exposes physical drain separately from prompt cancellation', async () => {
  const { runner, workers } = fixture({ maxConcurrent: 1 });
  const controller = new AbortController();
  const job = runner.run('worker.cjs', {}, { signal: controller.signal });
  assert.ok(job.drained instanceof Promise, 'physical drain handle is available to parent lifecycle');
  let drained = false; job.drained.then(() => { drained = true; });
  const rejected = assert.rejects(job, { name: 'AbortError' }); controller.abort(); await rejected; await tick();
  assert.equal(drained, false); workers[0].finishTermination(); await job.drained; assert.equal(drained, true);
  await runner.shutdown();
  const refused = runner.run('worker.cjs', {}); await assert.rejects(refused, { name: 'AbortError' }); await refused.drained;
});

test('falsy abort reasons reject queued and active jobs without releasing physical workers early', async () => {
  for (const reason of [null, false, 0, '']) {
    const { runner, workers } = fixture({ maxConcurrent: 1 });
    const active = new AbortController(), queued = new AbortController();
    const first = runner.run('worker.cjs', {}, { signal: active.signal });
    const second = runner.run('worker.cjs', {}, { signal: queued.signal });
    const outcome = promise => promise.then(value => ({ kind: 'fulfilled', value }), error => ({ kind: 'rejected', error }));
    const firstOutcome = outcome(first), secondOutcome = outcome(second);
    try {
      queued.abort(reason); active.abort(reason);
      assert.deepEqual(await firstOutcome, { kind: 'rejected', error: reason });
      assert.deepEqual(await secondOutcome, { kind: 'rejected', error: reason });
      assert.deepEqual(await outcome(runner.run('worker.cjs', {}, { signal: active.signal })), { kind: 'rejected', error: reason });
      let drained = false; first.drained.then(() => { drained = true; });
      await tick(); assert.equal(drained, false);
    } finally {
      workers[0].finishTermination();
      await runner.shutdown();
    }
  }
});

test('falsy shutdown reason rejects work consistently before and after shutdown', async () => {
  const { runner, workers } = fixture({ maxConcurrent: 1 });
  const outcome = promise => promise.then(() => 'fulfilled', reason => ({ reason }));
  const active = outcome(runner.run('worker.cjs', {}));
  const queued = outcome(runner.run('worker.cjs', {}));
  const stopping = runner.shutdown(false);
  try {
    assert.deepEqual(await active, { reason: false });
    assert.deepEqual(await queued, { reason: false });
    assert.deepEqual(await outcome(runner.run('worker.cjs', {})), { reason: false });
  } finally { workers[0].finishTermination(); await stopping; }
});
