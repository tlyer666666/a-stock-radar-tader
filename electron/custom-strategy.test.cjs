'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const custom = require('./custom-strategy.cjs');
const engine = require('./strategy-signal-engine.cjs');
const { legacyFactorSnapshot } = require('./strategy-intelligence.cjs');
const { evaluateAnalysisPresetRequirements } = require('./analysis-selection-policy.cjs');
const { createTradingCalendar } = require('./trend-trading-calendar.cjs');
const conditions = require('../config/strategy-custom-conditions.json');
const { initialSelected } = { initialSelected: ['support', 'avwap', 'trend', 'contraction', 'sector', 'sectorLadder', 'riskVeto'] };

const patternIds = new Set(engine.ALL_STRATEGY_DEFINITIONS.map(item => item.id));
const patternMatchers = new Map(engine.ALL_STRATEGY_DEFINITIONS.map(item => [item.id, item.matches]));
const patternNames = new Map(engine.ALL_STRATEGY_DEFINITIONS.map(item => [item.id, item.name]));
const calendar = createTradingCalendar();
const base = { id: 'cs_test001', name: '测试策略', conditions: [{ ref: 'factor:support', required: true }, { ref: 'factor:trend' }] };

function universe(count, bars, seedStart = 5) {
  let seed = seedStart; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const dates = calendar.sessionsThrough('2026-10-20', bars), candidates = [], histories = {};
  for (let s = 0; s < count; s++) {
    const code = String(600200 + s); let close = 10 + rnd() * 10; const rows = [];
    for (const date of dates) {
      const previous = close, limit = rnd() < 0.05;
      close = Math.round(previous * (limit ? 1.1 : 1 + (rnd() - 0.48) * 0.05) * 100) / 100;
      const open = Math.round(previous * (1 + (rnd() - 0.5) * 0.02) * 100) / 100;
      rows.push({ date, open, high: limit ? close : Math.round(Math.max(open, close) * (1 + rnd() * 0.02) * 100) / 100,
        low: Math.round(Math.min(open, close) * (1 - rnd() * 0.02) * 100) / 100, close, volume: 1e6 * (0.5 + rnd()), amount: 1e8 * (1 + rnd()) });
    }
    candidates.push({ code, name: `样本${s}` }); histories[code] = rows;
  }
  let level = 3000; const benchmark = dates.map(date => { const open = level; level *= 1 + (rnd() - 0.5) * 0.01; return { date, open, high: Math.max(open, level) * 1.002, low: Math.min(open, level) * 0.998, close: level, volume: 1e9, amount: 1e12 }; });
  return { candidates, histories, benchmark };
}

test('the condition catalog covers every settings factor and legacy riskVeto stays an implicit gate', () => {
  const { strategyOptions } = { strategyOptions: ['support', 'avwap', 'trend', 'contraction', 'sector', 'volatility', 'originBreakout', 'vcpCompression', 'chipLock', 'information', 'exactNode', 'lowFirstBoard', 'firstBoardQuality', 'secondBreakout', 'sectorLeader', 'sectorLadder', 'weakToStrong', 'marketEmotion', 'riskVeto'] };
  const ids = new Set(conditions.factors.map(item => item.id));
  for (const id of strategyOptions.filter(id => id !== 'riskVeto')) assert.ok(ids.has(id), id);
  assert.equal(ids.has('riskVeto'), false);
});

test('validation rejects unusable strategies with field-specific messages', () => {
  const check = (patch, field, message) => assert.throws(() => custom.normalizeCustomStrategy({ ...base, ...patch }, { patternIds }), error => error.field === field && message.test(error.message));
  check({ name: ' ' }, 'name', /名称/);
  check({ name: '名'.repeat(31) }, 'name', /30/);
  check({ conditions: [] }, 'conditions', /至少选择一个条件/);
  check({ conditions: [{ ref: 'factor:unknown' }] }, 'conditions', /无法识别/);
  check({ conditions: [{ ref: 'pattern:not_a_rule' }] }, 'conditions', /无法识别/);
  check({ filters: { minDaysSinceLimit: 9, maxDaysSinceLimit: 3 } }, 'filters.minDaysSinceLimit', /不能大于/);
  check({ filters: { minAmountYi: -1 } }, 'filters.minAmountYi', /之间/);
  check({ requiredAnyGroups: [['factor:support']] }, 'requiredAnyGroups', /两个以上/);
  check({ universe: 'whole_market' }, 'universe', /范围/);
  const ok = custom.normalizeCustomStrategy({ ...base, conditions: [...base.conditions, { ref: 'factor:support' }, { ref: 'pattern:low_first_board' }], filters: { boards: ['main', 'chinext', 'star', 'bse'] } }, { patternIds });
  assert.equal(ok.conditions.length, 3, 'duplicates merge');
  assert.equal(ok.conditions[0].required, true, 'a duplicate keeps the required flag');
  assert.equal(ok.filters.boards, undefined, 'all boards means no board filter');
  assert.equal(ok.minMatchPercent, 70);
});

test('legacy settings combinations migrate with their original 70% rate and named-preset requirements', () => {
  const steady = custom.legacyStrategyFromSettings(initialSelected);
  assert.equal(steady.name, '稳健趋势（由设置迁移）');
  assert.deepEqual(steady.conditions.filter(item => item.required).map(item => item.ref), ['factor:trend']);
  assert.equal(steady.minMatchPercent, 70); assert.equal(steady.origin, 'legacy-settings');
  const secondWave = custom.legacyStrategyFromSettings(['originBreakout', 'vcpCompression', 'chipLock', 'secondBreakout', 'support', 'riskVeto']);
  assert.deepEqual(secondWave.requiredAnyGroups, [['factor:vcpCompression', 'factor:secondBreakout']]);
  const free = custom.legacyStrategyFromSettings(['support', 'weakToStrong', 'riskVeto']);
  assert.equal(free.name, '我的自主组合（由设置迁移）');
  assert.equal(free.conditions.some(item => item.required), false);
  assert.equal(custom.legacyStrategyFromSettings(['riskVeto']), null);
  assert.doesNotThrow(() => custom.normalizeCustomStrategy({ ...steady, id: 'cs_legacy01' }, { patternIds }));
});

test('a migrated daily-only combination qualifies exactly when the 个股分析 rule does, day by day', () => {
  const { candidates, histories } = universe(12, 160, 21);
  for (const ids of [['support', 'avwap', 'trend', 'volatility'], ['originBreakout', 'vcpCompression', 'chipLock', 'secondBreakout', 'support'], ['weakToStrong', 'avwap', 'volatility', 'exactNode']]) {
    const migrated = { ...custom.legacyStrategyFromSettings([...ids, 'riskVeto']), id: 'cs_compat01' };
    const compiled = custom.compileCustomStrategy(custom.normalizeCustomStrategy(migrated, { patternIds }), { patternMatchers, patternNames });
    let compared = 0, qualified = 0;
    for (const { code, name } of candidates) {
      const rows = histories[code];
      for (let index = 70; index < rows.length; index += 3) {
        const feature = engine.__test.featureSnapshot(rows, index, code, name);
        if (!feature) continue;
        const legacy = legacyFactorSnapshot(rows, index, code, name);
        const results = ids.map(id => ({ id, matched: legacy.factors[id] }));
        const scoring = results.filter(item => item.id !== 'exactNode');
        const rate = Math.round(scoring.filter(item => item.matched).length / scoring.length * 100);
        const exactOk = !ids.includes('exactNode') || legacy.factors.exactNode;
        const expected = evaluateAnalysisPresetRequirements([...ids, 'riskVeto'], results).passed && rate >= 70 && legacy.factors.riskVeto && exactOk;
        assert.equal(compiled.evaluate(feature).passed, expected, `${ids.join('+')} ${code} ${rows[index].date}`);
        compared += 1; qualified += Number(expected);
      }
    }
    assert.ok(compared > 300, `compared ${compared}`);
    if (ids.length === 4 && ids[0] === 'support') assert.ok(qualified > 0, `${ids.join('+')} qualified ${qualified}`);
  }
});

test('external factors never block screening: they are reported as pending confirmation', () => {
  const strategy = custom.normalizeCustomStrategy({ ...base, conditions: [{ ref: 'factor:support', required: true }, { ref: 'factor:sectorLeader', required: true }], minMatchPercent: 100 }, { patternIds });
  const compiled = custom.compileCustomStrategy(strategy, { patternMatchers, patternNames });
  assert.equal(compiled.hasExternal, true);
  const feature = { legacyFactors: { hasEvent: true, daysSinceLimit: 4, factors: { riskVeto: true, support: true } } };
  const result = compiled.evaluate(feature);
  assert.equal(result.passed, true); assert.equal(result.needsConfirmation, true); assert.deepEqual(result.pending, ['板块龙头']);
  assert.equal(compiled.evaluate({ legacyFactors: { factors: { riskVeto: false, support: true } } }).blockedBy, '风险否决');
  assert.match(compiled.conditions.join(' '), /需个股数据：板块龙头/);
});

test('C2-02 watchlist scope does not veto a stock merely because it has no limit-up event', () => {
  const compile = (universe, conditions, options = {}) => custom.compileCustomStrategy(
    custom.normalizeCustomStrategy({ ...base, universe, conditions, minMatchPercent: 70 }, { patternIds: options.patternIds || patternIds }),
    { patternMatchers: options.patternMatchers || patternMatchers, patternNames }
  );
  const pool = compile('limit_pool', [{ ref: 'factor:trend' }]);
  const watch = compile('watchlist', [{ ref: 'factor:trend' }]);
  const noEvent = { legacyFactors: { hasEvent: false, daysSinceLimit: null, factors: { riskVeto: false, trend: false } } };
  const eventVetoed = { legacyFactors: { hasEvent: true, daysSinceLimit: 4, factors: { riskVeto: false, trend: true } } };
  const eventClean = { legacyFactors: { hasEvent: true, daysSinceLimit: 4, factors: { riskVeto: true, trend: true } } };

  // 无涨停事件：候选池范围（本身要求近期涨停）仍按风险否决拦截；
  // 自选与持仓范围不要求涨停，不能谎报「风险否决」，应如实报告条件未满足。
  assert.equal(pool.evaluate(noEvent).blockedBy, '风险否决');
  assert.equal(watch.evaluate(noEvent).blockedBy, '匹配比例不足');
  // 有涨停事件且风险项触发时，两个范围都照常否决。
  assert.equal(pool.evaluate(eventVetoed).blockedBy, '风险否决');
  assert.equal(watch.evaluate(eventVetoed).blockedBy, '风险否决');
  assert.equal(watch.evaluate(eventClean).passed, true);

  // 自选范围里只引用形态规则（不需要涨停事件）时，无涨停股票现在可以被正常选中。
  const patternWatch = compile('watchlist', [{ ref: 'pattern:demo_rule' }], {
    patternIds: new Set(['demo_rule']), patternMatchers: new Map([['demo_rule', () => true]])
  });
  assert.equal(patternWatch.evaluate(noEvent).passed, true);

  // 说明文案与判定口径一致。
  assert.match(pool.conditions.join(' '), /风险否决：始终启用/);
  assert.match(watch.conditions.join(' '), /本范围不要求近期涨停/);
});

test('numeric filters and board scope are enforced before conditions', () => {
  const strategy = custom.normalizeCustomStrategy({ ...base, conditions: [{ ref: 'factor:support' }], minMatchPercent: 0,
    filters: { minDaysSinceLimit: 2, maxDaysSinceLimit: 6, minAmountYi: 1, maxConsecutiveBoards: 2, excludeOnePriceToday: true, boards: ['chinext'] } }, { patternIds });
  const compiled = custom.compileCustomStrategy(strategy, { patternMatchers, patternNames });
  const feature = patch => ({ securityCode: '300001', latestAmount: 2e8, consecutiveBoards: 1, onePriceToday: false, eventLow: 10, latest: 11,
    legacyFactors: { daysSinceLimit: 4, factors: { riskVeto: true, support: true } }, ...patch });
  assert.equal(compiled.evaluate(feature({})).passed, true);
  assert.equal(compiled.evaluate(feature({ legacyFactors: { daysSinceLimit: 9, factors: { riskVeto: true, support: true } } })).blockedBy, '涨停后天数不在范围内');
  assert.equal(compiled.evaluate(feature({ latestAmount: 5e7 })).blockedBy, '成交额不足');
  assert.equal(compiled.evaluate(feature({ consecutiveBoards: 3 })).blockedBy, '连板数超过上限');
  assert.equal(compiled.evaluate(feature({ onePriceToday: true })).blockedBy, '当日一字涨停');
  assert.equal(compiled.evaluate(feature({ securityCode: '600001' })).blockedBy, '不在所选板块');
});

test('store saves, edits with revision, rejects duplicate names and deletes', () => {
  let ids = 0; const newId = () => `cs_fixed${String(++ids).padStart(3, '0')}`;
  let { store, strategy } = custom.saveCustomStrategyInStore(custom.emptyStore(), base, { patternIds, newId, now: new Date('2026-10-21T00:00:00Z') });
  assert.equal(strategy.id, 'cs_fixed001'); assert.equal(strategy.revision, 1);
  ({ store, strategy } = custom.saveCustomStrategyInStore(store, { ...strategy, name: '测试策略改', minMatchPercent: 80 }, { patternIds, newId, now: new Date('2026-10-22T00:00:00Z') }));
  assert.equal(store.strategies.length, 1); assert.equal(strategy.revision, 2); assert.equal(strategy.createdAt, '2026-10-21T00:00:00.000Z'); assert.equal(strategy.updatedAt, '2026-10-22T00:00:00.000Z');
  ({ store } = custom.saveCustomStrategyInStore(store, { ...base, id: undefined, name: '第二套' }, { patternIds, newId }));
  assert.throws(() => custom.saveCustomStrategyInStore(store, { ...base, id: undefined, name: '测试策略改' }, { patternIds, newId }), /同名/);
  store = custom.deleteCustomStrategyFromStore(store, 'cs_fixed001');
  assert.deepEqual(store.strategies.map(item => item.name), ['第二套']);
  assert.throws(() => custom.deleteCustomStrategyFromStore(store, 'cs_fixed001'), /不存在/);
  const loaded = custom.normalizeCustomStrategyStore({ strategies: [...store.strategies, { name: '坏数据' }, store.strategies[0]] }, { patternIds });
  assert.equal(loaded.strategies.length, 1); assert.equal(loaded.dropped, 2);
});

test('the selection engine runs saved custom strategies beside the built-in rules and isolates broken ones', () => {
  const { candidates, histories, benchmark } = universe(40, 200, 9);
  const options = { asOfDate: '2026-10-20', marketDates: calendar.sessionsThrough('2026-10-20', 120), minCurrentHistoryBars: 120 };
  const loose = { id: 'cs_loose001', name: '宽松测试', conditions: [{ ref: 'factor:support' }, { ref: 'factor:trend' }, { ref: 'factor:sector' }], minMatchPercent: 30 };
  const watch = { id: 'cs_watch001', name: '自选范围', universe: 'watchlist', conditions: [{ ref: 'factor:support' }] };
  const broken = { id: 'cs_broken01', name: '已失效', conditions: [{ ref: 'pattern:removed_rule' }] };
  const report = engine.buildStrategySelectionReport(candidates, histories, benchmark, { ...options, customStrategies: [loose, watch, broken] });
  const group = report.strategies.find(item => item.id === 'cs_loose001');
  assert.ok(group && group.custom && group.family === 'custom');
  assert.equal(report.strategies.some(item => item.id === 'cs_watch001'), false, 'other universes run separately');
  assert.match(report.strategies.find(item => item.id === 'cs_broken01').error, /无法识别/);
  assert.ok(group.stocks.length > 0, 'loose custom strategy selects synthetic stocks');
  for (const stock of group.stocks) { assert.ok(stock.matchRate >= 0); assert.equal(stock.needsConfirmation, stock.matchRate < 30, 'pending only matters when confirmed conditions alone fall short'); assert.deepEqual(stock.pendingConditions, ['强板块共振']); }
  assert.equal(report.strategies.filter(item => !item.custom).length, engine.STRATEGY_DEFINITIONS.length);
  const onlyWatch = engine.buildStrategySelectionReport(candidates, histories, benchmark, { ...options, includeBuiltIn: false, universe: 'watchlist', customStrategies: [loose, watch] });
  assert.deepEqual(onlyWatch.strategies.map(item => item.id), ['cs_watch001']);
});

test('the store migrates the settings combination exactly once and never resurrects it after deletion', () => {
  const { createCustomStrategyStore } = require('./custom-strategy-store.cjs');
  let file = null, writes = 0, n = 0;
  const store = createCustomStrategyStore({ read: () => file, write: value => { file = JSON.parse(JSON.stringify(value)); writes += 1; },
    loadLegacySelection: () => initialSelected, patternIds: () => patternIds, newId: () => `cs_store${String(++n).padStart(3, '0')}` });
  const first = store.list();
  assert.equal(first.length, 1); assert.equal(first[0].name, '稳健趋势（由设置迁移）'); assert.equal(file.migratedLegacy, true); assert.equal(writes, 1);
  store.list(); assert.equal(writes, 1, 'reading does not rewrite');
  store.remove(first[0].id);
  assert.deepEqual(store.list(), [], 'a deleted migration is not recreated');
  const imported = store.importLegacy();
  assert.equal(imported.strategy.name, '稳健趋势（设置导入）');
  assert.equal(store.importLegacy().strategy.name, '稳健趋势（设置导入）（2）');
  const edited = store.save({ ...imported.strategy, minMatchPercent: 85 });
  assert.equal(edited.strategy.revision, 2); assert.equal(edited.strategy.origin, 'legacy-settings');
  const emptySettings = createCustomStrategyStore({ read: () => null, write: () => {}, loadLegacySelection: () => ['riskVeto'], patternIds: () => patternIds });
  assert.deepEqual(emptySettings.list(), []);
});

test('the selection service runs watchlist-scoped strategies as a second pass over 自选 and 持仓 codes only', async () => {
  const { createStrategySelectionService } = require('./strategy-selection-service.cjs');
  const dates = calendar.sessionsThrough('2026-10-20', 120);
  const rows = dates.map(date => ({ date, open: 10, high: 11, low: 9, close: 10, volume: 100, amount: 1e6 }));
  const engineCalls = [], historyCalls = [];
  const service = createStrategySelectionService({ calendar, now: () => new Date('2026-10-21T02:00:00Z'),
    loadUniverse: async () => ({ rows: [{ code: '600001', name: '池内', secid: '1.600001' }], boards: [{ label: '沪市主板', expected: 1, loaded: 1, complete: true }] }),
    loadHistory: async security => { historyCalls.push(security.code); return rows; },
    runEngine: async (candidates, histories, _benchmark, options) => { engineCalls.push({ codes: candidates.map(item => item.code), histories: Object.keys(histories), options });
      return { mode: 'selection', strategies: (options.customStrategies || []).filter(item => (item.universe || 'limit_pool') === options.universe).map(item => ({ id: item.id, stocks: [] })), dataQuality: { processed: candidates.length } }; } });
  const watch = { id: 'cs_watch001', name: '自选', universe: 'watchlist', conditions: [{ ref: 'factor:support' }] };
  const pool = { id: 'cs_pool0001', name: '池', conditions: [{ ref: 'factor:support' }] };
  const report = await service.load({ customStrategies: [pool, watch], watchlistSecurities: [{ code: '600001', name: '池内' }, { code: '000002', name: '自选甲' }, { code: '600003', name: '*ST乙' }, { code: '000002', name: '重复' }] });
  assert.equal(engineCalls.length, 2);
  assert.equal(engineCalls[0].options.universe, 'limit_pool');
  assert.deepEqual(engineCalls[1].codes, ['600001', '000002'], 'ST and duplicate codes are skipped');
  assert.equal(engineCalls[1].options.includeBuiltIn, false);
  assert.equal(historyCalls.filter(code => code === '600001').length, 1, 'a code already loaded for the pool is not fetched twice');
  assert.deepEqual(report.strategies.map(item => item.id), ['cs_pool0001', 'cs_watch001']);
  const { requested, processed, failed, note } = report.watchlistCoverage;
  assert.deepEqual({ requested, processed, failed, note }, { requested: 2, processed: 2, failed: 0, note: '' });
});
