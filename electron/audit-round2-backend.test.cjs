"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveThsFreeSymbol, thsFreeSupports, thsFreeDailyHistory, thsFreeQuote } = require("./ths-free-market.cjs");
const runtimeModule = require("./services/runtime.cjs");
const engine = require("./strategy-signal-engine.cjs");
const { legacyFactorSnapshot, buildHistoricalStrategyStats } = require("./strategy-intelligence.cjs");
const { simulateStrategyPortfolio } = require("./portfolio-backtest.cjs");
const { createAiService, evaluateRowsOutcome } = require("./ai-service.cjs");
const { createStockAgentTools } = require("./stock-agent-tools.cjs");
const { createDailyBarStore } = require("./daily-bar-store.cjs");

function makeWeekdayDates(count, startIso = "2026-01-05") {
  const dates = [];
  let cursor = Date.parse(`${startIso}T00:00:00Z`);
  while (dates.length < count) {
    const day = new Date(cursor).getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(new Date(cursor).toISOString().slice(0, 10));
    }
    cursor += 86400 * 1000;
  }
  return dates;
}

test("P0-1: resolveThsFreeSymbol maps SH indices safely and never collides 000985.SH / 000001.SH with SZ stocks", async () => {
  // Mapped Shanghai indices -> hs_1A0001 / hs_1B0300
  assert.deepEqual(
    resolveThsFreeSymbol({ code: "000001", name: "上证指数", secid: "1.000001", thscode: "000001.SH", assetType: "index" }),
    { market: "hs", code: "1A0001" }
  );
  assert.deepEqual(
    resolveThsFreeSymbol({ code: "000300", name: "沪深300", secid: "1.000300" }),
    { market: "hs", code: "1B0300" }
  );
  assert.deepEqual(
    resolveThsFreeSymbol({ code: "883957", thsMarket: "48", assetType: "index" }),
    { market: "48", code: "883957" }
  );

  // Unmapped CSI All-Share 000985 (even when assetType is omitted!) must fail closed instead of hitting hs_000985 (大庆华科)
  assert.equal(resolveThsFreeSymbol({ code: "000985", secid: "1.000985", name: "中证全指" }), null);
  assert.equal(resolveThsFreeSymbol({ code: "000985", assetType: "index", name: "中证全指" }), null);
  assert.equal(resolveThsFreeSymbol({ code: "399006", secid: "0.399006", name: "创业板指" }), null);
  assert.equal(thsFreeSupports({ code: "000985", secid: "1.000985" }), false);

  await assert.rejects(
    () => thsFreeDailyHistory({ code: "000985", secid: "1.000985", name: "中证全指" }),
    { code: "THS_FREE_UNSUPPORTED" }
  );
  await assert.rejects(
    () => thsFreeQuote({ code: "000985", secid: "1.000985", name: "中证全指" }),
    { code: "THS_FREE_UNSUPPORTED" }
  );

  // Genuine Shenzhen stocks 000001.SZ (平安银行) and 000985.SZ (大庆华科) remain supported
  assert.deepEqual(
    resolveThsFreeSymbol({ code: "000001", secid: "0.000001", name: "平安银行", assetType: "stock" }),
    { market: "hs", code: "000001" }
  );
  assert.deepEqual(
    resolveThsFreeSymbol({ code: "000985", secid: "0.000985", name: "大庆华科", assetType: "stock" }),
    { market: "hs", code: "000985" }
  );
});

test("P1-1: destructured stockIndustryIndex proxy forwards calls to reconfigured store", async () => {
  const { stockIndustryIndex, configureStockIndustryStore } = runtimeModule;
  const nowMs = Date.now();
  try {
    configureStockIndustryStore({
      read: () => ({
        builtAt: nowMs,
        source: "unit-test",
        industryCount: 2,
        industries: { "600519": "白酒Ⅱ", "300750": "电池" }
      }),
      write: () => {}
    });
    await stockIndustryIndex.ensure();
    assert.equal(stockIndustryIndex.lookup("600519"), "白酒Ⅱ");
    assert.equal(stockIndustryIndex.lookup("300750"), "电池");
    assert.equal(stockIndustryIndex.status().stocks, 2);
  } finally {
    configureStockIndustryStore(null);
    await stockIndustryIndex.shutdown();
  }
});

test("P0-2 & P2-5: enhanceCurrentFeature refreshes overheatVeto, signal report rejects missingNextMarketDay, and replay avoids overlapping deferred exits", () => {
  const baseFeature = {
    date: "2026-04-10",
    latest: 10.5,
    ma20: 10,
    ma20ExtensionPercent: 5,
    changePct: 1.2,
    volumeRatio: 1.0,
    relativeTurnover: 1.0,
    closePosition: 0.8,
    overheatFlags: [],
    overheatCount: 0,
    overheatVeto: false
  };
  const enhanced = engine.__test.enhanceCurrentFeature(
    baseFeature,
    {
      latest: 12.2,
      changePct: 8.5,
      quote: { volumeRatio: 3.8 },
      analysis: { relativeTurnover: 3.2 }
    },
    "600001",
    "测试股"
  );
  assert.equal(enhanced.overheatVeto, true);
  assert.ok(enhanced.overheatCount >= 2);

  // replayStrategy does not overlap a second entry while a prior trade's exit is deferred by suspension
  const dates = makeWeekdayDates(45);
  const rows = dates.map((date, idx) => ({
    date,
    open: 10,
    high: 10.2,
    low: 9.8,
    close: 10,
    volume: idx >= 26 && idx <= 34 ? 0 : 10000,
    amount: idx >= 26 && idx <= 34 ? 0 : 10000000,
    isST: false
  }));
  const def = {
    id: "custom_probe",
    name: "探针",
    matches: (f) => f.date === dates[22] || f.date === dates[29]
  };
  const replay = engine.__test.replayStrategy(
    def,
    "600001",
    "测试股",
    rows,
    new Map(rows.map((r) => [r.date, r])),
    engine.__test.resolvedOptions({ horizonDays: 5, cooldownDays: 5 }),
    {
      requireNextMarketDay: true,
      nextMarketDateByDate: new Map(dates.slice(0, -1).map((d, i) => [d, dates[i + 1]]))
    }
  );
  // First signal at idx=22 enters at 23; normal exit idx=27 is suspended (26..34 have volume=0), so exit defers to idx=35.
  // Second signal at idx=29 (29 - 22 = 7 > cooldownDays 5) is still inside [23..35], so it must NOT overlap!
  assert.equal(replay.samples.length, 1);
  assert.equal(replay.samples[0].entryDate, dates[23]);
  assert.equal(replay.samples[0].exitDate, dates[35]);
});

test("P1-5: strategy-intelligence treats missing turnover as null and rejects suspended/ex-rights samples", () => {
  const dates = makeWeekdayDates(50);
  const history = dates.map((date, idx) => {
    if (idx === 25) {
      // 10% limit up from 10 -> 11, no turnover reported anywhere
      return { date, open: 10.2, high: 11, low: 10.1, close: 11, preClose: 10, volume: 20000, amount: 22000000 };
    }
    const base = idx > 25 ? 10.8 : 10;
    return {
      date,
      open: base,
      high: base + 0.1,
      low: base - 0.1,
      close: base,
      preClose: idx === 26 ? 11 : base,
      volume: idx === 28 ? 8000 : 15000,
      amount: 15000000
    };
  });
  // At T+3 (idx = 28), volume shrunk (8000 < 15000), but turnover is completely absent -> contraction must be false, not fabricated true!
  const snap = legacyFactorSnapshot(history, 28, "600001", "测试股");
  assert.equal(snap.hasEvent, true);
  assert.equal(snap.factors.contraction, false);

  // Suspend stock on benchmark trading day dates[29] (remove dates[29] from stock history while keeping it in benchmark)
  const stockWithGap = history.filter((row) => row.date !== dates[29]);
  const benchmark = dates.map((date) => ({ date, open: 3000, high: 3010, low: 2990, close: 3005 }));
  const stats = buildHistoricalStrategyStats(stockWithGap, "600001", "测试股", ["support"], benchmark);
  // Node T+3 (eval at dates[28]) expects next market day dates[29], but stock skipped to dates[30] -> counted as untradeable!
  assert.ok(stats.untradeableCount >= 1);
});

test("P1-6: simulateStrategyPortfolio records missingNextMarketDay rejection instead of crashing on out-of-window resumed bar", () => {
  const dates = makeWeekdayDates(10);
  const benchmark = dates.slice(0, 6).map((date) => ({ date, open: 100, high: 101, low: 99, close: 100 }));
  const stockRows = [
    ...dates.slice(0, 3).map((date) => ({ date, open: 10, high: 10.2, low: 9.8, close: 10, volume: 1000 })),
    // Stock suspended from dates[3] through dates[7], resuming on dates[8] (beyond benchmark lastDate dates[5]!)
    { date: dates[8], open: 10, high: 10.2, low: 9.8, close: 10, volume: 1000 },
    { date: dates[9], open: 10, high: 10.2, low: 9.8, close: 10, volume: 1000 }
  ];
  const result = simulateStrategyPortfolio(
    [
      {
        sampleId: "suspended-beyond-window",
        strategyId: "low_first_board",
        strategyName: "低位首板",
        code: "600001",
        name: "停牌股",
        signalDate: dates[2],
        entryDate: dates[8],
        exitDate: dates[9],
        entryPrice: 10,
        exitPrice: 10,
        netReturn: 0
      }
    ],
    { "600001": stockRows },
    benchmark,
    {
      startingCapital: 100000,
      maxPositions: 3,
      maxPositionPercent: 30
    }
  );
  assert.equal(result.trades.length, 0);
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].reason, "missingNextMarketDay");
});

test("P1-7: evaluateRowsOutcome stops before ex-rights split discontinuity and outcomesLeaderboard aligns missRatePct", async () => {
  const splitRows = [
    { date: "2026-10-10", low: 19.8, close: 20 },
    { date: "2026-10-11", low: 19.9, close: 20.4, preClose: 20 },
    // 10-for-10 share split on 2026-10-12: preClose rebased to 10.2 while prior raw close was 20.4!
    { date: "2026-10-12", low: 10.1, close: 10.5, preClose: 10.2 },
    { date: "2026-10-13", low: 10.4, close: 10.6, preClose: 10.5 }
  ];
  const outcome = evaluateRowsOutcome(splitRows, "2026-10-10", "600519");
  assert.equal(outcome.t1, 2);
  assert.equal(outcome.t3, null);
  assert.equal(outcome.stopHit, false);
  assert.equal(outcome.maxDrawdownPct, -0.5);

  const storeData = {
    version: 1,
    entries: [
      {
        key: "rank:2026-10-10:m1:a",
        kind: "rank",
        savedAt: "2026-10-10T15:30:00Z",
        value: {
          asOfDate: "2026-10-10",
          profileName: "模型A",
          framework: { id: "short", name: "短线" },
          items: [
            { code: "600519", name: "茅台", score: 85, rating: "重点关注" },
            { code: "000001", name: "平安", score: 71, rating: "关注" }
          ]
        }
      },
      // Duplicate run earlier same day for same model/framework must not double-count
      {
        key: "rank:2026-10-10:m1:b",
        kind: "rank",
        savedAt: "2026-10-10T15:10:00Z",
        value: {
          asOfDate: "2026-10-10",
          profileName: "模型A",
          framework: { id: "short", name: "短线" },
          items: [{ code: "600519", name: "茅台", score: 85, rating: "重点关注" }]
        }
      }
    ]
  };
  const service = createAiService({
    getConfig: () => ({ id: "p1", name: "模型A", baseUrl: "https://example.com/v1", model: "m1", apiKey: "k" }),
    store: { read: () => storeData, write: () => {} },
    evaluateOutcomes: async () => ({
      "600519": { t1: -5, t3: -6, t5: -4, maxDrawdownPct: -8, stopHit: true },
      "000001": { t1: -5, t3: -6, t5: -4, maxDrawdownPct: -8, stopHit: true }
    })
  });
  const board = await service.outcomesLeaderboard({ days: 30 });
  assert.equal(board.evaluatedSamples, 2);
  // Only 600519 had score >= 75 (highScoreEvaluated = 1, highScoreMisses = 1 -> 100%, NOT 1/2 = 50%!)
  assert.equal(board.byModel[0].highScoreMisses, 1);
  assert.equal(board.byModel[0].missRatePct, 100);
});

test("P2-3 & P3-3: stock-agent-tools kline/intraday math and daily-bar-store limit/ST preservation", async () => {
  const tools = createStockAgentTools({
    dailyRows: async () => [
      { date: "2026-10-09", open: 9.9, high: 10.1, low: 9.8, close: 10.0, amount: 1e8, turnover: 1.2 },
      { date: "2026-10-10", open: 10.0, high: 11.0, low: 10.0, close: 11.0, amount: 2e8, turnover: 2.5 },
      { date: "2026-10-13", open: 11.0, high: 11.5, low: 10.8, close: 11.0, amount: 1.5e8, turnover: 1.8 },
      { date: "2026-10-14", open: 11.0, high: 11.2, low: 10.9, close: 11.0, amount: 1.2e8, turnover: 1.4 },
      { date: "2026-10-15", open: 11.0, high: 11.3, low: 10.9, close: 11.0, amount: 1.1e8, turnover: 1.3 },
      { date: "2026-10-16", open: 11.0, high: 11.1, low: 10.9, close: 11.0, amount: 1.0e8, turnover: 1.1 }
    ],
    timeShare: async () => ({
      date: "2026-10-16",
      preClose: 10,
      rows: [
        { date: "2026-10-16 09:31", close: 10.1, average: 10.05, amount: 1e7 },
        { date: "2026-10-16 09:45", close: 10.3, average: 10.15, amount: 2e7 }
      ]
    })
  });

  // 5-day window (2026-10-10..2026-10-16): prior close on 2026-10-09 was 10.0, last close is 11.0 -> +10%, NOT 0%!
  const klineRes = await tools.runTool("kline", { code: "600519", days: 5 });
  assert.equal(klineRes.ok, true);
  assert.match(klineRes.summary, /区间涨跌 10%/);

  // At 09:45, future nodes like 10:00 / 13:30 / 15:00 must NOT be fabricated
  const intraRes = await tools.runTool("intraday", { code: "600519" });
  assert.equal(intraRes.ok, true);
  assert.deepEqual(intraRes.data.nodes.map((n) => n.time), ["09:45"]);
  await tools.shutdown();

  // daily-bar-store preserves upperLimit / lowerLimit / isST on appended snapshot bar
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "astock-bar-meta-"));
  try {
    const fetchedMs = Date.parse("2026-10-16T15:10:00+08:00");
    const store = createDailyBarStore({
      directory: () => tmpDir,
      previousSession: (d) => (d === "2026-10-16" ? "2026-10-15" : null),
      nextSession: (d) => (d === "2026-10-16" ? "2026-10-19" : null),
      snapshot: async () =>
        new Map([
          [
            "600001",
            {
              code: "600001",
              open: 10.1,
              high: 10.5,
              low: 10.0,
              latest: 10.5,
              preClose: 10.0,
              volume: 50000,
              amount: 52000000,
              turnover: 2.1,
              limitUp: 10.5,
              limitDown: 9.5,
              isST: true,
              quoteAt: "2026-10-16T15:01:00+08:00",
              quoteAtIsTradeTime: true,
              fetchedAt: fetchedMs
            }
          ]
        ])
    });
    const baseRows = [
      { date: "2026-10-15", open: 9.9, high: 10.1, low: 9.8, close: 10.0, volume: 40000, amount: 40000000, turnover: 1.8 }
    ];
    await store.history({ code: "600001" }, "2026-10-15", async () => ({ rows: baseRows, adjustment: "none", source: "mock" }));
    await store.prepareDay([{ code: "600001" }], "2026-10-16");
    const updated = await store.history({ code: "600001" }, "2026-10-16", async () => ({ rows: baseRows, adjustment: "none", source: "mock" }));
    const lastBar = updated.rows.at(-1);
    assert.equal(lastBar.date, "2026-10-16");
    assert.equal(lastBar.upperLimit, 10.5);
    assert.equal(lastBar.lowerLimit, 9.5);
    assert.equal(lastBar.isST, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
