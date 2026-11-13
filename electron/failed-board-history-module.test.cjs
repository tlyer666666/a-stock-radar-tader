"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createFailedBoardHistoryService } = require("./failed-board-history.cjs");

const dates = ["2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12"];
const makePool = (date, rows = []) => ({
  date,
  serverTradingDate: "2026-10-16",
  fetchedAt: `${date}T08:00:00.000Z`,
  provider: "eastmoney_topic_pool",
  providers: ["eastmoney_topic_pool"],
  pool: rows
});

function createService() {
  const requestedDays = [];
  const latestRows = [
    {
      code: "600001", name: "测试样本", industry: "测试行业",
      latest: null, changePct: null, amount: null, turnover: null,
      raw: { p: null, zdp: null, amount: null, hs: null }
    },
    { code: "600002", name: "ST风险样本", latest: 10, changePct: 1, amount: 1, turnover: 1 }
  ];
  const service = createFailedBoardHistoryService({
    displayDate(value) {
      const text = String(value || "");
      return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
    },
    todayInShanghai: () => "2026-10-17",
    isAStockCode: (code) => /^\d{6}$/.test(code),
    isRiskStockName: (name) => /(?:\*?ST|退)/i.test(name),
    recentLimitUpPools: async () => [
      makePool("2026-10-16", [{ code: "600001", name: "测试样本", raw: { high_days: 1, limit_up_type: "换手板" }, consecutiveBoards: 1, boardType: "换手板" }]),
      makePool("2026-10-15", [{ code: "600001", name: "测试样本", consecutiveBoards: 1, boardType: "换手板" }])
    ],
    recentTradingDates: async () => dates,
    selectLimitUpTradingDates: (_today, _pool, calendarDates, count) => calendarDates.slice(0, count),
    topicPoolForDate: async (date, type) => {
      if (type === "limit" && date === "2026-10-17") return makePool(date, []);
      requestedDays.push(date);
      return makePool(date, date === dates[0] ? latestRows : [{ code: "600003", name: `炸板${date}`, latest: 8, changePct: -1, amount: 300, turnover: 2 }]);
    }
  });
  return { service, requestedDays };
}

test("failed-board feature keeps each trading day independent and preserves unknown source metrics", async () => {
  const { service, requestedDays } = createService();
  const snapshot = await service.getPreviousLimitUpFailedBoardSnapshot({ forceRefresh: true });

  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.failedBoardDays.map((day) => day.date), dates);
  assert.equal(new Set(requestedDays).size, 5);
  assert.deepEqual(snapshot.failedBoardDays[0].rows.map((row) => row.code), ["600001"]);
  assert.equal(snapshot.failedBoardDays[0].rows[0].latest, null);
  assert.equal(snapshot.failedBoardDays[0].rows[0].changePct, null);
  assert.deepEqual(snapshot.failedBoardDays[1].rows.map((row) => row.code), ["600003"]);
  assert.deepEqual(snapshot.rows.map((row) => row.code), ["600001"]);
});

test("failed-board rows never derive a first-board count from decoration defaults", async () => {
  const displayDate = value => String(value || "");
  const current = makePool(dates[0], [{code:"600001",name:"样本"}]);
  const service = createFailedBoardHistoryService({displayDate,todayInShanghai:()=>"2026-10-16",isAStockCode:()=>true,isRiskStockName:()=>false,
    recentLimitUpPools:async()=>[current,makePool(dates[1])],recentTradingDates:async()=>dates,selectLimitUpTradingDates:()=>dates,
    topicPoolForDate:async date=>makePool(date,[{code:"600001",name:"样本",consecutiveBoards:1,raw:{c:"600001",p:10000}}])});
  const result=await service.getPreviousLimitUpFailedBoardSnapshot();
  assert.equal(result.failedBoardDays[0].rows[0].consecutiveBoards,null);
});

test("THS failed-board fields and supplemental open count agree in daily and intersection views", async () => {
  const row = {
    code: "600001", name: "同花顺样本", dataProvider: "ths_public_open_limit",
    latest: 10, changePct: -2, amount: 1000, turnover: 7.5, openBoardCount: 3,
    firstSealTime: "09:40:00", lastSealTime: "10:20:00",
    openBoardCountProvider: "fuyao_limit_break_pool",
    raw: { zbc: 3, sourceItem: { latest: 10, change_rate: -2, turnover: 1000, turnover_rate: 7.5,
      first_limit_up_time: 1, last_limit_up_time: 2, open_board_count: null } }
  };
  const unknown = { ...row, code: "600002", openBoardCount: 0, openBoardCountProvider: undefined,
    raw: { zbc: 0, sourceItem: { open_board_count: null } } };
  const service = createFailedBoardHistoryService({
    displayDate: value => String(value || ""),
    todayInShanghai: () => dates[0], isAStockCode: () => true, isRiskStockName: () => false,
    recentLimitUpPools: async () => [makePool(dates[0]), makePool(dates[1], [row, unknown])],
    recentTradingDates: async () => dates,
    selectLimitUpTradingDates: () => dates,
    topicPoolForDate: async date => makePool(date, date === dates[0] ? [row, unknown] : [])
  });
  const result = await service.getPreviousLimitUpFailedBoardSnapshot();
  for (const rows of [result.failedBoardDays[0].rows, result.rows.map(item => item.today)]) {
    assert.equal(rows[0].latest, 10);
    assert.equal(rows[0].changePct, -2);
    assert.equal(rows[0].amount, 1000);
    assert.equal(rows[0].turnover, 7.5);
    assert.equal(rows[0].firstSealTime, "09:40:00");
    assert.equal(rows[0].lastSealTime, "10:20:00");
    assert.equal(rows[0].openBoardCount, 3);
    assert.equal(rows[1].openBoardCount, null);
  }
});

test("a manual historical refresh bypasses the cache only for the selected trading day", async () => {
  const forced = [];
  const service = createFailedBoardHistoryService({
    displayDate: value => String(value || ""),
    todayInShanghai: () => dates[0], isAStockCode: () => true, isRiskStockName: () => false,
    recentLimitUpPools: async () => [makePool(dates[0]), makePool(dates[1])],
    recentTradingDates: async () => dates,
    selectLimitUpTradingDates: () => dates,
    topicPoolForDate: async (date, type, options) => {
      if (type === "failed" && options.forceRefresh) forced.push(date);
      return makePool(date);
    }
  });
  await service.getPreviousLimitUpFailedBoardSnapshot({ forceRefresh: true, refreshDate: dates[2] });
  assert.deepEqual(forced, [dates[2]]);
  forced.length = 0;
  await service.getPreviousLimitUpFailedBoardSnapshot({ forceRefresh: true, refreshDate: "2026-10-10" });
  assert.deepEqual(forced, [dates[0]]);
});

test("intersection uses the prior pool matching the latest failed-board date", async () => {
  const service = createFailedBoardHistoryService({
    displayDate: value => String(value || ""),
    todayInShanghai: () => dates[0], isAStockCode: () => true, isRiskStockName: () => false,
    recentLimitUpPools: async () => [makePool(dates[1], [{ code: "600002" }]), makePool(dates[2], [{ code: "600001" }])],
    recentTradingDates: async () => dates,
    selectLimitUpTradingDates: () => dates,
    topicPoolForDate: async date => makePool(date, [{ code: "600001" }, { code: "600002" }])
  });
  const result = await service.getPreviousLimitUpFailedBoardSnapshot();
  assert.equal(result.currentDate, dates[0]);
  assert.equal(result.previousDate, dates[1]);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.rows.map(row => row.code), ["600002"]);
  assert.equal(result.failedBoardDays[0].status, "ready");
});
