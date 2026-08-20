const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decorateLimitPoolItem,
  scoreFirstBoardQuality,
  buildSectorLadder,
  buildHistoricalStrategyStats,
  computePatternStrategies
} = require("./strategy-intelligence.cjs");
const {
  normalizeEastAnnouncement,
  normalizeClsTelegraph,
  thsRows,
  cachedSource,
  cachedSourceStatus,
  resetNewsCache,
  NEWS_SOURCE_MAX_STALE_MS,
  dedupeItems,
  filterItems,
  classifyEvent,
  isBroadcastWorthy
} = require("./news-service.cjs");

test("A-share announcement feed filters content type and portfolio scopes", () => {
  const rows = [
    {
      id: "announcement-1",
      type: "announcement",
      title: "贵州茅台年度报告",
      summary: "",
      source: "公告源",
      eventType: "业绩",
      direction: "neutral",
      relatedSectors: ["白酒"],
      relatedStocks: [{ code: "600519", name: "贵州茅台" }]
    },
    {
      id: "flash-1",
      type: "flash",
      title: "贵州茅台盘中快讯",
      summary: "",
      source: "快讯源",
      eventType: "市场",
      direction: "positive",
      relatedSectors: ["白酒"],
      relatedStocks: [{ code: "600519", name: "贵州茅台" }]
    },
    {
      id: "announcement-2",
      type: "announcement",
      title: "其他公司公告",
      summary: "",
      source: "公告源",
      eventType: "公司公告",
      direction: "neutral",
      relatedSectors: [],
      relatedStocks: [{ code: "000001", name: "平安银行" }]
    }
  ];

  assert.deepEqual(
    filterItems(rows, {
      contentType: "announcement",
      scope: "holdings",
      holdings: [{ code: "600519", name: "贵州茅台", industry: "白酒" }]
    }).map((item) => item.id),
    ["announcement-1"]
  );
  assert.deepEqual(
    filterItems(rows, {
      contentType: "announcement",
      scope: "watchlist",
      watchlist: [{ code: "000001", name: "平安银行" }]
    }).map((item) => item.id),
    ["announcement-2"]
  );
});

test("THS announcement rows unwrap the official nested table envelope", () => {
  const rows = thsRows({
    tables: [{
      thscode: "600000.SH",
      table: {
        reportTitle: ["公告甲", "公告乙"],
        seq: ["1", "2"],
        ctime: ["2026-08-10 09:00:00", "2026-08-10 10:00:00"]
      }
    }]
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].thscode, "600000.SH");
  assert.equal(rows[0].reportTitle, "公告甲");
  assert.equal(rows[1].seq, "2");
});

test("news source cache uses one request, honors TTL, and rejects cache beyond max stale", async (t) => {
  resetNewsCache({ clear: true });
  t.after(() => resetNewsCache({ clear: true }));
  let nowMs = 1_000;
  let calls = 0;
  let failWith = null;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const factory = async () => {
    calls += 1;
    if (calls === 1) await firstGate;
    if (failWith) throw failWith;
    return [{ id: `news-${calls}` }];
  };
  const options = { now: () => nowMs, maxStaleMs: 3_000 };

  const firstRequest = cachedSource("fast", 1_000, factory, "", options);
  const concurrentRequest = cachedSource("fast", 1_000, factory, "", options);
  releaseFirst();
  const [first, concurrent] = await Promise.all([firstRequest, concurrentRequest]);
  assert.deepEqual(first.items, [{ id: "news-1" }]);
  assert.deepEqual(concurrent.items, first.items);
  assert.equal(calls, 1);

  nowMs = 1_999;
  const fresh = await cachedSource("fast", 1_000, factory, "", options);
  assert.equal(fresh.fromCache, true);
  assert.equal(fresh.stale, false);
  assert.equal(calls, 1);

  const upstreamError = new Error("upstream 429 retry-after=30");
  failWith = upstreamError;
  nowMs = 2_000;
  const stale = await cachedSource("fast", 1_000, factory, "", options);
  assert.equal(stale.fromCache, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.warning, upstreamError.message);
  assert.equal(calls, 2);

  nowMs = 4_001;
  await assert.rejects(
    cachedSource("fast", 1_000, factory, "", options),
    (error) => error === upstreamError
  );
  assert.equal(calls, 3);
});

test("news source cache does not reuse a stale THS result for another token key", async (t) => {
  resetNewsCache({ clear: true });
  t.after(() => resetNewsCache({ clear: true }));
  let nowMs = 10_000;
  await cachedSource(
    "ths",
    1_000,
    async () => [{ id: "token-a-result" }],
    "token-a",
    { now: () => nowMs, maxStaleMs: 30_000 }
  );
  nowMs = 11_000;
  const tokenBError = new Error("token-b unauthorized");
  await assert.rejects(
    cachedSource(
      "ths",
      1_000,
      async () => { throw tokenBError; },
      "token-b",
      { now: () => nowMs, maxStaleMs: 30_000 }
    ),
    (error) => error === tokenBError
  );
});

test("stale news source status preserves the upstream warning", () => {
  const status = cachedSourceStatus(8, {
    stale: true,
    warning: "source timed out"
  });
  assert.equal(status.warning, "source timed out");
  assert.match(status.message, /使用缓存/);
  assert.match(status.message, /降级原因：source timed out/);
  assert.equal(NEWS_SOURCE_MAX_STALE_MS.fast, 2 * 60 * 1000);
  assert.equal(NEWS_SOURCE_MAX_STALE_MS.announcement, 30 * 60 * 1000);
});

test("first-board quality uses real seal, break, turnover and float-cap fields", () => {
  const record = decorateLimitPoolItem({
    c: "600001",
    m: 1,
    n: "测试股份",
    p: 11000,
    zdp: 10,
    amount: 500_000_000,
    ltsz: 8_000_000_000,
    hs: 6.25,
    lbc: 1,
    fbt: 94518,
    lbt: 101206,
    fund: 160_000_000,
    zbc: 1,
    hybk: "测试行业"
  }, "2026-07-27");
  const quality = scoreFirstBoardQuality(record, {
    preLimitReturn20: 6.2,
    heldSupport: true
  });
  assert.equal(record.firstSealTime, "09:45:18");
  assert.equal(record.consecutiveBoards, 1);
  assert.equal(record.openBoardCount, 1);
  assert.equal(quality.eligible, true);
  assert.equal(quality.matched, true);
  assert.ok(quality.score >= 70);
  assert.ok(quality.factors.some((factor) => factor.id === "sealRatio"));
});

test("first-board quality never awards points to missing pool fields", () => {
  const quality = scoreFirstBoardQuality({
    code: "600001",
    name: "测试股份",
    consecutiveBoards: null,
    firstSealRaw: null,
    firstSealTime: "",
    openBoardCount: null,
    turnover: 6.25,
    sealFloatRatio: null,
    tradedFloatRatio: null,
    sealedAmount: 0
  }, {
    preLimitReturn20: 6.2,
    heldSupport: true
  });

  assert.equal(quality.dataComplete, false);
  assert.equal(quality.partial, true);
  assert.equal(quality.matched, false);
  assert.equal(quality.grade, "--");
  assert.equal(quality.openBoardCount, null);
  assert.match(quality.summary, /字段不完整/);
  for (const id of ["firstSealTime", "openBoardCount", "sealRatio", "liquidity"]) {
    assert.equal(quality.factors.find((factor) => factor.id === id)?.points, 0);
  }
});

test("sector ladder calculates promotion and failed-board rates from code sets", () => {
  const currentPool = [
    { code: "600001", name: "甲", consecutiveBoards: 2, firstSealRaw: 93000 },
    { code: "600002", name: "乙", consecutiveBoards: 1, firstSealRaw: 100000 }
  ];
  const previousPool = [
    { code: "600001", name: "甲", consecutiveBoards: 1 },
    { code: "600003", name: "丙", consecutiveBoards: 1 }
  ];
  const failedPool = [{ code: "600004", name: "丁" }];
  const ladder = buildSectorLadder({
    currentPool,
    previousPool,
    failedPool,
    memberCodes: ["600001", "600002", "600003", "600004"]
  });
  assert.equal(ladder.maxHeight, 2);
  assert.equal(ladder.firstBoards, 1);
  assert.equal(ladder.promotedCount, 1);
  assert.equal(ladder.promotionRate, 0.5);
  assert.equal(ladder.breakRate, 1 / 3);
});

test("sector ladder keeps failed-board metrics and score unknown when the failed pool is unavailable", () => {
  const ladder = buildSectorLadder({
    currentPool: [
      { code: "600001", name: "甲", consecutiveBoards: 2, firstSealRaw: 93000 },
      { code: "600002", name: "乙", consecutiveBoards: 1, firstSealRaw: 100000 }
    ],
    previousPool: [
      { code: "600001", name: "甲", consecutiveBoards: 1 }
    ],
    failedPool: null
  });

  assert.equal(ladder.failedPoolAvailable, false);
  assert.equal(ladder.failedBoards, null);
  assert.equal(ladder.breakRate, null);
  assert.equal(ladder.score, null);
  assert.equal(ladder.state, "炸板数据缺失");
});

test("important negative announcements remain high-importance and high-risk", () => {
  const classification = classifyEvent(
    "测试股份收到证监会立案告知书并提示退市风险",
    "",
    "A"
  );
  assert.equal(classification.direction, "negative");
  assert.equal(classification.riskSeverity, 3);
  assert.ok(classification.importanceScore >= 70);
  assert.equal(classification.credibilityScore, 96);
});

test("cross-source duplicate announcements are merged without refreshing publication time", () => {
  const first = normalizeEastAnnouncement({
    art_code: "AN1",
    title: "测试股份:关于重大合同中标的公告",
    display_time: "2026-07-28 08:05:00",
    codes: [{ stock_code: "600001", short_name: "测试股份", market_code: "1" }],
    columns: [{ column_name: "重大合同" }]
  });
  const second = {
    ...first,
    id: "ths-ann-2",
    source: "同花顺官方公告",
    sourceLevel: "A",
    publishedAt: "2026-07-28 08:07:00"
  };
  const merged = dedupeItems([first, second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].duplicateCount, 2);
});

test("CLS public telegraphs are normalized with subjects and publication time", () => {
  const item = normalizeClsTelegraph({
    id: 123,
    title: "PCB产业链出现新进展",
    brief: "财联社电报测试",
    ctime: 1785286100,
    subjects: [{ subject_name: "PCB" }, { subject_name: "先进封装" }],
    stock_list: [{ stock_code: "600001", stock_name: "测试股份" }]
  });
  assert.equal(item.source, "财联社电报");
  assert.equal(item.relatedStocks[0].code, "600001");
  assert.ok(item.relatedSectors.includes("先进封装"));
  assert.equal(item.sourceLevel, "B");
});

test("voice broadcast only selects major, risky or high-confidence news", () => {
  assert.equal(isBroadcastWorthy({ importanceScore: 86, riskSeverity: 0, sourceLevel: "B" }), true);
  assert.equal(isBroadcastWorthy({ importanceScore: 60, riskSeverity: 2, sourceLevel: "B" }), true);
  assert.equal(isBroadcastWorthy({ importanceScore: 76, riskSeverity: 0, sourceLevel: "A" }), true);
  assert.equal(isBroadcastWorthy({ importanceScore: 72, riskSeverity: 0, sourceLevel: "B" }), false);
});

test("historical strategy statistics only use outcomes after each evaluation node", () => {
  const history = [];
  let close = 10;
  for (let index = 0; index < 130; index += 1) {
    if ([35, 75, 105].includes(index)) close = Math.round(close * 1.1 * 100) / 100;
    else close *= 1 + (index % 7 === 0 ? -0.004 : 0.003);
    history.push({
      date: new Date(2026, 0, index + 1).toISOString().slice(0, 10),
      open: close * 0.995,
      high: close * 1.006,
      low: close * 0.992,
      close,
      volume: 100000 + (index % 5) * 2000,
      amount: close * 100000 * 100,
      turnover: 2
    });
  }
  const result = buildHistoricalStrategyStats(
    history,
    "600001",
    "测试股份",
    ["support", "trend", "information", "exactNode", "riskVeto"]
  );
  assert.ok(result.totalEvents >= 2);
  assert.ok(result.stats.some((item) => item.id === "currentCombination"));
  assert.ok(result.stats.find((item) => item.id === "support").sampleCount > 0);
  assert.equal(result.stats.find((item) => item.id === "information").available, false);
  assert.equal(result.stats.some((item) => item.id === "exactNode"), false);
  assert.equal(result.stats.some((item) => item.id === "riskVeto"), false);
  assert.equal(result.entryRule.includes("下一交易日开盘"), true);
  assert.ok(result.stats.find((item) => item.id === "support").n5 <= result.stats.find((item) => item.id === "support").n1);
  assert.equal(result.nodeStats.length, 4);
});

test("pattern strategies detect a narrow breakout, volatility compression and chip lock", () => {
  const history = [];
  for (let index = 0; index < 30; index += 1) {
    const close = 9.9 + (index % 4) * 0.02;
    history.push({
      date: `2026-05-${String(index + 1).padStart(2, "0")}`,
      open: close - 0.03,
      high: 10,
      low: 9.72,
      close,
      volume: 100000,
      amount: close * 100000 * 100,
      turnover: 2
    });
  }
  history.push({
    date: "2026-06-01",
    open: 10.15,
    high: 10.91,
    low: 10.1,
    close: 10.91,
    volume: 200000,
    amount: 10.91 * 200000 * 100,
    turnover: 6
  });
  [
    [10.82, 11.08, 10.72, 10.98],
    [10.96, 11.06, 10.78, 11.01],
    [11.0, 11.08, 10.86, 11.04],
    [11.03, 11.09, 10.9, 11.06],
    [11.05, 11.1, 10.94, 11.08]
  ].forEach(([open, high, low, close], offset) => {
    history.push({
      date: `2026-06-0${offset + 2}`,
      open,
      high,
      low,
      close,
      volume: 70000 - offset * 4000,
      amount: close * (70000 - offset * 4000) * 100,
      turnover: 1.4 - offset * 0.08
    });
  });
  const result = computePatternStrategies(history, 30, 35);
  assert.equal(result.originBreakout, true);
  assert.equal(result.vcpCompression, true);
  assert.equal(result.chipLock, true);
  assert.ok(result.chipLockScore >= 60);
  assert.ok(result.compressionRatio <= result.vcpThresholds.compression);
});

test("historical returns enter on the next trading-day open", () => {
  const history = [];
  for (let index = 0; index < 70; index += 1) {
    const isEvent = index === 30;
    const close = isEvent ? 11 : index < 30 ? 10 : 11;
    const isEntry = [34, 36, 38, 40].includes(index);
    history.push({
      date: new Date(2026, 0, index + 1).toISOString().slice(0, 10),
      open: isEvent ? 10.2 : isEntry ? 20 : close,
      high: isEntry ? 20 : close * 1.01,
      low: close * 0.99,
      close,
      volume: isEvent ? 200000 : 100000,
      amount: close * 100000 * 100,
      turnover: 2
    });
  }
  const result = buildHistoricalStrategyStats(
    history,
    "600001",
    "测试股份",
    ["support"],
    history.map((item) => ({
      date: item.date,
      open: 100,
      close: 101
    }))
  );
  const support = result.stats.find((item) => item.id === "support");
  assert.equal(support.n1, 4);
  assert.ok(support.average1 < -40);
  assert.equal(support.nExcess5, 4);
  assert.ok(support.averageExcess5 < support.average5);
  assert.equal(result.benchmarkAvailable, true);
});
