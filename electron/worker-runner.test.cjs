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

test('an expired queued worker never starts when its timeout callback is delayed', async () => {
  let time = 0;
  const { runner, workers } = fixture({ maxConcurrent: 1, now: () => time });
  const active = runner.run('worker.cjs', {});
  const queued = runner.run('worker.cjs', { queued: true }, { timeoutMs: 10 });
  const outcomes = Promise.allSettled([active, queued]);
  try {
    workers[0].emit('message', { ok: true, value: 'ready' });
    time = 11;
    workers[0].finishTermination();
    assert.equal(workers.length, 1, 'a physical worker must not be constructed after its queue deadline');
    await assert.rejects(queued, /超时/); await queued.drained;
    assert.deepEqual(runner.getDiagnostics(), { active: 0, pending: 0, retainedInputs: 0 });
    const next = runner.run('worker.cjs', {});
    workers[1].emit('message', { ok: true, value: 'recovered' }); workers[1].finishTermination();
    assert.equal(await next, 'recovered');
  } finally {
    const stopping = runner.shutdown();
    for (const worker of workers) worker.finishTermination?.();
    await stopping; await outcomes;
  }
});

test('a late worker success cannot beat its timeout callback or release its physical slot', async () => {
  let time = 0;
  const { runner, workers } = fixture({ maxConcurrent: 1, now: () => time });
  const job = runner.run('worker.cjs', {}, { timeoutMs: 10 });
  const outcome = job.then(value => ({ value }), error => ({ error }));
  try {
    time = 11;
    workers[0].emit('message', { ok: true, value: 'late result' });
    assert.match((await outcome).error?.message || '', /超时/);
    assert.equal(runner.getDiagnostics().active, 1);
    workers[0].finishTermination(); await job.drained;
    assert.equal(runner.getDiagnostics().active, 0);
  } finally {
    const stopping = runner.shutdown(); workers[0].finishTermination?.(); await stopping;
  }
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

test('worker script paths are rewritten out of app.asar so a Worker can be started', () => {
  const { workerScriptPath } = require('./worker-runner.cjs');
  const path = require('node:path');
  const sep = path.sep;

  // Development / unpacked layout: nothing to rewrite.
  assert.equal(workerScriptPath(`${sep}repo${sep}electron`, 'legacy-analysis-worker.cjs'),
    `${sep}repo${sep}electron${sep}legacy-analysis-worker.cjs`);
  // Packaged layout: worker files are unpacked next to the archive.
  assert.equal(
    workerScriptPath(`${sep}app${sep}Resources${sep}app.asar${sep}electron`, 'strategy-signal-worker.cjs'),
    `${sep}app${sep}Resources${sep}app.asar.unpacked${sep}electron${sep}strategy-signal-worker.cjs`);
  // Only a real path segment counts: a directory merely containing the text is left alone.
  assert.equal(workerScriptPath(`${sep}repo${sep}my-app.asar-backup${sep}electron`, 'x-worker.cjs'),
    `${sep}repo${sep}my-app.asar-backup${sep}electron${sep}x-worker.cjs`);
  // Rewriting must not double-apply when the directory is already unpacked.
  assert.equal(
    workerScriptPath(`${sep}app${sep}app.asar.unpacked${sep}electron`, 'x-worker.cjs'),
    `${sep}app${sep}app.asar.unpacked${sep}electron${sep}x-worker.cjs`);
});

test('active workers release original main-thread inputs immediately after structured cloning',async()=>{
 const {runner,workers}=fixture({maxConcurrent:1});
 const first=runner.run('worker.cjs',{large:Array(10000).fill(1)});
 const second=runner.run('worker.cjs',{pending:true});
 try {assert.deepEqual(runner.getDiagnostics(),{active:1,pending:1,retainedInputs:1});}
 finally {
  const outcomes=Promise.allSettled([first,second]);const stopping=runner.shutdown();workers[0].finishTermination();await stopping;await outcomes;
 }
 assert.deepEqual(runner.getDiagnostics(),{active:0,pending:0,retainedInputs:0});
});

// E-01 回归：逐次超时覆盖必须生效，且每个派发点的超时不得短于其所属 job 的预算。
// 原缺陷：4 个派发点都用 runner 默认的 120s，而 strategy:scan 的预算是 600s，
// 导致全市场扫描跑到第 2 分钟必然被误杀。
test('per-job timeoutMs overrides the runner default', async () => {
  const { runner } = fixture({ timeoutMs: 50 });
  const started = Date.now();
  const error = await runner.run('worker.cjs', {}, { timeoutMs: 400 }).then(() => null, reason => reason);
  const elapsed = Date.now() - started;
  assert.ok(error, '任务应在超时后 reject');
  assert.match(error.message, /超时/);
  assert.ok(elapsed >= 350, `应按逐次传入的 400ms 超时，实际 ${elapsed}ms`);
  assert.ok(elapsed < 4000, `不应回退到 runner 默认值，实际 ${elapsed}ms`);
});

test('every worker dispatch point allows at least its job operation budget', async () => {
  // 静态断言：services.cjs 的每个派发点都必须显式传 timeoutMs，
  // 且取值来自 DEFAULT_OPERATION_TIMEOUTS，不能是硬编码的小数字。
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'services.cjs'), 'utf8');
  const dispatches = [...source.matchAll(/workerRunner\.run\([\s\S]{0,600}?\}\)\)/g)].map(m => m[0]);
  assert.ok(dispatches.length >= 4, `应至少有 4 个 worker 派发点，实际 ${dispatches.length}`);
  for (const block of dispatches) {
    assert.match(block, /timeoutMs:\s*DEFAULT_OPERATION_TIMEOUTS\./,
      `派发点缺少 timeoutMs 预算：${block.slice(0, 120)}`);
  }
  const { DEFAULT_OPERATION_TIMEOUTS } = require('./job-lifecycle.cjs');
  assert.ok(DEFAULT_OPERATION_TIMEOUTS.scan > 120000,
    'scan 预算必须大于 runner 的 120s 默认值，否则长扫描仍会被误杀');
});
