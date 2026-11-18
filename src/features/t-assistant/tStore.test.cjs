"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let store;
let restoreTypeScript;
before(() => { restoreTypeScript = registerTypeScript(); store = require("./tStore.ts"); });
after(() => restoreTypeScript?.());

test("本地数据归一：去重、过滤非 A 股代码和坏成交，参数按规则修正", () => {
  const value = store.normalizeTStore({
    items: [
      { code: "600000", name: "浦发银行", config: { baseShares: 3000, sellableShares: 9000 } },
      { code: "600000", name: "重复" },
      { code: "BAD", name: "坏代码" },
      { code: "000001", name: "平安银行" }
    ],
    trades: {
      "2026-11-09": { "600000": [{ id: "a", side: "sell", price: 10.5, shares: 1000, time: "10:05" }, { side: "buy", price: -1, shares: 100, time: "10:10" }, { side: "buy", price: 10, shares: 100, time: "25:00" }] },
      "not-a-date": { "600000": [] }
    },
    voice: false
  });
  assert.deepEqual(value.items.map(item => item.code), ["600000", "000001"]);
  assert.equal(value.items[0].config.sellableShares, 3000);
  assert.equal(value.items[0].secid, "1.600000");
  assert.equal(value.items[1].secid, "0.000001");
  assert.equal(value.trades["2026-11-09"]["600000"].length, 1);
  assert.equal(value.trades["not-a-date"], undefined);
  assert.equal(value.voice, false);
  assert.equal(value.showReplay, true);
  assert.deepEqual(store.normalizeTStore(null).items, []);
});

test("登记和删除成交：删空后去掉当天记录", () => {
  let value = store.normalizeTStore({ items: [{ code: "600000", name: "浦发银行" }] });
  value = store.withTrades(value, "2026-11-09", "600000", list => [...list, { id: "x", side: "sell", price: 10.2, shares: 500, time: "10:00" }]);
  assert.equal(value.trades["2026-11-09"]["600000"].length, 1);
  value = store.withTrades(value, "2026-11-09", "600000", list => list.filter(trade => trade.id !== "x"));
  assert.equal(value.trades["2026-11-09"], undefined);
});

test("交易时段：北京时间工作日 9:25–11:30、13:00–15:00", () => {
  const at = text => new Date(`${text}+08:00`);
  assert.equal(store.inTradingSession(at("2026-11-09T09:40:00")), true);
  assert.equal(store.inTradingSession(at("2026-11-09T12:10:00")), false);
  assert.equal(store.inTradingSession(at("2026-11-09T14:59:00")), true);
  assert.equal(store.inTradingSession(at("2026-11-08T10:00:00")), false, "周日");
  assert.equal(store.shanghaiClock(at("2026-11-09T09:41:30")), "09:41");
});

test("提醒去重：同一动作 5 分钟一次，动作变了马上提醒，旧信号不提醒", () => {
  const memory = {};
  const now = Date.parse("2026-11-09T02:00:00Z");
  assert.equal(store.shouldAlert(memory, "600000", "sell", "10:00", now, "10:00"), true);
  memory["600000"] = { action: "sell", at: now };
  assert.equal(store.shouldAlert(memory, "600000", "sell", "10:02", now + 120_000, "10:02"), false);
  assert.equal(store.shouldAlert(memory, "600000", "buyBack", "10:02", now + 120_000, "10:02"), true);
  assert.equal(store.shouldAlert(memory, "600000", "sell", "10:06", now + 360_000, "10:06"), true);
  assert.equal(store.shouldAlert({}, "600000", "sell", "09:50", now, "10:00"), false, "十分钟前的信号");
  assert.equal(store.shouldAlert({}, "600000", "wait", "10:00", now, "10:00"), false);
});

test('第61条成交仍完整保存，达到容量明确拒绝而非截断账本', () => {
  let value = store.normalizeTStore({});
  const trade = i => ({ id: String(i), side: 'sell', price: 10, shares: 100, time: '10:00' });
  value = store.withTrades(value, '2026-11-09', '600000', () => Array.from({length: 61}, (_, i) => trade(i)));
  assert.equal(value.trades['2026-11-09']['600000'].length, 61);
  assert.throws(() => store.withTrades(value, '2026-11-09', '600000', () => Array.from({length: store.MAX_T_TRADES + 1}, (_, i) => trade(i))), /上限/);
  assert.equal(value.trades['2026-11-09']['600000'][0].id, '0');
});

test('同一时分的旧日、未来分钟和失败缓存都不算新鲜行情', () => {
  const now = new Date('2026-11-09T10:00:00+08:00');
  assert.equal(store.isFreshTQuote('2026-11-06', '10:00', now), false);
  assert.equal(store.isFreshTQuote('2026-11-09', '10:01', now), false);
  assert.equal(store.isFreshTQuote('2026-11-09', '09:57', now), false);
  assert.equal(store.isFreshTQuote('2026-11-09', '09:58', now), true);
  assert.equal(store.shouldAlert({}, '600000', 'sell', '10:00', now.getTime(), '10:00', '2026-11-06'), false);
});

test('相同信号时间不因开关语音或刷新重播，新交易日去重自动重置', () => {
  const now = Date.parse('2026-11-09T10:00:00+08:00');
  const memory = { '600000': {action: 'sell', at: now - 600000, date: '2026-11-09', signalTime: '10:00'} };
  assert.equal(store.shouldAlert(memory, '600000', 'sell', '10:00', now, '10:00', '2026-11-09'), false);
  memory['600000'].date = '2026-11-06';
  assert.equal(store.shouldAlert(memory, '600000', 'sell', '10:00', now, '10:00', '2026-11-09'), true);
});

test('切换交易日仍能看到上一登记日未完成T，不把旧成交自动算进今天', () => {
  const value = store.normalizeTStore({ items: [{code: '600000', config: {baseShares: 1000, sellableShares: 1000}}], trades: {
    '2026-11-06': {'600000': [{id:'a', side:'sell', price:10, shares:100, time:'14:50'}]}
  }});
  assert.equal(store.previousOpenT(value, '600000', '2026-11-09').open.shares, 100);
  assert.equal(store.previousOpenT(value, '600000', '2026-11-09').date, '2026-11-06');
  assert.equal(value.trades['2026-11-09'], undefined);
  const closed = store.withTrades(value, '2026-11-06', '600000', list => [...list, {id:'b',side:'buy',price:9.9,shares:100,time:'14:55'}]);
  assert.equal(store.previousOpenT(closed, '600000', '2026-11-09'), null);
});

test('新交易日 T+1 自动滚动可卖底仓、同步持仓成本，且对同日调用幂等', () => {
  const initial = store.normalizeTStore({
    lastRolloverDay: '2026-11-08',
    items: [
      { code: '600000', name: '浦发银行', config: { baseShares: 3000, sellableShares: 2000, costPrice: 0, tShares: 1000 } },
      { code: '000001', name: '平安银行', config: { baseShares: 2000, sellableShares: 2000, costPrice: 10.5, tShares: 500 } }
    ],
    trades: {
      '2026-11-08': {
        '600000': [{ id: 'b1', side: 'buy', price: 10.2, shares: 500, time: '10:30' }],
        '000001': [{ id: 's1', side: 'sell', price: 10.8, shares: 500, time: '14:10' }]
      }
    }
  });
  const holdings = [{ code: '600000', shares: 3500, costPrice: 10.1 }, { code: '000001', shares: 1500, costPrice: 11.0 }];
  const rolled = store.rolloverTStoreForDay(initial, '2026-11-09', holdings);
  assert.equal(rolled.changed, true);
  assert.equal(rolled.store.lastRolloverDay, '2026-11-09');
  const pf = rolled.store.items.find(i => i.code === '600000');
  const pa = rolled.store.items.find(i => i.code === '000001');
  assert.equal(pf.config.baseShares, 3500);
  assert.equal(pf.config.sellableShares, 3500, '昨日买入+未解锁股数在次日全部变为 T+1 可卖');
  assert.equal(pf.config.costPrice, 10.1, '成本价为 0 时自动从持仓补齐');
  assert.equal(pa.config.baseShares, 1500, '昨日净卖出 500 股扣减底仓');
  assert.equal(pa.config.sellableShares, 1500);
  assert.equal(pa.config.costPrice, 10.5, '已填成本价不被覆盖');

  const again = store.rolloverTStoreForDay(rolled.store, '2026-11-09', holdings);
  assert.equal(again.changed, false);

  const summary = store.summarizeTStoreForAgent(rolled.store);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].sellableRatioPct, 100);
  assert.equal('shares' in summary[0], false);
  assert.equal('sellableShares' in summary[0], false);
});
