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
