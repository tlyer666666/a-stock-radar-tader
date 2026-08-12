"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  scanStrategySignals,
  strategyValidationAliases,
  enrichStrategySignalReport,
  strategySignalOptions,
  buildStrategySignalReportInWorker,
  buildStrategyDataQuality,
  buildStrategySampleDiversity,
  selectIndependentValidationSample,
  edgeGateFromStats
} = require("./services.cjs");
const {
  buildStrategySignalReport
} = require("./strategy-signal-engine.cjs");

test("strategy scan service is exported for the Electron IPC layer", () => {
  assert.equal(typeof scanStrategySignals, "function");
  assert.equal(typeof buildStrategySignalReportInWorker, "function");
});

test("strategy replay runs outside the main event loop", async () => {
  let eventLoopYielded = false;
  const pending = buildStrategySignalReportInWorker([], {}, [], {
    generatedAt: "2026-08-03T10:00:00+08:00"
  });
  await new Promise((resolve) => {
    setImmediate(() => {
      eventLoopYielded = true;
      resolve();
    });
  });
  assert.equal(eventLoopYielded, true);
  const report = await pending;
  assert.equal(Array.isArray(report.strategies), true);
  assert.ok(report.strategies.length > 0);
});

test("engine composite metadata is preserved in both full audit contracts", () => {
  const engineReport = buildStrategySignalReport([], {}, [], {
    generatedAt: "2026-07-30T15:00:00+08:00"
  });
  const report = enrichStrategySignalReport(engineReport, [], {
    processed: 0,
    failed: 0,
    benchmarkFailed: false,
    benchmarkBars: 720,
    historyBarsRequested: 720
  });
  const engineComposites = engineReport.strategies.filter(
    (strategy) => strategy.type === "composite"
  );

  assert.ok(engineComposites.length > 0);
  assert.equal(
    report.baseStrategyCount,
    engineReport.strategies.length - engineComposites.length
  );
  assert.equal(report.compositeStrategyCount, engineComposites.length);
  assert.equal(report.publishedCompositeCount, 0);
  for (const engineStrategy of engineComposites) {
    const audited = report.auditedStrategies.find(
      (strategy) => strategy.id === engineStrategy.id
    );
    const summary = report.strategyAudit.find(
      (strategy) => strategy.id === engineStrategy.id
    );
    assert.equal(audited.type, engineStrategy.type);
    assert.deepEqual(audited.components, engineStrategy.components);
    assert.deepEqual(audited.voteRule, engineStrategy.voteRule);
    assert.equal(summary.type, engineStrategy.type);
    assert.deepEqual(summary.components, engineStrategy.components);
    assert.deepEqual(summary.voteRule, engineStrategy.voteRule);
    assert.equal(
      audited.validation.validationEvidence.publicationChecks
        .sameThresholdsAsBaseStrategy,
      true
    );
  }
});

test("strategy scan cannot weaken the minimum historical validation settings", () => {
  const options = strategySignalOptions({
    lookbackDays: 180,
    maxUniverse: 9999,
    minSamples: 6,
    minWinRate: 20,
    minAverageReturn: -2,
    maxDrawdown: -60,
    roundTripCostBps: 2,
    outOfSampleRatio: 0.15,
    walkForwardFolds: 2
  });

  assert.equal(options.historyBars, 720);
  assert.equal(options.provider, "ths");
  assert.equal(options.fallbackEnabled, true);
  assert.equal(options.multiSourceEnabled, true);
  assert.equal(options.maxUniverse, 300);
  assert.equal(options.replay.minSamples, 120);
  assert.equal(options.replay.minOutOfSampleSamples, 36);
  assert.equal(options.replay.minIndependentSignalDays, 60);
  assert.equal(options.replay.minWalkForwardFoldSamples, 10);
  assert.equal(options.replay.minWinRate, 45);
  assert.equal(options.replay.minAverageReturn, 0.2);
  assert.equal(options.replay.maxDrawdown, -22);
  assert.equal(options.replay.roundTripCostBps, 18);
  assert.equal(options.replay.outOfSampleRatio, 0.3);
  assert.equal(options.replay.walkForwardFolds, 4);
  assert.equal(options.replay.minCurrentHistoryBars, 120);
  assert.equal(options.replay.minReturnLowerBound, 0);
  assert.equal(options.replay.maxStrategyOverlap, 0.68);
  assert.equal(options.replay.optimizedMinVotes, 2);
  assert.equal(options.replay.terminalHoldoutRatio, 0.2);
});

test("strategy scan preserves the configured market-source policy", () => {
  const options = strategySignalOptions({
    provider: "eastmoney",
    fallbackEnabled: false,
    multiSourceEnabled: false
  });
  assert.equal(options.provider, "eastmoney");
  assert.equal(options.fallbackEnabled, false);
  assert.equal(options.multiSourceEnabled, false);
});

test("large validation universe reports board and date-cohort diversity", () => {
  const candidates = [
    { code: "600001", limitDate: "2026-07-30", industry: "机械" },
    { code: "000001", limitDate: "2026-07-29", industry: "银行" },
    { code: "300001", limitDate: "2026-07-28", industry: "软件" },
    { code: "688001", limitDate: "2026-07-27", industry: "半导体" },
    { code: "830001", limitDate: "2026-07-24", industry: "材料" }
  ];
  const diversity = buildStrategySampleDiversity(candidates);

  assert.equal(diversity.securities, 5);
  assert.equal(diversity.boardCount, 4);
  assert.equal(diversity.dateCohortCount, 5);
  assert.equal(diversity.industryOrThemeCount, 5);
  assert.equal(diversity.boardBuckets["沪深主板"], 2);
  assert.equal(diversity.boardBuckets["创业板"], 1);
  assert.equal(diversity.boardBuckets["科创板"], 1);
  assert.equal(diversity.boardBuckets["北交所"], 1);
  assert.equal(diversity.diversified, false);
  assert.deepEqual(diversity.concentrationWarnings, []);
});

test("strategy validation aliases prefer out-of-sample evidence and expose frontend fields", () => {
  const validation = strategyValidationAliases({
    accepted: true,
    sampleCount: 40,
    minimumSamples: 18,
    winRate: 61,
    averageReturn: 2.1,
    averageExcessReturn: 1.7,
    maxDrawdown: -8,
    outOfSample: {
      sampleCount: 12,
      benchmarkSampleCount: 12,
      winRate: 58.3,
      averageReturn: 1.4,
      averageExcessReturn: 1.1,
      maxDrawdown: -6.5
    },
    walkForward: {
      available: true,
      passRate: 2 / 3,
      positiveFoldRate: 1,
      degradationPercent: 20
    }
  });

  assert.equal(validation.outOfSampleCount, 12);
  assert.equal(validation.winRate5, 58.3);
  assert.equal(validation.average5, 1.4);
  assert.equal(validation.excess5, 1.1);
  assert.equal(validation.worstMdd5, -6.5);
  assert.equal(validation.walkForwardPassRate, 2 / 3);
  assert.equal(validation.stabilityScore, 77);
  assert.equal(validation.status, "PASS");
  assert.equal(validation.grade, "B");
});

test("missing validation evidence remains null instead of being fabricated", () => {
  const validation = strategyValidationAliases({
    accepted: false,
    sampleCount: 0,
    minimumSamples: 18,
    winRate: null,
    averageReturn: null,
    averageExcessReturn: null,
    maxDrawdown: null,
    outOfSample: { sampleCount: 0 },
    walkForward: { available: false, passRate: 0 }
  });

  assert.equal(validation.winRate5, null);
  assert.equal(validation.average5, null);
  assert.equal(validation.excess5, null);
  assert.equal(validation.worstMdd5, null);
  assert.equal(validation.stabilityScore, null);
  assert.equal(validation.status, "INSUFFICIENT");
  assert.equal(validation.grade, "D");
});

test("data-quality evidence records real ranges, usable bars and isolated failures", () => {
  const stockRows = [
    { date: "2024-01-02", open: 10, high: 11, low: 9, close: 10.5 },
    { date: "2024-01-03", open: 10.5, high: 11, low: 10, close: 10.8 }
  ];
  const benchmarkRows = [
    { date: "2023-12-29", open: 100, high: 101, low: 99, close: 100 },
    { date: "2024-01-03", open: 100, high: 102, low: 99, close: 101 }
  ];
  const quality = buildStrategyDataQuality(
    [
      { code: "600001", name: "样本一", limitDate: "2024-01-03" },
      { code: "600002", name: "样本二", limitDate: "2024-01-02" }
    ],
    [
      { ok: true, value: stockRows },
      { ok: false, error: "HTTP 503" }
    ],
    { ok: true, value: benchmarkRows },
    720
  );

  assert.equal(quality.requestedBars, 720);
  assert.equal(quality.dataRange.from, "2024-01-02");
  assert.equal(quality.dataRange.to, "2024-01-03");
  assert.equal(quality.candidateEventRange.from, "2024-01-02");
  assert.equal(quality.summary.usableSecurities, 1);
  assert.equal(quality.summary.failedSecurities, 1);
  assert.equal(quality.securities[0].usableBars, 2);
  assert.equal(quality.securities[1].failureReason, "HTTP 503");
  assert.equal(quality.benchmark.code, "000985");
  assert.equal(quality.benchmark.from, "2023-12-29");
  assert.deepEqual(quality.failures, [
    {
      code: "600002",
      name: "样本二",
      stage: "stock_history",
      reason: "HTTP 503"
    }
  ]);
});

test("unaccepted strategies remain auditable but are not published", () => {
  const report = enrichStrategySignalReport(
    {
      generatedAt: "2026-07-30T15:00:00+08:00",
      methodology: {
        entry: "次一交易日开盘价",
        exit: "持有五个交易日"
      },
      strategies: [
        {
          id: "low_first_board",
          name: "低位首板",
          detail: "低位启动",
          validation: {
            accepted: false,
            sampleCount: 8,
            minimumSamples: 18,
            outOfSample: { sampleCount: 2, winRate: 50 },
            walkForward: { available: false, passRate: 0 }
          },
          stocks: [
            {
              code: "600001",
              name: "真实样本",
              signalStrength: 86,
              reasons: ["低位首板"],
              risks: ["样本不足"]
            }
          ]
        }
      ]
    },
    [
      {
        code: "600001",
        name: "真实样本",
        secid: "1.600001",
        thscode: "600001.SH",
        latest: 12.34,
        changePct: 9.98,
        turnover: 6.2,
        amount: 123000000,
        industry: "机械",
        observationNode: "T+1",
        limitDate: "2026-07-29",
        consecutiveBoards: 1
      }
    ],
    {
      strategyIds: ["support", "avwap"],
      universeSize: 1,
      availableUniverseSize: 88,
      processed: 1,
      failed: 2,
      benchmarkFailed: true,
      benchmarkBars: 0,
      historyBarsRequested: 420
    }
  );

  assert.equal(report.sourceClass, "public_web");
  assert.equal(report.availableUniverseSize, 88);
  assert.equal(report.processed, 1);
  assert.equal(report.failed, 2);
  assert.equal(report.qualifiedCount, 0);
  assert.equal(report.strategies.length, 0);
  assert.equal(report.publishedStrategyCount, 0);
  assert.equal(report.rejectedStrategyCount, 1);
  assert.equal(report.strategyAudit.length, 1);
  assert.equal(report.auditedStrategies.length, 1);
  assert.equal(report.auditedStrategies[0].stocks.length, 1);
  assert.equal(
    report.auditedStrategies[0].stocks[0].validationPassed,
    false
  );
  assert.equal(report.strategyAudit[0].publicationAccepted, false);
  assert.equal(report.strategyAudit[0].currentMatchCount, 1);
  assert.ok(report.strategyAudit[0].failureReasons.length >= 1);
  assert.match(report.methodology, /次一交易日开盘价/);
  assert.match(report.warning, /被拦截/);
  assert.equal(report.currentCandidateSize, 1);
  assert.equal(report.validationUniverseSize, 1);
  assert.equal(report.universeDefinition.independentValidationUniverse, false);
  assert.match(report.selectionBiasWarning, /选择偏差与幸存者偏差/);
});

test("only accepted strategies with auditable windows and benchmark evidence are published", () => {
  const acceptedValidation = {
    accepted: true,
    sampleCount: 40,
    winCount: 24,
    lossCount: 16,
    benchmarkSampleCount: 40,
    averageReturn: 1.2,
    averageExcessReturn: 0.8,
    maxDrawdown: -9,
    horizonDays: 5,
    roundTripCostBps: 18,
    entryRule: "信号次一交易日开盘买入，持有5个交易日",
    returnType: "扣除双边交易成本后的区间收益率",
    range: { from: "2023-02-01", to: "2026-06-20" },
    inSample: {
      sampleCount: 28,
      winRate: 60,
      averageReturn: 1.3,
      maxDrawdown: -7,
      range: { from: "2023-02-01", to: "2025-04-30" }
    },
    outOfSample: {
      sampleCount: 12,
      benchmarkSampleCount: 12,
      winRate: 58.3,
      averageReturn: 1.0,
      averageExcessReturn: 0.7,
      maxDrawdown: -6,
      range: { from: "2025-05-01", to: "2026-06-20" }
    },
    walkForward: {
      available: true,
      accepted: true,
      passRate: 2 / 3,
      positiveFoldRate: 1,
      degradationPercent: 20,
      passedFolds: 2,
      folds: [
        {
          fold: 1,
          trainRange: { from: "2023-02-01", to: "2025-04-30" },
          testRange: { from: "2025-05-01", to: "2025-09-30" },
          trainSampleCount: 28,
          testSampleCount: 4,
          testAverageReturn: 0.8,
          testWinRate: 50,
          testMaxDrawdown: -3,
          accepted: true
        },
        {
          fold: 2,
          trainRange: { from: "2023-02-01", to: "2025-09-30" },
          testRange: { from: "2025-10-01", to: "2026-02-28" },
          trainSampleCount: 32,
          testSampleCount: 4,
          testAverageReturn: 1.1,
          testWinRate: 75,
          testMaxDrawdown: -2,
          accepted: true
        },
        {
          fold: 3,
          trainRange: { from: "2023-02-01", to: "2026-02-28" },
          testRange: { from: "2026-03-01", to: "2026-06-20" },
          trainSampleCount: 36,
          testSampleCount: 4,
          testAverageReturn: -0.1,
          testWinRate: 25,
          testMaxDrawdown: -4,
          accepted: false
        }
      ]
    }
  };
  const report = enrichStrategySignalReport(
    {
      strategies: [
        {
          id: "accepted",
          name: "已通过策略",
          type: "base",
          validation: acceptedValidation,
          stocks: [
            {
              code: "600001",
              name: "发布样本",
              signalStrength: 90
            }
          ]
        },
        {
          id: "rejected",
          name: "未通过策略",
          type: "composite",
          components: ["accepted", "another_base"],
          voteRule: {
            mode: "at_least",
            minimumVotes: 2
          },
          validation: {
            accepted: false,
            sampleCount: 10,
            outOfSample: { sampleCount: 3 },
            walkForward: {
              available: false,
              accepted: false,
              passRate: 0,
              folds: []
            },
            reason: "样本不足"
          },
          stocks: [
            {
              code: "600002",
              name: "拦截样本",
              signalStrength: 88
            }
          ]
        }
      ]
    },
    [
      { code: "600001", name: "发布样本", industry: "机械" },
      { code: "600002", name: "拦截样本", industry: "电子" }
    ],
    {
      universeSize: 2,
      currentCandidateSize: 2,
      validationUniverseSize: 2,
      processed: 2,
      failed: 0,
      benchmarkFailed: false,
      benchmarkBars: 720,
      historyBarsRequested: 720,
      dataQuality: {
        dataRange: { from: "2023-01-03", to: "2026-07-30" },
        benchmark: {
          from: "2023-01-03",
          to: "2026-07-30"
        }
      }
    }
  );

  assert.deepEqual(report.strategies.map((item) => item.id), ["accepted"]);
  assert.equal(report.strategies[0].stocks.length, 1);
  assert.equal(report.strategies[0].stocks[0].validationPassed, true);
  assert.equal(report.strategyAudit.length, 2);
  assert.equal(report.auditedStrategies.length, 2);
  assert.equal(
    report.auditedStrategies.find((item) => item.id === "accepted")
      .stocks[0].validationPassed,
    true
  );
  assert.equal(
    report.auditedStrategies.find((item) => item.id === "rejected")
      .stocks[0].validationPassed,
    false
  );
  assert.equal(report.publishedStrategyCount, 1);
  assert.equal(report.baseStrategyCount, 1);
  assert.equal(report.compositeStrategyCount, 1);
  assert.equal(report.publishedBaseCount, 1);
  assert.equal(report.publishedCompositeCount, 0);
  assert.equal(report.rejectedStrategyCount, 1);
  assert.equal(report.strategiesTested, 2);
  assert.match(report.multipleTestingWarning, /多重比较与过拟合风险/);
  const evidence = report.strategies[0].validation.validationEvidence;
  assert.equal(evidence.signalFrom, "2023-02-01");
  assert.equal(evidence.signalTo, "2026-06-20");
  assert.equal(evidence.totalTrades, 40);
  assert.equal(evidence.training.trades, 28);
  assert.equal(evidence.outOfSample.trades, 12);
  assert.equal(evidence.walkForward.windows.length, 3);
  assert.equal(evidence.execution.roundTripCostBps, 18);
  assert.equal(evidence.execution.roundTripCostPercent, 0.18);
  assert.equal(evidence.benchmark.code, "000985");
  assert.equal(evidence.benchmark.bars, 720);
  assert.equal(evidence.benchmark.from, "2023-01-03");
  assert.equal(evidence.publicationChecks.passed, true);
  assert.equal(
    evidence.publicationChecks.sameThresholdsAsBaseStrategy,
    true
  );
  assert.deepEqual(evidence.failureReasons, []);
  const rejectedAudit = report.strategyAudit.find(
    (item) => item.id === "rejected"
  );
  assert.equal(rejectedAudit.type, "composite");
  assert.deepEqual(rejectedAudit.components, ["accepted", "another_base"]);
  assert.deepEqual(rejectedAudit.voteRule, {
    mode: "at_least",
    minimumVotes: 2
  });
  const rejectedAudited = report.auditedStrategies.find(
    (item) => item.id === "rejected"
  );
  assert.equal(rejectedAudited.type, "composite");
  assert.deepEqual(rejectedAudited.components, [
    "accepted",
    "another_base"
  ]);
  assert.deepEqual(rejectedAudited.voteRule, {
    mode: "at_least",
    minimumVotes: 2
  });
});

test("composite strategies use the identical publication gate and preserve composition metadata", () => {
  const folds = [
    {
      fold: 1,
      trainRange: { from: "2023-01-01", to: "2024-01-31" },
      testRange: { from: "2024-02-01", to: "2024-06-30" },
      trainSampleCount: 21,
      testSampleCount: 3,
      accepted: true
    },
    {
      fold: 2,
      trainRange: { from: "2023-01-01", to: "2024-06-30" },
      testRange: { from: "2024-07-01", to: "2024-11-30" },
      trainSampleCount: 24,
      testSampleCount: 3,
      accepted: true
    },
    {
      fold: 3,
      trainRange: { from: "2023-01-01", to: "2024-11-30" },
      testRange: { from: "2024-12-01", to: "2025-04-30" },
      trainSampleCount: 27,
      testSampleCount: 3,
      accepted: false
    }
  ];
  const validComposite = {
    id: "composite_valid",
    name: "组合通过",
    type: "composite",
    components: ["base_a", "base_b", "base_c"],
    voteRule: {
      mode: "at_least",
      minimumVotes: 2,
      totalComponents: 3
    },
    validation: {
      accepted: true,
      sampleCount: 30,
      benchmarkSampleCount: 30,
      range: { from: "2023-01-01", to: "2025-04-30" },
      inSample: {
        sampleCount: 21,
        range: { from: "2023-01-01", to: "2024-01-31" }
      },
      outOfSample: {
        sampleCount: 9,
        benchmarkSampleCount: 9,
        range: { from: "2024-02-01", to: "2025-04-30" }
      },
      walkForward: {
        available: true,
        accepted: true,
        passRate: 2 / 3,
        positiveFoldRate: 2 / 3,
        degradationPercent: 25,
        passedFolds: 2,
        folds
      },
      horizonDays: 5,
      roundTripCostBps: 18
    },
    stocks: [
      { code: "600001", name: "组合发布股票", signalStrength: 92 }
    ]
  };
  const weakComposite = {
    ...validComposite,
    id: "composite_weak",
    name: "组合不足",
    components: ["base_d", "base_e"],
    voteRule: {
      mode: "all",
      minimumVotes: 2,
      totalComponents: 2
    },
    validation: {
      ...validComposite.validation,
      accepted: true,
      sampleCount: 29,
      outOfSample: {
        ...validComposite.validation.outOfSample,
        sampleCount: 8,
        benchmarkSampleCount: 8
      },
      walkForward: {
        ...validComposite.validation.walkForward,
        folds: folds.slice(0, 2),
        passRate: 1
      }
    },
    stocks: [
      { code: "600002", name: "组合拦截股票", signalStrength: 95 }
    ]
  };
  const report = enrichStrategySignalReport(
    {
      strategies: [weakComposite, validComposite]
    },
    [
      { code: "600001", name: "组合发布股票" },
      { code: "600002", name: "组合拦截股票" }
    ],
    {
      processed: 2,
      failed: 0,
      benchmarkFailed: false,
      benchmarkBars: 720,
      historyBarsRequested: 720
    }
  );

  assert.deepEqual(report.strategies.map((item) => item.id), [
    "composite_valid"
  ]);
  assert.equal(report.baseStrategyCount, 0);
  assert.equal(report.compositeStrategyCount, 2);
  assert.equal(report.publishedCompositeCount, 1);
  assert.equal(report.publishedBaseCount, 0);
  assert.equal(report.auditedStrategies[0].id, "composite_valid");
  assert.equal(report.auditedStrategies[1].id, "composite_weak");
  assert.deepEqual(report.strategies[0].components, [
    "base_a",
    "base_b",
    "base_c"
  ]);
  assert.deepEqual(report.strategies[0].voteRule, {
    mode: "at_least",
    minimumVotes: 2,
    totalComponents: 3
  });
  assert.equal(
    report.strategies[0].validation.validationEvidence.publicationChecks
      .thresholdProfile,
    "uniform_v1"
  );
  const weakAudit = report.strategyAudit.find(
    (item) => item.id === "composite_weak"
  );
  assert.equal(weakAudit.publicationAccepted, false);
  assert.match(weakAudit.failureReasons.join(" "), /29\/30/);
  assert.match(weakAudit.failureReasons.join(" "), /8\/9/);
  assert.match(weakAudit.failureReasons.join(" "), /2\/3/);
});

test("independent validation sampler is deterministic, excludes current signals and preserves board quotas", () => {
  const rows = [];
  const addBoard = (prefix, count, label) => {
    for (let index = 1; index <= count; index += 1) {
      rows.push({
        code: `${prefix}${String(index).padStart(6 - prefix.length, "0")}`,
        name: `${label}${index}`,
        industry: `行业${index % 12}`
      });
    }
  };
  addBoard("600", 100, "主板");
  addBoard("300", 80, "创业板");
  addBoard("688", 70, "科创板");
  addBoard("83", 60, "北交所");
  const first = selectIndependentValidationSample(rows, 120, ["600001"]);
  const second = selectIndependentValidationSample(rows, 120, ["600001"]);

  assert.deepEqual(first.map((item) => item.code), second.map((item) => item.code));
  assert.equal(first.length, 120);
  assert.equal(first.some((item) => item.code === "600001"), false);
  const counts = first.reduce((result, item) => {
    const board = /^(300|301)/.test(item.code)
      ? "growth"
      : /^(688|689)/.test(item.code)
        ? "star"
        : /^(4|8|9)/.test(item.code)
          ? "beijing"
          : "main";
    result[board] = (result[board] || 0) + 1;
    return result;
  }, {});
  assert.equal(counts.main, 60);
  assert.equal(counts.growth, 30);
  assert.equal(counts.star, 18);
  assert.equal(counts.beijing, 12);
});

test("historical edge gate blocks zero and tiny samples instead of treating missing evidence as a pass", () => {
  for (const sampleCount of [0, 1, 3, 11]) {
    const gate = edgeGateFromStats({
      stats: [{
        id: "currentCombination",
        sampleCount,
        winRate5: 80,
        average5: 3,
        worstMdd5: -2
      }]
    });
    assert.equal(gate.passed, false);
    assert.equal(gate.minimumSamples, 30);
    assert.match(gate.reasons.join(" "), new RegExp(`${sampleCount}\\/30`));
  }
});

test("optimized portfolio is published only with independent universe, terminal holdout and regime fit", () => {
  const rawReport = {
    strategies: [],
    optimizedPortfolio: {
      id: "optimized_robust_consensus",
      name: "稳健优选组合",
      accepted: true,
      selectedStrategies: [
        { id: "a", name: "A", robustScore: 82 },
        { id: "b", name: "B", robustScore: 78 }
      ],
      terminalHoldout: {
        accepted: true,
        sampleCount: 36,
        benchmarkSampleCount: 36
      },
      currentRegimeFit: { supported: true, regimeLabel: "震荡均衡" },
      validation: {
        accepted: true,
        sampleCount: 120,
        benchmarkSampleCount: 120
      },
      stocks: [{
        code: "600001",
        name: "组合样本",
        matchSource: "ohlcv",
        historyBars: 720,
        signalStrength: 91,
        matchedStrategyIds: ["a", "b"]
      }]
    }
  };
  const blocked = enrichStrategySignalReport(rawReport, [{ code: "600001" }], {
    independentValidationUniverse: false,
    benchmarkFailed: false,
    benchmarkBars: 720
  });
  const published = enrichStrategySignalReport(rawReport, [{ code: "600001" }], {
    independentValidationUniverse: true,
    benchmarkFailed: false,
    benchmarkBars: 720
  });
  const incompleteBenchmarkReport = {
    ...rawReport,
    optimizedPortfolio: {
      ...rawReport.optimizedPortfolio,
      validation: {
        ...rawReport.optimizedPortfolio.validation,
        benchmarkSampleCount: 119
      }
    }
  };
  const incompleteBenchmark = enrichStrategySignalReport(
    incompleteBenchmarkReport,
    [{ code: "600001" }],
    {
      independentValidationUniverse: true,
      benchmarkFailed: false,
      benchmarkBars: 720
    }
  );

  assert.equal(blocked.optimizedPortfolio.publicationAccepted, false);
  assert.equal(blocked.optimizedPortfolio.stocks.length, 0);
  assert.equal(published.optimizedPortfolio.publicationAccepted, true);
  assert.equal(published.optimizedPortfolio.stocks.length, 1);
  assert.equal(incompleteBenchmark.optimizedPortfolio.publicationAccepted, false);
  assert.equal(incompleteBenchmark.optimizedPortfolio.stocks.length, 0);
  assert.match(
    incompleteBenchmark.optimizedPortfolio.publicationFailureReasons.join(" "),
    /开发期基准可比交易不足：119\/120/
  );
});
