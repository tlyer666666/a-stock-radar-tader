'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {registerTypeScript}=require('../qa/register-typescript.cjs');
let restore,createCollectionWriter;
before(()=>{restore=registerTypeScript();({createCollectionWriter}=require('./collectionWriter.ts'));});
after(()=>restore?.());
test('queued collection mutations merge against accepted data instead of stale snapshots',async()=>{
 let state=['A','B'];const pending=[],writes=[];
 const write=createCollectionWriter({read:()=>state,persist:items=>new Promise(resolve=>{writes.push(items);pending.push(()=>resolve(items));}),accept:items=>state=items});
 const remove=write(items=>items.filter(x=>x!=='A'));const add=write(items=>[...items,'C']);
 await Promise.resolve();assert.deepEqual(state,['A','B']);pending.shift()();await remove;await Promise.resolve();
 assert.deepEqual(writes,[['B'],['B','C']]);pending.shift()();await add;assert.deepEqual(state,['B','C']);
});
test('failed collection persistence preserves existing state and does not block the next mutation',async()=>{
 let state=['A','B'],attempt=0;
 const write=createCollectionWriter({read:()=>state,persist:async items=>{if(++attempt===1)throw Error('disk');return items;},accept:items=>state=items});
 const failed=write(items=>items.filter(x=>x!=='A'));const later=write(items=>[...items,'C']);
 await assert.rejects(failed,/disk/);await later;assert.deepEqual(state,['A','B','C']);
});
