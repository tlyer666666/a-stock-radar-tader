const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const restore = require('../../../qa/register-typescript.cjs').registerTypeScript();
after(restore);
const model = require('./limitUpPoolModel.ts');

test('shows the entire sorted pool by default and searches all stocks', () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ code: String(600000 + index), name: `样本${index}`, latest: index }));
  const result = model.selectLimitUpRows(items, { query: '', sort: { key: 'latest', direction: 'desc' } });
  assert.equal(result.visible.length, 12);
  assert.equal(result.visible[0].code, '600011');
  assert.equal(model.selectLimitUpRows(items, { query: '样本1', sort: { key: 'latest', direction: 'asc' } }).visible.length, 3);
});

test('unknown numeric values sort last in both directions and zero remains a real value', () => {
  const items = [{ code: '600001', latest: null }, { code: '600002', latest: 0 }, { code: '600003', latest: 3 }, { code: '600004' }];
  for (const direction of ['asc', 'desc']) {
    const { visible } = model.selectLimitUpRows(items, { query: '', sort: { key: 'latest', direction } });
    assert.deepEqual(visible.slice(-2).map(row => row.code), ['600001', '600004']);
    assert.equal(visible[direction === 'asc' ? 0 : 1].latest, 0);
  }
});

test('column preferences cannot hide identity columns or retain invalid widths', () => {
  const prefs = model.normalizeColumnPreferences({ visible: ['amount', 'unknown'], widths: { code: -100, name: Infinity, amount: 99999 } });
  assert.deepEqual(prefs.visible, ['code', 'name', 'amount']);
  assert.ok(prefs.widths.code >= 48);
  assert.ok(Number.isFinite(prefs.widths.name));
  assert.ok(prefs.widths.amount <= 480);
});

test('first seal times sort chronologically across minute and second precision', () => {
  const items = [{ code: '1', firstSealTime: '09:30' }, { code: '2', firstSealTime: '09:00:01' }, { code: '3', firstSealTime: '25:00' }];
  for (const direction of ['asc', 'desc']) {
    const result = model.selectLimitUpRows(items, { query: '', sort: { key: 'firstSealTime', direction } });
    assert.deepEqual(result.visible.map(row => row.code), direction === 'asc' ? ['2', '1', '3'] : ['1', '2', '3']);
  }
});

test('large limit-up lists mount a bounded window with reachable first and last securities at either density', () => {
  const {limitPoolWindow} = require('./limitUpPoolModel.ts');
  for (const height of [28,42]) {
    assert.deepEqual(limitPoolWindow(80,0,400,height),{start:0,end:80});
    const top = limitPoolWindow(800,0,400,height);
    assert.equal(top.start,0); assert.ok(top.end < 30);
    const end = limitPoolWindow(800,800*height,400,height);
    assert.equal(end.end,800); assert.ok(end.end-end.start < 30);
    const filtered = limitPoolWindow(90,800*height,400,height);
    assert.ok(filtered.start < 90 && filtered.end === 90);
  }
});

test('rendering 800 stocks keeps the full accessible row count and only mounts the initial viewport', () => {
  const React = require('react'), {renderToStaticMarkup} = require('react-dom/server');
  const Pool = require('./LimitUpPool.tsx').default;
  const items = Array.from({length:800}, (_, i) => ({code:String(600000+i),name:'股票'+i,secid:'1.'+(600000+i)}));
  const html = renderToStaticMarkup(React.createElement(Pool,{items,onAdd(){},onOpen(){}}));
  assert.match(html,/aria-rowcount="801"/);
  assert.ok((html.match(/aria-rowindex=/g)||[]).length <= 30);
  assert.match(html,/aria-label="监控股票0"/);
  assert.doesNotMatch(html,/aria-label="监控股票799"/);
});
