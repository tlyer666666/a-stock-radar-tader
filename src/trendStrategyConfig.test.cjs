'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
let config, restore;
before(() => { restore = registerTypeScript(); config = require('./trendStrategyConfig.ts'); });
after(() => restore?.());
test('old and new production snapshots stay readable but never compare as the same strategy', () => {
  const old = { id: 'quality-v2', version: '2.0.0', configHash: 'a'.repeat(64), config: { maxExtensionAtr: 2, minCloseLocation: 0.7, maxVolumeRatio: 3 } };
  const current = { ...old, version: '2.1.0' };
  assert.equal(config.validStrategySnapshot(old), true);
  assert.equal(config.validStrategySnapshot(current), true);
  assert.equal(config.sameTrendStrategy(old, current), false);
  const library = config.TREND_LIBRARY[0];
  for (const version of ['1.0.0', '1.1.0']) assert.equal(config.validStrategySnapshot({ id: library.id, version, configHash: 'b'.repeat(64), config: library.parameters }), true);
  assert.equal(config.validStrategySnapshot({ ...old, version: '2.2.0' }), false);
});
test('preset values cannot be mutated between scans and custom settings require an explicit research identity', () => {
  assert.throws(() => { config.TREND_QUALITY_PRESETS.robust.maxExtensionAtr = 9; }, TypeError);
  assert.equal(config.qualityPresetName({ maxExtensionAtr: 2, minCloseLocation: 0.7, maxVolumeRatio: 3 }), 'robust');
  assert.equal(config.qualityPresetName({ maxExtensionAtr: 2.5, minCloseLocation: 0.65, maxVolumeRatio: 3.5 }), 'balanced');
  assert.equal(config.qualityPresetName({ maxExtensionAtr: 1.7, minCloseLocation: 0.7, maxVolumeRatio: 3 }), 'custom-research');
});

test('preview distinguishes close confirmation floors from breakout floors without a high open requirement', async () => {
  const preview = require('./trendScreenerPreview.ts');
  const state = await preview.createConfiguredTrendPreviewStatus({ strategyId: 'macd-zero-cross-v1' });
  const c = state.candidates[0];
  assert.equal(c.plan.entryType, 'close-confirmation');
  assert.equal(c.plan.minEntry, 11.43);
  assert.ok(c.plan.minEntry < c.metrics.close);
  const q = await preview.createConfiguredTrendPreviewStatus({ strategyId: 'quality-v2' });
  assert.equal(q.candidates[0].plan.entryType, 'breakout');
});
