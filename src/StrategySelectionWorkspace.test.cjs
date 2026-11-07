'use strict';
// 策略选股工作台：自定义策略创建/编辑/复制/删除、三类策略入口与旧路由兼容。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHookHarness, walk, text, find, button } = require('../qa/research-hook-harness.cjs');
const { registerTypeScript } = require('../qa/register-typescript.cjs');

let restore, Signals, Editor, model, previousWindow, previousDocument;
before(() => {
  restore = registerTypeScript();
  Signals = require('./StrategySignalsView.tsx').default;
  Editor = require('./features/strategy-selection/CustomStrategyEditor.tsx').CustomStrategyEditor;
  model = require('./features/strategy-selection/customStrategyModel.ts');
  previousWindow = global.window; previousDocument = global.document;
});
after(() => { restore?.(); global.window = previousWindow; global.document = previousDocument; });

const definitions = [{ id: 'low_first_board', name: '低位首板', family: 'first_board', detail: '首板', stocks: [] }, { id: 'limit_ma10_pullback', name: '涨停后MA10回踩', family: 'pullback', detail: '回踩', stocks: [] }];
const saved = (patch = {}) => ({ id: 'cs_abc12345', name: '我的回踩', description: '', universe: 'limit_pool', conditions: [{ ref: 'factor:support', required: true }, { ref: 'pattern:limit_ma10_pullback' }],
  requiredAnyGroups: [], minMatchPercent: 70, filters: {}, origin: 'user', revision: 1, ...patch });

function mount({ store = [saved()], api = {}, browser = {}, fresh = false } = {}) {
  const calls = { scans: 0, saves: [], deletes: [] };
  let strategies = structuredClone(store);
  const stockApi = {
    getStrategyDefinitions: async () => definitions,
    scanStrategySignals: async () => { calls.scans += 1; return { asOfDate: '2026-10-20', strategies: [...definitions.map(item => ({ ...item, stocks: [] })),
      ...strategies.map(item => ({ id: item.id, name: item.name, type: 'custom', custom: true, family: 'custom', conditions: ['必要条件：涨停低点防守'], stocks: [{ code: '600001', name: '测试证券', matchRate: 80, signalStrength: 70 }] }))] }; },
    cancelServiceJob: async () => {},
    listCustomStrategies: async () => structuredClone(strategies),
    saveCustomStrategy: async input => { calls.saves.push(input); const strategy = { ...input, id: input.id || `cs_new${String(calls.saves.length).padStart(5, '0')}`, revision: (input.revision || 0) + 1 };
      strategies = input.id ? strategies.map(item => item.id === input.id ? strategy : item) : [...strategies, strategy]; return { strategy, strategies: structuredClone(strategies) }; },
    deleteCustomStrategy: async id => { calls.deletes.push(id); strategies = strategies.filter(item => item.id !== id); return { strategies: structuredClone(strategies) }; },
    importSettingsStrategy: async () => { const strategy = saved({ id: 'cs_import001', name: '稳健趋势（设置导入）', origin: 'legacy-settings' }); strategies = [...strategies, strategy]; return { strategy, strategies: structuredClone(strategies) }; },
    ...api
  };
  global.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, stockApi, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {}, ...browser };
  global.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  if (fresh) { delete require.cache[require.resolve('./StrategySignalsView.tsx')]; require('./features/strategy-selection/selectionReportStore.ts').setSelectionReport(null); }
  const hooks = createHookHarness(fresh ? require('./StrategySignalsView.tsx').default : Signals, { props: { onOpen() {} } });
  return { ...hooks, get tree() { return hooks.tree; }, calls };
}
const libraryButton = (tree, name) => find(tree, node => node.type === 'button' && String(node.props?.className || '').includes('strategy-library-item') && text(node).startsWith(name));
const editorNode = tree => walk(tree).find(node => node.type === Editor);

test('the unified library lists 我的策略, 涨停形态 and 趋势模型 and a saved custom strategy shows its own picks', async () => {
  const h = mount();
  try {
    h.render(); await h.flush();
    const all = text(h.tree);
    assert.match(all, /策略选股/); assert.match(all, /我的策略/); assert.match(all, /涨停形态/); assert.match(all, /趋势模型/);
    libraryButton(h.tree, '我的回踩').props.onClick(); h.render();
    const panel = walk(h.tree).find(node => node.props?.group?.id === 'cs_abc12345');
    assert.ok(panel, 'custom strategy results are rendered from its own report group');
    assert.equal(panel.props.group.stocks[0].matchRate, 80);
    assert.ok(walk(h.tree).some(node => node.type === 'button' && text(node) === '编辑'));
  } finally { h.dispose(); }
});

test('creating a strategy saves through the main-process store, selects it and reruns selection', async () => {
  const h = mount({ store: [] });
  try {
    h.render(); await h.flush();
    assert.match(text(h.tree), /还没有自己的策略/);
    const before = h.calls.scans;
    find(h.tree, node => node.type === 'button' && text(node) === '新建').props.onClick(); h.render();
    const editor = editorNode(h.tree);
    assert.ok(editor, 'new opens the editor'); assert.equal(editor.props.initial.id, null);
    editor.props.onSave({ ...model.emptyCustomStrategy(), name: '新策略', conditions: [{ ref: 'factor:trend', required: true }] }); await h.flush();
    assert.equal(h.calls.saves.length, 1); assert.equal(h.calls.saves[0].name, '新策略');
    assert.equal(editorNode(h.tree), undefined, 'editor closes after saving');
    assert.ok(h.calls.scans > before, 'saving reruns selection so the new strategy takes effect');
    assert.equal(libraryButton(h.tree, '新策略').props['aria-pressed'], true);
    assert.match(text(h.tree), /已保存「新策略」/);
  } finally { h.dispose(); }
});

test('editing keeps the id, copying starts a new strategy, and deleting asks for confirmation first', async () => {
  const h = mount();
  try {
    h.render(); await h.flush();
    libraryButton(h.tree, '我的回踩').props.onClick(); h.render();
    button(h.tree, '编辑').props.onClick(); h.render();
    let editor = editorNode(h.tree);
    assert.equal(editor.props.initial.id, 'cs_abc12345');
    editor.props.onSave({ ...editor.props.initial, minMatchPercent: 90 }); await h.flush();
    assert.equal(h.calls.saves.at(-1).id, 'cs_abc12345');
    button(h.tree, '复制').props.onClick(); h.render();
    editor = editorNode(h.tree);
    assert.equal(editor.props.initial.id, null); assert.equal(editor.props.initial.origin, 'copy'); assert.match(editor.props.initial.name, /副本$/);
    editor.props.onCancel(); h.render();
    button(h.tree, '删除').props.onClick(); h.render();
    const dialog = walk(h.tree).find(node => node.props?.request && node.props?.onResolve);
    assert.match(dialog.props.request.title, /删除「我的回踩」/);
    assert.deepEqual(h.calls.deletes, [], 'nothing is deleted before confirming');
    dialog.props.onResolve(false); await h.flush();
    assert.deepEqual(h.calls.deletes, []);
    button(h.tree, '删除').props.onClick(); h.render();
    walk(h.tree).find(node => node.props?.request && node.props?.onResolve).props.onResolve(true); await h.flush();
    assert.deepEqual(h.calls.deletes, ['cs_abc12345']);
    assert.equal(walk(h.tree).some(node => String(node.props?.className || '').includes('strategy-library-item custom')), false);
  } finally { h.dispose(); }
});

test('a built-in rule can seed a new strategy and the settings combination can be imported', async () => {
  const h = mount({ store: [] });
  try {
    h.render(); await h.flush();
    button(h.tree, '以此为基础新建').props.onClick(); h.render();
    const editor = editorNode(h.tree);
    assert.deepEqual(editor.props.initial.conditions.map(item => item.ref).length, 1);
    assert.match(editor.props.initial.conditions[0].ref, /^pattern:/);
    editor.props.onImportSettings(); await h.flush();
    assert.equal(libraryButton(h.tree, '稳健趋势（设置导入）').props['aria-pressed'], true);
  } finally { h.dispose(); }
});

test('a save rejected by the main process keeps the editor open with its message', async () => {
  const h = mount({ api: { saveCustomStrategy: async () => { throw new Error("Error invoking remote method 'strategy:custom:save': CustomStrategyError: 已有同名策略，请换一个名称"); } } });
  try {
    h.render(); await h.flush();
    find(h.tree, node => node.type === 'button' && text(node) === '新建').props.onClick(); h.render();
    editorNode(h.tree).props.onSave({ ...model.emptyCustomStrategy(), name: '我的回踩', conditions: [{ ref: 'factor:trend' }] }); await h.flush();
    const editor = editorNode(h.tree);
    assert.ok(editor); assert.equal(editor.props.error, '已有同名策略，请换一个名称');
  } finally { h.dispose(); }
});

test('trend models are strategies in the same library and the former 涨停趋势 route opens them', async () => {
  const h = mount();
  try {
    h.render(); await h.flush();
    libraryButton(h.tree, '趋势质量 v2').props.onClick(); h.render();
    const lazyTrend = walk(h.tree).find(node => node.props?.embedded === true && node.props?.focusStrategyId === 'quality-v2');
    assert.ok(lazyTrend, 'the trend scanner is embedded and focused on the chosen model');
  } finally { h.dispose(); }
  mount({ store: [] }).dispose();
  const routed = createHookHarness(Signals, { props: { onOpen() {}, initialFocus: 'trend' } });
  try {
    routed.render(); await routed.flush();
    assert.ok(walk(routed.tree).some(node => node.props?.embedded === true && node.props?.focusStrategyId), 'initialFocus=trend shows a trend model');
  } finally { routed.dispose(); }
});

test('the editor validates instantly, mirrors legacy semantics and saves only cleaned strategies', () => {
  const saves = [];
  const h = createHookHarness(Editor, { props: { initial: model.emptyCustomStrategy(), patterns: definitions, others: [saved()], saving: false, error: '', onSave: value => saves.push(value), onCancel() {} } });
  try {
    h.render();
    find(h.tree, node => node.type === 'button' && text(node).includes('保存并选股')).props.onClick(); h.render();
    assert.equal(saves.length, 0, 'an empty strategy cannot be saved');
    assert.match(text(h.tree), /请填写策略名称|请先修正/);
    find(h.tree, node => node.props?.['aria-label'] === '策略名称').props.onChange({ target: { value: '我的回踩' } }); h.render();
    find(h.tree, node => node.props?.['aria-label'] === '涨停低点防守').props.onChange(); h.render();
    find(h.tree, node => node.type === 'button' && text(node).includes('保存并选股')).props.onClick(); h.render();
    assert.equal(saves.length, 0, 'duplicate names are rejected before reaching the store');
    find(h.tree, node => node.props?.['aria-label'] === '策略名称').props.onChange({ target: { value: '  新的名字  ' } }); h.render();
    find(h.tree, node => node.props?.['aria-label'] === '板块龙头').props.onChange(); h.render();
    assert.match(text(h.tree), /选股时待确认/, 'external factors are labelled before saving');
    find(h.tree, node => node.props?.['aria-label'] === '涨停低点防守 设为必要条件').props.onChange({ target: { checked: true } }); h.render();
    find(h.tree, node => node.type === 'button' && text(node).includes('保存并选股')).props.onClick(); h.render();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].name, '新的名字');
    assert.deepEqual(saves[0].conditions, [{ ref: 'factor:support', required: true }, { ref: 'factor:sectorLeader', required: false }]);
    assert.equal(saves[0].minMatchPercent, 70, 'default match share equals the legacy 70%');
  } finally { h.dispose(); }
});

const historical = { sampleCount: 120, independentSignalDays: 60, winRate: 52.5, averageReturn: 1.2, medianReturn: 0.3,
  averageReturnLowerBound95: 0.2, edgeVsBaseline: 0.8, medianEdgeVsBaseline: 0.5, nextDayUnbuyableRate: 12.5,
  worstTradeDrawdown: -9.1, range: { from: '2025-10-01', to: '2026-09-10' }, verdict: { level: 'weak', text: '弱于基线' } };
const selectionReport = patch => ({ asOfDate: '2026-10-23', universeSize: 1, processed: 1, failed: 0,
  strategies: [{ ...definitions[0], stocks: [{ code: '600001', name: '选中证券', latest: 10.12 }], history: historical }], ...patch });
const patternButton = tree => find(tree, node => node.type === 'button' && text(node).startsWith('低位首板'));

test('both built-in and custom strategies show picked stocks without any historical reference', async () => {
  const h = mount({ fresh: true, api: { scanStrategySignals: async () => selectionReport({ strategies: [
    { ...definitions[0], stocks: [{ code: '600001', name: '选中证券' }], history: historical },
    { id: 'cs_abc12345', name: '我的回踩', custom: true, history: historical, stocks: [{ code: '600002', name: '自定义证券' }] }
  ] }) } });
  try {
    h.render(); await h.flush();
    for (const chooseCustom of [false, true]) {
      if (chooseCustom) { libraryButton(h.tree, '我的回踩').props.onClick(); h.render(); }
      const content = walk(find(h.tree, node => node.props?.className === 'strategy-signal-main'));
      const stocks = content.findIndex(node => node.type?.type?.name === 'StrategyStockPanel');
      const history = content.findIndex(node => /History|FieldEvidence/.test(node.type?.name || ''));
      assert.ok(stocks >= 0 && history === -1, 'strategies only pick stocks: no historical reference');
      const selectedButton = chooseCustom ? libraryButton(h.tree, '我的回踩') : patternButton(h.tree);
      assert.match(text(selectedButton), /本轮选出 1 只股票/);
      assert.doesNotMatch(text(selectedButton), /历史|弱于基线|样本不足/);
    }
  } finally { h.dispose(); }
});

test('strategy menu reports selection status independently of historical verdicts and discloses the snapshot near the results', async () => {
  const h = mount({ fresh: true, api: { scanStrategySignals: async () => selectionReport() } });
  try {
    h.render(); await h.flush();
    assert.match(text(patternButton(h.tree)), /本轮选出 1 只股票/);
    assert.doesNotMatch(text(patternButton(h.tree)), /历史|弱于基线|样本不足/);
    const banner = find(h.tree, node => node.props?.className === 'strategy-picks-banner' && text(node).includes('2026-10-23'));
    assert.match(text(banner), /数据日 2026-10-23.*收盘快照/);
    assert.match(text(banner), /表内行情独立刷新.*收盘快照/);
    assert.doesNotMatch(text(h.tree), /秒级/);
  } finally { h.dispose(); }
});

for (const [report, expected] of [
  [selectionReport({ strategies: [{ ...definitions[0], stocks: [], history: historical }] }), /本轮未命中/],
  [selectionReport({ processed: 0, failed: 1, strategies: [{ ...definitions[0], stocks: [], history: historical }] }), /行情暂不可用/],
  [selectionReport({ universeSize: 0, processed: 0, strategies: [{ ...definitions[0], stocks: [] }] }), /股票池为空/],
  [selectionReport({ universeSize: 2, failed: 1, strategies: [{ ...definitions[0], stocks: [] }] }), /可用数据中未命中/]
]) test(`menu empty status distinguishes ${expected}`, async () => {
  const h = mount({ fresh: true, api: { scanStrategySignals: async () => report } });
  try { h.render(); await h.flush(); assert.match(text(patternButton(h.tree)), expected); }
  finally { h.dispose(); }
});

test('selection waiting shows wall-clock elapsed time without live seconds, skips hidden ticks, and cleans up on cancel and unmount', async t => {
  let now = 100000, timerId = 0, resolve;
  const intervals = new Map(), cancellations = [];
  t.mock.method(Date, 'now', () => now);
  const h = mount({ fresh: true, store: [], browser: {
    setInterval(fn) { intervals.set(++timerId, fn); return timerId; }, clearInterval(id) { intervals.delete(id); }
  }, api: { scanStrategySignals: () => new Promise(done => { resolve = done; }), cancelServiceJob: async id => { cancellations.push(id); } } });
  try {
    h.render(); await h.flush();
    assert.equal(intervals.size, 1, 'one elapsed clock is active during selection');
    assert.match(text(h.tree), /首次.*分钟|首次.*数分钟/);
    assert.match(text(h.tree), /可.*取消/);
    const tick = () => { for (const fn of intervals.values()) fn(); h.render(); };
    now += 65000; tick();
    const elapsed = find(h.tree, node => node.props?.role === 'timer');
    assert.equal(elapsed.props['aria-live'], 'off'); assert.match(text(elapsed), /1 分 5 秒/);
    for (const status of walk(h.tree).filter(node => node.props?.role === 'status' || node.props?.['aria-live'] === 'polite')) {
      assert.doesNotMatch(text(status), /已耗时|1 分 5 秒/, 'seconds do not enter a live announcement');
    }
    global.document.hidden = true; now += 10000; tick();
    assert.match(text(find(h.tree, node => node.props?.role === 'timer')), /1 分 5 秒/);
    global.document.hidden = false; tick();
    assert.match(text(find(h.tree, node => node.props?.role === 'timer')), /1 分 15 秒/);
    button(h.tree, '取消').props.onClick(); h.render();
    assert.equal(intervals.size, 0); assert.equal(cancellations.length, 1);
    resolve(selectionReport()); await h.flush();
    assert.match(text(h.tree), /本轮选股已取消/);
    assert.equal(walk(h.tree).some(node => node.type?.type?.name === 'StrategyStockPanel'), false, 'a cancelled response cannot replace the report');
    button(h.tree, '重新选股').props.onClick(); h.render();
    assert.equal(intervals.size, 1);
    h.dispose(); assert.equal(intervals.size, 0); assert.equal(cancellations.length, 2);
  } finally { h.dispose(); }
});

test('refresh labels menu counts as previous results, restarts elapsed time, and releases the clock on completion', async t => {
  let now = 100000, resolve, timerId = 0, scans = 0;
  const intervals = new Map();
  t.mock.method(Date, 'now', () => now);
  const h = mount({ fresh: true, store: [], browser: { setInterval(fn) { intervals.set(++timerId, fn); return timerId; }, clearInterval(id) { intervals.delete(id); } },
    api: { scanStrategySignals: async () => ++scans === 1 ? selectionReport() : new Promise(done => { resolve = done; }) } });
  try {
    h.render(); await h.flush(); assert.equal(intervals.size, 0);
    now += 90000; button(h.tree, '重新选股').props.onClick(); h.render();
    assert.match(text(patternButton(h.tree)), /上轮选出 1 只股票/);
    assert.match(text(find(h.tree, node => node.props?.role === 'timer')), /0 秒/);
    assert.match(text(h.tree), /上轮结果.*2026-10-23/);
    resolve(selectionReport({ strategies: [{ ...definitions[0], stocks: [] }] })); await h.flush();
    assert.equal(intervals.size, 0); assert.match(text(patternButton(h.tree)), /本轮未命中/);
  } finally { h.dispose(); }
});

test('a failed initial selection releases its elapsed clock and never reports unavailable results as zero matches', async () => {
  let reject, timerId = 0;
  const intervals = new Map();
  const h = mount({ fresh: true, store: [], browser: { setInterval(fn) { intervals.set(++timerId, fn); return timerId; }, clearInterval(id) { intervals.delete(id); } },
    api: { scanStrategySignals: () => new Promise((_, fail) => { reject = fail; }) } });
  try {
    h.render(); await h.flush();
    assert.equal(intervals.size, 1); assert.match(text(patternButton(h.tree)), /选股中/);
    reject(new Error('测试行情读取失败')); await h.flush();
    assert.equal(intervals.size, 0);
    assert.match(text(patternButton(h.tree)), /选股未完成/);
    assert.doesNotMatch(text(patternButton(h.tree)), /选出 0|未命中/);
    assert.match(text(find(h.tree, node => node.props?.role === 'alert')), /测试行情读取失败/);
  } finally { h.dispose(); }
});

test('cache footer follows the service expiry and never promises long caching for incomplete results', async () => {
  const report = { asOfDate: '2026-10-30', universeSize: 2, processed: 1, failed: 0, strategies: definitions,
    dataQuality: { invalid: 1, stale: 0, missing: 0, excluded: 0, benchmarkReady: true }, cacheValidUntil: null };
  const h = mount({ fresh: true, store: [], api: { scanStrategySignals: async () => report } });
  try { h.render(); await h.flush(); const footer = text(find(h.tree, node => node.type === 'footer'));
    assert.match(footer, /短暂缓存/); assert.doesNotMatch(footer, /缓存到下一交易日/);
    assert.match(text(h.tree), /本轮可用数据中未命中/);
  } finally { h.dispose(); }
  const until = Date.parse('2026-11-02T15:10:00+08:00');
  const ready = mount({ fresh: true, store: [], api: { scanStrategySignals: async () => ({ ...report, processed: 2, dataQuality: { invalid: 0, stale: 0, missing: 0, benchmarkReady: true }, cacheValidUntil: until }) } });
  try { ready.render(); await ready.flush(); assert.match(text(find(ready.tree, node => node.type === 'footer')), /2026\/11\/02 15:10:00|2026\/11\/2 15:10:00/); }
  finally { ready.dispose(); }
});
