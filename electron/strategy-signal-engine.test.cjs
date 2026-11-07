"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildStrategySignalReport,
  buildSelectedStrategyReplay,
  STRATEGY_DEFINITIONS,
  ALL_STRATEGY_DEFINITIONS,
  temporalSplit,
  strategyDependence,
  robustStrategyScore,
  __test
} = require("./strategy-signal-engine.cjs");

const {
  buildFeatureTimeline,
  featureSnapshot,
  replayStrategy,
  resolvedOptions
} = __test;

function dateAt(index) {
  return new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
}

function replayableHistory({ onePriceEntry = false, noPriceLimitEntry = false, eventIndex = 30 } = {}) {
  const rows = [];
  for (let index = 0; index < 90; index += 1) {
    let open = 10;
    let high = 10.2;
    let low = 9.8;
    let close = 10;
    let volume = 100000;
    if (index === eventIndex) {
      open = 10.15;
      high = 11;
      low = 10.12;
      close = 11;
      volume = 200000;
    } else if (index === eventIndex + 1 && onePriceEntry) {
      open = 12.1;
      high = 12.1;
      low = 12.1;
      close = 12.1;
      volume = null;
    } else if (index === eventIndex + 1) {
      open = 10.85;
      high = 11.15;
      low = 10.8;
      close = 11.12;
      volume = 100000;
    } else if (index === eventIndex + 2) {
      open = onePriceEntry ? 12.08 : 11.05;
      high = onePriceEntry ? 12.15 : 11.15;
      low = onePriceEntry ? 12 : 10.9;
      close = onePriceEntry ? 12.1 : 11;
      volume = 80000;
    } else if (index === eventIndex + 3) {
      open = onePriceEntry ? 12.08 : 10.98;
      high = onePriceEntry ? 12.18 : 11.12;
      low = onePriceEntry ? 12 : 10.9;
      close = onePriceEntry ? 12.12 : 11.05;
      volume = 70000;
    } else if (index === eventIndex + 4) {
      open = onePriceEntry ? 12.12 : 11.05;
      high = onePriceEntry ? 12.2 : 11.35;
      low = onePriceEntry ? 12.04 : 11;
      close = onePriceEntry ? 12.15 : 11.3;
      volume = 130000;
    } else if (index >= eventIndex + 5) {
      const start = onePriceEntry ? 12.15 : 11.3;
      close = start + (index - (eventIndex + 4)) * 0.06;
      open = close - 0.03;
      high = close + 0.08;
      low = close - 0.09;
      volume = 95000;
    }
    rows.push({
      date: dateAt(index),
      open,
      high,
      low,
      close,
      volume,
      amount: volume ? close * volume * 100 : null,
      turnover: 2,
      ...(index === eventIndex + 1 && noPriceLimitEntry ? { noPriceLimit: true } : {})
    });
  }
  return rows;
}

function flatBenchmark() {
  return Array.from({ length: 90 }, (_, index) => ({
    date: dateAt(index),
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: 1000000
  }));
}

test("precomputed feature timeline is identical to on-demand snapshots", () => {
  const history = replayableHistory();
  const previousClose = Number(history[59].close);
  const secondLimitClose = Math.round(previousClose * 1.1 * 100) / 100;
  history[60] = {
    ...history[60],
    open: secondLimitClose - 0.08,
    high: secondLimitClose,
    low: secondLimitClose - 0.12,
    close: secondLimitClose,
    volume: 210000,
    amount: secondLimitClose * 210000 * 100
  };

  const timeline = buildFeatureTimeline(history, "600001", "双事件样本");
  assert.equal(timeline.length, history.length);
  for (let index = 0; index < history.length; index += 1) {
    assert.deepEqual(
      timeline[index],
      featureSnapshot(history, index, "600001", "双事件样本"),
      `feature mismatch at history index ${index}`
    );
  }
});

test("limit-up event detection uses date-specific board rules and skips explicit no-limit sessions", () => {
  const { isLimitUpAt } = __test;
  const bars = (date, close, high, extras = {}) => [
    { date: "2026-07-02", close: 10, high: 10 },
    { date, close, high, ...extras }
  ];

  assert.equal(isLimitUpAt(bars("2026-07-03", 10.5, 10.5), 1, "600001", "ST样本"), true);
  assert.equal(isLimitUpAt(bars("2026-07-06", 10.5, 10.5), 1, "600001", "ST样本"), false);
  assert.equal(isLimitUpAt(bars("2026-07-06", 10.99, 10.99), 1, "600001", "普通样本"), false);
  assert.equal(isLimitUpAt(bars("2026-07-06", 11, 11), 1, "600001", "ST样本"), true);
  assert.equal(isLimitUpAt(bars("2026-07-06", 11.2, 11.2, { upperLimit: 11.2 }), 1, "600001", "普通样本"), true);
  assert.equal(isLimitUpAt(bars("2026-07-06", 12, 12, { noPriceLimit: true }), 1, "600001", "普通样本"), false);
});

test("all eighteen strategies replay identically with a shared feature timeline", () => {
  const history = replayableHistory();
  const benchmarkByDate = new Map(
    flatBenchmark().map((row) => [row.date, row])
  );
  const options = resolvedOptions({
    minSamples: 6,
    minOutOfSampleSamples: 6,
    minIndependentSignalDays: 6,
    minWalkForwardFoldSamples: 2
  });
  const timeline = buildFeatureTimeline(history, "600001", "等价回放样本");

  for (const definition of STRATEGY_DEFINITIONS) {
    const onDemand = replayStrategy(
      definition,
      "600001",
      "等价回放样本",
      history,
      benchmarkByDate,
      options
    );
    const precomputed = replayStrategy(
      definition,
      "600001",
      "等价回放样本",
      history,
      benchmarkByDate,
      options,
      { featureTimeline: timeline }
    );
    assert.deepEqual(
      precomputed,
      onDemand,
      `${definition.id} replay output changed`
    );
  }
});

test("returns the catalogued strategy groups and refuses current matches without OHLCV history", () => {
  const candidates = [
    {
      code: "600001",
      name: "首板样本",
      latest: 11,
      changePct: 10,
      limitDate: "2026-07-30",
      tradingDaysSince: 0,
      consecutiveBoards: 1,
      limitStats: { count: 1 },
      analysis: {
        lowFirstBoard: true,
        heldSupport: true,
        preLimitReturn20: 3,
        riskVeto: true
      }
    },
    {
      code: "600002",
      name: "平台样本",
      latest: 12,
      date: "2026-07-30",
      analysis: {
        originBreakout: true,
        boxWidth: 8,
        heldSupport: true,
        riskVeto: true
      }
    },
    {
      code: "600003",
      name: "压缩样本",
      latest: 13,
      date: "2026-07-30",
      analysis: {
        vcpCompression: true,
        postVolumeRatio: 0.55,
        heldSupport: true,
        riskVeto: true
      }
    },
    {
      code: "600004",
      name: "二次突破",
      latest: 14,
      date: "2026-07-30",
      analysis: {
        secondBreakout: true,
        volumeRatio: 1.3,
        heldSupport: true,
        riskVeto: true
      }
    },
    {
      code: "600005",
      name: "弱转强样本",
      latest: 15,
      date: "2026-07-30",
      analysis: {
        weakToStrong: true,
        closePosition: 0.88,
        heldSupport: true,
        riskVeto: true
      }
    },
    {
      code: "600006",
      name: "趋势首板样本",
      latest: 16,
      date: "2026-07-30",
      analysis: { trendFirstBoard: true, heldSupport: true, riskVeto: true }
    },
    {
      code: "600007",
      name: "缩量首板样本",
      latest: 17,
      date: "2026-07-30",
      analysis: { lowVolumeFirstBoard: true, heldSupport: true, riskVeto: true }
    },
    {
      code: "600008",
      name: "缺口守卫样本",
      latest: 18,
      date: "2026-07-30",
      analysis: { limitGapHold: true, heldSupport: true, riskVeto: true }
    },
    {
      code: "600009",
      name: "均线回踩样本",
      latest: 19,
      date: "2026-07-30",
      analysis: { limitMa10Pullback: true, heldSupport: true, riskVeto: true }
    },
    {
      code: "600010",
      name: "地量反包样本",
      latest: 20,
      date: "2026-07-30",
      analysis: { volumeDryupRebound: true, heldSupport: true, riskVeto: true }
    },
    {
      code: "600011",
      name: "双板接力样本",
      latest: 21,
      date: "2026-07-30",
      analysis: { doubleLimitRelay: true, heldSupport: true, riskVeto: true }
    },
    {
      code: "600012",
      name: "高位窄旗样本",
      latest: 22,
      date: "2026-07-30",
      analysis: { highTightFlag: true, heldSupport: true, riskVeto: true }
    },
    {
      code: "600013",
      name: "均线反转样本",
      latest: 23,
      date: "2026-07-30",
      analysis: { maReclaimAfterLimit: true, heldSupport: true, riskVeto: true }
    },
    {
      code: "600014",
      name: "长下影封板样本",
      latest: 24,
      date: "2026-07-30",
      analysis: { longLowerShadowLimit: true, heldSupport: true, riskVeto: true }
    }
  ];
  const before = JSON.parse(JSON.stringify(candidates));
  const report = buildStrategySignalReport(candidates, {}, [], {
    generatedAt: "2026-07-30T15:00:00+08:00"
  });

  assert.equal(report.generatedAt, "2026-07-30T15:00:00+08:00");
  assert.equal(report.source, "provided_ohlcv_replay");
  assert.equal(report.strategies.length, ALL_STRATEGY_DEFINITIONS.length);
  assert.deepEqual(
    report.strategies.map((strategy) => strategy.id),
    ALL_STRATEGY_DEFINITIONS.map((strategy) => strategy.id)
  );
  for (const strategy of report.strategies) {
    assert.equal(typeof strategy.name, "string");
    assert.equal(typeof strategy.detail, "string");
    assert.ok(Array.isArray(strategy.conditions));
    assert.ok(strategy.conditions.length >= 3);
    assert.equal(typeof strategy.risk, "string");
    assert.equal(strategy.validation.sampleCount, 0);
    assert.equal(strategy.validation.accepted, false);
    assert.equal(strategy.validation.walkForward.available, false);
    assert.equal(strategy.validation.thresholds.minSamples, 30);
    assert.equal(strategy.validation.thresholds.minOutOfSampleSamples, 9);
    if (strategy.type === "composite") {
      assert.ok(strategy.components.length >= 3);
      assert.equal(typeof strategy.voteRule, "string");
      assert.equal(strategy.stocks.length, 0);
    } else {
      assert.equal(strategy.stocks.length, 0);
    }
  }
  assert.deepEqual(candidates, before, "pure report builder must not mutate candidate input");
});

test("external analysis booleans cannot force composite matches without OHLCV", () => {
  const candidates = [
    {
      code: "600101",
      name: "首板共振",
      date: "2026-07-30",
      analysis: {
        lowFirstBoard: true,
        originBreakout: true,
        heldSupport: true,
        riskVeto: true
      }
    },
    {
      code: "600102",
      name: "缩量共振",
      date: "2026-07-30",
      analysis: {
        vcpCompression: true,
        highTightFlag: true,
        heldSupport: true,
        riskVeto: true
      }
    },
    {
      code: "600103",
      name: "突破共振",
      date: "2026-07-30",
      analysis: {
        secondBreakout: true,
        weakToStrong: true,
        heldSupport: true,
        riskVeto: true
      }
    },
    {
      code: "600104",
      name: "N形共振",
      date: "2026-07-30",
      analysis: {
        doubleLimitRelay: true,
        trendFirstBoard: true,
        heldSupport: true,
        riskVeto: true
      }
    },
    {
      code: "600105",
      name: "纯单信号",
      date: "2026-07-30",
      analysis: {
        vcpCompression: true,
        heldSupport: true,
        riskVeto: true
      }
    }
  ];
  const report = buildStrategySignalReport(candidates, {}, [], {});
  for (const strategy of report.strategies.filter(
    (item) => item.type === "composite"
  )) {
    assert.equal(strategy.type, "composite");
    assert.deepEqual(strategy.stocks, []);
    assert.equal(strategy.validation.sampleCount, 0);
    assert.equal(strategy.validation.accepted, false);
  }
  for (const strategy of report.strategies.filter(
    (item) => item.type === "composite"
  )) {
    assert.equal(
      strategy.stocks.some((stock) => stock.code === "600105"),
      false,
      `${strategy.id} must not trigger from a single component`
    );
  }
});

test("replays signals with next-open entry and exposes time-split and walk-forward evidence", () => {
  const candidates = [];
  const historiesByCode = {};
  for (let index = 1; index <= 12; index += 1) {
    const code = `600${String(index).padStart(3, "0")}`;
    candidates.push({
      code,
      name: `回放样本${index}`,
      latest: 14,
      date: dateAt(89),
      analysis: { riskVeto: true }
    });
    historiesByCode[code] = replayableHistory({
      eventIndex: 24 + index * 2
    });
  }
  const beforeHistory = JSON.parse(JSON.stringify(historiesByCode));
  const report = buildStrategySignalReport(
    candidates,
    historiesByCode,
    flatBenchmark(),
    {
      minSamples: 6,
      minOutOfSampleSamples: 6,
      minIndependentSignalDays: 6,
      minWalkForwardFoldSamples: 2,
      minWinRate: 40,
      minAverageReturn: 0,
      maxDrawdown: -22,
      outOfSampleRatio: 0.5,
      roundTripCostBps: 18,
      generatedAt: "2024-03-30T15:00:00+08:00"
    }
  );
  const boardSignal = report.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );
  const platform = report.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );
  const compression = report.strategies.find(
    (strategy) => strategy.id === "vcp_compression"
  );
  const secondBreakout = report.strategies.find(
    (strategy) => strategy.id === "second_breakout"
  );
  const weakToStrong = report.strategies.find(
    (strategy) => strategy.id === "weak_to_strong"
  );
  const firstBoardComposite = report.strategies.find(
    (strategy) => strategy.id === "first_board_quality_resonance"
  );

  assert.equal(report.coverage.historiesUsed, 12);
  assert.equal(report.coverage.benchmarkBars, 90);
  assert.equal(boardSignal.validation.sampleCount, 12);
  assert.equal(platform.validation.sampleCount, 12);
  assert.ok(compression.validation.sampleCount >= 12);
  assert.equal(secondBreakout.validation.sampleCount, 12);
  assert.equal(weakToStrong.validation.sampleCount, 12);
  // 首板质量共振 v1.3.0 以“低位首板”为必要票；横盘样本的涨停收盘高于 MA20 约 9.5%，不是低位。
  assert.equal(firstBoardComposite.validation.sampleCount, 0);
  assert.ok(boardSignal.validation.averageReturn > 4);
  assert.equal(boardSignal.validation.averageReturn, 4.52);
  assert.equal(boardSignal.validation.benchmarkSampleCount, 12);
  assert.equal(boardSignal.validation.averageExcessReturn > 4, true);
  assert.equal(boardSignal.validation.outOfSample.sampleCount, 6);
  assert.equal(boardSignal.validation.walkForward.available, true);
  assert.equal(boardSignal.validation.walkForward.folds.length, 3);
  // Fail-closed: 6 out-of-sample signal days over a 5-session hold give
  // effectiveIndependentSamples = floor(6 / 5) = 1, so the 95% one-sided lower
  // bound cannot be computed. It used to be null and `Number(null) === 0`
  // silently cleared the minReturnLowerBound gate; now it must not pass.
  assert.equal(boardSignal.validation.outOfSample.averageReturnLowerBound95, null);
  assert.equal(boardSignal.validation.walkForward.accepted, false);
  assert.equal(boardSignal.validation.accepted, false);
  assert.match(boardSignal.validation.reason, /无法计算95%单侧下限/);
  assert.equal(firstBoardComposite.validation.accepted, false);
  assert.notStrictEqual(
    firstBoardComposite.validation,
    boardSignal.validation,
    "composite validation must be replayed independently"
  );
  assert.equal(
    boardSignal.validation.entryRule.includes("次一交易日开盘"),
    true
  );
  assert.deepEqual(
    historiesByCode,
    beforeHistory,
    "historical OHLCV input must remain unchanged"
  );
});

test("keeps all stocks from the same signal date on one side of the temporal split", () => {
  const candidates = [];
  const historiesByCode = {};
  for (let index = 1; index <= 30; index += 1) {
    const code = `601${String(index).padStart(3, "0")}`;
    candidates.push({ code, name: `同日样本${index}`, date: dateAt(89) });
    historiesByCode[code] = replayableHistory({ eventIndex: 30 });
  }
  const report = buildStrategySignalReport(
    candidates,
    historiesByCode,
    flatBenchmark(),
    {
      minSamples: 6,
      minOutOfSampleSamples: 6,
      minIndependentSignalDays: 6,
      minWalkForwardFoldSamples: 2,
      outOfSampleRatio: 0.3
    }
  );
  const boardSignal = report.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );

  assert.equal(boardSignal.validation.sampleCount, 30);
  assert.equal(boardSignal.validation.independentSignalDays, 1);
  assert.equal(boardSignal.validation.outOfSample.sampleCount, 0);
  assert.equal(boardSignal.validation.accepted, false);
  assert.match(boardSignal.validation.reason, /独立信号日不足/);
});

test("aggregates stocks from the same signal date equally before equity drawdown", () => {
  const winner = replayableHistory();
  const loser = replayableHistory();
  for (let index = 35; index < winner.length; index += 1) {
    winner[index] = {
      ...winner[index],
      open: 12,
      high: 12.1,
      low: 11.9,
      close: 12,
      volume: 95000
    };
    loser[index] = {
      ...loser[index],
      open: 9.7,
      high: 9.8,
      low: 9.6,
      close: 9.7,
      noPriceLimit: true,
      volume: 95000
    };
  }
  const report = buildStrategySignalReport(
    [
      { code: "600001", name: "同日盈利" },
      { code: "600002", name: "同日亏损" }
    ],
    { "600001": winner, "600002": loser },
    flatBenchmark(),
    { minSamples: 6 }
  );
  const boardSignal = report.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );

  assert.equal(boardSignal.validation.sampleCount, 2);
  assert.equal(boardSignal.validation.independentSignalDays, 1);
  assert.equal(boardSignal.validation.maxDrawdown, -0.046);
  assert.match(boardSignal.validation.equityAggregation, /同一信号日股票等权聚合/);
});

test("future bars after the holding window cannot change an earlier signal or its replay return", () => {
  const original = replayableHistory();
  const changedFuture = JSON.parse(JSON.stringify(original));
  for (let index = 70; index < changedFuture.length; index += 1) {
    changedFuture[index] = {
      ...changedFuture[index],
      open: 8,
      high: 8.1,
      low: 7.9,
      close: 8,
      volume: 500000
    };
  }
  const options = {
    minSamples: 6,
    minOutOfSampleSamples: 6,
    minIndependentSignalDays: 6
  };
  const originalReport = buildStrategySignalReport(
    [{ code: "600001", name: "未来函数审计" }],
    { "600001": original },
    flatBenchmark(),
    options
  );
  const changedReport = buildStrategySignalReport(
    [{ code: "600001", name: "未来函数审计" }],
    { "600001": changedFuture },
    flatBenchmark(),
    options
  );
  const originalLowFirst = originalReport.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );
  const changedLowFirst = changedReport.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );

  assert.equal(originalLowFirst.validation.sampleCount, 1);
  assert.equal(changedLowFirst.validation.sampleCount, 1);
  assert.equal(
    changedLowFirst.validation.averageReturn,
    originalLowFirst.validation.averageReturn
  );
  assert.equal(
    changedLowFirst.validation.range.from,
    originalLowFirst.validation.range.from
  );
});

test("excludes a flat next-day entry with no volume or amount as untradeable", () => {
  const history = replayableHistory();
  history[31] = {
    ...history[31],
    open: 10.8,
    high: 10.8,
    low: 10.8,
    close: 10.8,
    volume: 0,
    amount: 0
  };
  const report = buildStrategySignalReport(
    [{ code: "600001", name: "停牌样本", date: dateAt(89) }],
    { "600001": history },
    flatBenchmark(),
    { minSamples: 6 }
  );
  const boardSignal = report.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );

  assert.equal(boardSignal.validation.sampleCount, 0);
  assert.equal(boardSignal.validation.untradeableCount, 1);
  assert.equal(
    boardSignal.validation.untradeableReasons.suspendedOrNoLiquidity,
    1
  );
});

test("excludes a next-day one-price limit-up because the simulated entry cannot trade", () => {
  const history = replayableHistory({ onePriceEntry: true });
  const report = buildStrategySignalReport(
    [{ code: "600001", name: "不可成交样本", date: dateAt(89) }],
    { "600001": history },
    flatBenchmark(),
    {
      minSamples: 6,
      generatedAt: "2024-03-30T15:00:00+08:00"
    }
  );
  const boardSignal = report.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );

  assert.equal(boardSignal.validation.sampleCount, 0);
  assert.equal(boardSignal.validation.untradeableCount, 1);
  assert.equal(boardSignal.validation.accepted, false);
});

test("does not reject a one-price entry on a no-price-limit day as a limit-up lock", () => {
  const history = replayableHistory({ onePriceEntry: true, noPriceLimitEntry: true });
  history[31].amount = 1_000_000;
  history[31].volume = 100000;
  const report = buildStrategySignalReport(
    [{ code: "600001", name: "无涨跌幅限制样本", date: dateAt(89) }],
    { "600001": history },
    flatBenchmark(),
    { minSamples: 6, generatedAt: "2024-03-30T15:00:00+08:00" }
  );
  const boardSignal = report.strategies.find(strategy => strategy.id === "platform_breakout");

  assert.equal(boardSignal.validation.untradeableReasons.nextDayOnePriceLimitUp || 0, 0);
  assert.equal(boardSignal.validation.untradeableCount, 0);
});

test("missing volume cannot prove an entry fill even when amount is reported", () => {
  const history = replayableHistory();
  history[31] = { ...history[31], open: 10.98, high: 10.98, low: 10.98, close: 10.98, volume: null, amount: 1_000_000 };
  const report = buildStrategySignalReport(
    [{ code: "600001", name: "有成交额样本", date: dateAt(89) }],
    { "600001": history },
    flatBenchmark(),
    { minSamples: 6, generatedAt: "2024-03-30T15:00:00+08:00" }
  );
  const boardSignal = report.strategies.find(strategy => strategy.id === "platform_breakout");

  assert.equal(boardSignal.validation.untradeableReasons.suspendedOrNoLiquidity || 0, 1);
});

test("does not synthesize validation metrics when OHLCV rows are incomplete", () => {
  const report = buildStrategySignalReport(
    [
      {
        code: "600001",
        name: "缺失历史",
        latest: 10,
        date: "2026-07-30",
        analysis: {
          secondBreakout: true,
          heldSupport: true,
          riskVeto: true
        }
      }
    ],
    {
      "600001": [
        { date: "2026-07-29", close: 9.8 },
        { date: "2026-07-30", close: 10 }
      ]
    },
    [],
    {}
  );
  const strategy = report.strategies.find(
    (item) => item.id === "second_breakout"
  );

  assert.equal(report.coverage.historiesUsed, 0);
  assert.equal(strategy.validation.sampleCount, 0);
  assert.equal(strategy.validation.winRate, null);
  assert.equal(strategy.validation.averageReturn, null);
  assert.equal(strategy.validation.averageExcessReturn, null);
  assert.equal(strategy.validation.accepted, false);
  assert.equal(strategy.stocks.length, 0);
});

test("does not convert missing benchmark returns into zero excess returns", () => {
  const report = buildStrategySignalReport(
    [{ code: "600001", name: "缺少基准样本", date: dateAt(89) }],
    { "600001": replayableHistory() },
    [],
    { minSamples: 6 }
  );
  const boardSignal = report.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );

  assert.equal(boardSignal.validation.sampleCount, 1);
  assert.equal(boardSignal.validation.benchmarkSampleCount, 0);
  assert.equal(boardSignal.validation.averageExcessReturn, null);
  assert.equal(boardSignal.validation.outOfSample.benchmarkSampleCount, 0);
  assert.equal(boardSignal.validation.outOfSample.averageExcessReturn, null);
});

test("incomplete benchmark matches can never pass validation or publish the optimized portfolio", () => {
  const candidates = [];
  const historiesByCode = {};
  for (let index = 1; index <= 12; index += 1) {
    const code = `603${String(index).padStart(3, "0")}`;
    candidates.push({ code, name: `基准缺口样本${index}`, date: dateAt(89) });
    historiesByCode[code] = replayableHistory({ eventIndex: 24 + index * 2 });
  }
  const incompleteBenchmark = flatBenchmark().filter(
    (row) => row.date !== dateAt(49)
  );
  const report = buildStrategySignalReport(
    candidates,
    historiesByCode,
    incompleteBenchmark,
    {
      minSamples: 6,
      minOutOfSampleSamples: 6,
      minIndependentSignalDays: 6,
      minWalkForwardFoldSamples: 2,
      minWinRate: 40,
      minAverageReturn: 0,
      maxDrawdown: -22,
      outOfSampleRatio: 0.5
    }
  );
  const boardSignal = report.strategies.find(
    (strategy) => strategy.id === "platform_breakout"
  );

  assert.equal(boardSignal.validation.sampleCount, 12);
  assert.ok(
    boardSignal.validation.benchmarkSampleCount < boardSignal.validation.sampleCount
  );
  assert.equal(boardSignal.validation.benchmarkCoverage.complete, false);
  assert.equal(boardSignal.validation.accepted, false);
  assert.equal(boardSignal.validation.walkForward.accepted, false);
  assert.match(boardSignal.validation.reason, /基准可比交易不足/);
  assert.equal(report.optimizedPortfolio.accepted, false);
  assert.equal(report.optimizedPortfolio.publicationAccepted, false);
  assert.match(report.optimizedPortfolio.reason, /组合基准复核未完成/);
});

test("purges training trades whose holding window crosses an out-of-sample boundary", () => {
  const split = temporalSplit(
    [
      { code: "600001", signalDate: "2024-01-01", exitDate: "2024-01-03" },
      { code: "600002", signalDate: "2024-01-02", exitDate: "2024-01-06" },
      { code: "600003", signalDate: "2024-01-05", exitDate: "2024-01-10" },
      { code: "600004", signalDate: "2024-01-08", exitDate: "2024-01-12" }
    ],
    0.5
  );

  assert.equal(split.splitDate, "2024-01-05");
  assert.deepEqual(split.inSample.map((item) => item.code), ["600001"]);
  assert.equal(split.purgedTrainingSamples, 1);
});

test("dependence audit exposes duplicate strategies and robust score rewards OOS stability", () => {
  const samples = Array.from({ length: 6 }, (_, index) => ({
    code: `60000${index}`,
    signalDate: dateAt(index),
    netReturn: 1 + index / 10
  }));
  const duplicate = strategyDependence(
    { id: "a", samples },
    { id: "b", samples: samples.map((item) => ({ ...item })) }
  );
  const disjoint = strategyDependence(
    { id: "a", samples },
    {
      id: "c",
      samples: samples.map((item, index) => ({
        ...item,
        code: `30000${index}`
      }))
    }
  );
  assert.equal(duplicate.containment, 1);
  assert.equal(duplicate.redundant, true);
  assert.equal(disjoint.containment, 0);

  const stableScore = robustStrategyScore({
    accepted: true,
    outOfSample: {
      averageReturnLowerBound95: 0.8,
      averageExcessReturn: 1.1,
      winRateInterval95: [53, 71],
      maxDrawdown: -6
    },
    walkForward: { passRate: 0.8, degradationPercent: 15 },
    stability: { positiveBucketRate: 0.75 }
  });
  const weakScore = robustStrategyScore({
    accepted: false,
    outOfSample: {
      averageReturnLowerBound95: -0.8,
      averageExcessReturn: -0.4,
      winRateInterval95: [31, 49],
      maxDrawdown: -24
    },
    walkForward: { passRate: 0.25, degradationPercent: 80 },
    stability: { positiveBucketRate: 0.25 }
  });
  assert.ok(stableScore > weakScore);
});

test("current signals require real history and expose structured rule evidence", () => {
  const history = replayableHistory({ eventIndex: 89 });
  const report = buildStrategySignalReport(
    [{ code: "600001", name: "OHLCV证据", date: dateAt(89) }],
    { "600001": history },
    flatBenchmark(),
    { minCurrentHistoryBars: 60 }
  );
  const signal = report.strategies
    .find((strategy) => strategy.id === "platform_breakout")
    .stocks[0];

  assert.equal(signal.matchSource, "ohlcv");
  assert.equal(signal.historyBars, 90);
  assert.equal(signal.riskVetoStatus, "passed");
  assert.deepEqual(signal.matchedStrategyIds, ["platform_breakout"]);
  assert.equal(signal.componentEvidence[0].source, "ohlcv_rule_engine");
  assert.equal(signal.componentEvidence[0].passed, true);
});

test("optimized portfolio contract always separates development selection and terminal holdout", () => {
  const report = buildStrategySignalReport([], {}, flatBenchmark(), {});
  assert.equal(report.optimizedPortfolio.version, "robust-v2");
  assert.equal(report.optimizedPortfolio.accepted, false);
  assert.equal(report.optimizedPortfolio.selectedStrategies.length, 0);
  assert.equal(report.optimizedPortfolio.terminalHoldout.accepted, false);
  assert.match(report.optimizedPortfolio.methodology.holdout, /20%/);
});

test("selected strategy replay uses the exact strategy-signal definition for one stock", () => {
  const replay = buildSelectedStrategyReplay(
    ["platform_breakout"],
    { code: "600001", name: "策略联动样本" },
    replayableHistory(),
    flatBenchmark(),
    {
      minSamples: 6,
      minOutOfSampleSamples: 6,
      minIndependentSignalDays: 6,
      minWalkForwardFoldSamples: 2
    }
  );

  assert.equal(replay.id, "platform_breakout");
  assert.equal(replay.name, "平台突破首板");
  assert.deepEqual(replay.components, ["platform_breakout"]);
  assert.deepEqual(replay.componentNames, ["平台突破首板"], "versioned base metadata cannot erase the single-strategy name");
  assert.equal(replay.validation.validationVersion, "robust-v2-single-stock");
  assert.equal(replay.validation.sampleCount, 1);
  assert.equal(replay.samples[0].strategyId, "platform_breakout");
  assert.equal(replay.samples[0].code, "600001");
});

test("selected replay uses a custom entry price only when the next trading day reaches it", () => {
  const filled = buildSelectedStrategyReplay(
    ["platform_breakout"],
    { code: "600001", name: "自定义买入价样本" },
    replayableHistory(),
    flatBenchmark(),
    { customEntryPrice: 11 }
  );
  assert.equal(filled.samples.length, 1);
  assert.equal(filled.samples[0].entryPrice, 11);
  assert.equal(filled.samples[0].entryPriceSource, "custom_limit_price");

  const notReached = buildSelectedStrategyReplay(
    ["platform_breakout"],
    { code: "600001", name: "自定义买入价未触达样本" },
    replayableHistory(),
    flatBenchmark(),
    { customEntryPrice: 9 }
  );
  assert.equal(notReached.samples.length, 0);
  assert.equal(notReached.rejectedSignals.length, 1);
  assert.equal(notReached.rejectedSignals[0].reason, "customEntryPriceNotReached");
  assert.equal(notReached.untradeableReasons.customEntryPriceNotReached, 1);
});

test("selected replay preserves an untradeable strategy hit with stock, date and reason", () => {
  const replay = buildSelectedStrategyReplay(
    ["platform_breakout"],
    { code: "600001", name: "一字板样本" },
    replayableHistory({ onePriceEntry: true }),
    flatBenchmark(),
    {}
  );

  assert.equal(replay.samples.length, 0);
  assert.equal(replay.rejectedSignals.length, 1);
  assert.equal(replay.matchedSignalCount, 1);
  assert.deepEqual(replay.rejectedSignals[0].strategyIds, ["platform_breakout"]);
  assert.equal(replay.rejectedSignals[0].code, "600001");
  assert.equal(replay.rejectedSignals[0].signalDate, dateAt(30));
  assert.equal(replay.rejectedSignals[0].status, "rejected");
  assert.equal(replay.rejectedSignals[0].reason, "nextDayOnePriceLimitUp");
});

test("selected single-stock replay rejects a post-suspension bar that is not the next main-market day", () => {
  const history = replayableHistory();
  history.splice(31, 1);
  const replay = buildSelectedStrategyReplay(
    ["platform_breakout"],
    { code: "600001", name: "跨日复牌样本" },
    history,
    flatBenchmark(),
    {}
  );

  assert.equal(replay.samples.length, 0);
  assert.equal(replay.rejectedSignals.length, 1);
  assert.equal(replay.rejectedSignals[0].reason, "missingNextMarketDay");
  assert.equal(replay.rejectedSignals[0].expectedEntryDate, dateAt(31));
  assert.equal(replay.rejectedSignals[0].entryDate, dateAt(32));
  assert.equal(replay.untradeableReasons.missingNextMarketDay, 1);
  assert.equal(replay.validation.untradeableReasons.missingNextMarketDay, 1);
});

test("selected replay keeps a recent hit pending without inventing future returns", () => {
  const replay = buildSelectedStrategyReplay(
    ["platform_breakout"],
    { code: "600001", name: "最新信号样本" },
    replayableHistory({ eventIndex: 89 }),
    flatBenchmark(),
    {}
  );

  assert.equal(replay.samples.length, 0);
  assert.equal(replay.rejectedSignals.length, 0);
  assert.equal(replay.pendingSignals.length, 1);
  assert.equal(replay.pendingSignals[0].signalDate, dateAt(89));
  assert.equal(replay.pendingSignals[0].reason, "pending_next_trading_day");
  assert.equal(replay.pendingSignals[0].status, "pending");
});

test("selected strategy replay rejects IDs outside the verified signal library", () => {
  assert.throws(
    () => buildSelectedStrategyReplay(
      ["not_a_verified_strategy"],
      { code: "600001", name: "未知策略" },
      replayableHistory(),
      flatBenchmark()
    ),
    /未知策略/
  );
});

test('selection-only report runs existing current rules without any historical validation output', () => {
  const engine = require('./strategy-signal-engine.cjs');
  assert.equal(typeof engine.buildStrategySelectionReport, 'function');
  const history = replayableHistory({ eventIndex: 89 });
  const candidate = { code: '600001', name: '规则命中股份', latest: 11, tradingDaysSince: 0, turnover: 2, amount: 20000000 };
  // 夹具命中的是（已下线的）涨停形态规则：按 id 明确指定完整策略库。
  const options = { minCurrentHistoryBars: 60, asOfDate: history.at(-1).date, marketDates: history.map(row => row.date), generatedAt: '2026-10-20T10:00:00+08:00', strategyIds: ALL_STRATEGY_DEFINITIONS.map(definition => definition.id) };
  const expected = buildStrategySignalReport([candidate], { '600001': history }, flatBenchmark(), options);
  const actual = engine.buildStrategySelectionReport([candidate], { '600001': history }, flatBenchmark(), options);
  assert.equal(actual.mode, 'selection');
  assert.equal(actual.strategies.length, ALL_STRATEGY_DEFINITIONS.length);
  assert.ok(actual.strategies.some(group => group.stocks.length > 0));
  // 不指定 id 时（策略选股页）只跑在用策略。
  assert.deepEqual(engine.buildStrategySelectionReport([candidate], { '600001': history }, flatBenchmark(), { ...options, strategyIds: undefined }).strategies.map(group => group.id), STRATEGY_DEFINITIONS.map(definition => definition.id));
  for (const group of actual.strategies) {
    assert.deepEqual(group.stocks.map(stock => stock.code), expected.strategies.find(item => item.id === group.id).stocks.map(stock => stock.code));
    for (const field of ['validation', 'publicationAccepted', '_samples', 'backtest']) assert.equal(field in group, false);
  }
  for (const field of ['optimizedPortfolio', 'strategyAudit', 'auditedStrategies']) assert.equal(field in actual, false);
  const excluded = engine.buildStrategySelectionReport([{ ...candidate, isST: true }], { '600001': history }, flatBenchmark(), options);
  assert.ok(excluded.strategies.every(group => group.stocks.length === 0));
});

test('C2-03 ST/delisting names are filtered by the same shared predicate in every strategy list', () => {
  const engine = require('./strategy-signal-engine.cjs');
  const history = replayableHistory({ eventIndex: 89 });
  const options = { minCurrentHistoryBars: 60, asOfDate: history.at(-1).date, marketDates: history.map(row => row.date), generatedAt: '2026-10-20T10:00:00+08:00' };
  const run = name => buildStrategySignalReport(
    [{ code: '600001', name, latest: 11, tradingDaysSince: 0, turnover: 2, amount: 20000000 }],
    { '600001': history }, flatBenchmark(), options
  );
  // 正常名称会被列出，说明下面的 0 不是"夹具本来就不命中"。
  assert.ok(run('规则命中股份').strategies.some(group => group.stocks.length > 0));
  // 修复前这里只有 /ST|\*ST/：'甲退' 与 '退市乙' 会被列入 4 个策略；
  // 统一判定后与选股报告、趋势扫描一致，一律剔除。
  for (const name of ['*ST甲', '甲退', '退市乙', ' ST 丙 ']) {
    assert.equal(run(name).strategies.filter(group => group.stocks.length > 0).length, 0, name);
  }
  const selection = engine.buildStrategySelectionReport(
    [{ code: '600001', name: '甲退', latest: 11 }], { '600001': history }, flatBenchmark(), options
  );
  assert.equal(selection.dataQuality.excluded, 1);
  assert.equal(selection.dataQuality.reasons.risk_security, 1);
  assert.ok(selection.strategies.every(group => group.stocks.length === 0));
});

test('a null 95% lower bound is fail-closed instead of passing as zero', () => {
  const { summarizeSamples } = require('./strategy-signal-engine.cjs');
  const { buildValidation, lowerBoundPasses } = __test;
  // 9 independent signal days x 3 samples with a 5-session hold:
  // effectiveIndependentSamples = floor(9 / 5) = 1, so the bound cannot exist.
  const makeSamples = clusters => {
    const rows = [];
    for (let cluster = 0; cluster < clusters; cluster += 1) {
      const signalDate = dateAt(cluster * 2);
      for (let copy = 0; copy < 3; copy += 1) {
        rows.push({
          sampleId: `${cluster}-${copy}`, code: cluster % 2 ? '600001' : '600002', name: '样本',
          strategyId: 'demo', signalDate,
          entryDate: dateAt(cluster * 2 + 1), exitDate: dateAt(cluster * 2 + 6),
          netReturn: 1.2 + (cluster % 5) * 0.1, grossReturn: 1.5 + (cluster % 5) * 0.1,
          holdingTradingDays: 5, maxAdverseExcursion: -1,
          excessReturn: 0.8 + (cluster % 5) * 0.1
        });
      }
    }
    return rows;
  };
  const small = summarizeSamples(makeSamples(9));
  assert.equal(small.effectiveIndependentSamples, 1);
  assert.equal(small.averageReturnLowerBound95, null);
  // 20 signal days at a 30% hold-out still leaves 6 out-of-sample signal days,
  // which clears minOutOfSampleSamples but again yields floor(6 / 5) = 1.
  const samples = makeSamples(20);

  assert.equal(lowerBoundPasses(null, -0.25), false);
  assert.equal(lowerBoundPasses(undefined, -0.25), false);
  assert.equal(lowerBoundPasses('', -0.25), false);
  assert.equal(lowerBoundPasses(-0.3, -0.25), false);
  assert.equal(lowerBoundPasses(0, -0.25), true);

  const options = resolvedOptions({
    minSamples: 6, minOutOfSampleSamples: 3, minIndependentSignalDays: 6,
    minWalkForwardFoldSamples: 2, signalTo: dateAt(40)
  });
  const validation = buildValidation(samples, 0, {}, options);
  assert.equal(validation.outOfSample.independentSignalDays, 6);
  assert.equal(validation.outOfSample.averageReturnLowerBound95, null);
  assert.equal(validation.accepted, false);
  assert.match(validation.reason, /无法计算95%单侧下限/);
});

test('selection rules use current daily bars rather than historical pool prices or prior analysis', () => {
  const { buildStrategySelectionReport } = require('./strategy-signal-engine.cjs');
  const history = replayableHistory({ eventIndex: 30 });
  const last = history.at(-1);
  const candidate = { code: '600001', name: '历史涨停股', latest: 999, changePct: 10, isLimitUp: true, tradingDaysSince: 0, consecutiveBoards: 1, analysis: { eventCount60: 0 } };
  const report = buildStrategySelectionReport([candidate], { '600001': history }, flatBenchmark(), { asOfDate: history.at(-1).date, marketDates: history.map(row => row.date), minCurrentHistoryBars: 60, strategyIds: ALL_STRATEGY_DEFINITIONS.map(definition => definition.id) });
  assert.equal(report.strategies.find(group => group.id === 'platform_breakout').stocks.length, 0);
  for (const stock of report.strategies.flatMap(group => group.stocks)) {
    assert.equal(stock.latest, last.close);
    assert.equal(stock.changePct, ((last.close / history.at(-2).close) - 1) * 100);
  }
});

// A04: report output must use the selected shape's existing support, never an unrelated old limit low.
const selectionDates = require('./trend-trading-calendar.cjs').createTradingCalendar().sessionsThrough('2026-10-20', 120);
const selectionRow = (date, [open, high, low, close, volume = 150000]) => ({ date, open, high, low, close, volume, amount: close * volume * 100 });
function selectionPath(tail, price = 10) {
  const prefix = selectionDates.length - tail.length;
  return selectionDates.map((date, index) => selectionRow(date, index < prefix ? [price, price + .1, price - .1, price, 100000] : tail[index - prefix]));
}
const selectionBoard = (close, previous) => [previous * 1.02, close, previous * 1.01, close, 200000];
function selectionReport(rows, strategyId) {
  return require('./strategy-signal-engine.cjs').buildStrategySelectionReport([{ code: '600001', name: '离线样本' }], { '600001': rows }, [],
    { asOfDate: '2026-10-20', marketDates: selectionDates, strategyIds: [strategyId] });
}
test('dragon pullback reports its already-observed trough and the volume condition for invalidation', () => {
  const rows = selectionPath([selectionBoard(11, 10), selectionBoard(12.1, 11), selectionBoard(13.31, 12.1),
    [13.2, 13.3, 12.9, 13, 120000], [12.9, 13, 12.3, 12.4, 120000], [12.4, 12.5, 11.7, 11.8, 120000],
    [11.8, 11.9, 11.2, 11.3, 120000], [11.3, 11.4, 10.9, 11, 120000], [11, 11.35, 10.95, 11.3, 90000]]);
  const report = selectionReport(rows, 'youzi_dragon_pullback');
  assert.equal(report.dataQuality.processed, 1);
  assert.equal(report.strategies[0].stocks.length, 1);
  const stock = report.strategies[0].stocks[0];
  assert.equal(stock.latest, 11.3);
  assert.equal(stock.invalidationPrice, 10.9, 'the observed pullback low is 10.90; the old limit low is 12.221');
  assert.match(stock.executionNotes.join(' '), /失效依据.*回调低点.*放量/);
});
for (const oldLimit of [false, true]) test(`volume rebound reports the big up candle low (${oldLimit ? 'older limit exists' : 'no limit history'})`, () => {
  const rows = selectionDates.map((date, index) => {
    const close = index < 105 ? 20 : 20 - (index - 104) * .25;
    return selectionRow(date, [close, close + .1, close - .1, close, 100000]);
  });
  if (oldLimit) rows[100] = selectionRow(selectionDates[100], [20.4, 22, 20.1, 22, 200000]);
  rows[118] = selectionRow(selectionDates[118], [16.84, 17.97, 16.75, 17.92, 300000]);
  rows[119] = selectionRow(selectionDates[119], [17.92, 18.12, 17.60, 17.78, 300000]);
  const report = selectionReport(rows, 'volume_rebound_hold');
  assert.equal(report.dataQuality.processed, 1);
  assert.equal(report.strategies[0].stocks.length, 1);
  assert.equal(report.strategies[0].stocks[0].invalidationPrice, 16.75);
  assert.match(report.strategies[0].stocks[0].executionNotes.join(' '), /失效依据.*大阳.*最低价/);
});
test('a first-negative reclaim without a numeric support rule leaves the invalidation price empty', () => {
  const rows = selectionPath([selectionBoard(11, 10), selectionBoard(12.1, 11), [12.5, 12.6, 11.9, 12], [12, 12.8, 11.95, 12.7]]);
  const report = selectionReport(rows, 'youzi_first_negative_reclaim');
  assert.equal(report.strategies[0].stocks.length, 1);
  assert.equal(report.strategies[0].stocks[0].invalidationPrice, null);
});
test('existing limit-support rules keep their support boundary and publish its basis', () => {
  const rows = selectionPath([selectionBoard(11, 10)]);
  const original = selectionReport(rows, 'platform_breakout');
  assert.equal(original.strategies[0].stocks.length, 1);
  assert.equal(original.strategies[0].stocks[0].invalidationPrice, 10.05);
  assert.match(original.strategies[0].stocks[0].executionNotes.join(' '), /失效依据.*涨停日/);
});
test('arbitrary custom conditions publish no assumed numeric exit boundary', () => {
  const rows = selectionPath([selectionBoard(11, 10)]);
  const custom = require('./strategy-signal-engine.cjs').buildStrategySelectionReport([{code:'600001',name:'离线样本'}], {'600001':rows}, [], {
    asOfDate:'2026-10-20',marketDates:selectionDates,includeBuiltIn:false,
    customStrategies:[{id:'cs_exit0001',name:'平台条件',conditions:[{ref:'pattern:platform_breakout'}],minMatchPercent:100}]
  });
  assert.equal(custom.strategies[0].stocks.length, 1);
  assert.equal(custom.strategies[0].stocks[0].invalidationPrice, null);
});
