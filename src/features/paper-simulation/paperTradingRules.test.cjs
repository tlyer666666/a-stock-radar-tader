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

test('C-3 & H-6: ETF price limits use 10%/20% & 0.001 tick; synthetic snapshot does not stamp persistent gap block and advances holdingBars', () => {
  const rules = require('./paperTradingRules.ts');
  const engine = require('./paperSimulationEngine.ts');
  const { initialSettings } = require('../../domain/settings.ts');
  const { advancePaperHoldingBars } = require('../../paperHoldingBars.ts');
  const { shanghaiDateTag } = require('../../dateUtils.ts');

  assert.equal(rules.paperPriceLimitRate('510300', '沪深300ETF'), 0.1);
  assert.equal(rules.paperPriceLimitRate('513180', '恒生科技ETF'), 0.1);
  assert.equal(rules.paperPriceLimitRate('588000', '科创50ETF'), 0.2);
  assert.equal(rules.paperPriceLimitRate('159915', '创业板ETF'), 0.2);

  const etfPos = {
    code: '513180', name: '恒生科技ETF', quoteName: '恒生科技ETF',
    openedAt: '2026-01-01T02:00:00Z', quoteDate: shanghaiDateTag(),
    quoteVolume: 10000, latestPrice: 0.792, quotePreClose: 0.720
  };
  assert.match(rules.paperMatchBlock(etfPos, 'buy', 0.792), /涨停/);
  assert.equal(rules.paperMatchBlock({ ...etfPos, latestPrice: 0.791 }, 'buy', 0.791), '');

  // Background quote snapshot without history advances holdingBars by calendar trading days.
  const barRes = advancePaperHoldingBars(
    { openedAt: '2026-10-16T02:00:00Z', holdingBars: 0, lastHoldingBarDate: '2026-10-16' },
    undefined,
    '2026-10-21',
    '2026-10-20'
  );
  assert.equal(barRes.holdingBars, 2, '2026-10-19 (Mon) and 2026-10-20 (Tue) are 2 trading days');
  assert.equal(barRes.lastHoldingBarDate, '2026-10-20');

  // Synthetic snapshot (history omitted) with preClose gap must NOT stamp a persistent settlementBlockedReason.
  const baseState = {
    initialCapital: 100000,
    cash: 90000,
    equityPeak: 100000,
    maxDrawdownPercent: 0,
    openPositions: [{
      id: 'syn-1', code: '600519', name: '贵州茅台', shares: 100, entryPrice: 100, latestPrice: 100,
      stopPrice: 80, takePrice: 120, holdingBars: 1, lastHoldingBarDate: '2026-10-16', highWaterMark: 100,
      openedAt: '2026-10-15T02:00:00Z', entryFee: 5, feeRatePercent: 0.03,
      lastObservedClose: 100, lastObservedCloseDate: '2026-10-16', settlementBlockedReason: ''
    }],
    closedPositions: []
  };
  const synthetic = {
    security: { code: '600519', name: '贵州茅台', assetType: 'stock' },
    quote: { name: '贵州茅台', latest: 105, preClose: 104, high: 106, low: 104, volume: 10000 },
    updatedAt: '2026-10-20T02:00:00Z'
  };
  const res = engine.advancePaperSimulationByQuote(baseState, synthetic, { ...initialSettings, maxHoldingBars: 30, trailingStopPercent: 0 });
  assert.equal(res.state.openPositions[0].settlementBlockedReason || '', '', 'synthetic quote snapshot without history must not stamp persistent corporate-action block');
  assert.equal(res.changed, true, 'equityPeak / latestPrice change must report changed: true');
});
