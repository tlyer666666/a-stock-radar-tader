import signalCombinationCatalog from "../../config/strategy-signal-combinations.json";
import signalStrategyCatalog from "../../config/strategy-signal-catalog.json";
import { validateCustomStrategy, type CustomStrategy, type PatternOption } from "../features/strategy-selection/customStrategyModel";
import { inferSecurityMeta } from "../domain/securityIdentifiers";

const previewShanghaiDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(date);

const previewTradingDates = (count = 5) => {
  const dates: string[] = [];
  const cursor = new Date(`${previewShanghaiDate()}T12:00:00+08:00`);
  while (dates.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(previewShanghaiDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates;
};

const previewSecurities: Security[] = [
  {
    code: "600519",
    name: "贵州茅台",
    secid: "1.600519",
    thscode: "600519.SH",
    marketName: "沪A",
    assetType: "stock"
  },
  {
    code: "300750",
    name: "宁德时代",
    secid: "0.300750",
    thscode: "300750.SZ",
    marketName: "深A",
    assetType: "stock"
  },
  {
    code: "002594",
    name: "比亚迪",
    secid: "0.002594",
    thscode: "002594.SZ",
    marketName: "深A",
    assetType: "stock"
  }
];

const previewVerifiedStrategies = signalStrategyCatalog;

const previewExtraIds = new Set([...signalCombinationCatalog.map(entry => entry.id), "relative_strength_pullback"]);

const defaultPreviewSettings: Settings = {
  riskProfile: "balanced",
  provider: "ths",
  refreshToken: "",
  tushareToken: "",
  fuyaoApiKey: "",
  aiBaseUrl: "",
  aiModel: "",
  aiApiKey: "",
  aiRankInstructions: "",
  aiSummaryInstructions: "",
  multiSourceEnabled: true,
  fallbackEnabled: true,
  quoteRefreshSeconds: 5,
  refreshSeconds: 90,
  newsRefreshSeconds: 6,
  newsVoiceEnabled: false,
  alertScore: 75,
  exactNodesOnly: false,
  strictGate: true,
  maxPositionPercent: 28,
  maxRiskPerTradePercent: 1,
  stopLossATRMultiple: 2,
  takeProfitATRMultiple: 3.2,
  maxHoldingBars: 30,
  minMarketCap: 0,
  maxDailyRiskPercent: 3.2,
  maxPortfolioRiskPercent: 70,
  minProjectedNetEdgePercent: 0.2,
  minExpectancyPoints: 0.2,
  maxConsecutiveLossesForStop: 4,
  maxDailyTrades: 12,
  lossStreakStepPercent: 18,
  lossStreakFloorPercent: 30,
  minPaperWinRatePercent: 52,
  minExecutionRatePercent: 90,
  minPaperRiskRewardRatio: 1.15,
  maxSectorExposurePercent: 45,
  minTurnoverPercent: 0.4,
  minQuoteAmount: 1_200_000,
  maxQuoteAgeSeconds: 480,
  trailingStopPercent: 3,
  commissionBps: 7,
  slippageBps: 2,
  timeDecayPerBarPercent: 0.11,
  maxOpenPositions: 2,
  enabledPaperSim: true,
  selectedStrategies: [
    "support",
    "avwap",
    "trend",
    "contraction",
    "sector",
    "sectorLadder",
    "riskVeto"
  ],
  theme: "system"
};

export const previewState = {
  customStrategies: [{
    id: "cs_preview01",
    name: "稳健趋势（由设置迁移）",
    description: "浏览器预览演示：由设置页自主策略组合迁移。",
    universe: "limit_pool",
    conditions: ["support", "avwap", "trend", "contraction", "sector", "sectorLadder"].map(id => ({ ref: `factor:${id}`, required: id === "trend" })),
    requiredAnyGroups: [],
    minMatchPercent: 70,
    filters: {},
    origin: "legacy-settings",
    revision: 1,
    createdAt: null,
    updatedAt: null
  }] as CustomStrategy[],
  customSequence: 1,
  settings: { ...defaultPreviewSettings } as Settings,
  watchlist: [] as WatchItem[],
  holdings: [] as HoldingItem[]
};

export const savePreviewCustom = (input: CustomStrategy) => {
  const issues = validateCustomStrategy(input, previewVerifiedStrategies as unknown as PatternOption[], previewState.customStrategies);
  if (issues.length) throw new Error(issues[0]!.message);
  const now = new Date().toISOString();
  const existing = input.id ? previewState.customStrategies.find(item => item.id === input.id) : undefined;
  const strategy: CustomStrategy = existing
    ? { ...structuredClone(input), name: input.name.trim(), revision: (existing.revision || 1) + 1, createdAt: existing.createdAt || now, updatedAt: now }
    : { ...structuredClone(input), name: input.name.trim(), id: `cs_preview${String(++previewState.customSequence).padStart(2, "0")}`, revision: 1, createdAt: now, updatedAt: now };
  previewState.customStrategies = existing ? previewState.customStrategies.map(item => item.id === strategy.id ? strategy : item) : [...previewState.customStrategies, strategy];
  return { strategy, strategies: structuredClone(previewState.customStrategies) };
};

export const resolveSecurity = (input: Security | string): Security => {
  if (typeof input !== "string") return input;
  const hit = previewSecurities.find((item) => item.code === input);
  if (hit) return hit;
  const meta = inferSecurityMeta(input);
  return {
    ...meta,
    name: `预览标的 ${input}`
  };
};

export {
  previewShanghaiDate,
  previewTradingDates,
  previewSecurities,
  previewVerifiedStrategies,
  previewExtraIds,
  defaultPreviewSettings
};
