'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../../../qa/register-typescript.cjs');
let model, restore;
before(() => { restore = registerTypeScript(); model = require('./tToolboxModel.ts'); });
after(() => restore?.());
const rows = (n = 80, fn = i => 10 + i / 10) => Array.from({length:n}, (_,i) => {
  const close = fn(i); return { date: new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0,10), open:close, high:close+1, low:close-1, close, volume:100, volumeUnit:'lots' };
});
test('minute dates retain their time and invalid or duplicate candles are rejected', () => {
  const raw = rows(2).map((r,i)=>({...r,date:`2026-11-11 10:0${i}`}));
  const result = model.normalizeToolboxChart({rows:raw.reverse(),source:'测试源',adjustment:'不复权'});
  assert.deepEqual(result.rows.map(r=>r.date), ['2026-11-11 10:00','2026-11-11 10:01']);
  assert.equal(result.rows[0].volumeUnit,'手');
  for (const bad of [[raw[0],raw[0]],[{...raw[0],high:1}],[{...raw[0],date:'2026-02-30 10:00'}],[{...raw[0],close:NaN}]]) assert.throws(()=>model.normalizeToolboxChart({rows:bad}), /K线|行情/);
});
test('short history stays unknown; flat RSI is neutral and rising RSI is 100', () => {
  assert.equal(model.toolboxIndicators(rows(5)).rsi.at(-1),null);
  assert.equal(model.toolboxIndicators(rows(40,()=>10)).rsi.at(-1),50);
  assert.equal(model.toolboxIndicators(rows()).rsi.at(-1),100);
  assert.equal(model.toolboxIndicators(rows(40,()=>10)).macd.at(-1),0);
  assert.ok(Math.abs(model.toolboxIndicators(rows(40,()=>10)).atr.at(-1)-2)<1e-10);
});
test('indicator values do not depend on future candles', () => {
  const all = model.toolboxIndicators(rows(80)); const prefix = model.toolboxIndicators(rows(40));
  for (const key of ['rsi','dif','dea','macd','atr','k','d','j','ma20','upper']) assert.deepEqual(all[key].slice(0,40),prefix[key],key);
});
test('support and resistance exclude the current candle; missing volume is never zero', () => {
  const input = rows(21,()=>10); input[20]={...input[20],high:100,low:1,volume:200};
  const s = model.summarizeToolbox(input);
  assert.equal(s.support,9);assert.equal(s.resistance,11);assert.equal(s.volumeRatio,2);
  input[3].volume=null;
  assert.equal(model.summarizeToolbox(input).volumeRatio,null);
  assert.equal(model.summarizeToolbox(rows(10)).support,null);
});
test('drawings keep time/price anchors, isolate stock and adjustment, and reject malformed entries', () => {
  assert.notEqual(model.drawingKey('600001','101','前复权'),model.drawingKey('600001','101','不复权'));
  assert.notEqual(model.drawingKey('600001','101','前复权'),model.drawingKey('600002','101','前复权'));
  const valid={id:'x',kind:'horizontal',a:{date:'2026-11-11',price:10}};
  assert.deepEqual(model.normalizeDrawings([valid,{...valid,id:'bad',a:{date:'bad',price:NaN}},{...valid,id:'trend',kind:'trend'}]),[valid]);
  assert.equal(model.normalizeDrawings(Array.from({length:60},(_,i)=>({...valid,id:String(i)}))).length,50);
});
test('old minute history is explicitly marked historical and future timestamps are rejected as current', () => {
  const now = new Date('2026-11-11T10:30:00+08:00');
  assert.match(model.toolboxHistoryNote({rows:[{date:'2026-11-10 15:00'}]},'5',now),/历史|不是今日/);
  assert.match(model.toolboxHistoryNote({rows:[{date:'2026-11-11 09:40'}]},'5',now),/滞后/);
  assert.equal(model.toolboxHistoryNote({rows:[{date:'2026-11-11 10:30'}]},'5',now),'');
  assert.match(model.toolboxHistoryNote({rows:[{date:'2026-11-12 10:00'}]},'5',now),/异常/);
});
test('drawing references survive ordinary rolling history and ignore the forming candle', () => {
  const base=rows(140); const refs=model.drawingReferences(base);
  assert.equal(refs.length,3);assert.ok(refs.every(r=>r.date!==base.at(-1).date));
  const rolled=[...base.slice(1),{...base.at(-1),date:'2026-11-30',close:100,high:101}];
  assert.equal(model.drawingReferenceStatus(refs,rolled),'valid');
  assert.equal(model.drawingReferenceStatus(refs,rolled.map(r=>({...r,close:r.close*.5}))),'changed');
  assert.equal(model.drawingReferenceStatus(refs,rows(10)),'missing');
});

test("日线背景：均线空头但价格站上 MA20 时是弱势反弹，不笼统叫整理", () => {
  const sample = rows(80, i => i < 70 ? 70 - i * 0.45 : 38.5 + (i - 70) * 0.6);
  assert.match(model.summarizeToolbox(sample).trend, /弱势反弹/);
});
