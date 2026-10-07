'use strict';
const assert=require('node:assert/strict');const {test,before,after}=require('node:test');
const {registerTypeScript}=require('../qa/register-typescript.cjs');
let restore,group;
before(()=>{restore=registerTypeScript();group=require('./consecutiveBoardGroups.ts').buildConsecutiveBoardGroups;});after(()=>restore?.());
const row=(code,height,extra={})=>({code,name:'合成股票'+code,consecutiveBoards:height,limitDate:'2026-09-30',...extra});
test('ladder keeps heights descending and groups securities on the same trading date',()=>{
 const result=group([row('a',2),row('b',5),row('c',2),row('old',8,{limitDate:'2026-09-29'}),row('first',1)]);
 assert.equal(result.asOf,'2026-09-30');assert.deepEqual(result.groups.map(g=>[g.height,g.stocks.map(s=>s.code)]),[[5,['b']],[2,['a','c']]]);assert.equal(result.total,3);
});
test('within-level sorts never interleave heights and missing values sort last in either direction',()=>{
 const rows=[row('high',5,{turnover:1}),row('missing',2,{turnover:null}),row('zero',2,{turnover:0}),row('ten',2,{turnover:10})];
 assert.deepEqual(group(rows,{key:'turnover',direction:'desc'}).groups.map(g=>g.stocks.map(s=>s.code)),[['high'],['ten','zero','missing']]);
 assert.deepEqual(group(rows,{key:'turnover',direction:'asc'}).groups.map(g=>g.stocks.map(s=>s.code)),[['high'],['zero','ten','missing']]);
});
test('invalid heights, ST names, undated mixing and conflicting duplicates cannot inflate the ladder',()=>{
 const rows=[row('a',3),row('a',3),row('conflict',2),row('conflict',4),row('st',3,{name:'*ST合成'}),row('bad',2.5),row('missingDate',4,{limitDate:undefined}),row('infinite',Infinity)];
 const result=group(rows);assert.equal(result.total,1);assert.deepEqual(result.groups[0].stocks.map(x=>x.code),['a']);assert.equal(result.conflicts,1);
});
test('an all-undated legacy pool is explicitly dated unknown and preserves valid zero metrics',()=>{
 const result=group([row('a',2,{limitDate:undefined,openBoardCount:0,turnover:0})]);
 assert.equal(result.asOf,null);assert.equal(result.total,1);assert.equal(result.groups[0].stocks[0].openBoardCount,0);
});
test('the latest pool day applies even when its only stock is first-board',()=>{
 const result=group([row('old',4,{limitDate:'2026-09-29'}),row('today',1)]);assert.equal(result.asOf,'2026-09-30');assert.equal(result.total,0);
});
test('conflicting first-board and second-board records cannot manufacture a consecutive-board candidate',()=>{
 const result=group([row('a',1),row('a',2),row('b',3)]);
 assert.equal(result.total,1);assert.equal(result.conflicts,1);assert.deepEqual(result.groups.map(g=>g.height),[3]);
});
