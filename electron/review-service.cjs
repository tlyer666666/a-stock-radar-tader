const { shanghaiDateTime, tradingDateStatus } = require("./market-time-rules.cjs");
const services = require("./services.cjs");
const { buildMarketReviewDecision, marketScenarios, validBreadth } = require("./review-decision.cjs");

const { BoundedCache, credentialFingerprint } = require("./bounded-cache.cjs");
const { busyError } = require("./worker-runner.cjs");
const reviewCache = new BoundedCache({ maxEntries: 8 });
const reviewInFlight = new Map();
const activeReviews = new Set();
let reviewGeneration = 0;

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

function indexReview(definition, chart, generatedAt = new Date().toISOString()) {
  const rows = chart?.rows || [];
  const historyValid = rows.every((row, i) => /^\d{4}-\d{2}-\d{2}$/.test(row?.date || "") &&
    Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) && new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) === row.date &&
    (!i || row.date > rows[i - 1].date) && [row.open, row.high, row.low, row.close].every(n => Number.isFinite(Number(n)) && Number(n) > 0) &&
    Number(row.high) >= Math.max(Number(row.open), Number(row.close), Number(row.low)) && Number(row.low) <= Math.min(Number(row.open), Number(row.close), Number(row.high)));
  if (rows.length < 10) {
    return {
      ...definition,
      close: 0,
      date: "",
      returns: { r1: 0, r3: 0, r5: 0 },
      ma5: 0,
      ma10: 0,
      ma20: 0,
      ma60: null,
      historyBars: rows.length,
      historyValid,
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
  const sameDay = latest.date === shanghaiDateTime(generatedAt).slice(0, 10);
  const unfinished = sameDay && shanghaiDateTime(generatedAt).slice(11, 16) < "15:00";
  const amountsAvailable = rows.slice(-6).length === 6 && rows.slice(-6).every(row => row.amount !== null && row.amount !== undefined && Number.isFinite(Number(row.amount)) && Number(row.amount) > 0);
  const volumeRatio = !unfinished && amountsAvailable && previousFiveAmount ? Number(latest.amount) / previousFiveAmount : null;
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
    ma60: rows.length >= 60 && historyValid ? movingAverage(rows, 60) : null,
    historyBars: rows.length,
    historyValid,
    volumeRatio,
    volumeRatioBasis: unfinished ? "awaiting-close" : amountsAvailable ? "full-day" : "missing",
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
  if (tradingDateStatus(shanghaiDateTime(generatedAt).slice(0, 10)) === false) return "休市";
  const minutes = chinaTime.getUTCHours() * 60 + chinaTime.getUTCMinutes();
  if (minutes < 9 * 60 + 15) return "盘前";
  if (minutes < 11 * 60 + 30) return "上午盘中";
  if (minutes < 13 * 60) return "午间";
  if (minutes < 15 * 60) return "下午盘中";
  return "收盘复盘";
}

function buildLimitEcology(emotion, ladderPools) {
  const nonRisk = rows => (rows || []).filter(item => !services.isRiskStockName(item.name || ""));
  const current = nonRisk(ladderPools?.currentPool);
  const previous = nonRisk(ladderPools?.previousPool);
  const failedAvailable = ladderPools?.failedPoolAvailable !== false && Array.isArray(ladderPools?.failedPool);
  const failed = failedAvailable ? nonRisk(ladderPools.failedPool) : [];
  const currentCodes = new Set(current.map(item => String(item.code)));
  const previousCodes = new Set(previous.map(item => String(item.code)));
  const previousAvailable = previousCodes.size > 0 || Boolean(ladderPools?.previousDate && ladderPools.previousDate !== ladderPools.currentDate);
  const promoted = previousAvailable ? [...previousCodes].filter(code => currentCodes.has(code)).length : null;
  const promotionRate = previousAvailable && previousCodes.size ? promoted / previousCodes.size : previousAvailable ? 0 : null;
  const failedRate = failedAvailable ? (current.length + failed.length ? failed.length / (current.length + failed.length) : 0) : null;
  const knownHeight = item => item.consecutiveBoards !== null && item.consecutiveBoards !== undefined && Number.isFinite(Number(item.consecutiveBoards)) && Number(item.consecutiveBoards) >= 1;
  const known = current.filter(knownHeight);
  const firstBoards = known.filter(item => Number(item.consecutiveBoards) === 1).length;
  const continuationBoards = known.filter(item => Number(item.consecutiveBoards) > 1).length;
  const maxHeight = known.length ? Math.max(...known.map(item => Number(item.consecutiveBoards))) : current.length ? null : 0;
  const heightDistribution = [...new Set(known.map(item => Number(item.consecutiveBoards)))].sort((a,b) => b-a).map(height => ({height,count:known.filter(item => Number(item.consecutiveBoards) === height).length}));
  const limitUpCount = Array.isArray(ladderPools?.currentPool) ? current.length : Number(emotion?.limitUpCount || 0);
  const limitDownCount = Number(emotion?.limitDownCount || 0);
  const complete = failedAvailable && previousAvailable && known.length === current.length;
  const score = complete ? Math.round(clamp(42 + (limitUpCount - limitDownCount) * 0.16 + promotionRate * 25 - failedRate * 32 + Math.min(maxHeight,7)*3)) : 50;
  return {score,available:complete,limitUpCount,limitDownCount,previousLimitUpCount:previous.length,firstBoards,continuationBoards,maxHeight,promoted,promotionRate,failedBoards:failedAvailable ? failed.length : null,failedRate,heightDistribution,unknownHeightCount:current.length-known.length};
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
      consecutiveBoards: item.consecutiveBoards == null ? null : Number(item.consecutiveBoards),
      turnover: Number(item.turnover || 0),
      openBoardCount: Number(item.openBoardCount || 0),
      firstSealTime: item.firstSealTime || "",
      reason:
        item.consecutiveBoards == null ? "连板高度待确认" : Number(item.consecutiveBoards) > 1
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

function buildProfessionalReviewSnapshot(input) {
  const generatedAt = input.generatedAt || new Date().toISOString();
  const emotion = input.emotion || {};
  const market = input.market || {};
  const indices = (input.indices || []).map((item) =>
    item.score === undefined ? indexReview(item.definition, item.chart, generatedAt) : item
  );
  const ecology = buildLimitEcology(emotion, input.ladderPools || {});
  const sectorRows = (input.sectors || []).slice(0, 15);
  const availableIndices = indices.filter((item) => item.available !== false);
  const marketAvailable = input.sourceAvailability?.market !== false && validBreadth(market);
  const measuredBreadth = marketAvailable ? Number(market.upCount) / Number(market.stockCount) : null;
  const trendScore = Math.round(
    availableIndices.length ? average(availableIndices.map((item) => item.score)) : 50
  );
  const breadthScore = marketAvailable
    ? Math.round(clamp(measuredBreadth * 100))
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
  if (ecology.failedRate === null) riskSignals.push("炸板池不可用，炸板数量与炸板率待确认");
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
  const exposure = { min: null, max: null, label: "不从评分推导仓位" };
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
      breadth: measuredBreadth,
      // A2-03 最后一米：指数行情未知时上游给的是 null，这里不能再折回 0%，
      // 否则复盘页会把"取不到指数"显示成"平均涨幅 0.00%"，与 breadth 的 null 口径矛盾。
      averageReturn: market.averageReturn === null || market.averageReturn === undefined || market.averageReturn === ""
        ? null
        : Number(market.averageReturn)
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
      `涨停 ${ecology.limitUpCount} 家、跌停 ${ecology.limitDownCount} 家、炸板 ${ecology.failedBoards ?? "待确认"} 家，晋级率 ${ecology.promotionRate === null ? "待确认" : `${(ecology.promotionRate * 100).toFixed(1)}%`}。`,
      `最高 ${ecology.maxHeight ?? "待确认"} 连板，首板 ${ecology.firstBoards} 家、连板 ${ecology.continuationBoards} 家。`,
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
  snapshot.scenarios = marketScenarios();
  snapshot.decision = buildMarketReviewDecision(input, snapshot);
  return snapshot;
}

/**
 * 把同花顺扶摇数据并入复盘本身（不是另起一块）：涨停生态补封板率与最高板、梯队补涨停原因、
 * 证据链/风险/次日清单补题材、龙虎榜和热度，有序证据加实测与背景。纯函数，便于单测。
 */
function integrateFuyaoReview(snapshot, fuyao) {
  if (!snapshot || !fuyao) return snapshot;
  snapshot.fuyao = fuyao;
  if (!fuyao.available) return snapshot;
  const limitUp = fuyao.limitUp || null;
  const themes = (limitUp?.reasons || []).slice(0, 6);
  const sealRate = Number.isFinite(fuyao.sealRate) ? fuyao.sealRate : null;
  const pctText = value => `${(value * 100).toFixed(1)}%`;
  const names = rows => rows.map(row => row.name).filter(Boolean).slice(0, 3).join("、");

  const ecology = snapshot.ecology || (snapshot.ecology = {});
  ecology.sealRate = sealRate;
  if (limitUp && Number.isFinite(limitUp.maxBoards)) ecology.thsMaxBoards = limitUp.maxBoards;
  if ((ecology.failedBoards === null || ecology.failedBoards === undefined) && Number.isFinite(fuyao.limitBreak?.count)) {
    ecology.failedBoards = fuyao.limitBreak.count;
    ecology.failedBoardsSource = "同花顺扶摇炸板池";
    snapshot.riskSignals = (snapshot.riskSignals || []).filter(item => !/炸板池不可用/.test(item));
  }
  ecology.themes = themes;

  const byCode = limitUp?.byCode || {};
  snapshot.leaders = (snapshot.leaders || []).map(item => {
    const ths = byCode[String(item.code)];
    return ths ? { ...item, thsReason: ths.reason || "", boardsText: ths.boardsText || "", sealMoney: ths.sealMoney ?? null } : item;
  });
  if (!snapshot.leaders.length && limitUp?.leaders?.length) {
    snapshot.leaders = limitUp.leaders.map(row => ({ code: row.code, name: row.name, thscode: row.thscode, industry: "", consecutiveBoards: row.boards,
      reason: row.boardsText || `${row.boards}连板`, thsReason: row.reason, boardsText: row.boardsText, sealMoney: row.sealMoney ?? null }));
  }

  const evidence = snapshot.evidence || (snapshot.evidence = []);
  if (limitUp) evidence.push(`同花顺：涨停 ${limitUp.count} 家（剔除ST）、炸板 ${fuyao.limitBreak?.count ?? "待确认"} 家、跌停 ${fuyao.limitDown?.count ?? "待确认"} 家，封板率 ${sealRate === null ? "待确认" : pctText(sealRate)}，最高 ${limitUp.maxBoards || "--"} 板。`);
  if (themes.length) evidence.push(`同花顺涨停原因最集中：${themes.slice(0, 4).map(t => `${t.reason} ${t.count} 只`).join("、")}。`);
  const lhb = fuyao.dragonTiger;
  if (lhb?.topNet?.length) evidence.push(`龙虎榜（${lhb.date || "最近交易日"}）净买入居前：${lhb.topNet.slice(0, 3).map(row => row.name).join("、")}${lhb.topNet.some(row => Number(row.orgNet) > 0) ? `；机构净买入：${names(lhb.topNet.filter(row => Number(row.orgNet) > 0))}` : ""}。`);
  if (fuyao.hot?.length) evidence.push(`同花顺热股榜前五：${fuyao.hot.slice(0, 5).map(row => row.name).join("、")}（关注度参考，不代表强弱）。`);

  const risks = snapshot.riskSignals || (snapshot.riskSignals = []);
  if (sealRate !== null && sealRate < 0.6) risks.unshift(`同花顺封板率 ${pctText(sealRate)}，低于60%，打板与接力容错率低`);
  if (themes[0] && limitUp?.count && themes[0].count / limitUp.count > 0.35) risks.push(`涨停过度集中于「${themes[0].reason}」（${themes[0].count}/${limitUp.count}），注意题材拥挤`);
  snapshot.riskSignals = risks.filter((item, index) => risks.indexOf(item) === index && !(risks.length > 1 && /未触发系统级硬风险/.test(item)));

  const plan = snapshot.nextPlan || (snapshot.nextPlan = { focus: [], observe: [], avoid: [] });
  if (themes.length) plan.focus = [...themes.slice(0, 2).map(t => `题材「${t.reason}」：同花顺涨停 ${t.count} 只，代表 ${names(t.stocks) || "--"}`), ...(plan.focus || [])].slice(0, 5);
  if (limitUp?.leaders?.length) plan.observe = [`连板梯队：${limitUp.leaders.slice(0, 4).map(row => `${row.name}${row.boardsText ? `（${row.boardsText}）` : ""}`).join("、")}，看次日晋级与分歧承接`, ...(plan.observe || [])].slice(0, 5);

  snapshot.sources = [
    "同花顺指数与全市场涨跌分布",
    "同花顺涨停/炸板/跌停池（扶摇官方接口 + 免费网页接口）",
    "同花顺扶摇：连板天梯、热股榜、龙虎榜、异动解读",
    "A股雷达板块强度与涨停梯队模型"
  ];

  const decision = snapshot.decision;
  if (decision) {
    decision.sourceNature = "同花顺行情、涨停池与扶摇特色数据快照；不是收益验证";
    decision.metrics = [...(decision.metrics || []),
      { id: "sealRate", label: "封板率（同花顺）", value: sealRate === null ? null : sealRate * 100, unit: "%", detail: "涨停 ÷（涨停 + 炸板），剔除ST；同花顺扶摇涨停池与炸板池同时点" },
      { id: "maxBoards", label: "最高连板（同花顺）", value: Number.isFinite(limitUp?.maxBoards) ? limitUp.maxBoards : null, unit: "板", detail: "同花顺涨停池的连板天数；高度不代表次日晋级" }];
    if (themes.length) decision.context = [{ id: "ths-themes", label: "同花顺涨停题材", state: `${themes.length} 个题材`,
      facts: themes.map(t => `${t.reason}：${t.count} 只（${names(t.stocks) || "--"}）`) }, ...(decision.context || [])];
    if (lhb?.topNet?.length || fuyao.hot?.length) decision.context = [...(decision.context || []), { id: "ths-money", label: "龙虎榜与热度", state: lhb?.date || "最近交易日",
      facts: [...(lhb?.topNet?.length ? [`龙虎榜净买入居前：${lhb.topNet.slice(0, 5).map(row => row.name).join("、")}。`] : []),
        ...(lhb?.desks?.length ? [`活跃营业部：${lhb.desks.slice(0, 3).map(desk => desk.name).join("、")}。`] : []),
        ...(fuyao.hot?.length ? [`热股榜前五：${fuyao.hot.slice(0, 5).map(row => row.name).join("、")}；热度只表示关注度。`] : [])] }];
    const add = item => { decision.evidence = [...(decision.evidence || []), item].sort((a, b) => a.priority - b.priority); };
    if (sealRate !== null && sealRate < 0.6) add({ id: "ths-seal-rate", title: "封板质量偏弱", tone: "risk", priority: 2, detail: `同花顺封板率 ${pctText(sealRate)}，炸板 ${fuyao.limitBreak?.count ?? "--"} 家。`, basis: "同花顺扶摇涨停池与炸板池；与涨跌家数是不同口径，不重复计票" });
    if (themes.length) add({ id: "ths-themes", title: "涨停题材集中度", tone: "neutral", priority: 4, detail: `${themes.slice(0, 3).map(t => `${t.reason} ${t.count} 只`).join("、")}。`, basis: "同花顺涨停原因按「+」拆分计数；一只股票可属多个题材" });
    const market = (decision.steps || []).find(step => step.id === "market");
    if (market && themes.length) market.facts = [...market.facts, `同花顺涨停题材：${themes.slice(0, 3).map(t => `${t.reason} ${t.count} 只`).join("、")}。`];
    if (sealRate !== null && market) market.facts = [...market.facts, `封板率 ${pctText(sealRate)}、最高 ${limitUp?.maxBoards || "--"} 板（同花顺）。`];
  }
  return snapshot;
}

function reviewSettingsKey(settings) {
  return credentialFingerprint(JSON.stringify(settings, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value));
}

async function getProfessionalReview(input = {}) {
  const options = input && typeof input === "object" ? input : {};
  const settings = options.settings && typeof options.settings === "object" ? { ...options.settings } : {};
  const key = reviewSettingsKey(settings);
  const active = reviewInFlight.get(key);
  if (active && (!options.refresh || active.refresh)) return active.promise;
  const cached = reviewCache.get(key);
  if (!options.refresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (activeReviews.size >= 4) throw busyError("复盘任务繁忙，请稍后重试");
  const entry = { generation: reviewGeneration, refresh: options.refresh === true };
  activeReviews.add(entry);
  // Keep the aggregate identity separate from its result cache: a reset or a
  // newer forced generation must never be overwritten by late dependencies.
  entry.promise = loadProfessionalReview({ ...options, settings }).then(value => {
    if (reviewInFlight.get(key) === entry && entry.generation === reviewGeneration) {
      reviewCache.set(key, { value, expiresAt: Date.now() + 45 * 1000 });
    }
    return value;
  }).finally(() => {
    activeReviews.delete(entry);
    if (reviewInFlight.get(key) === entry) reviewInFlight.delete(key);
  });
  reviewInFlight.set(key, entry);
  return entry.promise;
}

async function loadProfessionalReview(options) {
  const indexPromises = INDEX_DEFINITIONS.map(async (definition) => {
    const chart = await services.getReviewIndexChart(definition.secid, {
      range: "3m",
      limit: 90,
      forceRefresh: options.refresh === true
    }).catch(() => ({ rows: [] }));
    return { definition, chart };
  });
  const marketOptions = {
    ...(options.settings || {}),
    forceRefresh: options.refresh === true
  };
  // 同花顺扶摇复盘数据（连板天梯、涨停原因、热股榜、龙虎榜、异动解读）：独立加载，失败不影响复盘主体。
  const fuyaoPromise = typeof services.getFuyaoReviewData === "function"
    ? services.getFuyaoReviewData({ forceRefresh: options.refresh === true })
      .catch((error) => ({ available: false, reason: `同花顺扶摇复盘数据暂不可用：${String(error?.message || error).slice(0, 120)}` }))
    : Promise.resolve(null);
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
  const fallbackDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); // 北京时间日期
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
    indices,
    sourceAvailability: { emotion: Boolean(emotion), market: Boolean(market || sectors[0]?.marketSnapshot) }
  });
  return integrateFuyaoReview(value, await fuyaoPromise);
}

function resetProfessionalReviewCache() {
  reviewGeneration += 1;
  reviewCache.clear();
  reviewInFlight.clear();
}

module.exports = {
  buildProfessionalReviewSnapshot,
  integrateFuyaoReview,
  getProfessionalReview,
  marketSession,
  resetProfessionalReviewCache
};
