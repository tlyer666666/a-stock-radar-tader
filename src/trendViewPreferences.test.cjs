'use strict';
// trendViewPreferences：把「本地存储里的任意内容」归一化成可渲染的视图偏好。
// 这是一段容易被忽视但要紧的代码——localStorage 可能被旧版本、手工编辑或别的
// 标签页写坏，归一化一旦出错，趋势页会以非法状态启动（例如策略 id 不存在、
// filter 不是允许值、qualityDraft 缺字段导致参数校验全红）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
registerTypeScript();

const KEY = 'a-stock-radar:trend-view-preferences:v1';

function withStorage(entries, run) {
  const store = new Map(entries);
  global.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear()
    }
  };
  try { return run(store); } finally { delete global.window; }
}

const load = () => {
  const mod = require('./trendViewPreferences.ts');
  return mod;
};

test('empty storage falls back to defaults', () => {
  const { readTrendViewPreferences } = load();
  const prefs = withStorage([], () => readTrendViewPreferences());
  assert.equal(prefs.scanMode, 'multi');
  assert.equal(prefs.strategyId, 'classic-v1');
  assert.deepEqual(prefs.selectedStrategies, ['classic-v1', 'quality-v2']);
  assert.equal(prefs.strategyFilter, 'all');
  assert.equal(prefs.forceRefresh, false);
  assert.equal(prefs.filter, 'all');
  assert.equal(prefs.tab, 'candidates');
  assert.equal(prefs.query, '');
  // qualityDraft 必须补齐预设的三个字段（缺失时用预设值）
  assert.deepEqual(Object.keys(prefs.qualityDraft).sort(), ['maxExtensionAtr', 'maxVolumeRatio', 'minCloseLocation']);
});

test('a valid stored document round-trips', () => {
  const { readTrendViewPreferences } = load();
  const stored = {
    scanMode: 'single', strategyId: 'classic-v1', selectedStrategies: ['quality-v2'],
    strategyFilter: 'quality-v2', qualityDraft: { maxExtensionAtr: '1.5' },
    forceRefresh: true, filter: 'watch', tab: 'plans', query: '宁德'
  };
  const prefs = withStorage([[KEY, JSON.stringify(stored)]], () => readTrendViewPreferences());
  assert.equal(prefs.scanMode, 'single');
  assert.equal(prefs.selectedStrategies.length, 1);
  assert.equal(prefs.strategyFilter, 'quality-v2');
  assert.equal(prefs.forceRefresh, true);
  assert.equal(prefs.filter, 'watch');
  assert.equal(prefs.tab, 'plans');
  assert.equal(prefs.query, '宁德');
});

test('illegal values are normalised instead of crashing the page', () => {
  const { readTrendViewPreferences } = load();
  const prefs = withStorage([[KEY, JSON.stringify({
    scanMode: 'nonsense',              // 只接受 'single'
    strategyId: 'not-a-strategy',      // 未知 id
    selectedStrategies: ['nope', 42],  // 全非法
    strategyFilter: 'whatever',
    qualityDraft: { maxExtensionAtr: 12, minCloseLocation: 'x'.repeat(40) }, // 非字符串 / 超长
    forceRefresh: 'yes',               // 非布尔 true
    filter: 'bogus',
    tab: 'bogus',
    query: 'q'.repeat(200)
  })]], () => readTrendViewPreferences());
  assert.equal(prefs.scanMode, 'multi');
  assert.equal(prefs.strategyId, 'classic-v1');
  assert.deepEqual(prefs.selectedStrategies, ['classic-v1', 'quality-v2'], '非法 id 全被过滤后回落到默认组合');
  assert.equal(prefs.strategyFilter, 'all');
  assert.equal(prefs.forceRefresh, false);
  assert.equal(prefs.filter, 'all');
  assert.equal(prefs.tab, 'candidates');
  assert.equal(prefs.query.length, 100, 'query 必须截断到 100 字符');
  // 非字符串与超长的 draft 字段回落为预设值
  assert.equal(prefs.qualityDraft.maxExtensionAtr, '2');
  assert.equal(prefs.qualityDraft.minCloseLocation, '0.7');
});

test('a corrupted document falls back without throwing', () => {
  const { readTrendViewPreferences } = load();
  const prefs = withStorage([[KEY, '{not json']], () => readTrendViewPreferences());
  assert.equal(prefs.strategyId, 'classic-v1');
  assert.equal(prefs.tab, 'candidates');
});

test('saving writes the document so it can be read back', () => {
  const { readTrendViewPreferences, saveTrendViewPreferences } = load();
  const prefs = withStorage([[KEY, JSON.stringify({ tab: 'plans' })]], () => readTrendViewPreferences());
  prefs.query = '实测';
  const ok = withStorage([[KEY, JSON.stringify(prefs)]], () => {
    const saved = saveTrendViewPreferences(prefs);
    return saved;
  });
  assert.equal(ok, true);
  const again = withStorage([[KEY, JSON.stringify(prefs)]], () => readTrendViewPreferences());
  assert.equal(again.query, '实测');
  assert.equal(again.tab, 'plans');
});
