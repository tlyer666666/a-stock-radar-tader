'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../../../qa/register-typescript.cjs');
let restore, model; before(() => { restore = registerTypeScript(); model = require('./timeShareModel.ts'); }); after(() => restore?.());
const bar = (date, close, volume = 100, amount = close * volume * 100) => ({ date, open: close, high: close, low: close, close, volume, amount });

test('time-share axis maps the trading day onto 241 fixed slots and folds the opening auction into 09:30', () => {
  assert.equal(model.timeShareSlot('09:25'), 0);
  assert.equal(model.timeShareSlot('09:30'), 0);
  assert.equal(model.timeShareSlot('09:31'), 1);
  assert.equal(model.timeShareSlot('11:30'), 120);
  assert.equal(model.timeShareSlot('12:00'), null);
  assert.equal(model.timeShareSlot('13:01'), 121);
  assert.equal(model.timeShareSlot('15:00'), 240);
  assert.equal(model.timeShareSlot('15:05'), null);
});

test('time-share uses the previous session close as baseline and a volume-weighted average price', () => {
  const rows = [bar('2026-10-27 14:59', 9.9), bar('2026-10-27 15:00', 10),
    bar('2026-10-28 09:31', 10.2, 100), bar('2026-10-28 09:32', 10.5, 300), bar('2026-10-28 13:01', 10.1, 100)];
  const share = model.buildTimeShare(rows);
  assert.equal(share.date, '2026-10-28');
  assert.equal(share.preClose, 10);
  assert.equal(share.preCloseSource, 'previous_day');
  assert.deepEqual(share.points.map(p => p.slot), [1, 2, 121]);
  assert.ok(Math.abs(share.points[1].average - (10.2 * 100 + 10.5 * 300) / 400) < 1e-9);
  assert.ok(Math.abs(share.points[1].changePercent - 5) < 1e-9);
  assert.equal(share.points[2].rising, false);
  assert.ok(share.scale.max - 10 > 0.5 && Math.abs((share.scale.max - 10) - (10 - share.scale.min)) < 1e-9, 'axis is symmetric around the previous close');
  assert.equal(share.high, 10.5); assert.equal(share.low, 10.1);
});

test('volume reported in shares is recognised and a first day without history falls back to the first open', () => {
  const rows = [{ date: '2026-10-28 09:31', open: 9.8, high: 10, low: 9.8, close: 10, volume: 10000, amount: 100000 }];
  const share = model.buildTimeShare(rows);
  assert.equal(share.preCloseSource, 'first_open');
  assert.equal(share.preClose, 9.8);
  assert.ok(Math.abs(share.points[0].average - 10) < 1e-9);
  assert.equal(model.buildTimeShare([{ date: '2026-10-28', close: 10 }]), null, 'daily bars are not time-share data');
});

test('a source previous close and source average price take priority over values derived from minute bars', () => {
  const rows = [{ date: '2026-10-29 09:31', open: 10.2, high: 10.2, low: 10.2, close: 10.2, volume: 100, amount: 102000, average: 10.18 }];
  const share = model.buildTimeShare(rows, { preClose: 10 });
  assert.equal(share.preClose, 10);
  assert.equal(share.preCloseSource, 'source');
  assert.equal(share.points[0].average, 10.18);
  assert.ok(Math.abs(share.points[0].changePercent - 2) < 1e-9);
});

test('stock lots, convertible-bond lots and individual units produce the same economic VWAP', () => {
  // Two trades: 1000 units at 100, then 3000 at 102 => VWAP 101.5.
  const trades = [bar('2026-10-29 09:31', 100, 1000, 100000), bar('2026-10-29 09:32', 102, 3000, 306000)];
  for (const { assetType, unitsPerLot } of [{ assetType: 'stock', unitsPerLot: 100 }, { assetType: 'convertibleBond', unitsPerLot: 10 }]) {
    for (const volumeUnit of ['lots', 'shares']) {
      const rows = trades.map(row => ({ ...row, volume: row.volume / (volumeUnit === 'lots' ? unitsPerLot : 1), volumeUnit }));
      const share = model.buildTimeShare(rows, { preClose: 100, assetType });
      assert.equal(share.points[0].average, 100, `${assetType}/${volumeUnit}`);
      assert.equal(share.points[1].average, 101.5, `${assetType}/${volumeUnit}`);
      assert.equal(share.totalAmount, 406000);
      assert.equal(share.totalVolume, 4000 / unitsPerLot, 'display volume is always in lots');
      assert.ok(share.scale.maxPercent < 3, 'correct VWAP keeps a normal symmetric price scale');
    }
  }
});

test('explicit volume units and lot metadata take priority over price-based unit guessing', () => {
  const row = { ...bar('2026-10-29 09:31', 100, 100, 990000), volumeUnit: 'lots' };
  assert.equal(model.buildTimeShare([row], { unitsPerLot: 10 }).points[0].average, 990, 'lots metadata is not overridden to make VWAP closer to the closing price');
  assert.equal(model.buildTimeShare([{ ...row, volumeUnit: 'shares' }], { unitsPerLot: 10, volumeUnit: 'lots' }).points[0].average, 9900, 'row units override chart-level defaults');
  assert.equal(model.buildTimeShare([{ ...row, volumeUnit: undefined }], { unitsPerLot: 10, volumeUnit: 'shares' }).points[0].average, 9900);
  assert.equal(model.buildTimeShare([{ ...row, amount: 100000 }], { assetType: 'stock', unitsPerLot: 10 }).points[0].average, 100, 'explicit lot size overrides asset defaults');
});

test('a real time-share service fallback to parsed convertible-bond minute bars renders through the market workspace', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const ths = require('../../../electron/ths-free-market.cjs');
  const filename = path.resolve(__dirname, '../../../electron/services.cjs'), localRequire = createRequire(filename);
  const module = { exports: {} }, calls = [];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    require: id => id === './ths-free-market.cjs' ? {
      ...ths,
      thsFreeTimeShare: async security => { calls.push(['time', security.assetType]); throw new Error('offline time-share fixture'); },
      thsFreeKline: async (security, options) => {
        calls.push([options.interval, security.assetType, options.fqt]);
        return ths.parseThsMinuteData('202610290931,100,100,100,100,1000,100000;202610290932,100,100,100,100,1000,100000', 10);
      }
    } : localRequire(id),
    process, console, URL, Buffer, AbortController, AbortSignal, DOMException, TextDecoder,
    setTimeout, clearTimeout, setImmediate, queueMicrotask
  }, { filename });
  const security = { code: '113001', secid: '1.113001', name: '转债样本', assetType: 'convertibleBond' };
  const result = await module.exports.getChart(security, 'time', { forceRefresh: true });
  assert.deepEqual(calls, [['time', 'convertibleBond'], ['1', 'convertibleBond', 0]]);
  assert.match(result.note, /1 分钟线/);
  assert.equal(result.rows[0].volumeUnit, 'lots');
  assert.equal(result.rows[0].volume, 100);
  assert.equal(result.rows[0].average, undefined, 'fallback must derive VWAP instead of inheriting a source average');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { createHookHarness, find } = require('../../../qa/research-hook-harness.cjs');
  const TimeShareChart = require('./TimeShareChart.tsx').default;
  // Expose the real private panel only in this test module; no production-only
  // testing export or replacement child component is needed.
  const typescript = require('typescript'), { Module } = require('node:module');
  const workspaceFilename = path.join(__dirname, 'MarketWorkspace.tsx');
  const compiled = typescript.transpileModule(fs.readFileSync(workspaceFilename, 'utf8') + '\nexport { TrendChartPanel };', {
    fileName: workspaceFilename, compilerOptions: { esModuleInterop: true, jsx: typescript.JsxEmit.ReactJSX, module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
  }).outputText;
  const workspace = new Module(workspaceFilename);workspace.filename = workspaceFilename;workspace.paths = Module._nodeModulePaths(__dirname);workspace._compile(compiled, workspaceFilename);
  const originalWindow = global.window;
  global.window = { stockApi: { getChart: async (item, interval) => { assert.equal(item, security);assert.equal(interval, 'time');return result; } } };
  const h = createHookHarness(workspace.exports.TrendChartPanel, { props: { security, dailyHistory: [], live: false } });
  try {
    h.render();await h.flush();
    const markup = renderToStaticMarkup(find(h.tree, node => node.type === TimeShareChart));
    assert.match(markup, /均价 <em class="time-share-average-text">100\.00<\/em>/);
    assert.match(markup, /\+1\.08%/);
  } finally { h.dispose();global.window = originalWindow; }
});
