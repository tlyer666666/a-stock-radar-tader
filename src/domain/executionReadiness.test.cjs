'use strict';
// Behaviour of the shared execution-readiness derivation. The paper-trading page and the
// backtest page both consume this, so these cases pin the contract for both surfaces.
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../../qa/register-typescript.cjs');
registerTypeScript();
const {
  normalizePaperExecutionReadiness,
  normalizeBacktestExecutionReadiness
} = require('./executionReadiness.ts');

test('a payload that cannot be trusted is treated as absent, never as a zero verdict', () => {
  for (const junk of [null, undefined, 0, '', 'string', true, [], [1], () => {}]) {
    assert.equal(normalizePaperExecutionReadiness(junk), null, `paper: ${JSON.stringify(junk)}`);
    assert.equal(normalizeBacktestExecutionReadiness(junk), null, `backtest: ${JSON.stringify(junk)}`);
  }
  // Missing/unknown level and non-finite score are the two other rejection paths.
  assert.equal(normalizePaperExecutionReadiness({ score: 50 }), null);
  assert.equal(normalizePaperExecutionReadiness({ level: 'PASS', score: 50 }), null);
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass' }), null);
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass', score: 'abc' }), null);
  assert.equal(normalizeBacktestExecutionReadiness({ level: 'block', score: NaN }), null);
});

test('status follows the level unless the payload states a valid one', () => {
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass', score: 50 }).status, 'PASS');
  assert.equal(normalizePaperExecutionReadiness({ level: 'wait', score: 50 }).status, 'WAIT');
  assert.equal(normalizePaperExecutionReadiness({ level: 'block', score: 50 }).status, 'BLOCK');
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass', score: 50, status: 'BLOCK' }).status, 'BLOCK');
  // An unknown status falls back to the level rather than being passed through.
  assert.equal(normalizePaperExecutionReadiness({ level: 'wait', score: 50, status: 'pass' }).status, 'WAIT');
});

test('score is rounded and clamped into 0-100', () => {
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass', score: 50.4 }).score, 50);
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass', score: 50.6 }).score, 51);
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass', score: -5 }).score, 0);
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass', score: 150 }).score, 100);
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass', score: '77' }).score, 77);
});

test('reasons are filtered to non-blank strings and fall back to a default line', () => {
  assert.deepEqual(normalizePaperExecutionReadiness({ level: 'pass', score: 1, reasons: ['a', '', '  ', 3, null] }).reasons, ['a']);
  assert.deepEqual(normalizePaperExecutionReadiness({ level: 'pass', score: 1, reasons: [] }).reasons, ['执行评估已完成']);
  assert.deepEqual(normalizePaperExecutionReadiness({ level: 'pass', score: 1 }).reasons, ['执行评估已完成']);
});

test('paper readiness keeps its own summary/recommendation defaults and block override', () => {
  const missing = normalizePaperExecutionReadiness({ level: 'pass', score: 1 });
  assert.equal(missing.summary, '执行评估已返回但摘要缺失');
  assert.equal(missing.recommendation, '可执行');
  assert.equal(missing.canExecute, true);

  assert.equal(normalizePaperExecutionReadiness({ level: 'wait', score: 1 }).recommendation, '建议先确认后执行');
  assert.equal(normalizePaperExecutionReadiness({ level: 'block', score: 1 }).recommendation, '当前不适合执行');

  // A block level always wins over a payload that claims it can execute.
  assert.equal(normalizePaperExecutionReadiness({ level: 'block', score: 1, canExecute: true }).canExecute, false);
  assert.equal(normalizePaperExecutionReadiness({ level: 'pass', score: 1, canExecute: false }).canExecute, false);
  // Non-boolean canExecute falls back to "anything but block".
  assert.equal(normalizePaperExecutionReadiness({ level: 'wait', score: 1, canExecute: 'yes' }).canExecute, true);

  const explicit = normalizePaperExecutionReadiness({ level: 'pass', score: 1, summary: ' 摘要 ', recommendation: ' 建议 ' });
  assert.equal(explicit.summary, ' 摘要 ');
  assert.equal(explicit.recommendation, ' 建议 ');
});

test('backtest readiness keeps its own wording and only allows live runs on pass', () => {
  assert.equal(normalizeBacktestExecutionReadiness({ level: 'pass', score: 1 }).recommendation, '可用于执行');
  assert.equal(normalizeBacktestExecutionReadiness({ level: 'wait', score: 1 }).recommendation, '建议先确认再执行');
  assert.equal(normalizeBacktestExecutionReadiness({ level: 'block', score: 1 }).recommendation, '不建议执行');

  // canRunLive requires level 'pass'; an absent flag means "allowed", an explicit false does not.
  assert.equal(normalizeBacktestExecutionReadiness({ level: 'pass', score: 1 }).canRunLive, true);
  assert.equal(normalizeBacktestExecutionReadiness({ level: 'pass', score: 1, canRunLive: false }).canRunLive, false);
  assert.equal(normalizeBacktestExecutionReadiness({ level: 'wait', score: 1, canRunLive: true }).canRunLive, false);
  assert.equal(normalizeBacktestExecutionReadiness({ level: 'block', score: 1, canRunLive: true }).canRunLive, false);

  assert.deepEqual(Object.keys(normalizeBacktestExecutionReadiness({ level: 'pass', score: 1 })),
    ['score', 'level', 'status', 'recommendation', 'reasons', 'canRunLive']);
  assert.deepEqual(Object.keys(normalizePaperExecutionReadiness({ level: 'pass', score: 1 })),
    ['score', 'level', 'status', 'summary', 'recommendation', 'reasons', 'canExecute']);
});
