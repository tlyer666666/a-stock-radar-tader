'use strict';
// Strategy quality, feasibility and practicality regressions (2026-10-21 review).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTradingCalendar } = require('./trend-trading-calendar.cjs');
const engine = require('./strategy-signal-engine.cjs');
const fieldRules = require('./strategy-field-rules.cjs');
const { limitEvidenceAt } = require('./strategy-signal-combinations.cjs');
const { preLimitRangePosition } = require('./strategy-selection-rules.cjs');
const { featureSnapshot, selectionExecutionNotes } = engine.__test;
const calendar = createTradingCalendar();
const lowFirstBoard = engine.ALL_STRATEGY_DEFINITIONS.find(item => item.id === 'low_first_board');

function bar(date, close, previous, extra = {}) {
  const open = extra.open ?? previous;
  return { date, open, high: Math.max(open, close) * 1.004, low: Math.min(open, close) * 0.996, close, volume: 100000, amount: 100000 * close, ...extra };
}
function pathHistory(closes) {
  const dates = calendar.sessionsThrough('2026-10-20', closes.length);
  return closes.map((close, index) => bar(dates[index], close, index ? closes[index - 1] : close));
}
function withFirstBoard(closes) {
  const rows = pathHistory(closes.slice(0, -1));
  const previous = rows.at(-1).close, limit = Math.round(previous * 110) / 100;
  const date = calendar.nextSession(rows.at(-1).date);
  rows.push({ date, open: previous * 1.01, high: limit, low: previous * 1.005, close: limit, volume: 200000, amount: 200000 * limit });
  return rows;
}

test('低位首板 v1.3.0: first board after a decline, close within 5% of MA20 and no 60-day gain', () => {
  // 一路下跌后的首板：涨停收盘约等于 MA20，近60日下跌 → 低位
  const falling = [...Array.from({ length: 120 }, (_, i) => 20 - i * 0.0924), 0];
  // 一路上涨后的首板：远高于 MA20、60日大涨 → 不是低位
  const rising = [...Array.from({ length: 120 }, (_, i) => 10 + i * 0.08), 0];
  // 下跌后横盘再涨停：涨停收盘高于 MA20 约 10%（旧版会判为低位，实测这类表现差）
  const baseThenLimit = [...Array.from({ length: 95 }, (_, i) => 20 - i * 0.1), ...Array(24).fill(10.5), 0];
  const feature = closes => { const rows = withFirstBoard(closes); return featureSnapshot(rows, rows.length - 1, '600001', '样本'); };
  const low = feature(falling), high = feature(rising), based = feature(baseThenLimit);
  for (const item of [low, high, based]) assert.equal(item.isCurrentLimit, true);
  assert.ok(low.ma20ExtensionPercent <= 5 && low.return60Percent <= 0, `${low.ma20ExtensionPercent} ${low.return60Percent}`);
  assert.equal(lowFirstBoard.matches(low), true);
  assert.equal(lowFirstBoard.matches(high), false);
  assert.ok(based.ma20ExtensionPercent > 9, `extension ${based.ma20ExtensionPercent}`);
  assert.equal(lowFirstBoard.matches(based), false, 'a limit-up already 10% above MA20 is no longer "低位"');
  assert.equal(lowFirstBoard.version, '1.3.0');
  // 不足60个交易日：60日涨幅不可算，不判为低位
  const short = withFirstBoard(Array.from({ length: 50 }, (_, i) => 15 - i * 0.1).concat(0));
  const shortFeature = featureSnapshot(short, short.length - 1, '600001', '样本');
  assert.equal(shortFeature.return60Percent, null);
  assert.equal(lowFirstBoard.matches(shortFeature), false);
  assert.equal(preLimitRangePosition(withFirstBoard(falling).slice(0, 40), 39), null, 'fewer than 60 prior sessions stays unknown');
});

test('overheat count follows the field rules and vetoes only non-limit-day signals with two or more flags', () => {
  const { overheatAssessment, fieldSignalStrength, OVERHEAT } = fieldRules;
  const calm = { closePosition: 0.5, currentReturn: 1, ma20ExtensionPercent: 3, volumeRatio: 0.9, priorLimitCount60: 0, return60Percent: 5 };
  assert.deepEqual(overheatAssessment(calm), { flags: [], count: 0, veto: false });
  const one = overheatAssessment({ ...calm, volumeRatio: OVERHEAT.maxVolumeRatio + 0.1 });
  assert.equal(one.count, 1); assert.equal(one.veto, false);
  const two = overheatAssessment({ ...calm, closePosition: 0.95, currentReturn: 6 });
  assert.equal(two.count, 2); assert.equal(two.veto, true);
  // 涨停日：收盘高位、大涨、量比不计入，也从不否决
  const limitDay = overheatAssessment({ ...calm, isCurrentLimit: true, closePosition: 1, currentReturn: 10, volumeRatio: 3 });
  assert.equal(limitDay.count, 0); assert.equal(limitDay.veto, false);
  const hotLimit = overheatAssessment({ ...calm, isCurrentLimit: true, closePosition: 1, currentReturn: 10, ma20ExtensionPercent: 25, return60Percent: 80, priorLimitCount60: 4 });
  assert.equal(hotLimit.count, 3); assert.equal(hotLimit.veto, false);
  // 排序分：越热越低；低位首板加分
  assert.ok(fieldSignalStrength(calm) > fieldSignalStrength({ ...calm, volumeRatio: 2 }));
  assert.ok(fieldSignalStrength({ ...calm, isCurrentLimit: true, ma20ExtensionPercent: 2, return60Percent: -10 }) > fieldSignalStrength({ ...calm, isCurrentLimit: true, ma20ExtensionPercent: 8, return60Percent: 10 }));
});

test('non-limit-day strategies skip overheated signals; limit-day-only strategies keep their version', () => {
  const vcp = engine.ALL_STRATEGY_DEFINITIONS.find(item => item.id === 'vcp_compression');
  const feature = { vcpCompression: true, riskVeto: true, overheatVeto: false };
  assert.equal(vcp.matches(feature), true);
  assert.equal(vcp.matches({ ...feature, overheatVeto: true }), false);
  assert.equal(vcp.version, '1.2.0'); assert.equal(vcp.overheatGate, true);
  const platform = engine.ALL_STRATEGY_DEFINITIONS.find(item => item.id === 'platform_breakout');
  assert.equal(platform.overheatGate, false); assert.equal(platform.version, '1.1.0');
  assert.ok(vcp.conditions.some(line => /过热指标/.test(line)));
});

test('historical review skips next-day entries that gap up more than 4% or down more than 5%', () => {
  const rows = pathHistory(Array(100).fill(10));
  const signal = 80;
  const replay = (entryOpen, policy) => {
    const history = rows.map((row, index) => index === signal + 1 ? { ...row, open: entryOpen, high: Math.max(entryOpen, row.high), low: Math.min(entryOpen, row.low) } : row);
    const definition = { id: 'probe', matches: feature => feature.date === history[signal].date };
    return engine.__test.replayStrategy(definition, '600001', '样本', history, new Map(), engine.__test.resolvedOptions({ horizonDays: 5, cooldownDays: 5 }), policy);
  };
  assert.equal(replay(10.5, { entryGapRule: true }).untradeableReasons.entryGapOutOfRange, 1, 'gap up 5% is skipped');
  assert.equal(replay(9.4, { entryGapRule: true }).untradeableReasons.entryGapOutOfRange, 1, 'gap down 6% is skipped');
  assert.equal(replay(10.3, { entryGapRule: true }).samples.length, 1, 'gap up 3% is bought');
  const off = replay(10.5, {});
  assert.equal(off.samples.length, 1, 'other replays are unchanged without the rule');
  assert.equal(Object.hasOwn(off.untradeableReasons, 'entryGapOutOfRange'), false);
});

test('limit-up evidence in combination strategies uses the exchange reference close like base strategies', () => {
  const rows = [{ date: '2026-07-09', open: 10, high: 10.1, low: 9.9, close: 10, volume: 1, amount: 1 },
    { date: '2026-07-10', open: 9.8, high: 10.67, low: 9.7, close: 10.67, preClose: 9.7, volume: 1, amount: 1 }];
  const evidence = limitEvidenceAt(rows, 1, '600001', '样本');
  assert.ok(evidence, 'ex-dividend limit-up (preClose 9.70 → 10.67) is recognised');
  assert.equal(evidence.source, 'reference_pre_close');
  const plain = limitEvidenceAt([rows[0], { ...rows[1], preClose: undefined }].map(({ preClose: _p, ...row }) => row), 1, '600001', '样本');
  assert.equal(plain, null, 'without a reference close, 10.67 is not a 10% limit over 10.00');
});

test('next-session practicality notes flag one-price limit-ups and thin liquidity without filtering', () => {
  const rows = pathHistory(Array(30).fill(10));
  rows.push({ date: calendar.nextSession(rows.at(-1).date), open: 11, high: 11, low: 11, close: 11, volume: 5000, amount: 55000000 });
  const feature = featureSnapshot(rows, rows.length - 1, '600001', '样本');
  const notes = selectionExecutionNotes(rows, feature, { code: '600001', name: '样本' });
  assert.ok(notes.some(note => /一字涨停/.test(note)), notes.join('|'));
  assert.ok(notes.some(note => /不足1亿/.test(note)), notes.join('|'));
});

function syntheticUniverse(count, bars, seedStart = 11) {
  let seed = seedStart; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const dates = calendar.sessionsThrough('2026-10-20', bars), candidates = [], histories = {};
  for (let s = 0; s < count; s++) {
    const code = String(600100 + s); let close = 10 + rnd() * 10; const rows = [];
    for (const date of dates) {
      const previous = close, limit = rnd() < 0.04;
      close = Math.round(previous * (limit ? 1.1 : 1 + (rnd() - 0.5) * 0.05) * 100) / 100;
      const open = Math.round(previous * (1 + (rnd() - 0.5) * 0.02) * 100) / 100;
      rows.push({ date, open, high: limit ? close : Math.round(Math.max(open, close) * (1 + rnd() * 0.02) * 100) / 100,
        low: Math.round(Math.min(open, close) * (1 - rnd() * 0.02) * 100) / 100, close, volume: 1e6 * (1 + rnd()), amount: 1e8 * (1 + rnd()) });
    }
    candidates.push({ code, name: `样本${s}` }); histories[code] = rows;
  }
  let level = 3000; const benchmark = dates.map(date => { const open = level; level *= 1 + (rnd() - 0.5) * 0.01; return { date, open, high: Math.max(open, level) * 1.002, low: Math.min(open, level) * 0.998, close: level, volume: 1e9, amount: 1e12 }; });
  return { candidates, histories, benchmark, dates };
}

test('historical review never sees bars after its cutoff and never changes current picks', () => {
  const { candidates, histories, benchmark, dates } = syntheticUniverse(24, 260);
  const signalTo = dates[dates.length - 20];
  const options = { asOfDate: '2026-10-20', marketDates: calendar.sessionsThrough('2026-10-20', 120), minCurrentHistoryBars: 120 };
  const withReview = engine.buildStrategySelectionReport(candidates, histories, benchmark, { ...options, historicalReview: { signalTo } });
  const plain = engine.buildStrategySelectionReport(candidates, histories, benchmark, options);
  assert.deepEqual(withReview.strategies.map(item => item.stocks.map(stock => stock.code)), plain.strategies.map(item => item.stocks.map(stock => stock.code)));
  assert.equal(plain.historicalReview, undefined);
  const picks = withReview.strategies.flatMap(item => item.stocks);
  assert.ok(picks.length > 0, 'synthetic universe yields picks');
  for (const stock of picks) assert.ok(stock.invalidationPrice > 0 && stock.invalidationPrice <= stock.latest * 1.0001, `${stock.code} invalidation ${stock.invalidationPrice} vs ${stock.latest}`);
  const review = withReview.historicalReview;
  assert.equal(review.signalTo, signalTo); assert.equal(review.roundTripCostBps, 23.2); assert.ok(review.baseline.sampleCount > 0);
  for (const strategy of withReview.strategies) {
    assert.ok(strategy.history, strategy.id);
    if (strategy.history.sampleCount) assert.ok(strategy.history.range.to <= signalTo, `${strategy.id} signal after cutoff`);
    assert.ok(['insufficient', 'favorable', 'neutral', 'weak'].includes(strategy.history.verdict.level));
  }
  // Doubling every price after the cutoff must not move any historical statistic.
  const mutated = Object.fromEntries(Object.entries(histories).map(([code, rows]) => [code, rows.map(row => row.date > signalTo ? { ...row, open: row.open * 2, high: row.high * 2, low: row.low * 2, close: row.close * 2 } : row)]));
  const again = engine.buildSelectionHistoricalReview(engine.STRATEGY_DEFINITIONS, candidates, mutated, benchmark, { signalTo });
  const original = engine.buildSelectionHistoricalReview(engine.STRATEGY_DEFINITIONS, candidates, histories, benchmark, { signalTo });
  assert.deepEqual(again, original);
});

test('historical review is skipped cleanly without a valid cutoff', () => {
  assert.equal(engine.buildSelectionHistoricalReview(engine.STRATEGY_DEFINITIONS, [], {}, [], { signalTo: '' }), null);
});

for (const blockedExit of ['limit-down', 'no-volume']) {
  test(`historical baseline uses the same delayed ${blockedExit} exit and signal cooldown as strategies`, () => {
    const rows = pathHistory([...Array(100).fill(10), ...Array(7).fill(11)]);
    rows[100].high = 11;
    rows[105] = bar(rows[105].date, blockedExit === 'limit-down' ? 9.9 : 10.2, 11,
      blockedExit === 'no-volume' ? { volume: 0 } : {});
    rows[106] = bar(rows[106].date, 9.8, rows[105].close);
    const definition = { id: 'recent_limit', matches: feature => Number.isInteger(feature.daysSinceLimit) && feature.daysSinceLimit <= 15 };
    const result = engine.buildSelectionHistoricalReview([definition], [{ code: '600001', name: '样本' }],
      { '600001': rows }, rows, { signalTo: rows.at(-1).date });
    // The only completed trade enters at 11; the blocked day-five exit is
    // deferred to 9.80, giving (9.80 / 11 - 1) * 100 - 0.232 = -11.141%.
    assert.equal(result.strategies.recent_limit.sampleCount, 1);
    assert.equal(result.strategies.recent_limit.averageReturn, -11.141);
    assert.equal(result.baseline.sampleCount, 1);
    assert.equal(result.baseline.averageReturn, -11.141);
    assert.equal(result.strategies.recent_limit.edgeVsBaseline, 0);
  });
}

test('historical unbuyable rate counts observed entries before their holding period completes', () => {
  const rows = pathHistory(Array(100).fill(10));
  rows[99] = { ...rows[99], open: 11, close: 11, high: 11, low: 11 };
  const signals = new Set([rows[60].date, rows[96].date, rows[98].date, rows[99].date]);
  const definition = { id: 'observed_entries', matches: feature => signals.has(feature.date) };
  const result = engine.buildSelectionHistoricalReview([definition], [{ code: '600001', name: '样本' }],
    { '600001': rows }, rows, { signalTo: rows.at(-1).date, cooldownDays: 0 });
  assert.equal(result.strategies.observed_entries.sampleCount, 1);
  // Three next opens are observed: one completed, one awaiting exit, one
  // unbuyable. The final signal has no next open and must not dilute the rate.
  assert.equal(result.strategies.observed_entries.nextDayUnbuyableRate, 33.3);
});


test('historical review counts discarded rows and never filters a stock by its current risk name', () => {
  const rows = pathHistory([...Array(100).fill(10), ...Array(8).fill(11)]);
  rows[100].high = 11;
  const opts = { signalTo: rows.at(-1).date };
  const definition = { id: 'recent', matches: feature => Number.isInteger(feature.daysSinceLimit) && feature.daysSinceLimit <= 15 };
  const replay = (name, risk) => {
    const marked = rows.map(row => risk === undefined ? row : {...row, isST:risk});
    return engine.buildSelectionHistoricalReview([definition], [{code:'600001',name},{code:'600002',name:'短历史'}],
      {'600001':[...marked,marked[0],{date:marked[1].date,open:0}], '600002':marked.slice(0,2)}, rows, opts);
  };
  const ordinary = replay('普通样本',false), renamed = replay('ST今日名称',false);
  assert.deepEqual(renamed,ordinary); assert.equal(ordinary.dataQuality.invalidRows,1);
  assert.equal(ordinary.dataQuality.duplicateDates,1); assert.equal(ordinary.dataQuality.insufficientHistories,1);
  assert.ok(ordinary.baseline.sampleCount > 0); assert.equal(replay('普通名称',true).baseline,null);
  assert.ok(replay('未知身份').dataQuality.unknownStRows > 0); assert.equal(ordinary.universe.pointInTime,false);
});
