'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const security = { code:'688001', name:'示例股票', secid:'1.688001' };
const quote = { code:'688001',name:'示例股票',secid:'1.688001',latest:10,limitUp:12,limitDown:8,quoteAt:'2026-10-21T09:25:00+08:00',suspended:false,source:'fixture-reported-status' };
const create = (overrides = {}) => require('./trend-execution-check.cjs').createTrendExecutionChecker({ now:()=>new Date('2026-10-21T01:25:30Z'), fetchQuote:async()=>quote, ...overrides });
test('execution check uses source time/identity and board quantities', async()=>{
 const r=await create()({security,signalDate:'2026-10-20'});
 assert.equal(r.state,'ready');assert.equal(r.executionDate,'2026-10-21'); assert.equal(r.minimumBuyQuantity,200);assert.equal(r.quantityStep,1);
 assert.equal(r.priceDate,'2026-10-21'); assert.equal(r.validUntil,'2026-10-21T01:26:00.000Z');
});
test('past signals expire before any network operation',async()=>{
 let calls=0;const check=create({fetchQuote:async()=>{calls++;return quote;}});
 const r=await check({security,signalDate:'2026-10-16'});assert.equal(r.state,'expired');assert.equal(calls,0);
});
test('missing timestamps and halt state cannot be replaced by request time or observed volume',async()=>{
 for(const fields of [{quoteAt:undefined},{suspended:undefined,volume:1000000},{quoteAt:'2026-10-20T09:25:00+08:00'},{quoteAt:'2026-10-21T09:24:00+08:00'},{code:'600000'}]){
  const r=await create({fetchQuote:async()=>({...quote,...fields})})({security,signalDate:'2026-10-20'});assert.equal(r.state,'unknown');assert.ok(r.reasons.length);
 }
});
test('suspension, risk name and limit locked quotes block entry',async()=>{
 for(const fields of [{suspended:true},{name:'*ST示例'},{latest:12}]){
  const r=await create({fetchQuote:async()=>({...quote,...fields})})({security,signalDate:'2026-10-20'}); assert.equal(r.state,'blocked');
 }
});
test('network finishing outside the opening window cannot publish readiness',async()=>{
 let clock=new Date('2026-10-21T01:34:59Z');
 const check=create({now:()=>clock,fetchQuote:async()=>{clock=new Date('2026-10-21T01:35:01Z');return {...quote,quoteAt:'2026-10-21T09:35:00+08:00'};}});
 assert.equal((await check({security,signalDate:'2026-10-20'})).state,'expired');
});
test('unknown-year calendar, provider failure and inconsistent identity stay unknown',async()=>{
 const a=await create({now:()=>new Date('2027-01-05T01:25:30Z')})({security,signalDate:'2027-01-04'});assert.equal(a.state,'unknown');
 const b=await create({fetchQuote:async()=>{throw Error('offline')}})({security,signalDate:'2026-10-20'});assert.equal(b.state,'unknown');
 await assert.rejects(()=>create()({security:{...security,secid:'0.600001'},signalDate:'2026-10-20'}),/证券/);
});
