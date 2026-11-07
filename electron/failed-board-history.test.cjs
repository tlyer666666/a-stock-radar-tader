"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPreviousLimitUpFailedBoardSnapshot, topicPoolForDate } = require("./services.cjs");

const jsonResponse = value => ({ ok: true, json: async () => value });
const shanghaiDate = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

function recentWeekdays(count = 12) {
  const result = [];
  const cursor = new Date(`${shanghaiDate()}T12:00:00Z`);
  while (result.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return result.reverse();
}

function compact(date) {
  return date.replaceAll("-", "");
}

function failedRow(code, name) {
  return {
    c: code,
    m: 1,
    n: name,
    p: 12340,
    zdp: 5.2,
    amount: 123000000,
    hs: 3.4,
    lbc: 2,
    fbt: 93200,
    lbt: 101500,
    zbc: 2,
    hybk: "测试行业"
  };
}

test("returns five independent historical failed-board days despite later qdate, empty pools, and one source failure", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const dates = recentWeekdays();
  // 行情接口会按 datalen 请求足够多的 K 线（基准日历要 20 根），
  // 而 recentTradingDates 依赖的 sinaKline 有 minimumRows 校验：
  // 返回行数少于请求量会被判为截断响应并抛错。
  // 因此这里必须提供足量历史，否则基准日历拿不到数据、五日历史会退化成一天。
  const klineDates = recentWeekdays(40);
  const newest = dates.at(-1);
  const previous = dates.at(-2);
  const emptyDate = dates.at(-3);
  const failedDate = dates.at(-4);
  const failedRequests = [];

  global.fetch = async url => {
    const requestUrl = String(url);
    if (requestUrl.includes("quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData")) {
      // 按请求的 datalen 截取，模拟真实数据源「要多少给多少」的行为。
      const requested = Number(requestUrl.match(/[?&]datalen=(\d+)/)?.[1]) || klineDates.length;
      const rows = klineDates.slice(-Math.min(requested, klineDates.length));
      return jsonResponse({
        result: {
          data: rows.map((day, index) => ({
            day,
            open: 100 + index,
            close: 100.1 + index,
            high: 100.2 + index,
            low: 99.9 + index,
            volume: 100000
          }))
        }
      });
    }

    const requestDate = requestUrl.match(/[?&]date=(\d{8})/)?.[1] || "";
    if (requestUrl.includes("getTopicZTPool")) {
      const pool = [newest, previous].includes(`${requestDate.slice(0, 4)}-${requestDate.slice(4, 6)}-${requestDate.slice(6, 8)}`)
        ? [failedRow("600001", "昨日涨停样本")]
        : [];
      return jsonResponse({ data: { qdate: compact(newest), tc: pool.length, pool } });
    }

    if (requestUrl.includes("getTopicZBPool")) {
      failedRequests.push(requestDate);
      if (requestDate === compact(failedDate)) return jsonResponse({ data: null });
      const requested = `${requestDate.slice(0, 4)}-${requestDate.slice(4, 6)}-${requestDate.slice(6, 8)}`;
      const pool = requested === emptyDate
        ? []
        : [
            failedRow(requested === newest ? "600001" : "600002", `炸板样本${requested}`),
            ...(requested === newest ? [
              { c: "600003", m: 1, n: "缺字段样本" },
              failedRow("600004", "ST示例")
            ] : [])
          ];
      return jsonResponse({ data: { qdate: compact(newest), tc: pool.length, pool } });
    }

    throw new Error(`unexpected request: ${requestUrl}`);
  };

  const snapshot = await getPreviousLimitUpFailedBoardSnapshot({
    provider: "eastmoney",
    fallbackEnabled: false,
    multiSourceEnabled: false,
    forceRefresh: true
  });

  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.rows.map(row => row.code), ["600001"]);
  assert.deepEqual(snapshot.failedBoardDays.map(day => day.date), dates.slice(-5).reverse());
  assert.ok(failedRequests.includes(compact(failedDate)), `missing failure probe for ${failedDate}: ${failedRequests.join(",")}`);
  assert.deepEqual(snapshot.failedBoardDays.map(day => day.status), [
    "ready",
    "ready",
    "ready",
    "unavailable",
    "ready"
  ]);
  assert.equal(snapshot.failedBoardDays[0].rows[0].code, "600001");
  assert.equal(snapshot.failedBoardDays[0].rows[0].changePct, 5.2);
  assert.equal(snapshot.failedBoardDays[0].rows[1].amount, null);
  assert.equal(snapshot.failedBoardDays[0].rows[1].changePct, null);
  assert.equal(snapshot.failedBoardDays[0].rows.some(row => row.code === "600004"), false);
  assert.deepEqual(snapshot.failedBoardDays[2].rows, []);
  assert.equal(snapshot.failedBoardDays[2].status, "ready");
  assert.match(snapshot.failedBoardDays[3].error, /炸板池返回空数据/);
  assert.equal(snapshot.failedBoardDays[1].source.sourceLatestDate, newest);
  assert.notEqual(snapshot.failedBoardDays[1].date, snapshot.failedBoardDays[1].source.sourceLatestDate);
  assert.equal(new Set(failedRequests).size, 5);
});

test("historical failed-board pool uses the one-day cache lifetime even when qdate is later", async t => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  let now = originalNow();
  t.after(() => { global.fetch = originalFetch; });
  t.after(() => { Date.now = originalNow; });
  Date.now = () => now;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return jsonResponse({ data: { qdate: "20500103", tc: 0, pool: [] } });
  };

  const options = { provider: "eastmoney", fallbackEnabled: false };
  await topicPoolForDate("2049-12-29", "failed", options);
  now += 16_000;
  await topicPoolForDate("2049-12-29", "failed", options);

  assert.equal(requests, 1, "the second historical request should reuse the date-keyed pool cache");
});
