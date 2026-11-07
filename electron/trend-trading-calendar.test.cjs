'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = () => require('./trend-trading-calendar.cjs');
// 过期/外推相关的用例固定用「只覆盖到 2026 年底」的日历，不随内置日历每年延长而失效。
const bundledCalendar = require('../config/a-share-market-calendar.json');
const through2026 = { ...bundledCalendar, coveredTo: '2026-12-31', closedRanges: bundledCalendar.closedRanges.filter(range => range[1] <= '2026-12-31') };
test('independent exchange calendar handles closure days and 15:10 cutoff', () => {
  const { createTradingCalendar } = api(); const c = createTradingCalendar(through2026);
  assert.equal(c.expectedCloseDate(new Date('2026-10-21T07:09:59Z')).date, '2026-10-20');
  assert.equal(c.expectedCloseDate(new Date('2026-10-21T07:10:00Z')).date, '2026-10-21');
  assert.equal(c.expectedCloseDate(new Date('2026-10-03T08:00:00Z')).date, '2026-09-30');
  assert.equal(c.nextSession('2026-09-30'), '2026-10-08');
  assert.equal(c.nextSession('2026-02-13'), '2026-02-24');
  assert.equal(c.isSession('2026-10-10'), false, 'make-up Saturday is not a trading session');
  assert.equal(c.expectedCloseDate(new Date('2027-01-05T08:00:00Z')).state, 'unknown');
  assert.equal(c.isSession('2026-02-30'), null);
});
test('execution only permits the next session opening window and expires automatically', () => {
  const c = api().createTradingCalendar();
  assert.equal(c.executionWindow('2026-09-30', new Date('2026-10-08T01:24:59Z')).state, 'blocked');
  const ready = c.executionWindow('2026-09-30', new Date('2026-10-08T01:25:00Z'));
  assert.equal(ready.state, 'ready'); assert.equal(ready.executionDate, '2026-10-08');
  assert.equal(c.executionWindow('2026-09-30', new Date('2026-10-08T01:35:00Z')).state, 'expired');
  assert.equal(c.executionWindow('2026-09-30', new Date('2026-10-09T01:25:00Z')).state, 'expired');
  assert.equal(c.executionWindow('2026-10-09', new Date('2026-10-10T01:25:00Z')).state, 'blocked');
  assert.equal(c.executionWindow('2026-10-10', new Date('2026-10-12T01:25:00Z')).state, 'unknown');
});

test('observed index sessions extend an expired calendar without overriding exchange closures', () => {
  const { createTradingCalendar } = api(); const base = createTradingCalendar(through2026);
  const observed = base.withObservedSessions(['2026-12-30', '2027-01-04', '2027-01-05', '2027-01-06', '2027-01-09']);
  assert.equal(observed.isSession('2026-12-30'), true, 'bundled range still decides');
  assert.equal(observed.isSession('2027-01-01'), false); assert.equal(observed.isSession('2027-01-09'), null, 'weekend bars are ignored');
  const after = observed.expectedCloseDate(new Date('2027-01-06T07:10:00Z'));
  assert.equal(after.date, '2027-01-06'); assert.equal(after.inferred, true); assert.equal(after.state, 'known');
  assert.equal(observed.expectedCloseDate(new Date('2027-01-06T07:09:00Z')).date, '2027-01-05');
  assert.deepEqual(observed.sessionsThrough('2027-01-05', 3), ['2026-12-31', '2027-01-04', '2027-01-05']);
  assert.equal(observed.expectedCloseDate(new Date('2027-02-01T08:00:00Z')).state, 'unknown', 'stale index cannot vouch for today');
  assert.match(base.coverageNotice(new Date('2026-11-03T00:00:00Z')), /剩余58天/);
  assert.match(base.coverageNotice(new Date('2026-11-20T00:00:00Z')), /剩余41天/);
  assert.equal(base.coverageNotice(new Date('2026-10-01T00:00:00Z')), '');
});

test('内置日历含 2027 年休市安排（国务院办公厅 2026-11-05 通知）', () => {
  const c = api().createTradingCalendar();
  for (const day of ['2027-01-01', '2027-02-05', '2027-02-12', '2027-04-05', '2027-05-04', '2027-05-05', '2027-06-09', '2027-09-15', '2027-10-01', '2027-10-07']) assert.equal(c.isSession(day), false, day);
  for (const day of ['2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09']) assert.equal(c.isSession(day), false, `调休上班的周末 ${day} 不开市`);
  assert.equal(c.nextSession('2027-02-04'), '2027-02-15');
  assert.equal(c.nextSession('2027-09-30'), '2027-10-08');
  assert.equal(c.isSession('2027-06-10'), true);
});
