'use strict';
const {createTradingCalendar,validDate}=require('./trend-trading-calendar.cjs');
const {isBseAshareCode}=require('./price-limit-rules.cjs');
// C2-03：与策略信号、趋势扫描共用同一个 ST/退市名称判定。
const {isRiskSecurityName}=require('./strategy-intelligence.cjs');
const {classifySelectionFailure,buildSelectionDiagnostics}=require('./selection-diagnostics.cjs');
const SELECTION_HISTORY_BARS=320;
const MARKET_SESSIONS=120;
// 全市场选股按批计算：每批的日线读完就交给计算线程，算完即释放，内存与单批耗时都有上限。
const SELECTION_CHUNK_SIZE=400;
const HISTORY_CONCURRENCY=6;
const BENCHMARK={code:'000985',secid:'1.000985',assetType:'index'};
const codeEligible=code=>/^(?:000|001|002|003|600|601|603|605|30[012]|68[89])\d{3}$/.test(code)||isBseAshareCode(code);
async function mapBounded(items,worker,assertActive,concurrency=HISTORY_CONCURRENCY) {
 const results=new Array(items.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
  while(cursor<items.length){assertActive();const index=cursor++;try{results[index]={ok:true,value:await worker(items[index],index)};}catch(error){assertActive();results[index]={ok:false,error:error instanceof Error?error.message:String(error),failure:classifySelectionFailure(error)};}}
 }));
 return results;
}
/** 各批选股报告合并：同一策略的入选股票拼在一起重新排序，数据质量计数相加。 */
function mergeSelectionReports(reports) {
 const [first]=reports;if(!first)return null;
 const strategies=(Array.isArray(first.strategies)?first.strategies:[]).map(group=>({...group,stocks:[...(Array.isArray(group.stocks)?group.stocks:[])]}));
 const byId=new Map(strategies.map(group=>[group.id,group]));
 const quality={...(first.dataQuality||{}),reasons:{...(first.dataQuality?.reasons||{})}};
 for(const report of reports.slice(1)){
  for(const group of Array.isArray(report?.strategies)?report.strategies:[]){
   const target=byId.get(group.id);
   if(target)target.stocks.push(...(Array.isArray(group.stocks)?group.stocks:[]));
   else{const copy={...group,stocks:[...(Array.isArray(group.stocks)?group.stocks:[])]};strategies.push(copy);byId.set(copy.id,copy);}
  }
  const next=report?.dataQuality||{};
  for(const key of ['requested','processed','invalid','stale','missing','excluded'])quality[key]=(Number(quality[key])||0)+(Number(next[key])||0);
  for(const [reason,count] of Object.entries(next.reasons||{}))quality.reasons[reason]=(quality.reasons[reason]||0)+(Number(count)||0);
  if(next.benchmarkReady===false)quality.benchmarkReady=false;
 }
 for(const group of strategies)group.stocks.sort((left,right)=>(right.matchRate??0)-(left.matchRate??0)||(Number(right.signalStrength)||0)-(Number(left.signalStrength)||0)||String(left.code).localeCompare(String(right.code)));
 return {...first,dataQuality:quality,strategies,qualifiedCount:new Set(strategies.flatMap(group=>group.stocks.map(stock=>stock.code))).size};
}
function createStrategySelectionService({calendar=createTradingCalendar(),now=()=>new Date(),loadUniverse,prepareHistories=null,loadHistory,runEngine,getDiagnostics=()=>({}),assertActive=()=>{},chunkSize=SELECTION_CHUNK_SIZE}={}) {
 function contextFor(activeCalendar){
  const expected=activeCalendar.expectedCloseDate(now());
  const marketDates=expected.date&&activeCalendar.sessionsThrough(expected.date,MARKET_SESSIONS);
  if(expected.state!=='known'||!marketDates)throw Error(expected.reason||'交易日历未覆盖选股所需日期，请更新日历');
  const next=activeCalendar.nextSession(expected.date);
  return {asOfDate:expected.date,marketDates,calendarVersion:expected.calendarVersion||activeCalendar.version,
   inferred:expected.inferred===true,
   // Completed-session data is immutable: a result stays valid until the next session's 15:10 cutoff.
   cacheValidUntil:next&&expected.inferred!==true?Date.parse(`${next}T15:10:00+08:00`):null,
   calendarNotice:typeof activeCalendar.coverageNotice==='function'?activeCalendar.coverageNotice(now()):''};
 }
 const context=()=>contextFor(calendar);
 /** Outside the bundled calendar, infer completed sessions from real CSI All Share bars before any universe request. */
 async function resolveContext(options){
  try{return {ctx:context(),benchmark:null};}
  catch(error){
   if(typeof calendar.withObservedSessions!=='function')throw error;
   assertActive();
   let rows;
   try{rows=await loadHistory(BENCHMARK,SELECTION_HISTORY_BARS,options);}
   catch(cause){throw Error(`${error.message}；指数行情读取失败，无法推断交易日：${cause instanceof Error?cause.message:String(cause)}`,{cause});}
   const dates=(Array.isArray(rows)?rows:[]).map(row=>String(row?.date??'')).filter(validDate);
   let ctx;
   try{ctx=contextFor(calendar.withObservedSessions(dates));}
   catch{throw Error(`${error.message}；指数交易日不足或过旧，无法推断已完成交易日`);}
   return {ctx,benchmark:rows};
  }
 }
 /** 全市场名单：剔除 ST/退市与非A股代码，北交所保留。名单读取失败的板块记入覆盖说明。 */
 async function universeFor(options,runtime){
  let listing;
  try{listing=await loadUniverse({...options,forceRefresh:runtime.forceRefresh===true});}
  catch(error){assertActive();throw Error(`全市场股票名单读取失败，无法选股：${error instanceof Error?error.message:String(error)}`,{cause:error});}
  assertActive();
  const rows=Array.isArray(listing?.rows)?listing.rows:[];
  const boards=(Array.isArray(listing?.boards)?listing.boards:[]).map(board=>({label:String(board?.label||''),expected:Number.isInteger(board?.expected)?board.expected:null,
   loaded:Math.max(0,Math.trunc(Number(board?.loaded)||0)),complete:board?.complete===true,...(board?.error?{error:String(board.error).slice(0,200)}:{}),...(typeof board?.fromCache==='string'?{fromCache:board.fromCache}:{})}));
  const unique=new Map(),snapshots=[];let excludedRisk=0;
  for(const item of rows){
   const code=String(item?.code||'');
   if(!codeEligible(code)||unique.has(code))continue;
   if(isRiskSecurityName(item?.name)||item?.isST===true||item?.st===true){excludedRisk++;continue;}
   const {closeSnapshot,...security}=item;
   // 名单里没有当日成交快照：未上市、刚挂牌未交易或长期停牌，日线读不到不算数据源故障。
   unique.set(code,closeSnapshot?{...security,code}:{...security,code,noTradeSnapshot:true});
   snapshots.push(closeSnapshot?{...security,code,closeSnapshot}:{...security,code});
  }
  return {candidates:[...unique.values()],snapshots,boards,listed:rows.length,excludedRisk};
 }
 async function load(options={},runtime={}) {
  assertActive();
  const {ctx,benchmark:prefetchedBenchmark}=await resolveContext(options);
  const universe=await universeFor(options,runtime);
  const {candidates,boards}=universe;
  const boardsFailed=boards.filter(board=>!board.complete).length;
  if(!candidates.length)throw Error(`全市场股票名单为空${boardsFailed?`（${boardsFailed}个板块读取失败）`:''}，无法选股`);
  // 本地日线库：先批量取当天收盘快照，已有日线的股票只补一根，不再逐只完整下载。
  if(typeof prepareHistories==='function'){
   try{await prepareHistories(universe.snapshots);}catch{/* 预取失败只会退回逐只下载 */}
   assertActive();
  }
  const bars=SELECTION_HISTORY_BARS;
  // 指数与第一批个股日线同时读取。
  const benchmarkRead=prefetchedBenchmark?Promise.resolve({ok:true,value:prefetchedBenchmark})
   :mapBounded([BENCHMARK],security=>loadHistory(security,bars,options),assertActive).then(results=>results[0]);
  benchmarkRead.catch(()=>{});
  const customStrategies=Array.isArray(options.customStrategies)?options.customStrategies:[];
  const engineOptions={selectionOnly:true,minCurrentHistoryBars:MARKET_SESSIONS,strategyIds:options.strategyIds,asOfDate:ctx.asOfDate,marketDates:ctx.marketDates,
   universe:'limit_pool',customStrategies,historicalReview:false};
  // 分批：读一批日线、算一批，下一批的日线读取与本批计算并行。
  const size=Math.max(1,Math.trunc(Number(chunkSize)||SELECTION_CHUNK_SIZE));
  const chunks=[];for(let offset=0;offset<candidates.length;offset+=size)chunks.push(candidates.slice(offset,offset+size));
  // User strategies scoped to 我的自选与持仓 run as a second pass over those codes only.
  const watchStrategies=customStrategies.filter(item=>item&&item.universe==='watchlist');
  const watchSeen=new Set();
  const watchSecurities=watchStrategies.length?(Array.isArray(options.watchlistSecurities)?options.watchlistSecurities:[]).map(item=>({...item,code:String(item?.code||'')}))
   .filter(item=>codeEligible(item.code)&&!isRiskSecurityName(item.name)&&!watchSeen.has(item.code)&&watchSeen.add(item.code)).slice(0,300):[];
  const historyFailures=new Map(),historySources=new Set(),reports=[],retained={};let failed=0;const failedNames=[],noBars=[];
  const readChunk=chunk=>{const read=mapBounded(chunk,security=>loadHistory(security,bars,options),assertActive);read.catch(()=>{});return read;};
  let pending=chunks.length?readChunk(chunks[0]):null;
  const benchmarkResult=await benchmarkRead;
  const benchmark=benchmarkResult?.ok&&Array.isArray(benchmarkResult.value)?benchmarkResult.value:[];
  assertActive();
  for(let index=0;index<chunks.length;index++){
   const results=await pending;assertActive();
   pending=index+1<chunks.length?readChunk(chunks[index+1]):null;
   // 1.6.47：个别股票日线因网络抖动读取失败时，本批计算前再读一次。
   const retryIndexes=results.map((result,offset)=>result?.ok&&Array.isArray(result.value)&&result.value.length?-1:offset).filter(offset=>offset>=0);
   if(retryIndexes.length&&retryIndexes.length<=Math.max(20,Math.ceil(chunks[index].length/5))){
    const again=await mapBounded(retryIndexes.map(offset=>chunks[index][offset]),security=>loadHistory(security,bars,options),assertActive).catch(()=>[]);
    assertActive();
    again.forEach((result,position)=>{if(result?.ok&&Array.isArray(result.value)&&result.value.length)results[retryIndexes[position]]=result;});
   }
   const historiesByCode={};
   results.forEach((result,offset)=>{
    if(result?.ok)historySources.add(String(result.value?.dataSource||'公开行情'));
    const security=chunks[index][offset];
    if(result?.ok&&Array.isArray(result.value)&&result.value.length){historiesByCode[security.code]=result.value;}
    // 读取成功但没有日线：新股未上市/刚上市（N、C 开头）或长期停牌，先记下，循环结束后再决定算不算失败。
    else if(result?.ok||security.noTradeSnapshot===true)noBars.push(`${security.code}${security.name?` ${security.name}`:''}`);
    else{failed++;if(failedNames.length<6)failedNames.push(`${security.code}${security.name?` ${security.name}`:''}`);}
   });
   // Aggregate diagnostics while this batch is live; never retain successful raw daily bars here.
   for(const failure of buildSelectionDiagnostics({histories:results}).failures){
    const key=failure.category,previous=historyFailures.get(key);
    historyFailures.set(key,{...failure,count:(previous?.count||0)+failure.count});
   }
   reports.push(await runEngine(chunks[index],historiesByCode,benchmark,engineOptions));
   assertActive();
   // 只为自选/持仓第二轮保留它们自己的日线，不保留全市场日线。
   for(const code of watchSeen)if(historiesByCode[code])retained[code]=historiesByCode[code];
  }
  if(pending)await pending.catch(()=>null);
  // 少量「读取成功但没有日线」是新股或长期停牌（2026-11-06 实测：N森峰、钧锐锶、菊乐股份、琼民源A）；
  // 一次出现很多则更像数据源出错，仍按读取失败处理，结果也不当作干净结果缓存。
  const noBarsAreFailures=noBars.length>20;
  if(noBarsAreFailures){failed+=noBars.length;for(const name of noBars)if(failedNames.length<6)failedNames.push(name);}
  const report=mergeSelectionReports(reports)||{mode:'selection',strategies:[],dataQuality:{}};
  let watchlistCoverage=null;let watchHistoryResults=[];
  if(watchStrategies.length){
   const securities=watchSecurities;
   const missing=securities.filter(item=>!retained[item.code]);
   const loaded=await mapBounded(missing,security=>loadHistory(security,bars,options),assertActive);
   watchHistoryResults=loaded;
   const watchHistories={};let watchFailed=0;
   for(const item of securities)if(retained[item.code])watchHistories[item.code]=retained[item.code];
   loaded.forEach((result,index)=>{if(result?.ok&&Array.isArray(result.value)&&result.value.length)watchHistories[missing[index].code]=result.value;else watchFailed++;});
   assertActive();
   const watchReport=securities.length?await runEngine(securities,watchHistories,benchmark,{...engineOptions,strategyIds:undefined,
    includeBuiltIn:false,universe:'watchlist',customStrategies:watchStrategies}):{strategies:watchStrategies.map(item=>({id:item.id,name:item.name,type:'custom',custom:true,family:'custom',universeId:'watchlist',conditions:[],stocks:[]})),dataQuality:{}};
   assertActive();
   report.strategies=[...(Array.isArray(report.strategies)?report.strategies:[]),...(Array.isArray(watchReport.strategies)?watchReport.strategies:[])];
   watchlistCoverage={requested:securities.length,processed:Number(watchReport.dataQuality?.processed)||0,failed:watchFailed,
    invalid:Number(watchReport.dataQuality?.invalid)||0,stale:Number(watchReport.dataQuality?.stale)||0,missing:Number(watchReport.dataQuality?.missing)||0,
    ...(typeof watchReport.dataQuality?.benchmarkReady==='boolean'?{benchmarkReady:watchReport.dataQuality.benchmarkReady}:{}),
    note:securities.length?'':'自选、观察池与持仓中没有可选股票'};
  }
  report.qualifiedCount=new Set(report.strategies.flatMap(group=>(Array.isArray(group.stocks)?group.stocks:[]).map(stock=>stock.code))).size;
  if(!ctx.inferred){
   let current=null;try{current=context().asOfDate;}catch{current=null;}
   if(current!==ctx.asOfDate)throw Error('交易日已切换，请重新选股以使用完整收盘数据');
  }
  const quality=report.dataQuality||{};
  const warnings=[],notes=[];
  if(ctx.inferred)warnings.push(`内置交易日历已到期，本轮按中证全指实际交易日推断${ctx.asOfDate}为完整交易日；请更新交易日历。`);
  const cachedBoards=boards.filter(board=>board.complete&&board.fromCache);
  if(cachedBoards.length)warnings.push(`${cachedBoards.map(board=>board.label).join('、')}的股票名单今天没读全（数据源限流），已改用本机 ${cachedBoards[0].fromCache} 保存的完整名单；行情和日线仍是最新的。`);
  if(boardsFailed)warnings.push(`${boardsFailed}个板块的股票名单读取不完整（${boards.filter(board=>!board.complete).map(board=>`${board.label} ${board.loaded}/${board.expected??'?'}${board.error?`：${board.error.slice(0,60)}`:''}`).join('；')}），候选覆盖不完整。`);
  if(failed)warnings.push(`${failed}只股票日线读取失败（${failedNames.join('、')}${failed>failedNames.length?' 等':''}），本轮未参与计算。`);
  if(noBars.length&&!noBarsAreFailures)notes.push(`${noBars.length}只暂无日线（新股未上市或刚上市、长期停牌）：${noBars.slice(0,6).join('、')}${noBars.length>6?' 等':''}，本轮不参与计算。`);
  if(watchlistCoverage?.failed)warnings.push(`自选与持仓股票池另有${watchlistCoverage.failed}只行情读取失败。`);
  if(!benchmarkResult?.ok||quality.benchmarkReady===false)warnings.push('指数日期或必要数据暂缺，依赖指数的策略本轮不选股。');
  const skipped=(Number(quality.invalid)||0)+(Number(quality.stale)||0)+(Number(quality.missing)||0);
  if(skipped)notes.push(`未参与计算${skipped}只：上市不足${MARKET_SESSIONS}个交易日、近期停牌或日线不完整（异常${quality.invalid||0}只、陈旧${quality.stale||0}只、缺失${quality.missing||0}只）。`);
  if(quality.reasons?.insufficient_listing_sessions)notes.push(`按明确上市日期剔除上市不足${MARKET_SESSIONS}个交易日的股票${quality.reasons.insufficient_listing_sessions}只。`);
  if(universe.excludedRisk)notes.push(`已剔除ST、*ST与退市整理股票${universe.excludedRisk}只。`);
  if(ctx.calendarNotice&&!ctx.inferred)notes.push(ctx.calendarNotice);
  const sources=[...historySources];
  const degraded=Boolean(boardsFailed||failed||quality.invalid||quality.missing||quality.stale||!benchmarkResult?.ok||quality.benchmarkReady===false||watchlistCoverage?.failed||watchlistCoverage?.invalid||watchlistCoverage?.stale||watchlistCoverage?.missing);
  let sourceDiagnostics={};
  try{sourceDiagnostics=getDiagnostics()||{};}catch{/* Diagnostics cannot invalidate a completed selection. */}
  const selectionDiagnostics=buildSelectionDiagnostics({universe:boards.filter(board=>!board.complete).map(board=>({ok:false,error:board.error||'名单缺页'})),benchmark:benchmarkResult,watchHistories:watchHistoryResults,sources:sourceDiagnostics.sources});
  // Keep the published stage order and sanitized failure/source schema unchanged.
  selectionDiagnostics.failures=[...selectionDiagnostics.failures.filter(item=>item.stage==='universe'),...historyFailures.values(),...selectionDiagnostics.failures.filter(item=>item.stage!=='universe')].slice(0,32);
  return {...report,asOfDate:ctx.asOfDate,calendarVersion:ctx.calendarVersion,calendarInferred:ctx.inferred,
   scope:'full_market',source:`全市场A股名单（剔除ST，含北交所） + 不复权日线（${sources.join('、')||'公开行情'}）`,
   universeSize:candidates.length,availableUniverseSize:candidates.length,processed:Number(quality.processed)||0,failed,
   historyBarsRequested:bars,
   universeCoverage:{boards,listed:universe.listed,eligible:candidates.length,excludedRisk:universe.excludedRisk,failed:boardsFailed,requestsComplete:boardsFailed===0,complete:boardsFailed===0},
   cacheValidUntil:degraded?null:ctx.cacheValidUntil,watchlistCoverage,selectionDiagnostics,
   warning:[report.warning,...warnings].filter(Boolean).join(' '),notes};
 }
 return {context,load};
}
module.exports={createStrategySelectionService,mergeSelectionReports,SELECTION_HISTORY_BARS,MARKET_SESSIONS};
