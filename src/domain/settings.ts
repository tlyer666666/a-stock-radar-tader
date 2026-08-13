export type NormalizedSettings = Required<Settings>;

export const initialSettings: Settings = {
  provider: "ths",
  riskProfile: "balanced",
  refreshToken: "",
  tushareToken: "",
  multiSourceEnabled: true,
  fallbackEnabled: true,
  quoteRefreshSeconds: 5,
  refreshSeconds: 90,
  newsRefreshSeconds: 6,
  newsVoiceEnabled: true,
  alertScore: 75,
  exactNodesOnly: false,
  strictGate: false,
  maxPositionPercent: 28,
  maxRiskPerTradePercent: 1,
  stopLossATRMultiple: 2,
  takeProfitATRMultiple: 3.2,
  maxHoldingBars: 30,
  minMarketCap: 0,
  maxDailyRiskPercent: 3.2,
  maxPortfolioRiskPercent: 70,
  maxSectorExposurePercent: 45,
  minProjectedNetEdgePercent: 0.2,
  minExpectancyPoints: 0.2,
  maxConsecutiveLossesForStop: 4,
  lossStreakStepPercent: 18,
  lossStreakFloorPercent: 30,
  commissionBps: 7,
  slippageBps: 2,
  minTurnoverPercent: 0.4,
  minQuoteAmount: 1200000,
  maxQuoteAgeSeconds: 480,
  timeDecayPerBarPercent: 0.11,
  maxOpenPositions: 2,
  maxDailyTrades: 12,
  minExecutionRatePercent: 90,
  minPaperWinRatePercent: 52,
  minPaperRiskRewardRatio: 1.15,
  trailingStopPercent: 3,
  enabledPaperSim: true,
  selectedStrategies: ["support", "avwap", "trend", "contraction", "sector", "sectorLadder", "riskVeto"],
  theme: "system"
};

export const riskProfilePresets: Array<{
  id: Settings["riskProfile"];
  name: string;
  detail: string;
  settings: Partial<Settings>;
}> = [
  {
    id: "conservative",
    name: "稳健保守",
    detail: "更低杠杆与更高触发门槛，适合风控优先。",
    settings: {
      maxPositionPercent: 20,
      maxRiskPerTradePercent: 0.6,
      stopLossATRMultiple: 2.4,
      takeProfitATRMultiple: 3.6,
      maxHoldingBars: 24,
      maxDailyRiskPercent: 2.2,
      maxPortfolioRiskPercent: 48,
      maxSectorExposurePercent: 28,
      maxConsecutiveLossesForStop: 3,
      lossStreakStepPercent: 22,
      lossStreakFloorPercent: 24,
      maxDailyTrades: 6,
      minExecutionRatePercent: 94,
      minPaperWinRatePercent: 56,
      minPaperRiskRewardRatio: 1.35,
      trailingStopPercent: 2.5,
      maxOpenPositions: 2,
      minProjectedNetEdgePercent: 0.35,
      minExpectancyPoints: 0.3
    }
  },
  {
    id: "balanced",
    name: "平衡稳健",
    detail: "兼顾收益与回撤，适合日内高频观察迭代。",
    settings: {
      maxPositionPercent: 28,
      maxRiskPerTradePercent: 1,
      stopLossATRMultiple: 2,
      takeProfitATRMultiple: 3.2,
      maxHoldingBars: 30,
      maxDailyRiskPercent: 3.2,
      maxPortfolioRiskPercent: 70,
      maxSectorExposurePercent: 45,
      maxConsecutiveLossesForStop: 4,
      lossStreakStepPercent: 18,
      lossStreakFloorPercent: 30,
      maxDailyTrades: 12,
      minExecutionRatePercent: 90,
      minPaperWinRatePercent: 52,
      minPaperRiskRewardRatio: 1.15,
      trailingStopPercent: 3,
      maxOpenPositions: 2,
      minProjectedNetEdgePercent: 0.2,
      minExpectancyPoints: 0.2
    }
  },
  {
    id: "aggressive",
    name: "积极进取",
    detail: "更高频率与风险上限，需严格监控执行纪律。",
    settings: {
      maxPositionPercent: 36,
      maxRiskPerTradePercent: 1.45,
      stopLossATRMultiple: 1.8,
      takeProfitATRMultiple: 3.1,
      maxHoldingBars: 36,
      maxDailyRiskPercent: 4.5,
      maxPortfolioRiskPercent: 82,
      maxSectorExposurePercent: 52,
      maxConsecutiveLossesForStop: 6,
      lossStreakStepPercent: 14,
      lossStreakFloorPercent: 36,
      maxDailyTrades: 18,
      minExecutionRatePercent: 85,
      minPaperWinRatePercent: 49,
      minPaperRiskRewardRatio: 1.05,
      trailingStopPercent: 3.8,
      maxOpenPositions: 3,
      minProjectedNetEdgePercent: 0.1,
      minExpectancyPoints: 0.1
    }
  }
];

export const strategyOptions = [
  { id: "support", name: "涨停低点防守", detail: "观察期内不跌破涨停日最低价" },
  { id: "avwap", name: "锚定均价承接", detail: "价格保持在涨停日起算 AVWAP 上方" },
  { id: "trend", name: "均线多头发散", detail: "MA5 > MA10 > MA20，且斜率同时向上" },
  { id: "contraction", name: "缩量抗跌", detail: "量能低于五日均量，相对换手不过热" },
  { id: "sector", name: "强板块共振", detail: "板块强度不低于 65，个股不弱于板块" },
  { id: "volatility", name: "回撤与收盘质量", detail: "回撤小于 10%，收盘位于振幅上半区" },
  { id: "originBreakout", name: "平台突破首板", detail: "涨停从窄幅箱体放量突破，观察期仍守在突破位附近" },
  { id: "vcpCompression", name: "波动压缩平台", detail: "按 T+3/5/7/9 使用不同阈值，确认真实波动逐步收窄" },
  { id: "chipLock", name: "筹码锁定", detail: "观察期换手衰减、下跌量占比低，抛压持续减弱" },
  { id: "information", name: "信息催化确认", detail: "高可信资讯存在正向催化，且无重大风险公告" },
  { id: "exactNode", name: "精确观察节点", detail: "只匹配 T+3 / T+5 / T+7 / T+9" },
  { id: "lowFirstBoard", name: "低位首板", detail: "近60日首次涨停，板前20日涨幅不高并守住关键位" },
  { id: "firstBoardQuality", name: "首板质量", detail: "综合首次封板、开板次数、封单、换手和涨停位置" },
  { id: "secondBreakout", name: "平台二次突破", detail: "涨停后整理3–9日，温和放量突破平台高点" },
  { id: "sectorLeader", name: "板块龙头", detail: "板块强度合格，个股排名与相对板块收益领先" },
  { id: "sectorLadder", name: "板块梯队", detail: "首板、连板、晋级率和炸板率共同确认板块持续性" },
  { id: "weakToStrong", name: "弱转强", detail: "盘中收回关键位，或低开后强势反包" },
  { id: "marketEmotion", name: "市场情绪过滤", detail: "比较涨停、跌停数量和涨停家数变化，过滤退潮期" },
  { id: "riskVeto", name: "风险否决", detail: "跌破关键位、巨量、过热或弱收盘时直接否决" }
];

export const strategyPresets = [
  {
    id: "steady",
    name: "稳健趋势",
    detail: "趋势、承接、板块与风险过滤",
    strategies: ["support", "avwap", "trend", "contraction", "sector", "sectorLadder", "riskVeto"]
  },
  {
    id: "firstBoard",
    name: "低位首板",
    detail: "低位首次涨停后的关键位防守",
    strategies: ["firstBoardQuality", "lowFirstBoard", "support", "sectorLadder", "riskVeto"]
  },
  {
    id: "leader",
    name: "主线龙头",
    detail: "板块龙头、资讯与市场情绪共振",
    strategies: ["sectorLeader", "sector", "sectorLadder", "information", "marketEmotion", "support", "riskVeto"]
  },
  {
    id: "secondWave",
    name: "二波蓄势",
    detail: "首板来源、波动压缩与筹码锁定共同确认",
    strategies: ["originBreakout", "vcpCompression", "chipLock", "secondBreakout", "support", "riskVeto"]
  },
  {
    id: "turnStrong",
    name: "弱转强",
    detail: "低开反包或关键位失而复得",
    strategies: ["weakToStrong", "avwap", "sector", "marketEmotion", "volatility", "riskVeto"]
  }
];

export const sameStrategySet = (left: string[] = [], right: string[] = []) =>
  left.length === right.length && left.every((item) => right.includes(item));

export const safeNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const clampNumber = (value: unknown, min: number, max: number, fallback = 0) => {
  const parsed = safeNumber(value, fallback);
  return Math.min(max, Math.max(min, parsed));
};

export const normalizeRiskProfile = (value: unknown): Settings["riskProfile"] =>
  value === "conservative" || value === "aggressive" ? value : "balanced";

export const normalizeSettings = (input: Settings): NormalizedSettings => {
  const merged = { ...initialSettings, ...input } as Settings;
  const stopLoss = clampNumber(merged.stopLossATRMultiple, 0.8, 5, 1.8);
  const takeProfitDefault = Math.max(2, stopLoss + 0.4);
  const selectedStrategies = Array.isArray(merged.selectedStrategies) && merged.selectedStrategies.length
    ? merged.selectedStrategies
    : initialSettings.selectedStrategies;
  const dedupedStrategies = [...new Set(selectedStrategies.filter((item) => typeof item === "string"))];
  return {
    ...merged,
    provider: "ths",
    refreshToken: String(merged.refreshToken || ""),
    tushareToken: String(merged.tushareToken || ""),
    multiSourceEnabled: merged.multiSourceEnabled !== false,
    fallbackEnabled: merged.fallbackEnabled !== false,
    quoteRefreshSeconds: clampNumber(merged.quoteRefreshSeconds, 3, 20, 5),
    refreshSeconds: clampNumber(merged.refreshSeconds, 30, 300, 90),
    newsRefreshSeconds: clampNumber(merged.newsRefreshSeconds, 5, 45, 6),
    newsVoiceEnabled: merged.newsVoiceEnabled !== false,
    alertScore: clampNumber(merged.alertScore, 50, 95, 75),
    exactNodesOnly: Boolean(merged.exactNodesOnly),
    strictGate: Boolean(merged.strictGate),
    riskProfile: normalizeRiskProfile(merged.riskProfile),
    maxPositionPercent: clampNumber(merged.maxPositionPercent, 5, 90, 28),
    maxRiskPerTradePercent: clampNumber(merged.maxRiskPerTradePercent, 0.2, 5, 1),
    stopLossATRMultiple: stopLoss,
    takeProfitATRMultiple: clampNumber(Math.max(merged.takeProfitATRMultiple, takeProfitDefault), Math.max(stopLoss + 0.2, takeProfitDefault), 10, takeProfitDefault),
    maxHoldingBars: Math.round(clampNumber(merged.maxHoldingBars, 3, 120, 30)),
    minMarketCap: clampNumber(merged.minMarketCap, 0, 100000, 0),
    minTurnoverPercent: clampNumber(merged.minTurnoverPercent, 0, 20, 0.4),
    minQuoteAmount: clampNumber(merged.minQuoteAmount, 0, 1_000_000_000, 1200000),
    maxQuoteAgeSeconds: clampNumber(merged.maxQuoteAgeSeconds, 30, 1800, 480),
    maxDailyRiskPercent: clampNumber(merged.maxDailyRiskPercent ?? 3.2, 0.3, 12, 3.2),
    maxSectorExposurePercent: clampNumber(merged.maxSectorExposurePercent ?? 45, 10, 100, 45),
    commissionBps: clampNumber(merged.commissionBps ?? 7, 0, 40, 7),
    slippageBps: clampNumber(merged.slippageBps ?? 2, 0, 40, 2),
    maxDailyTrades: Math.round(clampNumber(merged.maxDailyTrades ?? 12, 1, 200, 12)),
    timeDecayPerBarPercent: clampNumber(merged.timeDecayPerBarPercent ?? 0.11, 0, 1, 0.11),
    minProjectedNetEdgePercent: clampNumber(merged.minProjectedNetEdgePercent ?? 0.2, -2, 10, 0.2),
    minExpectancyPoints: clampNumber(merged.minExpectancyPoints ?? 0.2, -1, 5, 0.2),
    maxConsecutiveLossesForStop: Math.round(clampNumber(merged.maxConsecutiveLossesForStop ?? 4, 2, 12, 4)),
    lossStreakStepPercent: clampNumber(merged.lossStreakStepPercent ?? 18, 2, 60, 18),
    lossStreakFloorPercent: clampNumber(merged.lossStreakFloorPercent ?? 30, 10, 80, 30),
    maxPortfolioRiskPercent: clampNumber(merged.maxPortfolioRiskPercent ?? 70, 10, 100, 70),
    minPaperWinRatePercent: clampNumber(merged.minPaperWinRatePercent ?? 52, 40, 90, 52),
    minPaperRiskRewardRatio: clampNumber(merged.minPaperRiskRewardRatio ?? 1.15, 1, 3, 1.15),
    minExecutionRatePercent: clampNumber(merged.minExecutionRatePercent ?? 90, 40, 100, 90),
    trailingStopPercent: clampNumber(merged.trailingStopPercent ?? 3, 0, 20, 3),
    maxOpenPositions: Math.round(clampNumber(merged.maxOpenPositions ?? 2, 1, 10, 2)),
    enabledPaperSim: merged.enabledPaperSim !== false,
    selectedStrategies: dedupedStrategies.includes("riskVeto")
      ? dedupedStrategies
      : [...dedupedStrategies, "riskVeto"],
    theme: merged.theme === "light" || merged.theme === "dark" || merged.theme === "system"
      ? merged.theme
      : "system"
  };
};

export const riskProfileLabel = (value: Settings["riskProfile"]) =>
  value === "conservative" ? "稳健保守" : value === "aggressive" ? "积极进取" : "平衡稳健";

export const buildSettingsByRiskProfile = (input: Settings, profile: Settings["riskProfile"]): Settings => {
  const preset = riskProfilePresets.find((item) => item.id === profile);
  return normalizeSettings({
    ...input,
    riskProfile: profile,
    ...(preset ? preset.settings : {})
  });
};
