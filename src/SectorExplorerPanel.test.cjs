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

test('board list sorts by live change or inflow and keeps boards without quotes after them', () => {
  const e = (id, kind = 'industry') => ({ id, code: id, name: id, kind, level: null, path: [], classification: '', sourceUrl: '' });
  const entries = [e('a'), e('b'), e('f10', 'classification'), e('c', 'concept')];
  const quotes = { a: { changePct: 1.2, netInflow: -1e8 }, b: { changePct: 3.4, netInflow: 2e8 }, c: { changePct: -0.5, netInflow: 5e8 } };
  assert.deepEqual(view.sortSectorEntries(entries, quotes, 'change-desc').map(x => x.id), ['b', 'a', 'c', 'f10']);
  assert.deepEqual(view.sortSectorEntries(entries, quotes, 'change-asc').map(x => x.id), ['c', 'a', 'b', 'f10']);
  assert.deepEqual(view.sortSectorEntries(entries, quotes, 'inflow-desc').map(x => x.id), ['c', 'b', 'a', 'f10']);
  assert.deepEqual(view.sortSectorEntries(entries, quotes, 'name').map(x => x.id), ['a', 'b', 'f10', 'c']);
  assert.deepEqual(view.sortSectorEntries(entries, undefined, 'change-desc').map(x => x.id), ['a', 'b', 'f10', 'c'], 'without quotes the directory order is kept');
});

test('member columns sort with unknown values last', () => {
  const m = (code, changePercent, amount) => ({ code, name: code, secid: `0.${code}`, latest: 10, changePercent, amount, turnover: null });
  const rows = [m('000001', 1, null), m('000002', null, 5), m('000003', 4, 2)];
  assert.deepEqual(view.sortSectorMembers(rows, { key: 'changePercent', desc: true }).map(x => x.code), ['000003', '000001', '000002']);
  assert.deepEqual(view.sortSectorMembers(rows, { key: 'amount', desc: false }).map(x => x.code), ['000003', '000002', '000001']);
  assert.deepEqual(view.sortSectorMembers(rows, { key: 'source', desc: true }).map(x => x.code), ['000001', '000002', '000003']);
});

test('board detail shows inflow, leader, the index trend and the anonymous member limit', () => {
  const board = { ...detail, status: 'partial', entry: { ...detail.entry, kind: 'industry', id: 'ths:industry:881270', name: '元件' },
    metrics: { changePercent: -0.72, amount: 81616000000, rising: 24, falling: 39 },
    coverage: { ...detail.coverage, loaded: 100, complete: false, anonymousLimit: { pages: 5, approxTotal: 140 } },
    trend: { asOf: '2026-10-21', change5: 2.15, change20: -3.4, closes: Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, close: 100 + Math.sin(i) })) } };
  const h = renderToStaticMarkup(React.createElement(view.SectorExplorerDetailView, { detail: board, onOpenStock: () => {},
    quote: { changePct: -0.72, netInflow: -3.2e8, indexCode: '881270', leaderName: '鹏鼎控股', leaderChangePct: 4.1, companyCount: 63 } }));
  assert.match(h, /主力净流入/);
  assert.match(h, /−3\.20 亿/);
  assert.match(h, /鹏鼎控股/);
  assert.match(h, /\+4\.10%/);
  assert.match(h, /近 5 日/);
  assert.match(h, /\+2\.15%/);
  assert.match(h, /-3\.40%/);
  assert.match(h, /<svg[^>]*sector-explorer-sparkline/);
  assert.match(h, /同花顺未登录只开放前 100 只（共约 140 只）/);
  assert.match(h, /aria-sort/);
});
