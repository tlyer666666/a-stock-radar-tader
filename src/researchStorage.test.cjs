'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');const {registerTypeScript}=require('../qa/register-typescript.cjs');let restore,s;
before(()=>{restore=registerTypeScript();s=require('./researchStorage.ts');});after(()=>restore?.());
test('research collections recover all-corrupt documents without rejecting mixed or intentional empty documents',()=>{
 const log={source:'BACKTEST_CURRENT',result:'BLOCKED'},history={securityCode:'600001'};
 for(const [valid,row] of [[s.isExecutionLogCollection,log],[s.isBacktestHistoryCollection,history]]){
  assert.equal(valid([{broken:true}]),false);assert.equal(valid([]),true);assert.equal(valid([null,row]),true);assert.equal(valid({}),false);
 }
 assert.equal(s.isBacktestHistoryRow({rawResult:{security:{code:'600001'}}}),true);
 assert.equal(s.isBacktestHistoryRow({securityCode:['600001']}),false);
});
test('paper ledger requires coherent cash and positions while preserving legacy numeric strings',()=>{
 const good={initialCapital:100000,cash:77700,openPositions:[],closedPositions:[]};
 assert.equal(s.isPaperState(good),true);assert.equal(s.isPaperState({...good,cash:'77700'}),true);
 for(const cash of [null,{},[],true,'',-1])assert.equal(s.isPaperState({...good,cash}),false);
 assert.equal(s.isPaperState({...good,openPositions:[null]}),false);
 assert.equal(s.isPaperState({...good,openPositions:[{code:'600001',shares:100,entryPrice:10}]}),true);
});
