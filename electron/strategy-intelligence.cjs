function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return 0;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function roundPrice(value) {
  return Math.round(value * 100 + 1e-7) / 100;
}

function priceLimitRate(code, name = "") {
  if (/ST|\*ST/i.test(name)) return 0.05;
  if (/^(300|301|688|689)/.test(code)) return 0.2;
  if (/^(8|4|9)/.test(code)) return 0.3;
  return 0.1;
}

function formatPoolTime(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "";
  const text = String(Math.trunc(Number(value))).padStart(6, "0");
  return `${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4, 6)}`;
}

function poolTimeMinutes(value) {
  const text = String(Math.trunc(Number(value) || 0)).padStart(6, "0");
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(2, 4));
}

function decorateLimitPoolItem(raw, date = "") {
  const code = String(raw?.c || raw?.code || "");
  const market = Number(raw?.m ?? (/^(6|68)/.test(code) ? 1 : 0));
  const floatMarketCap = Number(raw?.ltsz || raw?.floatMarketCap || 0);
  const sealedAmount = Number(raw?.fund || raw?.sealedAmount || 0);
  const amount = Number(raw?.amount || 0);
  return {
    code,
    name: String(raw?.n || raw?.name || code),
    secid: `${market}.${code}`,
    thscode: `${code}.${market === 1 ? "SH" : /^(8|4|9)/.test(code) ? "BJ" : "SZ"}`,
    latest: Number(raw?.p || 0) / (raw?.p ? 1000 : 1),
    changePct: Number(raw?.zdp || raw?.changePct || 0),
    turnover: Number(raw?.hs || raw?.turnover || 0),
    amount,
    floatMarketCap,
    totalMarketCap: Number(raw?.tshare || raw?.totalMarketCap || 0),
    industry: raw?.hybk || raw?.industry || "未分类",
    limitDate: date,
    consecutiveBoards: Number(raw?.lbc || raw?.consecutiveBoards || 1),
    firstSealTime: formatPoolTime(raw?.fbt ?? raw?.firstSealRaw),
    lastSealTime: formatPoolTime(raw?.lbt ?? raw?.lastSealRaw),
    firstSealRaw: Number(raw?.fbt ?? raw?.firstSealRaw ?? 0),
    lastSealRaw: Number(raw?.lbt ?? raw?.lastSealRaw ?? 0),
    openBoardCount: Number(raw?.zbc ?? raw?.openBoardCount ?? 0),
    sealedAmount,
    sealFloatRatio: floatMarketCap ? sealedAmount / floatMarketCap : 0,
    tradedFloatRatio: floatMarketCap ? amount / floatMarketCap : 0,
    limitStats: {
      windowDays: Number(raw?.zttj?.days || raw?.limitStats?.windowDays || 0),
      count: Number(raw?.zttj?.ct || raw?.limitStats?.count || 0)
    },
    raw
  };
}

function scoreFirstBoardQuality(record, analysis = {}) {
  if (!record) {
    return {
      available: false,
      dataComplete: false,
      partial: true,
      eligible: false,
      matched: false,
      score: 0,
      grade: "--",
      summary: "涨停专题字段暂不可用",
      factors: [],
      reasons: [],
      risks: ["缺少首次封板、炸板和封单数据"]
    };
  }

  const factors = [];
  const risks = [];
  const reasons = [];
  const hasNumber = (value) =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const consecutiveAvailable = hasNumber(record.consecutiveBoards);
  const firstSealAvailable = hasNumber(record.firstSealRaw) && Number(record.firstSealRaw) > 0;
  const openCountAvailable = hasNumber(record.openBoardCount);
  const turnoverAvailable = hasNumber(record.turnover);
  const sealRatioAvailable = hasNumber(record.sealFloatRatio);
  const tradedRatioAvailable = hasNumber(record.tradedFloatRatio);
  const locationAvailable = hasNumber(analysis.preLimitReturn20);
  const supportAvailable = typeof analysis.heldSupport === "boolean";
  const dataComplete = consecutiveAvailable && firstSealAvailable && openCountAvailable &&
    turnoverAvailable && sealRatioAvailable && tradedRatioAvailable;
  const eligible = consecutiveAvailable && Number(record.consecutiveBoards) === 1;
  const firstMinutes = firstSealAvailable ? poolTimeMinutes(record.firstSealRaw) : 0;
  const openCount = openCountAvailable ? Number(record.openBoardCount) : null;
  const turnover = turnoverAvailable ? Number(record.turnover) : null;
  const sealRatio = sealRatioAvailable ? Number(record.sealFloatRatio) : null;
  const tradedFloatRatio = tradedRatioAvailable ? Number(record.tradedFloatRatio) : null;
  const preLimitReturn = locationAvailable ? Number(analysis.preLimitReturn20) : null;

  const add = (id, label, value, points, maxPoints, passed, threshold) => {
    factors.push({ id, label, value, points, maxPoints, passed, threshold });
    if (passed && points >= maxPoints * 0.7) reasons.push(`${label}${value}`);
    return points;
  };

  let score = 0;
  const sealTimePoints =
    !firstSealAvailable ? 0 :
      firstMinutes <= 570 ? 20 :
      firstMinutes <= 600 ? 18 :
        firstMinutes <= 660 ? 14 :
          firstMinutes <= 810 ? 8 : 4;
  score += add(
    "firstSealTime",
    "首次封板",
    firstSealAvailable ? record.firstSealTime || "--" : "--",
    sealTimePoints,
    20,
    sealTimePoints >= 14,
    "11:00前更优"
  );

  const openPoints = !openCountAvailable ? 0 : openCount === 0 ? 18 : openCount === 1 ? 13 : openCount === 2 ? 8 : openCount === 3 ? 4 : 0;
  score += add("openBoardCount", "开板次数", openCountAvailable ? `${openCount}次` : "--", openPoints, 18, openCountAvailable && openCount <= 1, "≤1次");

  const turnoverPoints =
    !turnoverAvailable ? 0 :
      turnover >= 0.5 && turnover <= 15 ? 15 :
      turnover <= 25 ? 10 :
        turnover <= 35 ? 5 : 1;
  score += add("turnover", "涨停换手", turnoverAvailable ? `${turnover.toFixed(1)}%` : "--", turnoverPoints, 15, turnoverAvailable && turnover >= 0.5 && turnover <= 25, "0.5%–25%");

  const sealPoints =
    !sealRatioAvailable ? 0 :
      sealRatio >= 0.03 ? 18 :
      sealRatio >= 0.015 ? 14 :
        sealRatio >= 0.0075 ? 10 :
          sealRatio >= 0.003 ? 6 : 2;
  score += add("sealRatio", "封单/流通市值", sealRatioAvailable ? `${(sealRatio * 100).toFixed(2)}%` : "--", sealPoints, 18, sealRatioAvailable && sealRatio >= 0.0075, "≥0.75%");

  const liquidityPoints =
    !tradedRatioAvailable ? 0 :
      tradedFloatRatio >= 0.01 && tradedFloatRatio <= 0.18 ? 12 :
      tradedFloatRatio <= 0.3 ? 7 : 3;
  score += add("liquidity", "成交额/流通市值", tradedRatioAvailable ? `${(tradedFloatRatio * 100).toFixed(1)}%` : "--", liquidityPoints, 12, tradedRatioAvailable && tradedFloatRatio >= 0.01 && tradedFloatRatio <= 0.18, "1%–18%");

  const locationPoints = !locationAvailable ? 0 : preLimitReturn <= 8 ? 10 : preLimitReturn <= 15 ? 7 : preLimitReturn <= 25 ? 3 : 0;
  score += add("location", "板前20日涨幅", locationAvailable ? `${preLimitReturn.toFixed(1)}%` : "--", locationPoints, 10, locationAvailable && preLimitReturn <= 15, "≤15%");

  const supportPoints = supportAvailable && analysis.heldSupport ? 7 : 0;
  score += add("support", "涨停低点防守", supportAvailable ? analysis.heldSupport ? "有效" : "失效" : "--", supportPoints, 7, supportAvailable && Boolean(analysis.heldSupport), "不得跌破");

  if (!consecutiveAvailable) risks.push("连板高度缺失");
  else if (!eligible) risks.push(`当前为${record.consecutiveBoards}连板，不属于首板`);
  if (!firstSealAvailable) risks.push("首次封板时间缺失");
  if (!openCountAvailable) risks.push("开板次数缺失");
  if (!sealRatioAvailable || !tradedRatioAvailable) risks.push("封单或流通市值字段缺失");
  if (openCountAvailable && openCount >= 4) risks.push("开板次数过多");
  if (turnoverAvailable && turnover > 40) risks.push("涨停日换手过热");
  if (sealRatioAvailable && sealRatio > 0 && sealRatio < 0.001) risks.push("封单占流通市值过低");
  if (!supportAvailable) risks.push("涨停低点防守数据缺失");
  else if (!analysis.heldSupport) risks.push("观察期已跌破涨停日最低价");

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (!eligible) score = Math.min(score, 55);
  const matched = dataComplete && supportAvailable && eligible && score >= 70 && !risks.some((item) => /过多|过热|跌破|缺失/.test(item));
  const grade = !dataComplete ? "--" : score >= 85 ? "S" : score >= 75 ? "A" : score >= 60 ? "B" : "C";
  return {
    available: true,
    dataComplete,
    partial: !dataComplete,
    eligible,
    matched,
    score,
    grade,
    summary: !dataComplete
      ? "首板质量字段不完整 · 暂不判定"
      : eligible
        ? `首板质量 ${score}分 · ${grade}级`
        : `${record.consecutiveBoards}连板 · 不适用首板策略`,
    factors,
    reasons,
    risks,
    firstSealTime: record.firstSealTime,
    lastSealTime: record.lastSealTime,
    openBoardCount: openCount,
    turnover,
    sealFloatRatio: sealRatio,
    sealedAmount: record.sealedAmount
  };
}

function movingAverage(history, days, endIndex) {
  return average(
    history
      .slice(Math.max(0, endIndex - days + 1), endIndex + 1)
      .map((item) => Number(item.close))
  );
}

function detectLimitEvents(history, code, name) {
  const events = [];
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const day = history[index];
    const target = roundPrice(Number(previous.close) * (1 + priceLimitRate(code, name)));
    if (Number(day.close) >= target - 0.011 && Number(day.high) >= target - 0.011) {
      events.push({ ...day, index, target });
    }
  }
  return events;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function trueRange(history, index) {
  const item = history[index];
  const previousClose = Number(history[index - 1]?.close ?? item?.open ?? 0);
  return Math.max(
    Number(item?.high || 0) - Number(item?.low || 0),
    Math.abs(Number(item?.high || 0) - previousClose),
    Math.abs(Number(item?.low || 0) - previousClose)
  );
}

function computePatternStrategies(history, eventIndex, evaluationIndex) {
  const event = history[eventIndex];
  const latest = history[evaluationIndex];
  if (!event || !latest || evaluationIndex <= eventIndex) {
    return {
      originBreakout: false,
      vcpCompression: false,
      chipLock: false
    };
  }
  const node = evaluationIndex - eventIndex;
  const pre20 = history.slice(Math.max(0, eventIndex - 20), eventIndex);
  const pre5 = history.slice(Math.max(0, eventIndex - 5), eventIndex);
  const boxHigh = pre20.length ? Math.max(...pre20.map((item) => Number(item.high))) : 0;
  const boxLow = pre20.length ? Math.min(...pre20.map((item) => Number(item.low))) : 0;
  const boxWidth = boxLow ? ((boxHigh / boxLow) - 1) * 100 : 0;
  const breakoutPct = boxHigh ? ((Number(event.close) / boxHigh) - 1) * 100 : 0;
  const preVolumeAverage = average(pre5.map((item) => Number(item.volume || 0)));
  const limitVolumeRatio = preVolumeAverage
    ? Number(event.volume || 0) / preVolumeAverage
    : 0;
  const eventRange = Number(event.high) - Number(event.low);
  const eventBodyRatio = eventRange
    ? (Number(event.close) - Number(event.open)) / eventRange
    : 1;
  const recentCloses = history
    .slice(Math.max(eventIndex + 1, evaluationIndex - 1), evaluationIndex + 1)
    .map((item) => Number(item.close));
  const twoDayBoxFailure =
    recentCloses.length >= 2 &&
    recentCloses.every((close) => boxHigh && close < boxHigh * 0.98);
  const originLocalVeto =
    twoDayBoxFailure || (limitVolumeRatio > 4 && eventBodyRatio < 0.45);
  const originBreakout =
    Boolean(boxHigh && boxLow) &&
    Number(event.close) >= boxHigh &&
    boxWidth <= 18 &&
    breakoutPct >= 0 &&
    breakoutPct <= 12 &&
    limitVolumeRatio >= 1.2 &&
    limitVolumeRatio <= 3.5 &&
    eventBodyRatio >= 0.55 &&
    Number(latest.close) >= boxHigh * 0.98 &&
    !originLocalVeto;

  const post = history.slice(eventIndex + 1, evaluationIndex + 1);
  const eventTr = trueRange(history, eventIndex);
  const postTrs = post.map((_, offset) => trueRange(history, eventIndex + 1 + offset));
  const compressionRatio = eventTr ? average(postTrs) / eventTr : 0;
  const postHigh = post.length ? Math.max(...post.map((item) => Number(item.high))) : 0;
  const postLow = post.length ? Math.min(...post.map((item) => Number(item.low))) : 0;
  const vcpPlatformWidth = Number(event.close)
    ? ((postHigh - postLow) / Number(event.close)) * 100
    : 0;
  const earlyTr = average(postTrs.slice(0, 3));
  const lateTr = average(postTrs.slice(-3));
  const lateEarlyRatio = earlyTr ? lateTr / earlyTr : 0;
  const thresholds =
    node <= 3 ? { compression: 0.7, width: 8, late: Infinity } :
      node <= 5 ? { compression: 0.65, width: 10, late: 0.9 } :
        node <= 7 ? { compression: 0.6, width: 11, late: 0.85 } :
          { compression: 0.55, width: 12, late: 0.8 };
  const platformMid = postLow + (postHigh - postLow) / 2;
  const latestTr = trueRange(history, evaluationIndex);
  const latestClosePosition =
    Number(latest.high) === Number(latest.low)
      ? 1
      : (Number(latest.close) - Number(latest.low)) /
        (Number(latest.high) - Number(latest.low));
  const vcpLocalVeto =
    (eventTr && latestTr > eventTr * 1.2 && latestClosePosition < 0.3) ||
    (
      postTrs.length >= 3 &&
      postTrs.at(-1) > postTrs.at(-2) &&
      postTrs.at(-2) > postTrs.at(-3) &&
      Number(latest.close) < Number(latest.open)
    );
  const vcpCompression =
    post.length >= 3 &&
    compressionRatio <= thresholds.compression &&
    vcpPlatformWidth <= thresholds.width &&
    lateEarlyRatio <= thresholds.late &&
    Number(latest.close) >= platformMid &&
    !vcpLocalVeto;

  const eventTurnover = Number(event.turnover || 0);
  const postTurns = post.map((item) => Number(item.turnover || 0)).filter((value) => value > 0);
  const turnoverDecay = eventTurnover && postTurns.length
    ? median(postTurns) / eventTurnover
    : Number(event.volume)
      ? median(post.map((item) => Number(item.volume || 0))) / Number(event.volume)
      : 0;
  const downDays = post.filter((item, offset) => {
    const prior = history[eventIndex + offset];
    return Number(item.close) < Number(prior?.close || item.open);
  });
  const postVolume = post.reduce((sum, item) => sum + Number(item.volume || 0), 0);
  const downVolume = downDays.reduce((sum, item) => sum + Number(item.volume || 0), 0);
  const downVolumeShare = postVolume ? downVolume / postVolume : 0;
  const downCloseWeighted = downVolume
    ? downDays.reduce((sum, item) => {
        const position =
          Number(item.high) === Number(item.low)
            ? 1
            : (Number(item.close) - Number(item.low)) /
              (Number(item.high) - Number(item.low));
        return sum + position * Number(item.volume || 0);
      }, 0) / downVolume
    : 1;
  const chipLockScore = Math.round(
    45 * clamp((1.2 - turnoverDecay) / 0.7) +
    35 * (1 - clamp(downVolumeShare)) +
    20 * clamp(downCloseWeighted)
  );
  const lastTwo = post.slice(-2);
  const consecutiveDistribution =
    lastTwo.length === 2 &&
    lastTwo.every((item, offset) => {
      const index = evaluationIndex - 1 + offset;
      const prior5 = history
        .slice(Math.max(0, index - 5), index)
        .map((row) => Number(row.volume || 0));
      return Number(item.close) < Number(item.open) &&
        Number(item.volume || 0) > average(prior5) * 1.25;
    });
  const chipLocalVeto =
    (turnoverDecay > 1.3 && downVolumeShare > 0.65) || consecutiveDistribution;
  const chipLock =
    post.length >= 2 &&
    chipLockScore >= 60 &&
    turnoverDecay <= 0.8 &&
    downVolumeShare <= 0.55 &&
    !chipLocalVeto;

  return {
    originBreakout,
    boxHigh,
    boxLow,
    boxWidth,
    breakoutPct,
    limitVolumeRatio,
    eventBodyRatio,
    originLocalVeto,
    vcpCompression,
    compressionRatio,
    vcpPlatformWidth,
    lateEarlyRatio,
    vcpThresholds: thresholds,
    vcpLocalVeto,
    chipLock,
    chipLockScore,
    turnoverDecay,
    downVolumeShare,
    downCloseWeighted,
    chipUsesTurnover: Boolean(eventTurnover && postTurns.length),
    chipLocalVeto
  };
}

function featureSnapshot(history, event, evaluationIndex, events) {
  const latest = history[evaluationIndex];
  const previousDay = history[evaluationIndex - 1];
  const since = history.slice(event.index, evaluationIndex + 1);
  const minLow = Math.min(...since.map((item) => Number(item.low)));
  const heldSupport = minLow >= Number(event.low) - 0.001;
  const avwapVolume = since.reduce((sum, item) => sum + Number(item.volume || 0), 0);
  const avwapAmount = since.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const avwap = avwapVolume ? avwapAmount / (avwapVolume * 100) : 0;
  const ma5 = movingAverage(history, 5, evaluationIndex);
  const ma10 = movingAverage(history, 10, evaluationIndex);
  const ma20 = movingAverage(history, 20, evaluationIndex);
  const priorMa5 = movingAverage(history, 5, evaluationIndex - 1);
  const priorMa10 = movingAverage(history, 10, evaluationIndex - 1);
  const priorMa20 = movingAverage(history, 20, evaluationIndex - 1);
  const priorVolumes = history
    .slice(Math.max(0, evaluationIndex - 5), evaluationIndex)
    .map((item) => Number(item.volume || 0));
  const priorTurns = history
    .slice(Math.max(0, evaluationIndex - 20), evaluationIndex)
    .map((item) => Number(item.turnover || 0));
  const volumeRatio = average(priorVolumes) ? Number(latest.volume || 0) / average(priorVolumes) : 0;
  const relativeTurnover = average(priorTurns) ? Number(latest.turnover || 0) / average(priorTurns) : 0;
  const closePosition =
    Number(latest.high) === Number(latest.low)
      ? 1
      : (Number(latest.close) - Number(latest.low)) / (Number(latest.high) - Number(latest.low));
  const maxDrawdown = Number(event.close)
    ? ((Number(event.close) - minLow) / Number(event.close)) * 100
    : 0;
  const consolidation = history.slice(event.index + 1, evaluationIndex);
  const platformHigh = consolidation.length
    ? Math.max(...consolidation.map((item) => Number(item.high)))
    : 0;
  const platformLow = consolidation.length
    ? Math.min(...consolidation.map((item) => Number(item.low)))
    : 0;
  const platformRange = platformLow ? ((platformHigh - platformLow) / platformLow) * 100 : 0;
  const recentEventCount = events.filter(
    (item) => item.index <= event.index && item.index >= event.index - 59
  ).length;
  const start20 = Math.max(0, event.index - 20);
  const preLimitReturn20 = Number(history[start20]?.close)
    ? ((Number(history[event.index - 1]?.close) / Number(history[start20].close)) - 1) * 100
    : 0;
  const reclaimedSupport = Number(latest.low) < Number(event.low) && Number(latest.close) >= Number(event.low);
  const lowOpenRecovery = Boolean(
    previousDay &&
      Number(latest.open) < Number(previousDay.close) &&
      Number(latest.close) > Number(previousDay.close) &&
      closePosition >= 0.7
  );
  const patternStrategies = computePatternStrategies(
    history,
    event.index,
    evaluationIndex
  );
  return {
    heldSupport,
    aboveAvwap: Boolean(avwap && Number(latest.close) >= avwap),
    maBull: ma5 > ma10 && ma10 > ma20,
    slopesUp: ma5 > priorMa5 && ma10 > priorMa10 && ma20 > priorMa20,
    volumeRatio,
    relativeTurnover,
    closePosition,
    maxDrawdown,
    platformHigh,
    platformRange,
    secondBreakout:
      consolidation.length >= 2 &&
      platformRange <= 12 &&
      Number(latest.close) > platformHigh &&
      volumeRatio >= 1.1 &&
      volumeRatio <= 2.2 &&
      heldSupport,
    lowFirstBoard: recentEventCount === 1 && preLimitReturn20 >= -25 && preLimitReturn20 <= 15 && heldSupport,
    weakToStrong: (reclaimedSupport || lowOpenRecovery) && closePosition >= 0.7 && volumeRatio <= 1.8,
    ...patternStrategies,
    riskVeto:
      heldSupport &&
      volumeRatio <= 2 &&
      !(avwap && Number(latest.close) < avwap && volumeRatio > 1.3) &&
      !(closePosition < 0.25 && volumeRatio > 1.5)
  };
}

const STAT_LABELS = {
  support: "涨停低点防守",
  avwap: "锚定均价承接",
  trend: "均线多头发散",
  contraction: "缩量抗跌",
  volatility: "波动收敛",
  exactNode: "精确观察节点",
  lowFirstBoard: "低位首板",
  originBreakout: "平台突破首板",
  vcpCompression: "波动压缩平台",
  chipLock: "筹码锁定",
  secondBreakout: "平台二次突破",
  weakToStrong: "弱转强",
  riskVeto: "风险否决",
  firstBoardQuality: "首板质量",
  sector: "强板块共振",
  sectorLeader: "板块龙头",
  sectorLadder: "板块梯队",
  information: "资讯确认",
  marketEmotion: "市场情绪过滤"
};

function strategyMatched(id, feature) {
  switch (id) {
    case "support": return feature.heldSupport;
    case "avwap": return feature.aboveAvwap;
    case "trend": return feature.maBull && feature.slopesUp;
    case "contraction": return feature.volumeRatio < 1 && feature.relativeTurnover < 1.5;
    case "volatility": return feature.maxDrawdown < 10 && feature.closePosition > 0.55;
    case "exactNode": return true;
    case "lowFirstBoard": return feature.lowFirstBoard;
    case "originBreakout": return feature.originBreakout;
    case "vcpCompression": return feature.vcpCompression;
    case "chipLock": return feature.chipLock;
    case "secondBreakout": return feature.secondBreakout;
    case "weakToStrong": return feature.weakToStrong;
    case "riskVeto": return feature.riskVeto;
    default: return null;
  }
}

function confidenceFor(sampleCount) {
  if (sampleCount >= 100) return { level: "较高", note: "已结算样本达到100次，仍需结合全市场验证" };
  if (sampleCount >= 30) return { level: "中等", note: "样本达到30次，结论仍仅适用于当前股票" };
  if (sampleCount >= 10) return { level: "偏低", note: "已结算样本少于30次，胜率仅作参考" };
  return { level: "不足", note: "已结算样本少于10次，不形成统计结论" };
}

function wilsonInterval(wins, total, z = 1.96) {
  if (!total) return null;
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) /
    denominator;
  return [
    Math.max(0, (center - margin) * 100),
    Math.min(100, (center + margin) * 100)
  ];
}

function summarizeSamples(id, samples) {
  const returns = (days) => samples.map((item) => item[`r${days}`]).filter(Number.isFinite);
  const r1 = returns(1);
  const r3 = returns(3);
  const r5 = returns(5);
  const excess5 = samples.map((item) => item.excess5).filter(Number.isFinite);
  const wins5 = r5.filter((value) => value > 0).length;
  const confidence = confidenceFor(r5.length);
  return {
    id,
    label: STAT_LABELS[id] || id,
    sampleCount: samples.length,
    n1: r1.length,
    n3: r3.length,
    n5: r5.length,
    winRate1: r1.length ? (r1.filter((value) => value > 0).length / r1.length) * 100 : null,
    winRate3: r3.length ? (r3.filter((value) => value > 0).length / r3.length) * 100 : null,
    winRate5: r5.length ? (wins5 / r5.length) * 100 : null,
    winRate5Interval: wilsonInterval(wins5, r5.length),
    nExcess5: excess5.length,
    winRateExcess5: excess5.length
      ? (excess5.filter((value) => value > 0).length / excess5.length) * 100
      : null,
    average1: r1.length ? average(r1) : null,
    average3: r3.length ? average(r3) : null,
    average5: r5.length ? average(r5) : null,
    averageExcess5: excess5.length ? average(excess5) : null,
    median5: r5.length ? median(r5) : null,
    worstMdd5: samples.some((item) => Number.isFinite(item.mdd5))
      ? Math.min(...samples.map((item) => item.mdd5).filter(Number.isFinite))
      : null,
    confidence: confidence.level,
    confidenceNote: confidence.note,
    available: r1.length > 0,
    unavailableReason:
      r1.length > 0
        ? ""
        : ["sector", "sectorLeader", "sectorLadder", "information", "marketEmotion", "firstBoardQuality"].includes(id)
          ? "该条件需要板块、资讯或封板快照，等待实盘信号积累"
          : "回放区间内没有已结算样本"
  };
}

function buildHistoricalStrategyStats(
  history,
  code,
  name,
  selectedIds = [],
  benchmarkHistory = [],
  options = {}
) {
  const gateIds = new Set(["riskVeto", "exactNode"]);
  const externalIds = new Set([
    "sector",
    "sectorLeader",
    "sectorLadder",
    "information",
    "marketEmotion",
    "firstBoardQuality"
  ]);
  const statisticIds = selectedIds.filter((id) => !gateIds.has(id));
  const replayableIds = statisticIds.filter((id) => !externalIds.has(id));
  if (!Array.isArray(history) || history.length < 40) {
    return {
      source: "个股不复权日线回放",
      range: "",
      totalEvents: 0,
      entryRule: "T+N收盘产生信号，下一交易日开盘模拟买入",
      stats: statisticIds.map((id) => summarizeSamples(id, [])),
      nodeStats: [],
      untradeableCount: 0,
      ...(options.includeSamples ? { combinationSamples: [] } : {})
    };
  }
  const rawEvents = detectLimitEvents(history, code, name);
  const events = rawEvents.filter(
    (event, index) => index === 0 || event.index > rawEvents[index - 1].index + 1
  );
  const nodes = [3, 5, 7, 9];
  const samplesByStrategy = new Map(statisticIds.map((id) => [id, []]));
  const nodeSamples = new Map(nodes.map((node) => [node, []]));
  const combinationSamples = [];
  const benchmarkByDate = new Map(
    (Array.isArray(benchmarkHistory) ? benchmarkHistory : [])
      .filter((item) => item?.date)
      .map((item) => [String(item.date).slice(0, 10), item])
  );
  let untradeableCount = 0;

  for (const event of events) {
    for (const node of nodes) {
      const evaluationIndex = event.index + node;
      const entryIndex = evaluationIndex + 1;
      if (entryIndex >= history.length) continue;
      const evaluation = history[evaluationIndex];
      const feature = featureSnapshot(history, event, evaluationIndex, events);
      const entry = history[entryIndex];
      const entryPrice = Number(entry.open);
      if (!entryPrice) continue;
      const entryTarget = roundPrice(
        Number(evaluation.close) * (1 + priceLimitRate(code, name))
      );
      const onePriceLimitUp =
        Number(entry.low) >= entryTarget - 0.011 &&
        Math.abs(Number(entry.high) - Number(entry.low)) < 0.001;
      if (onePriceLimitUp) {
        untradeableCount += 1;
        continue;
      }
      const outcome = {
        node,
        date: evaluation.date,
        entryDate: entry.date,
        entryPrice
      };
      for (const days of [1, 3, 5]) {
        const futureIndex = entryIndex + days - 1;
        if (futureIndex < history.length) {
          const future = history[futureIndex];
          outcome[`r${days}`] = ((Number(future.close) / entryPrice) - 1) * 100;
          if (days === 5) outcome.exitDate = String(future.date || "").slice(0, 10);
          const benchmarkEntry = benchmarkByDate.get(String(entry.date).slice(0, 10));
          const benchmarkFuture = benchmarkByDate.get(String(future.date).slice(0, 10));
          const benchmarkEntryPrice = Number(benchmarkEntry?.open);
          const benchmarkFuturePrice = Number(benchmarkFuture?.close);
          outcome[`benchmarkR${days}`] =
            benchmarkEntryPrice && benchmarkFuturePrice
              ? ((benchmarkFuturePrice / benchmarkEntryPrice) - 1) * 100
              : null;
          outcome[`excess${days}`] =
            Number.isFinite(outcome[`benchmarkR${days}`])
              ? outcome[`r${days}`] - outcome[`benchmarkR${days}`]
              : null;
        } else {
          outcome[`r${days}`] = null;
          outcome[`benchmarkR${days}`] = null;
          outcome[`excess${days}`] = null;
        }
      }
      const hasFiveDays = entryIndex + 4 < history.length;
      const forward = hasFiveDays ? history.slice(entryIndex, entryIndex + 5) : [];
      outcome.mdd5 = hasFiveDays
        ? Math.min(...forward.map((item) => ((Number(item.low) / entryPrice) - 1) * 100))
        : null;
      nodeSamples.get(node).push(outcome);
      const matchedReplayable = [];
      for (const id of statisticIds) {
        if (strategyMatched(id, feature) === true) {
          samplesByStrategy.get(id).push(outcome);
          if (replayableIds.includes(id)) matchedReplayable.push(id);
        }
      }
      const combinationRate = replayableIds.length
        ? (matchedReplayable.length / replayableIds.length) * 100
        : 0;
      if (replayableIds.length && combinationRate >= 70 && feature.riskVeto) {
        combinationSamples.push(outcome);
      }
    }
  }

  const combination = summarizeSamples("currentCombination", combinationSamples);
  combination.label = "当前可回放组合";
  combination.coverage = statisticIds.length
    ? replayableIds.length / statisticIds.length
    : 0;
  combination.confidenceNote =
    `${combination.confidenceNote}；覆盖 ${replayableIds.length}/${statisticIds.length} 个可回放条件`;

  return {
    source: "个股不复权日线回放",
    range: `${history[0]?.date || ""} 至 ${history.at(-1)?.date || ""}`,
    totalEvents: events.length,
    rawEventCount: rawEvents.length,
    entryRule: "T+N收盘产生信号，下一交易日开盘模拟买入；一字涨停不可成交样本剔除",
    benchmarkAvailable: Array.isArray(benchmarkHistory) && benchmarkHistory.length > 0,
    untradeableCount,
    stats: [
      combination,
      ...statisticIds.map((id) => summarizeSamples(id, samplesByStrategy.get(id) || []))
    ],
    nodeStats: nodes.map((node) => {
      const samples = nodeSamples.get(node) || [];
      const r5 = samples.map((item) => item.r5).filter(Number.isFinite);
      const excess5 = samples.map((item) => item.excess5).filter(Number.isFinite);
      const confidence = confidenceFor(r5.length);
      return {
        node: `T+${node}`,
        sampleCount: samples.length,
        n5: r5.length,
        winRate5: r5.length ? (r5.filter((value) => value > 0).length / r5.length) * 100 : null,
        average5: r5.length ? average(r5) : null,
        nExcess5: excess5.length,
        averageExcess5: excess5.length ? average(excess5) : null,
        confidence: confidence.level
      };
    }),
    ...(options.includeSamples ? { combinationSamples } : {})
  };
}

function buildSectorLadder({ currentPool = [], previousPool = [], failedPool = [], memberCodes = [] } = {}) {
  const members = new Set(memberCodes.map(String));
  const inSector = (item) => !members.size || members.has(String(item.code));
  const current = (Array.isArray(currentPool) ? currentPool : []).filter(inSector);
  const previous = (Array.isArray(previousPool) ? previousPool : []).filter(inSector);
  const failedPoolAvailable = Array.isArray(failedPool);
  const failed = failedPoolAvailable ? failedPool.filter(inSector) : [];
  const previousCodes = new Set(previous.map((item) => String(item.code)));
  const promoted = current.filter((item) => previousCodes.has(String(item.code)));
  const maxHeight = current.length
    ? Math.max(...current.map((item) => Number(item.consecutiveBoards || 1)))
    : 0;
  const levels = [...new Set(current.map((item) => Number(item.consecutiveBoards || 1)))]
    .sort((a, b) => b - a)
    .map((height) => ({
      height,
      label: height === 1 ? "首板" : `${height}连板`,
      stocks: current
        .filter((item) => Number(item.consecutiveBoards || 1) === height)
        .sort((a, b) => Number(a.firstSealRaw || 999999) - Number(b.firstSealRaw || 999999))
        .map((item) => ({
          code: item.code,
          name: item.name,
          firstSealTime: item.firstSealTime,
          openBoardCount: item.openBoardCount,
          turnover: item.turnover
        }))
    }));
  const promotionRate = previous.length ? promoted.length / previous.length : 0;
  const breakRate = failedPoolAvailable
    ? current.length + failed.length
      ? failed.length / (current.length + failed.length)
      : 0
    : null;
  const ladderScore = failedPoolAvailable
    ? Math.round(
        Math.max(
          0,
          Math.min(
            100,
            35 +
              Math.min(25, maxHeight * 5) +
              Math.min(20, current.length * 2) +
              promotionRate * 25 -
              breakRate * 25
          )
        )
      )
    : null;
  return {
    currentLimitUps: current.length,
    previousLimitUps: previous.length,
    firstBoards: current.filter((item) => Number(item.consecutiveBoards || 1) === 1).length,
    continuationBoards: current.filter((item) => Number(item.consecutiveBoards || 1) > 1).length,
    failedBoards: failedPoolAvailable ? failed.length : null,
    failedPoolAvailable,
    promotedCount: promoted.length,
    promotionRate,
    breakRate,
    maxHeight,
    levels,
    leaders: levels.flatMap((level) => level.stocks).slice(0, 8),
    score: ladderScore,
    state: !failedPoolAvailable
      ? "炸板数据缺失"
      : ladderScore >= 80 ? "梯队完整" :
        ladderScore >= 65 ? "梯队增强" :
          ladderScore >= 50 ? "首板扩散" :
            ladderScore >= 35 ? "梯队分化" : "梯队退潮"
  };
}

module.exports = {
  decorateLimitPoolItem,
  scoreFirstBoardQuality,
  computePatternStrategies,
  buildHistoricalStrategyStats,
  buildSectorLadder,
  formatPoolTime
};
