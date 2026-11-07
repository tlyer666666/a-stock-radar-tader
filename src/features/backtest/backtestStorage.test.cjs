'use strict';
// backtestStorage：回测历史在 localStorage 与组件之间的边界层。
// 它要同时应付三种输入：本版本写回的数据、旧版本残留的数据、以及被写坏的垃圾。
// 归一化出错会让回测中心显示错乱的历史、或把别人的策略参数套到当前账户上。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTypeScript } = require(path.join(__dirname, '../../../qa/register-typescript.cjs'));
registerTypeScript();

const {
  BACKTEST_HISTORY_KEY,
  BACKTEST_HISTORY_LIMIT,
  loadBacktestHistory,
  buildBacktestHistoryRecord
} = require('./backtestStorage.ts');
const { initialSettings: defaultSettings } = require('../../domain/settings.ts');

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

const validRow = (overrides = {}) => ({
  id: 'row-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  draft: { securityCode: '600519', startDate: '2025-01-02' },
  securityCode: '600519',
  securityName: '贵州茅台',
  accepted: true,
  metrics: { accepted: true, totalReturn: 12.5 },
  strategyIds: ['classic-v1'],
  ...overrides
});

test('empty or unusable storage yields an empty history', () => {
  assert.deepEqual(withStorage([], () => loadBacktestHistory(defaultSettings)), []);
  // 顶层不是数组
  assert.deepEqual(withStorage([[BACKTEST_HISTORY_KEY, JSON.stringify({ nope: true })]], () => loadBacktestHistory(defaultSettings)), []);
  // 坏 JSON
  assert.deepEqual(withStorage([[BACKTEST_HISTORY_KEY, '{bad json']], () => loadBacktestHistory(defaultSettings)), []);
});

test('valid rows survive normalisation', () => {
  const rows = withStorage([[BACKTEST_HISTORY_KEY, JSON.stringify([validRow()])]], () => loadBacktestHistory(defaultSettings));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].securityCode, '600519');
  assert.equal(rows[0].securityName, '贵州茅台');
  assert.equal(rows[0].accepted, true);
  assert.deepEqual(rows[0].strategyIds, ['classic-v1']);
});

test('rows without a usable security code are dropped', () => {
  const rows = withStorage([[
    BACKTEST_HISTORY_KEY,
    JSON.stringify([
      validRow(),
      { id: 'bad-1' },                                  // 完全没有代码
      { id: 'bad-2', securityCode: '', draft: {} },      // 空代码
      'not-an-object'
    ])
  ]], () => loadBacktestHistory(defaultSettings));
  assert.equal(rows.length, 1, '只有带合法证券代码的行被保留');
});

test('history is capped at BACKTEST_HISTORY_LIMIT', () => {
  const many = Array.from({ length: BACKTEST_HISTORY_LIMIT + 12 }, (_, i) => validRow({ id: `r${i}` }));
  const rows = withStorage([[BACKTEST_HISTORY_KEY, JSON.stringify(many)]], () => loadBacktestHistory(defaultSettings));
  assert.equal(rows.length, BACKTEST_HISTORY_LIMIT);
});

test('legacy field aliases are still understood', () => {
  // 旧版本用 input / result 而非 draft / rawResult
  const legacy = {
    id: 'legacy-1',
    input: { securityCode: '000001', startDate: '2025-01-02' },
    result: { security: { code: '000001', name: '平安银行' }, metrics: { accepted: true } }
  };
  const rows = withStorage([[BACKTEST_HISTORY_KEY, JSON.stringify([legacy])]], () => loadBacktestHistory(defaultSettings));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].securityCode, '000001');
  assert.equal(rows[0].securityName, '平安银行');
  assert.equal(rows[0].accepted, true);
});

test('buildBacktestHistoryRecord fills every field from a fresh result', () => {
  const record = buildBacktestHistoryRecord(
    { securityCode: '600519', startDate: '2025-01-02' },
    {
      security: { code: '600519', name: '贵州茅台' },
      metrics: { accepted: false, totalReturn: -3.2 },
      strategyIds: ['quality-v2'],
      benchmarkReturns: { default: 1.1 }
    },
    defaultSettings
  );
  assert.equal(record.securityCode, '600519');
  assert.equal(record.securityName, '贵州茅台');
  assert.equal(record.accepted, false);
  assert.deepEqual(record.strategyIds, ['quality-v2']);
  assert.deepEqual(record.benchmarkReturns, { default: 1.1 });
  assert.ok(record.id.includes('600519'), `id 应含证券代码，实际 ${record.id}`);
  assert.ok(record.createdAt, 'createdAt 必须存在');
});

test('buildBacktestHistoryRecord tolerates a result with no metrics or benchmark', () => {
  const record = buildBacktestHistoryRecord(
    { securityCode: '000001', startDate: '2025-01-02' },
    {},
    defaultSettings
  );
  assert.equal(record.metrics, null);
  assert.equal(record.benchmarkReturns, null);
  assert.equal(record.accepted, false);
  assert.equal(record.securityCode, '000001', '缺 result.security 时回落到草稿里的代码');
});
