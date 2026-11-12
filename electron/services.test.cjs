require("../qa/test-env.cjs"); // 自防御：不依赖运行器预加载，直接 node --test 本文件也禁网
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  priceLimitRate,
  incompleteBacktestBarAllowance,
  isRiskStockName,
  toSecurity,
  searchSecurities,
  analyzeSecurity,
  getQuoteSnapshot,
  getChart,
  conceptRootName,
  extractThsConceptRows,
  extractThsSectorMembers,
  parseSinaSectorCatalog,
  matchSinaSector,
  normalizeSinaSectorMembers,
  buildSectorStrengthFromData,
  SECTOR_PROVIDER_PRIORITY,
  buildFreeConceptGroups,
  buildSectorBreadthDiagnostics,
  eastPriceFromRaw,
  normalizeTencentQuote,
  isConvertibleBondCode,
  assetTypeFromExactCode,
  searchableAssetType,
  normalizeSearchSecurity,
  resolveBacktestSecurity,
  analyzeHistory,
  average,
  returnFor,
  buildTradeExecutionReadiness,
  strategyDefinitionsFor,
  validateHistoryRows,
  withSingleFlightCache,
  selectLimitUpTradingDates,
  normalizeThsLimitUpItem,
  mergeThsAndEastmoneyLimitPool,
  extractThsTable,
  normalizeThsHistoryTable,
  discoverLimitUps,
  currentLadderPools,
  buildSequentialSamplePath,
  buildSingleStockTradeLedger,
  singleStockBacktestLookbackBars,
  normalizeSingleBacktestDate,
  loadBacktestHistory,
  getStrategyDefinitions,
  curlExecutable,
  runPortfolioBacktest,
  runBacktest,
  mergeBacktestSettings,
  safeBacktestStrategyProfile
} = require("./services.cjs");

const recentDate = (offset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

const shanghaiDate = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

const compactDate = (date = shanghaiDate()) => String(date).replaceAll("-", "");

const mockRecentSinaHistory = (length = 24) => {
  const end = new Date(`${shanghaiDate()}T00:00:00Z`);
  return Array.from({ length }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (length - 1 - index));
    return {
      day: date.toISOString().slice(0, 10),
      open: "10",
      close: "10.1",
      high: "10.2",
      low: "9.9",
      volume: "100000"
    };
  });
};

const mockRecentEastHistory = (length = 24) => mockRecentSinaHistory(length).map((row) => [
  row.day,
  row.open,
  row.close,
  row.high,
  row.low,
  row.volume,
  "1010000",
  "3",
  "1",
  "0.1",
  "1.2"
].join(","));

const mockJsonResponse = (value) => ({
  ok: true,
  json: async () => value
});

test("curl fallback resolves the native executable for each desktop platform", () => {
  assert.equal(curlExecutable("win32"), "curl.exe");
  assert.equal(curlExecutable("darwin"), "curl");
  assert.equal(curlExecutable("linux"), "curl");
});

test("single-stock backtest dates reject impossible calendar values", () => {
  assert.equal(normalizeSingleBacktestDate("2026-02-28"), "2026-02-28");
  assert.equal(normalizeSingleBacktestDate("2024-02-29"), "2024-02-29");
  assert.equal(normalizeSingleBacktestDate("2026-02-29"), "");
  assert.equal(normalizeSingleBacktestDate("2026-02-30"), "");
  assert.equal(normalizeSingleBacktestDate("2026-02-28junk"), "");
});

test("trade readiness uses its documented fill-rate fallback instead of a clamp boundary", () => {
  const result = buildTradeExecutionReadiness(
    { qualification: { riskVetoPassed: true }, riskPenalty: 0, mrs: 80 },
    { signal: "BUY", positionSizePercent: 10, riskReward: 2 },
    { minExecutionRatePercent: 90 }
  );

  assert.equal(result.status, "PASS");
  assert.equal(result.canExecute, true);
  assert.equal(result.reasons.some((reason) => reason.includes("预计成交率")), false);
});

test("history validation rejects malformed, duplicate and stale rows before strategy use", () => {
  const valid = validateHistoryRows([
    { date: recentDate(-2), open: 10, high: 10.5, low: 9.8, close: 10.2, volume: 100 },
    { date: recentDate(-1), open: 10.2, high: 10.8, low: 10.1, close: 10.6, volume: 200 },
    { date: recentDate(-1), open: 10.2, high: 10.8, low: 10.1, close: 10.6, volume: 200 },
    { date: recentDate(0), open: 10.6, high: 10.2, low: 10.5, close: 10.4, volume: 50 }
  ], { source: "test", minimumRows: 2 });
  assert.equal(valid.length, 2);
  assert.throws(() => validateHistoryRows([
    { date: "2020-01-02", open: 10, high: 11, low: 9, close: 10, volume: 10 }
  ], { source: "test" }), /stale/i);
  assert.throws(() => validateHistoryRows([
    { date: recentDate(0), open: 10, high: 9, low: 10, close: 10, volume: 10 }
  ], { source: "test" }), /usable rows/i);
});

test("public quote and chart entry points return their documented production contracts", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const chartRows = Array.from({ length: 140 }, (_, index) => {
    const date = new Date("2026-01-01T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + index);
    const close = 10 + index / 100;
    return [
      date.toISOString().slice(0, 10),
      close - 0.05,
      close,
      close + 0.1,
      close - 0.1,
      100000 + index,
      1000000 + index,
      2,
      0.5,
      0.05,
      1.2
    ].join(",");
  });
  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/stock/get?")) {
      return mockJsonResponse({
        data: {
          f43: 1234,
          f44: 1250,
          f45: 1200,
          f46: 1210,
          f47: 100000,
          f48: 123400000,
          f50: 110,
          f51: 1357,
          f52: 1111,
          f57: "600519",
          f58: "贵州茅台",
          f59: 2,
          f60: 1220,
          f116: 1000000000,
          f117: 800000000,
          f127: "白酒",
          f168: 250,
          f169: 14,
          f170: 115,
          f171: 410
        }
      });
    }
    if (requestUrl.includes("/stock/kline/get?")) {
      return mockJsonResponse({ data: { klines: chartRows } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const quote = await getQuoteSnapshot("600519", { provider: "eastmoney" });
  assert.equal(quote.actualProvider, "eastmoney");
  assert.equal(quote.primaryStatus, "active");
  assert.equal(quote.quote.code, "600519");
  assert.equal(quote.quote.latest, 12.34);
  assert.ok(Number.isFinite(Date.parse(quote.updatedAt)));

  const chart = await getChart("600518", "101", {
    range: "3m",
    limit: 20,
    adjustment: "front",
    forceRefresh: true
  });
  assert.ok(Array.isArray(chart.rows));
  assert.equal(chart.rows.length, 140);
  assert.equal(chart.interval, "101");
  assert.equal(chart.visibleLimit, 20);
  assert.equal(chart.dataSource, "eastmoney");
  assert.equal(chart.availableFrom, chart.rows[0].date);
  assert.equal(chart.availableTo, chart.rows.at(-1).date);
});

test("service entry points reject inconsistent identifiers before any network request", async () => {
  const invalid = { code: "600519", secid: "0.600519", thscode: "600519.SH" };
  await assert.rejects(getQuoteSnapshot(invalid), /Invalid secid/);
  await assert.rejects(getChart(invalid, "101"), /Invalid secid/);
  await assert.rejects(analyzeSecurity(invalid), /Invalid secid/);
});

test("THS official nested tables are unwrapped and truncated without date-price misalignment", () => {
  const table = extractThsTable({
    tables: [{
      thscode: "600000.SH",
      time: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"],
      table: {
        open: [10, 11, 12, 13],
        high: [10.5, 11.5, 12.5, 13.5],
        low: [9.5, 10.5, 11.5, 12.5],
        close: [10.2, 11.2, 12.2, 13.2],
        volume: [100, 110, 120, 130],
        amount: [1000, 1100, 1200, 1300],
        changeRatio: [1, 2, 3, 4],
        turnoverRatio: [0.5, 0.6, 0.7, 0.8]
      }
    }]
  });
  assert.equal(table.thscode, "600000.SH");
  assert.deepEqual(table.open, [10, 11, 12, 13]);
  const rows = normalizeThsHistoryTable(table, 2);
  assert.deepEqual(rows.map((row) => row.date), ["2026-08-05", "2026-08-06"]);
  assert.deepEqual(rows.map((row) => row.open), [12, 13]);
  assert.deepEqual(rows.map((row) => row.close), [12.2, 13.2]);
});

test("market-wide loaders share a single in-flight request", async () => {
  const cache = { value: null, expiresAt: 0, promise: null };
  let calls = 0;
  const load = () => withSingleFlightCache(cache, 1000, async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value: 7 };
  });
  const rows = await Promise.all([load(), load(), load(), load()]);
  assert.equal(calls, 1);
  assert.deepEqual(rows, [{ value: 7 }, { value: 7 }, { value: 7 }, { value: 7 }]);
  assert.equal(cache.promise, null);
  assert.equal((await load()).value, 7);
  assert.equal(calls, 1);
});

test("forced single-flight refresh bypasses a fresh cached value", async () => {
  const cache = {
    value: { value: "old" },
    expiresAt: Date.now() + 60_000,
    promise: null
  };
  let calls = 0;
  const fresh = await withSingleFlightCache(cache, 1000, async () => {
    calls += 1;
    return { value: "fresh" };
  }, { forceRefresh: true });
  assert.equal(calls, 1);
  assert.equal(fresh.value, "fresh");
  assert.equal(cache.value.value, "fresh");
});

test("concurrent forced refreshes share one fresh request", async () => {
  const cache = { value: null, expiresAt: 0, promise: null };
  let calls = 0;
  const load = () => withSingleFlightCache(cache, 1000, async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value: "fresh" };
  }, { forceRefresh: true });
  const values = await Promise.all([load(), load(), load()]);
  assert.equal(calls, 1);
  assert.deepEqual(values, [
    { value: "fresh" },
    { value: "fresh" },
    { value: "fresh" }
  ]);
});

test("intraday limit-up dates prefer a server-confirmed today over yesterday daily bars", () => {
  const dates = selectLimitUpTradingDates(
    "2026-08-06",
    {
      date: "2026-08-06",
      serverTradingDate: "2026-08-06",
      pool: [{ code: "002180" }]
    },
    ["2026-08-05", "2026-08-04", "2026-08-03"],
    3
  );
  assert.deepEqual(dates, ["2026-08-06", "2026-08-05", "2026-08-04"]);
});

test("a confirmed trading day remains current when the valid limit-up pool is empty", () => {
  const dates = selectLimitUpTradingDates(
    "2026-08-06",
    {
      date: "2026-08-06",
      serverTradingDate: "2026-08-06",
      pool: []
    },
    ["2026-08-05", "2026-08-04"],
    2
  );
  assert.deepEqual(dates, ["2026-08-06", "2026-08-05"]);
});

test("a holiday candidate falls back to the latest server-confirmed trading date", () => {
  const dates = selectLimitUpTradingDates(
    "2026-08-08",
    {
      date: "2026-08-08",
      serverTradingDate: "2026-08-07",
      pool: []
    },
    ["2026-08-07", "2026-08-06", "2026-08-05"],
    2
  );
  assert.deepEqual(dates, ["2026-08-07", "2026-08-06"]);
});

test("THS normalization preserves missing fields as unknown and does not invent first-seal or industry data", () => {
  const lastSealEpoch = Math.floor(Date.parse("2026-08-06T09:31:15+08:00") / 1000);
  const row = normalizeThsLimitUpItem({
    code: "603221",
    name: "爱丽家居",
    latest: 24.79,
    change_rate: 9.9823,
    turnover_rate: 6.6058,
    order_volume: 2641531,
    last_limit_up_time: String(lastSealEpoch),
    reason_type: "复牌+拟收购欧康诺+存储测试+PVC地板",
    limit_up_type: "T字板",
    high_days: "",
    is_again_limit: 1
  }, "2026-08-06");

  assert.equal(row.amount, null);
  assert.equal(row.floatMarketCap, null);
  assert.equal(row.totalMarketCap, null);
  assert.equal(row.openBoardCount, null);
  assert.equal(row.consecutiveBoards, null);
  assert.equal(row.firstSealTime, "");
  assert.equal(row.firstSealRaw, null);
  assert.equal(row.lastSealTime, "09:31:15");
  assert.equal(row.industry, "未分类");
  assert.equal(row.limitReason, "复牌+拟收购欧康诺+存储测试+PVC地板");
  assert.equal(row.boardType, "T字板");
  assert.equal(row.sealFloatRatio, null);
  assert.equal(row.tradedFloatRatio, null);
});

test("A2-04 a sealed amount missing from both limit-up sources is unknown (null), never 0", () => {
  // THS 侧没有封单量 → decorateLimitPoolItem 的 fund 兜底会写 0；merge 必须还原成 null，
  // 否则封单占比 = 0% 会被界面读成"封单极弱"，而真实情况是"没拿到"。
  const withoutOrderVolume = normalizeThsLimitUpItem({
    code: "600001", name: "样本甲", latest: 20, amount: 100000000, ltsz: 1000000000, high_days: "首板"
  }, "2026-10-19");
  assert.equal(withoutOrderVolume.sealedAmount, null, "缺失封单量不能变成 0 元封单");
  assert.equal(withoutOrderVolume.sealFloatRatio, null);

  const merged = mergeThsAndEastmoneyLimitPool(
    { pool: [withoutOrderVolume] },
    { pool: [{ code: "600001", sealedAmount: 0, floatMarketCap: 1000000000 }] }
  ).pool[0];
  assert.equal(merged.sealedAmount, null, "双源缺失（east 的 0 只是占位）时保持 null");
  assert.equal(merged.sealFloatRatio, null, "封单占比在缺值时必须是未知，不能是 0%");

  // 东财有真实封单额时仍然回填；两家都有时优先 THS 原生值。
  const eastOnly = mergeThsAndEastmoneyLimitPool(
    { pool: [withoutOrderVolume] },
    { pool: [{ code: "600001", sealedAmount: 50000000, floatMarketCap: 1000000000 }] }
  ).pool[0];
  assert.equal(eastOnly.sealedAmount, 50000000);
  assert.equal(eastOnly.sealFloatRatio, 0.05);

  const bothSources = mergeThsAndEastmoneyLimitPool(
    { pool: [normalizeThsLimitUpItem({ code: "600002", name: "样本乙", latest: 20, order_volume: 5000, ltsz: 1000000000 }, "2026-10-19")] },
    { pool: [{ code: "600002", sealedAmount: 90000000, floatMarketCap: 1000000000 }] }
  ).pool[0];
  assert.equal(bothSources.sealedAmount, 100000, "THS 封单额 = 最新价 × 封单量");
  assert.equal(bothSources.sealFloatRatio, 0.0001);
});

test("E-06 average() and returnFor() return null for missing samples instead of a fake zero", () => {
  assert.equal(average([]), null, "空样本是未知，不是均值 0");
  assert.equal(average([Number.NaN, undefined, null]), null);
  assert.equal(average([1, 3]), 2, "有样本时口径不变");

  const history = (closes) => closes.map((close, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, close }));
  assert.equal(returnFor(history([10, 11]), 3), null, "不足 days+1 根 K 线 = 未知，不是 0%");
  assert.equal(returnFor(history([0, 10, 11, 12]), 3), null, "基准价为 0 时不能返回 Infinity 或 0");
  assert.ok(Math.abs(returnFor(history([10, 10, 10, 13]), 3) - 30) < 1e-9, "有样本时口径不变");
});

test("E-06 an uncomputable 3-day return keeps relative sector strength unknown and never awards sector points", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    open: 10, high: 10.2, low: 9.8, close: 10, volume: 100, amount: 100000, turnover: 2
  }));
  rows[26] = { ...rows[26], close: 0, high: 0, low: 0, open: 0 }; // history.at(-4) 基准价为 0
  const sector = { returns: { r3: 1.5 }, score: 70, memberCount: 20 };
  const analysis = analyzeHistory({ code: "600001" }, { name: "样本", latest: 10 }, rows, sector, null, [], []);
  assert.equal(analysis.stockReturn3, null);
  assert.equal(analysis.rsSector, null, "样本不足/基准异常时相对板块是未知，不是 0% 超额");
  assert.equal(analysis.sectorLeader, false, "未知不能被当成 rsSector >= 0");
  const strategies = strategyDefinitionsFor(analysis, { latest: 10 });
  const sectorStrategy = strategies.find((item) => item.id === "sector");
  assert.equal(sectorStrategy.matched, false, "null >= 0 的隐式成立必须被挡住");
  assert.match(sectorStrategy.detail, /未知/);
  assert.match(strategies.find((item) => item.id === "sectorLeader").detail, /未知/, "展示层不能在 null 上调用 toFixed");
});

test("THS primary pool is enriched from Eastmoney and retains Eastmoney-only Beijing stocks", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const today = shanghaiDate();
  const todayCompact = compactDate(today);
  const lastSealEpoch = Math.floor(Date.parse(`${today}T09:31:15+08:00`) / 1000);
  const thsRow = {
    code: "603221",
    name: "爱丽家居",
    latest: 24.79,
    change_rate: 9.9823,
    turnover_rate: 6.6058,
    order_volume: 2641531,
    last_limit_up_time: String(lastSealEpoch),
    reason_type: "复牌+拟收购欧康诺+存储测试+PVC地板",
    limit_up_type: "T字板",
    high_days: "10天10板",
    is_again_limit: 1
  };
  const eastRows = [
    {
      c: "603221", m: 1, n: "爱丽家居", p: 24790, zdp: 9.9823,
      amount: 396490928, ltsz: 6005873300, tshare: 6005873300,
      hs: 6.6058, lbc: 10, fbt: 92501, lbt: 93115,
      fund: 65483553, zbc: 1, hybk: "家居用品", zttj: { days: 21, ct: 11 }
    },
    {
      c: "920117", m: 0, n: "龙鑫智能", p: 18120, zdp: 29.989,
      amount: 128000000, ltsz: 1800000000, tshare: 2600000000,
      hs: 8.2, lbc: 1, fbt: 94500, lbt: 94500,
      fund: 21000000, zbc: 0, hybk: "专用设备", zttj: { days: 1, ct: 1 }
    }
  ];

  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("data.10jqka.com.cn/dataapi/limit_up/limit_up_pool")) {
      return mockJsonResponse({
        status_code: 0,
        data: { info: [thsRow], page: { total: 1 } }
      });
    }
    if (requestUrl.includes("push2ex.eastmoney.com/getTopicZTPool")) {
      return mockJsonResponse({
        data: { qdate: todayCompact, tc: eastRows.length, pool: eastRows }
      });
    }
    if (requestUrl.includes("quotes.sina.cn/")) {
      return mockJsonResponse({ result: { data: mockRecentSinaHistory() } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const snapshot = await discoverLimitUps({
    provider: "ths",
    fallbackEnabled: true,
    multiSourceEnabled: true,
    forceRefresh: true
  });
  const { rows, meta } = snapshot;
  const shared = rows.find((item) => item.code === "603221");
  const beijingOnly = rows.find((item) => item.code === "920117");

  assert.equal(rows.length, 2);
  assert.ok(shared);
  assert.equal(shared.industry, "家居用品");
  assert.equal(shared.amount, 396490928);
  assert.equal(shared.floatMarketCap, 6005873300);
  assert.equal(shared.totalMarketCap, 6005873300);
  assert.equal(shared.firstSealTime, "09:25:01");
  assert.equal(shared.openBoardCount, 1);
  assert.equal(shared.dataProvider, "ths_public_limit_up");
  assert.deepEqual(shared.verificationProviders, ["eastmoney_topic_pool"]);
  assert.ok(beijingOnly);
  assert.equal(beijingOnly.thscode, "920117.BJ");
  assert.equal(beijingOnly.dataProvider, "eastmoney_topic_pool");
  assert.equal(beijingOnly.primaryProviderMissing, true);
  assert.deepEqual(meta.providers, [
    "ths_public_limit_up",
    "eastmoney_topic_pool"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).meta, meta);
});

test("a valid but empty THS response does not hide a non-empty Eastmoney pool", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const todayCompact = compactDate();
  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("data.10jqka.com.cn/dataapi/limit_up/limit_up_pool")) {
      return mockJsonResponse({
        status_code: 0,
        data: { info: [], page: { total: 0 } }
      });
    }
    if (requestUrl.includes("push2ex.eastmoney.com/getTopicZTPool")) {
      return mockJsonResponse({
        data: {
          qdate: todayCompact,
          tc: 1,
          pool: [{
            c: "600003", m: 1, n: "东财补位样本", p: 13200, zdp: 10,
            amount: 88000000, ltsz: 900000000, tshare: 1100000000,
            hs: 4, lbc: 1, fbt: 93200, lbt: 93200,
            fund: 9000000, zbc: 0, hybk: "机械设备", zttj: { days: 1, ct: 1 }
          }]
        }
      });
    }
    if (requestUrl.includes("quotes.sina.cn/")) {
      return mockJsonResponse({ result: { data: mockRecentSinaHistory() } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const snapshot = await discoverLimitUps({
    provider: "ths",
    fallbackEnabled: true,
    multiSourceEnabled: true,
    forceRefresh: true
  });
  const { rows, meta } = snapshot;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "600003");
  assert.equal(rows[0].dataProvider, "eastmoney_topic_pool");
  assert.equal(rows[0].primaryProviderMissing, true);
  assert.deepEqual(meta.providers, [
    "ths_public_limit_up",
    "eastmoney_topic_pool"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).meta, meta);
});

test("ladder caches are isolated by configured primary provider", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const today = shanghaiDate();
  const todayCompact = compactDate(today);
  const lastSealEpoch = Math.floor(Date.parse(`${today}T09:35:00+08:00`) / 1000);

  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("data.10jqka.com.cn/dataapi/limit_up/limit_up_pool")) {
      return mockJsonResponse({
        status_code: 0,
        data: {
          info: [{
            code: "600002",
            name: "THS独立样本",
            latest: 12,
            change_rate: 10,
            turnover_rate: 3,
            order_volume: 10000,
            first_limit_up_time: String(lastSealEpoch),
            last_limit_up_time: String(lastSealEpoch),
            high_days: "1天1板",
            change_tag: "FIRST_LIMIT"
          }],
          page: { total: 1 }
        }
      });
    }
    if (requestUrl.includes("push2ex.eastmoney.com/getTopicZBPool")) {
      return mockJsonResponse({ data: { qdate: todayCompact, tc: 0, pool: [] } });
    }
    if (requestUrl.includes("push2ex.eastmoney.com/getTopicZTPool")) {
      return mockJsonResponse({
        data: {
          qdate: todayCompact,
          tc: 1,
          pool: [{
            c: "600001", m: 1, n: "东财独立样本", p: 11000, zdp: 10,
            amount: 1000000, ltsz: 10000000, tshare: 12000000,
            hs: 2, lbc: 1, fbt: 93000, lbt: 93000,
            fund: 100000, zbc: 0, hybk: "测试行业", zttj: { days: 1, ct: 1 }
          }]
        }
      });
    }
    if (requestUrl.includes("quotes.sina.cn/")) {
      return mockJsonResponse({ result: { data: mockRecentSinaHistory() } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const eastmoney = await currentLadderPools({
    provider: "eastmoney",
    fallbackEnabled: false,
    multiSourceEnabled: false,
    forceRefresh: true
  });
  const ths = await currentLadderPools({
    provider: "ths",
    fallbackEnabled: false,
    multiSourceEnabled: false,
    forceRefresh: false
  });

  assert.equal(eastmoney.currentPool[0].code, "600001");
  assert.equal(ths.currentPool[0].code, "600002");
  assert.notStrictEqual(eastmoney, ths);
});

test("historical sample path uses real dates, costs and non-overlapping settled samples", () => {
  const samplePath = buildSequentialSamplePath([
    { entryDate: "2026-01-02", exitDate: "2026-01-08", node: 3, r5: 10 },
    { entryDate: "2026-01-05", exitDate: "2026-01-09", node: 5, r5: 80 },
    { entryDate: "2026-01-09", exitDate: "2026-01-15", node: 3, r5: -4 }
  ], {
    startingCapital: 100000,
    positionPercent: 50,
    roundTripCostPercent: 0.2
  });
  assert.equal(samplePath.points.length, 2);
  assert.equal(samplePath.skippedOverlaps, 1);
  assert.equal(samplePath.points[0].entryDate, "2026-01-02");
  assert.equal(samplePath.points[0].netReturnPercent, 9.8);
  assert.equal(samplePath.points[1].exitDate, "2026-01-15");
  assert.ok(samplePath.endingCapital > 100000);
});

test("single-stock backtest history window follows the selected start date", () => {
  const now = new Date("2026-08-11T00:00:00Z");
  assert.equal(singleStockBacktestLookbackBars(undefined), 120);
  assert.equal(singleStockBacktestLookbackBars(720), 720);
  assert.equal(singleStockBacktestLookbackBars(80), 120);
  assert.equal(singleStockBacktestLookbackBars(120, "2025-08-11", now), 381);
  assert.equal(singleStockBacktestLookbackBars(120, "2026-08-01", now), 128);
  assert.equal(singleStockBacktestLookbackBars(120, "2010-01-01", now), 4000);
});

test("single-stock trade ledger preserves every trade and compounds account profit", () => {
  const ledger = buildSingleStockTradeLedger([
    {
      signalDate: "2026-01-01",
      strategyId: "low_first_board",
      strategyIds: ["low_first_board", "trend_first_board"],
      entryPriceSource: "custom_limit_price",
      entryDate: "2026-01-02",
      exitDate: "2026-01-08",
      entryPrice: 10,
      exitPrice: 11,
      grossReturn: 10.2,
      netReturn: 10,
      benchmarkReturn: 1,
      excessReturn: 9
    },
    {
      signalDate: "2026-01-08",
      entryDate: "2026-01-09",
      exitDate: "2026-01-15",
      entryPrice: 20,
      exitPrice: 19,
      grossReturn: -4.8,
      netReturn: -5,
      benchmarkReturn: -1,
      excessReturn: -4
    }
  ], {
    startingCapital: 100000,
    positionPercent: 100,
    roundTripCostPercent: 0.2
  });
  assert.equal(ledger.trades.length, 2);
  assert.equal(ledger.trades[0].entryPrice, 10);
  assert.deepEqual(ledger.trades[0].strategyIds, ["low_first_board", "trend_first_board"]);
  assert.equal(ledger.trades[0].entryPriceSource, "custom_limit_price");
  assert.equal(ledger.trades[1].exitDate, "2026-01-15");
  assert.equal(ledger.summary.profitableTrades, 1);
  assert.equal(ledger.summary.losingTrades, 1);
  assert.equal(ledger.summary.winRatePercent, 50);
  assert.equal(ledger.summary.endingCapital, 104500);
  assert.equal(ledger.summary.totalProfitAmount, 4500);
  assert.equal(ledger.summary.totalNetReturnPercent, 4.5);
  assert.equal(ledger.summary.maxDrawdownPercent, -5);
});

test("price limit rates follow board and ST rules", () => {
  assert.equal(priceLimitRate("600000", "浦发银行"), 0.1);
  assert.equal(priceLimitRate("300750", "宁德时代"), 0.2);
  assert.equal(priceLimitRate("688981", "中芯国际"), 0.2);
  assert.equal(priceLimitRate("600000", "ST测试"), 0.1);
  assert.equal(priceLimitRate("600000", "ST测试", "2026-07-05"), 0.05);
  assert.equal(priceLimitRate("600000", "ST测试", "2026-07-06"), 0.1);
  assert.equal(priceLimitRate("300001", "ST测试", "2020-08-23"), 0.05);
  assert.equal(priceLimitRate("300001", "ST测试", "2020-08-24"), 0.2);
  assert.equal(priceLimitRate("300001", "ST历史改名", "2026-07-06", false), 0.2);
  assert.equal(priceLimitRate("920000", "北交所测试"), 0.3);
});

test("302 ChiNext securities retain Shenzhen identity and the 20 percent board rule", () => {
  const security = toSecurity({ code: "302132", name: "中航成飞" });
  assert.equal(security.secid, "0.302132");
  assert.equal(security.thscode, "302132.SZ");
  assert.equal(priceLimitRate("302132", "中航成飞"), 0.2);
  assert.equal(security.assetType, "stock");
  assert.throws(() => toSecurity("303132"));
  const service = require("./services.cjs");
  const diversity = service.buildStrategySampleDiversity([security]);
  assert.equal(diversity.boardBuckets["创业板"], 1);
  assert.deepEqual(service.selectIndependentValidationSample([security], 1).map(row => row.code), ["302132"]);
});

test("security identifiers are normalized", () => {
  assert.equal(toSecurity("600000").secid, "1.600000");
  assert.equal(toSecurity("000001").thscode, "000001.SZ");
  assert.equal(
    toSecurity({ code: "600519", industry: "白酒" }).industry,
    "白酒"
  );
});

test("security identifiers are canonical and exchange-consistent for SH, SZ and BJ", () => {
  assert.deepEqual(
    ["600519", "000001", "300750", "688981", "430047", "830799", "920117"]
      .map((code) => {
        const security = toSecurity(code);
        return [security.code, security.secid, security.thscode];
      }),
    [
      ["600519", "1.600519", "600519.SH"],
      ["000001", "0.000001", "000001.SZ"],
      ["300750", "0.300750", "300750.SZ"],
      ["688981", "1.688981", "688981.SH"],
      ["430047", "0.430047", "430047.BJ"],
      ["830799", "0.830799", "830799.BJ"],
      ["920117", "0.920117", "920117.BJ"]
    ]
  );
  assert.equal(toSecurity("920117.bj").thscode, "920117.BJ");
});

test("malicious or inconsistent code, secid, QuoteID and thscode values fail closed", async () => {
  assert.throws(
    () => toSecurity({ code: "600519&fields=f43" }),
    /exactly 6 digits/i
  );
  assert.throws(
    () => toSecurity({ code: "600519", secid: "1.600519&fields=f43" }),
    /Invalid secid/i
  );
  assert.throws(
    () => toSecurity({ code: "600519", QuoteID: "0.600519" }),
    /Invalid QuoteID/i
  );
  assert.throws(
    () => toSecurity({ code: "600519", thscode: "600519.SH,000001.SZ" }),
    /Invalid thscode/i
  );
  assert.throws(
    () => toSecurity({ code: "600519", secid: "0.600519" }),
    /Invalid secid/i
  );
  assert.throws(
    () => toSecurity({ code: "920117", thscode: "920117.SZ" }),
    /Invalid thscode/i
  );
  await assert.rejects(
    resolveBacktestSecurity({ code: "600519&provider=ths" }),
    /exactly 6 digits/i
  );

  assert.equal(normalizeSearchSecurity({
    Code: "600519&fields=f43",
    Name: "malicious",
    Classify: "AStock",
    MktNum: "1",
    QuoteID: "1.600519"
  }), null);
  assert.equal(normalizeSearchSecurity({
    Code: "600519",
    Name: "malicious",
    Classify: "AStock",
    MktNum: "1",
    QuoteID: "1.600519&fields=f43"
  }), null);
  assert.equal(normalizeSearchSecurity({
    Code: "600519",
    Name: "wrong exchange",
    Classify: "AStock",
    MktNum: "0",
    QuoteID: "0.600519"
  }), null);
});

test("search query metacharacters stay inside the encoded input parameter", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let capturedUrl = "";
  global.fetch = async (url) => {
    capturedUrl = String(url);
    return mockJsonResponse({ QuotationCodeTable: { Data: [] } });
  };

  const maliciousQuery = "600000&count=999&type=1#fragment";
  assert.deepEqual(await searchSecurities(maliciousQuery), []);
  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("input"), maliciousQuery);
  assert.deepEqual(parsed.searchParams.getAll("count"), ["40"]);
  assert.deepEqual(parsed.searchParams.getAll("type"), ["14"]);
  assert.equal(parsed.hash, "");
});

test("backtest security resolver accepts a code or one uniquely matched A-share name", async () => {
  let searchCalls = 0;
  const search = async (query) => {
    searchCalls += 1;
    assert.equal(query, "贵州茅台");
    return [
      {
        code: "600519",
        name: "贵州茅台",
        secid: "1.600519",
        thscode: "600519.SH",
        assetType: "stock"
      },
      {
        code: "600199",
        name: "金种子酒",
        secid: "1.600199",
        thscode: "600199.SH",
        assetType: "stock"
      }
    ];
  };
  const byName = await resolveBacktestSecurity("贵州茅台", search);
  assert.equal(byName.code, "600519");
  assert.equal(byName.name, "贵州茅台");
  assert.equal(byName.assetType, "stock");
  assert.equal(searchCalls, 1);

  const byCode = await resolveBacktestSecurity("000001.SZ", async () => {
    throw new Error("代码输入不应调用证券搜索");
  });
  assert.equal(byCode.code, "000001");
  assert.equal(byCode.thscode, "000001.SZ");
});

test("backtest security resolver rejects ambiguous, missing and non-stock inputs clearly", async () => {
  await assert.rejects(
    resolveBacktestSecurity("银行", async () => [
      { code: "000001", name: "平安银行", assetType: "stock" },
      { code: "600036", name: "招商银行", assetType: "stock" }
    ]),
    /对应多只A股.*000001.*600036.*6位代码/
  );
  await assert.rejects(
    resolveBacktestSecurity("不存在股份", async () => []),
    /未找到.*对应的A股/
  );
  await assert.rejects(
    resolveBacktestSecurity("沪深300ETF", async () => [
      { code: "510300", name: "沪深300ETF", assetType: "etf" }
    ]),
    /未找到.*对应的A股/
  );
  await assert.rejects(
    resolveBacktestSecurity({
      code: "510300",
      name: "沪深300ETF",
      assetType: "etf"
    }),
    /回测仅支持A股股票/
  );
});

test("backtest history uses THS first, Eastmoney second, then the public relay", async () => {
  const security = toSecurity({ code: "600519", name: "贵州茅台" });
  const calls = [];
  const thsRows = [{ date: "2026-07-31", close: 1400 }];
  const eastmoneyRows = [{ date: "2026-07-31", close: 1399.5 }];
  const publicRows = [{ date: "2026-07-31", close: 1399 }];
  const preferred = await loadBacktestHistory(
    security,
    { provider: "ths", refreshToken: "token", fallbackEnabled: true },
    260,
    {
      ths: async (target, bars) => {
        calls.push(`ths:${target.code}:${bars}`);
        return thsRows;
      },
      eastmoney: async () => {
        calls.push("eastmoney");
        return eastmoneyRows;
      },
      public: async () => {
        calls.push("public");
        return publicRows;
      }
    }
  );
  assert.equal(preferred, thsRows);
  assert.deepEqual(calls, ["ths:600519:260"]);

  calls.length = 0;
  const secondary = await loadBacktestHistory(
    security,
    { provider: "ths", refreshToken: "token", fallbackEnabled: true },
    260,
    {
      ths: async () => {
        calls.push("ths");
        throw new Error("timeout");
      },
      eastmoney: async () => {
        calls.push("eastmoney");
        return eastmoneyRows;
      },
      public: async () => {
        calls.push("public");
        return publicRows;
      }
    }
  );
  assert.equal(secondary, eastmoneyRows);
  assert.deepEqual(calls, ["ths", "eastmoney"]);

  calls.length = 0;
  const relay = await loadBacktestHistory(
    security,
    { provider: "ths", refreshToken: "token", fallbackEnabled: true },
    260,
    {
      ths: async () => {
        calls.push("ths");
        throw new Error("timeout");
      },
      eastmoney: async () => {
        calls.push("eastmoney");
        throw new Error("rate limited");
      },
      public: async () => {
        calls.push("public");
        return publicRows;
      }
    }
  );
  assert.equal(relay, publicRows);
  assert.deepEqual(calls, ["ths", "eastmoney", "public"]);

  await assert.rejects(
    loadBacktestHistory(
      security,
      { provider: "ths", refreshToken: "token", fallbackEnabled: false },
      260,
      { ths: async () => { throw new Error("token expired"); } }
    ),
    /同花顺历史行情获取失败.*token expired/
  );
});

test("amount-dependent backtest history replaces an incomplete public feed with verified raw bars", async () => {
  const security = toSecurity({ code: "600825", name: "新华传媒" });
  const complete = Array.from({length:120}, (_, i) => ({date:recentDate(i-120),open:10,high:11,low:9,close:10,volume:100,amount:123456}));
  const missing = complete.map(row => ({...row,amount:null})); let repairs=0;
  const rows = await loadBacktestHistory(security, {fallbackEnabled:true},120, {
    eastmoney:async()=>{throw Error("network");}, public:async()=>missing,
    completeRaw:async(target,bars)=>{repairs++;assert.equal(target.code,"600825");assert.equal(bars,120);return {rows:complete,adjustment:"none",source:"sohu+tencent-raw",provenance:{amountUnit:"CNY"}};}
  }, {requireAmount:true});
  assert.equal(repairs,1);assert.equal(rows[0].amount,123456);assert.equal(rows[0].close,10);
  assert.equal(rows.actualAdjustment,0);assert.equal(rows.dataSource,"sohu+tencent-raw");
});

test("amount-dependent history cannot return false zero-signal evidence on missing fields, short windows or wrong adjustment", async () => {
  const complete = Array.from({length:120}, (_, i) => ({date:recentDate(i-120),open:10,high:11,low:9,close:10,volume:100,amount:123456}));
  for(const replacement of [
    {rows:complete.map(row=>({...row,amount:null})),adjustment:"none"},
    {rows:complete.map(row=>({...row,volume:null})),adjustment:"none"},
    {rows:complete.slice(-80),adjustment:"none"},
    {rows:complete,adjustment:"front"}
  ]) await assert.rejects(loadBacktestHistory(toSecurity("600825"),{fallbackEnabled:true},120,{
    eastmoney:async()=>complete.map(row=>({...row,amount:null})),public:async()=>[],completeRaw:async()=>replacement
  },{requireAmount:true}), error=>error.code==="BACKTEST_DATA_INCOMPLETE" && /数据不足|口径|窗口/.test(error.message));
});

test("amount-dependent history respects disabled fallback and does not require index amount by default", async () => {
  const rows=Array.from({length:120},(_,i)=>({date:recentDate(i-120),open:10,high:11,low:9,close:10,volume:100,amount:null}));let calls=0;
  await assert.rejects(loadBacktestHistory(toSecurity("600825"),{fallbackEnabled:false},120,{eastmoney:async()=>rows,completeRaw:async()=>{calls++;return rows;}},{requireAmount:true}),/数据不足.*amount/);
  assert.equal(calls,0);
  assert.strictEqual(await loadBacktestHistory({code:"000985",secid:"1.000985"},{},120,{eastmoney:async()=>rows}),rows);
});

test("manual catalog-combination runBacktest rejects missing stock amount instead of returning zero signals", async(t)=>{
  const originalFetch=global.fetch;t.after(()=>{global.fetch=originalFetch;});
  global.fetch=async url=>{
    assert.match(String(url),/push2his\.eastmoney\.com/);
    const klines=mockRecentEastHistory(140).map(line=>{
      const fields=line.split(",");
      if(new URL(String(url)).searchParams.get("secid")==="1.600825")fields[6]="invalid";
      return fields.join(",");
    });
    return mockJsonResponse({data:{klines}});
  };
  await assert.rejects(runBacktest({code:"600825",name:"新华传媒",secid:"1.600825",assetType:"stock"},
    {provider:"eastmoney",fallbackEnabled:false},
    {lookbackBars:120,strategyContext:{universeSource:"manual",strategyId:"limit_rsi_pullback_resonance",strategyIds:["limit_rsi_pullback_resonance"],minimumVotes:1}}),/个股历史数据加载失败.*amount.*0信号/);
});

test("amount-dependent history distinguishes all-zero missing usability from a real suspension followed by an evaluable window",async()=>{
  const rows=Array.from({length:180},(_,i)=>({date:recentDate(i-180),open:10,high:11,low:9,close:10,volume:100,amount:123456}));
  for(const field of ["volume","amount"]) {
    const zeros=rows.map(row=>({...row,[field]:0}));
    await assert.rejects(loadBacktestHistory(toSecurity("600825"),{fallbackEnabled:false},180,{eastmoney:async()=>zeros},{requireAmount:true}),/数据不足.*80.*正量额/);
  }
  const suspended=rows.map((row,i)=>i===30?{...row,volume:0,amount:0}:row);
  assert.strictEqual(await loadBacktestHistory(toSecurity("600825"),{fallbackEnabled:false},180,{eastmoney:async()=>suspended},{requireAmount:true}),suspended);
  const recentZeros=rows.map((row,i)=>i>=100?{...row,volume:0,amount:0}:row);
  await assert.rejects(loadBacktestHistory(toSecurity("600825"),{fallbackEnabled:false},180,{eastmoney:async()=>recentZeros},{requireAmount:true,signalFrom:rows[100].date}),/数据不足.*信号区间/);
});

test("manual combination backtest refuses short or internally gapped benchmark price coverage", async(t)=>{
  const originalFetch=global.fetch;t.after(()=>{global.fetch=originalFetch;});let mode="short";
  global.fetch=async url=>{
    let klines=mockRecentEastHistory(140);
    if(new URL(String(url)).searchParams.get("secid")==="1.000985")klines=mode==="short"?klines.slice(-30):klines.filter((_,i)=>i!==100);
    return mockJsonResponse({data:{klines}});
  };
  for(mode of ["short","gap"])await assert.rejects(runBacktest({code:"600825",name:"新华传媒",secid:"1.600825",assetType:"stock"},
    {provider:"eastmoney",fallbackEnabled:false},
    {lookbackBars:120,strategyContext:{universeSource:"manual",strategyId:"limit_rsi_pullback_resonance",strategyIds:["limit_rsi_pullback_resonance"],minimumVotes:1}}),/回测数据不足.*基准.*窗口|回测数据不足.*日历/);
});

test("renderer backtest settings cannot override or preserve sensitive service settings", () => {
  const normalMerge = mergeBacktestSettings(
    {
      provider: "ths",
      refreshToken: "trusted-service-token",
      fallbackEnabled: true
    },
    { maxPositionPercent: 35 }
  );
  assert.equal(normalMerge.provider, "ths");
  assert.equal(normalMerge.refreshToken, "trusted-service-token");
  assert.equal(normalMerge.fallbackEnabled, true);
  assert.equal(normalMerge.maxPositionPercent, 35);

  const merged = mergeBacktestSettings(
    {
      provider: "ths",
      refreshToken: "main-refresh-token",
      tushareToken: "main-tushare-token",
      fallbackEnabled: false,
      maxPositionPercent: 28,
      commissionBps: 7
    },
    {
      provider: "ths",
      refreshToken: "renderer-refresh-token",
      tushareToken: "renderer-tushare-token",
      fallbackEnabled: false,
      forceRefresh: true,
      backendApiKey: "renderer-api-key",
      maxPositionPercent: 41,
      commissionBps: 9,
      selectedStrategies: ["low_first_board"]
    }
  );

  assert.equal(merged.provider, undefined);
  assert.equal(merged.refreshToken, undefined);
  assert.equal(merged.tushareToken, undefined);
  assert.equal(merged.fallbackEnabled, undefined);
  assert.equal(merged.forceRefresh, undefined);
  assert.equal(merged.backendApiKey, undefined);
  assert.equal(merged.maxPositionPercent, 41);
  assert.equal(merged.commissionBps, 9);
  assert.deepEqual(merged.selectedStrategies, ["low_first_board"]);

  const profile = safeBacktestStrategyProfile({
    ...merged,
    provider: "eastmoney",
    refreshToken: "must-not-return",
    tushareToken: "must-not-return-either",
    internalPassword: "must-not-return-password",
    riskProfile: "balanced",
    lossStreakStepPercent: 18,
    lossStreakFloorPercent: 30
  }, ["low_first_board"]);
  assert.deepEqual(profile.selectedStrategies, ["low_first_board"]);
  assert.equal(profile.riskProfile, "balanced");
  assert.equal(profile.lossStepPercent, 18);
  assert.equal(profile.lossFloorPercent, 30);
  assert.equal("provider" in profile, false);
  assert.equal("refreshToken" in profile, false);
  assert.equal("tushareToken" in profile, false);
  assert.equal("internalPassword" in profile, false);
});

test("verified runBacktest returns only the safe strategy profile whitelist", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const requestedUrls = [];
  global.fetch = async (url) => {
    const requestUrl = String(url);
    requestedUrls.push(requestUrl);
    if (requestUrl.includes("push2his.eastmoney.com/")) {
      return mockJsonResponse({ data: { klines: mockRecentEastHistory(140) } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const result = await runBacktest(
    { code: "603999", name: "安全回测样本", assetType: "stock" },
    {
      provider: "eastmoney",
      refreshToken: "SERVICE_REFRESH_CREDENTIAL",
      tushareToken: "SERVICE_TUSHARE_CREDENTIAL",
      internalApiKey: "SERVICE_INTERNAL_CREDENTIAL",
      riskProfile: "balanced",
      maxPositionPercent: 28,
      commissionBps: 7,
      slippageBps: 2
    },
    {
      startDate: recentDate(-60),
      signalStrategyIds: ["low_first_board", "trend_first_board"],
      strategyContext: {
        strategyId: "custom_strategy_vote",
        strategyName: "安全多策略回归",
        strategyIds: ["low_first_board", "trend_first_board"],
        minimumVotes: 1
      },
      minSamples: 8,
      settings: {
        provider: "ths",
        refreshToken: "RENDERER_REFRESH_CREDENTIAL",
        fallbackEnabled: false,
        forceRefresh: true,
        backendPassword: "RENDERER_PASSWORD_CREDENTIAL",
        riskProfile: "aggressive",
        maxPositionPercent: 37,
        commissionBps: 9,
        slippageBps: 3
      }
    }
  );

  assert.equal(result.backtestMode, "verified_signal_strategy");
  assert.equal(result.range.requestedFrom, recentDate(-60));
  assert.equal(result.range.signalFrom, recentDate(-60));
  assert.ok(Array.isArray(result.trades));
  assert.equal(result.strategyMode, "multi_strategy_vote");
  assert.equal(result.strategyBreakdown.length, 2);
  assert.deepEqual(
    result.strategyBreakdown.map((item) => item.strategyId),
    ["low_first_board", "trend_first_board"]
  );
  assert.equal(typeof result.profitSummary.totalNetReturnPercent, "number");
  assert.ok(result.trades.every((trade) => trade.signalDate >= recentDate(-60)));
  assert.deepEqual(result.strategyProfile.selectedStrategies, ["low_first_board", "trend_first_board"]);
  assert.equal(result.strategyProfile.riskProfile, "aggressive");
  assert.equal(result.strategyProfile.maxPositionPercent, 37);
  assert.equal(result.strategyProfile.commissionBps, 9);
  for (const forbidden of [
    "provider",
    "refreshToken",
    "tushareToken",
    "fallbackEnabled",
    "forceRefresh",
    "internalApiKey",
    "backendPassword"
  ]) {
    assert.equal(forbidden in result.strategyProfile, false, forbidden);
  }
  const serializedProfile = JSON.stringify(result.strategyProfile);
  for (const credential of [
    "SERVICE_REFRESH_CREDENTIAL",
    "SERVICE_TUSHARE_CREDENTIAL",
    "SERVICE_INTERNAL_CREDENTIAL",
    "RENDERER_REFRESH_CREDENTIAL",
    "RENDERER_PASSWORD_CREDENTIAL"
  ]) {
    assert.equal(serializedProfile.includes(credential), false, credential);
  }
  // 同花顺日线为主源（此处模拟同花顺不可用）；应急时只请求东方财富日线两次。
  const eastUrls = requestedUrls.filter((url) => url.includes("push2his.eastmoney.com/"));
  assert.equal(eastUrls.length, 2);
  assert.ok(requestedUrls.every((url) => url.includes("push2his.eastmoney.com/") || url.includes("d.10jqka.com.cn/")), "only THS (primary) and the Eastmoney emergency source are requested");
});

test("portfolio backtest service keeps a no-signal basket as an all-cash diagnostic", async () => {
  const rows = Array.from({ length: 150 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index));
    const close = 10 + index * 0.001;
    return {
      date: date.toISOString().slice(0, 10),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 100000,
      amount: close * 100000,
      turnover: 1
    };
  });
  const result = await runPortfolioBacktest(
    {
      securities: [
        { code: "600001", name: "组合甲", assetType: "stock" },
        { code: "000001", name: "组合乙", assetType: "stock" }
      ],
      strategyIds: ["low_first_board"],
      minimumVotes: 1,
      startingCapital: 200000,
      maxPositions: 2,
      maxPositionPercent: 28,
      lookbackBars: 720,
      commissionBps: 7,
      slippageBps: 2,
      lotSize: 100,
      benchmark: "000985"
    },
    { provider: "eastmoney", maxPositionPercent: 28 },
    {
      resolveSecurity: async (security) => toSecurity(security),
      loadHistory: async () => rows
    }
  );

  assert.equal(result.backtestMode, "verified_strategy_portfolio");
  assert.equal(result.status, "DIAGNOSTIC");
  assert.equal(result.validation.accepted, false);
  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.metrics.totalReturnPercent, 0);
  assert.equal(result.metrics.endingCapital, 200000);
  assert.equal(result.equityCurve.length, 120);
  assert.equal(result.universe.usedCount, 2);
  assert.equal(result.contributions.length, 2);
  assert.match(result.methodology.summary, /共享现金/);
});

test("strategy-derived portfolio is labeled separately from a manual basket", async () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 100000,
    amount: 1000000,
    turnover: 1
  }));
  const result = await runPortfolioBacktest(
    {
      securities: [{ code: "600001", name: "策略命中股", assetType: "stock" }],
      strategyIds: ["low_first_board"],
      universeSource: "strategy_current_matches",
      lookbackBars: 120
    },
    {},
    {
      resolveSecurity: async (security) => toSecurity(security),
      loadHistory: async () => rows
    }
  );
  assert.equal(result.universe.selectionMode, "strategy_current_matches");
  assert.equal(result.universe.selectionLabel, "所选策略本轮命中股票");
  assert.match(result.statusReasons[0], /并非手工先选股/);
  assert.equal(result.universe.pointInTime, false);
});

test("sector diagnostics distinguish broad participation from a few crowded leaders", () => {
  const broad = buildSectorBreadthDiagnostics([
    { f3: 3, f6: 100, f62: 10 },
    { f3: 2, f6: 100, f62: 8 },
    { f3: 1, f6: 100, f62: 5 },
    { f3: 0.5, f6: 100, f62: 2 },
    { f3: -0.2, f6: 100, f62: -1 },
    { f3: 0.3, f6: 100, f62: 1 }
  ]);
  const crowded = buildSectorBreadthDiagnostics([
    { f3: 8, f6: 900, f62: 20 },
    { f3: -2, f6: 20, f62: -5 },
    { f3: -1.5, f6: 20, f62: -4 },
    { f3: -1, f6: 20, f62: -3 },
    { f3: -0.5, f6: 20, f62: -2 },
    { f3: -0.2, f6: 20, f62: -1 }
  ]);
  assert.ok(broad.advancingAmountShare > 0.7);
  assert.ok(broad.positiveInflowRatio > 0.7);
  assert.ok(broad.leadershipQualityScore > crowded.leadershipQualityScore);
  assert.ok(crowded.top5AmountShare > broad.top5AmountShare);
  assert.equal(broad.coveragePercent, 100);
});

test("Sina industry catalog and constituents normalize into canonical A-share rows", () => {
  const catalog = parseSinaSectorCatalog(
    'var S_Finance_bankuai_sinaindustry = {"new_dlhy":"new_dlhy,电力行业,3,10.2,0.12,1.18,2000,3000,sh600001,10.02,11,1,甲公司"};'
  );
  const sector = matchSinaSector(catalog, "电力");
  assert.equal(sector.node, "new_dlhy");
  assert.equal(sector.changePct, 1.18);
  const members = normalizeSinaSectorMembers([
    {
      symbol: "sh600001",
      code: "600001",
      name: "甲公司",
      trade: "11.00",
      settlement: "10.00",
      changepercent: "10.00",
      turnoverratio: "3.2",
      amount: "123456"
    },
    { symbol: "usAAPL", name: "非A股", trade: "1" }
  ]);
  assert.equal(members.length, 1);
  assert.equal(members[0].code, "600001");
  assert.equal(members[0].secid, "1.600001");
  assert.equal(members[0].isLimitUp, true);
  assert.equal(normalizeSinaSectorMembers([{
    code: "600002", name: "乙公司", trade: "10.99", settlement: "10.00"
  }])[0].isLimitUp, false);
});

test("THS smart-picking columns normalize into sector member rows", () => {
  const members = extractThsSectorMembers({
    tables: [{
      table: {
        thscode: ["600001.SH", "000001.SZ"],
        股票简称: ["甲公司", "乙公司"],
        最新价: [11, 9.5],
        涨跌幅: [10, -1.2],
        成交额: [100000, 80000],
        换手率: [4.2, 2.1],
        昨收价: [10, 9.62]
      }
    }]
  });
  assert.deepEqual(members.map((item) => item.code), ["600001", "000001"]);
  assert.equal(members[0].isLimitUp, true);
  assert.equal(members[1].changePct, -1.2);
});

test("sector fallback scoring never turns missing history into zero returns", () => {
  assert.deepEqual(SECTOR_PROVIDER_PRIORITY.slice(0, 3), [
    "同花顺 QuantAPI",
    "东方财富实时",
    "东方财富延迟节点"
  ]);
  const realtime = buildSectorStrengthFromData({
    sector: { code: "", name: "电力行业", secid: "" },
    members: [
      { code: "600001", name: "甲", changePct: 2, turnover: 3, amount: 100, isLimitUp: false },
      { code: "000001", name: "乙", changePct: -1, turnover: 2, amount: 80, isLimitUp: false }
    ],
    history: [],
    benchmark: [],
    context: { marketBreadth: 0.5, marketAverageReturn: 0.2 },
    source: "新浪行业实时"
  });
  assert.equal(realtime.returns.r1, 0.5);
  assert.equal(realtime.returns.r3, null);
  assert.equal(realtime.returns.r5, null);
  assert.ok(Number.isFinite(realtime.score));
  assert.equal(realtime.partial, true);

  const summaryOnly = buildSectorStrengthFromData({
    sector: { code: "", name: "电力行业", secid: "" },
    members: [],
    history: [],
    benchmark: [],
    context: {},
    source: "新浪行业摘要",
    summary: { memberCount: 100, changePct: 1.2 }
  });
  assert.equal(summaryOnly.score, null);
  assert.equal(summaryOnly.breadth, null);
  assert.equal(summaryOnly.returns.r3, null);
  assert.equal(summaryOnly.memberCount, 100);
});

test("回测余量：15:10 前多取 1 根，收盘后与非交易日为 0", () => {
  const at = (iso) => incompleteBacktestBarAllowance(new Date(iso));
  // 2026-10-23 是交易日（周五）
  assert.equal(at("2026-10-23T09:00:00+08:00"), 1, "盘前应多取当天未完成的一根");
  assert.equal(at("2026-10-23T15:09:59+08:00"), 1, "15:10 之前仍视为未完成");
  assert.equal(at("2026-10-23T15:10:00+08:00"), 0, "15:10 起视为已收盘");
  assert.equal(at("2026-10-23T20:00:00+08:00"), 0);
  // 2026-10-24 / 25 是周六 / 周日
  assert.equal(at("2026-10-24T10:00:00+08:00"), 0, "周六不取余量");
  assert.equal(at("2026-10-25T10:00:00+08:00"), 0, "周日不取余量");
});

test("portfolio service accepts one stock and fixes the return window at 120 bars with warmup", async () => {
  const rows = Array.from({ length: 340 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index));
    return {
      date: date.toISOString().slice(0, 10),
      open: 10,
      high: 10.1,
      low: 9.9,
      close: 10,
      volume: 100000,
      amount: 1000000,
      turnover: 1
    };
  });
  const requestedBars = [];
  const result = await runPortfolioBacktest(
    {
      securities: [{ code: "600001", name: "单股样本", assetType: "stock" }],
      strategyIds: ["low_first_board"],
      lookbackBars: 720
    },
    {},
    {
      resolveSecurity: async (security) => toSecurity(security),
      loadHistory: async (_security, _settings, bars) => {
        requestedBars.push(bars);
        return rows;
      }
    }
  );

  assert.equal(result.lookbackBars, 120);
  assert.equal(result.universe.usedCount, 1);
  assert.equal(result.equityCurve.length, 120);
  assert.equal(result.dataQuality.signalWindow.bars, 120);
  assert.equal(result.dataQuality.warmupBarsRequested, 80);
  assert.equal(result.dataQuality.warmupBarsAvailable, 80);
  assert.equal(result.dataQuality.benchmarkHistoryBarsLoaded, 200);
  // 请求根数 = 120 回测窗口 + 80 预热 + 未收盘当天的余量（15:10 前多取 1 根，收盘后 0）。
  // 用同一规则算期望值：写死 200 会让这个用例随"跑测试的时刻"变红（盘前/盘中跑必红）。
  const allowance = incompleteBacktestBarAllowance(new Date());
  assert.ok(allowance === 0 || allowance === 1, `余量只能是 0 或 1，实际 ${allowance}`);
  assert.deepEqual(requestedBars, [200 + allowance, 200 + allowance]);
});

test("portfolio service lists a strategy-hit stock by signal date even when entry is rejected", async () => {
  const stockRows = Array.from({ length: 320 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index));
    let open = 10;
    let high = 10.2;
    let low = 9.8;
    let close = 10;
    let volume = 100000;
    if (index === 220) {
      open = 10.1;
      high = 11;
      low = 10.05;
      close = 11;
      volume = 180000;
    } else if (index === 221) {
      open = 12.1;
      high = 12.1;
      low = 12.1;
      close = 12.1;
    }
    return {
      date: date.toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume,
      amount: close * volume,
      turnover: 1
    };
  });
  const benchmarkRows = stockRows.map((row) => ({
    ...row,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: 1000000,
    amount: 100000000
  }));
  const tradableRows = stockRows.map((row, index) => index === 221
    ? {
        ...row,
        open: 10.85,
        high: 11.15,
        low: 10.8,
        close: 11.12,
        volume: 100000,
        amount: 1112000
      }
    : row);
  const result = await runPortfolioBacktest(
    {
      securities: [
        { code: "600001", name: "一字板命中", assetType: "stock" },
        { code: "600002", name: "实际成交", assetType: "stock" },
        { code: "600003", name: "容量拒绝", assetType: "stock" }
      ],
      strategyIds: ["platform_breakout"],
      lookbackBars: 120,
      maxPositions: 1
    },
    {},
    {
      resolveSecurity: async (security) => toSecurity(security),
      loadHistory: async (security) => {
        if (security.code === "000985") return benchmarkRows;
        return security.code === "600001" ? stockRows : tradableRows;
      }
    }
  );

  const event = result.signalEvents.find(
    (item) => item.code === "600001" && item.signalDate === stockRows[220].date
  );
  assert.ok(event);
  assert.equal(event.status, "rejected");
  assert.equal(event.reason, "nextDayOnePriceLimitUp");
  assert.equal(result.signalTimeline[0].stocks.length, 3);
  assert.equal(result.signalTimeline[0].filledCount, 1);
  assert.equal(result.signalTimeline[0].rejectedCount, 2);
  assert.deepEqual(
    new Set(result.signalTimeline[0].stocks.map((item) => item.reason).filter(Boolean)),
    new Set(["nextDayOnePriceLimitUp", "capacity_limit"])
  );
  assert.equal(result.signalAudit.matched, 3);
  assert.equal(result.signalAudit.rejected, 2);
  assert.equal(result.metrics.tradeCount, 1);
});

test("portfolio strategy definition endpoint exposes the full auditable library", () => {
  const definitions = getStrategyDefinitions();
  const engine = require("./strategy-signal-engine.cjs");
  // 回测中心看到完整策略库：在用的在前，2026-11-05 下线的标 retired 排在后面；策略选股页只用在用的。
  assert.equal(definitions.length, engine.ALL_STRATEGY_DEFINITIONS.length);
  assert.ok(definitions.every((item) => item.id && item.name && item.detail));
  assert.equal(definitions.filter((item) => item.type === "base").length, 25);
  assert.equal(definitions.filter((item) => item.type === "composite").length, 18);
  assert.equal(definitions.filter((item) => item.retired).length, engine.RETIRED_STRATEGY_DEFINITIONS.length);
  assert.equal(definitions.filter((item) => !item.retired).length, engine.STRATEGY_DEFINITIONS.length);
  assert.deepEqual(definitions.slice(0, engine.STRATEGY_DEFINITIONS.length).map((item) => item.id), engine.STRATEGY_DEFINITIONS.map((item) => item.id));
  assert.ok(definitions.filter((item) => item.featured).every((item) => !item.retired));
  for (const entry of require("../config/strategy-signal-combinations.json")) {
    const definition = definitions.find((item) => item.id === entry.id);
    assert.equal(definition.version, entry.version);
    assert.deepEqual(definition.sources, entry.sources);
    assert.deepEqual(definition.parameters, entry.parameters);
  }
  assert.equal(definitions.some((item) => typeof item.matches === "function"), false);
});

test("Tencent quote fallback preserves execution fields", () => {
  const quote = normalizeTencentQuote(
    {
      code: "600519",
      name: "贵州茅台",
      secid: "1.600519",
      thscode: "600519.SH",
      industry: "白酒"
    },
    {
      securityName: "贵州茅台",
      securityCode: "600519",
      latest: 1337.33,
      preClose: 1361.76,
      open: 1330.03,
      high: 1345,
      low: 1325.77,
      volume: 3791900,
      amount: 5054314019,
      turnover: 0.3,
      volumeRatio: 1.49,
      amplitude: 1.41,
      totalMarketCap: 16717.72e8,
      floatMarketCap: 16717.72e8,
      limitUp: 1497.94,
      limitDown: 1225.58,
      change: -24.43,
      changePct: -1.79
    }
  );
  assert.equal(quote.source, "tencent");
  assert.equal(quote.industry, "白酒");
  assert.equal(quote.latest, 1337.33);
  assert.equal(quote.amount, 5054314019);
  assert.equal(quote.turnover, 0.3);
  assert.equal(quote.limitUp, 1497.94);
});

test("search accepts exchange ETFs and convertible bonds but marks them search-only", () => {
  const etf = normalizeSearchSecurity({
    Code: "510300",
    Name: "沪深300ETF华泰柏瑞",
    Classify: "Fund",
    MktNum: "1",
    QuoteID: "1.510300"
  });
  const bond = normalizeSearchSecurity({
    Code: "118060",
    Name: "瑞可转债",
    Classify: "Bond",
    MktNum: "1",
    QuoteID: "1.118060"
  });
  assert.equal(searchableAssetType({ Code: "510300", Name: "沪深300ETF", Classify: "Fund" }), "etf");
  assert.equal(isConvertibleBondCode("118060"), true);
  assert.equal(etf.marketName, "ETF");
  assert.equal(etf.assetType, "etf");
  assert.equal(etf.defaultVisible, false);
  assert.equal(bond.marketName, "可转债");
  assert.equal(bond.assetType, "convertibleBond");
  assert.equal(bond.defaultVisible, false);
});

test("search excludes OTC funds and ordinary bonds", () => {
  assert.equal(searchableAssetType({
    Code: "000003",
    Name: "中海可转债债券A",
    Classify: "OTCFUND"
  }), null);
  assert.equal(searchableAssetType({
    Code: "019547",
    Name: "国债示例",
    Classify: "Bond"
  }), null);
});

test("quote prices respect the source precision for stocks, ETFs and convertible bonds", () => {
  assert.equal(eastPriceFromRaw(134882, 2), 1348.82);
  assert.equal(eastPriceFromRaw(4594, 3), 4.594);
  assert.equal(eastPriceFromRaw(171491, 3), 171.491);
});

test("exact searchable codes can fall back without the suggestion endpoint", () => {
  assert.equal(assetTypeFromExactCode("510300"), "etf");
  assert.equal(assetTypeFromExactCode("159919"), "etf");
  assert.equal(assetTypeFromExactCode("118060"), "convertibleBond");
  assert.equal(assetTypeFromExactCode("123236"), "convertibleBond");
  assert.equal(assetTypeFromExactCode("600519"), null);
});

test("ST and delisting-risk names are excluded", () => {
  assert.equal(isRiskStockName("*ST测试"), true);
  assert.equal(isRiskStockName("测试退"), true);
  assert.equal(isRiskStockName("正常股份"), false);
});

test("fine-grained concepts are parsed dynamically from THS smart-picking fields", () => {
  assert.equal(conceptRootName("PCB概念"), "PCB");
  assert.equal(conceptRootName("机器人行业Ⅱ"), "机器人");
  const rows = extractThsConceptRows({
    tables: [{
      table: {
        股票代码: ["300001.SZ", "600001.SH"],
        股票简称: ["甲公司", "乙公司"],
        所属同花顺概念: [
          "电子布;覆铜板;AI服务器",
          "电子级树脂;覆铜板"
        ]
      }
    }]
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    code: "300001",
    name: "甲公司",
    concepts: ["电子布", "覆铜板", "AI服务器"]
  });
});

test("free market fields generate dynamic industry and cross-concept groups", () => {
  const result = buildFreeConceptGroups("PCB", [
    { code: "600001", name: "甲", subIndustry: "专用设备", freeConcepts: ["PCB", "玻璃基板"] },
    { code: "600002", name: "乙", subIndustry: "专用设备", freeConcepts: ["PCB", "玻璃基板"] },
    { code: "600003", name: "丙", subIndustry: "电子化学品", freeConcepts: ["PCB", "先进封装"] },
    { code: "600004", name: "丁", subIndustry: "电子化学品", freeConcepts: ["PCB", "先进封装"] }
  ]);
  assert.equal(result.stockCount, 4);
  assert.ok(result.groups.some((group) => group.name === "成分行业细分"));
  assert.ok(result.groups.some((group) => group.name === "交叉概念细分"));
  assert.ok(result.groups.flatMap((group) => group.segments).some((item) => item.name === "玻璃基板"));
  assert.equal(result.groups.flatMap((group) => group.segments).some((item) => item.name === "PCB"), false);
});

test("analysis detects a limit-up event and exact node", () => {
  const history = [];
  let close = 10;
  for (let i = 0; i < 30; i += 1) {
    const date = `2026-06-${String(i + 1).padStart(2, "0")}`;
    if (i === 24) close = 11;
    else if (i > 24) close *= 1.003;
    history.push({
      date,
      open: close * 0.99,
      high: close,
      low: close * 0.98,
      close,
      volume: i === 24 ? 200000 : 100000,
      amount: close * 100000 * 100,
      turnover: 2
    });
  }
  const quote = { name: "测试股份" };
  const result = analyzeHistory(
    { code: "600001" },
    quote,
    history,
    { score: 65, returns: { r3: 1 } }
  );
  assert.equal(result.daysSince, 5);
  assert.equal(result.exactNode, "T+5");
  assert.ok(result.avwap > 0);
  assert.equal(result.eventCount60, 1);
  assert.equal(result.isLowFirstBoard, true);
  const strategies = strategyDefinitionsFor(
    {
      ...result,
      marketEmotion: {
        score: 82,
        state: "情绪强势",
        limitUpCount: 111,
        limitDownCount: 6,
        limitDownRatio: 6 / 111
      }
    },
    { latest: history.at(-1).close }
  );
  assert.equal(strategies.find((item) => item.id === "lowFirstBoard").matched, true);
  assert.ok(strategies.find((item) => item.id === "originBreakout"));
  assert.ok(strategies.find((item) => item.id === "vcpCompression"));
  assert.ok(strategies.find((item) => item.id === "chipLock"));
  assert.equal(strategies.find((item) => item.id === "marketEmotion").matched, true);
  assert.equal(strategies.find((item) => item.id === "riskVeto").matched, true);
});


function completedWindowFixture() {
  const rows = [];
  for (let index = 0; index < 425; index++) {
    const date = new Date(Date.UTC(2025, 8, 1 + index));
    if ([0, 6].includes(date.getUTCDay())) continue;
    rows.push({ date: date.toISOString().slice(0, 10), open: 10, high: 10.1, low: 9.9,
      close: 10, volume: 100000, amount: 1000000, turnover: 1 });
  }
  return rows;
}

for (const [label, now, expectedTo] of [
  ["intraday", "2026-10-23T02:00:00Z", "2026-10-22"],
  ["before settlement buffer", "2026-10-23T07:09:59Z", "2026-10-22"],
  ["completed close", "2026-10-23T07:10:00Z", "2026-10-23"],
  ["holiday", "2026-10-05T08:00:00Z", "2026-09-30"]
]) {
  test(`portfolio backtest ${label} excludes unfinished and future daily bars`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
    const result = await runPortfolioBacktest({
      securities: [{ code: "600071", name: "完成日边界样本", assetType: "stock" }],
      strategyIds: ["low_first_board"], lookbackBars: 120
    }, {}, { resolveSecurity: async security => toSecurity(security), loadHistory: async () => completedWindowFixture() });
    assert.equal(result.dataQuality.signalWindow.to, expectedTo);
    assert.equal(result.equityCurve.at(-1).date, expectedTo);
    assert.equal(result.dataQuality.warmupBarsAvailable, 80);
    assert.ok(result.signalEvents.every(row => row.signalDate <= expectedTo));
  });
}

test("single stock backtest excludes a live daily bar from the settled range", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-23T02:00:00Z") });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async url => {
    if (!String(url).includes("push2his.eastmoney.com/")) throw new Error("fixture source unavailable");
    return mockJsonResponse({ data: { klines: completedWindowFixture().filter(row => row.date <= "2026-10-23").map(row =>
      [row.date, row.open, row.close, row.high, row.low, row.volume, row.amount, 2, 0, 0, row.turnover].join(",")) } });
  };
  const result = await runBacktest({ code: "603998", name: "盘中回测边界", assetType: "stock" }, {},
    { signalStrategyIds: ["low_first_board"], lookbackBars: 200 });
  assert.equal(result.range.signalTo, "2026-10-22");
  assert.equal(result.range.historyTo, "2026-10-22");
  assert.equal(result.dataCoverage.stock.source, "eastmoney");
  assert.equal(result.dataCoverage.benchmark.source, "eastmoney");
  assert.ok(result.trades.every(row => row.exitDate <= "2026-10-22"));
});

test("intraday amount strategy accepts the full completed window without an optional live bar", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-23T02:00:00Z") });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const dates = require("./trend-trading-calendar.cjs").createTradingCalendar().sessionsThrough("2026-10-22", 200);
  global.fetch = async url => {
    if (!String(url).includes("push2his.eastmoney.com/")) throw new Error("fixture source unavailable");
    return mockJsonResponse({ data: { klines: dates.map(date => `${date},10,10,10.1,9.9,100000,1000000,2,0,0,1`) } });
  };
  const result = await runBacktest({ code: "603997", name: "完整收盘窗口", assetType: "stock" },
    { fallbackEnabled: false }, { signalStrategyIds: ["limit_rsi_pullback_resonance"], lookbackBars: 200 });
  assert.equal(result.dataCoverage.amountRequired, true);
  assert.equal(result.dataCoverage.stock.bars, 200);
  assert.equal(result.dataCoverage.benchmark.bars, 200);
  assert.equal(result.range.signalTo, "2026-10-22");
});

test("intraday amount strategy requires its full window after removing a live stock bar", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-23T02:00:00Z") });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const dates = require("./trend-trading-calendar.cjs").createTradingCalendar().sessionsThrough("2026-10-22", 200);
  global.fetch = async url => {
    if (!String(url).includes("push2his.eastmoney.com/")) throw new Error("fixture source unavailable");
    const isStock = new URL(String(url)).searchParams.get("secid") === "1.603996";
    const sourceDates = isStock ? [...dates.slice(1), "2026-10-23"] : dates;
    return mockJsonResponse({ data: { klines: sourceDates.map(date => `${date},10,10,10.1,9.9,100000,1000000,2,0,0,1`) } });
  };
  await assert.rejects(runBacktest({ code: "603996", name: "未满完整窗口", assetType: "stock" },
    { fallbackEnabled: false }, { signalStrategyIds: ["limit_rsi_pullback_resonance"], lookbackBars: 200 }),
  /回测数据不足：(个股.*200.*199|请求窗口 200 根，实际仅 199 根)/);
});

test("intraday amount strategy ignores missing amount on the excluded live bar", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-23T02:00:00Z") });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const dates = require("./trend-trading-calendar.cjs").createTradingCalendar().sessionsThrough("2026-10-22", 200);
  global.fetch = async url => {
    if (!String(url).includes("push2his.eastmoney.com/")) throw new Error("fixture source unavailable");
    const klines = dates.map(date => `${date},10,10,10.1,9.9,100000,1000000,2,0,0,1`);
    klines.push("2026-10-23,10,10,10.1,9.9,100000,invalid,2,0,0,1");
    return mockJsonResponse({ data: { klines } });
  };
  const result = await runBacktest({ code: "603995", name: "盘中部分行情", assetType: "stock" },
    { fallbackEnabled: false }, { signalStrategyIds: ["limit_rsi_pullback_resonance"], lookbackBars: 200 });
  assert.equal(result.dataCoverage.stock.bars, 200);
  assert.equal(result.dataCoverage.stock.amountPresentBars, 200);
  assert.equal(result.range.signalTo, "2026-10-22");
});

test("optional live-bar allowance does not exceed the verified raw source capacity", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-23T02:00:00Z") });
  const complete = Array.from({ length: 1500 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 22 - 1499 + i)).toISOString().slice(0, 10),
    open: 10, high: 10.1, low: 9.9, close: 10, volume: 100, amount: 100000 }));
  let requested;
  const rows = await loadBacktestHistory(toSecurity("603994"), {}, 1501, {
    thsPublic: async () => { throw new Error("fixture unavailable"); },
    eastmoney: async () => complete.map(row => ({ ...row, amount: null })),
    completeRaw: async (_security, bars) => {
      requested = bars;
      if (bars > 1500) throw new Error("historyBars必须为20至1500的整数");
      return { rows: complete, adjustment: "none", source: "verified-raw-capacity", provenance: { amountUnit: "CNY" } };
    }
  }, { requireAmount: true, minimumRows: 1500, completedAt: new Date() });
  assert.equal(requested, 1500);
  assert.equal(rows.length, 1500);
  assert.equal(rows.dataSource, "verified-raw-capacity");
  assert.equal(rows.actualAdjustment, 0);
  assert.equal(rows.provenance.amountUnit, "CNY");
});

test('Sina minute fallback keeps every intraday timestamp instead of deduplicating by day', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const day = recentDate();
  const candles = Array.from({ length: 24 }, (_, index) => ({ day: `${day} ${String(9 + Math.floor((35 + index * 5) / 60)).padStart(2, '0')}:${String((35 + index * 5) % 60).padStart(2, '0')}:00`, open: '10', high: '11', low: '9', close: '10.5', volume: '10000' }));
  global.fetch = async () => mockJsonResponse({ result: { data: [...candles, candles[0], { ...candles[0], day: `${day} 25:00:00` }] } });
  const rows = await require('./services.cjs').sinaKline({ code: '000657', secid: '0.000657' }, '5', 24);
  assert.equal(rows.length, 24);
  assert.equal(rows[0].date, `${day} 09:35`);
  assert.equal(rows.at(-1).date, `${day} 11:30`);
  assert.equal(rows[0].volume, 100);
  assert.equal(rows.dataSource, 'sina_5m');
  assert.equal(rows.actualAdjustment, 0);
});
