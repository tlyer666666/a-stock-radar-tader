'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), ts = require('typescript');
const { createServiceRuntime } = require('./service-runtime.cjs');
const { pickBacktestSettingOverrides } = require('./security-policy.cjs');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function sender(id) { const value = new EventEmitter(); value.id = id; value.isDestroyed = () => Boolean(value.destroyed); return value; }
function harness() {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = [], registrations = [], handlers = new Map(), requests = [], gate = deferred(), runtime = createServiceRuntime();
  const names = new Set(['serviceRequestId', 'serviceRequestRuntime']);
  const channels = new Set(['strategy:scan', 'backtest:run', 'backtest:run-portfolio', 'service:cancel']);
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) functions.push(node.getText(ast));
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'handleTrustedIpc' && ts.isStringLiteral(node.arguments[0]) && channels.has(node.arguments[0].text)) registrations.push(node.getText(ast) + ';');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const invokeService = (operation, input, request) => { requests.push({ operation, input, request }); return runtime.run(operation, 'shared', request || {}, () => gate.promise); };
  vm.runInNewContext([...functions, ...registrations].join('\n'), {
    serviceJobOwners: new WeakSet(), handleTrustedIpc: (name, handler) => handlers.set(name, handler),
    settingsForService: () => ({ provider: 'eastmoney', fallbackEnabled: true }), pickBacktestSettingOverrides,
    scanStrategySignals: (options, request) => invokeService('scan', options, request),
    runBacktest: (input, _settings, _options, request) => invokeService('single', input, request),
    runPortfolioBacktest: (input, _settings, request) => invokeService('portfolio', input, request),
    cancelServiceJob: request => runtime.cancel(request), cancelServiceOwner: owner => runtime.cancelOwner(owner)
  });
  return { requests, runtime, gate, invoke: (contents, channel, ...args) => {
    assert.equal(typeof handlers.get(channel), 'function', `${channel} handler exists`);
    return handlers.get(channel)({ sender: contents }, ...args);
  }, cleanup: async () => { gate.resolve('done'); await runtime.shutdown(); } };
}
test('job IPC uses sender identity and cannot cancel a peer using the same renderer request id', async () => {
  const h = harness(), first = sender(11), second = sender(22), jobs = [];
  try {
    jobs.push(h.invoke(first, 'strategy:scan', { requestId: 'same', owner: 22 }));
    jobs.push(h.invoke(second, 'strategy:scan', { requestId: 'same', owner: 11 }));
    const rejected = assert.rejects(jobs[0], { code: 'JOB_CANCELLED' });
    assert.equal(h.invoke(first, 'service:cancel', 'same'), true); await rejected;
    assert.equal(h.runtime.getDiagnostics().jobs.subscribers, 1);
    assert.deepEqual(h.requests.map(item => item.request.owner), [11, 22]);
    h.gate.resolve('peer result'); assert.equal(await jobs[1], 'peer result');
  } finally { h.gate.resolve(); await Promise.allSettled(jobs); await h.cleanup(); }
});
test('backtest and portfolio IPC forward request metadata without accepting an owner from the payload', async () => {
  const h = harness(), contents = sender(31), jobs = [];
  try {
    jobs.push(h.invoke(contents, 'backtest:run', { code: '000001' }, { requestId: 'one', timeoutMs: 1000, owner: 999 }));
    jobs.push(h.invoke(contents, 'backtest:run-portfolio', { requestId: 'two', timeoutMs: 1500, owner: 999 }));
    assert.deepEqual(JSON.parse(JSON.stringify(h.requests.map(item => item.request))), [
      { owner: 31, requestId: 'one', timeoutMs: 1000 }, { owner: 31, requestId: 'two', timeoutMs: 1500 }
    ]);
    h.gate.resolve(); await Promise.all(jobs);
  } finally { h.gate.resolve(); await Promise.allSettled(jobs); await h.cleanup(); }
});
test('sender destruction registers one listener and cancels only that sender subscriptions', async () => {
  const h = harness(), first = sender(1), second = sender(2), jobs = [];
  try {
    jobs.push(h.invoke(first, 'strategy:scan', { requestId: 'a' }));
    jobs.push(h.invoke(first, 'strategy:scan', { requestId: 'b' }));
    jobs.push(h.invoke(second, 'strategy:scan', { requestId: 'c' }));
    assert.equal(first.listenerCount('destroyed'), 1);
    const rejected = jobs.slice(0, 2).map(job => assert.rejects(job, { code: 'JOB_CANCELLED' }));
    first.destroyed = true; first.emit('destroyed'); await Promise.all(rejected);
    assert.equal(first.listenerCount('destroyed'), 0); assert.equal(h.runtime.getDiagnostics().jobs.subscribers, 1);
    h.gate.resolve('peer'); assert.equal(await jobs[2], 'peer');
  } finally { h.gate.resolve(); await Promise.allSettled(jobs); await h.cleanup(); }
});
for (const cause of ['modern-navigation', 'legacy-navigation', 'renderer-crash']) test(`${cause} cancels only its document owner and keeps one lifecycle listener across reloads`, async () => {
  const h = harness(), first = sender(1), second = sender(2), jobs = [];
  try {
    jobs.push(h.invoke(first, 'strategy:scan', { requestId: 'a' }), h.invoke(first, 'strategy:scan', { requestId: 'b' }), h.invoke(second, 'strategy:scan', { requestId: 'c' }));
    assert.equal(first.listenerCount('did-start-navigation'), 1); assert.equal(first.listenerCount('render-process-gone'), 1);
    first.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    first.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    first.emit('did-start-navigation', {}, 'https://test.invalid/#fragment', true, true, 1, 1);
    assert.equal(h.runtime.getDiagnostics().jobs.subscribers, 3, 'same-document and subframe navigation preserve work');
    if (cause === 'modern-navigation') first.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    else if (cause === 'legacy-navigation') first.emit('did-start-navigation', {}, 'https://test.invalid/reload', false, true, 1, 1);
    else first.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await Promise.all(jobs.slice(0, 2).map(job => assert.rejects(job, { code: 'JOB_CANCELLED' })));
    assert.equal(h.runtime.getDiagnostics().jobs.subscribers, 1);
    const restarted = h.invoke(first, 'strategy:scan', { requestId: 'new-document' }); jobs.push(restarted);
    assert.equal(first.listenerCount('did-start-navigation'), 1); assert.equal(first.listenerCount('render-process-gone'), 1);
    first.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 }); await assert.rejects(restarted, { code: 'JOB_CANCELLED' });
    first.destroyed = true; first.emit('destroyed');
    assert.equal(first.listenerCount('did-start-navigation'), 0); assert.equal(first.listenerCount('render-process-gone'), 0);
    h.gate.resolve('peer'); assert.equal(await jobs[2], 'peer');
  } finally { h.gate.resolve(); await Promise.allSettled(jobs); await h.cleanup(); }
});
test('invalid cancellation and job metadata never reach services or register destroy listeners', async () => {
  const h = harness(), contents = sender(1);
  try {
    for (const value of [undefined, null, {}, '', ' ', 'x'.repeat(257)]) assert.throws(() => h.invoke(contents, 'service:cancel', value), { code: 'INVALID_IPC_PAYLOAD' });
    for (const options of [{ requestId: {} }, { requestId: '' }, { requestId: 'valid', timeoutMs: -1 }, { requestId: 'valid', timeoutMs: Infinity }]) {
      assert.throws(() => h.invoke(contents, 'strategy:scan', options), { code: 'INVALID_IPC_PAYLOAD' });
    }
    assert.equal(h.requests.length, 0); assert.equal(contents.listenerCount('destroyed'), 0);
    contents.destroyed = true;
    assert.throws(() => h.invoke(contents, 'strategy:scan', { requestId: 'valid' }), { code: 'INVALID_IPC_PAYLOAD' });
  } finally { await h.cleanup(); }
});
test('preload exposes owner-free cancellation through the service channel', async () => {
  let api; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    process: { platform: 'test' }, require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(true); } } })
  });
  assert.equal(typeof api.cancelServiceJob, 'function'); assert.equal(await api.cancelServiceJob('id'), true);
  assert.deepEqual(calls, [['service:cancel', 'id']]);
});
test('actual main shutdown joins application token work and service work exactly once before quitting', async () => {
  const { createShutdownGate } = require('./shutdown-gate.cjs');
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); let initializer;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'finishShutdown') initializer = node.initializer.getText(ast); ts.forEachChild(node, visit); }
  visit(ast);
  const services = deferred(), token = deferred(), module = { exports: {} }; let serviceCalls = 0, tokenCalls = 0, quits = 0;
  vm.runInNewContext(`module.exports = ${initializer};`, { module, createShutdownGate, runtimeErrorLog: () => {},
    app: { quit: () => { quits++; } }, shutdownServiceResources: () => { serviceCalls++; return services.promise; },
    shutdownThsTokenManager: () => { tokenCalls++; return token.promise; } });
  const event = { preventDefault() {} }, stopping = module.exports(event); module.exports(event);
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(serviceCalls, 1); assert.equal(tokenCalls, 1);
    services.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(quits, 0);
    token.resolve(); await stopping; assert.equal(quits, 1);
  } finally { services.resolve(); token.resolve(); await stopping; }
});
