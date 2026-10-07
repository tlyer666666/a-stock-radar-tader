'use strict';
const assert=require('node:assert/strict');const {test,before,after}=require('node:test');
const {registerTypeScript}=require('../qa/register-typescript.cjs');const catalog=require('../config/trend-strategy-library.json');
let restore,config,preview,workspace;
before(()=>{restore=registerTypeScript();config=require('./trendStrategyConfig.ts');preview=require('./trendScreenerPreview.ts');workspace=require('./trendWorkspace.ts');});after(()=>restore?.());
test('all independent library IDs normalize fixed snapshots with backend fingerprints',async()=>{
 const {normalizeTrendStrategy}=require('../electron/trend-strategy.cjs');
 for(const def of catalog){
  const state=await preview.createConfiguredTrendPreviewStatus({strategyId:def.id});
  assert.deepEqual(state.strategy,normalizeTrendStrategy({strategyId:def.id}));
  assert.ok(config.validStrategySnapshot(state.strategy));
  assert.equal(config.strategyName(state.strategy),def.name);
  assert.ok(state.candidates.every(c=>c.strategy.id===def.id&&c.patterns.length===0&&c.setup.id===def.id));
  const frozen=workspace.createSavedTrendPlan(state.candidates[0],state);let raw;const store={getItem:()=>raw,setItem:(_,v)=>raw=v};
  assert.equal(workspace.writeTrendPlans(store,[frozen]),true);assert.equal(workspace.readTrendPlans(store).plans.length,1);
  const bad=structuredClone(frozen);bad.candidate.strategy.config.maxExtensionAtr=99;
  assert.equal(workspace.writeTrendPlans(store,[bad]),false);
  const csv=workspace.trendCandidatesCsv([frozen]);assert.ok(csv.includes(def.name));assert.ok(csv.includes(def.id));
 }
});
test('combined preview is canonical, counts stocks once, and preserves per-strategy plan identity',async()=>{
 const selections=catalog.map(d=>({strategyId:d.id}));
 const a=await preview.createConfiguredTrendPreviewStatus({strategies:selections});
 const b=await preview.createConfiguredTrendPreviewStatus({strategies:[...selections].reverse()});
 assert.equal(a.strategy,undefined);assert.equal(a.strategies.length,catalog.length);assert.equal(a.strategySetHash,b.strategySetHash);
 assert.equal(a.processed,8);assert.equal(a.candidates.length,catalog.length*3);assert.equal(new Set(a.candidates.map(c=>c.security.secid)).size,3);
 const single=await preview.createConfiguredTrendPreviewStatus(selections[0]);
 const matching=a.candidates.find(c=>c.strategy.id===selections[0].strategyId&&c.security.secid===single.candidates[0].security.secid);
 assert.equal(workspace.trendPlanId(matching,true),workspace.trendPlanId(single.candidates[0],true));
 for(const options of [{strategies:[]},{strategies:[selections[0],selections[0]]},{strategyId:'classic-v1',strategies:selections}])await assert.rejects(()=>preview.createConfiguredTrendPreviewStatus(options));
});
test('new technical snapshots reject absent setup, invalid numbers and plans in watch state',async()=>{
 const state=await preview.createConfiguredTrendPreviewStatus({strategyId:catalog[0].id});
 const good=workspace.createSavedTrendPlan(state.candidates[0],state);
 for(const mutation of [c=>delete c.setup,c=>c.setup.triggerPrice=NaN,c=>c.technical.indicators.DIF=Infinity,c=>c.plan.minEntry=c.plan.stop,c=>c.stage='watch']){
  const bad=structuredClone(good);mutation(bad.candidate);assert.equal(workspace.writeTrendPlans({setItem(){}},[bad]),false);
 }
});
test('strategy equality rejects inconsistent config bodies and versions while retaining legacy classic compatibility', async()=>{
 const quality=(await preview.createConfiguredTrendPreviewStatus({strategyId:'quality-v2'})).strategy;
 const changed=structuredClone(quality);changed.config.maxExtensionAtr=2.5;
 assert.equal(config.sameTrendStrategy(quality,changed),false,'equal hash strings must not hide different parameter bodies');
 const classic=(await preview.createConfiguredTrendPreviewStatus({strategyId:'classic-v1'})).strategy;
 assert.equal(config.sameTrendStrategy(undefined,classic),true);
 assert.equal(config.sameTrendStrategy(classic,{...classic,version:'99.0.0'}),false);
});
test('saved plan verification isolates dates, strategy params, preview status, and per-strategy coverage',async()=>{
 const single=await preview.createConfiguredTrendPreviewStatus({strategyId:catalog[0].id});
 const saved=workspace.createSavedTrendPlan(single.candidates[0],single);
 const batch=await preview.createConfiguredTrendPreviewStatus({strategies:catalog.map(d=>({strategyId:d.id}))});
 assert.equal(workspace.reviewSavedTrendPlan(saved,batch).verificationAvailable,true,'same strategy in a batch may verify an observed candidate');
 const mismatched=structuredClone(batch);mismatched.strategies[0].configHash='f'.repeat(64);
 // Choose by id because batch canonical ordering is independent from catalog order.
 mismatched.strategies.find(s=>s.id===saved.candidate.strategy.id).configHash='f'.repeat(64);
 assert.equal(workspace.reviewSavedTrendPlan(saved,mismatched).verificationAvailable,false);
 assert.equal(workspace.reviewSavedTrendPlan(saved,{...batch,isPreview:false}).verificationAvailable,false);
 const older=structuredClone(batch);older.asOf='2026-09-28';older.candidates.forEach(c=>c.asOf=older.asOf);
 assert.equal(workspace.reviewSavedTrendPlan(saved,older).marketGate,'unknown');
 const stale=structuredClone(batch);stale.asOf='2026-09-30';stale.coverageComplete=true;stale.strategyStats.forEach(s=>s.coverageComplete=true);
 assert.equal(workspace.reviewSavedTrendPlan(saved,stale).verificationAvailable,false,'stale candidate cannot stand for current coverage');
 const absent=structuredClone(batch);absent.asOf='2026-09-30';absent.candidates=[];absent.coverageComplete=true;
 assert.equal(workspace.reviewSavedTrendPlan(saved,absent).verificationAvailable,false,'another strategy/global completion must not prove absence');
 absent.strategyStats.find(s=>s.strategy.id===saved.candidate.strategy.id).coverageComplete=true;
 assert.equal(workspace.reviewSavedTrendPlan(saved,absent).verificationAvailable,true);
 assert.equal(workspace.reviewSavedTrendPlan(saved,absent).latestAsOf,'2026-09-30');
 delete absent.strategyStats;
 assert.equal(workspace.reviewSavedTrendPlan(saved,absent).verificationAvailable,false,'multi-strategy reports require corresponding strategy coverage');
 assert.equal(workspace.reviewSavedTrendPlan(saved,{...single,candidates:[],strategyStats:undefined,coverageComplete:true}).verificationAvailable,true,'old single report remains compatible');
});
test('library preview observations never inherit old A/B failure warnings',async()=>{
 const state=await preview.createConfiguredTrendPreviewStatus({strategyId:catalog[0].id});
 const watch=state.candidates.find(c=>c.stage==='watch');
 assert.ok(watch);
 assert.doesNotMatch(watch.warnings.join(' '),/A\/B/);
});
