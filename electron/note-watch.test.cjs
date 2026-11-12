'use strict';
// 随心记价格条件（1.6.66）：主进程盯报价、只在交易时段取数、触发一次就交给页面并发系统通知。
require('../qa/test-env.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNoteWatcher, evaluateCondition, normalizeItem, inTradingSession } = require('./note-watch.cjs');

const cn = text => Date.parse(`${text}+08:00`);
const item = (id, code, condition, extra = {}) => ({ id, code, name: code === '600519' ? '贵州茅台' : '比亚迪', secid: '', text: `记录${id}`, condition, ...extra });

function harness({ quotes, session = true, clock = cn('2026-11-12T10:00:00') } = {}) {
  const calls = [], notices = [];
  let timerFn = null;
  const watcher = createNoteWatcher({
    getQuote: async security => { calls.push(security.code); const quote = quotes[security.code]; if (quote instanceof Error) throw quote; return { quote }; },
    notify: message => notices.push(message), inSession: () => session, now: () => clock,
    setTimer: fn => { timerFn = fn; return 1; }, clearTimer: () => { timerFn = null; }
  });
  return { watcher, calls, notices, timer: () => timerFn };
}

test('条件判断：价格和涨跌幅，缺报价或 0 价不触发', () => {
  assert.match(evaluateCondition({ field: 'latest', op: 'lte', value: 280 }, { latest: 279.5 }), /现价 279\.5，已跌到 280 以下/);
  assert.equal(evaluateCondition({ field: 'latest', op: 'lte', value: 280 }, { latest: 281 }), null);
  assert.equal(evaluateCondition({ field: 'latest', op: 'lte', value: 280 }, { latest: 0 }), null, '0 价是没拿到报价');
  assert.equal(evaluateCondition({ field: 'latest', op: 'lte', value: 280 }, null), null);
  assert.match(evaluateCondition({ field: 'changePct', op: 'gte', value: 5 }, { changePct: 5.21 }), /涨跌幅 \+5\.21%，已涨超 5%/);
  assert.match(evaluateCondition({ field: 'changePct', op: 'lte', value: -3 }, { changePct: -3.4 }), /已跌超 3%/);
  assert.equal(normalizeItem({ id: 'x', code: '12345', condition: { field: 'latest', op: 'lte', value: 1 } }), null);
  assert.equal(normalizeItem({ id: 'x', code: '600519', condition: { field: 'latest', op: 'lte', value: -1 } }), null);
  assert.equal(normalizeItem({ id: 'x', code: '600519', condition: { field: 'latest', op: 'lte', value: 1 } }).secid, '1.600519');
});

test('交易时段内触发一次：从盯的列表移除、发系统通知、下次同步交给页面', async () => {
  const h = harness({ quotes: { '600519': { latest: 1490, changePct: -1 }, '002594': { latest: 300, changePct: 1 } } });
  const first = h.watcher.sync({ items: [item('a', '600519', { field: 'latest', op: 'lte', value: 1500 }), item('b', '002594', { field: 'latest', op: 'lte', value: 280 }),
    item('c', '600519', { field: 'changePct', op: 'gte', value: 5 })] });
  assert.deepEqual(first.hits, []);
  assert.equal(first.watching, 3);
  await h.watcher.tick();
  assert.deepEqual(h.calls.sort(), ['002594', '600519'], '同一只股票只取一次报价');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].title, /贵州茅台 价格条件到了/);
  assert.match(h.notices[0].body, /现价 1490，已跌到 1500 以下 — 记录a/);
  // 页面同步：拿到触发记录；页面还没更新时又交来 a，也不会重复盯。
  const second = h.watcher.sync({ items: [item('a', '600519', { field: 'latest', op: 'lte', value: 1500 }), item('b', '002594', { field: 'latest', op: 'lte', value: 280 })] });
  assert.deepEqual(second.hits.map(hit => hit.id), ['a']);
  assert.match(second.hits[0].detail, /^贵州茅台 现价 1490/);
  assert.equal(second.watching, 1);
  await h.watcher.tick();
  assert.equal(h.notices.length, 1, '没有新触发');
  assert.deepEqual(h.watcher.sync({ items: [] }).hits, []);
  assert.equal(h.timer(), null, '没有要盯的就停掉定时器');
});

test('非交易时段不取报价；关了系统通知只记录；取数失败带回原因', async () => {
  const closed = harness({ quotes: { '600519': { latest: 1 } }, session: false });
  closed.watcher.sync({ items: [item('a', '600519', { field: 'latest', op: 'lte', value: 1500 })] });
  await closed.watcher.tick();
  assert.deepEqual(closed.calls, []);
  assert.equal(closed.watcher.sync({ items: [item('a', '600519', { field: 'latest', op: 'lte', value: 1500 })] }).session, false);

  const quiet = harness({ quotes: { '600519': { latest: 1 }, '002594': new Error('超时') } });
  quiet.watcher.sync({ items: [item('a', '600519', { field: 'latest', op: 'lte', value: 1500 }), item('b', '002594', { field: 'latest', op: 'lte', value: 280 })], systemNotify: false });
  await quiet.watcher.tick();
  assert.equal(quiet.notices.length, 0);
  const result = quiet.watcher.sync({ items: [item('b', '002594', { field: 'latest', op: 'lte', value: 280 })], systemNotify: false });
  assert.deepEqual(result.hits.map(hit => hit.id), ['a']);
  assert.match(result.error, /超时/);
});

test('交易时段判断按北京时间', () => {
  const open = () => true;
  assert.equal(inTradingSession(cn('2026-11-12T09:30:00'), open), true);
  assert.equal(inTradingSession(cn('2026-11-12T09:29:00'), open), false);
  assert.equal(inTradingSession(cn('2026-11-12T12:00:00'), open), false);
  assert.equal(inTradingSession(cn('2026-11-12T14:59:00'), open), true);
  assert.equal(inTradingSession(cn('2026-11-12T10:00:00'), () => false), false);
});
