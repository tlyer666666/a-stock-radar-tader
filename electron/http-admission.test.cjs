'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const api = require('./http-client.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not become true before the test deadline');
    await delay(10);
  }
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('JSON and binary share eight physical slots through full body consumption', async t => {
  let active = 0, peak = 0, settled = 0;
  const replies = [];
  const url = await serve(t, (_, response) => { active++; peak = Math.max(peak, active); replies.push(response); response.on('close', () => active--); response.writeHead(200); response.write('['); });
  const controller = new AbortController();
  const jobs = Array.from({ length: 24 }, (_, index) => (index % 2 ? api.fetchJsonWithPolicy : api.fetchArrayBufferWithPolicy)(url, { signal: controller.signal }, { timeoutMs: 10000 }).catch(error => error).finally(() => settled++));
  try {
    await waitFor(() => replies.length >= 8);
    await delay(30);
    assert.ok(peak <= 8, `physical body peak was ${peak}`);
    assert.equal(replies.length, 8);
    assert.equal(active, 8);
    assert.equal(settled, 0, 'all response bodies remain incomplete');
    assert.equal(api.getHttpDiagnostics().active, 8);
    assert.equal(api.getHttpDiagnostics().pending, 16);
  }
  finally { controller.abort(); await Promise.all(jobs); }
  assert.equal(api.getHttpDiagnostics().active, 0);
  assert.equal(api.getHttpDiagnostics().pending, 0);
});
test('raw Response body and ignored body retain independent finite timeouts after slow headers', { timeout: 5000 }, async t => {
  let closed = 0;
  const url = await serve(t, (request, response) => {
    response.on('close', () => closed++);
    const sendHeaders = () => { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write('partial'); };
    // Awaiting these slow headers deliberately gives /ignored a later deadline.
    if (request.url === '/read') setTimeout(sendHeaders, 180);
    else sendHeaders();
  });
  const controller = new AbortController();
  const deadline = Date.now() + 3000;
  const consumed = await api.fetchWithPolicy(url + '/read', { signal: controller.signal }, { timeoutMs: 1000 });
  const ignored = await api.fetchWithPolicy(url + '/ignored', { signal: controller.signal }, { timeoutMs: 1000 });
  const pending = consumed.text().then(() => 'resolved', () => 'rejected');
  try {
    assert.equal(await Promise.race([pending, delay(1350).then(() => 'still pending')]), 'rejected');
    // Keep ignored.body unread: its own request timer must close the source.
    await waitFor(() => closed === 2 && api.getHttpDiagnostics().active === 0, Math.max(1, deadline - Date.now()));
    assert.equal(closed, 2);
    assert.equal(api.getHttpDiagnostics().active, 0);
    assert.equal(ignored.bodyUsed, false);
    await assert.rejects(ignored.text());
  } finally { controller.abort(); await pending; }
});
test('raw successful Response preserves standard consumption, metadata and clone while releasing at source EOF', async t => {
  const url = await serve(t, (_, response) => { response.writeHead(200, { 'X-Source': 'local' }); response.end('payload'); });
  const result = await api.fetchWithPolicy(url);
  assert.ok(result instanceof Response); assert.equal(result.status, 200); assert.equal(result.headers.get('x-source'), 'local'); assert.equal(result.url, url + '/');
  const cloned = result.clone();
  assert.equal(cloned.url, result.url);
  assert.equal(cloned.type, result.type);
  assert.equal(cloned.clone().redirected, result.redirected);
  assert.equal(await cloned.text(), 'payload'); assert.equal(await result.text(), 'payload');
  assert.equal(api.getHttpDiagnostics().active, 0);
});
test('raw caller body cancellation releases a streaming request', async t => {
  let closed = false;
  const url = await serve(t, (_, response) => { response.on('close', () => { closed = true; }); response.writeHead(200); response.write('ongoing'); });
  const result = await api.fetchWithPolicy(url);
  await result.body.cancel();
  for (let i = 0; i < 20 && !closed; i++) await delay(10);
  assert.equal(closed, true); assert.equal(api.getHttpDiagnostics().active, 0);
});
test('external transport slots wait for physical settlement after caller cancellation', async () => {
  assert.equal(typeof api.runWithTransportSlot, 'function');
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const baseline = api.getHttpDiagnostics().active;
  const job = api.runWithTransportSlot(async () => { entered(); return new Promise(resolve => { finish = resolve; }); }, { url: 'https://curl.test', signal: controller.signal });
  await started; controller.abort(); await delay(5);
  assert.equal(api.getHttpDiagnostics().active, baseline + 1);
  finish(); await assert.rejects(job, { name: 'AbortError' });
  assert.equal(api.getHttpDiagnostics().active, baseline);
});
test('queue errors are not retryable', () => {
  assert.equal(api.isRetryableRequestError({ code: 'QUEUE_FULL' }), false);
  assert.equal(api.isRetryableRequestError({ code: 'QUEUE_TIMEOUT' }), false);
});

test('retry backoff does not retain a physical lease and retry re-enters admission', async t => {
  let calls = 0, firstResponse;
  const first = new Promise(resolve => { firstResponse = resolve; });
  const url = await serve(t, (_, response) => {
    calls++;
    if (calls === 1) { response.writeHead(429, { 'Retry-After': '0.5' }); response.end('later'); firstResponse(); }
    else response.end('{"recovered":true}');
  });
  const request = api.fetchJsonWithPolicy(url, {}, { retries: 1 });
  await first; await delay(30);
  assert.equal(api.getHttpDiagnostics().active, 0);
  assert.deepEqual(await request, { recovered: true });
  assert.equal(calls, 2); assert.equal(api.getHttpDiagnostics().active, 0);
});
