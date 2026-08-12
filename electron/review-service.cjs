const services = require("./services.cjs");

let reviewCache = { value: null, expiresAt: 0 };

const INDEX_DEFINITIONS = [
  { code: "000985", secid: "1.000985", thscode: "000985.SH", name: "中证全指" },
  { code: "000001", secid: "1.000001", thscode: "000001.SH", name: "上证指数" },
  { code: "399001", secid: "0.399001", thscode: "399001.SZ", name: "深证成指" },
  { code: "399006", secid: "0.399006", thscode: "399006.SZ", name: "创业板指" },
  { code: "000300", secid: "1.000300", thscode: "000300.SH", name: "沪深300" }
];

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function average(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function percentReturn(rows, days) {
  if (!Array.isArray(rows) || rows.length < 2) return 0;
  const latest = Number(rows.at(-1)?.close || 0);
  const base = Number(rows[Math.max(0, rows.length - 1 - days)]?.close || 0);
  return base ? ((latest / base) - 1) * 100 : 0;
}

function movingAverage(rows, days, field = "close") {
  return average((rows || []).slice(-days).map((row) => Number(row?.[field] || 0)));
}

function indexReview(definition, chart) {
  const rows = chart?.rows || [];
  if (rows.length < 10) {
    return {
      ...definition,
      close: 0,
      date: "",
      returns: { r1: 0, r3: 0, r5: 0 },
      ma5: 0,
      ma10: 0,
      ma20: 0,
      volumeRatio: 0,
      score: 50,
      trend: "数据暂缺",
      available: false
    };
  }
  const latest = rows.at(-1) || {};
  const close = Number(latest.close || 0);
  const ma5 = movingAverage(rows, 5);
  const ma10 = movingAverage(rows, 10);
  const ma20 = movingAverage(rows, 20);
  const previousFiveAmount = average(rows.slice(-6, -1).map((row) => Number(row.amount || 0)));
  const volumeRatio = previousFiveAmount ? Number(latest.amount || 0) / previousFiveAmount : 0;
  const r1 = percentReturn(rows, 1);
  const r3 = percentReturn(rows, 3);
  const r5 = percentReturn(rows, 5);
  const aboveMa5 = close >= ma5;
  const aboveMa20 = close >= ma20;
  const bullishAlignment = ma5 >= ma10 && ma10 >= ma20;
  const score = Math.round(clamp(
    48 +
    r1 * 9 +
    r3 * 4 +
    r5 * 2 +
    (aboveMa5 ? 5 : -5) +
    (aboveMa20 ? 6 : -6) +
    (bullishAlignment ? 8 : -4)
  ));
  return {
    ...definition,
    close,
    date: latest.date || "",
    returns: { r1, r3, r5 },
    ma5,
    ma10,
    ma20,
    volumeRatio,
    score,
    trend:
      bullishAlignment && aboveMa5
        ? "多头"
        : aboveMa20
          ? "震荡偏强"
          : aboveMa5
            ? "弱修复"
            : "偏弱",
    available: true
  };
}

function marketSession(generatedAt) {
  const date = new Date(generatedAt);
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const minutes = chinaTime.getUTCHours() * 60 + chinaTime.getUTCMinutes();
  if (minutes < 9 * 60 + 15) return "盘前";
  if (minutes < 11 * 60 + 30) return "上午盘中";
  if (minutes < 13 * 60) return "午间";
  if (minutes < 15 * 60) return "下午盘中";
  return "收盘复盘";
}

function buildLimitEcology(emotion, ladderPools) {
  const current = ladderPools?.currentPool || [];
  const previous = ladderPools?.previousPool || [];
  const failed = ladderPools?.failedPool || [];
  const currentCodes = new Set(current.map((item) => String(item.code)));
  const previousCodes = new Set(previous.map((item) => String(item.code)));
  const promoted = [...previousCodes].filter((code) => currentCodes.has(code)).length;
  const promotionRate = previousCodes.size ? promoted / previousCodes.size : 0;
  const failedRate = current.length + failed.length
    ? failed.length / (current.length + failed.length)
    : 0;
  const firstBoards = current.filter((item) => Number(item.consecutiveBoards || 1) === 1).length;
  const continuationBoards = current.filter((item) => Number(item.consecutiveBoards || 1) > 1).length;
  const maxHeight = Math.max(0, ...current.map((item) => Number(item.consecutiveBoards || 1)));
  const heightDistribution = [...new Set(current.map((item) => Number(item.consecutiveBoards || 1)))]
    .sort((a, b) => b - a)
    .map((height) => ({
      height,
      count: current.filter((item) => Number(item.consecutiveBoards || 1) === height).length
    }));
  const score = Math.round(clamp(
    42 +
    (Number(emotion?.limitUpCount || current.length) - Number(emotion?.limitDownCount || 0)) * 0.16 +
    promotionRate * 25 -
    failedRate * 32 +
    Math.min(maxHeight, 7) * 3
  ));
  return {
    score,
    limitUpCount: Number(emotion?.limitUpCount || current.length),
    limitDownCount: Number(emotion?.limitDownCount || 0),
    previousLimitUpCount: Number(emotion?.previousLimitUpCount || previous.length),
    firstBoards,
    continuationBoards,
    maxHeight,
    promoted,
    promotionRate,
    failedBoards: failed.length,
    failedRate,
    heightDistribution
  };
}

function leadingStocks(ladderPools) {
  return [...(ladderPools?.currentPool || [])]
    .sort((a, b) =>
      Number(b.consecutiveBoards || 1) - Number(a.consecutiveBoards || 1) ||
      Number(a.openBoardCount || 0) - Number(b.openBoardCount || 0) ||
      Number(a.firstSealRaw || 999999) - Number(b.firstSealRaw || 999999)
    )
    .slice(0, 12)
    .map((item) => ({
      code: item.code,
      name: item.name,
      secid: item.secid,
      thscode: item.thscode,
      industry: item.industry,
      consecutiveBoards: Number(item.consecutiveBoards || 1),
      turnover: Number(item.turnover || 0),
      openBoardCount: Number(item.openBoardCount || 0),
      firstSealTime: item.firstSealTime || "",
      reason:
        Number(item.consecutiveBoards || 1) > 1
          ? `${Number(item.consecutiveBoards || 1)}连板高度`
          : Number(item.openBoardCount || 0) === 0
            ? "首板封板稳定"
            : "首板分歧回封"
    }));
}

function classifyRegime({ score, breadthScore, emotionScore, ecology, indices }) {
  const risingIndices = indices.filter((item) => item.returns.r1 > 0).length;
  if (score >= 75 && breadthScore >= 58 && ecology.promotionRate >= 0.28) {
    return { id: "trend", name: "趋势进攻", tone: "attack", posture: "主线前排，分歧低吸" };
  }
  if (emotionScore >= 62 && ecology.failedRate >= 0.3) {
    return { id: "divergence", name: "高位分歧", tone: "warning", posture: "降低追高，等待回流确认" };
  }
  if (score >= 58 && risingIndices >= 3) {
    return { id: "repair", name: "修复轮动", tone: "repair", posture: "控制节奏，只做强于市场" };
  }
  if (score < 43 || ecology.limitDownCount > ecology.limitUpCount * 0.45) {
    return { id: "retreat", name: "退潮防守", tone: "defense", posture: "现金优先，等待风险释放" };
  }
  return { id: "rotation", name: "混沌震荡", tone: "neutral", posture: "小仓试错，快进快出" };
}

function buildScenarios(snapshot) {
  const { ecology, market, dimensions } = snapshot;
  return [
    {
      id: "attack",
      name: "进攻确认",
      tone: "attack",
      conditions: [
        `上涨家数占比升至 ${Math.max(55, Math.round(market.breadth * 100))}% 以上`,
        `晋级率不低于 ${Math.max(30, Math.round(ecology.promotionRate * 100))}%`,
        "主线板块前三名强度不下降且量能温和放大"
      ],
      action: "只参与主线前排或缩量回踩核心，禁止追后排补涨。",
      invalidation: "炸板率超过35%或核心龙头跌破涨停日低点。"
    },
    {
      id: "rotation",
      name: "轮动基准",
      tone: "neutral",
      conditions: [
        `环境评分维持 ${Math.round(snapshot.score - 5)}–${Math.round(snapshot.score + 5)} 分`,
        "指数分化、上涨家数在45%–55%之间",
        "板块强度快速切换但跌停家数未扩散"
      ],
      action: "降低持仓时间，优先板块内相对强度前15%的股票。",
      invalidation: "市场广度与情绪评分同时跌破45分。"
    },
    {
      id: "defense",
      name: "防守触发",
      tone: "defense",
      conditions: [
        `情绪评分跌破 ${Math.min(45, dimensions.emotion)} 分`,
        "跌停/涨停比超过0.5",
        "三大指数多数跌破MA20并伴随放量"
      ],
      action: "停止新增交易，保留观察池并等待两日风险不再扩散。",
      invalidation: "上涨广度重回55%，涨停数量和晋级率同步回升。"
    }
  ];
}

function buildProfessionalReviewSnapshot(input) {
  const generatedAt = input.generatedAt || new Date().toISOString();
  const emotion = input.emotion || {};
  const market = input.market || {};
  const indices = (input.indices || []).map((item) =>
    item.score === undefined ? indexReview(item.definition, item.chart) : item
  );
  const ecology = buildLimitEcology(emotion, input.ladderPools || {});
  const sectorRows = (input.sectors || []).slice(0, 15);
  const availableIndices = indices.filter((item) => item.available !== false);
  const marketAvailable =
    Number(market.stockCount || 0) > 0 &&
    Number(market.upCount || 0) + Number(market.downCount || 0) > 0;
  const trendScore = Math.round(
    availableIndices.length ? average(availableIndices.map((item) => item.score)) : 50
  );
  const breadthScore = marketAvailable
    ? Math.round(clamp(50 + (Number(market.breadth || 0.5) - 0.5) * 100))
    : 50;
  const emotionScore = Math.round(clamp(Number(emotion.score || 50)));
  const leadershipScore = Math.round(clamp(
    sectorRows.length
      ? average(sectorRows.slice(0, 5).map((item) => Number(item.score || 45)))
      : 45
  ));
  const confirmationScore = Math.round(
    availableIndices.length
      ? (
          availableIndices.filter((item) => Number(item.close) >= Number(item.ma20)).length /
            availableIndices.length *
            65 +
          availableIndices.filter((item) => Number(item.returns?.r3) > 0).length /
            availableIndices.length *
            35
        )
      : 50
  );
  const liquidityScore = Math.round(
    availableIndices.length
      ? average(
          availableIndices.map((item) => {
            const ratio = Number(item.volumeRatio || 0);
            if (!ratio) return 50;
            return clamp(
              35 +
                Math.min(ratio, 1.5) * 38 -
                Math.max(0, ratio - 1.8) * 24
            );
          })
        )
      : 50
  );
  const strongSectorCount = sectorRows.filter((item) => Number(item.score || 0) >= 60).length;
  const topSectorShare = Number(sectorRows[0]?.poolShare || 0);
  const diffusionScore = Math.round(clamp(
    sectorRows.length
      ? 42 +
          Math.min(5, strongSectorCount) * 8 -
          Math.max(0, topSectorShare - 0.3) * 100
      : 50
  ));
  const score = Math.round(clamp(
    trendScore * 0.22 +
    breadthScore * 0.17 +
    emotionScore * 0.18 +
    ecology.score * 0.13 +
    leadershipScore * 0.1 +
    confirmationScore * 0.08 +
    liquidityScore * 0.06 +
    diffusionScore * 0.06
  ));
  const dimensions = {
    trend: trendScore,
    breadth: breadthScore,
    emotion: emotionScore,
    ecology: ecology.score,
    leadership: leadershipScore,
    confirmation: confirmationScore,
    liquidity: liquidityScore,
    diffusion: diffusionScore
  };
  const regime = classifyRegime({
    score,
    breadthScore,
    emotionScore,
    ecology,
    indices
  });
  const riskSignals = [];
  if (marketAvailable && Number(market.breadth || 0) < 0.45) {
    riskSignals.push("上涨广度不足45%，赚钱效应偏弱");
  }
  if (ecology.failedRate > 0.32) riskSignals.push("炸板率超过32%，高位接力容错率下降");
  if (ecology.limitDownCount > ecology.limitUpCount * 0.4) riskSignals.push("跌停/涨停比偏高，风险扩散");
  if (
    availableIndices.length >= 3 &&
    availableIndices.filter((item) => item.close < item.ma20).length >= Math.ceil(availableIndices.length / 2)
  ) {
    riskSignals.push("多数核心指数位于MA20下方");
  }
  if (sectorRows[0] && Number(sectorRows[0].poolShare || 0) > 0.32) riskSignals.push("涨停过度集中于单一板块，注意拥挤交易");
  if (confirmationScore < 42) riskSignals.push("核心指数趋势确认不足，反弹的一致性偏弱");
  if (liquidityScore < 42) riskSignals.push("核心指数成交参与度偏低，趋势持续性需要量能确认");
  if (!riskSignals.length) riskSignals.push("未触发系统级硬风险，但仍需服从个股止损");
  const exposure =
    score >= 75 ? { min: 60, max: 80, label: "积极但不满仓" } :
      score >= 60 ? { min: 40, max: 60, label: "均衡试错" } :
        score >= 45 ? { min: 20, max: 40, label: "轻仓轮动" } :
          { min: 0, max: 20, label: "防守观察" };
  const focusSectors = sectorRows.slice(0, 8).map((item, index) => ({
    ...item,
    reviewRank: index + 1,
    verdict:
      Number(item.score || 0) >= 75 && Number(item.relativeReturn || 0) >= 0
        ? "主线候选"
        : Number(item.score || 0) >= 60
          ? "轮动跟踪"
          : "等待确认"
  }));
  const snapshot = {
    generatedAt,
    date: emotion.date || indices[0]?.date || generatedAt.slice(0, 10),
    session: marketSession(generatedAt),
    score,
    regime,
    exposure,
    dimensions,
    market: {
      available: marketAvailable,
      stockCount: Number(market.stockCount || 0),
      upCount: Number(market.upCount || 0),
      downCount: Number(market.downCount || 0),
      flatCount: Number(market.flatCount || 0),
      breadth: Number(market.breadth || 0),
      averageReturn: Number(market.averageReturn || 0)
    },
    emotion: {
      ...emotion,
      score: emotionScore
    },
    ecology,
    indices,
    focusSectors,
    leaders: leadingStocks(input.ladderPools || {}),
    riskSignals,
    evidence: [
      marketAvailable
        ? `全市场上涨 ${Number(market.upCount || 0)} 家、下跌 ${Number(market.downCount || 0)} 家，上涨广度 ${(Number(market.breadth || 0) * 100).toFixed(1)}%。`
        : "全市场涨跌家数接口暂时降级，本次广度维度按中性50分处理，不用缺失数据推断强弱。",
      `涨停 ${ecology.limitUpCount} 家、跌停 ${ecology.limitDownCount} 家、炸板 ${ecology.failedBoards} 家，晋级率 ${(ecology.promotionRate * 100).toFixed(1)}%。`,
      `最高 ${ecology.maxHeight} 连板，首板 ${ecology.firstBoards} 家、连板 ${ecology.continuationBoards} 家。`,
      `${availableIndices.length} 个可用核心指数中 ${availableIndices.filter((item) => item.returns.r1 > 0).length} 个收涨，${availableIndices.filter((item) => item.close >= item.ma20).length} 个位于MA20上方。`,
      `趋势确认 ${confirmationScore} 分、成交参与 ${liquidityScore} 分、主线扩散 ${diffusionScore} 分；三项作为市场一致性校验。`
    ],
    nextPlan: {
      focus: focusSectors.slice(0, 3).map((item) => `${item.name}：${item.verdict}，强度 ${Math.round(item.score || 0)} 分`),
      observe: focusSectors.slice(3, 6).map((item) => `${item.name}：等待量价与涨停梯队继续确认`),
      avoid: [
        ecology.failedRate > 0.3 ? "高位反复炸板且回封弱的后排股" : "无板块扩散、仅个股脉冲的孤立涨停",
        "放量跌破涨停日最低价或锚定均价的观察股",
        "重大利空未完成定价、流动性不足或ST/退市风险股票"
      ]
    },
    sources: [
      "东方财富公开指数与全市场行情",
      "涨停/跌停/炸板专题池",
      "A股雷达板块强度与涨停梯队模型"
    ],
    methodology: {
      name: "八维市场状态模型",
      description: "趋势22% + 广度17% + 情绪18% + 涨停生态13% + 主线10% + 趋势确认8% + 成交参与6% + 主线扩散6%",
      note: "结论用于复盘与条件预案，不预测单一方向，也不构成投资建议。"
    }
  };
  snapshot.scenarios = buildScenarios(snapshot);
  return snapshot;
}

async function getProfessionalReview(options = {}) {
  if (!options.refresh && reviewCache.value && reviewCache.expiresAt > Date.now()) {
    return reviewCache.value;
  }
  const indexPromises = INDEX_DEFINITIONS.map(async (definition) => {
    const chart = await services.getChart(definition, "101", {
      range: "3m",
      limit: 90,
      adjustment: 1,
      forceRefresh: options.refresh === true
    }).catch(() => ({ rows: [] }));
    return { definition, chart };
  });
  const marketOptions = {
    ...(options.settings || {}),
    forceRefresh: options.refresh === true
  };
  const [emotion, market, ladderPools, sectors, limitUpSnapshot, indices] = await Promise.all([
    services.marketEmotionSnapshot(marketOptions).catch(() => null),
    services.wholeMarketSnapshot(marketOptions).catch(() => null),
    services.currentLadderPools(marketOptions).catch(() => ({
      currentPool: [],
      previousPool: [],
      failedPool: null,
      failedPoolAvailable: false
    })),
    services.getLimitUpSectorBoard(marketOptions).catch(() => []),
    services.discoverLimitUps(marketOptions).catch(() => ({ rows: [], meta: null })),
    Promise.all(indexPromises)
  ]);
  const limitUps = Array.isArray(limitUpSnapshot?.rows) ? limitUpSnapshot.rows : [];
  const fallbackDate = new Date().toISOString().slice(0, 10);
  const safeEmotion = emotion || {
    date: fallbackDate,
    limitUpCount: limitUps.length,
    limitDownCount: 0,
    previousLimitUpCount: 0,
    score: limitUps.length >= 70 ? 68 : limitUps.length >= 35 ? 55 : 45,
    state: "数据降级"
  };
  const safeMarket = market || sectors[0]?.marketSnapshot || {
    stockCount: 0,
    upCount: 0,
    downCount: 0,
    flatCount: 0,
    breadth: 0.5,
    averageReturn: 0,
    fetchedAt: new Date().toISOString()
  };
  const value = buildProfessionalReviewSnapshot({
    generatedAt: new Date().toISOString(),
    emotion: safeEmotion,
    market: safeMarket,
    ladderPools,
    sectors,
    limitUps,
    indices
  });
  reviewCache = { value, expiresAt: Date.now() + 45 * 1000 };
  return value;
}

function resetProfessionalReviewCache() {
  reviewCache = { value: null, expiresAt: 0 };
}

module.exports = {
  INDEX_DEFINITIONS,
  buildProfessionalReviewSnapshot,
  getProfessionalReview,
  marketSession,
  resetProfessionalReviewCache
};
