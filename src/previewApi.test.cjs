"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let restoreTypeScript;
let createPreviewApi;

before(() => {
  restoreTypeScript = registerTypeScript();
  ({ createPreviewApi } = require("./previewApi.ts"));
});

after(() => restoreTypeScript?.());

test("preview getChart matches the production rows contract", async () => {
  const chart = await createPreviewApi().getChart("600519", "101", {
    range: "3m",
    limit: 24,
    adjustment: "front"
  });

  assert.equal(chart.interval, "101");
  assert.equal(chart.range, "3m");
  assert.equal(chart.visibleLimit, 24);
  assert.equal(chart.adjustment, "前复权");
  assert.equal(chart.sourceClass, "preview");
  assert.equal(chart.dataSource, "preview");
  assert.equal(chart.isPartial, false);
  assert.equal(chart.rows.length, 24);
  assert.equal(chart.availableFrom, chart.rows[0].date);
  assert.equal(chart.availableTo, chart.rows.at(-1).date);
  assert.ok(Number.isFinite(Date.parse(chart.updatedAt)));
  assert.equal("history" in chart, false, "legacy history alias must not hide rows-only bugs");
  assert.equal("data" in chart, false, "legacy data alias must not hide rows-only bugs");
  assert.ok(chart.rows.every((row) =>
    /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
    [row.open, row.high, row.low, row.close, row.volume, row.amount].every(Number.isFinite) &&
    row.high >= Math.max(row.open, row.close) &&
    row.low <= Math.min(row.open, row.close)
  ));
});

test("preview API supplies coherent data for search, analysis, and review pages", async () => {
  const api = createPreviewApi();
  const matches = await api.search("600519");
  assert.deepEqual(matches.map((item) => item.code), ["600519"]);

  const analysis = await api.analyze(matches[0]);
  assert.equal(analysis.security.code, "600519");
  assert.equal(analysis.quote.code, "600519");
  assert.ok(Array.isArray(analysis.history) && analysis.history.length >= 120);
  assert.equal(analysis.actualProvider, "preview");
  assert.equal(analysis.analysis.tradeExecutionReadiness.canExecute, false);

  const review = await api.getProfessionalReview();
  assert.equal(Object.keys(review.dimensions).length, 8);
  assert.ok(Array.isArray(review.leaders) && review.leaders.length > 0);
  assert.match(review.methodology.name, /八维市场状态模型/);

  const snapshot = await api.getLimitUpPoolSnapshot();
  const legacyNamedSnapshot = await api.discoverLimitUps();
  assert.ok(Array.isArray(snapshot.rows));
  assert.deepEqual(snapshot.meta.providers, ["preview"]);
  assert.match(snapshot.meta.dataDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(legacyNamedSnapshot.rows, snapshot.rows);
  assert.deepEqual(legacyNamedSnapshot.meta.providers, snapshot.meta.providers);
  assert.equal(legacyNamedSnapshot.meta.dataDate, snapshot.meta.dataDate);
  assert.ok(Number.isFinite(Date.parse(legacyNamedSnapshot.meta.fetchedAt)));
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);

  const failedBoards = await api.getPreviousLimitUpFailedBoardSnapshot();
  assert.equal(failedBoards.failedBoardDays.length, 5);
  assert.equal(failedBoards.failedBoardDays[0].date, failedBoards.currentDate);
  assert.ok(failedBoards.failedBoardDays.every((day) => day.status === "ready" && day.rows.length === 1));
  assert.ok(failedBoards.failedBoardDays.every((day) => day.rows.every((row) => /^\d{6}$/.test(row.code))));
});

test("preview settings preserve the mandatory risk veto", async () => {
  const api = createPreviewApi();
  const saved = await api.saveSettings({
    ...(await api.getSettings()),
    selectedStrategies: ["trend"]
  });
  assert.deepEqual(saved.selectedStrategies, ["trend", "riskVeto"]);
  assert.deepEqual((await api.getSettings()).selectedStrategies, ["trend", "riskVeto"]);
});

test("preview A-share announcement feed honors the independent content contract", async () => {
  const api = createPreviewApi();
  const feed = await api.getNewsFeed({ contentType: "announcement", scope: "all" });

  assert.equal(feed.total, 2);
  assert.ok(feed.items.every((item) => item.type === "announcement"));
  assert.ok(feed.items.every((item) => item.eventType && item.sourceLevel && item.status));
  assert.deepEqual(
    feed.sourceStatus.filter((source) => ["announcement", "ths"].includes(source.id)).map((source) => source.id),
    ["announcement", "ths"]
  );

  const holding = feed.items[0].relatedStocks[0];
  const holdingFeed = await api.refreshNewsFeed({
    contentType: "announcement",
    scope: "holdings",
    holdings: [{ ...holding, shares: 100, costPrice: 1 }]
  });
  assert.deepEqual(holdingFeed.items.map((item) => item.relatedStocks[0].code), [holding.code]);
});

test('preview exposes the same versioned combinations without publishing invented evidence', async () => {
  const api = createPreviewApi();
  const catalog = require('../config/strategy-signal-combinations.json');
  const definitions = await api.getStrategyDefinitions();
  assert.equal(definitions.length, require("../electron/strategy-signal-engine.cjs").ALL_STRATEGY_DEFINITIONS.length);
  const report = await api.scanStrategySignals();
  // 与桌面一致：目录含已下线策略（retired），选股只跑在用策略。
  const live = definitions.filter(item => !item.retired);
  assert.equal(report.compositeStrategyCount, live.filter(item => item.type === 'composite').length);
  assert.equal(report.mode, 'selection');
  assert.equal(report.strategies.filter(item => !item.custom).length, live.length);
  assert.equal(live.length, require("../electron/strategy-signal-engine.cjs").STRATEGY_DEFINITIONS.length);
  assert.ok(report.strategies.some(item => item.custom && item.id === 'cs_preview01'), 'preview includes the demo custom strategy');
  assert.equal('optimizedPortfolio' in report, false);
  for (const entry of catalog) {
    const definition = definitions.find(item => item.id === entry.id);
    assert.equal(definition?.version, entry.version);
    assert.deepEqual(definition.parameters, entry.parameters);
    const audited = report.strategies.find(item => item.id === entry.id);
    if (definition.retired) { assert.equal(audited, undefined, `${entry.id} is retired from selection`); continue; }
    assert.equal("validation" in audited, false);
    assert.equal("publicationAccepted" in audited, false);
    assert.equal(audited.stocks.length, 0);
  }
});

test('browser strategy metadata stays identical to the current Electron rule definitions', async()=>{
  const expected=require('../electron/strategy-signal-engine.cjs').ALL_STRATEGY_DEFINITIONS;
  const actual=await createPreviewApi().getStrategyDefinitions();
  assert.equal(actual.length,expected.length);
  for(const definition of expected){const item=actual.find(x=>x.id===definition.id);assert.equal(item.name,definition.name);assert.equal(item.version,definition.version);assert.equal(item.family,definition.family);}
});

test("preview API exposes stubs for rotation, factor screen, alert rules, industries, feeds and signals", async () => {
  const api = createPreviewApi();
  const industries = await api.getStockIndustries(["600519", "999999"]);
  assert.deepEqual(industries, { "600519": "白酒" });

  const rot = await api.getEtfRotation({ lookback: 40, topN: 99, rebalance: "monthly" });
  assert.equal(rot.config.lookback, 40);
  assert.equal(rot.config.topN, rot.config.pool.length);
  assert.equal(rot.config.rebalance, "monthly");

  const screen = await api.screenFactors({ strategyId: "blue_chip_value" });
  assert.equal(screen.strategy.id, "blue_chip_value");
  assert.equal(screen.picks.length, 0);

  const savedRules = await api.alertRules({ op: "save", rule: { type: "cci", scope: "watchlist", code: "", params: { direction: "below", period: 14, threshold: -100 }, cooldownHours: 0, enabled: true } });
  assert.equal(savedRules.rules.length, 1);
  assert.equal(savedRules.rules[0].cooldownHours, 0);
  const removedRules = await api.alertRules({ op: "remove", id: savedRules.rules[0].id });
  assert.equal(removedRules.rules.length, 0);

  const savedFeeds = await api.ai.agent.feeds({ op: "save", name: "测试源", url: "https://example.com/rss.xml" });
  assert.equal(savedFeeds.feeds.length, 1);
  const removedFeeds = await api.ai.agent.feeds({ op: "remove", id: savedFeeds.feeds[0].id });
  assert.equal(removedFeeds.feeds.length, 0);

  const sigs = await api.ai.agent.signals({ evaluate: true });
  assert.deepEqual(sigs.signals, []);
  const updatedSigs = await api.ai.agent.updateSignal({ id: "missing", remove: true });
  assert.deepEqual(updatedSigs.signals, []);
});
