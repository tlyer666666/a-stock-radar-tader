"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildStrategySignalReport,
  buildSelectedStrategyReplay,
  STRATEGY_DEFINITIONS,
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

function replayableHistory({ onePriceEntry = false, eventIndex = 30 } = {}) {
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
      turnover: 2
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

test("signals before the requested date window do not consume cooldown", () => {
  const history = replayableHistory();
  const featureTimeline = Array.from({ length: history.length }, () => null);
  featureTimeline[20] = { hit: true, date: dateAt(20) };
  featureTimeline[22] = { hit: true, date: dateAt(22) };
  const replay = replayStrategy(
    {
      id: "date_window_boundary",
      name: "日期窗口边界",
      matches: (feature) => feature?.hit === true
    },
    "600001",
    "日期窗口样本",
    history,
    new Map(flatBenchmark().map((row) => [row.date, row])),
    resolvedOptions({
      signalFrom: dateAt(22),
      signalTo: dateAt(40),
      cooldownDays: 5,
      horizonDays: 1
    }),
    { featureTimeline }
  );

  assert.equal(replay.samples.length, 1);
  assert.equal(replay.samples[0].signalDate, dateAt(22));
});

test("returns eighteen auditable strategy groups and refuses current matches without OHLCV history", () => {
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
  assert.equal(report.strategies.length, 18);
  assert.deepEqual(
    report.strategies.map((strategy) => strategy.id),
    STRATEGY_DEFINITIONS.map((strategy) => strategy.id)
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
  const lowFirst = report.strategies.find(
    (strategy) => strategy.id === "low_first_board"
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
  assert.equal(lowFirst.validation.sampleCount, 12);
  assert.equal(platform.validation.sampleCount, 12);
  assert.ok(compression.validation.sampleCount >= 12);
  assert.equal(secondBreakout.validation.sampleCount, 12);
  assert.equal(weakToStrong.validation.sampleCount, 12);
  assert.equal(firstBoardComposite.validation.sampleCount, 12);
  assert.ok(lowFirst.validation.averageReturn > 4);
  assert.equal(lowFirst.validation.averageReturn, 4.52);
  assert.equal(lowFirst.validation.benchmarkSampleCount, 12);
  assert.equal(lowFirst.validation.averageExcessReturn > 4, true);
  assert.equal(lowFirst.validation.outOfSample.sampleCount, 6);
  assert.equal(lowFirst.validation.walkForward.available, true);
  assert.equal(lowFirst.validation.walkForward.folds.length, 3);
  assert.equal(lowFirst.validation.walkForward.accepted, true);
  assert.equal(lowFirst.validation.accepted, true);
  assert.equal(firstBoardComposite.validation.accepted, true);
  assert.notStrictEqual(
    firstBoardComposite.validation,
    lowFirst.validation,
    "composite validation must be replayed independently"
  );
  assert.equal(
    lowFirst.validation.entryRule.includes("次一交易日开盘"),
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
  const lowFirst = report.strategies.find(
    (strategy) => strategy.id === "low_first_board"
  );

  assert.equal(lowFirst.validation.sampleCount, 30);
  assert.equal(lowFirst.validation.independentSignalDays, 1);
  assert.equal(lowFirst.validation.outOfSample.sampleCount, 0);
  assert.equal(lowFirst.validation.accepted, false);
  assert.match(lowFirst.validation.reason, /独立信号日不足/);
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
  const lowFirst = report.strategies.find(
    (strategy) => strategy.id === "low_first_board"
  );

  assert.equal(lowFirst.validation.sampleCount, 2);
  assert.equal(lowFirst.validation.independentSignalDays, 1);
  assert.equal(lowFirst.validation.maxDrawdown, -0.18);
  assert.match(lowFirst.validation.equityAggregation, /同一信号日股票等权聚合/);
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
    (strategy) => strategy.id === "low_first_board"
  );
  const changedLowFirst = changedReport.strategies.find(
    (strategy) => strategy.id === "low_first_board"
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
  const lowFirst = report.strategies.find(
    (strategy) => strategy.id === "low_first_board"
  );

  assert.equal(lowFirst.validation.sampleCount, 0);
  assert.equal(lowFirst.validation.untradeableCount, 1);
  assert.equal(
    lowFirst.validation.untradeableReasons.suspendedOrNoLiquidity,
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
  const lowFirst = report.strategies.find(
    (strategy) => strategy.id === "low_first_board"
  );

  assert.equal(lowFirst.validation.sampleCount, 0);
  assert.equal(lowFirst.validation.untradeableCount, 1);
  assert.equal(lowFirst.validation.accepted, false);
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
  const lowFirst = report.strategies.find(
    (strategy) => strategy.id === "low_first_board"
  );

  assert.equal(lowFirst.validation.sampleCount, 1);
  assert.equal(lowFirst.validation.benchmarkSampleCount, 0);
  assert.equal(lowFirst.validation.averageExcessReturn, null);
  assert.equal(lowFirst.validation.outOfSample.benchmarkSampleCount, 0);
  assert.equal(lowFirst.validation.outOfSample.averageExcessReturn, null);
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
  const lowFirst = report.strategies.find(
    (strategy) => strategy.id === "low_first_board"
  );

  assert.equal(lowFirst.validation.sampleCount, 12);
  assert.ok(
    lowFirst.validation.benchmarkSampleCount < lowFirst.validation.sampleCount
  );
  assert.equal(lowFirst.validation.benchmarkCoverage.complete, false);
  assert.equal(lowFirst.validation.accepted, false);
  assert.equal(lowFirst.validation.walkForward.accepted, false);
  assert.match(lowFirst.validation.reason, /基准可比交易不足/);
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
    .find((strategy) => strategy.id === "low_first_board")
    .stocks[0];

  assert.equal(signal.matchSource, "ohlcv");
  assert.equal(signal.historyBars, 90);
  assert.equal(signal.riskVetoStatus, "passed");
  assert.deepEqual(signal.matchedStrategyIds, ["low_first_board"]);
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
    ["low_first_board"],
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

  assert.equal(replay.id, "low_first_board");
  assert.equal(replay.name, "低位首板");
  assert.deepEqual(replay.components, ["low_first_board"]);
  assert.equal(replay.validation.validationVersion, "robust-v2-single-stock");
  assert.equal(replay.validation.sampleCount, 1);
  assert.equal(replay.samples[0].strategyId, "low_first_board");
  assert.equal(replay.samples[0].code, "600001");
});

test("selected replay uses a custom entry price only when the next trading day reaches it", () => {
  const filled = buildSelectedStrategyReplay(
    ["low_first_board"],
    { code: "600001", name: "自定义买入价样本" },
    replayableHistory(),
    flatBenchmark(),
    { customEntryPrice: 11 }
  );
  assert.equal(filled.samples.length, 1);
  assert.equal(filled.samples[0].entryPrice, 11);
  assert.equal(filled.samples[0].entryPriceSource, "custom_limit_price");

  const notReached = buildSelectedStrategyReplay(
    ["low_first_board"],
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
    ["low_first_board"],
    { code: "600001", name: "一字板样本" },
    replayableHistory({ onePriceEntry: true }),
    flatBenchmark(),
    {}
  );

  assert.equal(replay.samples.length, 0);
  assert.equal(replay.rejectedSignals.length, 1);
  assert.equal(replay.matchedSignalCount, 1);
  assert.deepEqual(replay.rejectedSignals[0].strategyIds, ["low_first_board"]);
  assert.equal(replay.rejectedSignals[0].code, "600001");
  assert.equal(replay.rejectedSignals[0].signalDate, dateAt(30));
  assert.equal(replay.rejectedSignals[0].status, "rejected");
  assert.equal(replay.rejectedSignals[0].reason, "nextDayOnePriceLimitUp");
});

test("selected single-stock replay rejects a post-suspension bar that is not the next main-market day", () => {
  const history = replayableHistory();
  history.splice(31, 1);
  const replay = buildSelectedStrategyReplay(
    ["low_first_board"],
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
    ["low_first_board"],
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
