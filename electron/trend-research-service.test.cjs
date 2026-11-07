'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=()=>require('./trend-research-request.cjs');
const input=()=>({dataset:{schemaVersion:1,sourceClass:'synthetic',calendar:['2026-10-20'],securities:[]},from:'2026-10-20',to:'2026-10-20',splitDate:'2026-10-20'});
test('desktop research bounds inputs before sending them to a worker',()=>{
 assert.equal(api().validateTrendResearchRequest(input()).from,'2026-10-20');
 assert.throws(()=>api().validateTrendResearchRequest({...input(),dataset:{...input().dataset,comment:'x'.repeat(16*1024*1024)}}),/16/);
 assert.throws(()=>api().validateTrendResearchRequest({...input(),dataset:{...input().dataset,securities:Array(301).fill({})}}),/300/);
 assert.throws(()=>api().validateTrendResearchRequest({...input(),eval:'unsafe'}),/参数/);
});
test('installed research operation yields without blocking main event loop and preserves honest qualification',async()=>{
 const { evaluateTrendResearch,shutdownServiceResources }=require('./services.cjs');
 const calendar=Array.from({length:260},(_,i)=>new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10));
 const rows=calendar.map(date=>({date,open:10,high:10.1,low:9.9,close:10,volume:10000,amount:300000000}));
 const dataset={schemaVersion:1,sourceClass:'synthetic',source:'synthetic IPC contract fixture',universeMode:'selected',calendar,benchmarkRows:rows,securities:[{security:{code:'600001',name:'虚构样本',secid:'1.600001'},rawRows:rows,adjustedRows:rows}]};
 try{
  const pending=evaluateTrendResearch({dataset,from:calendar[250],splitDate:calendar[251],to:calendar[259]});
  let yielded=false;await new Promise(resolve=>setImmediate(()=>{yielded=true;resolve();}));assert.equal(yielded,true);
  const result=await pending;assert.equal(result.qualification.returnSuperiorityVerified,false);assert.equal(result.qualification.status,'SYNTHETIC_MECHANICS_ONLY');assert.ok(result.advanced.sharedAccount);
 }finally{await shutdownServiceResources();}
});
