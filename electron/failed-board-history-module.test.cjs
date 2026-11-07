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
