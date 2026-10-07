const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
let restore, subject;
before(() => { restore = registerTypeScript(); subject = require('./signalTestRequest.ts'); });
after(() => restore?.());
const group = { id: 'limit_macd_pullback', name: '回踩共振', version: '1.0.0' };
test('unpublished strategy can create an explicit manual single-stock research request', () => {
  const stock = { code: '302132', name: '测试股票', secid: '0.302132', assetType: 'stock' };
  const r = subject.buildManualSignalTestRequest(stock, group);
  assert.equal(r.security.code, '302132');
  assert.equal(r.universeSource, 'manual');
  assert.equal(r.strategyVersion, '1.0.0');
  assert.deepEqual(r.strategyIds, [group.id]);
  assert.deepEqual(r.securities.map(s => s.code), ['302132']);
  assert.equal(r.universeTotalCount, 1);
  assert.equal(r.minimumVotes, 1);
});
test('manual research rejects non A shares, ST, wrong exchange identity and absent selection', () => {
  for (const stock of [null, {code:'510300',name:'ETF',secid:'1.510300',assetType:'etf'}, {code:'600000',name:'ST测试',secid:'1.600000'}, {code:'303001',name:'测试',secid:'0.303001'}, {code:'600000',name:'浦发',secid:'0.600000'}]) {
    assert.equal(subject.buildManualSignalTestRequest(stock, group), null);
  }
  assert.equal(subject.buildManualSignalTestRequest({code:'600000',name:'浦发',secid:'1.600000'}, {id:'',name:''}), null);
});
test('search choices deduplicate only complete eligible identities and cap displayed results', () => {
  const s = {code:'600000',name:'浦发银行',secid:'1.600000'};
  assert.deepEqual(subject.eligibleSignalTestStocks([s,s,{...s,secid:'0.600000'}, {code:'920000', name:'万达轴承',secid:'0.920000'}]).map(x => x.code), ['600000','920000']);
});
