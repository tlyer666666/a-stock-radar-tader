'use strict';
// 随心记「AI 整理」（1.6.66）：只发文字和时间，输出逐字段校验。
require('../qa/test-env.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNoteParser, sanitizeNoteParse } = require('./ai-notes.cjs');

const DAYS = ['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'];

test('AI 整理：请求里只有文字、时间和交易日；结果逐字段校验', async () => {
  const requests = [];
  const ai = { chat: async request => { requests.push(request); return { text: '明天开盘看比亚迪，跌破 280 减仓', when: '2026-11-13 09:30', repeat: 'none', code: '002594',
    condition: { field: 'latest', op: 'lte', value: 280 }, note: '' }; }, model: () => 'demo-model' };
  const result = await createNoteParser({ ai }).parseNote({ text: '明早开盘瞅一眼比亚迪 002594 跌破280就减', now: '2026-11-12 21:50 周四', tradingDays: DAYS });
  assert.equal(result.when, '2026-11-13 09:30');
  assert.equal(result.code, '002594');
  assert.deepEqual(result.condition, { field: 'latest', op: 'lte', value: 280 });
  assert.equal(result.model, 'demo-model');
  assert.match(requests[0].user, /现在是北京时间 2026-11-12 21:50 周四/);
  assert.match(requests[0].user, /2026-11-13、2026-11-16/);
  assert.equal(requests[0].json, true);
  await assert.rejects(createNoteParser({ ai }).parseNote({ text: '  ' }), /先写点内容/);
});

test('不合格的字段丢掉：坏时间、坏代码、坏条件、非交易日的交易时段', () => {
  const bad = sanitizeNoteParse({ text: 'x', when: '明天', repeat: 'hourly', code: '12345', condition: { field: 'volume', op: 'lte', value: 1 } }, { tradingDays: DAYS });
  assert.deepEqual([bad.when, bad.repeat, bad.code, bad.condition], [null, 'none', null, null]);
  assert.equal(sanitizeNoteParse({ when: '2026-02-30 10:00' }).when, null);
  assert.equal(sanitizeNoteParse({ when: '2026-11-14 09:30' }, { tradingDays: DAYS }).when, null, '周六的开盘不存在');
  assert.equal(sanitizeNoteParse({ when: '2026-11-14 20:00' }, { tradingDays: DAYS }).when, '2026-11-14 20:00', '周六晚上可以');
  assert.equal(sanitizeNoteParse({ condition: { field: 'changePct', op: 'gte', value: 50 } }).condition, null);
  assert.deepEqual(sanitizeNoteParse({ condition: { field: 'changePct', op: 'lte', value: -3 } }).condition, { field: 'changePct', op: 'lte', value: -3 });
});
