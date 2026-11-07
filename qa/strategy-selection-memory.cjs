'use strict';
// Offline A11 acceptance: main-process retention during a 5,500 x 320-bar scan.
const assert=require('node:assert/strict');
const {createTradingCalendar}=require('../electron/trend-trading-calendar.cjs');
const {createStrategySelectionService}=require('../electron/strategy-selection-service.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function main(){
 assert.equal(typeof global.gc,'function','run with --expose-gc');
 const calendar=createTradingCalendar(),dates=calendar.sessionsThrough('2026-10-20',320),weak=new Map(),reads=new Map(),samples=[];
 const securities=Array.from({length:5500},(_,i)=>({code:['600','601','603','605','000','001'][Math.floor(i/1000)]+String(i%1000).padStart(3,'0'),name:'离线内存样本'}));
 const watchlist=[securities[0],securities[1000]];let marketBatches=0,watchlistProcessed=0;
 global.gc();const baseline=process.memoryUsage().heapUsed;
 const service=createStrategySelectionService({calendar,now:()=>new Date('2026-10-21T02:00:00Z'),
  loadUniverse:async()=>({rows:securities,boards:[{label:'合成名单',expected:5500,loaded:5500,complete:true}]}),
  loadHistory:async security=>{
   const rows=dates.map((date,index)=>({date,open:10+index/10000,high:11+index/10000,low:9+index/10000,close:10+index/10000,volume:10000+index,amount:10000000+index,volumeUnit:'lots'}));
   rows.dataSource='合成原价';
   if(security.assetType!=='index'){weak.set(security.code,new WeakRef(rows));reads.set(security.code,(reads.get(security.code)||0)+1);}
   return rows;
  },runEngine:async(batch,histories,_benchmark,options)=>{
   if(options.universe==='watchlist'){
    watchlistProcessed=batch.length;
    for(const security of watchlist){assert.equal(histories[security.code],weak.get(security.code).deref(),'watchlist reuses the retained original history');assert.equal(reads.get(security.code),1);}
   }else{
    marketBatches++;await tick();global.gc();
    if(marketBatches===1||marketBatches===14){samples.push({batch:marketBatches,liveHistoryArrays:[...weak.values()].filter(ref=>ref.deref()).length,heapDeltaMiB:Number(((process.memoryUsage().heapUsed-baseline)/2**20).toFixed(2))});}
   }
   return {strategies:[],dataQuality:{requested:batch.length,processed:batch.length,invalid:0,stale:0,missing:0,excluded:0,reasons:{},benchmarkReady:true}};
  }});
 const report=await service.load({customStrategies:[{id:'cs_memory01',universe:'watchlist'}],watchlistSecurities:watchlist});
 assert.equal(report.universeSize,5500);assert.equal(report.watchlistCoverage.processed,2);assert.equal(marketBatches,14);
 assert.ok(samples.at(-1).liveHistoryArrays<=802,`completed history arrays must be collectible before the last batch: ${JSON.stringify(samples)}`);
 assert.equal(report.failed,0);assert.deepEqual(report.selectionDiagnostics.failures,[]);assert.match(report.source,/合成原价/);
 process.stdout.write(JSON.stringify({universeSize:report.universeSize,marketBatches,watchlistProcessed,samples})+'\n');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
