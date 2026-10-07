'use strict';
const {test,before,after}=require('node:test');const assert=require('node:assert/strict');
const {registerTypeScript}=require('../qa/register-typescript.cjs');let restore,createServiceJobScope;
before(()=>{restore=registerTypeScript();({createServiceJobScope}=require('./serviceJobClient.ts'));});after(()=>restore?.());
test('cancellation targets only outstanding IDs and cleanup does not remove newer requests',async()=>{
 const cancelled=[],resolvers=[],ids=[];const scope=createServiceJobScope(id=>{cancelled.push(id);return Promise.resolve(true);});
 const a=scope.run(id=>{ids.push(id);return new Promise(r=>resolvers.push(r));});scope.cancelAll();
 const b=scope.run(id=>{ids.push(id);return new Promise(r=>resolvers.push(r));});resolvers[0](1);await a;
 assert.notEqual(ids[0],ids[1]);scope.cancelAll();assert.deepEqual(cancelled,ids);resolvers[1](2);assert.equal(await b,2);scope.cancelAll();assert.equal(cancelled.length,2);
});
test('resolved or rejected requests are not cancelled and a rejected cancel is observed',async()=>{
 const cancelled=[];const scope=createServiceJobScope(id=>{cancelled.push(id);return Promise.reject(Error('window gone'));});
 await scope.run(async()=>3);await assert.rejects(scope.run(async()=>{throw Error('failed');}));scope.cancelAll();assert.equal(cancelled.length,0);
 let finish;const p=scope.run(()=>new Promise(r=>finish=r));await scope.cancelAll();finish(1);await p;
});
