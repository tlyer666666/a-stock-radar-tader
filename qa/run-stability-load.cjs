'use strict';

// Finite loopback-only soak. No provider endpoints or user profile are read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { fetchJsonWithPolicy, getHttpDiagnostics } = require('../electron/http-client.cjs');
const { BoundedCache } = require('../electron/bounded-cache.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const output = path.resolve(process.argv[2] || 'artifacts/stability-v142/load-monitor');
  const durationMs = Math.max(1000, Math.min(120000, Number(process.argv[3]) || 60000));
  fs.mkdirSync(output, { recursive: true });
  const sockets = new Set();
  let active = 0, peak = 0, seen = 0, sequence = 0;
  const server = http.createServer((request, response) => {
    active++; peak = Math.max(peak, active); seen++;
    const id = Number(new URL(request.url, 'http://localhost').searchParams.get('id'));
    let settled = false;
    const timer = setTimeout(() => response.end(JSON.stringify({ id, rows: [1, 2, 3] })), 20);
    const finish = () => { if (!settled) { settled = true; active--; clearTimeout(timer); } };
    response.once('finish', finish); response.once('close', finish);
    response.writeHead(id % 29 === 0 ? 503 : 200, { 'content-type': 'application/json' });
    response.flushHeaders();
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const cache = new BoundedCache({ maxEntries: 128 });
  const start = Date.now();
  const result = { version: require('../package.json').version, scope: 'synthetic loopback only; bounded one-minute soak; completed-entry count is not a heap-byte cap', samples: [], successes: 0, expectedFailures: 0, unexpectedFailures: [], exposedGc: typeof global.gc === 'function' };
  if (global.gc) global.gc(); result.memoryBefore = process.memoryUsage();
  try {
    while (Date.now() - start < durationMs) {
      const calls = Array.from({ length: 16 }, () => {
        const id = ++sequence;
        return fetchJsonWithPolicy(`http://127.0.0.1:${server.address().port}/?id=${id}`, {}, { retries: 0, timeoutMs: 1000 })
          .then(value => {
            assert.equal(value.id, id);
            cache.set(id, { value: Array.from({ length: 160 }, (_, bar) => ({ close: 10 + bar / 100, volume: id })), expiresAt: Date.now() + 500 });
            result.successes++;
          }, error => {
            if (id % 29 === 0 && error.status === 503) result.expectedFailures++;
            else result.unexpectedFailures.push({ name: error.name, code: error.code, message: error.message });
          });
      });
      await Promise.all(calls);
      const transport = getHttpDiagnostics();
      assert.equal(transport.active, 0); assert.equal(transport.pending, 0);
      assert.ok(cache.size <= 128);
      result.samples.push({ elapsedMs: Date.now() - start, memory: process.memoryUsage(), transport, cacheEntries: cache.size, openSockets: sockets.size });
      await delay(200);
    }
    await delay(510); cache.prune();
    assert.equal(cache.size, 0);
    assert.equal(result.unexpectedFailures.length, 0);
    // A cancelled client stream can be closed locally before its server sees
    // the disconnect. Report that separate observation; it is not a client
    // lease count and can transiently exceed the admission limit.
    assert.ok(getHttpDiagnostics().peakActive <= 8);
  } finally {
    loop.disable();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await delay(20);
    if (global.gc) global.gc();
    result.durationMs = Date.now() - start;
    result.requests = sequence; result.serverRequests = seen;
    result.peakServerObservedResponses = peak; result.remainingSockets = sockets.size;
    result.remainingActiveServerRequests = active; result.finalTransport = getHttpDiagnostics();
    result.finalCacheEntries = cache.size; result.memoryAfter = process.memoryUsage();
    result.resourcesAfter = process.getActiveResourcesInfo();
    result.eventLoop = { meanMs: loop.mean / 1e6, p95Ms: loop.percentile(95) / 1e6, maxMs: loop.max / 1e6 };
    fs.writeFileSync(path.join(output, 'load-results.json'), JSON.stringify(result, null, 2));
  }
  assert.equal(result.remainingSockets, 0);
  assert.equal(result.remainingActiveServerRequests, 0);
  result.passed = true;
  fs.writeFileSync(path.join(output, 'load-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, durationMs: result.durationMs, requests: result.requests, peakClientLeases: result.finalTransport.peakActive, peakServerObservedResponses: peak, active: result.finalTransport.active, pending: result.finalTransport.pending, sockets: result.remainingSockets, eventLoop: result.eventLoop }));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
