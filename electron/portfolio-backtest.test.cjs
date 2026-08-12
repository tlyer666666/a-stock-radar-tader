"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { simulateStrategyPortfolio } = require("./portfolio-backtest.cjs");
const {
  buildSelectedStrategyPortfolioReplay
} = require("./strategy-signal-engine.cjs");

const DATES = [
  "2026-01-02",
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  "2026-01-09"
];

function history(closes = [10, 10, 10, 10, 10, 10], dates = DATES) {
  return dates.map((date, index) => ({
    date,
    open: index ? Number(closes[index - 1]) : Number(closes[index]),
    high: Number(closes[index]) * 1.01,
    low: Number(closes[index]) * 0.99,
    close: Number(closes[index]),
    volume: 100000,
    amount: Number(closes[index]) * 100000 * 100
  }));
}

function benchmark(dates = DATES) {
  return dates.map((date) => ({ date, open: 100, close: 100 }));
}

function sample(code, overrides = {}) {
  return {
    strategyId: "test_strategy",
    code,
    name: code,
    signalDate: DATES[0],
    entryDate: DATES[1],
    exitDate: DATES[2],
    netReturn: 0,
    ...overrides
  };
}

test("shared account enforces capacity and same-day ordering deterministically", () => {
  const samples = [
    sample("600001", { netReturn: 20, priority: 90 }),
    sample("600002", { netReturn: -10, priority: 80 }),
    sample("600003", { netReturn: 100, priority: 10 })
  ];
  const histories = {
    "600001": history(),
    "600002": history(),
    "600003": history()
  };
  const left = simulateStrategyPortfolio(
    samples,
    histories,
    benchmark(),
    { startingCapital: 100, maxPositions: 2, lotSize: 1 }
  );
  const right = simulateStrategyPortfolio(
    [...samples].reverse(),
    histories,
    benchmark(),
    { startingCapital: 100, maxPositions: 2, lotSize: 1 }
  );

  assert.deepEqual(left.trades.map((trade) => trade.code), ["600001", "600002"]);
  assert.deepEqual(right.trades, left.trades, "input order must not choose the winners");
  assert.equal(left.trades[0].allocation, 50);
  assert.equal(left.trades[1].allocation, 50);
  assert.equal(left.metrics.endingCapital, 105);
  assert.equal(left.metrics.totalReturnPercent, 5);
  assert.equal(left.metrics.tradeCount, 2);
  assert.equal(left.metrics.winRate, 50);
  assert.equal(left.metrics.profitLossRatio, 2);
  assert.equal(left.metrics.profitFactor, 2);
  assert.equal(left.metrics.capacityRejected, 1);
  assert.equal(left.rejections[0].code, "600003");
  assert.equal(left.rejections[0].reason, "capacity_limit");
  assert.deepEqual(left.rejections[0].strategyIds, ["test_strategy"]);
  assert.deepEqual(
    left.contributions.map((row) => [row.code, row.pnl]),
    [["600001", 10], ["600002", -5]]
  );
});

test("exit-day proceeds and slots are unavailable to that morning entries", () => {
  const samples = [
    sample("600001", {
      sampleId: "first",
      signalDate: DATES[0],
      entryDate: DATES[1],
      exitDate: DATES[3],
      netReturn: 10
    }),
    sample("600001", {
      sampleId: "overlap",
      signalDate: DATES[1],
      entryDate: DATES[2],
      exitDate: DATES[4],
      netReturn: 50
    }),
    sample("600002", {
      sampleId: "same-exit-morning",
      signalDate: DATES[2],
      entryDate: DATES[3],
      exitDate: DATES[4],
      netReturn: 90
    }),
    sample("600002", {
      sampleId: "next-morning",
      signalDate: DATES[3],
      entryDate: DATES[4],
      exitDate: DATES[5],
      netReturn: 10
    })
  ];
  const result = simulateStrategyPortfolio(
    samples,
    { "600001": history(), "600002": history() },
    benchmark(),
    { startingCapital: 100, maxPositions: 1, lotSize: 1 }
  );

  assert.deepEqual(result.trades.map((trade) => trade.sampleId), ["first", "next-morning"]);
  assert.equal(result.metrics.endingCapital, 121);
  assert.equal(result.metrics.overlapRejected, 1);
  assert.equal(result.metrics.capacityRejected, 1);
  assert.equal(
    result.rejections.find((item) => item.sampleId === "same-exit-morning").reason,
    "capacity_limit"
  );
  assert.equal(
    result.equityCurve.find((point) => point.date === DATES[3]).openedToday,
    0,
    "the position exiting at this close must still occupy its morning slot"
  );
});

test("equity curve marks open positions to close and calculates drawdown", () => {
  const result = simulateStrategyPortfolio(
    [sample("600001", {
      exitDate: DATES[4],
      netReturn: 10
    })],
    { "600001": history([10, 10, 8, 9, 11, 11]) },
    benchmark(),
    { startingCapital: 100, maxPositions: 1, lotSize: 1 }
  );

  assert.deepEqual(
    result.equityCurve.map((point) => point.equity),
    [100, 100, 80, 90, 110, 110]
  );
  assert.deepEqual(result.range, { from: DATES[0], to: DATES.at(-1) });
  assert.equal(result.metrics.totalReturnPercent, 10);
  assert.equal(result.metrics.maxDrawdownPercent, -20);
  assert.equal(
    result.metrics.annualizedReturnPercent,
    Number((((1.1 ** (252 / DATES.length)) - 1) * 100).toFixed(4))
  );
  assert.equal(result.metrics.winRatePercent, 100);
  assert.equal(result.metrics.tradeCount, 1);
  assert.equal(result.trades[0].pnl, 10);
  assert.equal(result.contributions[0].contributionPercent, 10);
  assert.equal(result.status, "DIAGNOSTIC");
  assert.equal(result.validation.accepted, false);
  assert.match(result.validation.reasons.join(" "), /少于30只/);
});

test("master market calendar rejects a stock suspended on the next market day", () => {
  const suspendedDates = [DATES[0], DATES[2], DATES[3]];
  const result = simulateStrategyPortfolio(
    [sample("600001", {
      signalDate: DATES[0],
      entryDate: DATES[2],
      exitDate: DATES[3],
      netReturn: 30
    })],
    { "600001": history([10, 10.2, 10.5], suspendedDates) },
    benchmark(),
    { startingCapital: 100, maxPositions: 1, lotSize: 1 }
  );

  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.metrics.endingCapital, 100);
  assert.equal(result.metrics.missingNextMarketDayRejected, 1);
  assert.equal(result.rejections[0].reason, "missingNextMarketDay");
  assert.match(result.rejections[0].reasonText, /停牌|缺失行情/);
});

test("empty signals return an all-cash diagnostic result", () => {
  const result = simulateStrategyPortfolio(
    [],
    { "600001": history() },
    benchmark(),
    { startingCapital: 123, maxPositions: 2 }
  );
  assert.equal(result.status, "DIAGNOSTIC");
  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.metrics.totalReturnPercent, 0);
  assert.equal(result.metrics.endingCapital, 123);
  assert.equal(result.equityCurve.length, DATES.length);
  assert.ok(result.equityCurve.every((point) => point.equity === 123));
  assert.match(result.validation.reasons.join(" "), /没有可成交信号/);
});

test("A-share lot size and per-stock position cap determine actual cash usage", () => {
  const capped = simulateStrategyPortfolio(
    [sample("600001", { netReturn: 10 })],
    { "600001": history() },
    benchmark(),
    {
      startingCapital: 10000,
      maxPositions: 1,
      maxPositionPercent: 50
    }
  );
  assert.equal(capped.trades[0].shares, 500);
  assert.equal(capped.trades[0].allocation, 5000);
  assert.equal(capped.metrics.endingCapital, 10500);
  assert.equal(capped.settings.lotSize, 100);
  assert.equal(capped.settings.maxPositionPercent, 50);

  const tooSmall = simulateStrategyPortfolio(
    [sample("600001", { netReturn: 10 })],
    { "600001": history() },
    benchmark(),
    { startingCapital: 500, maxPositions: 1 }
  );
  assert.equal(tooSmall.metrics.tradeCount, 0);
  assert.equal(tooSmall.metrics.insufficientLotRejected, 1);
  assert.equal(tooSmall.rejections[0].reason, "insufficient_lot");
});

test("portfolio input validation rejects malformed samples and histories", () => {
  assert.throws(
    () => simulateStrategyPortfolio({}, {}, benchmark()),
    /samples 必须是数组/
  );
  assert.throws(
    () => simulateStrategyPortfolio(
      [sample("600001")],
      {},
      benchmark()
    ),
    /缺少历史行情/
  );
  assert.throws(
    () => simulateStrategyPortfolio(
      [sample("600001", { entryDate: DATES[2], exitDate: DATES[3] })],
      { "600001": history() },
      benchmark()
    ),
    /入场日必须是信号日后的首个交易日/
  );
  assert.throws(
    () => simulateStrategyPortfolio(
      [sample("600001", { netReturn: undefined })],
      { "600001": history() },
      benchmark()
    ),
    /netReturn/
  );
  assert.throws(
    () => simulateStrategyPortfolio(
      [sample("600001")],
      { "600001": history() },
      benchmark(),
      { maxPositions: 0, lotSize: 1 }
    ),
    /maxPositions/
  );
});

function replayDate(index) {
  return new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
}

function replayHistory(eventIndex) {
  const rows = [];
  for (let index = 0; index < 90; index += 1) {
    let open = 10;
    let high = 10.2;
    let low = 9.8;
    let close = 10;
    let volume = 100000;
    if (index === eventIndex) {
      open = 10.1;
      high = 11;
      low = 10.05;
      close = 11;
      volume = 180000;
    } else if (index > eventIndex) {
      close = 11 + (index - eventIndex) * 0.04;
      open = close - 0.03;
      high = close + 0.08;
      low = close - 0.08;
      volume = 90000;
    }
    rows.push({
      date: replayDate(index),
      open,
      high,
      low,
      close,
      volume,
      amount: close * volume * 100,
      turnover: 2
    });
  }
  return rows;
}

test("selected strategy portfolio replay exposes combined and per-security samples", () => {
  const histories = {
    "600001": replayHistory(30),
    "600002": replayHistory(40)
  };
  const replay = buildSelectedStrategyPortfolioReplay(
    ["low_first_board"],
    [
      { code: "600002", name: "样本二" },
      { code: "600001", name: "样本一" }
    ],
    histories,
    history(Array(90).fill(100), Array.from({ length: 90 }, (_, index) => replayDate(index))),
    {
      minSamples: 6,
      minOutOfSampleSamples: 6,
      minIndependentSignalDays: 6
    }
  );

  assert.equal(replay.id, "low_first_board");
  assert.deepEqual(replay.componentNames, ["低位首板"]);
  assert.equal(replay.securityCount, 2);
  assert.equal(replay.perSecurity.length, 2);
  assert.deepEqual(replay.perSecurity.map((row) => row.code), ["600001", "600002"]);
  assert.equal(replay.samples.length, 2);
  assert.equal(replay.validation.sampleCount, 2);
  assert.ok(replay.samples.every((row) => row.entryDate > row.signalDate));
});

test("selected multi-stock replay removes entries missing the next master-market day", () => {
  const suspended = replayHistory(30);
  suspended.splice(31, 1);
  const benchmarkRows = history(
    Array(90).fill(100),
    Array.from({ length: 90 }, (_, index) => replayDate(index))
  );
  const replay = buildSelectedStrategyPortfolioReplay(
    ["low_first_board"],
    [{ code: "600001", name: "停牌样本" }],
    { "600001": suspended },
    benchmarkRows,
    {}
  );

  assert.equal(replay.sampleCount, 0);
  assert.equal(replay.perSecurity[0].sampleCount, 0);
  assert.equal(replay.rejections.length, 1);
  assert.equal(replay.rejections[0].reason, "missingNextMarketDay");
  assert.equal(replay.untradeableReasons.missingNextMarketDay, 1);
});

test("portfolio replay limits signals to the requested window while retaining warmup history", () => {
  const benchmarkRows = history(
    Array(90).fill(100),
    Array.from({ length: 90 }, (_, index) => replayDate(index))
  );
  const replay = buildSelectedStrategyPortfolioReplay(
    ["low_first_board"],
    [{ code: "600001", name: "预热窗口样本" }],
    { "600001": replayHistory(30) },
    benchmarkRows,
    {
      signalFrom: replayDate(40),
      signalTo: replayDate(89)
    }
  );

  assert.equal(replay.sampleCount, 0);
  assert.equal(replay.matchedSignalCount, 0);
  assert.equal(replay.perSecurity[0].historyBars, 90);
});

test("portfolio replay exposes a latest strategy hit as pending", () => {
  const benchmarkRows = history(
    Array(90).fill(100),
    Array.from({ length: 90 }, (_, index) => replayDate(index))
  );
  const replay = buildSelectedStrategyPortfolioReplay(
    ["low_first_board"],
    [{ code: "600001", name: "最新信号样本" }],
    { "600001": replayHistory(89) },
    benchmarkRows,
    {}
  );

  assert.equal(replay.sampleCount, 0);
  assert.equal(replay.pendingCount, 1);
  assert.equal(replay.matchedSignalCount, 1);
  assert.equal(replay.pendingSignals[0].signalDate, replayDate(89));
});

test("portfolio replay counts a replay-layer rejection exactly once", () => {
  const rows = replayHistory(30);
  rows[31] = {
    ...rows[31],
    open: 12.1,
    high: 12.1,
    low: 12.1,
    close: 12.1,
    volume: 100000,
    amount: 121000000
  };
  const benchmarkRows = history(
    Array(90).fill(100),
    Array.from({ length: 90 }, (_, index) => replayDate(index))
  );
  const replay = buildSelectedStrategyPortfolioReplay(
    ["low_first_board"],
    [{ code: "600001", name: "一字板样本" }],
    { "600001": rows },
    benchmarkRows,
    {}
  );

  assert.equal(replay.sampleCount, 0);
  assert.equal(replay.rejections.length, 1);
  assert.equal(replay.untradeableCount, 1);
  assert.equal(replay.validation.untradeableCount, 1);
  assert.equal(replay.perSecurity[0].validation.untradeableCount, 1);
});
