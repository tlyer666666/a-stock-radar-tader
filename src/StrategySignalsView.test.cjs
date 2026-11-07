"use strict";
const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
let restore, view;
before(() => { restore = registerTypeScript(); view = require("./StrategySignalsView.tsx"); });
after(() => restore?.());
test("signal reports retain the new source version and named component contract", () => {
  const { buildStrategySignalReport } = require("../electron/strategy-signal-engine.cjs");
  const report = view.normalizeSignalReport(buildStrategySignalReport());
  const combo = report.strategies.find(item => item.id === "limit_boll_breakout_resonance");
  assert.equal(combo.version, require("../config/strategy-signal-combinations.json").find(item => item.id === combo.id).version);
  assert.equal(combo.sources.length, 2);
  assert.equal(combo.componentNames.length, 3);
  assert.equal(combo.parameters.widthLookback, 60);
  assert.equal(typeof combo.adaptationNote, "string");
});
test("sources render as official provenance with fixed parameters and no fabricated performance claim", () => {
  const group = require("../config/strategy-signal-combinations.json")[0];
  const html = renderToStaticMarkup(React.createElement(view.StrategyRuleSources, { group }));
  assert.match(html, /公式来源与适配/);
  assert.match(html, /通达信公式系统/);
  assert.match(html, /同花顺股民学校/);
  assert.match(html, /固定参数/);
  assert.ok(html.includes(group.version));
  assert.doesNotMatch(html, /回测收益/);
});

test("selection metadata retains completed data day, universe coverage and rule requirements without analytics", () => {
  const report = view.normalizeSignalReport({
    generatedAt: "2026-10-21T02:00:00Z", asOfDate: "2026-10-20",
    universeCoverage: { boards: [{ label: "北交所", expected: 270, loaded: 200, complete: false }], listed: 5400, eligible: 5200, excludedRisk: 150, failed: 1, requestsComplete: false, complete: false },
    dataQuality: { requested: 300, processed: 297, invalid: 1, stale: 1, missing: 1, excluded: 5,
      benchmarkReady: false, calendarState: "ready", reasons: { stale_stock: 1 } },
    strategies: [{ id: "relative", name: "相对强势回踩", family: "pullback", detail: "回踩后收回均线",
      conditions: ["收回MA10"], dataRequirements: ["完整120根日线"], scope: "近期涨停候选池",
      evidenceLevel: "技术规则候选", stocks: [{ code: "600001", signalDate: "2026-10-20", signalStrength: 71 }],
      validation: { accepted: false } }], validation: { accepted: false }
  });
  assert.equal(report.asOfDate, "2026-10-20");
  assert.deepEqual(report.universeCoverage, { boards: [{ label: "北交所", expected: 270, loaded: 200, complete: false }], listed: 5400, eligible: 5200, excludedRisk: 150, failed: 1, requestsComplete: false, complete: false });
  assert.equal(report.dataQuality.stale, 1);
  assert.equal(report.dataQuality.benchmarkReady, false);
  assert.deepEqual(report.dataQuality.reasons, { stale_stock: 1 });
  assert.equal(report.strategies[0].family, "pullback");
  assert.deepEqual(report.strategies[0].conditions, ["收回MA10"]);
  assert.deepEqual(report.strategies[0].dataRequirements, ["完整120根日线"]);
  assert.equal(report.strategies[0].scope, "近期涨停候选池");
  assert.equal(report.strategies[0].evidenceLevel, "技术规则候选");
  assert.equal(report.strategies[0].stocks.length, 1);
  assert.equal(Object.hasOwn(report, "validation"), false);
  assert.equal(Object.hasOwn(report.strategies[0], "validation"), false);
});

test("family filtering keeps only the requested shapes and sorts picks without changing rule membership", () => {
  const groups = [
    { id: "first", name: "首板", detail: "量价", family: "first_board", stocks: [{ code: "600001" }] },
    { id: "pullback-small", name: "回踩甲", family: "pullback", stocks: [] },
    { id: "pullback-large", name: "回踩乙", family: "pullback", stocks: [{ code: "600002" }, { code: "600003" }] }
  ];
  assert.deepEqual(view.filterSignalGroups(groups, "", "picks", "pullback").map(row => row.id), ["pullback-large", "pullback-small"]);
  assert.deepEqual(view.filterSignalGroups(groups, "量价", "catalog", "all").map(row => row.id), ["first"]);
  assert.equal(groups[0].id, "first");
  assert.equal(view.filterSignalGroups(groups, "不存在", "catalog", "all").length, 0);
});

test("rule details disclose conditions, data requirements and scope independently of the stock list", () => {
  const group = { id: "sample", name: "示例", detail: "回踩后收回均线", family: "pullback", stocks: [],
    version: "1.1.0", conditions: ["收盘收回MA10"], dataRequirements: ["完整120根日线"],
    scope: "最近16个完整交易日候选池", evidenceLevel: "技术规则候选", parameters: { period: 20 }, sources: [] };
  const html = renderToStaticMarkup(React.createElement(view.StrategySelectionRules, { group }));
  assert.match(html, /<summary>选股条件<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /收盘收回MA10/);
  assert.match(html, /完整120根日线/);
  assert.match(html, /最近16个完整交易日候选池/);
  assert.match(html, /固定参数/);
  assert.match(html, /period：20/);
  assert.doesNotMatch(html, /<button|回测|发订单/);
});

test("coverage distinguishes the completed data day from refresh time and labels cached results", () => {
  const report = view.normalizeSignalReport({ generatedAt: "2026-10-21T02:00:00Z", asOfDate: "2026-10-20",
    universeCoverage: { boards: [{ label: "沪市主板", expected: 1700, loaded: 1700, complete: true }, { label: "北交所", expected: 270, loaded: 200, complete: false }], failed: 1, requestsComplete: false, complete: false },
    dataQuality: { requested: 5200, processed: 5100, invalid: 0, stale: 1, missing: 0, excluded: 0, benchmarkReady: false, calendarState: "ready", reasons: {} },
    availableUniverseSize: 5200, universeSize: 5200, processed: 5100, failed: 3, strategies: [] });
  const html = renderToStaticMarkup(React.createElement(view.StrategySelectionCoverage, { report, previous: true }));
  assert.match(html, /上轮数据日：2026-10-20/);
  assert.match(html, /更新时间：/);
  assert.match(html, /全市场A股/);
  assert.match(html, /剔除 ST/);
  assert.match(html, /北交所 200（不完整）/);
  assert.match(html, /共 5200 只，已完成计算 5100 只/);
  assert.match(html, /部分板块股票名单读取不完整/);
  assert.match(html, /3 只股票日线读取失败/);
  assert.doesNotMatch(html, /行情陈旧/, "full-market stale/new listings are disclosed in notes, not alarms");
  assert.match(html, /基准行情未就绪/);
  assert.doesNotMatch(html, /最近 11|32 套/);
});

test("malformed source dates remain unknown without crashing the selection renderer", () => {
  const report = view.normalizeSignalReport({ asOfDate: "2026-99-99", generatedAt: "bad-source-time",
    universeCoverage: { boards: "bad", failed: -1 }, strategies: [] });
  assert.equal(report.asOfDate, undefined);
  assert.deepEqual(report.universeCoverage.boards, []);
  assert.equal(report.universeCoverage.failed, undefined);
  const html = renderToStaticMarkup(React.createElement(view.StrategySelectionCoverage, { report }));
  assert.match(html, /数据日：未提供/);
  assert.match(html, /更新时间：未提供/);
});

test("default strategy selection uses stock count without validation priority", () => {
  const groups = [
    { id: "empty-published", type: "base", validation: { accepted: true }, stocks: [] },
    { id: "research-small", type: "base", validation: { accepted: false }, stocks: [{ code: "600001" }] },
    { id: "research-large", type: "base", validation: { accepted: false }, stocks: [{ code: "600002" }, { code: "600003" }] },
    { id: "published", type: "base", validation: { accepted: true }, stocks: [{ code: "600004" }] }
  ];

  assert.equal(view.defaultStrategyId(groups), "research-large");
  assert.equal(view.defaultStrategyId(groups.slice(0, 3)), "research-large");
});

test("every rule match is shown as a picked stock without a verification gate", () => {
  const group = {
    id: "low-first-board",
    name: "低位首板",
    validation: { accepted: false, status: "INSUFFICIENT", sampleCount: 32, minimumSamples: 120 },
    stocks: [{ code: "600001", name: "示例股份" }]
  };

  const display = view.strategyStockDisplayModel(group);

  assert.equal(display.title, "本策略选出的股票");
  assert.match(display.subtitle, /选出 1 只/);
  assert.doesNotMatch(display.subtitle, /未验证|发布门槛|仅用于研究/);
  assert.equal(display.stocks[0].code, "600001");
  const html = renderToStaticMarkup(React.createElement(view.StrategyStockPanel, {
    group, strategyNames: new Map(), onOpen() {}, onOpenBacktest() {}
  }));
  assert.match(html, /示例股份/);
  assert.doesNotMatch(html, /未验证/);
});

test('strategy candidate panel renders twenty rows per page without hiding the total', () => {
  const group = { id: 'sample', name: '示例策略', validation: { accepted: false, status: 'INSUFFICIENT' }, stocks: Array.from({ length: 45 }, (_, i) => ({ code: String(600000 + i), name: `候选${String(i).padStart(3, '0')}` })) };
  const html = renderToStaticMarkup(React.createElement(view.StrategyStockPanel, { group, strategyNames: new Map(), onOpen() {}, onOpenBacktest() {} }));
  assert.match(html, /候选000/);
  assert.match(html, /候选019/);
  assert.doesNotMatch(html, /候选020/);
  assert.match(html, /共 45 只/);
  assert.match(html, /下一页/);
});

test('selection list contains no validation, backtest, review or analysis actions', () => {
  const group = { id: 'sample', name: '规则选股', stocks: [{ code: '600001', name: '选中股份', signalDate: '2026-10-20' }] };
  const html = renderToStaticMarkup(React.createElement(view.StrategyStockPanel, { group, strategyNames: new Map(), onOpen() {}, onOpenBacktest() {} }));
  assert.match(html, /选中股份/);
  assert.doesNotMatch(html, /回测|复盘|验证|策略依据|信号质量|风险检查/);
  assert.match(html, /2026-10-20/);
});
test('a complete full-market universe shows no coverage alarm and keeps standing notes as plain disclosures',()=>{
 const report=view.normalizeSignalReport({asOfDate:'2026-10-20',universeSize:5200,processed:5000,universeCoverage:{boards:[],failed:0,requestsComplete:true,complete:true},notes:['已剔除ST、*ST与退市整理股票150只。'],strategies:[]});
 const html=renderToStaticMarkup(React.createElement(view.StrategySelectionCoverage,{report}));
 assert.doesNotMatch(html,/warning-banner/);assert.match(html,/已剔除ST/);assert.doesNotMatch(html,/涨停池|300 只/);
});

test('stock summary de-duplicates same-family strategies and ranks by distinct families', () => {
  const groups = [
    { id: 'p1', name: '回踩一', family: 'pullback', stocks: [{ code: '600001', name: '甲', signalStrength: 70 }, { code: '600002', name: '乙', signalStrength: 90 }] },
    { id: 'p2', name: '回踩二', family: 'pullback', stocks: [{ code: '600002', name: '乙', signalStrength: 80 }] },
    { id: 'b1', name: '突破一', family: 'breakout', stocks: [{ code: '600001', name: '甲', signalStrength: 75 }] }
  ];
  const rows = view.summarizeStocksAcrossStrategies(groups);
  assert.deepEqual(rows.map(row => [row.code, row.familyCount, row.strategies.length, row.signalStrength]), [['600001', 2, 2, 75], ['600002', 1, 2, 90]]);
  const html = renderToStaticMarkup(React.createElement(view.StrategyStockSummaryPanel, { groups, onOpen() {} }));
  assert.match(html, /按股票汇总/); assert.match(html, /回踩一/); assert.match(html, /2 类/);
});

test('stock summary puts stocks hit by featured strategies first', () => {
  const groups = [
    { id: 'p1', name: '回踩一', family: 'pullback', stocks: [{ code: '600001', name: '甲', signalStrength: 70 }] },
    { id: 'b1', name: '突破一', family: 'breakout', stocks: [{ code: '600001', name: '甲', signalStrength: 75 }] },
    { id: 'f1', name: '精选一', family: 'bottom_trend', featured: true, stocks: [{ code: '600009', name: '丙', signalStrength: 60 }] }
  ];
  const rows = view.summarizeStocksAcrossStrategies(groups);
  assert.deepEqual(rows.map(row => [row.code, row.featuredCount, row.familyCount]), [['600009', 1, 1], ['600001', 0, 2]]);
});

test('picked rows show limit age, ranking score and next-session cautions and are keyboard reachable when opening is available', () => {
  const report = view.normalizeSignalReport({ strategies: [{ id: 's', name: '示例', stocks: [{ code: '000001', name: '平安', limitDate: '2026-10-15', daysSinceLimit: 3, signalStrength: 82,
    latest: 10, invalidationPrice: 9.5, reasons: ['MA10回踩'], executionNotes: ['今日涨停：次日看竞价，高开过多不宜追'] }] }] });
  const stock = report.strategies[0].stocks[0];
  assert.equal(stock.secid, '0.000001');
  const html = renderToStaticMarkup(React.createElement(view.StrategyStockPanel, { group: report.strategies[0], onOpen() {} }));
  assert.match(html, /2026-10-15 · T\+3/); assert.match(html, /失效位 9\.50（较选股收盘 -5\.0%）/); assert.match(html, />82</); assert.match(html, /MA10回踩/); assert.match(html, /次日看竞价/);
  assert.match(html, /<button type="button" class="strategy-security-link" aria-label="查看 平安 000001 个股分析">/, 'the stock name is a real keyboard-reachable button');
  const passive = renderToStaticMarkup(React.createElement(view.StrategyStockPanel, { group: report.strategies[0] }));
  assert.doesNotMatch(passive, /strategy-security-link/);
});

test('hidden-empty keeps the active strategy and selection pages render no historical statistics', () => {
  const groups = [{ id: 'few', name: '少', stocks: [] }, { id: 'weak', name: '弱', stocks: [{ code: '600001' }] }, { id: 'good', name: '好', stocks: [] }];
  assert.deepEqual(view.filterSignalGroups(groups, '', 'catalog', 'all', true).map(g => g.id), ['weak']);
  assert.deepEqual(view.filterSignalGroups(groups, '', 'catalog', 'all', true, 'good').map(g => g.id), ['weak', 'good']);
  const report = view.normalizeSignalReport({ historicalReview: { method: '次日开盘买入' }, strategies: [{ id: 'a', name: '甲', history: { sampleCount: 9 }, fieldEvidence: { verdict: { level: 'weak' } }, stocks: [] }] });
  assert.equal(report.historicalReview, undefined);
  assert.equal(report.strategies[0].history, undefined);
  assert.equal(view.StrategyHistoryCard, undefined, 'no historical reference card on the selection page');
});

test('strategy and stock summary distinguish live quote cells from their unchanged selection close', () => {
  const group = { id: 'close', name: '收盘示例', stocks: [{ code: '600001', name: '示例股份', latest: 10.12, changePct: 1.23 }] };
  for (const [Component, props] of [[view.StrategyStockPanel, { group }], [view.StrategyStockSummaryPanel, { groups: [group] }]]) {
    const html = renderToStaticMarkup(React.createElement(Component, props));
    assert.match(html, /<th scope="col">行情 \/ 换手 \/ 成交额<\/th>/);
    assert.match(html, /选股收盘 10\.12/);
    assert.match(html, /换手 --.*成交额 --/);
    assert.doesNotMatch(html, />10\.12<\/b>/, "selection close is never the live latest price");
  }
});

test('次日注意 is shown in full on its own row spanning the whole table, so no column gets cut off', () => {
  const group = { id: 'close', name: '收盘示例', stocks: [{ code: '600001', name: '示例股份', latest: 10.12, changePct: 1.23, needsConfirmation: true, pendingConditions: ['竞价站稳10日线'], executionNotes: ['跌破失效位离场'] }] };
  for (const [Component, props] of [[view.StrategyStockPanel, { group }], [view.StrategyStockSummaryPanel, { groups: [group] }]]) {
    const html = renderToStaticMarkup(React.createElement(Component, props));
    assert.equal((html.match(/<th scope="col">/g) || []).length, 5, 'five compact columns');
    assert.match(html, /<tr class="strategy-notes-row"><td colSpan="5" class="strategy-stock-notes[^"]*"><b>次日注意<\/b>待确认：竞价站稳10日线；跌破失效位离场<\/td><\/tr>/);
  }
});

test('full-market history failures remain data gaps while explicit eligibility exclusions stay ready', () => {
  const { selectionDataState } = require('./strategySelectionDataState.ts');
  for (const field of ['invalid', 'stale', 'missing']) {
    const quality = { requested: 2, processed: 0, [field]: 2, excluded: 0, benchmarkReady: true };
    const report = view.normalizeSignalReport({ universeSize: 2, processed: 0, failed: 0, dataQuality: quality });
    assert.equal(selectionDataState(report).state, 'unavailable', field);
    assert.equal(selectionDataState({ ...report, processed: 1 }).state, 'partial', field);
  }
  assert.equal(selectionDataState(view.normalizeSignalReport({ universeSize: 2, processed: 0, dataQuality: { excluded: 2, invalid: 0, stale: 0, missing: 0, benchmarkReady: true } })).state, 'ready');
});


test('coverage visibly distinguishes invalid histories from stable exclusions', () => {
  const input = { universeSize: 2, processed: 1, dataQuality: { invalid: 1, stale: 0, missing: 0, excluded: 0 }, strategies: [] };
  const html = renderToStaticMarkup(React.createElement(view.StrategySelectionCoverage, {report:view.normalizeSignalReport(input)}));
  assert.match(html, /1 只股票日线无效/);
  const excluded = renderToStaticMarkup(React.createElement(view.StrategySelectionCoverage, {report:view.normalizeSignalReport({...input,dataQuality:{excluded:1}})}));
  assert.doesNotMatch(excluded, /warning-banner/);
});

test('untrusted cache expiry values cannot reach date formatting or imply long validity', () => {
  for (const value of [undefined, '', false, -1, 0, Infinity, 1e20]) assert.equal(view.normalizeSignalReport({cacheValidUntil:value}).cacheValidUntil, undefined);
  assert.equal(view.normalizeSignalReport({cacheValidUntil:null}).cacheValidUntil,null);
});
