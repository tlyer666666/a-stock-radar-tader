'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiClient, chatCompletionsUrl, parseModelJson } = require('./ai-client.cjs');
const { createAiSelection, sanitizePicks } = require('./ai-selection.cjs');
const { createAiService, marketFromEcology, evaluateRowsOutcome } = require('./ai-service.cjs');

const config = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-test' };
const reply = (content) => ({ json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }) });
const pick = (code, name, extra = {}) => ({ code, name, industry: '电子', changePct: 5.1, amount: 3.2e8, daysSinceLimit: 3, strategies: ['首板质量共振'], ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

for (const source of ['caller', 'producer']) test(`AI client prevents a pre-aborted ${source} signal from starting a request`, async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled before request', 'AbortError');
  controller.abort(reason);
  let calls = 0;
  const client = createAiClient({ getConfig: () => config, getSignal: () => source === 'producer' ? controller.signal : undefined,
    fetchImpl: async () => { calls++; return reply({ ok: true }); } });
  await assert.rejects(client.chat({ user: 'x', ...(source === 'caller' ? { signal: controller.signal } : {}) }), error => error === reason);
  assert.equal(calls, 0);
});

test('AI admission runs two jobs, queues four and rejects excess work before network I/O', async t => {
  const gate = deferred(); let calls = 0;
  const service = createAiService({ getConfig: () => config, fetchImpl: async () => { calls++; await gate.promise; return reply({ ok: true }); } });
  const pending = Array.from({ length: 7 }, (_, index) => service.test({ ...config, model: `model-${index}` }));
  const settled = Promise.allSettled(pending);
  t.after(async () => { gate.resolve(); await settled; await service.shutdown?.(); });
  await tick();
  assert.equal(calls, 2, 'queued and refused jobs must not start their network requests');
  gate.resolve();
  const outcomes = await settled;
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 6);
  assert.equal(outcomes[6].status, 'rejected');
  assert.equal(outcomes[6].reason.code, 'SERVICE_BUSY');
});

test('AI subscriber cancellation leaves a shared board producer alive for another caller', async t => {
  const gate = deferred(), entered = deferred(), controller = new AbortController();
  let calls = 0, signal;
  const service = createAiService({ getConfig: () => config, fetchImpl: async (_url, options) => {
    calls++; signal = options.signal; entered.resolve(); await gate.promise;
    return reply({ items: [{ code: '600001', score: 80 }] });
  } });
  const input = { asOfDate: '2026-11-04', picks: [pick('600001', '甲')] };
  const first = service.rank(input, { signal: controller.signal });
  const firstOutcome = first.then(() => 'fulfilled', () => 'rejected');
  await entered.promise;
  // A different display list uses the same board scoring work through a distinct public job.
  const second = service.rank({ ...input, display: ['600001', '600002'] });
  t.after(async () => { gate.resolve(); await Promise.allSettled([first, second]); await service.shutdown?.(); });
  controller.abort(new DOMException('first caller cancelled', 'AbortError'));
  await tick();
  assert.equal(await Promise.race([firstOutcome, Promise.resolve('pending')]), 'rejected');
  assert.equal(signal?.aborted, false, 'the producer must not inherit the first subscriber signal');
  gate.resolve();
  assert.equal((await second).items[0].code, '600001');
  assert.equal(calls, 1);
});

test('AI deadline rejects promptly while retaining a transport physical drain', async t => {
  const physical = deferred(); let signal;
  const service = createAiService({ getConfig: () => config, fetchImpl: (_url, options) => {
    signal = options.signal;
    const request = new Promise((resolve, reject) => {
      physical.promise.then(() => resolve(reply({ ok: true })));
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    Object.defineProperty(request, 'drained', { value: physical.promise });
    return request;
  } });
  const pending = service.test(config, { timeoutMs: 20 });
  const outcome = pending.then(() => ({ status: 'fulfilled' }), error => ({ status: 'rejected', error }));
  t.after(async () => { physical.resolve(); await outcome; await service.shutdown?.(); });
  const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve({ status: 'pending' }), 100))]);
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'JOB_TIMEOUT');
  assert.equal(signal.aborted, true);
  let drained = false; pending.drained.then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  physical.resolve(); await pending.drained; assert.equal(drained, true);
});

for (const source of ['market', 'ranking', 'summary', 'market review']) test(`AI shutdown drains ${source} work and prevents late cache publication`, async t => {
  const physical = deferred(), entered = deferred(); let writes = 0, calls = 0, signal;
  const service = createAiService({ getConfig: () => config,
    loadMarket: source === 'market' ? () => { entered.resolve(); return physical.promise; } : async () => null,
    store: { read: () => null, write: () => { writes++; } },
    fetchImpl: (_url, options) => {
      calls++; signal = options.signal; entered.resolve();
      const response = physical.promise.then(() => reply(source === 'summary'
        ? { headline: '总结', market: '市场', themes: [], focus: [], risks: [] }
        : source === 'market review' ? { headline: '复盘', market: '市场', themes: [], risks: [], nextDay: [] }
          : { items: [{ code: '600001', score: 80 }] }));
      return response;
    } });
  const input = { asOfDate: '2026-11-04', picks: [pick('600001', '甲')] };
  const pending = source === 'summary' ? service.summary(input) : source === 'market review'
    ? service.marketReview({ snapshot: { date: input.asOfDate } }) : service.rank(input);
  const outcome = pending.then(() => 'fulfilled', () => 'rejected');
  t.after(async () => { physical.resolve(null); await outcome; await service.shutdown?.(); });
  await entered.promise;
  assert.equal(typeof service.shutdown, 'function');
  let drained = false;
  const closing = service.shutdown().then(() => { drained = true; });
  await tick();
  assert.equal(await outcome, 'rejected');
  assert.equal(drained, false, 'shutdown must own the original pending I/O');
  if (source !== 'market') assert.equal(signal.aborted, true);
  physical.resolve(null); await closing;
  assert.equal(writes, 0);
  if (source === 'market') assert.equal(calls, 0, 'shutdown during market loading must prevent the AI request');
  assert.equal(service.cachedRank(input), null);
});

test('AI shutdown denies every network method without starting new work', async () => {
  let calls = 0;
  const service = createAiService({ getConfig: () => config, fetchImpl: async () => { calls++; return reply({ ok: true }); } });
  assert.equal(typeof service.shutdown, 'function');
  await service.shutdown();
  for (const method of ['rank', 'rankCustom', 'review', 'summary', 'marketReview', 'lookback', 'interpret', 'draftStrategy', 'test']) {
    await assert.rejects(service[method](method === 'test' ? config : {}), { name: 'AbortError' });
  }
  assert.equal(calls, 0);
});

test('AI service keeps optional instruction failures isolated from network admission', async t => {
  const service = createAiService({ getConfig: () => config, getInstructions: () => { throw Error('settings unavailable'); },
    fetchImpl: async () => reply({ ok: true }) });
  t.after(() => service.shutdown());
  assert.equal((await service.test(config)).ok, true);
});

test('AI request identity errors reject asynchronously without starting network work', async t => {
  let calls = 0;
  const service = createAiService({ getConfig: () => config, fetchImpl: async () => { calls++; return reply({ ok: true }); } });
  t.after(() => service.shutdown());
  const input = { ...config }; input.cycle = input;
  await assert.rejects(service.test(input), /call stack|circular/i);
  assert.equal(calls, 0);
});

test('AI default HTTP transport retains shutdown ownership through an unfinished response body', async t => {
  const physical = deferred(), entered = deferred(), originalFetch = global.fetch;
  let controller, cancelling = false, closed = false;
  const release = () => {
    if (!cancelling && !closed) { closed = true; controller?.close(); }
    physical.resolve();
  };
  global.fetch = async () => new Response(new ReadableStream({
    start(value) {
      controller = value;
      value.enqueue(Buffer.from('{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}'));
      entered.resolve();
    },
    cancel() { cancelling = true; return physical.promise; }
  }));
  const service = createAiService({ getConfig: () => config });
  const pending = service.test(config), outcome = pending.then(() => 'fulfilled', () => 'rejected');
  t.after(async () => { release(); await outcome; await service.shutdown(); global.fetch = originalFetch; });
  await entered.promise; await tick();
  let drained = false;
  const closing = service.shutdown().then(() => { drained = true; });
  assert.equal(await outcome, 'rejected');
  await tick(); assert.equal(drained, false, 'a parsed-response rejection must not release an unfinished source body');
  release(); await closing;
});

test('AI shutdown after a successful batch prevents fallback cache writes and parameter retries', async t => {
  const physical = deferred(), entered = deferred(); let calls = 0, writes = 0;
  const profiles = Array.from({ length: 40 }, (_, index) => pick(String(600000 + index), `股${index}`));
  const service = createAiService({ getConfig: () => config, store: { read: () => null, write: () => { writes++; } },
    fetchImpl: async (_url, options) => {
      const stocks = JSON.parse(JSON.parse(options.body).messages[1].content).stocks;
      calls++;
      if (calls === 1) return reply({ items: stocks.map(item => ({ code: item.code, score: 80 })) });
      if (calls === 4) entered.resolve();
      await physical.promise;
      throw Object.assign(new Error('HTTP 400'), { status: 400 });
    } });
  const pending = service.rankCustom({ asOfDate: '2026-11-04', profiles });
  const outcome = pending.then(() => 'fulfilled', () => 'rejected');
  t.after(async () => { physical.resolve(); await outcome; await service.shutdown(); });
  await entered.promise;
  const closing = service.shutdown();
  assert.equal(await outcome, 'rejected');
  physical.resolve(); await closing;
  assert.equal(calls, 4, 'parameter retries must not start after shutdown');
  assert.equal(writes, 0, 'a partial successful batch must not publish fallback scores after shutdown');
  assert.equal(service.cachedCustom(profiles.map(item => item.code)), null);
});

test('main shutdown awaits an existing AI service without constructing an unused one', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  const source = fs.readFileSync(require.resolve('./main.cjs'), 'utf8');
  const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
    .find(node => node.name.getText(ast) === 'finishShutdown');
  for (const initialized of [false, true]) {
    const physical = deferred(); let calls = 0, quits = 0;
    const finish = vm.runInNewContext(declaration.initializer.getText(ast), {
      createShutdownGate: require('./shutdown-gate.cjs').createShutdownGate,
      shutdownServiceResources: async () => {}, shutdownThsTokenManager: async () => {},
      aiServiceInstance: initialized ? { shutdown: () => { calls++; return physical.promise; } } : null,
      aiService: () => { throw Error('shutdown must not construct an AI service'); },
      runtimeErrorLog: (_name, error) => { throw error; }, app: { quit: () => { quits++; } }
    });
    const closing = finish({ preventDefault() {} });
    await tick();
    assert.equal(calls, initialized ? 1 : 0);
    if (initialized) assert.equal(quits, 0, 'the native quit must wait for AI physical cleanup');
    physical.resolve(); await closing;
    assert.equal(quits, 1);
  }
});

test('endpoint addresses are normalised and only https (or local http) is accepted', () => {
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'), 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://api.example.com/v1'), null);
  assert.equal(chatCompletionsUrl('https://user:pass@api.example.com/v1'), null);
  assert.equal(chatCompletionsUrl('not a url'), null);
});

test('model JSON is read from plain text, code fences and surrounding prose', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('结果如下：\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseModelJson('好的 {"a":3} 以上'), { a: 3 });
  assert.throws(() => parseModelJson('没有 JSON'), { code: 'AI_BAD_JSON' });
});

test('the client sends a bearer key, asks for JSON, and retries once without response_format on HTTP 400', async () => {
  const calls = [];
  const fetchImpl = async (url, options, policy) => {
    calls.push({ url, options, policy, body: JSON.parse(options.body) });
    if (calls.length === 1) throw Object.assign(new Error('HTTP 400'), { status: 400 });
    return reply({ ok: true });
  };
  const client = createAiClient({ getConfig: () => config, fetchImpl });
  assert.deepEqual(await client.chat({ system: 's', user: 'u' }), { ok: true });
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[1].body.response_format, undefined);
  assert.ok(calls[0].policy.maxResponseBytes > 0, 'the shared response size limit applies');
  assert.equal(calls[0].policy.timeoutMs, 120_000, 'default request timeout');
});

test('AI 问股 gives reasoning models a longer per-request timeout, within bounds', async () => {
  const seen = [];
  const fetchImpl = async (_url, _options, policy) => { seen.push(policy.timeoutMs); return reply({ ok: true }); };
  await createAiClient({ getConfig: () => config, fetchImpl, timeoutMs: 240_000 }).chat({ user: 'u' });
  await createAiClient({ getConfig: () => config, fetchImpl, timeoutMs: 5 }).chat({ user: 'u' });
  await createAiClient({ getConfig: () => config, fetchImpl, timeoutMs: 9e9 }).chat({ user: 'u' });
  assert.deepEqual(seen, [240_000, 10_000, 600_000]);
});

test('missing configuration and HTTP failures surface plain-language errors', async () => {
  await assert.rejects(createAiClient({ getConfig: () => ({ ...config, apiKey: '' }) }).chat({ user: 'x' }), /API Key/);
  await assert.rejects(createAiClient({ getConfig: () => ({ ...config, baseUrl: 'http://x.com' }) }).chat({ user: 'x' }), /https/);
  const failing = status => createAiClient({ getConfig: () => config, fetchImpl: async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); } });
  await assert.rejects(failing(401).chat({ user: 'x', json: false }), /API Key 无效/);
  await assert.rejects(failing(429).chat({ user: 'x', json: false }), /限流/);
  assert.equal(createAiClient({ getConfig: () => config }).configured(), true);
  assert.equal(createAiClient({ getConfig: () => ({}) }).configured(), false);
});

test('only the stock fields the AI needs are sent, de-duplicated and capped at 40', () => {
  const picks = sanitizePicks([pick('600001', '甲', { secret: 'x', amount: 2.5e8 }), pick('600001', '重复'), { code: 'bad' },
    ...Array.from({ length: 60 }, (_, i) => pick(String(600100 + i), `股${i}`))]);
  assert.equal(picks.length, 40);
  assert.equal(picks[0].secret, undefined);
  assert.equal(picks[0].amountYi, 2.5);
  assert.equal(picks.filter(item => item.code === '600001').length, 1);
});

test('rankings keep only input codes, clamp scores, derive missing ratings and sort by score', async () => {
  const ai = { model: () => 'm', chat: async ({ user }) => {
    const input = JSON.parse(user);
    assert.equal(input.stocks.length, 2);
    return { items: [
      { code: '600002', score: 140, rating: '乱写', highlights: 'x'.repeat(200), risks: '高位', nextDay: '竞价' },
      { code: '600001', score: 55, rating: '观望' },
      { code: '999999', score: 99, rating: '重点关注' },
      { code: '600001', score: 10 }
    ] };
  } };
  const result = await createAiSelection({ ai }).rankPicks({ picks: [pick('600001', '甲'), pick('600002', '乙')], asOfDate: '2026-11-02' });
  assert.deepEqual(result.items.map(item => [item.code, item.score, item.rating]), [['600002', 100, '重点关注'], ['600001', 55, '观望']]);
  assert.ok([...result.items[0].highlights].length <= 60);
  await assert.rejects(createAiSelection({ ai: { model: () => 'm', chat: async () => ({ items: [] }) } }).rankPicks({ picks: [pick('600001', '甲')] }), { code: 'AI_BAD_OUTPUT' });
  await assert.rejects(createAiSelection({ ai }).rankPicks({ picks: [] }), { code: 'AI_NO_INPUT' });
});

test('summaries only name stocks that were in the input', async () => {
  const ai = { model: () => 'm', chat: async () => ({ headline: '情绪回暖', market: '涨停 60 家', themes: [{ name: '机器人', stocks: ['甲', '虚构股'] }],
    focus: [{ code: '600001', reason: '最强' }, { code: '688888', reason: '不在输入里' }], risks: ['高位分歧'] }) };
  const result = await createAiSelection({ ai }).dailySummary({ picks: [pick('600001', '甲')], asOfDate: '2026-11-02' });
  assert.deepEqual(result.themes, [{ name: '机器人', stocks: ['甲'] }]);
  assert.deepEqual(result.focus, [{ code: '600001', name: '甲', reason: '最强' }]);
});

test('a plain-language strategy is turned into a valid custom strategy using only known conditions', async () => {
  const ai = { model: () => 'm', chat: async ({ user }) => {
    assert.match(user, /factor:support/);
    assert.match(user, /pattern:low_first_board/);
    return { name: '首板回踩', description: '近一周首板回踩不破', universe: 'limit_pool',
      conditions: [{ ref: 'pattern:low_first_board', required: true }, { ref: 'factor:support', required: true }, { ref: 'factor:contraction' }, { ref: 'factor:made_up' }],
      minMatchPercent: 60, filters: { maxDaysSinceLimit: 5, minAmountYi: 3, boards: ['main', 'chinext', 'star'] }, notes: '“题材好”无法实现' };
  } };
  const result = await createAiSelection({ ai }).draftStrategy({ text: '近一周首板，回踩不破涨停低点，缩量，成交额3亿以上，不要北交所', patterns: [{ id: 'low_first_board', name: '低位首板', detail: '…' }] });
  assert.deepEqual(result.strategy.conditions.map(item => item.ref), ['pattern:low_first_board', 'factor:support', 'factor:contraction']);
  assert.equal(result.strategy.filters.maxDaysSinceLimit, 5);
  assert.deepEqual(result.strategy.filters.boards, ['main', 'chinext', 'star']);
  assert.equal(result.strategy.id, null);
  assert.match(result.notes, /无法实现/);
  const broken = { model: () => 'm', chat: async () => ({ name: 'x', conditions: [{ ref: 'factor:nope' }] }) };
  await assert.rejects(createAiSelection({ ai: broken }).draftStrategy({ text: '随便', patterns: [] }), { code: 'AI_BAD_OUTPUT' });
});

test('the service caches results per data day, model and stock set, and only regenerates on request', async () => {
  let stored = null, calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const user = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(user.stocks[0].limitReason, '机器人', 'THS limit-up reasons are added from the ecology data');
    return reply({ items: user.stocks.map((item, index) => ({ code: item.code, score: 80 - index })) });
  };
  const service = createAiService({ getConfig: () => config, fetchImpl, store: { read: () => stored, write: value => { stored = value; } },
    loadMarket: async () => marketFromEcology({ available: true, limitUp: { count: 50, maxBoards: 5, reasons: [{ reason: '机器人', count: 6 }], byCode: { 600001: { reason: '机器人' } } }, sealRate: 0.7 }) });
  const input = { asOfDate: '2026-11-02', picks: [pick('600001', '甲'), pick('600002', '乙')] };
  const first = await service.rank(input);
  assert.equal(first.cached, false);
  assert.equal((await service.rank(input)).cached, true);
  assert.equal(calls, 1);
  assert.equal(service.cachedRank(input).items.length, 2);
  assert.equal(service.cachedRank({ ...input, asOfDate: '2026-11-03' }), null);
  await service.rank({ ...input, force: true });
  assert.equal(calls, 2);
  assert.equal(stored.entries.length, 1);
});

test('scoring only a few stocks merges into the same board; a plain run only scores the stocks still missing', async () => {
  const asked = [];
  let stored = null, round = 0;
  const fetchImpl = async (_url, options) => {
    const user = JSON.parse(JSON.parse(options.body).messages[1].content);
    asked.push(user.stocks.map(item => item.code).join(','));
    round += 1;
    return reply({ items: user.stocks.map(item => ({ code: item.code, score: 50 + round })) });
  };
  const service = createAiService({ getConfig: () => config, fetchImpl, store: { read: () => stored, write: value => { stored = value; } } });
  const picks = [pick('600001', '甲'), pick('600002', '乙'), pick('600003', '丙')];
  const input = { asOfDate: '2026-11-03', picks };
  assert.equal((await service.rank(input)).items.length, 3);
  const only = await service.rank({ ...input, only: ['600002'], force: true });
  assert.deepEqual(asked, ['600001,600002,600003', '600002'], 'only the ticked stock is sent the second time');
  assert.equal(only.items.length, 3, 'the other stocks keep their earlier scores');
  assert.equal(only.items.find(item => item.code === '600002').score, 52);
  assert.equal(only.items.find(item => item.code === '600001').score, 51);
  assert.equal((await service.rank(input)).cached, true, 'everything is scored already');
  assert.equal(asked.length, 2);
  assert.deepEqual(service.pending('rank', { ...input, picks: [...picks, pick('600004', '丁')] }), ['600004']);
  const grown = await service.rank({ ...input, picks: [...picks, pick('600004', '丁')] });
  assert.equal(asked.at(-1), '600004', 'a plain run only scores the newly added stock');
  assert.equal(grown.items.length, 4);
  const shrunk = service.cachedRank({ ...input, picks: [picks[0], picks[2]] });
  assert.deepEqual(shrunk.items.map(item => item.code).sort(), ['600001', '600003'], 'removed stocks are left out of the view');
  assert.equal(shrunk.evaluated, 2);
  assert.equal(stored.entries.length, 1, 'one board per day, model and settings');
  assert.equal(service.historyDay('2026-11-03').rank.items.length, 4);
});

test('several model profiles can be saved, switched and removed; keys stay encrypted and masked', () => {
  const { createAiProfileStore } = require('./ai-profile-store.cjs');
  let stored = null;
  const store = createAiProfileStore({ read: () => stored, write: value => { stored = structuredClone(value); },
    encrypt: value => `enc:${value}`, decrypt: value => String(value).startsWith('enc:') ? String(value).slice(4) : '',
    legacy: () => ({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-old' }) });
  const first = store.list();
  assert.equal(first.profiles.length, 1, 'the single 1.6.33 configuration is migrated');
  assert.equal(first.profiles[0].name, '默认');
  assert.equal(first.profiles[0].hasKey, true);
  assert.equal(JSON.stringify(first).includes('sk-old'), false, 'keys are never returned');
  assert.equal(stored.profiles[0].apiKey, 'enc:sk-old');
  const qwen = store.save({ name: '通义 qwen-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', apiKey: 'sk-qwen' }).saved;
  assert.equal(store.active().model, 'deepseek-chat');
  store.activate(qwen.id);
  assert.deepEqual([store.active().model, store.active().apiKey], ['qwen-max', 'sk-qwen']);
  store.save({ id: qwen.id, name: '通义 qwen-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKey: '••••••••' });
  assert.deepEqual([store.active().model, store.active().apiKey], ['qwen-plus', 'sk-qwen'], 'a masked key keeps the saved key');
  assert.throws(() => store.save({ name: '坏地址', baseUrl: 'http://example.com', model: 'x' }), { code: 'INVALID_AI_PROFILE' });
  assert.throws(() => store.save({ name: '默认', baseUrl: 'https://a.com/v1', model: 'x' }), /同名/);
  store.remove(qwen.id);
  assert.equal(store.active().name, '默认', 'removing the active profile falls back to another one');
});

test('custom instructions are appended to the AI prompt and change the cache key', async () => {
  const systems = [];
  let instructions = '';
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    systems.push(body.messages[0].content);
    const user = JSON.parse(body.messages[1].content);
    return reply({ items: user.stocks.map(item => ({ code: item.code, score: 60 })) });
  };
  const service = createAiService({ getConfig: () => config, getInstructions: () => ({ rank: instructions }), fetchImpl });
  const input = { asOfDate: '2026-11-03', picks: [pick('600001', '甲')] };
  let stored = null;
  const cachedService = createAiService({ getConfig: () => config, getInstructions: () => ({ rank: instructions }), fetchImpl, store: { read: () => stored, write: value => { stored = value; } } });
  await cachedService.rank(input);
  instructions = '4 连板以上一律观望';
  assert.equal(cachedService.cachedRank(input), null, 'changed instructions need a fresh answer');
  await service.rank(input);
  assert.match(systems.at(-1), /用户的额外要求[\s\S]*4 连板以上一律观望/);
  assert.doesNotMatch(systems[0], /用户的额外要求/);
});

test('several models score together: average score, per-model scores, disagreement and partial failures', async () => {
  const profiles = [
    { id: 'a', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k1' },
    { id: 'b', name: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKey: 'k2' },
    { id: 'c', name: '坏模型', baseUrl: 'https://bad.example.com/v1', model: 'x', apiKey: 'k3' }
  ];
  const scores = { 'deepseek-chat': { 600001: 80, 600002: 50 }, 'qwen-plus': { 600001: 70, 600002: 80 } };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes('bad.example.com')) throw Object.assign(new Error('HTTP 401'), { status: 401 });
    const user = JSON.parse(body.messages[1].content);
    return reply({ items: user.stocks.map(item => ({ code: item.code, score: scores[body.model][item.code], highlights: body.model })) });
  };
  let stored = null;
  const service = createAiService({ getConfig: () => profiles[0], getRankProfiles: () => profiles, fetchImpl, store: { read: () => stored, write: value => { stored = value; } } });
  const input = { asOfDate: '2026-11-03', picks: [pick('600001', '甲'), pick('600002', '乙')] };
  const result = await service.rank(input);
  assert.deepEqual(result.models.map(item => [item.name, item.ok]), [['DeepSeek', true], ['通义', true], ['坏模型', false]]);
  assert.match(result.models[2].error, /API Key/);
  const first = result.items.find(item => item.code === '600001');
  const second = result.items.find(item => item.code === '600002');
  assert.equal(first.score, 75);
  assert.equal(first.rating, '重点关注');
  assert.deepEqual(first.scores.map(item => [item.name, item.score]), [['DeepSeek', 80], ['通义', 70]]);
  assert.equal(first.disagreement, false);
  assert.equal(second.score, 65);
  assert.equal(second.disagreement, true, 'a 30-point gap is flagged');
  assert.equal(first.highlights, 'deepseek-chat', 'text comes from the first model in the list');
  const cached = service.cachedRank(input);
  assert.equal(cached.models.length, 2, 'cached view combines the models that already answered');
  assert.equal(cached.cached, true);
});

test('scoring profiles sharing an endpoint and model use their own account and cached score', async t => {
  const sharedConfig = { baseUrl: 'https://rank.example.test/v1', model: 'shared-model' };
  const profiles = [
    { ...sharedConfig, id: 'a', name: '账户甲', apiKey: 'fixture-a' },
    { ...sharedConfig, id: 'b', name: '账户乙', apiKey: 'fixture-b' }
  ];
  const scoreByAccount = new Map([['Bearer fixture-a', 80], ['Bearer fixture-b', 60], ['Bearer fixture-c', 70]]);
  const requests = [];
  const service = createAiService({
    getConfig: () => profiles[0], getRankProfiles: () => profiles,
    fetchImpl: async (_url, options) => {
      const account = options.headers.Authorization;
      requests.push(account);
      return reply({ items: [{ code: '600001', score: scoreByAccount.get(account) }] });
    }
  });
  t.after(() => service.shutdown());
  const input = { asOfDate: '2026-11-13', picks: [pick('600001', '甲')] };

  const first = await service.rank(input);
  assert.deepEqual(first.items[0].scores.map(({ id, score }) => [id, score]), [['a', 80], ['b', 60]]);
  assert.equal(first.items[0].score, 70);
  assert.deepEqual(requests.slice().sort(), ['Bearer fixture-a', 'Bearer fixture-b']);
  assert.equal((await service.rank(input)).cached, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(service.historyDay(input.asOfDate).rank.models.map(({ id }) => id).sort(), ['a', 'b']);

  profiles[0] = { ...profiles[0], apiKey: 'fixture-c' };
  const afterKeyChange = await service.rank(input);
  assert.deepEqual(afterKeyChange.items[0].scores.map(({ id, score }) => [id, score]), [['a', 70], ['b', 60]]);
  assert.equal(afterKeyChange.items[0].score, 65);
  assert.deepEqual(requests.slice(2), ['Bearer fixture-c']);
});

test('history lists past data days and replays a day with each model\'s latest scores and the summary', async () => {
  const profiles = [
    { id: 'a', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k1' },
    { id: 'b', name: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKey: 'k2' }
  ];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const user = JSON.parse(body.messages[1].content);
    if (!user.stocks || /总结/.test(body.messages[0].content) && !/score/.test(body.messages[0].content)) {
      return reply({ headline: '总结', market: '市场', themes: [], focus: [], risks: [] });
    }
    return reply({ items: user.stocks.map(item => ({ code: item.code, score: body.model === 'qwen-plus' ? 60 : 80 })) });
  };
  let stored = null;
  const service = createAiService({ getConfig: () => profiles[0], getRankProfiles: () => profiles, fetchImpl, store: { read: () => stored, write: value => { stored = value; } } });
  const picks = [pick('600001', '甲')];
  await service.rank({ asOfDate: '2026-10-30', picks });
  await service.rank({ asOfDate: '2026-11-02', picks });
  const days = service.history();
  assert.deepEqual(days.map(day => day.asOfDate), ['2026-11-02', '2026-10-30']);
  assert.deepEqual([...days[1].rankModels].sort(), ['deepseek-chat', 'qwen-plus']);
  const replay = service.historyDay('2026-10-30');
  assert.equal(replay.rank.items[0].score, 70, 'the stored per-model scores are combined again');
  assert.equal(replay.rank.models.length, 2);
  assert.equal(replay.rank.cached, true);
  assert.equal(service.historyDay('2026-01-01').rank, null);
});

test('any stock can be scored from its profile, and a single stock gets a detailed review with levels from the software', async () => {
  const { buildStockProfile, trendText } = require('./stock-profile.cjs');
  const { sanitizeProfiles } = require('./ai-selection.cjs');
  const rows = Array.from({ length: 30 }, (_, index) => ({ date: new Date(Date.UTC(2026, 9, 1) + index * 86400000).toISOString().slice(0, 10), close: 10 + index * 0.1, high: 10.1 + index * 0.1, low: 9.9 + index * 0.1, volume: 100, amount: 1e8 }));
  const base = buildStockProfile({ code: '600001', name: '甲', rows });
  const profile = { ...base, trend: trendText(base), support: [...base.support, { label: '乱写<script>', price: 1 }] };
  const [clean] = sanitizeProfiles([profile, { code: 'bad' }]);
  assert.equal(clean.support.some(level => level.label.includes('<')), false, 'only well-formed level labels reach the model');
  assert.equal(clean.trend, '站上全部均线');
  const prompts = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    prompts.push(body.messages[0].content);
    const user = JSON.parse(body.messages[1].content);
    if (user.stock) return reply({ score: 130, rating: '乱写', trend: '站上全部均线', volume: '温和', highlights: '趋势向上', risks: '涨幅偏大', nextDay: '看 10日线', keyLevels: '支撑 12.4' });
    return reply({ items: user.stocks.map(item => ({ code: item.code, score: 66 })) });
  };
  let stored = null;
  const service = createAiService({ getConfig: () => config, fetchImpl, store: { read: () => stored, write: value => { stored = value; } } });
  const ranked = await service.rankCustom({ asOfDate: base.asOfDate, profiles: [profile] });
  assert.ok(Math.abs(ranked.items[0].score - ranked.items[0].base) <= 15, 'the AI score stays within 15 points of the framework base score');
  assert.match(ranked.items[0].framework, /^AI 编排：/, 'the default is AI orchestration over the playbook library');
  assert.ok(ranked.items[0].plays.length >= 1 && ranked.items[0].situation.length >= 1);
  assert.ok(ranked.items[0].dims.length >= 4);
  assert.equal(ranked.profiles[0].return5 !== undefined, true, 'a compact copy of the profile comes back for the table');
  assert.match(prompts[0], /用户自己挑的一批股票/);
  const review = await service.review({ asOfDate: base.asOfDate, profile });
  assert.equal(review.items[0].score, Math.min(review.items[0].caps.length ? 59 : 100, review.items[0].base + 15), 'an over-the-top AI score is pulled back to base + 15 (and 59 when a hard rule fires)');
  assert.equal(review.items[0].adjust, review.items[0].score - review.items[0].base);
  assert.equal(review.items[0].keyLevels, '支撑 12.4');
  assert.equal(review.profile.code, '600001');
  assert.match(prompts[1], /只能使用输入里的 support/);
  // 不知道数据日时取本机最近一次结果。
  assert.equal(service.cachedReview('600001').items[0].trend, '站上全部均线');
  assert.equal(service.cachedReview('600002'), null);
  assert.equal(service.cachedCustom(['600001']).items.length, 1);
  assert.deepEqual(service.cachedCustom(['600001', '600002']).items.map(item => item.code), ['600001'], 'a longer list keeps the stocks already scored');
  assert.equal((await service.review({ asOfDate: base.asOfDate, profile })).cached, true);
  // 换分析框架后旧结果不再适用。
  let framework = { active: 'shortline' };
  const switching = createAiService({ getConfig: () => config, fetchImpl, getFramework: () => framework, store: { read: () => stored, write: value => { stored = value; } } });
  assert.ok(switching.cachedReview('600001'), 'same framework reuses the saved review');
  framework = { active: 'technical' };
  assert.equal(switching.cachedReview('600001'), null);
  assert.equal(switching.status().framework, '技术面综合');
  const day = service.history().find(item => item.asOfDate === base.asOfDate);
  assert.deepEqual(day.customModels, ['deepseek-chat']);
  assert.equal(service.historyDay(base.asOfDate).custom.items.length, 1);
});

test('announcements reach the model only in a cleaned form', () => {
  const { sanitizeProfiles } = require('./ai-selection.cjs');
  const [stock] = sanitizeProfiles([{ code: '600001', name: '甲', announcements: [
    { date: '2026-10-28', title: '关于签订重大合同的公告', direction: '利好', risk: 0 },
    { date: 'bad', title: 'x'.repeat(80), direction: '大涨', risk: 9 },
    { title: '' }] }]);
  assert.equal(stock.announcements.length, 2);
  assert.deepEqual(stock.announcements[1], { date: '', title: `${'x'.repeat(39)}…`, direction: '中性', risk: 3 });
});

test('40 stocks are scored in batches of 10; a failed batch falls back to the framework base score', async () => {
  const { buildStockProfile, trendText } = require('./stock-profile.cjs');
  const day = i => new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10);
  const profiles = Array.from({ length: 40 }, (_, n) => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ date: day(i), close: 10 + i * 0.01 + n * 0.1, high: 10.1 + i * 0.01 + n * 0.1, low: 9.9 + i * 0.01 + n * 0.1, volume: 100, amount: 1e8 }));
    const p = buildStockProfile({ code: String(600100 + n), name: `股${n}`, rows });
    return { ...p, trend: trendText(p) };
  });
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const user = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.ok(user.stocks.length <= 10, 'each request carries at most 10 stocks');
    if (user.stocks[0].code === '600110') throw Object.assign(new Error('HTTP 500'), { status: 500 });
    return reply({ items: user.stocks.map(stock => ({ code: stock.code, score: stock.framework.base + 3, reason: '量能好' })) });
  };
  const service = createAiService({ getConfig: () => config, fetchImpl, getFramework: () => ({ active: 'technical' }) });
  const ranked = await service.rankCustom({ asOfDate: day(59), profiles });
  assert.equal(calls, 4);
  assert.equal(ranked.items.length, 40);
  assert.equal(ranked.models[0].missed, 10);
  assert.equal(ranked.items.filter(item => item.reason === 'AI 这一批没有返回，按基础分').length, 10);
});

test('the client retries with simpler requests only when the endpoint rejects parameters (HTTP 400)', async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(Object.keys(body).sort().join(','));
    if (body.response_format || body.temperature !== undefined) throw Object.assign(new Error('HTTP 400'), { status: 400 });
    return reply({ ok: true });
  };
  const client = createAiClient({ getConfig: () => config, fetchImpl });
  assert.deepEqual(await client.chat({ system: 's', user: 'u' }), { ok: true });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2], 'messages,model,stream');
  let attempts = 0;
  const limited = createAiClient({ getConfig: () => config, fetchImpl: async () => { attempts += 1; throw Object.assign(new Error('HTTP 429'), { status: 429 }); } });
  await assert.rejects(limited.chat({ system: 's', user: 'u' }), /限流/);
  assert.equal(attempts, 1, 'rate limits are not retried with other request shapes');
});

test('in AI orchestration the model picks and weights playbooks per stock; the base and the shown playbooks follow its choice', async () => {
  const { buildStockProfile, trendText } = require('./stock-profile.cjs');
  const day = i => new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10);
  const rows = Array.from({ length: 80 }, (_, i) => ({ date: day(i), close: 20 - i * 0.12, high: 20.1 - i * 0.12, low: 19.8 - i * 0.12, volume: 100, amount: 1e8 }));
  const p = buildStockProfile({ code: '600001', name: '甲', rows });
  const profile = { ...p, trend: trendText(p) };
  let sent = null, system = '';
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    system = body.messages[0].content;
    sent = JSON.parse(body.messages[1].content).stocks[0].framework;
    return reply({ items: [{ code: '600001', score: 1, plays: [{ id: 'oversold_bounce', weight: 70 }, { id: 'defensive', weight: 30 }], orchestration: '超跌但趋势仍弱，反弹+防守' }] });
  };
  const service = createAiService({ getConfig: () => config, fetchImpl });
  const ranked = await service.rankCustom({ asOfDate: day(79), profiles: [profile] });
  assert.ok(sent.situation.includes('超跌'), 'the model sees the software-detected situation');
  assert.ok(sent.candidates.length >= 3 && sent.candidates.every(item => item.id && Number.isFinite(item.fit)));
  assert.match(system, /自主选择分析策略并组合使用/);
  const [item] = ranked.items;
  assert.deepEqual(item.plays.map(play => [play.id, play.weight]), [['oversold_bounce', 70], ['defensive', 30]]);
  assert.equal(item.orchestration, '超跌但趋势仍弱，反弹+防守');
  assert.match(item.framework, /超跌反弹 70% \+ 弱市防守 30%/);
  assert.equal(item.score, Math.max(0, item.base - 15), 'the AI still moves at most 15 points from the weighted base');
});

test('1.6.52: combining models keeps the hard-rule cap and measures the AI adjustment from the average base', () => {
  const { combineRankings } = require('./ai-service.cjs');
  const ok = items => ({ status: 'fulfilled', value: { items, generatedAt: '2026-11-05T01:00:00Z', evaluated: items.length } });
  const result = combineRankings([
    { profile: { id: 'a', name: 'A' }, outcome: ok([{ code: '600001', name: '甲', score: 48, base: 48, caps: [{ id: 'broken', label: '近20日炸板≥2次' }], highlights: 'a' }]) },
    { profile: { id: 'b', name: 'B' }, outcome: ok([{ code: '600001', name: '甲', score: 77, base: 70, caps: [], highlights: 'b' }]) }
  ], { asOfDate: '2026-11-04' });
  const row = result.items[0];
  assert.equal(row.score, 59, 'a hard rule hit by any model caps the combined score at 观望');
  assert.equal(row.rating, '观望');
  assert.equal(row.base, 59);
  assert.equal(row.adjust, 0);
  assert.deepEqual(row.caps.map(cap => cap.id), ['broken']);
});

test('1.6.52: a saved API key is not reused after the interface address moves to another domain, and AI requests never follow redirects', async () => {
  const { createAiProfileStore } = require('./ai-profile-store.cjs');
  let saved = null;
  const store = createAiProfileStore({ read: () => saved, write: value => { saved = value; return value; }, encrypt: v => `enc:${v}`, decrypt: v => String(v).replace(/^enc:/, '') });
  const first = store.save({ name: '默认', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-1' }).saved;
  assert.throws(() => store.save({ id: first.id, name: '默认', baseUrl: 'https://evil.example.com/v1', model: 'x', apiKey: '••••••••' }), /重新填写/);
  store.save({ id: first.id, name: '默认', baseUrl: 'https://api.deepseek.com/beta', model: 'deepseek-chat', apiKey: '••••••••' });
  assert.equal(store.resolve(first.id).apiKey, 'sk-1', 'same domain keeps the key');
  const options = [];
  const { createAiClient } = require('./ai-client.cjs');
  const client = createAiClient({ getConfig: () => ({ baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: 'k' }), fetchImpl: async (_url, init) => { options.push(init); return { json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) }; } });
  await client.chat({ system: 's', user: 'u' });
  assert.equal(options[0].redirect, 'error');
});

test('删光模型配置后重启不会把旧设置里的 Key 迁移回来', () => {
  const { createAiProfileStore } = require('./ai-profile-store.cjs');
  let stored = null;
  const make = () => createAiProfileStore({ read: () => stored, write: value => { stored = structuredClone(value); return value; },
    encrypt: v => `enc:${v}`, decrypt: v => String(v).replace(/^enc:/, ''),
    legacy: () => ({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-old' }) });
  const first = make();
  const migrated = first.list();
  assert.equal(migrated.profiles.length, 1);
  first.remove(migrated.profiles[0].id);
  assert.equal(make().list().profiles.length, 0); // 新进程（重启）
});

test('1.6.57 #04: queued AI jobs snapshot config, instructions and framework at enqueue time', async () => {
  let currentConfig = { id: 'p1', name: '初始模型', baseUrl: 'https://first.example/v1', model: 'model-v1', apiKey: 'k1' };
  let currentInstructions = { rank: '初始打分要求', summary: '初始总结要求' };
  let currentFramework = { id: 'short_term' };
  const calls = [];
  let releaseHolders = [];
  const hold = () => new Promise(resolve => { releaseHolders.push(resolve); });
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const system = body.messages?.[0]?.content || '';
    const userText = body.messages?.[1]?.content || '';
    calls.push({ url, model: body.model, system, user: userText });
    if (String(body.model || '').startsWith('hold-model')) await hold();
    if (/记事助手/.test(system)) {
      return reply({ text: '观察600001', when: null, repeat: 'none', code: '600001', condition: null, note: '' });
    }
    if (/盘后复盘/.test(system)) {
      return reply({
        headline: '市场修复', cycle: { phase: '修复', reason: '放量回暖' }, market: '情绪回暖',
        mainlines: [{ name: '电网', comment: '强势' }], ladder: '3板', indices: '震荡',
        nextDay: { posture: '观察', focus: ['电网'], avoid: ['高位'] }, risks: ['分歧'], confidence: '中'
      });
    }
    let parsedUser = null;
    try { parsedUser = JSON.parse(userText); } catch { parsedUser = null; }
    if (parsedUser && /"headline"/.test(system) && !/"score"/.test(system)) {
      return reply({ headline: '今日总结', market: '震荡', themes: ['电网'], focus: ['600001 甲'], risks: ['回落'] });
    }
    return reply({ items: [{ code: '600001', score: 80, highlights: 'ok' }] });
  };
  let stored = null;
  const service = createAiService({
    getConfig: () => currentConfig,
    getInstructions: () => currentInstructions,
    getFramework: () => currentFramework,
    fetchImpl,
    store: { read: () => stored, write: value => { stored = value; } }
  });
  // Saturate maxActive=2 with distinct keys so subsequent calls sit in the runtime queue.
  const h1 = service.test({ baseUrl: 'https://hold.example/v1', model: 'hold-model-1', apiKey: 'hk' });
  const h2 = service.test({ baseUrl: 'https://hold.example/v1', model: 'hold-model-2', apiKey: 'hk' });
  const queuedSummary = service.summary({ asOfDate: '2026-11-05', picks: [pick('600001', '甲')] });
  const queuedNote = service.parseNote({ text: '明天看600001', now: '2026-11-05 15:10', tradingDays: ['2026-11-06'] });
  const queuedRank = service.rank({ asOfDate: '2026-11-05', picks: [pick('600001', '甲')] });

  // Mutate active settings mid-queue before queued jobs run.
  currentConfig = { id: 'p2', name: '新模型', baseUrl: 'https://second.example/v1', model: 'model-v2', apiKey: 'k2' };
  currentInstructions = { rank: '新打分要求', summary: '新总结要求' };
  currentFramework = { id: 'swing_trend' };

  while (releaseHolders.length < 2) await new Promise(r => setTimeout(r, 5));
  releaseHolders.forEach(fn => fn());
  await Promise.all([h1, h2]);

  const [sumOut, noteOut, rankOut] = await Promise.all([queuedSummary, queuedNote, queuedRank]);
  assert.equal(sumOut.model, 'model-v1');
  assert.equal(noteOut.model, 'model-v1');
  assert.equal(rankOut.models[0].model, 'model-v1');
  const sumCall = calls.find(c => /"headline"/.test(c.system) && !/"score"/.test(c.system));
  assert.match(sumCall.url, /^https:\/\/first\.example/);
  assert.match(sumCall.system, /初始总结要求/);
  assert.doesNotMatch(sumCall.system, /新总结要求/);
  const rankCall = calls.find(c => /初始打分要求/.test(c.system));
  assert.ok(rankCall && /^https:\/\/first\.example/.test(rankCall.url));
  assert.doesNotMatch(rankCall.system, /新打分要求/);
});

test('1.6.57 #10: historyDay disambiguates same-named models across endpoints by profileId/baseUrl', async () => {
  const profiles = [
    { id: 'ep-a', name: '东线同模', baseUrl: 'https://east.example/v1', model: 'shared-model', apiKey: 'k1' },
    { id: 'ep-b', name: '西线同模', baseUrl: 'https://west.example/v1', model: 'shared-model', apiKey: 'k2' }
  ];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const user = JSON.parse(body.messages[1].content);
    const score = String(url).includes('west.example') ? 60 : 80;
    return reply({ items: user.stocks.map(item => ({ code: item.code, score })) });
  };
  let stored = null;
  const service = createAiService({
    getConfig: () => profiles[0],
    getRankProfiles: () => profiles,
    fetchImpl,
    store: { read: () => stored, write: value => { stored = value; } }
  });
  await service.rank({ asOfDate: '2026-11-05', picks: [pick('600001', '甲')] });
  assert.equal(stored.entries.length, 2);
  assert.deepEqual(stored.entries.map(e => e.value.profileId).sort(), ['ep-a', 'ep-b']);
  assert.deepEqual(stored.entries.map(e => e.value.profileName).sort(), ['东线同模', '西线同模']);
  const replay = service.historyDay('2026-11-05');
  assert.equal(replay.rank.models.length, 2);
  assert.deepEqual(replay.rank.models.map(m => [m.id, m.name]).sort(), [['ep-a', '东线同模'], ['ep-b', '西线同模']]);
  assert.equal(replay.rank.items[0].score, 70);
});

test('a missing model response stays retryable and its base score does not count as an AI vote', () => {
  const { combineRankings } = require('./ai-service.cjs');
  const response = items => ({ status: 'fulfilled', value: { items, evaluated: items.length } });
  const ranked = combineRankings([
    { profile: { id: 'a', name: 'A' }, outcome: response([
      { code: '600001', name: '甲', score: 90, base: 90, fallback: true, highlights: '兜底文本' },
      { code: '600002', name: '乙', score: 55, base: 55, reason: 'AI 没有评估这只，按基础分' },
    ]) },
    { profile: { id: 'b', name: 'B' }, outcome: response([
      { code: '600001', name: '甲', score: 70, base: 65, highlights: '模型点评' },
    ]) },
  ], {});
  const [mixed, missing] = ranked.items;
  assert.equal(mixed.code, '600001');
  assert.equal(mixed.score, 70);
  assert.deepEqual(mixed.scores.map(score => score.id), ['b']);
  assert.equal(mixed.highlights, '模型点评');
  assert.equal(mixed.disagreement, false);
  assert.equal(missing.fallback, true);
  assert.deepEqual(missing.scores, []);
  assert.equal(ranked.evaluated, 1);
});

test('a partial response reports omitted stocks and retries just those stocks on the same data day', async () => {
  let stored;
  const requests = [];
  const profiles = [
    { code: '600519', name: '甲', latest: 10, changePct: 1 },
    { code: '000001', name: '乙', latest: 12, changePct: 2 }
  ];
  const service = createAiService({ getConfig: () => config, getFramework: () => ({ active: 'technical' }),
    store: { read: () => stored, write: value => { stored = value; } },
    fetchImpl: async (_url, options) => {
      const { stocks } = JSON.parse(JSON.parse(options.body).messages[1].content);
      requests.push(stocks.map(stock => stock.code));
      return reply({ items: [{ code: stocks[0].code, score: 65 }] });
    }
  });
  const input = { asOfDate: '2026-11-13', profiles };
  const first = await service.rankCustom(input);
  assert.equal(first.evaluated, 1);
  assert.equal(first.models[0].missed, 1);
  assert.equal(first.items.find(item => item.code === '000001').fallback, true);
  const second = await service.rankCustom(input);
  assert.deepEqual(requests, [['600519', '000001'], ['000001']]);
  assert.equal(second.evaluated, 2);
});

test('combineRankings preserves highlights and builds disagreementDetail when spread >= 20, and historyDayWithOutcomes computes T+1/3/5 win rates', async () => {
  const { combineRankings } = require('./ai-service.cjs');
  const combined = combineRankings([
    { profile: { id: 'p1', name: '多头模型', model: 'm1' }, outcome: { status: 'fulfilled', value: { asOfDate: '2026-11-03', items: [{ code: '600519', name: '贵州茅台', score: 86, rating: '重点关注', highlights: '首推亮点', risks: '高估值' }] } } },
    { profile: { id: 'p2', name: '风控模型', model: 'm2' }, outcome: { status: 'fulfilled', value: { asOfDate: '2026-11-03', items: [{ code: '600519', name: '贵州茅台', score: 52, rating: '观望', highlights: '有支撑', risks: '缩量回调风险' }] } } }
  ], { asOfDate: '2026-11-03' });
  assert.equal(combined.items[0].disagreement, true);
  assert.equal(combined.items[0].highlights, '首推亮点');
  assert.equal(combined.items[0].disagreementDetail.spread, 34);
  assert.equal(combined.items[0].disagreementDetail.highest.rating, '重点关注');
  assert.equal(combined.items[0].disagreementDetail.highest.thesis, '首推亮点');
  assert.equal(combined.items[0].disagreementDetail.lowest.rating, '观望');
  assert.equal(combined.items[0].disagreementDetail.lowest.thesis, '缩量回调风险');
  assert.match(combined.items[0].disagreementDetail.verificationPoint, /次日核心验证点/);
  assert.match(combined.items[0].disagreementDetail.summary, /看多\(多头模型 86分\)/);
  assert.match(combined.items[0].disagreementDetail.summary, /谨慎\(风控模型 52分\)/);

  let stored = null;
  const service = createAiService({
    getConfig: () => config,
    store: { read: () => stored, write: value => { stored = value; } },
    fetchImpl: async () => reply({ items: [{ code: '600519', score: 80, highlights: '强' }, { code: '000001', score: 72, highlights: '稳' }] }),
    evaluateOutcomes: async (_date, codes) => {
      assert.deepEqual(codes.sort(), ['000001', '600519']);
      return {
        '600519': { t1: 2.5, t3: 5.0, t5: 8.2, baseClose: 1500, asOfDate: '2026-11-03', latestDate: '2026-11-10' },
        '000001': { t1: -1.2, t3: -2.0, t5: null, baseClose: 10, asOfDate: '2026-11-03', latestDate: '2026-11-06' }
      };
    }
  });
  await service.rank({ asOfDate: '2026-11-03', picks: [pick('600519', '贵州茅台'), pick('000001', '平安银行')] });
  const replayed = await service.historyDayWithOutcomes('2026-11-03');
  assert.equal(replayed.rank.items[0].outcome.t5, 8.2);
  assert.equal(replayed.rank.outcomeSummary.evaluatedCount, 2);
  assert.equal(replayed.rank.outcomeSummary.t1.winRatePct, 50);
  assert.equal(replayed.rank.outcomeSummary.t5.winRatePct, 100);
});

test('Phase 2: AI client streams SSE chunks via onToken and falls back to non-stream JSON on HTTP 400', async () => {
  const seenTokens = [];
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"{\\"headline\\":\\"强"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"势\\"}"}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const client = createAiClient({
    getConfig: () => config,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
      body: new ReadableStream({
        start(controller) {
          for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        }
      })
    })
  });
  const streamed = await client.chat({
    system: 'test',
    user: 'hello',
    onToken: (_delta, full) => seenTokens.push(full)
  });
  assert.equal(streamed.headline, '强势');
  assert.ok(seenTokens.length >= 2);
  assert.equal(seenTokens.at(-1), '{"headline":"强势"}');

  const bodies = [];
  const fallbackClient = createAiClient({
    getConfig: () => config,
    fetchImpl: async (_url, options) => {
      const parsed = JSON.parse(options.body);
      bodies.push(parsed);
      if (parsed.stream) return { ok: false, status: 400 };
      return reply({ ok: true });
    }
  });
  const downgraded = await fallbackClient.chat({ system: 's', user: 'u', onToken: () => {} });
  assert.equal(downgraded.ok, true);
  assert.equal(bodies.at(-1).stream, false);
});

test('Phase 2: draftStrategy emits clarification, unsupportedTerms and alternatives for unsupported factors', async () => {
  const aiSelection = createAiSelection({
    ai: {
      model: () => 'deepseek-chat',
      chat: async () => ({
        name: '低估值回踩',
        description: '缺少市盈率因子',
        conditions: [],
        unsupportedTerms: ['PE<20', 'ROE>15%'],
        clarification: '当前软件暂未接入财务估值(PE/ROE)，建议改用量价、均线与涨停结构条件替代。',
        alternatives: [
          { label: '换用低位首板回踩', prompt: '近10日首板，回调不破涨停低点且缩量' },
          { label: '换用高成交活跃突破', prompt: '放量突破20日均线，成交额大于3亿' }
        ],
        notes: '已标注不支持的财务因子'
      })
    }
  });
  const res = await aiSelection.draftStrategy({ text: '市盈率低于20且ROE大于15%的股票', patterns: [{ id: 'p1', name: '首板回踩', detail: '缩量' }] });
  assert.equal(res.strategy, null);
  assert.equal(res.needsClarification, true);
  assert.deepEqual(res.unsupportedTerms, ['PE<20', 'ROE>15%']);
  assert.match(res.clarification, /PE\/ROE/);
  assert.equal(res.alternatives.length, 2);
});

test('Phase 3A: outcomesLeaderboard aggregates by model, framework, market cycle and injects high-score miss lessons', async () => {
  const storeData = {
    version: 1,
    entries: [
      {
        key: 'market:2026-10-10:m1',
        kind: 'market',
        savedAt: '2026-10-10T15:10:00Z',
        value: { asOfDate: '2026-10-10', headline: '退潮分歧', cycle: { phase: '退潮', reason: '连板炸板多' } }
      },
      {
        key: 'lookback:2026-10-11:m1',
        kind: 'lookback',
        savedAt: '2026-10-11T15:10:00Z',
        value: { asOfDate: '2026-10-11', hitRatePct: 60, lessons: ['退潮期少追高位连板'] }
      },
      {
        key: 'rank:2026-10-10:p1:fw1:h1',
        kind: 'rank',
        savedAt: '2026-10-10T15:20:00Z',
        value: {
          asOfDate: '2026-10-10',
          model: 'model-a',
          profileName: '模型A',
          framework: { id: 'short', name: '短线接力' },
          items: [
            { code: '600519', name: '贵州茅台', score: 86, rating: '重点关注', highlights: '龙头企稳', risks: '缩量追高易回踩' },
            { code: '000001', name: '平安银行', score: 78, rating: '关注', highlights: '温和放量', risks: '上方套牢盘' }
          ]
        }
      }
    ]
  };
  let capturedSystem = '';
  const service = createAiService({
    getConfig: () => ({ id: 'p1', name: '模型A', baseUrl: 'https://example.com/v1', model: 'model-a', apiKey: 'k1' }),
    getRankProfiles: () => [{ id: 'p1', name: '模型A', baseUrl: 'https://example.com/v1', model: 'model-a', apiKey: 'k1' }],
    store: { read: () => storeData, write: next => Object.assign(storeData, next) },
    evaluateOutcomes: async (asOfDate) => {
      if (asOfDate === '2026-10-10') {
        return {
          '600519': { t1: -2.1, t3: -5.6, t5: -6.2, maxDrawdownPct: -8.4, stopHit: true, baseClose: 100 },
          '000001': { t1: 1.5, t3: 4.2, t5: 5.0, maxDrawdownPct: -1.2, stopHit: false, baseClose: 10 }
        };
      }
      return {};
    },
    fetchImpl: async (_url, init) => {
      const reqBody = JSON.parse(init.body);
      capturedSystem = reqBody.messages.find(m => m.role === 'system')?.content || '';
      const payload = {
        choices: [{ message: { content: JSON.stringify({ items: [{ code: '000002', name: '万科A', score: 72, rating: '关注', highlights: '弱转强', risks: '注意回撤', nextDay: '看承接' }] }) } }]
      };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload)
      };
    }
  });

  const board = await service.outcomesLeaderboard({ days: 30 });
  assert.equal(board.daysCovered, 1);
  assert.equal(board.evaluatedSamples, 2);
  assert.equal(board.byModel[0].label, '模型A');
  assert.equal(board.byModel[0].t3.winRatePct, 50);
  assert.equal(board.byModel[0].highScoreMisses, 1);
  assert.equal(board.byModel[0].avgDrawdownPct, -4.8);
  assert.equal(board.byModel[0].stopHits, 1);
  assert.equal(board.byModel[0].stopHitRatePct, 50);
  assert.equal(board.byFramework[0].label, '短线接力');
  assert.equal(board.byCycle[0].label, '退潮');
  assert.equal(board.recentMisses.length, 1);
  assert.equal(board.recentMisses[0].code, '600519');
  assert.equal(board.recentMisses[0].maxDrawdownPct, -8.4);
  assert.equal(board.recentMisses[0].stopHit, true);
  assert.match(board.recentLessons[0], /600519/);
  assert.match(board.recentLessons[0], /最大回撤-8\.4%/);

  const ohlcOutcome = evaluateRowsOutcome([
    { date: '2026-10-09', low: 9.8, close: 10 },
    { date: '2026-10-10', low: 9.9, close: 10 },
    { date: '2026-10-11', low: 9.25, close: 9.7 },
    { date: '2026-10-12', low: 9.5, close: 10.2 },
    { date: '2026-10-13', low: 9.8, close: 10.4 },
    { date: '2026-10-14', low: 9.9, close: 10.5 },
    { date: '2026-10-15', low: 10.1, close: 10.6 }
  ], '2026-10-10');
  assert.equal(ohlcOutcome.t1, -3);
  assert.equal(ohlcOutcome.t3, 4);
  assert.equal(ohlcOutcome.t5, 6);
  assert.equal(ohlcOutcome.maxDrawdownPct, -7.5);
  assert.equal(ohlcOutcome.stopHit, true);
  assert.equal(board.lookbackStats.count, 1);
  assert.equal(board.lookbackStats.avgHitRatePct, 60);

  await service.rank({
    asOfDate: '2026-10-14',
    picks: [{ code: '000002', name: '万科A', industry: '地产', latest: 8.5, changePct: 2.1, turnover: 3.5, amount: 5e8, strategies: ['放量'] }]
  });
  assert.match(capturedSystem, /近期高分后验错题教训/);
  assert.match(capturedSystem, /600519/);
});

test("parseModelJson ignores stray brackets/braces in prose and string literals", () => {
  assert.deepEqual(
    parseModelJson('前文提到 {注意风险}，核心结论：{"ok":true,"note":"含]与{字符"} [风险自担]'),
    { ok: true, note: "含]与{字符" }
  );
  assert.deepEqual(
    parseModelJson('说明 [1]\n```json\n{"items":[{"code":"600519","score":91}]}\n```\n[注2]'),
    { items: [{ code: "600519", score: 91 }] }
  );
});

test('force: true never coalesces onto an in-flight non-forced flight across summary, rank, and marketReview', async t => {
  for (const mode of ['summary', 'rank', 'marketReview']) {
    const firstGate = deferred();
    const firstEntered = deferred();
    let calls = 0;
    const service = createAiService({
      getConfig: () => config,
      fetchImpl: async () => {
        const callIndex = ++calls;
        if (callIndex === 1) {
          firstEntered.resolve();
          await firstGate.promise;
        }
        if (mode === 'summary') {
          return reply({ headline: `总结-${callIndex}`, market: '市场', themes: [], focus: [], risks: [] });
        }
        if (mode === 'rank') {
          return reply({ items: [{ code: '600001', score: callIndex === 1 ? 60 : 88 }] });
        }
        return reply({ headline: `复盘-${callIndex}`, market: '市场', themes: [], risks: [], nextDay: [] });
      }
    });
    t.after(async () => { firstGate.resolve(); await service.shutdown(); });

    const input = mode === 'marketReview'
      ? { snapshot: { date: '2026-11-12' } }
      : { asOfDate: '2026-11-12', picks: [pick('600001', '甲')] };
    const first = service[mode](input);
    await firstEntered.promise;
    const forced = service[mode]({ ...input, force: true });
    const forcedResult = await forced;
    firstGate.resolve();
    const firstResult = await first;

    assert.equal(calls, 2, `${mode}: force: true must launch a fresh flight instead of coalescing onto the in-flight non-forced flight`);
    if (mode === 'rank') {
      assert.equal(firstResult.items[0].score, 60);
      assert.equal(forcedResult.items[0].score, 88);
    } else {
      assert.notEqual(forcedResult.headline, firstResult.headline);
    }
  }
});

test('marketContext timeout aborts loadMarket child signal cleanly so resources drain without hanging', async t => {
  let marketSignal = null;
  let cleanedUp = false;
  const service = createAiService({
    getConfig: () => config,
    marketTimeoutMs: 30,
    loadMarket: ({ signal }) => new Promise((_resolve, reject) => {
      marketSignal = signal;
      signal.addEventListener('abort', () => {
        cleanedUp = true;
        reject(signal.reason);
      }, { once: true });
    }),
    fetchImpl: async () => reply({ headline: '无市场背景总结', market: '中性', themes: [], focus: [], risks: [] })
  });
  t.after(() => service.shutdown());

  const result = await service.summary({ asOfDate: '2026-11-12', picks: [pick('600001', '甲')] });
  assert.equal(result.headline, '无市场背景总结');
  assert.equal(marketSignal?.aborted, true, 'loadMarket child signal must be aborted when marketContext times out');
  assert.equal(marketSignal?.reason?.code, 'ETIMEDOUT');
  assert.equal(cleanedUp, true, 'loadMarket abort listener must run to release resources');
});
