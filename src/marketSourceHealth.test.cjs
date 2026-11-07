'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
const restore = registerTypeScript();
const { describeSourceHealth, sourceStatusLabel } = require('./features/market/marketSourceHealth.ts');
after(restore);

const now = Date.parse('2026-10-22T02:00:00Z');
const entry = (id, status, patch = {}) => ({ id, name: id, kind: '', status, consecutiveFailures: 0, retryAt: null, lastOkAt: null, lastFailAt: null,
  lastError: '', lastLatencyMs: null, successCount: 0, failureCount: 0, ...patch });
const health = (...quotes) => ({ checkedAt: new Date(now).toISOString(), quotes, history: [] });

test('no notice while THS works or before any request has been made', () => {
  assert.equal(describeSourceHealth(health(entry('ths_free', 'ok'), entry('eastmoney', 'idle'), entry('tencent', 'idle')), now), null);
  assert.equal(describeSourceHealth(health(entry('ths_free', 'idle'), entry('eastmoney', 'idle'), entry('tencent', 'idle')), now), null);
  assert.equal(describeSourceHealth(null, now), null);
});

test('a paused THS line names the working relay, the reason and the retry time', () => {
  const notice = describeSourceHealth(health(
    entry('ths_free', 'open', { lastError: 'HTTP 503', lastFailAt: '2026-10-22T01:59:50Z', retryAt: '2026-10-22T02:00:25Z' }),
    entry('eastmoney', 'ok'), entry('tencent', 'idle')), now);
  assert.equal(notice.tone, 'relay');
  assert.match(notice.message, /同花顺免费行情暂不可用（HTTP 503），已由东方财富接力，25 秒后自动重试/);
  const same = describeSourceHealth(health(
    entry('ths_free', 'open', { lastError: 'HTTP 503', lastFailAt: '2026-10-22T01:59:50Z', retryAt: '2026-10-22T02:00:25Z' }),
    entry('eastmoney', 'ok'), entry('tencent', 'idle')), now + 5000);
  assert.equal(same.key, notice.key, 'a dismissed incident stays dismissed while it lasts');
});

test('all lines failing is an alert that keeps the last good data on screen', () => {
  const notice = describeSourceHealth(health(entry('ths_free', 'open'), entry('eastmoney', 'degraded'), entry('tencent', 'open')), now);
  assert.equal(notice.tone, 'down');
  assert.match(notice.message, /三路暂均不可用.*保留最后一次成功的数据/);
  assert.equal(sourceStatusLabel(entry('x', 'open')), '连续失败 · 暂停重试中');
  assert.equal(sourceStatusLabel(undefined), '待首次请求');
});
