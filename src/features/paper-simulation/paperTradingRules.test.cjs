'use strict';
// F-01 回归：除权阻塞必须能在事实澄清后解除，否则持仓永久无法平仓。
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../../../qa/register-typescript.cjs');
registerTypeScript();
const { paperCorporateActionBlock } = require('./paperTradingRules.ts');

const pos = (over = {}) => ({ code: '600519', name: '贵州茅台', openedAt: '2026-10-10', ...over });
const payload = (over = {}) => ({ updatedAt: '2026-10-19T10:00:00+08:00', quote: { name: '贵州茅台', preClose: 100, latest: 101 }, ...over });

test('除权标记仍在时继续阻塞（安全底线不破）', () => {
  const r = paperCorporateActionBlock(pos(), payload({ quote: { name: 'XR贵州茅台', preClose: 100, latest: 101 } }));
  assert.match(r, /除权除息/, '名称带 XR 必须继续阻塞');
});

test('行情声明 corporateAction 时继续阻塞', () => {
  const r = paperCorporateActionBlock(pos(), payload({ quote: { name: '贵州茅台', preClose: 100, latest: 101, corporateAction: true } }));
  assert.match(r, /除权除息/);
});

test('前收与已记录收盘不一致时继续阻塞', () => {
  const p = pos({ lastObservedClose: 100, lastObservedCloseDate: '2026-10-17' });
  const r = paperCorporateActionBlock(p, payload({ updatedAt: '2026-10-19T10:00:00+08:00', quote: { name: '贵州茅台', preClose: 88, latest: 90 } }));
  assert.match(r, /前收盘/);
});

test('★ 已阻塞但事实已澄清 → 解除阻塞（原实现永久死锁）', () => {
  // 关键场景：早就被阻塞了，但现在名称无除权标记、前收与记录一致
  const p = pos({ settlementBlockedReason: '前收盘参考价与已记录收盘价不一致（除权或缺失交易日待核实），暂停撮合' });
  const r = paperCorporateActionBlock(p, payload({ quote: { name: '贵州茅台', preClose: 100, latest: 101 } }));
  assert.equal(r, '', '事实澄清后必须返回空串以解除阻塞');
});

test('★ 已阻塞且除权日已过（行情推进、前收稳定）→ 解除', () => {
  const p = pos({
    settlementBlockedReason: '除权除息资料待核实，暂停撮合；需核对股份及现金权益',
    lastObservedClose: 100,
    lastObservedCloseDate: '2026-10-16'
  });
  const r = paperCorporateActionBlock(p, payload({
    updatedAt: '2026-10-19T10:00:00+08:00',
    quote: { name: '贵州茅台', preClose: 100, latest: 102 }
  }));
  assert.equal(r, '', '前收已与记录一致，应解除');
});

test('未阻塞且无异常 → 返回空', () => {
  assert.equal(paperCorporateActionBlock(pos(), payload()), '');
});

test('1.6.52: STAR market lot rule, Beijing new listings without a limit, and exchange-consistent limit rounding', () => {
  const rules = require('./paperTradingRules.ts');
  assert.deepEqual(rules.paperLotRule('688001'), { min: 200, step: 1 });
  assert.equal(rules.paperRoundShares('688001', 199.9), 0);
  assert.equal(rules.paperRoundShares('688001', 257.6), 257);
  assert.equal(rules.paperRoundShares('600001', 257.6), 200);
  assert.equal(rules.paperRoundShares('920001', 157), 157);
  assert.equal(rules.paperPriceLimitRate('920001', 'N新股'), null, 'Beijing first-day listings have no limit');
  assert.equal(rules.paperPriceLimitRate('920001', '北交样本'), 0.3);
  const position = { code: '600001', name: '样本', quoteName: '样本', openedAt: '2026-01-01T02:00:00Z', quoteDate: require('../../dateUtils').shanghaiDateTag(), quoteVolume: 100, latestPrice: 18.87, quotePreClose: 17.15 };
  assert.match(rules.paperMatchBlock(position, 'buy', 18.87), /涨停/, '17.15 × 1.1 rounds to 18.87, so 18.87 is the limit');
});
