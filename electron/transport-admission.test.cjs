'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let createTransportAdmission;
try { ({ createTransportAdmission } = require('./transport-admission.cjs')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function admission(options) {
  assert.equal(typeof createTransportAdmission, 'function');
  return createTransportAdmission(options);
}
test('transport admits a bounded number of physical leases and rejects excess pending work', async () => {
  const gate = admission({ maxConcurrent: 2, maxPending: 2 });
  const first = await gate.acquire('https://one.test'), second = await gate.acquire('https://two.test');
  const third = gate.acquire('https://three.test'), fourth = gate.acquire('https://four.test');
  await assert.rejects(gate.acquire('https://five.test'), { code: 'QUEUE_FULL' });
  assert.equal(gate.getDiagnostics().active, 2); assert.equal(gate.getDiagnostics().pending, 2);
  first(); const releaseThird = await third; second(); const releaseFourth = await fourth;
  releaseThird(); releaseFourth();
  assert.equal(gate.getDiagnostics().active, 0); assert.equal(gate.getDiagnostics().peakActive, 2);
});
test('origin cooling does not occupy a slot or block another eligible origin', async () => {
  const gate = admission({ maxConcurrent: 1 });
  (await gate.acquire('https://slow.test', { minimumGapMs: 100 }))();
  let slowGranted = false;
  const slow = gate.acquire('https://slow.test', { minimumGapMs: 100 }).then(release => { slowGranted = true; return release; });
  const fast = await gate.acquire('https://fast.test');
  assert.equal(slowGranted, false); fast(); (await slow)();
});
test('same-origin gap is measured on admission rather than before the global queue', async () => {
  const gate = admission({ maxConcurrent: 1 });
  const hold = await gate.acquire('https://occupied.test');
  const starts = [];
  const jobs = [1, 2].map(() => gate.acquire('https://paced.test', { minimumGapMs: 50 }).then(release => { starts.push(Date.now()); release(); }));
  await delay(80); hold(); await Promise.all(jobs);
  assert.ok(starts[1] - starts[0] >= 40, `actual start gap ${starts[1] - starts[0]}ms`);
});
test('queued abort and queue deadline remove work without releasing an active lease', async () => {
  const gate = admission({ maxConcurrent: 1 });
  const release = await gate.acquire('https://active.test');
  const controller = new AbortController();
  const queued = gate.acquire('https://cancel.test', { signal: controller.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError' }); controller.abort(); await rejected;
  await assert.rejects(gate.acquire('https://deadline.test', { queueTimeoutMs: 15 }), { code: 'QUEUE_TIMEOUT' });
  assert.equal(gate.getDiagnostics().active, 1); assert.equal(gate.getDiagnostics().pending, 0);
  release(); assert.equal(gate.getDiagnostics().active, 0);
});
