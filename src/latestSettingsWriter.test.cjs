const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {registerTypeScript} = require('../qa/register-typescript.cjs');
let restore, createLatestSettingsWriter;
before(() => {restore=registerTypeScript(); ({createLatestSettingsWriter}=require('./latestSettingsWriter.ts'));});
after(() => restore?.());
test('settings patches become active only after successful persistence and merge in order', async () => {
  let state = {theme:'dark',preset:'old'}; const pending=[],saved=[];
  const writer=createLatestSettingsWriter({read:()=>state, normalize:x=>x, persist:x=>new Promise(resolve=>{saved.push(x);pending.push(resolve);}), accept:x=>{state=x;}});
  const a=writer({theme:'light'}); const b=writer({preset:'new'});
  assert.deepEqual(state,{theme:'dark',preset:'old'});
  await Promise.resolve(); assert.equal(saved.length,1);
  pending.shift()(saved[0]);await a;await Promise.resolve();
  assert.deepEqual(state,{theme:'light',preset:'old'});
  assert.deepEqual(saved[1],{theme:'light',preset:'new'});
  pending.shift()(saved[1]);await b;
  assert.deepEqual(state,{theme:'light',preset:'new'});
});
test('a rejected settings patch never leaks into later independent writes', async () => {
  let state={a:1,b:1},calls=0;
  const writer=createLatestSettingsWriter({read:()=>state,normalize:x=>x,persist:async x=>{if(++calls===1)throw Error('disk');return x;},accept:x=>{state=x;}});
  const a=writer({a:2});const b=writer({b:3});await assert.rejects(a,/disk/);await b;
  assert.deepEqual(state,{a:1,b:3});assert.equal(calls,2);
});
