'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHookHarness, walk, text, find, button, input } = require('../qa/research-hook-harness.cjs');
const { registerTypeScript } = require('../qa/register-typescript.cjs');

let restore, Signals, Trend, filterSignalGroups, previousWindow, previousDocument;
before(() => {
  restore = registerTypeScript();
  ({ default: Signals, filterSignalGroups } = require('./StrategySignalsView.tsx'));
  Trend = require('./TrendScreenerView.tsx').default;
  previousWindow = global.window; previousDocument = global.document;
});
after(() => { restore?.(); global.window = previousWindow; global.document = previousDocument; });

const candidate = { security: { secid: '1.600001', code: '600001', name: '测试证券' }, board: 'main', asOf: '2026-10-20', limitDate: '2026-10-14', daysSinceLimit: 4, limitEvidence: 'official', stage: 'signal', patterns: ['A'], metrics: { close: 10, ma20: 9.7, ma60: 9, avgAmount20: 200000000, deviationPercent: 3.09, relativeStrength20: null, atr14: 0.2 }, plan: { stop: 9.5, maxEntry: 10.3, maxRiskPercent: 7.77, holdingDays: '10–30 个交易日' }, warnings: [], evidence: [] };
const snapshot = (change = {}) => ({ phase: 'completed', candidates: [], coverageComplete: true, boards: [], errors: [], processed: 1, unavailable: 0, failed: 0, excluded: 0, marketGate: 'unknown', ...change });

// Keep the real components and handlers. Only React's scheduling and the external
// stock API / browser surface are replaced so transitions can run without a DOM.
function harness(Component, { api = {}, preferences = {} } = {}) {
  const data = new Map([['a-stock-radar:trend-view-preferences:v1', JSON.stringify(preferences)]]);
  let hooks;
  const fields = new Map();
  const scope = { open: false, querySelector(selector) {
    const panel = walk(hooks.tree).find(node => node.type?.name === 'TrendStrategyPanel');
    const panelHooks = createHookHarness(panel.type, { props: panel.props });
    const fieldName = selector.match(/data-trend-field="([^"]+)"/)[1];
    const rendered = panelHooks.render(); panelHooks.dispose();
    if (!walk(rendered).some(node => node.props?.['data-trend-field'] === fieldName)) return null;
    if (!fields.has(selector)) fields.set(selector, { focused: false, disclosure: { open: false }, closest() { return this.disclosure; }, focus() { this.focused = true; } });
    return fields.get(selector);
  } };
  global.window = { localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }, stockApi: { getTrendScan: async () => snapshot(), cancelServiceJob: async () => {}, getStrategyDefinitions: async () => [], ...api }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {} };
  global.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  hooks = createHookHarness(Component, { props: { onOpen() {} }, bindRefs(tree) {
    for (const node of walk(tree)) if (node.props?.ref && typeof node.props.ref === 'object') node.props.ref.current = scope;
  } });
  return { ...hooks, get tree() { return hooks.tree; }, fields, scope };
}

// 放在最前：策略页会在模块里记住上一轮结果，这条用例需要还没有任何结果时的状态。
test('while a selection runs the library and status count only active strategies, not retired ones', async () => {
  const definitions = [
    { id: 'live', name: '在用策略', family: 'bottom_trend', featured: true, detail: '' },
    { id: 'old', name: '下线策略', family: 'relay', retired: true, detail: '' }
  ];
  const h = harness(Signals, { api: { getStrategyDefinitions: async () => definitions, scanStrategySignals: () => new Promise(() => {}) } });
  try {
    h.render(); await h.flush();
    const hide = walk(h.tree).find(node => node.type === 'input' && node.props.type === 'checkbox');
    if (hide) { hide.props.onChange({ target: { checked: false } }); h.render(); }
    assert.ok(walk(h.tree).some(node => node.type === 'button' && text(node).startsWith('在用策略')));
    assert.equal(walk(h.tree).some(node => node.type === 'button' && text(node).startsWith('下线策略')), false, 'retired rules are not listed in the library');
    assert.ok(walk(h.tree).some(node => /正在按 1 套策略规则选股/.test(text(node))), 'the running status counts active rules only');
  } finally { h.dispose(); }
});

test('strategy lookup finds necessary conditions and component names', () => {
  const groups = [{ id: 'rule', name: '组合', detail: '', conditions: ['收盘高于 MA60'], componentNames: ['布林收缩'], stocks: [] }];
  assert.equal(filterSignalGroups(groups, 'ma60', 'catalog', 'all').length, 1);
  assert.equal(filterSignalGroups(groups, '布林收缩', 'catalog', 'all').length, 1);
});

test('refresh keeps an explicitly selected strategy even when it returns zero stocks', async () => {
  const report = { strategies: [{ id: 'hit', name: '有结果策略', family: 'relay', stocks: [{ code: '600001', name: '测试证券' }] }, { id: 'zero', name: '零结果策略', family: 'first_board', stocks: [] }] };
  const h = harness(Signals, { api: { scanStrategySignals: async () => report } });
  try {
    h.render(); await h.flush();
    // 默认隐藏本轮无结果的策略；先取消隐藏再点选零结果策略。
    find(h.tree, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: false } }); h.render();
    find(h.tree, node => node.type === 'button' && text(node).startsWith('零结果策略')).props.onClick(); h.render();
    button(h.tree, '重新选股').props.onClick(); await h.flush();
    assert.equal(find(h.tree, node => node.type === 'button' && text(node).startsWith('零结果策略')).props['aria-pressed'], true);
  } finally { h.dispose(); }
});

test('an empty strategy search can clear both the search and family filters', async () => {
  const h = harness(Signals, { api: { scanStrategySignals: async () => ({ strategies: [{ id: 'one', name: '策略一', family: 'relay', stocks: [] }] }) } });
  try {
    h.render(); await h.flush(); input(h.tree, '策略家族').props.onChange({ target: { value: 'first_board' } }); h.render();
    find(h.tree, node => node.type === 'input').props.onChange({ target: { value: '不匹配' } }); h.render();
    button(h.tree, '清除筛选').props.onClick(); h.render();
    assert.equal(find(h.tree, node => node.type === 'input').props.value, '');
    assert.equal(input(h.tree, '策略家族').props.value, 'all');
    assert.ok(walk(h.tree).some(node => node.type === 'button' && text(node).startsWith('策略一')));
  } finally { h.dispose(); }
});

test('candidates hidden by a stage or result strategy offer one action that clears all filters', async () => {
  const h = harness(Trend, { api: { getTrendScan: async () => snapshot({ candidates: [candidate] }) }, preferences: { filter: 'watch', strategyFilter: 'quality-v2', query: '不匹配' } });
  try {
    h.render(); await h.flush();
    const empty = find(h.tree, node => node.props?.className === 'trend-empty');
    assert.match(text(empty), /已有 1 条研究候选/);
    button(empty, '清除筛选').props.onClick(); h.render();
    assert.equal(input(h.tree, '搜索代码或名称').props.value, '');
    assert.equal(input(h.tree, '结果策略').props.value, 'all');
    assert.ok(!walk(h.tree).some(node => node.props?.className === 'trend-empty'));
  } finally { h.dispose(); }
});

test('a truly empty candidate set is not described as a failed search', async () => {
  const h = harness(Trend, { preferences: { query: '不匹配' } });
  try { h.render(); await h.flush(); const empty = find(h.tree, node => node.props?.className === 'trend-empty'); assert.match(text(empty), /目前没有可展示的研究候选/); assert.doesNotMatch(text(empty), /未找到匹配/); }
  finally { h.dispose(); }
});

test('saved plans hidden by a result strategy retain their own filtered empty state', async () => {
  const { createSavedTrendPlan, writeTrendPlans } = require('./trendWorkspace.ts');
  const h = harness(Trend, { preferences: { tab: 'plans', strategyFilter: 'quality-v2' } });
  assert.equal(writeTrendPlans(window.localStorage, [createSavedTrendPlan(candidate, snapshot())]), true);
  try {
    h.render(); await h.flush(); const empty = find(h.tree, node => node.props?.className === 'trend-empty');
    assert.match(text(empty), /已有 1 条计划/); button(empty, '清除筛选').props.onClick(); h.render();
    assert.equal(input(h.tree, '结果策略').props.value, 'all');
    assert.ok(!walk(h.tree).some(node => node.props?.className === 'trend-empty'));
  } finally { h.dispose(); }
});

for (const kind of ['start', 'cancel']) test(`retry repeats a failed ${kind} request after a successful status refresh`, async () => {
  let calls = 0;
  const current = snapshot({ phase: kind === 'cancel' ? 'scanning' : 'completed' });
  const h = harness(Trend, { api: { getTrendScan: async () => current, [kind === 'start' ? 'startTrendScan' : 'cancelTrendScan']: async () => { calls++; if (calls === 1) throw new Error('离线'); return snapshot(); } } });
  try {
    h.render(); await h.flush(); button(h.tree, kind === 'start' ? '扫描全 A 股' : '取消扫描').props.onClick(); await h.flush();
    input(h.tree, '刷新扫描状态').props.onClick(); await h.flush();
    const error = find(h.tree, node => node.props?.role === 'alert'); assert.match(text(error), /离线/);
    button(error, '重试').props.onClick(); await h.flush();
    assert.equal(calls, 2); assert.ok(!walk(h.tree).some(node => node.props?.role === 'alert'));
  } finally { h.dispose(); }
});

for (const { preferences, fieldName, label } of [
  { preferences: { qualityDraft: { maxExtensionAtr: '', minCloseLocation: '0.7', maxVolumeRatio: '3' } }, fieldName: 'maxExtensionAtr', label: /最大均线偏离/ },
  { preferences: { qualityDraft: { minCloseLocation: '1' } }, fieldName: 'minCloseLocation', label: /最低收盘位置/ },
  { preferences: { qualityDraft: { maxVolumeRatio: '0' } }, fieldName: 'maxVolumeRatio', label: /最高五日量比/ },
  { preferences: { qualityDraft: { maxExtensionAtr: '2.1' } }, fieldName: 'scanReason', label: /扫描 \/ 调参原因/ },
  { preferences: { researchEnd: '2026-10-20' }, fieldName: 'researchStart', label: /研究区间/ },
  { preferences: { researchStart: '2026-10-21', researchEnd: '2026-10-20' }, fieldName: 'researchEnd', label: /研究区间/ }
]) test(`invalid ${fieldName} opens its disclosures and focuses the input without starting a scan`, async () => {
  let starts = 0;
  const h = harness(Trend, { api: { startTrendScan: async () => { starts++; return snapshot(); } }, preferences });
  try {
    h.render(); await h.flush(); button(h.tree, '扫描全 A 股').props.onClick(); await h.flush();
    assert.equal(starts, 0); assert.equal(h.scope.open, true);
    const field = h.fields.get(`[data-trend-field="${fieldName}"]`); assert.ok(field?.focused); assert.equal(field.disclosure.open, true);
    assert.match(text(find(h.tree, node => node.props?.role === 'alert')), label);
  } finally { h.dispose(); }
});

test('featured strategies are listed first and open by default; the rest sit under 更多策略', async () => {
  const stock = code => ({ code, name: `证券${code}` });
  const report = { strategies: [
    { id: 'plain', name: '普通策略', family: 'repair', stocks: [stock('600010'), stock('600011'), stock('600012')] },
    { id: 'star', name: '精选策略甲', family: 'bottom_trend', featured: true, stocks: [stock('600001')] },
    { id: 'empty', name: '本轮空策略', family: 'relay', stocks: [] }
  ] };
  const h = harness(Signals, { api: { scanStrategySignals: async () => report } });
  try {
    h.render(); await h.flush();
    const hide = find(h.tree, node => node.type === 'input' && node.props.type === 'checkbox');
    hide.props.onChange({ target: { checked: true } }); h.render();
    const labels = walk(h.tree).filter(node => node.type === 'button' && /^(精选策略甲|普通策略)/.test(text(node))).map(node => text(node));
    assert.deepEqual(labels.map(label => label.startsWith('精选') ? 'star' : 'plain'), ['star', 'plain'], 'the featured rule is listed before the others');
    assert.ok(walk(h.tree).some(node => text(node) === '精选策略'), 'a 精选策略 section heading is shown');
    assert.ok(walk(h.tree).some(node => /^更多策略/.test(text(node))), 'other rules sit under 更多策略');
    assert.equal(find(h.tree, node => node.type === 'button' && text(node).startsWith('精选策略甲')).props['aria-pressed'], true, 'a featured rule opens by default even with fewer picks');
    assert.equal(walk(h.tree).some(node => node.type === 'button' && text(node).startsWith('本轮空策略')), false, 'empty strategies can be hidden');
    const panel = walk(h.tree).find(node => node.type?.type?.name === 'StrategyStockPanel' || node.type?.name === 'StrategyStockPanel' || node.props?.group?.id === 'star');
    assert.equal(panel?.props.group.id, 'star');
  } finally { h.dispose(); }
});

test('the by-stock summary covers featured strategies by default, can switch to all, and offers copying codes', () => {
  const { StrategyStockSummaryPanel } = require('./StrategySignalsView.tsx');
  const stock = code => ({ code, name: `证券${code}` });
  const groups = [
    { id: 'plain', name: '普通策略', family: 'repair', stocks: [stock('600010'), stock('600011')] },
    { id: 'star', name: '精选策略甲', family: 'bottom_trend', featured: true, stocks: [stock('600001')] }
  ];
  global.window = { stockApi: {}, setInterval() { return 0; }, clearInterval() {}, setTimeout() { return 0; }, clearTimeout() {} };
  global.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const Panel = StrategyStockSummaryPanel.type || StrategyStockSummaryPanel;
  const h = createHookHarness(Panel, { props: { groups, live: false } });
  try {
    let tree = h.render();
    const copy = () => walk(tree).find(node => node.type?.name === 'CopyCodesButton').props.codes;
    assert.deepEqual(copy(), ['600001'], 'only featured strategies are summarised by default');
    find(tree, node => node.type === 'button' && text(node) === '全部策略').props.onClick(); tree = h.render();
    assert.deepEqual([...copy()].sort(), ['600001', '600010', '600011']);
    find(tree, node => node.type === 'button' && text(node) === '精选策略').props.onClick(); tree = h.render();
    assert.deepEqual(copy(), ['600001']);
  } finally { h.dispose(); }
});
