'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTradingCalendar}=require('./trend-trading-calendar.cjs');
const calendar=createTradingCalendar(), dates=calendar.sessionsThrough('2026-10-20',120);
function setup(overrides={}) {
 const calls={universe:0,prepared:[],histories:[],engine:[]};
 const deps={calendar,now:()=>new Date('2026-10-21T02:00:00Z'),
  loadUniverse:async()=>{calls.universe++;return {rows:[{code:'600001',name:'样本',secid:'1.600001',closeSnapshot:{latest:10}},{code:'830001',name:'北交样本',secid:'0.830001',closeSnapshot:{latest:5}},{code:'600002',name:'*ST乙',secid:'1.600002'},{code:'000003',name:'丙',secid:'0.000003',isST:true},{code:'600001',name:'重复',secid:'1.600001'},{code:'510300',name:'ETF',secid:'1.510300'}],
   boards:[{label:'沪市主板',expected:4,loaded:4,complete:true},{label:'北交所',expected:1,loaded:1,complete:true}]};},
  prepareHistories:async securities=>{calls.prepared.push(securities);},
  loadHistory:async (security,count)=>{calls.histories.push({security,count});return dates.map(date=>({date,open:10,high:11,low:9,close:10,volume:100,amount:1000000}));},
  runEngine:async (...args)=>{calls.engine.push(args);return {mode:'selection',asOfDate:args[3].asOfDate,strategies:[{id:'s1',stocks:args[0].map(item=>({code:item.code,signalStrength:Number(item.code.slice(-1))}))}],dataQuality:{requested:args[0].length,processed:args[0].length,invalid:0,stale:0,missing:0,excluded:0,reasons:{}}};},...overrides};
 return {calls,service:require('./strategy-selection-service.cjs').createStrategySelectionService(deps)};
}
test('full-market selection excludes ST and non-A-share codes, keeps Beijing stocks and has no 300 cap',async()=>{
 const {service,calls}=setup();const report=await service.load({historyBars:320,replay:{minCurrentHistoryBars:120}});
 assert.equal(report.asOfDate,'2026-10-20');assert.equal(calls.universe,1);
 assert.deepEqual(calls.engine[0][0].map(item=>item.code),['600001','830001'],'ST, *ST, duplicates and ETFs are excluded; BSE is kept');
 assert.equal(calls.engine[0][0][0].closeSnapshot,undefined,'close snapshots never reach the engine');
 assert.equal(calls.prepared[0][0].closeSnapshot.latest,10,'snapshots are handed to the local daily store first');
 assert.equal(calls.engine[0][3].marketDates.length,120);assert.equal(calls.engine[0][3].asOfDate,'2026-10-20');assert.equal(calls.engine[0][3].historicalReview,false);
 assert.ok(calls.histories.every(call=>call.count===320));assert.equal(report.universeSize,2);assert.equal(report.processed,2);
 assert.equal(report.universeCoverage.complete,true);assert.equal(report.universeCoverage.excludedRisk,2);assert.equal(report.scope,'full_market');
 assert.match(report.notes.join(' '),/剔除ST/);
 const many=Array.from({length:950},(_,i)=>({code:String(600000+i),name:`股${i}`,secid:`1.${600000+i}`}));
 const big=setup({loadUniverse:async()=>({rows:many,boards:[{label:'沪市主板',expected:950,loaded:950,complete:true}]})});
 const bigReport=await big.service.load({});
 assert.equal(bigReport.universeSize,950);assert.equal(bigReport.processed,950);
 assert.deepEqual(big.calls.engine.map(call=>call[0].length),[400,400,150],'computed in bounded chunks');
 assert.equal(bigReport.strategies[0].stocks.length,950,'chunk results are merged');
 assert.equal(bigReport.strategies[0].stocks[0].signalStrength,9,'merged picks are re-ranked across chunks');
});
test('merged chunk reports sum data quality and keep a strategy that only one chunk returned',()=>{
 const {mergeSelectionReports}=require('./strategy-selection-service.cjs');
 const merged=mergeSelectionReports([{strategies:[{id:'a',stocks:[{code:'1',signalStrength:1}]}],dataQuality:{processed:2,stale:1,reasons:{x:1}}},{strategies:[{id:'a',stocks:[{code:'2',signalStrength:5}]},{id:'b',stocks:[]}],dataQuality:{processed:3,stale:0,reasons:{x:2,y:1},benchmarkReady:false}}]);
 assert.deepEqual(merged.strategies.map(item=>item.id),['a','b']);assert.deepEqual(merged.strategies[0].stocks.map(item=>item.code),['2','1']);
 assert.equal(merged.dataQuality.processed,5);assert.equal(merged.dataQuality.stale,1);assert.deepEqual(merged.dataQuality.reasons,{x:3,y:1});assert.equal(merged.dataQuality.benchmarkReady,false);assert.equal(merged.qualifiedCount,2);
});
test('an incomplete board is disclosed and the result is not cached as clean',async()=>{
 const {service}=setup({loadUniverse:async()=>({rows:[{code:'600001',name:'样本',secid:'1.600001'}],boards:[{label:'沪市主板',expected:1,loaded:1,complete:true},{label:'北交所',expected:270,loaded:100,complete:false,error:'名单缺页'}]})});
 const report=await service.load({});
 assert.equal(report.universeCoverage.complete,false);assert.equal(report.universeCoverage.failed,1);assert.match(report.warning,/北交所/);assert.equal(report.cacheValidUntil,null);
 assert.ok(report.selectionDiagnostics.failures.some(item=>item.stage==='universe'));
});
test('an unreadable universe fails the run instead of returning an empty selection',async()=>{
 const failing=setup({loadUniverse:async()=>{throw Error('source offline');}});
 await assert.rejects(()=>failing.service.load({}),/全市场股票名单读取失败/);
 const empty=setup({loadUniverse:async()=>({rows:[],boards:[{label:'沪市主板',expected:null,loaded:0,complete:false}]})});
 await assert.rejects(()=>empty.service.load({}),/名单为空/);
});
test('stale securities and failed reads are counted without pretending full coverage',async()=>{
 const {service}=setup({loadHistory:async security=>{if(security.code==='830001')throw Error('source offline');return dates.map(date=>({date,open:10,high:11,low:9,close:10,volume:100,amount:1000000}));},
  runEngine:async ()=>({mode:'selection',strategies:[],dataQuality:{processed:0,invalid:0,stale:1,missing:0,excluded:0}})});
 const report=await service.load({});assert.equal(report.failed,1);assert.equal(report.processed,0);assert.match(report.warning,/读取失败/);assert.match(report.notes.join(' '),/未参与计算1只/);
});
test('a failed snapshot prefetch only falls back to per-stock history reads',async()=>{
 const {service,calls}=setup({prepareHistories:async()=>{throw Error('fuyao offline');}});
 const report=await service.load({});assert.equal(report.processed,2);assert.equal(calls.histories.filter(call=>call.security.assetType!=='index').length,2);
});
test('crossing the completion cutoff during a fetch refuses publication',async()=>{
 let clock='2026-10-21T07:09:00Z';const {service}=setup({now:()=>new Date(clock),runEngine:async()=>{clock='2026-10-21T07:10:00Z';return {mode:'selection',strategies:[],dataQuality:{processed:1}};}});
 await assert.rejects(()=>service.load({}),/交易日|重新选股/);
});
test('uncovered calendar fails before network and raw history is never filtered or deduplicated by service',async()=>{
 let network=false;const invalid=setup({now:()=>new Date('2028-01-04T02:00:00Z'),loadUniverse:async()=>{network=true;return {};}});await assert.rejects(()=>invalid.service.load({}),/日历/);assert.equal(network,false);
 const raw=[{date:'2026-10-20',low:12,high:11,volume:null},{date:'2026-10-20',low:9,high:11,volume:10}];const {service,calls}=setup({loadHistory:async()=>raw});await service.load({});assert.deepEqual(calls.engine[0][1]['600001'],raw);
});

test('selection cache identity changes when the independently completed session changes',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('./services.cjs'),'utf8');
 const body=source.slice(source.indexOf('function scanStrategySignals('),source.indexOf('\nasync function getLimitUpSectorBoard',source.indexOf('function scanStrategySignals(')));
 let date='2026-10-20',loads=0;
 const scan=vm.runInNewContext(`(${body.trim()})`,{strategySignalOptions:()=>({}),strategySelectionLoader:{context:()=>({asOfDate:date})},strategySignalCache:new Map(),strategySignalLoads:new Map(),Date,loadStrategySignals:async()=>({load:++loads}),serviceRuntime:{run:(_kind,_id,_runtime,fn)=>fn(),checkpoint:()=>{}}});
 assert.equal((await scan()).load,1);date='2026-10-21';assert.equal((await scan()).load,2);
});
test('named first-board analysis cannot qualify by scoring other factors when its core factor fails',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('./services.cjs'),'utf8');
 const start=source.indexOf('  analysis.strategyResults = strategyDefinitions.filter');
 const end=source.indexOf('  analysis.alertQualified =',start);
 const body=source.slice(start,end);
 const ids=['firstBoardQuality','lowFirstBoard','support','sectorLadder','riskVeto'];
 const analysis={historicalEdge:{passed:true},exactNode:true};
 vm.runInNewContext(body,{analysis,strategyDefinitions:ids.map(id=>({id,matched:id!=='lowFirstBoard'})),selectedIds:ids,selectedSet:new Set(ids),settings:{},evaluateAnalysisPresetRequirements:require('./analysis-selection-policy.cjs').evaluateAnalysisPresetRequirements});
 assert.equal(analysis.strategyMatchRate,75);assert.equal(analysis.strategyQualified,false);
});
test('past the bundled calendar, completed sessions are inferred from real index bars before any universe request',async()=>{
 const base=createTradingCalendar();
 // Weekday index bars after the bundled coverage, with 2028-01-01 closed.
 const extra=[];for(let t=Date.parse('2028-01-02T00:00:00Z');t<=Date.parse('2028-01-08T00:00:00Z');t+=864e5){const d=new Date(t).toISOString().slice(0,10),w=new Date(t).getUTCDay();if(w&&w!==6)extra.push(d);}
 const indexDates=[...base.sessionsThrough('2027-12-31',200),...extra];
 const order=[];
 const {service,calls}=setup({now:()=>new Date('2028-01-07T08:00:00Z'),
  loadHistory:async (security,count)=>{order.push(security.assetType==='index'?'index':'stock');calls.histories.push({security,count});return indexDates.map(date=>({date,open:10,high:11,low:9,close:10,volume:100,amount:1000000}));},
  loadUniverse:async()=>{order.push('universe');return {rows:[{code:'600001',name:'样本',secid:'1.600001'}],boards:[{label:'沪市主板',expected:1,loaded:1,complete:true}]};}});
 const report=await service.load({maxUniverse:300,replay:{}});
 assert.equal(order[0],'index','index is read first to infer sessions');
 assert.equal(report.asOfDate,'2028-01-07');assert.equal(report.calendarInferred,true);
 assert.equal(order[1],'universe');assert.ok(!calls.engine[0][3].marketDates.includes('2028-01-01'),'closed day without index bar is not a session');
 assert.equal(calls.engine[0][3].marketDates.at(-1),'2028-01-07');assert.equal(calls.engine[0][3].marketDates.length,120);
 assert.equal(calls.histories.filter(call=>call.security.assetType==='index').length,1,'benchmark is not fetched twice');
 assert.match(report.warning,/推断/);assert.equal(report.cacheValidUntil,null);
});
test('a stale index cannot stand in for an uncovered calendar date',async()=>{
 let pooled=false;const {service}=setup({now:()=>new Date('2028-03-01T08:00:00Z'),loadUniverse:async()=>{pooled=true;return {};}});
 await assert.rejects(()=>service.load({}),/日历.*推断|无法推断/);assert.equal(pooled,false);
});
test('clean completed-session results stay cached until the next session closes and never replay history',async()=>{
 const {service,calls}=setup();const report=await service.load({historicalReview:true});
 assert.equal(report.cacheValidUntil,Date.parse('2026-10-21T15:10:00+08:00'));
 assert.equal(calls.engine[0][3].historicalReview,false,'selection never replays history');
});

// A08: malformed but successfully transported histories must enter the five-minute recovery path.
const realSelectionEngine = (...args) => require('./strategy-signal-engine.cjs').buildStrategySelectionReport(...args);
const completeRows = () => dates.map(date => ({date,open:10,high:10.2,low:9.8,close:10,volume:100000,amount:100000000}));
const oneStockUniverse = extra => ({rows:[{code:'600001',name:'缓存样本',...extra}],boards:[{label:'沪市主板',expected:1,loaded:1,complete:true}]});
for (const [reason, corrupt] of [
 ['missing_activity', rows => {rows[100].amount=null;}],
 ['invalid_ohlc', rows => {rows[100].low=12;}],
 ['duplicate_date', rows => {rows[100].date=rows[99].date;}],
 ['incomplete_sessions', rows => {rows.splice(100,1);}],
 ['missing_history', rows => {rows.length=0;}]
]) test(`recoverable ${reason} does not receive a completed-session cache deadline`,async()=>{
 const {service}=setup({loadUniverse:async()=>oneStockUniverse(),runEngine:realSelectionEngine,
  loadHistory:async security=>{const rows=completeRows();if(security.assetType!=='index')corrupt(rows);return rows;}});
 const report=await service.load({});
 assert.equal(report.dataQuality.reasons[reason],1);
 assert.equal(report.dataQuality.processed,0);
 assert.equal(report.cacheValidUntil,null);
});
test('known young listings are stable exclusions while unproven short histories remain retryable',async()=>{
 for(const [extra,excluded,deadline] of [
  [{listingDate:dates.at(-30),listingDateSource:'fixture-listing'},1,Date.parse('2026-10-21T15:10:00+08:00')],
  [{},0,null], [{listingDate:'2025-01-02'},0,null], [{listingDate:'2026-10-21'},0,null]
 ]){
  const {service}=setup({loadUniverse:async()=>oneStockUniverse(extra),runEngine:realSelectionEngine,
   loadHistory:async security=>security.assetType==='index'?completeRows():completeRows().slice(-30)});
  const report=await service.load({});
  assert.equal(report.dataQuality.excluded,excluded,JSON.stringify(extra));
  assert.equal(report.cacheValidUntil,deadline,JSON.stringify(extra));
  if(excluded){assert.equal(report.dataQuality.invalid,0);assert.equal(report.dataQuality.reasons.insufficient_listing_sessions,1);}
  else assert.equal(report.dataQuality.reasons.incomplete_sessions,1);
 }
});
test('a normal scan after the recovery interval recalculates corrected history',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('./services.cjs'),'utf8');
 const start=source.indexOf('function scanStrategySignals('),end=source.indexOf('\nasync function getLimitUpSectorBoard',start);
 let clock=Date.parse('2026-10-21T02:00:00Z'),loads=0,repaired=false;
 const {service}=setup({now:()=>new Date(clock),loadUniverse:async()=>oneStockUniverse(),runEngine:realSelectionEngine,
  loadHistory:async security=>{const rows=completeRows();if(security.assetType!=='index'&&!repaired)rows[100].amount=null;return rows;}});
 class ClockDate extends Date {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
 const scan=vm.runInNewContext(`(${source.slice(start,end).trim()})`,{strategySignalOptions:()=>({}),strategySelectionLoader:service,
  strategySignalCache:new Map(),strategySignalLoads:new Map(),Date:ClockDate,loadStrategySignals:async()=>{loads++;return service.load({});},
  serviceRuntime:{run:(_kind,_id,_runtime,fn)=>fn(),checkpoint:()=>{}}});
 assert.equal((await scan()).processed,0);repaired=true;
 clock+=4*60*1000;assert.equal((await scan()).processed,0);assert.equal(loads,1);
 clock+=2*60*1000;const recovered=await scan();assert.equal(recovered.processed,1);assert.equal(loads,2);
 assert.equal(recovered.cacheValidUntil,Date.parse('2026-10-21T15:10:00+08:00'));
});
test('batch diagnostics retain source and classified failure counts without leaking provider detail',async()=>{
 const securities=Array.from({length:6},(_,i)=>({code:String(600001+i),name:'诊断样本',closeSnapshot:{latest:10}}));
 const {service}=setup({chunkSize:2,loadUniverse:async()=>({rows:securities,boards:[{label:'沪市主板',expected:6,loaded:6,complete:true}]}),
  loadHistory:async security=>{
   if(security.assetType==='index')return completeRows();
   if(security.code==='600002'||security.code==='600005')throw Error('429 secret-provider-body');
   if(security.code==='600003')return [];
   const rows=completeRows();rows.dataSource=security.code==='600006'?'第二来源':'第一来源';return rows;
  },getDiagnostics:()=>({sources:[{source:'eastmoney',successes:3,failures:2}]})});
 const report=await service.load({});
 // 600003 读取成功但没有日线：算「暂无日线」，不算读取失败；诊断分类仍记为 data。
 assert.equal(report.failed,2);
 assert.match(report.notes.join(' '),/1只暂无日线（新股未上市或刚上市、长期停牌）：600003 诊断样本/);
 assert.match(report.source,/第一来源/);assert.match(report.source,/第二来源/);assert.match(report.source,/公开行情/);
 assert.deepEqual(report.selectionDiagnostics.failures.map(({stage,category,count})=>({stage,category,count})),[
  {stage:'history',category:'rate',count:2},{stage:'history',category:'data',count:1}]);
 assert.deepEqual(report.selectionDiagnostics.sources,[{source:'东方财富',stage:'history',successes:3,failures:2}]);
 assert.doesNotMatch(JSON.stringify(report.selectionDiagnostics),/secret-provider-body/);
});
test('full-market history batches release completed non-watchlist arrays before the scan ends',()=>{
 const {spawnSync}=require('node:child_process');
 const child=spawnSync(process.execPath,['--expose-gc','--require','./qa/test-env.cjs','qa/strategy-selection-memory.cjs'],{cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8',timeout:30000});
 assert.equal(child.status,0,child.stderr||child.stdout);
 const result=JSON.parse(child.stdout);
 assert.equal(result.universeSize,5500);assert.equal(result.watchlistProcessed,2);assert.equal(result.marketBatches,14);
 assert.ok(result.samples.at(-1).liveHistoryArrays<=802,JSON.stringify(result.samples));
});
test('1.6.47: a history read that fails once is retried before the batch is computed',async()=>{
 const attempts=new Map();
 const {service}=setup({loadHistory:async security=>{const n=(attempts.get(security.code)||0)+1;attempts.set(security.code,n);
  if(security.code==='600001'&&n===1)throw Object.assign(new Error('socket hang up'),{code:'ECONNRESET'});
  return dates.map(date=>({date,open:10,high:11,low:9,close:10,volume:100,amount:1000000}));}});
 const report=await service.load({});
 assert.equal(attempts.get('600001'),2);assert.equal(report.failed,0);assert.equal(report.processed,2);
});
test('1.6.47: a board filled from the saved roster is disclosed, and a still-incomplete board says how far it got and why',async()=>{
 const cached=setup({loadUniverse:async()=>({rows:[{code:'600001',name:'样本',secid:'1.600001'}],boards:[{label:'沪市主板',expected:1,loaded:1,complete:true,fromCache:'2026-11-03'}]})});
 const report=await cached.service.load({});
 assert.equal(report.universeCoverage.complete,true);assert.match(report.warning,/沪市主板的股票名单今天没读全.*本机 2026-11-03/);
 const partial=setup({loadUniverse:async()=>({rows:[{code:'600001',name:'样本',secid:'1.600001'}],boards:[{label:'深市主板',expected:1490,loaded:900,complete:false,error:'第 10 页总数从 1490 变为 1488'}]})});
 assert.match((await partial.service.load({})).warning,/深市主板 900\/1490：第 10 页总数从 1490 变为 1488/);
});

test('1.6.52: failed daily-bar reads name the stocks; a few empty reads are new or suspended stocks, many are a source failure',async()=>{
 const {service}=setup({
  // 830001 当天有成交却读不到 → 读取失败；920085 读取成功但为空、000508 当天没有成交快照且读取报错 → 暂无日线。
  loadUniverse:async()=>({rows:[{code:'600001',name:'样本',secid:'1.600001',closeSnapshot:{latest:10}},{code:'830001',name:'北交样本',secid:'0.830001',closeSnapshot:{latest:5}},
   {code:'920085',name:'N森峰',secid:'0.920085'},{code:'000508',name:'琼民源A',secid:'0.000508'}],
   boards:[{label:'沪市主板',expected:2,loaded:2,complete:true},{label:'北交所',expected:2,loaded:2,complete:true}]}),
  loadHistory:async security=>{if(security.code==='830001'||security.code==='000508')throw Error('source offline');if(security.code==='920085')return [];return dates.map(date=>({date,open:10,high:11,low:9,close:10,volume:100,amount:1000000}));}});
 const report=await service.load({});
 assert.equal(report.failed,1);
 assert.match(report.warning,/1只股票日线读取失败（830001 北交样本）/);
 assert.match(report.notes.join(' '),/2只暂无日线（新股未上市或刚上市、长期停牌）：(920085 N森峰、000508 琼民源A|000508 琼民源A、920085 N森峰)/);
 const rows=Array.from({length:25},(_,i)=>({code:String(600100+i),name:`样本${i}`,secid:`1.${600100+i}`}));
 const flood=setup({loadUniverse:async()=>({rows,boards:[{label:'沪市主板',expected:25,loaded:25,complete:true}]}),
  loadHistory:async security=>security.assetType==='index'?dates.map(date=>({date,open:10,high:11,low:9,close:10,volume:100,amount:1000000})):[]});
 const bad=await flood.service.load({});
 assert.equal(bad.failed,25,'many empty reads at once are treated as a source failure');
 assert.match(bad.warning,/25只股票日线读取失败（600100 样本0/);
 assert.equal(bad.cacheValidUntil,null);
});

for (const [label, marketCodes, watchCodes, expected] of [
 ['watchlist-only match', [], ['600002'], 1],
 ['shared market/watchlist match', ['600001'], ['600001'], 1],
 ['empty watchlist matches', ['600001'], [], 1],
 ['separate market/watchlist matches', ['600001'], ['600002'], 2]
]) test(`A08 qualifiedCount uses all final strategy groups: ${label}`, async () => {
 const {service}=setup({runEngine:async (c,h,b,options)=>({mode:'selection',
  qualifiedCount:99,
  strategies:[{id:options.universe==='watchlist'?'cs_watchtest':'market',stocks:(options.universe==='watchlist'?watchCodes:marketCodes).map(code=>({code}))}],
  dataQuality:{requested:c.length,processed:c.length,invalid:0,stale:0,missing:0,excluded:0,benchmarkReady:true}})});
 const report=await service.load({customStrategies:[{id:'cs_watchtest',name:'自选策略',universe:'watchlist'}],watchlistSecurities:[{code:'600001',name:'市场共有'},{code:'600002',name:'自选独有'}]});
 assert.equal(report.qualifiedCount,expected);
 assert.equal(report.watchlistCoverage.processed,2);
 assert.equal(report.strategies.length,2);
});
