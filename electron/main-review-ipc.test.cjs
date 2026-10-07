'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const {createHarness}=require('../qa/main-ipc-test-harness.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function reviewFixture(emotion){
 const filename=path.join(__dirname,'review-service.cjs'),realRequire=createRequire(filename),module={exports:{}};
 const services={getReviewIndexChart:async()=>({rows:[]}),marketEmotionSnapshot:emotion,wholeMarketSnapshot:async()=>({}),currentLadderPools:async()=>({}),getLimitUpSectorBoard:async()=>[],discoverLimitUps:async()=>({rows:[]})};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:id=>id==='./services.cjs'?services:realRequire(id),Date,console},{filename});
 return module.exports;
}

test('actual review IPC handler coalesces simultaneous forced refreshes with identical settings',async()=>{
 const gate=deferred();let starts=0;
 const review=reviewFixture(async()=>{starts++;await gate.promise;return{date:'2026-09-30',limitUpCount:7};});
 const h=createHarness(review),jobs=[];
 try{
  jobs.push(h.invoke('review:get-market',{refresh:true}),h.invoke('review:get-market',{refresh:true}));
  assert.equal(starts,1,'the handler must not reset away the service-owned in-flight identity');
  gate.resolve();const results=await Promise.all(jobs);assert.equal(results[0].emotion.limitUpCount,7);assert.equal(results[1].emotion.limitUpCount,7);
 }finally{gate.resolve();await Promise.allSettled(jobs);h.cleanup();}
});

test('actual settings-save IPC still resets professional review cache after successful persistence',async()=>{
 let starts=0,resets=0;
 const review=reviewFixture(async()=>({date:'2026-09-30',limitUpCount:++starts}));
 const h=createHarness({...review,resetProfessionalReviewCache:()=>{resets++;review.resetProfessionalReviewCache();}});
 try{
  assert.equal((await h.invoke('review:get-market',{})).emotion.limitUpCount,1);
  assert.equal((await h.invoke('review:get-market',{})).emotion.limitUpCount,1);
  h.invoke('settings:save',{theme:'dark'});assert.equal(resets,1);
  assert.equal((await h.invoke('review:get-market',{})).emotion.limitUpCount,2);
 }finally{h.cleanup();}
});
