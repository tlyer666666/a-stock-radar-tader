"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const indicators = () => {
  assert.ok(fs.existsSync(`${__dirname}/trend-indicators.cjs`), "pure OHLCV indicators must exist");
  return require("./trend-indicators.cjs");
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const row = (close, high = close + 1, low = close - 1, volume = 10) => ({ close, high, low, volume });

test("EMA uses period alpha, first-value seed; Chinese SMA uses explicit seed", () => {
  const { ema, sma } = indicators();
  assert.deepEqual(ema([10, 12, 16], 3), [10, 11, 13.5]);
  const actual = sma([30, 60, 90], 3, 50);
  [130 / 3, 440 / 9, 1690 / 27].forEach((want, i) => near(actual[i], want));
});

test("BOLL uses population variance and requires a full trailing window", () => {
  const { boll } = indicators();
  const actual = boll([1, 2, 3], 3, 2);
  assert.equal(actual.middle[1], null);
  assert.equal(actual.middle[2], 2);
  near(actual.upper[2], 2 + 2 * Math.sqrt(2 / 3));
  near(actual.width[2], 2 * Math.sqrt(2 / 3));
});

test("OBV treats flat closes as zero and ignores the arbitrary starting level", () => {
  assert.deepEqual(indicators().obv([row(10, 11, 9, 5), row(11, 12, 10, 7), row(11, 12, 10, 99), row(10, 11, 9, 3)]), [0, 7, 7, 4]);
});

test("DMI uses exclusive directions, rolling sums and an arithmetic ADX", () => {
  const { dmi } = indicators();
  const actual = dmi([row(9, 10, 8), row(11, 12, 7), row(12, 13, 8), row(13, 14, 9)], 2, 2);
  assert.equal(actual.pdi[1], null);
  assert.equal(actual.pdi[2], 30);
  assert.equal(actual.pdi[3], 20);
  assert.equal(actual.adx[3], 100);
  const equal = dmi([row(9, 10, 8), row(9, 12, 6), row(9, 12, 6)], 2, 1);
  assert.equal(equal.pdi[2], 0); assert.equal(equal.mdi[2], 0);
  assert.equal(equal.adx[2], null, "zero direction denominator cannot invent ADX strength");
});

test("KDJ seeds K/D at 50 and zero nine-day amplitude cannot cross", () => {
  const { kdj, crossedAbove } = indicators();
  const actual = kdj(Array.from({ length: 9 }, () => row(8, 10, 0)), 9, 3, 3);
  assert.equal(actual.k[7], null);
  near(actual.k[8], 60); near(actual.d[8], 160 / 3); near(actual.j[8], 220 / 3);
  const flat = kdj(Array.from({ length: 10 }, () => row(10, 10, 10)), 9, 3, 3);
  assert.equal(flat.rsv[9], null); assert.equal(flat.k[9], null);
  assert.equal(crossedAbove(null, null, 2, 1), false);
  assert.equal(crossedAbove(1, 1, 2, 1), true);
  assert.equal(crossedAbove(0, 1, 1, 1), false);
});

test("indicator series are prefix causal and never rewrite earlier observations", () => {
  const api = indicators();
  const rows = Array.from({ length: 110 }, (_, i) => row(10 + i / 10 + Math.sin(i), 13 + i / 10, 7 + i / 10, i + 10));
  for (const fn of [r => api.macd(r.map(x => x.close)), r => api.boll(r.map(x => x.close)), r => api.dmi(r), r => api.kdj(r)]) {
    const prefix = fn(rows.slice(0, 100));
    const extended = fn(rows);
    for (const key of Object.keys(prefix)) assert.deepEqual(extended[key].slice(0, 100), prefix[key], key);
  }
});

test("RSI uses Chinese recursive smoothing, full warm-up and no fabricated zero-volatility value",()=>{
 const {rsi}=indicators(); const got=rsi([10,11,10,12],2);
 assert.deepEqual(got.slice(0,2),[null,null]);near(got[2],50);near(got[3],100*1.25/1.5);
 assert.ok(rsi([10,10,10,10],2).every(x=>x===null));
});
test("CCI uses typical-price mean absolute deviation, not standard deviation",()=>{
 const {cci}=indicators();const got=cci([row(1,1,1),row(2,2,2),row(3,3,3)],3);
 assert.deepEqual(got.slice(0,2),[null,null]);near(got[2],100);
 assert.equal(cci([row(10),row(10),row(10)],3).at(-1),null);
});
test("ROC uses an exact lag and rejects unavailable or nonpositive reference closes",()=>{
 const {roc}=indicators();assert.deepEqual(roc([10,12,15],2),[null,null,50]);
 assert.equal(roc([0,10,12],2).at(-1),null);
});
test("MFI uses rolling typical-price volume flow and THS non-rising classification",()=>{
 const {mfi}=indicators();const got=mfi([row(10),row(12),row(11),row(11)],2);
 near(got[2],100*120/(120+110));assert.equal(got[3],0,"equal typical price belongs to non-positive flow");
 assert.equal(mfi([row(10,11,9,0),row(11,12,10,0),row(12,13,11,0)],2).at(-1),null);
});
test("EMV uses midpoint movement and arithmetic mean, with invalid volume failing closed",()=>{
 const {emv}=indicators();const got=emv([row(10),row(12),row(11)],2,1);
 assert.deepEqual(got.slice(0,2),[null,null]);near(got[2],.1);
 assert.equal(emv([row(10),row(12,13,11,0),row(11)],2,1).at(-1),null);
});
test("Donchian bands exclude today and require all prior observations",()=>{
 const {donchian}=indicators();const got=donchian([row(10),row(12),row(100)],2);
 assert.equal(got.upper[1],null);assert.equal(got.upper[2],13);assert.equal(got.lower[2],9);
});

test('all six expansion indicator series are prefix causal',()=>{
 const api=indicators();const rows=Array.from({length:110},(_,i)=>row(10+i/10+Math.sin(i),13+i/10,7+i/10,i+10));
 for(const fn of [r=>api.rsi(r.map(x=>x.close)),r=>api.cci(r),r=>api.roc(r.map(x=>x.close)),r=>api.emv(r),r=>api.mfi(r),r=>api.donchian(r)]){
  const first=fn(rows.slice(0,100)),full=fn(rows);
  if(Array.isArray(first))assert.deepEqual(full.slice(0,100),first);
  else for(const key of Object.keys(first))assert.deepEqual(full[key].slice(0,100),first[key]);
 }
});
