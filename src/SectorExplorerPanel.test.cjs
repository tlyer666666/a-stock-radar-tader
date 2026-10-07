const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
let restore, view;
before(() => { restore = registerTypeScript(); require.extensions['.css'] = () => { }; view = require('./SectorExplorerPanel.tsx'); });
after(() => { restore(); delete require.extensions['.css']; });
const detail = { status: 'partial', entry: { id: 'x', code: 'x', name: '印制电路板', kind: 'classification', level: 3, path: ['电子', '元件', '印制电路板'], classification: '同花顺 F10 三级行业字段', sourceUrl: 'https://basic.10jqka.com.cn/300964/field.html' }, fetchedAt: '2026-09-30T01:00:00.000Z', asOf: null, reportDate: '2026-06-30', members: [{ code: '300964', name: '本川智能', secid: '0.300964', latest: null, changePercent: null, turnover: null, amount: null }], coverage: { loaded: 1, declared: 49, excluded: 0, invalid: 0, pagesLoaded: 1, pagesTotal: 1, complete: false, scope: '同行对比名单' }, metrics: null, sources: [], warnings: ['不是实时完整成分'], evidence: [], relatedTerms: [] };
test('classification detail labels report date and coverage without fake quotes', () => { const h = renderToStaticMarkup(React.createElement(view.SectorExplorerDetailView, { detail, onOpenStock: () => { }, onSearch: () => { } })); assert.match(h, /2026-06-30/); assert.match(h, /报告期/); assert.match(h, /49/); assert.match(h, /未提供/); assert.doesNotMatch(h, /0\.00%|覆盖完整|强度分/); });
test('unknown source date cannot display as current market quote', () => { const h = renderToStaticMarkup(React.createElement(view.SectorExplorerDetailView, { detail: { ...detail, entry: { ...detail.entry, kind: 'concept' }, metrics: { changePercent: 2.4, amount: null, rising: null, falling: null } }, onOpenStock: () => { }, onSearch: () => { } })); assert.match(h, /行情日期未提供/); assert.match(h, /2\.40%/); assert.match(h, /抓取时间/); assert.doesNotMatch(h, /上涨家数<\/span><strong>0/); });
test('filter includes paths and id, stable order prioritizes actual hierarchy', () => { const entries = [{ ...detail.entry, id: 'concept', kind: 'concept', level: null }, { ...detail.entry, id: 'level2', level: 2, name: '元件', path: ['电子', '元件'] }, detail.entry]; assert.deepEqual(view.filterSectorEntries(entries, '', 'all').map(x => x.id), ['level2', 'x', 'concept']); assert.equal(view.filterSectorEntries(entries, '电子', 'classification').length, 2); });

test('compact detail keeps incomplete coverage and date visible while explanations are collapsed', () => {
  const h = renderToStaticMarkup(React.createElement(view.SectorExplorerDetailView, { detail, onOpenStock() {} }));
  assert.match(h, /<details[^>]*class="sector-explorer-data-details"/);
  assert.match(h, /部分资料|数据不完整/);
  assert.match(h, /行情日期/);
  assert.doesNotMatch(h, /<details[^>]*open|名单不构成选股信号|不能用于确认今日板块强弱/);
});
