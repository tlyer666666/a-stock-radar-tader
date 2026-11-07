'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
let tools, restore;
before(() => { restore = registerTypeScript(); tools = require('./TrendResearchTools.tsx'); });
after(() => restore?.());
const dataset = { schemaVersion: 1, sourceClass: 'real', source: 'user supplied public history', universeMode: 'selected', calendar: ['2026-10-20'], benchmarkRows: [], securities: [{}] };
test('research input requires a supplied dataset and ordered real ISO dates', () => {
  for (const change of [{ dataset: null }, { from: '' }, { from: '2026-02-30' }, { to: '2026-10-01' }, { splitDate: '2026-10-22' }]) {
    assert.throws(() => tools.validateTrendResearchInput({ dataset, from: '2026-10-19', to: '2026-10-21', splitDate: '2026-10-20', ...change }));
  }
  assert.doesNotThrow(() => tools.validateTrendResearchInput({ dataset, from: '2026-10-19', to: '2026-10-21', splitDate: '2026-10-20' }));
});
test('dataset import rejects oversized data before reading it, malformed JSON and script text', async () => {
  let read = false;
  await assert.rejects(() => tools.readTrendResearchFile({ size: 16 * 1024 * 1024 + 1, text: async () => { read = true; return '{}'; } }), /16/);
  assert.equal(read, false);
  for (const value of ['window.pwned = true', '{bad', '[]', '{}']) await assert.rejects(() => tools.readTrendResearchFile({ size: value.length, text: async () => value }));
  assert.deepEqual(await tools.readTrendResearchFile({ size: 100, text: async () => JSON.stringify(dataset) }), dataset);
});
test('report summary preserves account incompleteness and missing values as unknown rather than zero', () => {
  const summary = tools.trendResearchReportSummary({ qualification: { status: 'REAL_DIAGNOSTIC', returnSuperiorityVerified: true },
    baseline: { sharedAccount: { metrics: { closed: 2, censored: 1, unresolved: 3, completeEquityEvidence: false } } }, advanced: {} });
  assert.equal(summary.qualification, 'REAL_DIAGNOSTIC');
  assert.equal(summary.superiorityVerified, false);
  assert.deepEqual(summary.baseline, { closed: 2, censored: 1, unresolved: 3, pending: null, complete: false });
  assert.deepEqual(summary.advanced, { closed: null, censored: null, unresolved: null, pending: null, complete: null });
  assert.equal(tools.trendResearchReportSummary(null).qualification, 'UNKNOWN');
});
