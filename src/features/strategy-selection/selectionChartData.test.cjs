'use strict';
const { test,before,after }=require('node:test');
const assert=require('node:assert/strict');
const {registerTypeScript}=require('../../../qa/register-typescript.cjs');
let restore; before(()=>restore=registerTypeScript()); after(()=>restore?.());
function fixture(){
 const previous={window:global.window,document:global.document}; const requests=[],cancelled=[];
 global.document={hidden:false,addEventListener(){}};
 global.window={stockApi:{getChart(_s,_i,options){let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b});requests.push({options,resolve,reject});return promise;},cancelServiceJob(id){cancelled.push(id);return Promise.resolve(true);}}};
 const file=require.resolve('./selectionChartData.ts');delete require.cache[file]; const api=require(file);
 return {requests,cancelled,...api,restore(){global.window=previous.window;global.document=previous.document;delete require.cache[file];}};
}
const security={code:'600000',secid:'1.600000',name:'测试证券'};
const response=close=>({rows:[{date:'2026-10-23',open:10,high:15,low:8,close,volume:100,volumeUnit:'lots'}],source:'本地回归',adjustment:'前复权',updatedAt:new Date().toISOString()});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('last unsubscribe cancels backend work; one remaining subscriber keeps shared work alive',async()=>{
 const h=fixture();let a,b;
 try{a=h.subscribeSelectionChart(security,()=>{});b=h.subscribeSelectionChart(security,()=>{});assert.equal(h.requests.length,1);a();assert.equal(h.cancelled.length,0);b();await tick();assert.equal(h.cancelled.length,1);h.requests[0].reject(new Error('cancelled'));await tick();}
 finally{a?.();b?.();h.restore();}
});
test('a manual refresh updates a peer that subscribed from fresh cache',async()=>{
 const h=fixture();const seen=[];let a,b,c;
 try{a=h.subscribeSelectionChart(security,()=>{});h.requests[0].resolve(response(11));await tick();a();b=h.subscribeSelectionChart(security,data=>seen.push(data.rows[0].close));c=h.subscribeSelectionChart(security,()=>{},true);h.requests[1].resolve(response(12));await tick();assert.deepEqual(seen,[11,12]);}
 finally{a?.();b?.();c?.();h.restore();}
});
test('an older normal response cannot replace a completed forced refresh',async()=>{
 const h=fixture();let a,b;const seen=[];
 try{a=h.subscribeSelectionChart(security,data=>seen.push(data.rows[0].close));b=h.subscribeSelectionChart(security,()=>{},true);h.requests[1].resolve(response(14));await tick();h.requests[0].resolve(response(11));await tick();assert.equal(seen.at(-1),14);}
 finally{a?.();b?.();h.restore();}
});
test('opening a loading chart does not cancel the request that is immediately resubscribed',async()=>{
 const h=fixture();let a,b;
 try{a=h.subscribeSelectionChart(security,()=>{});a();b=h.subscribeSelectionChart(security,()=>{});await tick();assert.equal(h.cancelled.length,0);assert.equal(h.requests.length,1);h.requests[0].resolve(response(12));await tick();}
 finally{a?.();b?.();h.restore();}
});
test('resubscribe after cancellation starts a new request and an old completion cannot delete it',async()=>{
 const h=fixture();let a,b,c;const seen=[];
 try{a=h.subscribeSelectionChart(security,()=>{});a();await tick();b=h.subscribeSelectionChart(security,data=>{if(data)seen.push(data.rows[0].close)});assert.equal(h.requests.length,2);h.requests[0].reject(new Error('cancelled'));await tick();c=h.subscribeSelectionChart(security,()=>{});assert.equal(h.requests.length,2);h.requests[1].resolve(response(13));await tick();assert.deepEqual(seen,[13]);}
 finally{a?.();b?.();c?.();h.restore();}
});
test('calling an old unsubscribe twice does not detach a newer cache observer',async()=>{
 const h=fixture();let a,b,c;const seen=[];
 try{a=h.subscribeSelectionChart(security,()=>{});h.requests[0].resolve(response(11));await tick();a();b=h.subscribeSelectionChart(security,data=>{if(data)seen.push(data.rows[0].close)});a();c=h.subscribeSelectionChart(security,()=>{},true);h.requests[1].resolve(response(12));await tick();assert.deepEqual(seen,[11,12]);}
 finally{a?.();b?.();c?.();h.restore();}
});
