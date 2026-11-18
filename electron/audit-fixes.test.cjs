'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { fetchNative } = require('./native-http.cjs');
const { buildStrategySignalReport } = require('./strategy-signal-engine.cjs');
const { loadElectronIpcSources } = require('../qa/ipc-source-loader.cjs');

function loadModule(name, requires = {}, globals = {}) {
  const filename = path.join(__dirname, name);
  const requireActual = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    require: id => requires[id] || requireActual(id),
    __dirname,
    __filename: filename,
    process,
    console,
    Date,
    URL,
    DOMException,
    AbortController,
    AbortSignal,
    TextDecoder,
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
    queueMicrotask,
    ...globals
  }, { filename });
  return module.exports;
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

test('fetchNative streams text/event-stream responses incrementally before server closes socket', async t => {
  let serverRes = null;
  const server = http.createServer((_req, res) => {
    serverRes = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write('data: {"choices":[{"delta":{"content":"chunk1"}}]}\n\n');
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise(resolve => {
    serverRes?.destroy();
    server.close(resolve);
  }));

  const response = await fetchNative(`${baseUrl}/sse`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(decoder.decode(first.value), /chunk1/);

  serverRes.write('data: {"choices":[{"delta":{"content":"chunk2"}}]}\n\ndata: [DONE]\n\n');
  serverRes.end();
  let rest = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    rest += decoder.decode(next.value, { stream: true });
  }
  rest += decoder.decode();
  assert.match(rest, /chunk2/);
  assert.match(rest, /\[DONE\]/);
});

test('fetchNative gzip streaming enforces byte ceiling and reader.cancel tears down transport', async t => {
  let closedOnServer = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/gzip-sse') {
      const gz = zlib.createGzip();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' });
      gz.pipe(res);
      gz.write('data: {"choices":[{"delta":{"content":"gz-ok"}}]}\n\n');
      gz.flush();
      res.on('close', () => { closedOnServer = true; try { gz.destroy(); } catch {} });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${'x'.repeat(256)}\n\n`);
    res.write(`data: ${'y'.repeat(512)}\n\n`);
    res.end();
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const gzRes = await fetchNative(`${baseUrl}/gzip-sse`);
  const gzReader = gzRes.body.getReader();
  const first = await gzReader.read();
  assert.match(new TextDecoder().decode(first.value), /gz-ok/);
  await gzReader.cancel(new Error('stop'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closedOnServer, true);

  const bigRes = await fetchNative(`${baseUrl}/too-big`, {}, 300);
  const bigReader = bigRes.body.getReader();
  await assert.rejects(async () => {
    while (true) {
      const step = await bigReader.read();
      if (step.done) break;
    }
  }, err => err?.code === 'RESPONSE_TOO_LARGE');
});

test('fetchTushareDailyQuote rejects empty/NaN close and converts blank fields to null with UTC+8 dates', async t => {
  const RealDate = Date;
  const fixedNow = Date.parse('2026-11-15T16:30:00Z'); // UTC 15日16:30 = 北京时间 16日00:30
  let capturedBody = null;
  const api = loadModule('data-federation.cjs', {
    './http-client.cjs': {
      fetchJsonWithPolicy: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          code: 0,
          data: {
            fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'change', 'pct_chg'],
            items: [['600519.SH', '20261113', '1500', '', null, '1510.5', '1495', '', 'bad']]
          }
        };
      }
    }
  });
  t.after(() => api.shutdownDataFederation());

  const originalNow = RealDate.now;
  RealDate.now = () => fixedNow;
  let result;
  try {
    result = await api.tushareDailyQuote({ code: '600519', secid: '1.600519', thscode: '600519.SH', name: '贵州茅台' }, 'tok-1');
  } finally {
    RealDate.now = originalNow;
  }

  assert.equal(capturedBody.params.end_date, '20261116', 'Beijing UTC+8 date must advance past midnight before UTC');
  assert.equal(result.latest, 1510.5);
  assert.equal(result.preClose, 1495);
  assert.equal(result.open, 1500);
  assert.equal(result.high, null);
  assert.equal(result.low, null);
  assert.equal(result.change, null);
  assert.equal(result.changePct, null);

  const invalidApi = loadModule('data-federation.cjs', {
    './http-client.cjs': {
      fetchJsonWithPolicy: async () => ({
        code: 0,
        data: {
          fields: ['ts_code', 'trade_date', 'close'],
          items: [['600519.SH', '20261113', '']]
        }
      })
    }
  });
  t.after(() => invalidApi.shutdownDataFederation());
  await assert.rejects(
    invalidApi.tushareDailyQuote({ code: '600519', secid: '1.600519', thscode: '600519.SH', name: '贵州茅台' }, 'tok-2'),
    /缺少有效收盘价/
  );
});

test('buildStrategySignalReport skips candidates whose baseFeature is null instead of synthesizing missing_ohlcv signals', () => {
  const rows = [];
  const start = Date.UTC(2026, 0, 5);
  for (let i = 0; i < 120; i += 1) {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    // Inject an unexplained discontinuity near the end so featureSnapshot returns null.
    const price = i >= 110 ? 5.0 : 10.0;
    rows.push({
      date: day,
      open: price,
      high: price * 1.02,
      low: price * 0.99,
      close: price,
      preClose: price,
      changePct: 0.5,
      volume: 1_000_000,
      amount: 50_000_000
    });
  }
  const report = buildStrategySignalReport(
    [{
      security: { code: '600519', name: '样本股份', secid: '1.600519' },
      quote: { latest: 5.0, changePct: 1.5, amount: 50_000_000, turnover: 3.5 },
      metrics: { lowPositionPct: 20, amount: 50_000_000, turnover: 3.5 },
      strategies: ['首板质量共振']
    }],
    { '600519': rows },
    [],
    { minHistoryBars: 90, minCurrentHistoryBars: 60 }
  );
  for (const strategy of report.strategies) {
    for (const stock of strategy.stocks) {
      assert.notEqual(stock.code, '600519', 'candidate with null baseFeature must be skipped rather than matchSource=missing_ohlcv');
    }
  }
});

test('electron main keychain migration includes backup-config and .last-good', () => {
  const { combinedSource: source } = loadElectronIpcSources();
  assert.match(source, /"backup-config",\s*"backup-config\.last-good"/);
  assert.match(source, /function readMigratedBackupConfig\(\)/);
  assert.match(source, /keychainMigrationPending[\s\S]{0,200}readMigratedBackupConfig\(\)/);
  assert.match(source, /readConfig:\s*\(\)\s*=>\s*readMigratedBackupConfig\(\)/);
});
