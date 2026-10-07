'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
let advance, normalize, settle, load, settings, restore, oldWindow, oldCss;
before(() => {
  restore = require('../qa/register-typescript.cjs').registerTypeScript();
  oldWindow = global.window; oldCss = require.extensions['.css'];
  global.window = { stockApi: { getPlatform: () => 'win32' } };
  require.extensions['.css'] = () => {};
  const filename = path.join(__dirname, 'App.tsx');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(__dirname);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8') + '\nexport { advancePaperSimulationByQuote, normalizePaperState, settlePaperPosition };', {
    fileName: filename, compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename);
  advance = mod.exports.advancePaperSimulationByQuote; normalize = mod.exports.normalizePaperState; load = mod.exports.loadPaperState;
  settle = mod.exports.settlePaperPosition;
  settings = { ...require('./domain/settings.ts').initialSettings, trailingStopPercent: 0, maxHoldingBars: 120 };
});
after(() => { restore?.(); global.window = oldWindow; if (oldCss) require.extensions['.css'] = oldCss; else delete require.extensions['.css']; });
const state = () => ({ initialCapital: 100000, cash: 99000, openPositions: [{ id: 'p', code: '600001', name: '合成', shares: 100,
  entryPrice: 10, latestPrice: 10, stopPrice: 8, takePrice: 20, holdingBars: 0, highWaterMark: 10, openedAt: '2026-01-05T02:00:00Z' }], closedPositions: [] });
const quote = (latest, dates = []) => ({ security: { code: '600001' }, quote: { latest }, history: dates.map(date => ({ date })) });
test('disabled trailing stop keeps position; fixed stop and take profit still close it', () => {
  assert.equal(advance(state(), quote(10), settings).state.openPositions.length, 1);
  assert.equal(advance(state(), quote(7), settings).state.closedPositions[0].closeReason, 'SL');
  assert.equal(advance(state(), quote(21), settings).state.closedPositions[0].closeReason, 'TP');
});
test('ordinary quotes retain price and peak so later retracement closes exactly once', () => {
  const safe = { ...settings, trailingStopPercent: 10 };
  const peak = advance(state(), quote(12), safe);
  assert.equal(peak.state.openPositions[0].latestPrice, 12);
  assert.equal(peak.state.openPositions[0].highWaterMark, 12);
  const exit = advance(peak.state, quote(10.5), safe);
  assert.equal(exit.state.openPositions.length, 0); assert.equal(exit.state.closedPositions.length, 1);
  assert.equal(advance(exit.state, quote(10.5), safe).state.cash, exit.state.cash);
});
test('repeated quotes count unique daily bars, retain cursor after reload and skip missing or invalid dates', () => {
  let next = advance(state(), quote(10, ['2026-01-05','2026-01-06','2026-01-06','bad','2026-02-30','2099-01-01']), settings).state;
  assert.equal(next.openPositions[0].holdingBars, 1);
  for (let i = 0; i < 125; i++) next = advance(next, quote(10, ['2026-01-06','2026-01-05']), settings).state;
  assert.equal(next.openPositions[0].holdingBars, 1);
  next = normalize(JSON.parse(JSON.stringify(next)));
  next = advance(next, quote(10, ['2026-01-07','2026-01-06']), settings).state;
  assert.equal(next.openPositions[0].holdingBars, 2);
  assert.equal(advance(next, quote(10), settings).state.openPositions[0].holdingBars, 2);
  const timed = advance(next, quote(10, ['2026-01-08']), { ...settings, maxHoldingBars: 3 });
  assert.equal(timed.state.closedPositions[0].closeReason, 'TIME_EXIT');
});
test('legacy counters survive migration and rolling history; stale history cannot move cursor back', () => {
  const legacy = state(); legacy.openPositions[0].holdingBars = 90;
  let next = advance(legacy, quote(10, ['2026-01-07']), settings).state;
  assert.equal(next.openPositions[0].holdingBars, 90);
  next = advance(next, quote(10, ['2026-01-06']), settings).state;
  next = advance(next, quote(10, ['2026-01-08']), settings).state;
  assert.equal(next.openPositions[0].holdingBars, 91);
});
test('invalid prices do not liquidate or revalue the ledger', () => {
  for (const latest of [undefined, null, '', [], {}, NaN, Infinity, 0, -1]) {
    const next = advance(state(), quote(latest), settings).state;
    assert.equal(next.openPositions.length, 1); assert.equal(next.openPositions[0].latestPrice, 10);
  }
});
test('legacy migration waits for history instead of counting old bars twice after an empty first response', () => {
  const legacy = state(); legacy.openPositions[0].holdingBars = 90;
  let next = advance(legacy, quote(10), settings).state;
  next = normalize(JSON.parse(JSON.stringify(next)));
  next = advance(next, quote(10, ['2026-01-06']), settings).state;
  assert.equal(next.openPositions[0].holdingBars, 90);
  next = advance(next, quote(10, ['2026-01-07']), settings).state;
  assert.equal(next.openPositions[0].holdingBars, 91);
});
test('portfolio kill switch settles each stock at its own latest price with original fees and slippage', () => {
  const portfolio = state(); portfolio.initialCapital = 5000; portfolio.cash = 2000;
  portfolio.openPositions.push({ ...portfolio.openPositions[0], id:'p2', code:'600002', entryPrice:20, latestPrice:20, highWaterMark:20, stopPrice:15, takePrice:30 });
  const safe = { ...settings, maxPortfolioRiskPercent:10 };
  const baseline = normalize(portfolio);
  const expected = baseline.openPositions.map(p => settle(p, p.latestPrice, 'KILL_SWITCH', '2026-01-05', safe));
  const result = advance(portfolio, quote(10), safe).state;
  assert.equal(result.openPositions.length, 0); assert.equal(result.closedPositions.length, 2);
  for (const item of expected) assert.equal(result.closedPositions.find(p => p.code === item.record.code).closePrice, item.record.closePrice);
  assert.ok(Math.abs(result.cash - (2000 + expected.reduce((sum,p) => sum + p.cashDelta, 0))) < 1e-8);
});
test('restoring a corrupt lot count uses the intact whole-account backup without writing', () => {
  const key = 'a-stock-radar-v054-paper-sim-v1';
  for (const shares of [49, 150, 100.5, 10000100]) {
    const bad = state(); bad.openPositions[0].shares = shares;
    const values = new Map([[key, JSON.stringify(bad)], [key + ':last-good', JSON.stringify(state())]]);
    window.localStorage = { getItem: key => values.get(key) ?? null, setItem() { assert.fail('hydration writes'); } };
    assert.equal(load().openPositions[0].shares, 100);
  }
});
