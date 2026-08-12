const test = require("node:test");
const assert = require("node:assert/strict");
const services = require("./services.cjs");
const {
  buildProfessionalReviewSnapshot,
  getProfessionalReview,
  marketSession,
  resetProfessionalReviewCache
} = require("./review-service.cjs");

function chart(lastClose, changes = [0.2, 0.4, 0.6, 0.8, 1]) {
  let close = lastClose - 4;
  return {
    rows: Array.from({ length: 30 }, (_, index) => {
      close += index >= 25 ? changes[index - 25] || 0.2 : 0.08;
      return {
        date: `2026-07-${String(index + 1).padStart(2, "0")}`,
        open: close - 0.2,
        close,
        high: close + 0.4,
        low: close - 0.4,
        amount: 1_000_000_000 + index * 10_000_000
      };
    })
  };
}

test("market session always uses China Standard Time", () => {
  assert.equal(marketSession("2026-07-30T01:14:00Z"), "盘前");
  assert.equal(marketSession("2026-07-30T01:15:00Z"), "上午盘中");
  assert.equal(marketSession("2026-07-30T03:30:00Z"), "午间");
  assert.equal(marketSession("2026-07-30T05:00:00Z"), "下午盘中");
  assert.equal(marketSession("2026-07-30T07:00:00Z"), "收盘复盘");
  assert.equal(marketSession("2026-07-30T15:10:00+08:00"), "收盘复盘");
});

test("professional review derives regime, ecology and conditional playbook from facts", () => {
  const currentPool = [
    { code: "000001", name: "甲公司", consecutiveBoards: 3, industry: "机器人", openBoardCount: 0, firstSealRaw: 93000 },
    { code: "000002", name: "乙公司", consecutiveBoards: 2, industry: "机器人", openBoardCount: 1, firstSealRaw: 94500 },
    { code: "000003", name: "丙公司", consecutiveBoards: 1, industry: "算力", openBoardCount: 0, firstSealRaw: 95500 }
  ];
  const previousPool = [
    { code: "000001" },
    { code: "000002" },
    { code: "000009" }
  ];
  const review = buildProfessionalReviewSnapshot({
    generatedAt: "2026-07-30T15:10:00+08:00",
    emotion: {
      date: "2026-07-30",
      limitUpCount: 96,
      limitDownCount: 5,
      previousLimitUpCount: 72,
      score: 80
    },
    market: {
      stockCount: 5300,
      upCount: 3600,
      downCount: 1500,
      flatCount: 200,
      breadth: 3600 / 5300,
      averageReturn: 1.1
    },
    ladderPools: {
      currentPool,
      previousPool,
      failedPool: [{ code: "000010" }]
    },
    sectors: [
      { name: "机器人", score: 83, relativeReturn: 2.1, poolShare: 0.22 },
      { name: "算力", score: 76, relativeReturn: 1.3, poolShare: 0.18 },
      { name: "CPO", score: 69, relativeReturn: 0.8, poolShare: 0.1 }
    ],
    indices: [
      ["中证全指", "000985"],
      ["上证指数", "000001"],
      ["深证成指", "399001"],
      ["创业板指", "399006"],
      ["沪深300", "000300"]
    ].map(([name, code], index) => ({
      definition: { name, code, secid: `${index ? 0 : 1}.${code}` },
      chart: chart(100 + index)
    }))
  });

  assert.equal(review.date, "2026-07-30");
  assert.equal(review.session, "收盘复盘");
  assert.ok(review.score >= 60);
  assert.ok(["趋势进攻", "修复轮动"].includes(review.regime.name));
  assert.equal(review.ecology.promoted, 2);
  assert.equal(review.ecology.maxHeight, 3);
  assert.equal(review.focusSectors[0].name, "机器人");
  assert.equal(review.leaders[0].name, "甲公司");
  assert.equal(review.scenarios.length, 3);
  assert.ok(review.scenarios.every((item) => item.conditions.length >= 3));
  assert.ok(review.nextPlan.avoid.length >= 3);
  assert.equal(review.indices.length, 5);
});

test("professional review enters defense when breadth and limit ecology deteriorate", () => {
  const review = buildProfessionalReviewSnapshot({
    generatedAt: "2026-07-30T14:10:00+08:00",
    emotion: {
      date: "2026-07-30",
      limitUpCount: 18,
      limitDownCount: 42,
      previousLimitUpCount: 60,
      score: 25
    },
    market: {
      stockCount: 5300,
      upCount: 900,
      downCount: 4100,
      flatCount: 300,
      breadth: 900 / 5300,
      averageReturn: -2.2
    },
    ladderPools: {
      currentPool: [{ code: "000001", name: "甲公司", consecutiveBoards: 1 }],
      previousPool: Array.from({ length: 8 }, (_, index) => ({ code: `00000${index + 1}` })),
      failedPool: Array.from({ length: 9 }, (_, index) => ({ code: `30000${index + 1}` }))
    },
    sectors: [{ name: "防御", score: 42, relativeReturn: -1.2, poolShare: 0.1 }],
    indices: Array.from({ length: 5 }, (_, index) => ({
      name: `指数${index + 1}`,
      close: 90,
      ma5: 95,
      ma20: 100,
      score: 20,
      returns: { r1: -2, r3: -4, r5: -6 }
    }))
  });

  assert.equal(review.regime.name, "退潮防守");
  assert.equal(review.exposure.max, 20);
  assert.ok(review.riskSignals.some((item) => item.includes("上涨广度")));
  assert.ok(review.riskSignals.some((item) => item.includes("跌停/涨停比")));
});

test("professional review refresh propagates to every index chart request", async () => {
  const originals = Object.fromEntries([
    "getChart",
    "marketEmotionSnapshot",
    "wholeMarketSnapshot",
    "currentLadderPools",
    "getLimitUpSectorBoard",
    "discoverLimitUps"
  ].map((key) => [key, services[key]]));
  const chartRefreshFlags = [];
  try {
    services.getChart = async (_definition, _frame, options) => {
      chartRefreshFlags.push(options?.forceRefresh === true);
      return chart(100);
    };
    services.marketEmotionSnapshot = async () => ({
      date: "2026-08-10",
      limitUpCount: 0,
      limitDownCount: 0,
      previousLimitUpCount: 0,
      score: 50,
      state: "中性"
    });
    services.wholeMarketSnapshot = async () => ({
      stockCount: 1,
      upCount: 0,
      downCount: 0,
      flatCount: 1,
      breadth: 0.5,
      averageReturn: 0
    });
    services.currentLadderPools = async () => ({
      currentPool: [],
      previousPool: [],
      failedPool: [],
      failedPoolAvailable: true
    });
    services.getLimitUpSectorBoard = async () => [];
    services.discoverLimitUps = async () => ({
      rows: [],
      meta: { dataDate: "2026-08-10", fetchedAt: new Date().toISOString(), providers: [] }
    });
    resetProfessionalReviewCache();
    await getProfessionalReview({ refresh: true, settings: {} });
    assert.deepEqual(chartRefreshFlags, [true, true, true, true, true]);
  } finally {
    Object.assign(services, originals);
    resetProfessionalReviewCache();
  }
});
