"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./strategy-signal-engine.cjs");
const { enrichStrategySignalReport } = require("./services.cjs");
const ids = ["limit_macd_pullback_resonance", "limit_boll_breakout_resonance", "limit_obv_breakout_resonance",
  "limit_dmi_reclaim_resonance", "limit_kdj_dryup_resonance", "limit_gap_ma_resonance"];
const seeds = [127, 1602, 570, 7, 51, 3];

// Fictional, reproducible OHLCV paths. The seed fixes market data, not a match flag.
function fixture(seed) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const cents = value => Math.round(value * 100) / 100;
  const history = [], wave = .1 + random() * .9;
  for (let index = 0; index < 300; index++) {
    let close = cents(10 + index * .012 + Math.sin(index / 5) * wave);
    if (index >= 260) close = cents(12.6 + (index - 260) * .016 + (random() - .5) * wave * 2);
    if (index === 291) close = cents(history[index - 1].close * 1.1);
    if (index > 291) close = cents(history[291].close - .15 + (random() - .35) * wave * 1.4);
    let open = cents(close - .02), high = cents(close + .08 + random() * .2), low = cents(close - .15 - random() * .2);
    if (index === 291) { open = cents(history[index - 1].close * 1.025); low = cents(open - .02); high = close; }
    let volume = 8000000 + Math.floor(random() * 1000000);
    if (index === 291) volume = 16000000;
    if (index === 299) volume = 9000000;
    history.push({ date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10), open, high, low, close, volume, amount: 300000000 });
  }
  const benchmark = history.map(({ date }) => ({ date, open: 100, close: 100, high: 101, low: 99, volume: 1, amount: 1 }));
  return { history, benchmark, security: { code: "600001", secid: "1.600001", name: "固定虚构样本" } };
}
function reportFor(input) {
  return engine.buildStrategySignalReport([input.security], { [input.security.code]: input.history }, input.benchmark,
    { generatedAt: "2026-09-30T08:00:00Z" });
}

test("six sourced combinations extend the original fourteen bases and four composites", () => {
  const report = engine.buildStrategySignalReport();
  assert.equal(report.strategies.length, 32);
  assert.equal(report.strategies.filter(item => item.type === "base").length, 14);
  assert.equal(report.strategies.filter(item => item.type === "composite").length, 18);
  const catalog = require("../config/strategy-signal-combinations.json");
  assert.deepEqual(catalog.slice(0, 6).map(item => item.id), ids);
  for (const id of ids) {
    const item = report.strategies.find(item => item.id === id);
    assert.equal(item.version, "1.0.0");
    assert.equal(item.type, "composite");
    assert.ok(item.sources.length >= 2);
    assert.ok(item.sources.every(source => /^https:\/\/(help\.tdx\.com\.cn|search\.10jqka\.com\.cn)\//.test(source.url)));
    assert.ok(Object.keys(item.parameters).length > 2);
    assert.match(item.adaptationNote, /自定义|适配/);
    assert.equal(item.validation.accepted, false);
  }
});

for (const [index, id] of ids.entries()) {
  test(`${id} combines its shape and real price-volume indicator confirmation`, () => {
    const input = fixture(seeds[index]);
    const group = reportFor(input).strategies.find(item => item.id === id);
    assert.ok(group, "new combination must exist");
    assert.equal(group.stocks.length, 1, JSON.stringify(group));
    const stock = group.stocks[0];
    assert.equal(stock.signalEvidence.limit.date, input.history[291].date);
    assert.equal(stock.signalEvidence.limit.rate, .1);
    assert.equal(stock.signalEvidence.limit.source, "calculated_board_rule");
    assert.equal(stock.signalEvidence.limit.upperLimit, input.history[291].close);
    assert.ok(stock.componentEvidence.length >= 2);
    assert.ok(stock.componentEvidence.every(item => item.passed));
    assert.ok(Object.values(stock.signalEvidence.indicators).every(Number.isFinite));
    const definition = engine.STRATEGY_DEFINITIONS.find(item => item.id === id);
    const feature = engine.__test.buildFeatureTimeline(input.history, input.security.code, input.security.name, input.benchmark).at(-1);
    assert.equal(definition.matches(feature), true);
    for (const atom of ["shape", "confirmation"]) {
      const copy = structuredClone(feature);
      copy.signalCombinations.matches[id][atom] = false;
      assert.equal(definition.matches(copy), false, `${atom} is mandatory`);
    }
    const replay = engine.buildSelectedStrategyReplay([id], input.security, input.history, input.benchmark);
    assert.ok(replay.matchedSignalCount > 0);
    assert.equal(replay.version, "1.0.0");
  });
}

test("new combinations are prefix-causal and cannot be forced by external analysis flags", () => {
  const input = fixture(127);
  const original = engine.__test.buildFeatureTimeline(input.history, "600001", "样本", input.benchmark)[299];
  input.history.push({ ...input.history.at(-1), date: "2030-01-01", open: 100, close: 100, high: 101, low: 99 });
  input.benchmark.push({ ...input.benchmark.at(-1), date: "2030-01-01", close: 50, low: 49 });
  assert.deepEqual(engine.__test.buildFeatureTimeline(input.history, "600001", "样本", input.benchmark)[299], original);
  const candidate = { ...input.security, analysis: { signalCombinations: original.signalCombinations, riskVeto: true }, signalCombinations: original.signalCombinations };
  const report = engine.buildStrategySignalReport([candidate]);
  assert.ok(report.strategies.filter(item => ids.includes(item.id)).every(item => item.stocks.length === 0));
});

test("missing volume amount calendar or explicit risk state cannot pass the new common gates", () => {
  for (const mutate of [
    input => { input.history[298].volume = null; },
    input => { input.history[298].amount = 0; },
    input => { input.history.splice(240, 1); },
    input => { input.benchmark = []; },
    input => { input.history[291].noPriceLimit = true; },
    input => { input.history[291].isST = true; },
    input => { input.security.name = "*ST样本"; },
    input => { input.security.isST = true; }
  ]) {
    const input = fixture(127); mutate(input);
    const report = reportFor(input);
    assert.ok(report.strategies.filter(item => ids.includes(item.id)).every(item => item.stocks.length === 0));
  }
});

test("limit evidence uses board-specific rounding and never treats an arbitrary 10% rise as a STAR or Beijing limit", () => {
  const { limitEvidenceAt } = require("./strategy-signal-combinations.cjs");
  for (const [code, rate] of [["600001", .1], ["300001", .2], ["302132", .2], ["688001", .2], ["920001", .3]]) {
    const previous = { date: "2026-09-29", close: 10.03 };
    const upper = Math.round(previous.close * (1 + rate) * 100) / 100;
    const current = { date: "2026-09-30", close: upper, high: upper };
    assert.equal(limitEvidenceAt([previous, current], 1, code, "样本").upperLimit, upper);
    assert.equal(limitEvidenceAt([previous, current], 1, code, "样本").rate, rate);
    if (rate > .1) assert.equal(limitEvidenceAt([previous, { ...current, close: 11.03, high: 11.03 }], 1, code, "样本"), null);
    assert.equal(limitEvidenceAt([previous, { ...current, noPriceLimit: true }], 1, code, "样本"), null);
    assert.equal(limitEvidenceAt([previous, { ...current, close: upper + .02, high: upper + .02 }], 1, code, "样本"), null);
  }
});

test("302 signal features require 20 percent rather than a main-board ten-percent event", () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ date: new Date(Date.UTC(2026, 5, i + 1)).toISOString().slice(0, 10), open: 10, high: 10.1, low: 9.9, close: 10, volume: 1000000, amount: 300000000 }));
  const feature = () => engine.__test.featureSnapshot(rows, 79, "302132", "合成样本");
  Object.assign(rows[79], { open: 10, high: 11, close: 11 });
  assert.equal(feature().eventDate, "");
  Object.assign(rows[79], { high: 12, close: 12 });
  assert.equal(feature().eventDate, rows[79].date);
});

test("pre-reform ChiNext shape and new common evidence agree causally on ten-percent events", () => {
  const input = fixture(127);
  input.security.code = "300001"; input.security.secid = "0.300001";
  input.history.forEach((row, index) => { row.date = new Date(Date.UTC(2019, 0, index + 1)).toISOString().slice(0, 10); input.benchmark[index].date = row.date; });
  const timeline = () => engine.__test.buildFeatureTimeline(input.history, input.security.code, input.security.name, input.benchmark);
  const feature = timeline().at(-1);
  assert.equal(feature.eventDate, input.history[291].date);
  assert.equal(feature.signalCombinations.limit.rate, .1);
  assert.equal(feature.signalCombinations.common, true);
  assert.equal(engine.STRATEGY_DEFINITIONS.find(row => row.id === ids[0]).matches(feature), true);
  input.history.push({ ...input.history.at(-1), date: "2026-09-30", close: 99, high: 100 });
  input.benchmark.push({ ...input.benchmark.at(-1), date: "2026-09-30" });
  assert.deepEqual(timeline()[299], feature);
  const missingDate = fixture(127).history;
  missingDate[291].date = undefined;
  assert.equal(engine.__test.featureSnapshot(missingDate, 299, "300001", "合成样本").eventDate, "");
});

test("new source metadata survives the worker/service audit while insufficient evidence remains unpublished", async () => {
  const { buildStrategySignalReportInWorker } = require("./services.cjs");
  const engineReport = await buildStrategySignalReportInWorker([], {}, [], {});
  const report = enrichStrategySignalReport(engineReport, [], {});
  for (const id of ids) {
    const audited = report.auditedStrategies.find(item => item.id === id);
    const summary = report.strategyAudit.find(item => item.id === id);
    assert.equal(audited.version, "1.0.0");
    assert.deepEqual(audited.sources, summary.sources);
    assert.equal(audited.publicationAccepted, false);
    assert.equal(report.strategies.some(item => item.id === id), false);
  }
});

test("new combination metadata and signals also flow through multi-stock selected replay", () => {
  const input = fixture(127);
  const report = engine.buildSelectedStrategyPortfolioReplay([ids[0]], [input.security],
    { [input.security.code]: input.history }, input.benchmark);
  assert.equal(report.version, "1.0.0");
  assert.equal(report.sources.length, 2);
  assert.ok(report.matchedSignalCount > 0);
});

module.exports = { fixture, ids, seeds };

const expansionIds = ['limit_rsi_pullback_resonance','limit_cci_breakout_resonance','limit_roc_reclaim_resonance','limit_emv_dryup_resonance','limit_mfi_pullback_resonance','limit_donchian_breakout_resonance','limit_rsi_mfi_resonance','limit_cci_roc_resonance'];
test('v1.4 expands to 32 signals with eight separately identified indicator combinations',()=>{
 const report=engine.buildStrategySignalReport();assert.equal(report.strategies.length,32);
 assert.equal(report.strategies.filter(row=>row.type==='base').length,14);
 assert.equal(report.strategies.filter(row=>row.type==='composite').length,18);
 const catalog=require('../config/strategy-signal-combinations.json');assert.deepEqual(catalog.slice(6).map(row=>row.id),expansionIds);
 const input=fixture(127);const feature=engine.__test.buildFeatureTimeline(input.history,input.security.code,input.security.name,input.benchmark).at(-1);
 for(const id of expansionIds){assert.equal(typeof feature.signalCombinations.matches[id].shape,'boolean');assert.equal(typeof feature.signalCombinations.matches[id].confirmation,'boolean');}
});

const expansionSeeds=[3,570,341,5,3,570,7,544];
for(const [index,id] of expansionIds.entries()){
 test(`${id} has a causal OHLCV positive and cannot bypass any required component`,()=>{
  const input=fixture(expansionSeeds[index]);const feature=engine.__test.buildFeatureTimeline(input.history,input.security.code,input.security.name,input.benchmark).at(-1);
  const definition=engine.STRATEGY_DEFINITIONS.find(row=>row.id===id);assert.equal(definition.matches(feature),true);
  const group=reportFor(input).strategies.find(row=>row.id===id);assert.equal(group.stocks.length,1);
  assert.ok(group.stocks[0].componentEvidence.every(row=>row.passed));
  for(const key of ['shape','confirmation']){const copy=structuredClone(feature);copy.signalCombinations.matches[id][key]=false;assert.equal(definition.matches(copy),false,key);}
  for(const key of ['common','riskVeto']){const copy=structuredClone(feature);if(key==='common')copy.signalCombinations.common=false;else copy.riskVeto=false;assert.equal(definition.matches(copy),false,key);}
  const before=structuredClone(feature);input.history.push({...input.history.at(-1),date:'2030-01-01',open:100,close:100,high:101,low:99});input.benchmark.push({...input.benchmark.at(-1),date:'2030-01-01'});
  assert.deepEqual(engine.__test.buildFeatureTimeline(input.history,input.security.code,input.security.name,input.benchmark)[299],before);
 });
 test(`${id} rejects missing calendar and explicit no-limit or ST evidence`,()=>{
  for(const mutate of [input=>input.benchmark.splice(240,1),input=>{input.history[291].noPriceLimit=true;},input=>{input.history[291].isST=true;},input=>{input.history[299].volume=0;}]){
   const input=fixture(expansionSeeds[index]);mutate(input);
   assert.equal(reportFor(input).strategies.find(row=>row.id===id).stocks.length,0);
  }
 });
}

test('all expansion metadata are primary platform sources and theoretical claims remain unvalidated',()=>{
 for(const item of require('../config/strategy-signal-combinations.json').slice(6)){
  assert.ok(item.sources.every(source=>/^https:\/\/(help\.tdx\.com\.cn|quant\.10jqka\.com\.cn|(?:www\.|cn\.)tradingview\.com)\//.test(source.url)));
  assert.match(item.adaptationNote,/未经收益/);assert.match(item.adaptationNote,/五日.*2–6周/);
 }
 const report=engine.buildStrategySignalReport();for(const id of expansionIds){assert.equal(report.strategies.find(row=>row.id===id).validation.accepted,false);}
});
