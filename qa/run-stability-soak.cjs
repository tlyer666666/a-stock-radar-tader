'use strict';

// Eight-hour default, loopback-only resource exercise. All files are QA evidence;
// this tool never imports the user profile, settings, credentials or services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const ROOT = path.resolve(__dirname, '..');
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(args) {
  const result = { durationMs: EIGHT_HOURS, waveIntervalMs: 10000, checkpointMs: 60000, workerEvery: 6 };
  const numbers = { '--duration-ms': ['durationMs', 100, 24 * 60 * 60 * 1000],
    '--wave-interval-ms': ['waveIntervalMs', 100, 60000], '--checkpoint-ms': ['checkpointMs', 100, 60000],
    '--worker-every': ['workerEvery', 1, 1000] };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (value === undefined) throw new TypeError(`Missing value for ${name}`);
    if (name === '--output') { result.output = path.resolve(value); continue; }
    const contract = numbers[name];
    if (!contract) throw new TypeError(`Unknown argument ${name}`);
    const number = Number(value);
    if (!Number.isInteger(number) || number < contract[1] || number > contract[2]) throw new RangeError(`Invalid ${name}`);
    result[contract[0]] = number;
  }
  if (!result.output) throw new TypeError('--output must identify a new evidence directory');
  return result;
}

function captureSourceManifest(root = ROOT) {
  const files = ['package.json'];
  for (const directory of ['electron', 'config']) {
    for (const name of fs.readdirSync(path.join(root, directory)).sort()) {
      if ((directory === 'electron' ? name.endsWith('.cjs') && !name.endsWith('.test.cjs') : name.endsWith('.json'))) {
        files.push(`${directory}/${name}`);
      }
    }
  }
  files.push('qa/run-stability-soak.cjs');
  const manifest = files.sort().map(file => ({ path: file,
    sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
  return { sourceHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), manifest };
}

function atomicJson(filename, value) {
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function errorRecord(error) {
  return { name: String(error?.name || 'Error').slice(0, 100), code: String(error?.code || '').slice(0, 100),
    message: String(error?.message || error).slice(0, 1200) };
}

function assessContinuity({ durationMs, waveIntervalMs, waveActiveMs, completedWaves, maximumWallGapMs }) {
  const meanWaveMs = completedWaves > 0 ? waveActiveMs / completedWaves : 0;
  const expectedWaves = durationMs / Math.max(waveIntervalMs, meanWaveMs, 1);
  const minimumWaves = Math.max(1, Math.floor(expectedWaves * 0.8));
  return { complete: maximumWallGapMs <= 120000 && completedWaves >= minimumWaves,
    meanWaveMs, expectedWaves, minimumWaves, maximumWallGapMs, completedWaves,
    maximumAllowedGapMs: 120000, minimumCoverageFraction: 0.8 };
}

function syntheticHistory() {
  const rows = [];
  const day = new Date('2024-01-02T00:00:00Z');
  while (rows.length < 280) {
    if (![0, 6].includes(day.getUTCDay())) {
      const close = 10 + rows.length * 0.015 + Math.sin(rows.length / 8) * 0.15;
      rows.push({ date: day.toISOString().slice(0, 10), open: close - 0.03, high: close + 0.12,
        low: close - 0.12, close, volume: 10_000_000, amount: 200_000_000, turnover: 2 });
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return rows;
}

async function runSoak(options) {
  if (typeof global.gc !== 'function') throw new Error('Run with --expose-gc; periodic post-GC sampling is required');
  const { output, durationMs, waveIntervalMs, checkpointMs, workerEvery } = options;
  fs.mkdirSync(output, { recursive: true });
  // A previous run is evidence, even if it crashed. Never truncate it on restart.
  const startupPath = path.join(output, 'startup.json');
  const lock = fs.openSync(startupPath, 'wx', 0o600);
  const source = captureSourceManifest();
  const startedAt = new Date().toISOString(), started = performance.now();
  const startup = { schemaVersion: 1, runId: randomUUID(), pid: process.pid, ppid: process.ppid, startedAt,
    version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    node: process.version, platform: process.platform, arch: process.arch, options,
    exposedGc: true, sourceHash: source.sourceHash,
    scope: 'Offline synthetic resource stability only; no market sources, user data or trading performance validation.' };
  fs.writeFileSync(lock, `${JSON.stringify(startup, null, 2)}\n`); fs.fsyncSync(lock); fs.closeSync(lock);
  atomicJson(path.join(output, 'source-manifest.json'), source);

  const report = { ...startup, status: 'running', completedWaves: 0, checkpointCount: 0, unexpectedErrors: [], samples: [],
    hourlySamples: [], memoryPeaks: { postGcHeapUsed: 0, rss: 0 },
    continuity: { waveActiveMs: 0, maximumWaveGapMs: 0, maximumCheckpointGapMs: 0, maximumWallGapMs: 0 },
    counts: { httpSuccesses: 0, httpSlowBodies: 0, rawCancelled: 0, callerCancelled: 0, bodyTimeouts: 0,
      httpFailures: 0, workerCompleted: 0, cacheOversizeRejected: 0, cacheReplacements: 0,
      sharedPeerSurvived: 0, jobDeadlines: 0 }, eightHoursCompleted: false };
  const httpClient = require('../electron/http-client.cjs');
  const { BoundedCache } = require('../electron/bounded-cache.cjs');
  const { createWorkerRunner } = require('../electron/worker-runner.cjs');
  const { createJobLifecycle } = require('../electron/job-lifecycle.cjs');
  assert.equal(captureSourceManifest().sourceHash, source.sourceHash, 'source changed while modules were loading');
  const cache = new BoundedCache({ maxEntries: 32, maxBytes: 128 * 1024, maxEntryBytes: 16 * 1024 });
  const workers = new Set(), sockets = new Set();
  class ObservedWorker extends Worker {
    constructor(filename, configuration) {
      super(filename, configuration); workers.add(this);
      this.once('exit', () => workers.delete(this));
    }
  }
  const runner = createWorkerRunner({ WorkerClass: ObservedWorker, maxConcurrent: 1, maxQueued: 1, timeoutMs: 10000 });
  const jobs = createJobLifecycle({ maxActive: 2, maxQueued: 2, operationTimeouts: { cache: 10000, single: 120 } });
  let serverResponses = 0, peakServerResponses = 0, serverRequests = 0, stopReason;
  let checkpointTimer, idleTimer, idleResolve, fault, waveWatchdog, cleanupWatchdog;
  let lastWaveWall = Date.now(), lastCheckpointWall = Date.now();
  const continuityError = () => Object.assign(new Error('Load continuity interrupted by more than two minutes or a backward clock change; restart a fresh run'), { code: 'SOAK_CONTINUITY_GAP' });
  const observeWallGap = kind => {
    const now = Date.now(), gap = now - (kind === 'wave' ? lastWaveWall : lastCheckpointWall);
    if (kind === 'wave') lastWaveWall = now; else lastCheckpointWall = now;
    const key = kind === 'wave' ? 'maximumWaveGapMs' : 'maximumCheckpointGapMs';
    report.continuity[key] = Math.max(report.continuity[key], gap);
    report.continuity.maximumWallGapMs = Math.max(report.continuity.maximumWallGapMs, gap);
    if (gap > 120000 || gap < 0) throw continuityError();
  };
  const boundCleanup = () => {
    if (cleanupWatchdog) return;
    cleanupWatchdog = setTimeout(() => {
      // Only terminate this dedicated QA process. This is failed/incomplete
      // evidence, never a claim that a non-cooperating resource drained.
      const failure = { status: 'failed', pid: process.pid, sourceHash: source.sourceHash,
        cleanupIncomplete: true, at: new Date().toISOString(),
        reason: errorRecord(new Error('QA physical cleanup did not finish within 15 seconds')) };
      try { atomicJson(path.join(output, 'failure.json'), failure); atomicJson(path.join(output, 'checkpoint.json'), { ...report, ...failure }); }
      finally { process.exit(1); }
    }, 15000);
  };
  const fatal = error => {
    if (!fault) { fault = error; report.unexpectedErrors.push(errorRecord(error)); }
    stopReason = stopReason || error;
    boundCleanup();
    clearTimeout(idleTimer); idleResolve?.();
    // Signal production owners; their shutdown promises remain awaited below.
    jobs.shutdown(error).catch(() => {}); runner.shutdown(error).catch(() => {});
    try { atomicJson(path.join(output, 'failure.json'), { pid: process.pid, sourceHash: source.sourceHash,
      at: new Date().toISOString(), error: errorRecord(error), status: 'failed' }); } catch { /* original failure remains stderr */ }
  };
  const stop = signal => {
    if (stopReason) return;
    stopReason = Object.assign(new Error(`QA interrupted by ${signal}`), { code: 'SOAK_INTERRUPTED' });
    boundCleanup();
    clearTimeout(idleTimer); idleResolve?.();
    jobs.shutdown(stopReason).catch(fatal); runner.shutdown(stopReason).catch(fatal);
  };
  const onSigint = () => stop('SIGINT'), onSigterm = () => stop('SIGTERM');
  process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);
  process.on('uncaughtException', fatal); process.on('unhandledRejection', fatal);
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  let lastCpu = process.cpuUsage(), lastCpuAt = performance.now();
  const server = http.createServer((request, response) => {
    serverRequests++; serverResponses++; peakServerResponses = Math.max(peakServerResponses, serverResponses);
    let settled = false, timer;
    const finish = () => { if (settled) return; settled = true; serverResponses--; clearTimeout(timer); };
    response.once('finish', finish); response.once('close', finish);
    const kind = new URL(request.url, 'http://127.0.0.1').pathname;
    response.writeHead(kind === '/fail' ? 503 : 200, { 'content-type': 'application/json', connection: 'close' });
    response.flushHeaders();
    if (kind === '/hang') { response.write('{"waiting":'); return; }
    if (kind === '/slow') { response.write('{"ok":'); timer = setTimeout(() => response.end('true}'), 45); return; }
    response.end(kind === '/fail' ? '{"expectedFailure":true}' : '{"ok":true}');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('error', fatal);
  let base;
  const snapshot = () => {
    global.gc();
    const currentCpu = process.cpuUsage(), now = performance.now();
    const cpuMs = ((currentCpu.user - lastCpu.user) + (currentCpu.system - lastCpu.system)) / 1000;
    const sample = { elapsedMs: Math.round(now - started), memory: process.memoryUsage(),
      cpu: { intervalMs: Math.round(now - lastCpuAt), usedMs: cpuMs, percentOfOneCore: cpuMs / (now - lastCpuAt) * 100 },
      transport: httpClient.getHttpDiagnostics(), jobs: jobs.getDiagnostics(), cache: cache.getDiagnostics(),
      workers: workers.size, sockets: sockets.size, serverResponses,
      handles: process._getActiveHandles().reduce((counts, handle) => { const type = handle.constructor?.name || 'Unknown';
        counts[type] = (counts[type] || 0) + 1; return counts; }, {}), resources: process.getActiveResourcesInfo(),
      eventLoop: { p95Ms: loop.percentile(95) / 1e6, maxMs: loop.max / 1e6 } };
    lastCpu = currentCpu; lastCpuAt = now; loop.reset();
    report.memoryPeaks.postGcHeapUsed = Math.max(report.memoryPeaks.postGcHeapUsed, sample.memory.heapUsed);
    report.memoryPeaks.rss = Math.max(report.memoryPeaks.rss, sample.memory.rss);
    if (!report.firstSample) report.firstSample = sample;
    const hour = Math.floor(sample.elapsedMs / 3600000);
    if (hour > 0 && !report.hourlySamples.some(item => item.hour === hour)) report.hourlySamples.push({ hour, ...sample });
    assert.ok(sample.cache.accountedBytes <= 128 * 1024); assert.ok(sample.cache.completedEntries <= 32);
    assert.ok(sample.transport.active <= 8); assert.ok(sample.transport.pending <= 256);
    return sample;
  };
  const checkpoint = () => {
    observeWallGap('checkpoint');
    assert.equal(captureSourceManifest().sourceHash, source.sourceHash, 'source drift: stop and restart after final code freeze');
    report.samples.push(snapshot()); if (report.samples.length > 60) report.samples.shift();
    report.checkpointCount++;
    atomicJson(path.join(output, 'checkpoint.json'), { ...report, lastCheckpointAt: new Date().toISOString() });
  };
  async function work(ctx, wave) {
    const policy = { retries: 0, timeoutMs: 1000 };
    const get = endpoint => ctx.track(httpClient.fetchJsonWithPolicy(base + endpoint, { signal: ctx.signal }, policy));
    const calls = [
      get('/ok').then(value => { assert.equal(value.ok, true); report.counts.httpSuccesses++; }),
      get('/ok').then(value => { assert.equal(value.ok, true); report.counts.httpSuccesses++; }),
      get('/slow').then(value => { assert.equal(value.ok, true); report.counts.httpSlowBodies++; }),
      (async () => {
        const response = await httpClient.fetchWithPolicy(base + '/hang', { signal: ctx.signal }, policy);
        const reader = response.body.getReader(); const first = await reader.read();
        assert.ok(first.value.byteLength > 0); await reader.cancel(); report.counts.rawCancelled++;
      })(),
      (async () => {
        const caller = new AbortController();
        const reason = Object.assign(new Error('expected caller cancellation'), { code: 'SOAK_EXPECTED_ABORT' });
        const timer = setTimeout(() => caller.abort(reason), 40);
        try {
          await assert.rejects(httpClient.fetchJsonWithPolicy(base + '/hang',
            { signal: AbortSignal.any([ctx.signal, caller.signal]) }, policy), error => error === reason);
          report.counts.callerCancelled++;
        } finally { clearTimeout(timer); }
      })(),
      (async () => {
        const response = await httpClient.fetchWithPolicy(base + '/hang', { signal: ctx.signal }, policy);
        // Deliberately retain an unread body past its one-second deadline.
        await delay(1100); await assert.rejects(response.text(), error => error.name === 'AbortError');
        report.counts.bodyTimeouts++;
      })(),
      get('/fail').then(() => { throw new Error('503 unexpectedly succeeded'); }, error => {
        assert.equal(error.status, 503); report.counts.httpFailures++;
      })
    ];
    // Track the full logical body exercise as well as original requests; raw
    // fetch settles at headers, whereas this aggregate owns reader completion.
    const settled = await ctx.track(Promise.allSettled(calls));
    const failures = settled.filter(result => result.status === 'rejected');
    if (failures.length) throw failures[0].reason;
    ctx.throwIfAborted();
    for (let index = 0; index < 8; index++) {
      const key = `wave-${wave}-credential-${wave % 3}-${index}`;
      cache.set(key, { value: Array.from({ length: 80 }, (_, bar) => ({ date: bar, close: 10 + bar / 100, amount: 100000 })), expiresAt: Date.now() + 120000 });
      assert.ok(cache.get(key)?.value.length === 80);
    }
    cache.set('replacement', { value: 'first', expiresAt: Date.now() + 60000 });
    cache.set('replacement', { value: 'second', expiresAt: Date.now() + 60000 });
    assert.equal(cache.get('replacement').value, 'second'); report.counts.cacheReplacements++;
    cache.set('oversized', { value: 'x'.repeat(20000), expiresAt: Date.now() + 60000 });
    assert.equal(cache.has('oversized'), false); report.counts.cacheOversizeRejected++;
    cache.set('expired', { value: null, expiresAt: Date.now() - 1 }); assert.equal(cache.has('expired'), false);
    if ((wave - 1) % workerEvery === 0) {
      const history = syntheticHistory();
      const computation = runner.run(path.join(ROOT, 'electron/portfolio-backtest-worker.cjs'), {
        task: 'single-stock-replay', strategyIds: ['low_first_board', 'platform_breakout'],
        security: { code: '600000', secid: '1.600000', name: 'QA合成股票', market: 'sh', board: 'main' },
        history, benchmarkHistory: history, replayOptions: { minimumVotes: 1 }
      }, { signal: ctx.signal });
      const result = await ctx.track(computation);
      assert.equal(result.replay.components.length, 2);
      assert.ok(result.replaysById.low_first_board); assert.ok(result.replaysById.platform_breakout);
      await computation.drained; report.counts.workerCompleted++;
    }
    return wave;
  }

  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    checkpoint();
    checkpointTimer = setInterval(() => { try { checkpoint(); } catch (error) { fatal(error); } }, checkpointMs);
    console.log(JSON.stringify({ status: 'started', pid: process.pid, output, sourceHash: source.sourceHash, plannedDurationMs: durationMs }));
    while (!stopReason && performance.now() - started < durationMs) {
      observeWallGap('wave');
      const waveWall = Date.now();
      waveWatchdog = setTimeout(() => fatal(Date.now() - waveWall > 120000 ? continuityError() : new Error('QA wave stalled for more than 15 seconds')), 15000);
      const waveStarted = performance.now(), wave = report.completedWaves + 1;
      const primary = jobs.subscribe({ operation: 'cache', key: `wave-${wave}`, owner: 'qa-A', requestId: `A-${wave}` }, ctx => work(ctx, wave));
      // Attach rejection handling immediately, before cancellation can fire.
      const primaryOutcome = primary.then(() => { throw new Error('cancelled subscriber unexpectedly succeeded'); }, error => {
        if (stopReason) return; assert.equal(error.code, 'JOB_CANCELLED');
      });
      const peer = jobs.subscribe({ operation: 'cache', key: `wave-${wave}`, owner: 'qa-B', requestId: `B-${wave}` },
        () => { throw new Error('shared producer duplicated'); });
      const peerOutcome = peer.then(value => { assert.equal(value, wave); report.counts.sharedPeerSurvived++; });
      const cancelTimer = setTimeout(() => jobs.cancel({ owner: 'qa-A', requestId: `A-${wave}` }), 20);
      const deadline = jobs.subscribe({ operation: 'single', key: `deadline-${wave}`, owner: 'qa-deadline', requestId: `D-${wave}` },
        ctx => ctx.track(httpClient.fetchJsonWithPolicy(base + '/hang', { signal: ctx.signal }, { retries: 0, timeoutMs: 5000 })));
      const deadlineOutcome = deadline.then(() => { throw new Error('total deadline unexpectedly succeeded'); }, error => {
        if (stopReason) return; assert.equal(error.code, 'JOB_TIMEOUT'); report.counts.jobDeadlines++;
      });
      const outcomes = await Promise.allSettled([primaryOutcome, peerOutcome, deadlineOutcome]);
      clearTimeout(cancelTimer);
      await Promise.all([primary.drained, peer.drained, deadline.drained]);
      clearTimeout(waveWatchdog);
      if (stopReason) break;
      const failed = outcomes.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      assert.equal(jobs.getDiagnostics().active, 0); assert.equal(jobs.getDiagnostics().pending, 0);
      assert.equal(httpClient.getHttpDiagnostics().active, 0); assert.equal(httpClient.getHttpDiagnostics().pending, 0);
      report.continuity.waveActiveMs += performance.now() - waveStarted;
      report.completedWaves++;
      const remaining = durationMs - (performance.now() - started);
      const wait = Math.max(0, Math.min(remaining, waveIntervalMs - (performance.now() - waveStarted)));
      if (wait > 0) await new Promise(resolve => { idleResolve = resolve; idleTimer = setTimeout(resolve, wait); });
      idleResolve = undefined;
    }
    if (!stopReason) { assert.ok(report.completedWaves > 0, 'at least one full wave must complete'); report.status = 'passed'; }
  } catch (error) {
    if (!stopReason) fatal(error);
  } finally {
    clearInterval(checkpointTimer); clearTimeout(idleTimer); clearTimeout(waveWatchdog);
    boundCleanup();
    try {
      await jobs.shutdown(); await runner.shutdown();
      cache.clear(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      const closeDeadline = performance.now() + 3000;
      while ((sockets.size || workers.size || serverResponses) && performance.now() < closeDeadline) await delay(10);
      clearTimeout(cleanupWatchdog); cleanupWatchdog = undefined;
      observeWallGap('wave');
      assert.equal(captureSourceManifest().sourceHash, source.sourceHash, 'source drift during run');
      const final = snapshot(); report.finalResources = final;
      for (const count of [final.transport.active, final.transport.pending, final.jobs.active, final.jobs.pending,
        final.jobs.subscribers, final.jobs.requests, final.workers, final.sockets, final.serverResponses, final.cache.accountedBytes]) assert.equal(count, 0);
      assert.ok(final.transport.peakActive <= 8);
    } catch (error) { fatal(error); }
    loop.disable();
    report.durationMs = Math.round(performance.now() - started);
    report.finishedAt = new Date().toISOString(); report.serverRequests = serverRequests;
    report.peakServerObservedResponses = peakServerResponses;
    const totalCpu = process.cpuUsage();
    report.totalCpu = { userMs: totalCpu.user / 1000, systemMs: totalCpu.system / 1000,
      percentOfOneCore: (totalCpu.user + totalCpu.system) / (report.durationMs * 1000) * 100 };
    if (fault) report.status = fault.code === 'SOAK_CONTINUITY_GAP' ? 'incomplete' : 'failed'; else if (stopReason) report.status = 'interrupted';
    report.continuity = { ...report.continuity, ...assessContinuity({ durationMs, waveIntervalMs,
      waveActiveMs: report.continuity.waveActiveMs, completedWaves: report.completedWaves,
      maximumWallGapMs: report.continuity.maximumWallGapMs }) };
    if (report.status === 'passed' && !report.continuity.complete) {
      report.status = 'incomplete'; stopReason = continuityError();
    }
    report.eightHoursCompleted = report.status === 'passed' && durationMs >= EIGHT_HOURS && report.durationMs >= EIGHT_HOURS;
    report.limitations = [
      'Synthetic OHLCV exercises CPU and lifecycle, not market data coverage or profitable signals.',
      'Serialized cache bytes are an accounting budget, not a hard JavaScript heap/RSS bound; pending producers are tracked separately.',
      'Remote socket close propagation may lag local transport release; server observations are reported separately.',
      'SIGKILL, power loss and storage failure cannot guarantee a final failure write; stale checkpoint with no final summary is incomplete.',
      'macOS Node run only; no Windows/Linux native UI or OS suspend/resume coverage.'
    ];
    if (report.status !== 'passed') atomicJson(path.join(output, 'failure.json'), { status: report.status, pid: process.pid,
      sourceHash: source.sourceHash, reason: errorRecord(fault || stopReason), finishedAt: report.finishedAt });
    atomicJson(path.join(output, 'checkpoint.json'), report);
    atomicJson(path.join(output, 'summary.json'), report);
    const summaryHash = createHash('sha256').update(fs.readFileSync(path.join(output, 'summary.json'))).digest('hex');
    fs.writeFileSync(path.join(output, 'summary.sha256'), `${summaryHash}\n`, { mode: 0o600 });
    clearTimeout(cleanupWatchdog);
    process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm);
    process.off('uncaughtException', fatal); process.off('unhandledRejection', fatal);
  }
  console.log(JSON.stringify({ status: report.status, pid: process.pid, completedWaves: report.completedWaves,
    durationMs: report.durationMs, eightHoursCompleted: report.eightHoursCompleted, unexpectedErrors: report.unexpectedErrors.length, output }));
  return report;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  runSoak(options).then(result => { process.exitCode = result.status === 'passed' ? 0 : result.status === 'interrupted' ? 2 : 1; },
    error => {
      // Module loading or an early startup failure precedes runtime handlers.
      // Record only this process's evidence; never overwrite a previous run.
      try {
        const startup = JSON.parse(fs.readFileSync(path.join(options.output, 'startup.json'), 'utf8'));
        if (startup.pid === process.pid && !fs.existsSync(path.join(options.output, 'summary.json'))) {
          const failed = { ...startup, status: 'failed', reason: errorRecord(error), eightHoursCompleted: false,
            finalResources: null, note: 'Startup or evidence-writing failure; resource completion not certified.' };
          atomicJson(path.join(options.output, 'failure.json'), failed);
          atomicJson(path.join(options.output, 'summary.json'), failed);
          fs.writeFileSync(path.join(options.output, 'summary.sha256'), `${createHash('sha256').update(fs.readFileSync(path.join(options.output, 'summary.json'))).digest('hex')}\n`);
        }
      } catch { /* stderr remains available when storage itself fails */ }
      console.error(JSON.stringify(errorRecord(error))); process.exitCode = 1;
    });
}

module.exports = { parseArgs, captureSourceManifest, assessContinuity, runSoak };
