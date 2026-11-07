const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
const { createHookHarness, find, input, text, walk } = require('../qa/research-hook-harness.cjs');
const restore = registerTypeScript();
const previousCss = require.extensions['.css'];
require.extensions['.css'] = () => {};
const App = require('./App.tsx').default;
after(() => { restore(); if (previousCss) require.extensions['.css'] = previousCss; else delete require.extensions['.css']; });
const stock = { code: '600519', name: '贵州茅台', secid: '1.600519' };
function mount(search, { analyze } = {}) {
  const previous = global.window;
  const analyses = [];
  global.window = { localStorage: { getItem: () => null, setItem() {} }, clearTimeout() {}, setTimeout: () => 1,
    stockApi: { search, analyze: security => { analyses.push(security); return analyze ? analyze(security) : new Promise(() => {}); } } };
  const h = createHookHarness(App, { runEffects: false });
  h.render();
  const field = () => input(h.tree, '证券搜索：A股、ETF、可转债');
  const edit = value => { field().props.onChange({ target: { value } }); h.render(); };
  const submit = () => find(h.tree, node => node.type === 'form' && node.props.className === 'search-box').props.onSubmit({ preventDefault() {} });
  return { ...h, get tree() { return h.tree; }, analyses, field, edit, submit, dispose() { h.dispose(); global.window = previous; } };
}

test('pressing Enter during a name search actually searches and opens its result', async () => {
  let resolve;
  const h = mount(() => new Promise(yes => { resolve = yes; }));
  try {
    h.edit('贵州茅台'); const pending = h.submit(); h.render();
    assert.match(text(h.tree), /正在搜索证券/);
    resolve([stock]); await pending; h.render();
    assert.deepEqual(h.analyses, [stock]);
    assert.equal(h.tree.props['data-workspace'], 'dashboard');
    assert.ok(!walk(h.tree).some(node => node.props?.className?.includes('security-search-feedback')));
  } finally { h.dispose(); }
});

test('search failures have a retry that recovers; successful empty search is distinct', async () => {
  let fail = true;
  const h = mount(async () => { if (fail) throw Error('offline'); return []; });
  try {
    h.edit('不存在的证券'); await h.submit(); h.render();
    assert.match(text(h.tree), /证券搜索暂不可用/);
    assert.doesNotMatch(text(h.tree), /未找到“/);
    fail = false;
    find(h.tree, node => node.type === 'button' && text(node) === '重试搜索').props.onClick(); await h.flush();
    assert.match(text(h.tree), /未找到“不存在的证券”/);
    assert.doesNotMatch(text(h.tree), /暂不可用/);
    assert.deepEqual(h.analyses, []);
  } finally { h.dispose(); }
});

test('a delayed Enter result cannot navigate after the user edits the search', async () => {
  let resolve;
  const h = mount(() => new Promise(yes => { resolve = yes; }));
  try {
    h.edit('贵州'); const pending = h.submit(); h.edit('招商'); resolve([stock]); await pending; h.render();
    assert.deepEqual(h.analyses, []);
    assert.equal(h.field().props.value, '招商');
    assert.equal(h.tree.props['data-workspace'], 'signals', 'the app opens on the unified 策略选股 workspace');
  } finally { h.dispose(); }
});

test('IME Enter is ignored and six digit direct search remains available', async () => {
  let searches = 0;
  const h = mount(async () => { searches++; return [stock]; });
  try {
    h.field().props.onCompositionStart(); h.edit('贵州'); await h.submit(); h.render();
    assert.equal(searches, 0); assert.equal(h.analyses.length, 0);
    h.field().props.onCompositionEnd(); h.edit('600519'); await h.submit(); h.render();
    assert.deepEqual(h.analyses, ['600519']);
  } finally { h.dispose(); }
});

test('ordinary workspace navigation has an honest failed-board name and no hidden-stock refresh', () => {
  const h = mount(async () => []);
  try {
    const nav = find(h.tree, node => node.props?.onNavigate && node.props?.items);
    assert.equal(nav.props.items.find(item => item.id === 'previous-limit-up-failed').label, '炸板观察');
    assert.equal(nav.props.items.find(item => item.id === 'signals').label, '策略选股');
    assert.equal(nav.props.items.some(item => item.id === 'trend-screener'), false, '涨停趋势 is merged into 策略选股');
    nav.props.onNavigate('signals'); h.render();
    assert.ok(!walk(h.tree).some(node => node.props?.['aria-label'] === '刷新当前股票'));
  } finally { h.dispose(); }
});

for (const [origin, label] of [['signals', '返回策略选股'], ['trend-screener', '返回策略选股'], ['holdings', '返回持仓股'], ['previous-limit-up-failed', '返回炸板观察']]) {
  test(`global search returns to its actual ${origin} workspace`, async () => {
    const h = mount(async () => [stock]);
    try {
      find(h.tree, node => node.props?.onNavigate && node.props?.items).props.onNavigate(origin); h.render();
      h.edit(stock.name); await h.submit(); h.render();
      const dashboard = find(h.tree, node => node.props?.backLabel && node.props?.onBack);
      assert.equal(dashboard.props.backLabel, label);
      dashboard.props.onBack(); h.render();
      assert.equal(h.tree.props['data-workspace'], origin);
    } finally { h.dispose(); }
  });
}

for (const blocked of [false, true]) test(`paper confirmation rechecks current quote/account${blocked ? ' and refuses a new block' : ''}`, async () => {
  const engine = require('./features/paper-simulation/paperSimulationEngine.ts');
  const originals = { evaluatePaperExecutionReadiness: engine.evaluatePaperExecutionReadiness,
    openPaperPositionFromSignal: engine.openPaperPositionFromSignal, advancePaperSimulationByQuote: engine.advancePaperSimulationByQuote };
  const opened = [];
  let price = 10;
  engine.evaluatePaperExecutionReadiness = (_state, payload) => ({ level: blocked && payload?.quote?.latest === 12 ? 'block' : 'wait', summary: '隔离风控', recommendation: '查看条件', reasons: [], score: 50 });
  engine.openPaperPositionFromSignal = (state, payload) => { opened.push({ cash: state.cash, price: payload.quote.latest }); return { changed: false, message: '隔离样例，无持久化操作' }; };
  engine.advancePaperSimulationByQuote = state => ({ state: { ...state, cash: state.cash - 100 } });
  const h = mount(async () => [stock], { analyze: async () => ({ security: stock, quote: { latest: price, preClose: 10 }, analysis: {}, history: [], updatedAt: new Date().toISOString() }) });
  try {
    h.edit(stock.code); await h.submit(); await h.flush();
    const dashboard = () => find(h.tree, node => typeof node.props?.executePaperTrade === 'function');
    const pending = dashboard().props.executePaperTrade(); h.render();
    assert.ok(find(h.tree, node => node.props?.request?.title === '模拟下单需确认'));
    price = 12; await dashboard().props.onRetry(); await h.flush();
    find(h.tree, node => node.props?.request?.title === '模拟下单需确认').props.onResolve(true);
    await pending; h.render();
    assert.deepEqual(opened, blocked ? [] : [{ cash: 199800, price: 12 }]);
  } finally { h.dispose(); Object.assign(engine, originals); }
});

test('removing an observation preserves its favorite identity and user fields', async () => {
  const previousWindow=global.window,previousDocument=global.document;
  const sample={...stock,autoAdded:true,favorite:true,tradingDaysSince:2,observationNode:'T+2',favoriteAddedAt:'2026-10-01T00:00:00Z',createdAt:'2026-10-01T00:00:00Z',note:'用户保留备注',customField:'preserve'};
  const ordinary={...sample,code:'600000',name:'仅观察样例',favorite:false};
  let saved=[sample,ordinary];
  const media={matches:false,addEventListener(){},removeEventListener(){}};
  global.window={localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>media,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},stockApi:{
    getWatchlist:async()=>saved,getHoldings:async()=>[],getVersion:async()=>'test',
    getSettings:async()=>require('./domain/settings.ts').initialSettings,
    saveWatchlist:async next=>{saved=structuredClone(next);return saved;},
    getLimitUpPoolSnapshot:async()=>({rows:[],meta:{}}),discoverRecentLimitUps:async()=>[]
  }};
  global.document={hidden:false,addEventListener(){},removeEventListener(){},documentElement:{dataset:{},style:{}},querySelector:()=>null};
  const h=createHookHarness(App);
  try{
    h.render();await h.flush();await h.flush();
    const navigate=id=>{find(h.tree,node=>node.props?.onNavigate&&node.props?.items).props.onNavigate(id);h.render();};
    navigate('watchlist');await h.flush();await h.flush();
    const observation=()=>find(h.tree,node=>typeof node.props?.onNodeChange==='function'&&Array.isArray(node.props?.items));
    assert.equal(observation().props.items.length,2);
    await observation().props.onRemove(sample);await h.flush();
    assert.deepEqual(observation().props.items.map(item=>item.code),['600000'],'the retained favorite must not still match the observation predicate');
    await observation().props.onRemove(ordinary);await h.flush();
    assert.equal(observation().props.items.length,0);
    assert.equal(saved.length,1,'removing an observation must not delete the favorite record');
    assert.deepEqual(saved[0],{...sample,autoAdded:false});
    navigate('favorites');
    const favorites=find(h.tree,node=>node.props?.monitors&&Array.isArray(node.props?.items));
    assert.equal(favorites.props.items.length,1);
    assert.equal(favorites.props.items[0].note,'用户保留备注');
  }finally{h.dispose();global.window=previousWindow;global.document=previousDocument;}
});
