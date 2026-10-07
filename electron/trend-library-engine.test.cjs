"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const facade = require("./trend-strategy.cjs");
const { evaluateTrendStock } = require("./trend-screener-engine.cjs");
const catalog = require("../config/trend-strategy-library.json");
function fixture(seed){
 let state=seed>>>0;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296};const cents=x=>Math.round(x*100)/100;
 const dates=[];const day=new Date('2025-01-01T00:00:00Z');while(dates.length<300){if(![0,6].includes(day.getUTCDay()))dates.push(day.toISOString().slice(0,10));day.setUTCDate(day.getUTCDate()+1)}
 const rawRows=[];let limitClose=0;const wave=.1+random()*.9;
 for(let i=0;i<300;i++){
  let close=cents(10+i*.012+Math.sin(i/5)*wave);
  if(i>=260)close=cents(12.6+(i-260)*.016+(random()-.5)*wave*2);
  if(i===286){close=cents(rawRows[i-1].close*1.1);limitClose=close;}
  if(i>286)close=cents(limitClose-.15+(random()-.35)*wave*1.4);
  const open=cents(close-.02);let high=cents(close+.08+random()*.2),low=cents(close-.15-random()*.2);
  if(i===286)low=cents(close-1.1);
  rawRows.push({date:dates[i],open,high,low,close,volume:8000000+Math.floor(random()*1000000),amount:300000000});
 }
 const benchmarkRows=dates.map((date,i)=>({date,open:100,high:101,low:99,close:100+i*.001,volume:1,amount:1}));
 return {security:{code:'600001',name:'独立样本',secid:'1.600001',assetType:'stock'},rawRows,adjustedRows:structuredClone(rawRows),benchmarkRows,asOf:dates.at(-1)};
}

function change(input, i, values) {
  Object.assign(input.rawRows[i], values); Object.assign(input.adjustedRows[i], values);
}
function bollFixture() {
  const input = fixture(1);
  const put = (i, close, low = close - .2) => change(input, i, { open: close - .02, close, high: close + .12, low });
  for (let i = 260; i < 280; i++) put(i, i % 2 ? 14 : 11.7);
  for (let i = 280; i < 285; i++) put(i, 14.1);
  put(285, 13); put(286, 14.3, 13.2);
  for (let i = 287; i < 299; i++) put(i, 14.2 + (i % 2 ? .03 : -.03));
  put(299, 14.85);
  return input;
}
const examples = [
  ["macd-zero-cross-v1", () => fixture(19), 13.24, 14.19, 14.39],
  ["boll-squeeze-breakout-v1", bollFixture, 13.74, 14.65, 14.93],
  ["dmi-trend-strength-v1", () => fixture(37), 13.16, 14.04, 14.29],
  ["obv-volume-breakout-v1", () => fixture(7), 13.29, 14.25, 14.44],
  ["kdj-trend-cross-v1", () => fixture(25), 13.3, 14.13, 14.37],
  ["ma-pullback-resume-v1", () => fixture(14), 13.84, 14.52, 14.87],
  ["rsi-midline-recovery-v1", () => fixture(659), 12.96, 13.57, 14.08],
  ["cci-strength-breakout-v1", () => fixture(9), 13.62, 14.35, 14.6],
  ["roc-zero-recovery-v1", () => fixture(2), 13.82, 14.44, 14.97],
  ["emv-zero-recovery-v1", () => fixture(1712), 12.25, 13.18, 13.31],
  ["mfi-midline-recovery-v1", () => fixture(9), 13.62, 14.35, 14.6],
  ["donchian-55-breakout-v1", () => fixture(640), 13.45, 14.6, 14.61]
];

test("fixed catalog parameters accept defaults, freeze full order, and reject retuning", () => {
  for (const item of catalog) {
    const snapshot = facade.normalizeTrendStrategy({ strategyId: item.id });
    assert.deepEqual(snapshot.config, item.parameters);
    const keys = Object.keys(item.parameters);
    assert.deepEqual(Object.keys(snapshot.config), keys);
    assert.equal(snapshot.configHash, createHash("sha256").update(JSON.stringify({ id: item.id, version: item.version, config: item.parameters })).digest("hex"));
    assert.deepEqual(facade.normalizeTrendStrategy({ strategyId: item.id, config: { [keys.at(-1)]: item.parameters[keys.at(-1)] } }), snapshot);
    for (const config of [{ unknown: 1 }, { [keys[0]]: item.parameters[keys[0]] + .1 }, { [keys[0]]: "3" }, { [keys[0]]: NaN }]) {
      assert.throws(() => facade.normalizeTrendStrategy({ strategyId: item.id, config }), /参数|配置/);
    }
    snapshot.config[keys[0]] = -1;
    assert.notEqual(facade.normalizeTrendStrategy({ strategyId: item.id }).config[keys[0]], -1);
  }
});

for (const [id, makeInput, stop, minEntry, maxEntry] of examples) {
  test(`${id} independently promotes a real classic watch and freezes a legal plan`, () => {
    const input = makeInput(), before = structuredClone(input);
    const classic = evaluateTrendStock(input);
    assert.equal(classic.kind, "candidate"); assert.equal(classic.candidate.stage, "watch");
    const result = facade.evaluateTrendStrategy(input, { strategyId: id });
    assert.equal(result.kind, "candidate");
    const c = result.candidate;
    assert.equal(c.stage, "signal", JSON.stringify(c.evidence?.filter(x => !x.passed)));
    assert.equal(c.strategy.id, id); assert.deepEqual(c.patterns, []); assert.equal(c.primaryPattern, null);
    assert.equal(c.quality, undefined); assert.equal(c.setup.id, id); assert.ok(c.setup.label);
    assert.equal(typeof c.setup.stopBasis, "string");
    assert.ok(c.plan.stop < c.plan.minEntry && c.plan.minEntry <= c.plan.maxEntry);
    if (stop !== undefined) assert.deepEqual([c.plan.stop, c.plan.minEntry, c.plan.maxEntry], [stop, minEntry, maxEntry]);
    assert.ok(Object.values(c.technical.indicators).every(Number.isFinite));
    assert.ok(!c.evidence.some(row => /^[AB]/.test(row.label)), "old shape failures must not appear in new evidence");
    assert.deepEqual(input, before);
  });
  test(`${id} rejects a failed trigger and does not retain its plan`, () => {
    const input = makeInput();
    const previous = input.rawRows.at(-2);
    change(input, 299, { open: previous.close, close: previous.close, high: previous.close + .05, low: previous.close - .05 });
    // DMI compares high/low directions, so a flat close alone is not a veto.
    if (id === "dmi-trend-strength-v1") change(input, 299, { high: previous.high, low: previous.low - 2 });
    const result = facade.evaluateTrendStrategy(input, { strategyId: id });
    assert.notEqual(result.candidate?.stage, "signal");
    if (result.candidate) assert.equal(result.candidate.plan, null);
  });
}

test("batch agrees with single evaluations in request order including classic and quality", () => {
  assert.equal(typeof facade.evaluateTrendStrategyBatch, "function");
  const options = [{ strategyId: "quality-v2" }, ...catalog.map(item => ({ strategyId: item.id })), {}];
  const input = fixture(19);
  assert.deepEqual(facade.evaluateTrendStrategyBatch(input, options), options.map(option => facade.evaluateTrendStrategy(input, option)));
  assert.deepEqual(facade.evaluateTrendStrategyBatch(input, []), []);
});

test("new batch never overrides base excluded/unavailable outcomes", () => {
  assert.equal(typeof facade.evaluateTrendStrategyBatch, "function");
  const options = catalog.map(item => ({ strategyId: item.id }));
  const st = fixture(19); st.security.isST = true;
  assert.ok(facade.evaluateTrendStrategyBatch(st, options).every(row => row.kind === "excluded"));
  const short = fixture(19); short.rawRows = short.rawRows.slice(-100); short.adjustedRows = short.adjustedRows.slice(-100);
  assert.ok(facade.evaluateTrendStrategyBatch(short, options).every(row => row.kind === "unavailable"));
});

test("new strategies require an aligned 80-session calendar even when classic accepts 65", () => {
  const input = fixture(19);
  input.rawRows.splice(230, 1); input.adjustedRows.splice(230, 1);
  assert.equal(evaluateTrendStock(input).kind, "candidate");
  for (const item of catalog) assert.equal(facade.evaluateTrendStrategy(input, { strategyId: item.id }).kind, "unavailable");
  const unknown = { ...fixture(19), benchmarkRows: [] };
  assert.equal(facade.evaluateTrendStrategy(unknown, { strategyId: catalog[0].id }).kind, "unavailable");
});

test("a price-only benchmark preserves new-library signals and still validates its OHLC", () => {
  const input = fixture(19), options = { strategyId: "macd-zero-cross-v1" };
  const expected = facade.evaluateTrendStrategy(input, options);
  input.benchmarkRows = input.benchmarkRows.map(row => ({ ...row, volume: null, amount: null }));
  assert.deepEqual(facade.evaluateTrendStrategy(input, options), expected);
  input.benchmarkRows.at(-1).high = 1;
  assert.equal(facade.evaluateTrendStrategy(input, options).kind, "unavailable");
});

test("21st factor, market gate and original-precision RS cannot be bypassed by a trigger", () => {
  const id = "macd-zero-cross-v1";
  const adjusted = fixture(19);
  for (const key of ["open", "high", "low", "close"]) adjusted.adjustedRows[279][key] *= .99;
  assert.equal(evaluateTrendStock(adjusted).kind, "candidate");
  assert.equal(facade.evaluateTrendStrategy(adjusted, { strategyId: id }).candidate.stage, "watch");
  const blocked = fixture(19);
  Object.assign(blocked.benchmarkRows.at(-1), { open: 90, close: 90, high: 91, low: 89 });
  const row = facade.evaluateTrendStrategy(blocked, { strategyId: id }).candidate;
  assert.equal(row.stage, "watch"); assert.equal(row.plan, null);
  const weak = fixture(19);
  const ratio = weak.rawRows.at(-1).close / weak.rawRows.at(-21).close;
  const close = weak.benchmarkRows.at(-21).close * (ratio + .000001);
  Object.assign(weak.benchmarkRows.at(-1), { open: close, close, high: close + 1, low: close - 1 });
  const weakRow = facade.evaluateTrendStrategy(weak, { strategyId: id }).candidate;
  assert.equal(weakRow.stage, "watch"); assert.ok(weakRow.metrics.relativeStrength20 < 0);
});

test("future bars and input order cannot rewrite any strategy's historical signal", () => {
  for (const [id, makeInput] of examples) {
    const input = makeInput(), expected = facade.evaluateTrendStrategy(input, { strategyId: id });
    for (const key of ["rawRows", "adjustedRows", "benchmarkRows"]) {
      input[key].push({ ...input[key].at(-1), date: "2030-01-01", close: 999, high: 1000 });
      input[key].reverse();
    }
    assert.deepEqual(facade.evaluateTrendStrategy(input, { strategyId: id }), expected);
  }
});

test("zero previous ATR and zero current amplitude fail closed with finite technical values", () => {
  const flat = fixture(19);
  for (let i = 284; i < 299; i++) change(flat, i, { open: 14, high: 14, low: 14, close: 14 });
  change(flat, 299, { open: 15.3, high: 15.4, low: 15.2, close: 15.4 });
  for (const item of catalog) {
    const c = facade.evaluateTrendStrategy(flat, { strategyId: item.id }).candidate;
    assert.equal(c.stage, "watch"); assert.equal(c.plan, null);
    assert.equal(c.evidence.find(row => row.label === "昨日波动").passed, false);
    assert.ok(Object.values(c.technical.indicators).every(Number.isFinite));
  }
  const zeroRange = fixture(19), close = zeroRange.rawRows.at(-1).close;
  change(zeroRange, 299, { open: close, high: close, low: close });
  const c = facade.evaluateTrendStrategy(zeroRange, { strategyId: "macd-zero-cross-v1" }).candidate;
  assert.equal(c.stage, "watch"); assert.equal(c.plan, null);
  assert.equal(c.evidence.find(row => row.label === "当日振幅").passed, false);
});

test("current-day range cannot widen yesterday's ATR stop or entry allowance", () => {
  const input = fixture(19), options = { strategyId: "macd-zero-cross-v1" };
  const expected = facade.evaluateTrendStrategy(input, options).candidate;
  change(input, 299, { high: 30, low: 10 });
  const actual = facade.evaluateTrendStrategy(input, options).candidate;
  assert.equal(actual.stage, "signal");
  assert.deepEqual(actual.plan, expected.plan);
  assert.equal(actual.technical.indicators.atr14Previous, expected.technical.indicators.atr14Previous);
});

test("an empty entry interval vetoes an otherwise valid MACD setup", () => {
  const input = fixture(19);
  change(input, 299, { close: 14.6, high: 14.7 });
  const c = facade.evaluateTrendStrategy(input, { strategyId: "macd-zero-cross-v1" }).candidate;
  assert.equal(c.evidence.find(row => row.label === "MACD金叉").passed, true);
  assert.equal(c.evidence.find(row => row.label === "独立入场区间").passed, false);
  assert.equal(c.stage, "watch"); assert.equal(c.plan, null);
});

test("positive excess return below display precision remains eligible", () => {
  const input = fixture(19);
  const ratio = input.rawRows.at(-1).close / input.rawRows.at(-21).close;
  const close = input.benchmarkRows.at(-21).close * (ratio - .000001);
  Object.assign(input.benchmarkRows.at(-1), { open: close, close, high: close + 1, low: close - 1 });
  assert.equal(evaluateTrendStock(input).candidate.metrics.relativeStrength20, 0);
  const c = facade.evaluateTrendStrategy(input, { strategyId: "macd-zero-cross-v1" }).candidate;
  assert.equal(c.stage, "signal"); assert.ok(c.metrics.relativeStrength20 > 0);
});

test("library ranking uses signal, exact RS, technical extension, amount and code", () => {
  const row = (code, stage, rs, extension, amount = 1) => ({ security: { code }, stage,
    metrics: { relativeStrength20: rs, avgAmount20: amount }, technical: { indicators: { extensionAtr: extension } } });
  const rows = [row("600009", "watch", 99, 0), row("600007", "signal", null, 0),
    row("600006", "signal", 1, 2), row("600005", "signal", 1, 1, 2),
    row("600004", "signal", 1, 1, 3), row("600003", "signal", 1, 1, 3), row("600002", "signal", 1.000001, 9)];
  const order = facade.rankTrendStrategyCandidates(rows, { strategyId: "macd-zero-cross-v1" });
  assert.deepEqual(order.map(item => item.security.code), ["600002", "600003", "600004", "600005", "600006", "600007", "600009"]);
  assert.equal(rows[0].security.code, "600009");
});

test("six-way batch executes the real shared base and indicator preparation only once", () => {
  // Wrappers observe work, but delegate every calculation to the real engine.
  const vm = require("node:vm"), fs = require("node:fs");
  const realBase = require("./trend-screener-engine.cjs"), realLibrary = require("./trend-library-engine.cjs");
  let baseCalls = 0, preparationCalls = 0;
  const sandbox = { module: { exports: {} }, require(id) {
    if (id === "./trend-screener-engine.cjs") return { ...realBase, evaluateTrendStock(...args) { baseCalls++; return realBase.evaluateTrendStock(...args); } };
    if (id === "./trend-library-engine.cjs") return { ...realLibrary, prepareTrendLibrary(...args) { preparationCalls++; return realLibrary.prepareTrendLibrary(...args); } };
    return require(id);
  } };
  sandbox.input = fixture(19);
  const options = JSON.stringify(catalog.map(item => ({ strategyId: item.id })));
  vm.runInNewContext(fs.readFileSync(`${__dirname}/trend-strategy.cjs`, "utf8") +
    `;module.exports.results = module.exports.evaluateTrendStrategyBatch(input, ${options});`, sandbox);
  const results = sandbox.module.exports.results;
  assert.equal(results.length, catalog.length); assert.equal(results[0].candidate.stage, "signal");
  assert.equal(baseCalls, 1); assert.equal(preparationCalls, 1);
});

const expansionIds = ['rsi-midline-recovery-v1','cci-strength-breakout-v1','roc-zero-recovery-v1','emv-zero-recovery-v1','mfi-midline-recovery-v1','donchian-55-breakout-v1'];
test('v1.4 exposes six additional distinct fixed-parameter families without changing old identities',()=>{
 assert.equal(catalog.length,12);assert.deepEqual(catalog.slice(6).map(row=>row.id),expansionIds);
 const input=fixture(19);const outcomes=facade.evaluateTrendStrategyBatch(input,expansionIds.map(strategyId=>({strategyId})));
 assert.equal(outcomes.length,6);
 for(const [i,outcome] of outcomes.entries()){
  assert.equal(outcome.kind,'candidate');assert.equal(outcome.candidate.strategy.id,expansionIds[i]);
  assert.deepEqual(outcome.candidate.patterns,[]);assert.equal(outcome.candidate.primaryPattern,null);
  assert.ok(Object.values(outcome.candidate.technical.indicators).every(Number.isFinite));
 }
});
