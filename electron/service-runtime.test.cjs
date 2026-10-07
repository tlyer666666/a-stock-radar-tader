'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createServiceRuntime}=require('./service-runtime.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const tick=()=>new Promise(r=>setImmediate(r));
test('shared cache isolates subscriber cancellation and retains physical parent ownership',async t=>{
 const r=createServiceRuntime(),cache=new Map(),gate=deferred();t.after(()=>r.shutdown());let signal,calls=0;
 const load=()=>r.cached(cache,'same',1000,async()=>{calls++;signal=r.signal();await gate.promise;return 42;});
 const a=r.run('single','a',{owner:1,requestId:'a'},load);const b=r.run('single','b',{owner:1,requestId:'b'},load);await tick();
 r.cancel({owner:1,requestId:'a'});await assert.rejects(a,{code:'JOB_CANCELLED'});assert.equal(signal.aborted,false);assert.equal(r.getDiagnostics().jobs.active,2);
 gate.resolve();assert.equal(await b,42);await a.drained;assert.equal(calls,1);assert.equal(r.getDiagnostics().jobs.active,0);
});
test('last subscriber aborts physical loader and prevents cache publication',async t=>{
 const r=createServiceRuntime(),cache=new Map(),gate=deferred();t.after(()=>r.shutdown());let signal;
 const p=r.run('single','a',{owner:1,requestId:'a'},()=>r.cached(cache,'a',1000,async()=>{signal=r.signal();await gate.promise;return 42;}));await tick();
 r.cancel({owner:1,requestId:'a'});await assert.rejects(p);assert.equal(signal.aborted,true);assert.equal(r.getDiagnostics().jobs.active,1);
 gate.resolve();await p.drained;assert.equal(cache.has('a'),false);assert.equal(r.getDiagnostics().jobs.active,0);
});
test('force refresh and invalidation prevent older writes while old consumers still receive values',async t=>{
 const r=createServiceRuntime(),cache=new Map(),a=deferred(),b=deferred();t.after(()=>r.shutdown());
 const one=r.cached(cache,'k',10000,()=>a.promise);const two=r.cached(cache,'k',10000,()=>b.promise,{forceRefresh:true});
 b.resolve('new');assert.equal(await two,'new');a.resolve('old');assert.equal(await one,'old');assert.equal(cache.get('k').value,'new');
 cache.delete('k');const three=r.cached(cache,'k',1000,()=>Promise.resolve('third'));assert.equal(await three,'third');
});
test('Map.delete severs pending generation, dynamic TTL honored, null cached and shutdown denies work',async()=>{
 const r=createServiceRuntime(),cache=new Map(),a=deferred();
 const old=r.cached(cache,'k',1000,()=>a.promise);cache.delete('k');
 assert.equal(await r.cached(cache,'k',()=>1000,()=>null),null);a.resolve('old');await old;assert.equal(cache.get('k').value,null);
 assert.equal(await r.cached(cache,'k',1000,()=>{throw Error('must hit null cache');}),null);
 await r.shutdown();await assert.rejects(r.cached(cache,'x',1000,()=>1));assert.equal(r.getDiagnostics().cache.active,0);
});
test('cache total deadline aborts nested IO and drains independent producer scope',async t=>{
 const r=createServiceRuntime({cacheJobOptions:{operationTimeouts:{cache:35}}}),cache=new Map();t.after(()=>r.shutdown());
 let aborted=false;const p=r.cached(cache,'deadline',1000,()=>r.track(()=>new Promise(resolve=>{r.signal().addEventListener('abort',()=>{aborted=true;resolve();},{once:true});})));
 await assert.rejects(p,{code:'JOB_TIMEOUT'});await p.drained;assert.equal(aborted,true);assert.equal(cache.has('deadline'),false);
});
test('new subscriber after last cancellation owns a fresh cache generation before old physical drain',async()=>{
 const r=createServiceRuntime(),cache=new Map(),old=deferred(),fresh=deferred();let oldCalls=0,newCalls=0;
 const a=r.run('single','a',{owner:1,requestId:'a'},()=>r.cached(cache,'key',1000,()=>{oldCalls++;return old.promise;}));
 const rejected=assert.rejects(a,{code:'JOB_CANCELLED'});r.cancel({owner:1,requestId:'a'});await rejected;
 const b=r.run('single','b',{owner:2,requestId:'b'},()=>r.cached(cache,'key',1000,()=>{newCalls++;return fresh.promise;}));
 try {
  assert.equal(oldCalls,1,'cancelled loader must not be invoked again under its old cache identity');assert.equal(newCalls,1);
  old.resolve('stale');await a.drained;assert.equal(cache.has('key'),true,'old finally must not remove newer pending record');
  fresh.resolve('fresh');assert.equal(await b,'fresh');await b.drained;assert.equal(cache.get('key').value,'fresh');
 } finally {old.resolve('stale');fresh.resolve('fresh');await Promise.allSettled([a,b]);await r.shutdown();}
});
test('queued cache cancellation invalidates its record synchronously before a replacement subscriber arrives',async()=>{
 const r=createServiceRuntime({cacheJobOptions:{maxActive:1,maxQueued:1}}),cache=new Map(),block=deferred();let oldCalls=0,newCalls=0;
 const held=r.cached(cache,'held',1000,()=>block.promise);
 const a=r.run('single','a',{owner:1,requestId:'a'},()=>r.cached(cache,'queued',1000,()=>{oldCalls++;return 'old';}));
 const rejected=assert.rejects(a,{code:'JOB_CANCELLED'});r.cancel({owner:1,requestId:'a'});
 const b=r.run('single','b',{owner:2,requestId:'b'},()=>r.cached(cache,'queued',1000,()=>{newCalls++;return 'fresh';}));
 try {block.resolve();await held;await rejected;assert.equal(await b,'fresh');await b.drained;assert.equal(oldCalls,0);assert.equal(newCalls,1);assert.equal(cache.get('queued').value,'fresh');}
 finally {block.resolve();await Promise.allSettled([a,b,held]);await r.shutdown();}
});
test('parent deadline during synchronous cache creation leaves no unobserved subscriber rejection',async()=>{
 const r=createServiceRuntime({jobOptions:{operationTimeouts:{single:5}}}),cache=new Map();
 const job=r.run('single','late',{owner:1,requestId:'late'},()=>r.cached(cache,'late',1000,()=>{
  const end=performance.now()+15;while(performance.now()<end){}return 42;
 }));
 try {await assert.rejects(job,{code:'JOB_TIMEOUT'});await job.drained;await tick();assert.equal(r.getDiagnostics().jobs.active,0);assert.equal(r.getDiagnostics().cache.active,0);}
 finally {await r.shutdown();}
});

test('single-object cache retains legacy settled fields but bypasses oversized values',async t=>{
 const r=createServiceRuntime(),object={value:null,expiresAt:0,promise:null};t.after(()=>r.shutdown());
 assert.equal(await r.cachedObject(object,10000,()=> 'ok',{maxBytes:300}),'ok');assert.equal(object.promise,null);assert.equal(object.value,'ok');
 const huge='x'.repeat(1000);assert.equal(await r.cachedObject(object,10000,()=>huge,{forceRefresh:true}),huge);assert.equal(object.value,null);assert.equal(object.promise,null);
});
test('nested cache admission rejects overload instead of queuing a child behind its own parent',async t=>{
 const r=createServiceRuntime({cacheJobOptions:{maxActive:1}}),cache=new Map();t.after(()=>r.shutdown());
 await assert.rejects(r.cached(cache,'parent',1000,()=>r.cached(cache,'child',1000,()=>1)),{code:'SERVICE_BUSY'});
 assert.equal(r.getDiagnostics().cache.pending,0);assert.equal(cache.size,0);
});
