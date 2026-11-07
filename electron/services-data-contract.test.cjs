'use strict';
require('../qa/test-env.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const services=require('./services.cjs');
const security={code:'600001',secid:'1.600001',assetType:'stock'};
const bar=date=>({date,open:10,high:11,low:9,close:10,volume:1000,amount:1000000});
const quote=patch=>({code:'600001',preClose:10,latest:10,open:10,high:11,low:9,volume:1000,volumeUnit:'lots',amount:1000000,quoteAt:'2026-10-30T07:00:00Z',quoteAtIsTradeTime:true,...patch});
function serviceFixture(snapshot){
 const filename=path.join(__dirname,'services.cjs'),realRequire=createRequire(filename),module={exports:{}};
 const fake={configured:()=>true,dailyHistory:async()=>Object.assign([bar('2026-10-29'),bar('2026-10-30')],{index:false,adjustment:0}),snapshot:async()=>new Map([['600001.SH',snapshot]])};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:id=>id==='./fuyao-client.cjs'?{...realRequire(id),createFuyaoClient:()=>fake}:realRequire(id),__dirname,__filename:filename,process,console,URL,DOMException,AbortController,AbortSignal,TextDecoder,setTimeout,clearTimeout,setImmediate,Buffer},{filename});return module.exports;
}

test('snapshot output time cannot stand in for actual stock trading evidence when appending daily bars',()=>{
 const rows=[bar('2026-10-29')];
 assert.equal(services.fuyaoQuoteBelongsAfter(rows,quote({quoteAtIsTradeTime:false}),'2026-10-30'),false);
 assert.equal(services.fuyaoQuoteBelongsAfter(rows,quote({quoteAt:'2026-10-31T02:00:00Z'}),'2026-10-31'),false);
 assert.equal(services.fuyaoQuoteBelongsAfter(rows,quote({quoteAt:'2026-10-30T00:30:00Z'}),'2026-10-30'),false);
 assert.equal(services.fuyaoQuoteBelongsAfter(rows,quote({quoteAt:'2026-10-01T02:00:00Z'}),'2026-10-01'),false);
 assert.equal(services.fuyaoQuoteBelongsAfter(rows,quote({volume:0,amount:0}),'2026-10-30'),false);
 assert.equal(services.fuyaoQuoteBelongsAfter(rows,quote({quoteAt:'2026-10-29T07:00:00Z'}),'2026-10-30'),false);
 assert.equal(services.fuyaoQuoteBelongsAfter(rows,quote({}),'2026-10-30'),true,'genuine traded-time evidence and continuous close can still append');
});

test('real Fuyao history path keeps Friday unchanged for weekend and pre-open flat-price snapshots',async()=>{
 for(const [at,tradeTime] of [['2026-10-31T02:00:00Z',false],['2026-10-31T02:00:00Z',true],['2026-11-02T00:30:00Z',false],['2026-11-02T00:30:00Z',true],['2026-11-02T02:00:00Z',false]]){
  const svc=serviceFixture(quote({quoteAt:at,quoteAtIsTradeTime:tradeTime}));
  try{const rows=await svc.trendThsLane.history(security,{limit:20,fqt:0});assert.deepEqual(Array.from(rows,r=>r.date),['2026-10-29','2026-10-30'],at);}
  finally{await svc.shutdownServiceResources();}
 }
});

function universeFixture(pages,cache={}){
 const source=fs.readFileSync(path.join(__dirname,'services.cjs'),'utf8'),start=source.indexOf('async function loadSelectionUniverse()'),end=source.indexOf('\nconst strategySelectionLoader',start);
 return vm.runInNewContext(`(${source.slice(start,end).trim()})`,{serviceSignal:()=>new AbortController().signal,SELECTION_UNIVERSE_BOARDS:[{label:'fixture',filter:'mock'}],serviceRuntime:{track:fn=>fn()},trackServiceRequest:p=>p,strategySelectionMarketData:{fetchUniversePage:async({page})=>{const value=typeof pages==='function'?pages(page):pages[page-1];if(value instanceof Error)throw value;return value;}},industryFromIndex:()=>null,
  readSelectionUniverseCache:()=>cache.saved||null,writeSelectionUniverseCache:boards=>{cache.written=boards.map(board=>board.rows.length);}});
}
test('1.6.47: a board that switched source mid-way is read again from page 1 once',async()=>{
 let calls=0;
 const result=await universeFixture(page=>{calls++;return calls===2?{total:150,rows:members(50)}:page===1?{total:101,rows:members(100)}:{total:101,rows:[{code:'600100'}]};})();
 assert.equal(result.boards[0].complete,true);assert.equal(result.rows.length,101);assert.equal(calls,4,'first read fails on page 2, the second read succeeds');
});
test('1.6.47: a board the sources could not read in full falls back to the last complete roster saved on this machine',async()=>{
 const cache={saved:{v:1,savedAt:Date.now(),savedDate:'2026-11-03',boards:{fixture:members(3)}}};
 const result=await universeFixture([new Error('新浪全A名单缺页：2300/5577')],cache)();
 assert.equal(result.boards[0].complete,true);assert.equal(result.boards[0].fromCache,'2026-11-03');assert.equal(result.rows.length,3);
 assert.match(result.boards[0].error,/本机 2026-11-03 的完整名单/);
 assert.equal(cache.written,undefined,'a roster taken from the cache is not saved again');
 const fresh={};
 await universeFixture([{total:2,rows:members(2)}],fresh)();
 assert.deepEqual([...fresh.written],[2],'a complete read refreshes the saved roster');
 await assert.rejects(universeFixture([new Error('缺页')],{})(),/缺页/,'without a saved roster the failure is still reported');
});
const members=n=>Array.from({length:n},(_,i)=>({code:String(600000+i),name:'fixture'}));
test('universe coverage uses unique valid codes and flags overlapping or malformed pages as partial',async()=>{
 const first=members(100);
 for(const next of [[{code:'600099'}],[{code:''}],[{code:'600100'},{code:'600101'}]]){
  const result=await universeFixture([{total:101,rows:first},{total:101,rows:next}])();
  assert.equal(result.boards[0].complete,false);assert.ok(result.boards[0].error);
  assert.equal(new Set(Array.from(result.rows,r=>r.code)).size,result.rows.length);
 }
 const complete=await universeFixture([{total:101,rows:first},{total:101,rows:[{code:'600100'}]}])();
 assert.equal(complete.boards[0].complete,true);assert.equal(complete.boards[0].loaded,101);assert.equal(complete.rows.length,101);
});

test('1.6.51: sector members mark ST limit-ups at the current exchange limit and never mark new listings by price', () => {
  const source = fs.readFileSync(path.join(__dirname, 'services.cjs'), 'utf8');
  const start = source.indexOf('function markMemberLimitUps('), end = source.indexOf('\nasync function analyzeSector', start);
  const rules = require('./price-limit-rules.cjs');
  const mark = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { finiteOrNull: v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)), priceLimitRate: rules.priceLimitRate, isLimitUpPrice: rules.isLimitUpPrice, roundPrice: v => Math.round(v * 100 + 1e-7) / 100 });
  const rows = mark([
    { code: '600001', name: '*ST甲', quoteStatus: 'live', preClose: 2.00, latest: 2.20, changePct: 10 },
    { code: '600002', name: 'ST乙', changePct: 9.95 },
    { code: '603999', name: 'N丙', changePct: 44 },
    { code: '300001', name: '丁', quoteStatus: 'live', preClose: 10, latest: 12, changePct: 20 }
  ], { currentPool: [] });
  assert.deepEqual(Array.from(rows, row => row.isLimitUp), [true, true, false, true]);
});

test('1.6.51: Fuyao review data refreshes every minute only while the market can change', () => {
  const source = fs.readFileSync(path.join(__dirname, 'services.cjs'), 'utf8');
  const start = source.indexOf('function fuyaoDataMayChange('), end = source.indexOf('\nasync function getFuyaoReviewData', start);
  const mayChange = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { require });
  const at = text => Date.parse(`${text}+08:00`);
  assert.equal(mayChange(at('2026-11-04T09:20:00')), true, 'call auction');
  assert.equal(mayChange(at('2026-11-04T14:30:00')), true);
  assert.equal(mayChange(at('2026-11-04T12:10:00')), false, 'lunch break');
  assert.equal(mayChange(at('2026-11-04T17:30:00')), false, 'after close');
  assert.equal(mayChange(at('2026-11-07T10:00:00')), false, 'Saturday');
  assert.equal(mayChange(at('2026-10-05T10:00:00')), false, 'National Day holiday');
});

function fuyaoReviewFixture(start) {
  const state = { now: Date.parse(`${start}+08:00`), calls: 0, fail: false, gate: null };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  const load = async value => { if (state.fail) throw Error('fixture unavailable'); return value; };
  const fake = {
    configured: () => true,
    limitUpPool: async () => {
      const generation = ++state.calls;
      await state.gate?.(generation);
      return load({ rows: [{ code: '600001', name: `版本${generation}`, boards: 1, isSt: false }] });
    },
    limitBreakPool: () => load({ rows: [], total: 0 }), limitDownPool: () => load({ rows: [], total: 0 }),
    limitUpLadder: () => load({ days: [] }), hotStocks: () => load([]), skyrocket: () => load([]),
    dragonTiger: () => load({ date: '2026-11-04', count: 0, stocks: [], desks: [] }), anomalies: () => load({ rows: [] })
  };
  const filename = path.join(__dirname, 'services.cjs'), realRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: id => id === './fuyao-client.cjs' ? { ...realRequire(id), createFuyaoClient: () => fake } : realRequire(id),
    __dirname, __filename: filename, process, console, URL, Date: Clock, DOMException, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout, setImmediate, Buffer
  }, { filename });
  state.fake = fake;
  return { service: module.exports, state, at: text => { state.now = Date.parse(`${text}+08:00`); } };
}

for (const [closed, opening] of [['09:09:00', '09:10:00'], ['12:54:00', '12:55:00']]) {
  test(`Fuyao review replaces a closed-session cache immediately at ${opening}`, async t => {
    const fixture = fuyaoReviewFixture(`2026-11-04T${closed}`), { service, state, at } = fixture;
    t.after(() => service.shutdownServiceResources());
    const before = await service.getFuyaoReviewData();
    assert.equal(before.limitUp.byCode['600001'].name, '版本1');
    at(`2026-11-04T${opening}`);
    const live = await service.getFuyaoReviewData();
    assert.equal(live.limitUp.byCode['600001'].name, '版本2', 'an off-hours expiry must not hide the newly opened live session');
    state.now += 59_999;
    assert.equal((await service.getFuyaoReviewData()).limitUp.byCode['600001'].name, '版本2');
    state.now += 1;
    assert.equal((await service.getFuyaoReviewData()).limitUp.byCode['600001'].name, '版本3', 'the live session still refreshes after one minute');
    assert.equal(state.calls, 3);
  });
}

test('Fuyao review retains the twenty-minute off-hours cache and explicit force refresh', async t => {
  const { service, state } = fuyaoReviewFixture('2026-11-04T17:30:00');
  t.after(() => service.shutdownServiceResources());
  await service.getFuyaoReviewData();
  state.now += 20 * 60_000 - 1;
  assert.equal((await service.getFuyaoReviewData()).limitUp.byCode['600001'].name, '版本1');
  state.now += 1;
  assert.equal((await service.getFuyaoReviewData()).limitUp.byCode['600001'].name, '版本2');
  assert.equal((await service.getFuyaoReviewData({ forceRefresh: true })).limitUp.byCode['600001'].name, '版本3');
});

test('Fuyao opening-session failures retry without reusing closed data and forced failures restore the live cache', async t => {
  const { service, state, at } = fuyaoReviewFixture('2026-11-04T09:09:00');
  t.after(() => service.shutdownServiceResources());
  await service.getFuyaoReviewData();
  at('2026-11-04T09:10:00'); state.fail = true;
  await assert.rejects(service.getFuyaoReviewData(), /全部不可用/);
  state.fail = false;
  assert.equal((await service.getFuyaoReviewData()).limitUp.byCode['600001'].name, '版本3');
  state.fail = true;
  await assert.rejects(service.getFuyaoReviewData({ forceRefresh: true }), /全部不可用/);
  state.fail = false;
  assert.equal((await service.getFuyaoReviewData()).limitUp.byCode['600001'].name, '版本3');
  assert.equal(state.calls, 4, 'a failed forced refresh must preserve the previously fresh live result');
});

test('1.6.52: before 9:25 an empty pool answered with "missing required pagination" is an empty pool, not a warning', async t => {
  const fixture = fuyaoReviewFixture('2026-11-06T09:00:30'), { service, state, at } = fixture;
  t.after(() => service.shutdownServiceResources());
  const fake = state.fake;
  fake.limitDownPool = async () => { throw new Error('同花顺扶摇接口返回 code=5003：hotspot_focus pool response missing required pagination'); };
  const early = await service.getFuyaoReviewData();
  assert.equal((early.warnings || []).length, 0);
  assert.equal(early.limitDown.count, 0);
  at('2026-11-06T09:40:00');
  const live = await service.getFuyaoReviewData();
  assert.match((live.warnings || []).join(' '), /跌停池暂不可用：.*missing required pagination/, 'during the session the same error is reported');
});

test('1.6.52: during the session a part that fails once keeps its last data from the same session and says so', async t => {
  const fixture = fuyaoReviewFixture('2026-11-06T10:00:00'), { service, state } = fixture;
  t.after(() => service.shutdownServiceResources());
  const fake = state.fake;
  let dragonFails = false;
  fake.dragonTiger = async () => { if (dragonFails) throw new Error('timeout'); return { date: '2026-11-05', count: 3, stocks: [{ code: '600009', name: '龙虎', net: 1e8 }], desks: [] }; };
  assert.equal((await service.getFuyaoReviewData()).dragonTiger.count, 3);
  dragonFails = true; state.now += 61_000;
  const next = await service.getFuyaoReviewData();
  assert.equal(next.dragonTiger.count, 3, 'the last good 龙虎榜 is kept');
  assert.match(next.warnings.join(' '), /龙虎榜本次刷新失败，沿用 10:00 的数据（timeout）/);
});

test('Fuyao opening-session requests do not subscribe to an unfinished closed-session snapshot', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, state, at } = fuyaoReviewFixture('2026-11-04T09:09:00');
  state.gate = generation => generation === 1 ? gate : undefined;
  const closed = service.getFuyaoReviewData();
  t.after(async () => { release(); await closed; await service.shutdownServiceResources(); });
  at('2026-11-04T09:10:00');
  const live = service.getFuyaoReviewData();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls, 2, 'opening must admit an independent producer while the old snapshot is still loading');
  assert.equal((await live).limitUp.byCode['600001'].name, '版本2');
  release(); await closed;
  assert.equal((await service.getFuyaoReviewData()).limitUp.byCode['600001'].name, '版本2', 'late closed-session publication must not replace the live cache');
});

test('chart entry preserves the producer drain and invalid securities still reject asynchronously', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'services.cjs'), 'utf8');
  const start = source.search(/(?:async )?function getChart\(/), end = source.indexOf('\n// Internal review-only identities.', start);
  let release;
  const task = Promise.resolve({ rows: [] });
  const drain = new Promise(resolve => { release = resolve; });
  Object.defineProperty(task, 'drained', { value: drain });
  const getChart = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    Promise, toSecurity: input => input, semanticKey: () => 'synthetic',
    chartRuntime: { run: () => task }, chartForSecurity: () => { throw new Error('must not start a real chart'); }
  });
  const result = getChart({ code: '600519', secid: '1.600519' });
  assert.equal(result.drained, drain, 'callers can join the original chart drain');
  let invalid;
  assert.doesNotThrow(() => { invalid = getChart({ code: 'invalid' }); });
  await assert.rejects(invalid, /6位股票代码/);
  release(); await result.drained;
});

for (const stage of ['industry list', 'industry members']) test(`actual industry factory retains ${stage} transport drain after subscriber cancellation`, async t => {
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  const { createStockIndustryIndex } = require('./stock-industry-index.cjs');
  const { createFuyaoClient } = require('./fuyao-client.cjs');
  const source = fs.readFileSync(require.resolve('./services.cjs'), 'utf8');
  const ast = ts.createSourceFile('services.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createStockIndustryIndexWith');
  let release; const physical = new Promise(resolve => { release = resolve; }); let sourceSignal;
  const transport = (_url, options) => {
    sourceSignal = options.signal;
    const result = new Promise((_resolve, reject) => sourceSignal.addEventListener('abort', () => reject(sourceSignal.reason), { once: true }));
    Object.defineProperty(result, 'drained', { value: physical }); return result;
  };
  const ths = { fetchThsFundFlow: stage === 'industry members'
    ? async () => [{ code: '881100', name: '离线行业' }]
    : require('./ths-quote.cjs').fetchThsFundFlow };
  const factory = vm.runInNewContext(`(${declaration.getText(ast)})`, {
    createStockIndustryIndex: options => createStockIndustryIndex({ ...options, minIndustries: 1, minStocks: 1 }),
    thsOfficial: ths, fetchWithPolicy: transport, fetchJsonWithPolicy: transport,
    createFuyaoClient, fuyaoApiKeyProvider: () => 'sk-fuyao-test_only_01234567890123456789',
    fuyao: { configured: () => true, constituents: async (_code, options) => transport('https://example.invalid/members', options) }
  });
  const index = factory(null), controller = new AbortController();
  const task = index.ensure({ signal: controller.signal }); const outcome = task.catch(error => error);
  t.after(async () => { controller.abort(); release(); await Promise.allSettled([outcome, index.shutdown()]); });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(sourceSignal, 'the real adapter starts its requested transport');
  controller.abort(new Error('stop industry lookup')); await outcome;
  let drained = false; task.drained.then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sourceSignal.aborted, true); assert.equal(drained, false, 'async parser/client must not hide raw transport cleanup');
  release(); await task.drained;
});
