import signalCombinationCatalog from "../config/strategy-signal-combinations.json";
import signalStrategyCatalog from "../config/strategy-signal-catalog.json";
import { createTrendPreviewStatus, createConfiguredTrendPreviewStatus } from "./trendScreenerPreview";
import { CUSTOM_CATALOG, validateCustomStrategy, type CustomStrategy } from "./features/strategy-selection/customStrategyModel";

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
// 浏览器预览：自定义策略只保存在本页内存中，刷新即恢复为一套演示策略。
let previewCustomStrategies: CustomStrategy[] = [{
  id: "cs_preview01", name: "稳健趋势（由设置迁移）", description: "浏览器预览演示：由设置页自主策略组合迁移。", universe: "limit_pool",
  conditions: ["support", "avwap", "trend", "contraction", "sector", "sectorLadder"].map(id => ({ ref: `factor:${id}`, required: id === "trend" })),
  requiredAnyGroups: [], minMatchPercent: 70, filters: {}, origin: "legacy-settings", revision: 1, createdAt: null, updatedAt: null
}];
let previewCustomSequence = 1;
const savePreviewCustom = (input: CustomStrategy) => {
  const issues = validateCustomStrategy(input, previewVerifiedStrategies as any, previewCustomStrategies);
  if (issues.length) throw new Error(issues[0]!.message);
  const now = new Date().toISOString();
  const existing = input.id ? previewCustomStrategies.find(item => item.id === input.id) : undefined;
  const strategy: CustomStrategy = existing
    ? { ...structuredClone(input), name: input.name.trim(), revision: (existing.revision || 1) + 1, createdAt: existing.createdAt || now, updatedAt: now }
    : { ...structuredClone(input), name: input.name.trim(), id: `cs_preview${String(++previewCustomSequence).padStart(2, "0")}`, revision: 1, createdAt: now, updatedAt: now };
  previewCustomStrategies = existing ? previewCustomStrategies.map(item => item.id === strategy.id ? strategy : item) : [...previewCustomStrategies, strategy];
  return { strategy, strategies: structuredClone(previewCustomStrategies) };
};
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

let previewSettings: Settings = { ...defaultPreviewSettings };
let previewWatchlist: WatchItem[] = [];
let previewHoldings: HoldingItem[] = [];

const resolveSecurity = (input: Security | string): Security => {
  if (typeof input !== "string") return input;
  return previewSecurities.find((item) => item.code === input) || {
    code: input,
    name: `预览标的 ${input}`,
    secid: input.startsWith("6") ? `1.${input}` : `0.${input}`,
    thscode: `${input}.${input.startsWith("6") ? "SH" : "SZ"}`,
    marketName: input.startsWith("6") ? "沪A" : "深A",
    assetType: "stock"
  };
};

const buildPreviewHistory = (security: Security, length = 260) => {
  const seed = Number(security.code.slice(-3)) || 519;
  const base = 30 + (seed % 120);
  return Array.from({ length }, (_, index) => {
    const drift = index * 0.045;
    const wave = Math.sin((index + seed) / 8) * 2.4 + Math.cos((index + seed) / 17) * 1.3;
    const eventBoost = index === length - 9 ? base * 0.1 : index > length - 9 ? base * 0.1 : 0;
    const close = Math.max(1, base + drift + wave + eventBoost);
    const open = close * (1 + Math.sin(index + seed) * 0.004);
    const high = Math.max(open, close) * 1.012;
    const low = Math.min(open, close) * 0.988;
    const date = new Date(2025, 7, 1 + index);
    return {
      date: date.toISOString().slice(0, 10),
      open: Number(open.toFixed(2)),
      close: Number(close.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      volume: Math.round(28_000 + Math.sin(index / 3) * 6_000 + seed * 10),
      amount: Math.round(close * 3_300_000),
      turnover: Number((1.2 + Math.abs(Math.sin(index / 5)) * 2.8).toFixed(2)),
      changePct: Number((((close / open) - 1) * 100).toFixed(2))
    };
  });
};

const buildPreviewPayload = (input: Security | string) => {
  const security = resolveSecurity(input);
  const history = buildPreviewHistory(security, 260);
  const latestBar = history.at(-1)!;
  const previousBar = history.at(-2)!;
  const limitEvent = history.at(-9)!;
  const latest = latestBar.close;
  const change = latest - previousBar.close;
  const updatedAt = new Date().toISOString();
  const executionReadiness = {
    score: 0,
    level: "block",
    status: "BLOCK",
    summary: "预览数据不能作为真实执行依据",
    recommendation: "请在 Electron 桌面环境中使用真实行情、历史回放和纸面验证。",
    reasons: ["浏览器预览模式没有真实逐笔成交和样本外验证"],
    canExecute: false
  };
  const quote = {
    code: security.code,
    name: security.name,
    latest,
    high: latestBar.high,
    low: latestBar.low,
    open: latestBar.open,
    preClose: previousBar.close,
    change: Number(change.toFixed(2)),
    changePct: Number((change / previousBar.close * 100).toFixed(2)),
    turnover: latestBar.turnover,
    amount: latestBar.amount,
    volume: latestBar.volume,
    volumeUnit: "lots",
    volumeRatio: 0.78,
    amplitude: Number(
      (((latestBar.high - latestBar.low) / previousBar.close) * 100).toFixed(2)
    ),
    industry: security.code === "600519" ? "白酒" : security.code === "300750" ? "新能源电池" : "汽车整车",
    updatedAt
  };
  return {
    security,
    quote,
    history,
    analysis: {
      limitEvent,
      daysSince: 8,
      exactNode: null,
      nextNode: "T+9",
      heldSupport: true,
      supportDistance: 3.2,
      avwap: Number((latest * 0.975).toFixed(2)),
      ma5: Number((latest * 0.992).toFixed(2)),
      ma10: Number((latest * 0.981).toFixed(2)),
      ma20: Number((latest * 0.963).toFixed(2)),
      ma60: Number((latest * 0.92).toFixed(2)),
      maBull: true,
      slopesUp: true,
      divergence: 2.1,
      volumeRatio: 0.78,
      relativeTurnover: 0.86,
      maxDrawdown: 4.1,
      closePosition: 0.73,
      stockReturn3: 2.8,
      rsSector: 1.4,
      structureScore: 82,
      sectorScore: 76,
      infoScore: 68,
      marketScore: 64,
      nodeScore: 66,
      riskPenalty: 0,
      risks: ["预览数据不可用于真实交易"],
      mrs: 76,
      grade: "A",
      trendLabel: "多头排列",
      strategyMatched: 5,
      strategyTotal: 6,
      strategyMatchRate: 83,
      strategyQualified: false,
      alertQualified: false,
      qualification: {
        strategyMatched: false,
        scoreMatched: true,
        nodeMatched: true,
        riskVetoPassed: true,
        historicalEdgePassed: false,
        alertScore: previewSettings.alertScore,
        exactNodesOnly: previewSettings.exactNodesOnly,
        vetoReasons: ["缺少真实样本外验证"]
      },
      strategyResults: [
        { id: "support", label: "涨停低点防守", matched: true, detail: "预览支撑有效" },
        { id: "avwap", label: "锚定均价承接", matched: true, detail: "价格位于锚定均价上方" },
        { id: "trend", label: "均线趋势", matched: true, detail: "均线保持多头排列" },
        { id: "contraction", label: "缩量抗跌", matched: true, detail: "量能处于温和区间" },
        { id: "sector", label: "板块强度", matched: true, detail: "板块相对强度为正" },
        { id: "riskVeto", label: "风险否决", matched: true, detail: "未发现预览风险项" }
      ],
      historicalStats: {
        source: "preview",
        range: `${history[0]?.date || latestBar.date} 至 ${latestBar.date}`,
        totalEvents: 0,
        untradeableCount: 0,
        stats: [],
        nodeStats: []
      },
      historicalEdge: {
        passed: false,
        penalty: 0,
        reasons: ["预览模式不提供真实历史样本"]
      },
      tradePlan: {
        signal: "WAIT",
        positionSizePercent: 0,
        maxPositionPercent: previewSettings.maxPositionPercent,
        stopLossPrice: Number((latest * 0.96).toFixed(2)),
        takeProfitPrice: Number((latest * 1.08).toFixed(2)),
        stopLossDistancePercent: 4,
        takeProfitDistancePercent: 8,
        riskReward: 2,
        killSwitchTriggered: true,
        killReasons: ["预览环境禁止执行"]
      },
      tradeProjection: {
        projection: {
          projectedNetEdge: 0,
          expectancyPoints: 0,
          riskReward: 2,
          expectedReturnPercent: 0,
          probabilityTakeProfit: 0,
          probabilityStopLoss: 0,
          probabilityTimeExit: 100
        }
      },
      tradeExecutionReadiness: executionReadiness,
      executionReadiness
    },
    sector: {
      name: quote.industry,
      score: 76,
      state: "相对强势",
      returns: { r1: 1.2, r3: 3.1, r5: 4.5 },
      benchmarkReturns: { r1: 0.4, r3: 1.2, r5: 1.8 },
      excess: 1.9,
      breadth: 0.68,
      limitUps: 3,
      memberCount: 22,
      amountHeat: 1.22,
      persistence: 0.72,
      history: history.slice(-15)
    },
    dataFederation: {
      status: "预览模式",
      activeCount: 1,
      configuredCount: 1,
      realtimeCount: 0,
      consensusPrice: latest,
      spreadPct: 0,
      updatedAt,
      note: "当前为浏览器预览数据，不代表实时行情。",
      sources: [
        {
          id: "preview",
          name: "本地预览生成器",
          kind: "模拟数据",
          role: "界面预览",
          ok: true,
          realtime: false,
          latest,
          latencyMs: 0,
          updatedAt
        }
      ]
    },
    announcements: [
      {
        id: "preview-announcement-1",
        art_code: "PREVIEW1",
        title: `${security.name}：浏览器预览公告`,
        category: "预览信息",
        display_time: updatedAt,
        publishedAt: updatedAt,
        score: 50,
        direction: "neutral",
        source: "preview",
        sourceUrl: "https://example.invalid/preview"
      }
    ],
    actualProvider: "preview",
    warning: "当前为浏览器预览模式，禁止据此进行真实交易。",
    updatedAt
  };
};

const buildPreviewNews = (input: Record<string, any> = {}) => {
  const now = new Date().toISOString();
  const items = previewSecurities.map((security, index) => {
    const isFlash = index === 1;
    const eventType = isFlash ? "快讯" : index === 0 ? "业绩" : "监管风险";
    const direction = index === 0 ? "positive" : index === 2 ? "negative" : "neutral";
    return {
      id: `preview-news-${security.code}`,
      type: isFlash ? "flash" : "announcement",
      eventType,
      title: isFlash ? `${security.name} 浏览器预览快讯` : `${security.name} 浏览器预览公告`,
      summary: isFlash ? "该内容仅用于检查资讯雷达界面。" : "该内容仅用于检查A股公告模块。",
      direction,
      riskSeverity: index === 2 ? 2 : 0,
      importanceScore: index === 2 ? 86 : 75 - index * 5,
      credibilityScore: index === 0 ? 96 : 76,
      sourceLevel: index === 0 ? "A" : "B",
      freshnessScore: 100,
      ageMinutes: 0,
      impactHorizon: "短期",
      marketConfirmation: "待行情确认",
      marketConfirmed: false,
      firstSeenAt: now,
      publishedAt: now,
      fetchedAt: now,
      source: isFlash ? "预览财经快讯" : "预览公司公告",
      transportProvider: "浏览器预览",
      originAuthority: index === 0 ? "官方披露原文" : "待原始披露平台核验",
      sourceUrl: "https://example.invalid/preview",
      relatedStocks: [security],
      relatedSectors: [],
      status: index === 2 ? "corrected" : "active",
      duplicateCount: 1,
      reasons: ["浏览器预览数据"],
      autoBroadcast: index === 2
    };
  });
  const collectionForScope =
    input.scope === "limitUp" ? input.limitUps :
      input.scope === "watchlist" ? input.watchlist :
        input.scope === "holdings" ? input.holdings : null;
  const filtered = items.filter((item) => {
    if (input.contentType && input.contentType !== "all" && item.type !== input.contentType) return false;
    if (Array.isArray(collectionForScope)) {
      const codes = new Set(collectionForScope.map((entry: any) => String(entry?.code || "")));
      if (!item.relatedStocks.some((stock) => codes.has(stock.code))) return false;
    }
    if (input.scope === "stock") {
      const code = String(input.currentStock?.code || "");
      if (!code || !item.relatedStocks.some((stock) => stock.code === code)) return false;
    }
    return true;
  });
  return {
    source: "preview",
    updatedAt: now,
    mode: "浏览器预览",
    collectionPolicy: "预览数据不会连接真实公告源",
    refreshAfterSeconds: 30,
    total: filtered.length,
    unfilteredTotal: items.length,
    sourceStatus: [
      { id: "fast", name: "预览财经快讯", ok: true, level: "B", message: "1条", pollSeconds: 30 },
      { id: "cls", name: "预览电报", ok: true, level: "B", message: "0条", pollSeconds: 30 },
      { id: "announcement", name: "预览公司公告", ok: true, level: "B", message: "2条", pollSeconds: 30 },
      { id: "ths", name: "预览官方公告", ok: true, level: "A", message: "1条", pollSeconds: 30 }
    ],
    items: filtered
  };
};

const buildPreviewProfessionalReview = () => {
  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);
  return {
    generatedAt,
    date,
    session: "预览复盘",
    score: 55,
    regime: {
      name: "预览演示",
      tone: "neutral",
      posture: "仅用于检查复盘布局；桌面版会读取真实市场、涨停生态与指数历史。"
    },
    exposure: { min: 0, max: 0, label: "预览环境不输出仓位建议" },
    dimensions: {
      trend: 58,
      breadth: 52,
      emotion: 55,
      ecology: 50,
      leadership: 57,
      confirmation: 53,
      liquidity: 51,
      diffusion: 54
    },
    market: {
      available: true,
      stockCount: 5300,
      upCount: 2700,
      downCount: 2400,
      flatCount: 200,
      breadth: 2700 / 5300,
      averageReturn: 0.18
    },
    ecology: {
      limitUpCount: 46,
      limitDownCount: 8,
      failedBoards: 17,
      promotionRate: 0.34,
      maxHeight: 3,
      firstBoards: 38,
      continuationBoards: 8
    },
    evidence: [
      "浏览器预览仅验证八维市场状态卡片与证据链布局。",
      "桌面版将使用真实涨停、跌停、炸板、指数与全市场广度数据。",
      "预览数值不进入策略信号、仓位或执行判断。"
    ],
    riskSignals: [
      "当前是浏览器预览数据，不代表真实市场状态。",
      "真实复盘需要桌面版行情源完成后再作判断。"
    ],
    indices: [
      { name: "中证全指", code: "000985", date, returns: { r1: 0.2, r3: 0.6, r5: 1.1 }, trend: "震荡", ma5: 6120, ma20: 6088, volumeRatio: 0.96, score: 58 },
      { name: "上证指数", code: "000001", date, returns: { r1: 0.1, r3: 0.4, r5: 0.7 }, trend: "震荡", ma5: 3560, ma20: 3542, volumeRatio: 0.92, score: 55 },
      { name: "深证成指", code: "399001", date, returns: { r1: 0.3, r3: 0.8, r5: 1.4 }, trend: "偏强", ma5: 11120, ma20: 10980, volumeRatio: 1.03, score: 62 }
    ],
    focusSectors: [
      { reviewRank: 1, name: "新能源", state: "预览演示", verdict: "观察", poolLimitUps: 8, returns: { r1: 1.2, r3: 2.6, r5: 3.8 }, breadth: 0.68, amountHeat: 1.18, score: 76 },
      { reviewRank: 2, name: "汽车整车", state: "预览演示", verdict: "观察", poolLimitUps: 5, returns: { r1: 0.8, r3: 1.9, r5: 2.7 }, breadth: 0.61, amountHeat: 1.08, score: 70 }
    ],
    leaders: previewSecurities.map((security, index) => ({
      ...security,
      industry: index === 0 ? "白酒" : index === 1 ? "新能源电池" : "汽车整车",
      consecutiveBoards: index === 1 ? 2 : 1,
      reason: "点击检查详细个股复盘"
    })),
    scenarios: [
      {
        id: "attack",
        name: "进攻情景",
        tone: "positive",
        conditions: ["指数与广度同步增强", "主线板块继续扩散", "高位股分歧后回封"],
        action: "只复核主线核心的确认信号。",
        invalidation: "广度转弱或核心跌破关键支撑"
      },
      {
        id: "base",
        name: "基准情景",
        tone: "neutral",
        conditions: ["指数维持震荡", "板块快速轮动", "涨停晋级率中性"],
        action: "降低频率，等待个股结构确认。",
        invalidation: "市场进入一致性单边状态"
      },
      {
        id: "defense",
        name: "防守情景",
        tone: "risk",
        conditions: ["下跌家数明显增加", "炸板率快速上升", "主线核心失去承接"],
        action: "以防守和复核风险为主。",
        invalidation: "指数、广度与核心股同步修复"
      }
    ],
    nextPlan: {
      focus: ["复核指数、广度与主线是否同向"],
      observe: ["观察涨停晋级率和炸板率变化"],
      avoid: ["不依据浏览器预览数值作交易判断"]
    },
    sources: ["浏览器预览生成器"],
    methodology: {
      name: "八维市场状态模型（预览）",
      description: "趋势、广度、情绪、涨停生态、主线、确认、成交参与与扩散",
      note: "本页只验证界面；桌面版真实数据结果不构成投资建议。"
    }
  };
};

// 浏览器预览不连扶摇：一份标明“演示”的同结构数据，便于检查涨停生态版面。
function buildPreviewLimitEcology(): any {
      const demo = (code: string, name: string) => ({ code, name, thscode: `${code}.${/^6/.test(code) ? "SH" : "SZ"}` });
      return {
        available: true, source: "演示数据（浏览器预览不连接同花顺扶摇）", fetchedAt: new Date().toISOString(), sealRate: 0.68,
        limitUp: { count: 52, maxBoards: 5, boardCounts: [{ level: 1, label: "首板", count: 38 }, { level: 2, label: "2板", count: 8 }, { level: 3, label: "3板", count: 4 }, { level: 4, label: "4板", count: 1 }, { level: 5, label: "5板以上", count: 1 }],
          reasons: [{ reason: "演示题材A", count: 9, stocks: [{ ...demo("600001", "演示一"), boards: 2 }] }, { reason: "演示题材B", count: 6, stocks: [{ ...demo("000002", "演示二"), boards: 1 }] }],
          leaders: [{ ...demo("600003", "演示三"), boards: 5, boardsText: "5连板", reason: "演示题材A", sealMoney: 3.2e8, limitUpTime: "09:31" }, { ...demo("000004", "演示四"), boards: 3, boardsText: "3连板", reason: "演示题材B", sealMoney: 1.1e8, limitUpTime: "10:02" }] },
        limitBreak: { count: 24, top: [] }, limitDown: { count: 6, top: [] },
        ladder: { days: [{ date: "2026-10-22", tiers: [{ level: 5, label: "5板", stocks: [{ ...demo("600003", "演示三"), boards: 5, nextDay: null }] }, { level: 3, label: "3板", stocks: [{ ...demo("000004", "演示四"), boards: 3, nextDay: null }] }] }] },
        hot: [1, 2, 3, 4, 5, 6].map((rank) => ({ ...demo(`60000${rank}`, `热股${rank}`), rank, heat: 100 - rank, rankChange: rank % 2 ? 3 : -2 })),
        hotLists: Object.fromEntries((["hour", "day"] as const).map((period) => [period, Object.fromEntries((["hot", "skyrocket"] as const).map((kind) => [kind,
          [1, 2, 3, 4, 5, 6].map((rank) => ({ ...demo(`60000${rank}`, `${period === "hour" ? "1小时" : "24小时"}${kind === "hot" ? "热股" : "飙升"}${rank}`), rank,
            heat: (100 - rank) * 1e4, heatText: `${100 - rank}.0万`, rankChange: rank % 2 ? 3 : -2, latest: 10 + rank, changePct: rank % 2 ? 3.2 : -1.1 }))]))])),
        skyrocket: [{ ...demo("000007", "飙升一"), rank: 1, heat: 90, rankChange: 120 }],
        dragonTiger: { date: "2026-10-22", count: 58, topNet: [{ ...demo("600008", "龙虎一"), changePct: 10.01, net: 2.3e8, orgNet: 1.1e8, hotMoneyNet: 0.6e8, reason: "日涨幅偏离值达7%" }], desks: [{ name: "演示营业部", buying: 1e8, stocks: [{ ...demo("600008", "龙虎一"), net: 0.5e8 }] }] },
        anomalies: [{ ...demo("600003", "演示三"), tag: "涨停", content: "演示：公司公告与题材共振，早盘快速封板。", keywords: ["演示题材A", "公告"] }],
        warnings: []
      };
}

export function createPreviewApi(): Window["stockApi"] {
  let trendState = createTrendPreviewStatus();
  return {
    async search(query) {
      const keyword = String(query || "").trim().toLowerCase();
      return previewSecurities.filter(
        (item) => item.code.includes(keyword) || item.name.toLowerCase().includes(keyword)
      );
    },
    async analyze(security, _options = {}) {
      return buildPreviewPayload(security);
    },
    async getQuoteSnapshot(security) {
      const payload = buildPreviewPayload(security);
      return {
        security: payload.security,
        quote: payload.quote,
        updatedAt: payload.updatedAt,
        provider: "preview"
      };
    },
    async getDataFederation(security) {
      return buildPreviewPayload(security).dataFederation;
    },
    async getMarketSourceHealth() {
      const checkedAt = new Date().toISOString();
      const entry = (id: string, name: string, kind: string): MarketSourceHealthEntry => ({
        id, name, kind, status: "ok", consecutiveFailures: 0, retryAt: null, lastOkAt: checkedAt, lastFailAt: null,
        lastError: "", lastLatencyMs: 120, successCount: 1, failureCount: 0
      });
      return {
        checkedAt,
        quotes: [entry("ths_free", "同花顺免费行情", "预览数据"), entry("eastmoney", "东方财富行情", "预览数据"), entry("tencent", "腾讯行情", "预览数据")],
        history: [entry("eastmoney_history", "东方财富日线", "预览数据"), entry("ths_free_history", "同花顺免费日线", "预览数据"), entry("tencent_history", "腾讯日线", "预览数据")]
      };
    },
    async getChart(security, interval, options = {}) {
      const requestedLimit = Number(options.limit);
      const visibleLimit = Number.isFinite(requestedLimit)
        ? Math.max(20, Math.min(3000, Math.round(requestedLimit)))
        : 260;
      const resolved = resolveSecurity(security);
      const rows = String(interval) === "1" || String(interval) === "time" ? buildPreviewMinutes(resolved) : buildPreviewHistory(resolved, visibleLimit);
      const adjustment =
        options.adjustment === "none" || Number(options.adjustment) === 0
          ? "不复权"
          : options.adjustment === "back" || Number(options.adjustment) === 2
            ? "后复权"
            : "前复权";
      return {
        rows,
        interval: String(interval),
        range: options.range || "",
        visibleLimit,
        source: "浏览器预览数据",
        sourceClass: "preview",
        dataSource: "preview",
        adjustment,
        updatedAt: new Date().toISOString(),
        availableFrom: rows[0]?.date || "",
        availableTo: rows.at(-1)?.date || "",
        isPartial: false,
        note: "预览 K 线只用于界面检查，不代表真实行情。"
      };
    },
    async discoverLimitUps(_options = {}) {
      const rows = previewSecurities.map((security, index) => ({
        ...security,
        latest: 30 + index * 45,
        changePct: security.code.startsWith("3") ? 20 : 10,
        turnover: 3.6 + index,
        amount: 1_800_000_000 + index * 500_000_000,
        industry: index === 0 ? "白酒" : index === 1 ? "新能源电池" : "汽车整车",
        isLimitUp: true
      }));
      return {
        rows,
        meta: {
          dataDate: previewShanghaiDate(),
          fetchedAt: new Date().toISOString(),
          providers: ["preview"]
        }
      };
    },
    async getLimitUpPoolSnapshot(options = {}) {
      return this.discoverLimitUps(options);
    },
    async getPreviousLimitUpFailedBoardSnapshot(_options = {}) {
      const dates = previewTradingDates(5);
      const currentDate = dates[0] || previewShanghaiDate();
      const previousDate = dates[1] || currentDate;
      const fetchedAt = new Date().toISOString();
      const source = (requestedDate: string) => ({
        providers: ["preview"],
        requestedDate,
        sourceTradingDate: requestedDate,
        sourceLatestDate: currentDate,
        fetchedAt
      });
      const failedBoardDays: FailedBoardDaySnapshot[] = dates.map((date, index) => ({
        date,
        status: "ready",
        source: {
          providers: ["preview"],
          requestedDate: date,
          sourceLatestDate: currentDate,
          fetchedAt
        },
        error: null,
        rows: [{
          code: ["600001", "000002", "300750", "688008", "430047"][index] || "600001",
          name: `炸板演示 ${date}（虚构）`,
          industry: ["示例行业", "示例制造", "示例科技", "示例医药", "示例材料"][index] || "示例行业",
          consecutiveBoards: index % 3 + 1,
          firstSealTime: "09:38:12",
          lastSealTime: "13:42:06",
          openBoardCount: index + 1,
          latest: 10 + index * 2.5,
          changePct: -1.6 + index * 1.1,
          amount: 260_000_000 + index * 90_000_000,
          turnover: 2.1 + index * 0.45
        }]
      }));
      return {
        status: "ready" as const,
        previousDate,
        currentDate,
        failedBoardDays,
        rows: [
          {
            code: "600001",
            name: "示例甲（虚构）",
            industry: "示例行业",
            previous: {
              consecutiveBoards: 1,
              firstSealTime: "09:25:00",
              lastSealTime: "09:25:00",
              openBoardCount: 0,
              boardType: "一字板",
              isOneWordBoard: true
            },
            today: {
              latest: 168.35,
              changePct: 4.12,
              amount: 3_050_000_000,
              turnover: 2.33,
              firstSealTime: "09:34:12",
              lastSealTime: "14:52:18",
              openBoardCount: 2
            }
          },
          {
            code: "000002",
            name: "示例乙（虚构）",
            industry: "示例行业",
            previous: {
              consecutiveBoards: 2,
              firstSealTime: "10:06:31",
              lastSealTime: "10:18:42",
              openBoardCount: 1,
              boardType: "换手板",
              isOneWordBoard: false
            },
            today: {
              latest: 236.8,
              changePct: 5.76,
              amount: 5_240_000_000,
              turnover: 3.18,
              firstSealTime: "13:48:05",
              lastSealTime: "14:31:22",
              openBoardCount: 3
            }
          }
        ],
        sources: {
          previousLimitUp: source(previousDate),
          todayFailed: source(currentDate)
        },
        errors: { previousLimitUp: null, todayFailed: null },
        checkedAt: fetchedAt,
        isPreview: true,
        previewLabel: "浏览器预览 · 模拟行情"
      };
    },
    async discoverRecentLimitUps(days = 10, _options = {}) {
      const { rows } = await this.discoverLimitUps();
      return rows.map((item, index) => ({
        ...item,
        limitDate: new Date(Date.now() - Math.min(days - 1, index) * 86_400_000)
          .toISOString()
          .slice(0, 10),
        tradingDaysSince: index
      }));
    },
    async getLimitUpSectorBoard() {
      const constituents = previewSecurities.map((security, index) => ({
        ...security,
        latest: 30 + index * 45,
        changePct: 3.2 - index * 1.1,
        turnover: 3.6 + index,
        amount: 1_800_000_000 + index * 500_000_000,
        mainNetInflow: 120_000_000 - index * 35_000_000,
        isLimitUp: index === 0
      }));
      return [
        { name: "新能源", score: 82, limitUps: 8, memberCount: 42, state: "强势扩散", returns: { r1: 2.1, r3: 4.6, r5: 6.2 }, benchmarkReturns: { r1: 0.4, r3: 1.1, r5: 1.8 }, allMarketReturns: { r1: 0.3, r3: 0.9, r5: 1.5 }, breadth: 0.72, memberAverageReturn: 2.4, relativeReturn: 2.1, amountHeat: 1.36, persistence: 0.8, memberAverageTurnover: 4.6, leadershipQualityScore: 81, advancingAmountShare: 0.78, positiveInflowRatio: 0.67, top5AmountShare: 0.34, medianMemberReturn: 1.86, returnDispersion: 1.42, dataCoveragePercent: 96, constituents },
        { name: "汽车整车", score: 76, limitUps: 5, memberCount: 24, state: "震荡增强", returns: { r1: 1.4, r3: 3.1, r5: 4.5 }, benchmarkReturns: { r1: 0.4, r3: 1.1, r5: 1.8 }, allMarketReturns: { r1: 0.3, r3: 0.9, r5: 1.5 }, breadth: 0.64, memberAverageReturn: 1.5, relativeReturn: 1.2, amountHeat: 1.18, persistence: 0.6, memberAverageTurnover: 4.1, leadershipQualityScore: 73, advancingAmountShare: 0.68, positiveInflowRatio: 0.58, top5AmountShare: 0.43, medianMemberReturn: 1.12, returnDispersion: 1.76, dataCoveragePercent: 94, constituents },
        { name: "大消费", score: 68, limitUps: 3, memberCount: 31, state: "温和修复", returns: { r1: 0.8, r3: 1.9, r5: 2.7 }, benchmarkReturns: { r1: 0.4, r3: 1.1, r5: 1.8 }, allMarketReturns: { r1: 0.3, r3: 0.9, r5: 1.5 }, breadth: 0.57, memberAverageReturn: 0.9, relativeReturn: 0.6, amountHeat: 1.04, persistence: 0.6, memberAverageTurnover: 3.5, leadershipQualityScore: 65, advancingAmountShare: 0.59, positiveInflowRatio: 0.52, top5AmountShare: 0.48, medianMemberReturn: 0.62, returnDispersion: 2.08, dataCoveragePercent: 91, constituents }
      ];
    },
    async getSectorStrengthBoard() {
      const industries = await this.getLimitUpSectorBoard();
      const concept = (name: string, changePct: number, netInflow: number, stocks: string[], index: number): SectorConceptRow => ({ kind: "concept", id: `ths:concept:30${index}`, code: `30${index}`, conceptCid: `30${index}`, indexCode: `8850${index}`,
        name, changePct, netInflow, memberCount: null, leaderName: "", limitUps: stocks.length, limitUpStocks: stocks.map((stockName, stockIndex) => ({ code: `60000${stockIndex}`, name: stockName, boards: 1 })) });
      return {
        fetchedAt: new Date().toISOString(),
        industries,
        concepts: [concept("固态电池", 3.1, 8.2e8, ["演示甲", "演示乙", "演示丙"], 1), concept("机器人概念", 1.8, 2.4e8, ["演示丁"], 2), concept("演示概念", -0.6, -1.1e8, [], 3)],
        themes: [{ reason: "固态电池", count: 3, stocks: [{ code: "600000", name: "演示甲", boards: 2 }, { code: "600001", name: "演示乙", boards: 1 }], concept: { name: "固态电池", code: "301", conceptCid: "301" } },
          { reason: "业绩增长", count: 2, stocks: [{ code: "600002", name: "演示丙", boards: 1 }] }],
        limitUpTotal: 48, conceptLimitUpSource: "演示数据", warnings: ["浏览器预览为演示数据。"]
      };
    },
    async searchSectors(query) {
      const keyword = String(query || "").trim();
      const rows = await this.getLimitUpSectorBoard();
      return rows.filter((item) => !keyword || item.name.includes(keyword));
    },
    async getConceptChain(query) {
      const name = typeof query === "string"
        ? query
        : String(query?.name || query?.query || "预览概念");
      return {
        name,
        query: name,
        source: "DEMO 虚构产业链演示",
        thsStatus: "预览演示",
        message: "以下为虚构细分结构，用于演示交互；请在桌面版核对真实成分。",
        stockCount: 12,
        groups: ["上游", "中游", "下游"].map((role, index) => ({ name: role, segments: [{ name: `${name}${role}`, role, description: "虚构演示细分", stockCount: 3 + index, overlapRatio: (3 + index) / 12, thsQuery: `${name}${role}` }] }))
      };
    },
    async getSectorCatalog() {
      return { status: "unavailable" as const, entries: [], fetchedAt: new Date().toISOString(), asOf: null,
        sources: [], warnings: ["浏览器预览不连接同花顺分类数据，请在桌面版读取真实目录。"],
        coverage: { loaded: 0, declared: null, excluded: 0, invalid: 0, pagesLoaded: 0, pagesTotal: null, complete: false, scope: "预览目录未连接" } };
    },
    async getSectorClassifications() { throw new Error("浏览器预览没有真实行业分类，请使用桌面版。"); },
    async getSectorDetail() { throw new Error("浏览器预览没有真实板块成分，请使用桌面版。"); },
    async cancelSectorRequest() { return { cancelled: false }; },
    async getLimitEcology() {
      return buildPreviewLimitEcology();
    },
    async getConvertibleBonds() {
      const names: [string, string, string][] = [["113052", "演示转债A", "600001"], ["123288", "演示转债B", "300101"], ["127117", "演示转债C", "002913"], ["118077", "演示转债D", "688150"], ["128136", "演示转债E", "002001"]];
      const members = names.map(([code, name, stockCode], index) => {
        const sh = code.startsWith("11");
        const latest = 108 + index * 9.7;
        return { code, name, market: (sh ? 19 : 35) as 19 | 35, stockCode, stockName: `演示正股${index + 1}`, listingDate: "2024-01-02", expireDate: `203${index}-06-30`,
          source: "discovered" as const, latest, preClose: latest / (1 + (index - 2) * 0.006), changePct: Number(((index - 2) * 0.6).toFixed(2)), amount: (index + 1) * 1.2e8,
          volume: (index + 1) * 1e6, turnover: 2 + index, amplitude: 1.1, high: latest * 1.01, low: latest * 0.99, quoteAt: new Date().toISOString(), quoteStatus: "ready" as const,
          remainingYears: 3 + index, secid: `${sh ? 1 : 0}.${code}`, thscode: `${code}.${sh ? "SH" : "SZ"}` };
      });
      return { source: "DEMO 虚构可转债，仅演示界面", fetchedAt: new Date().toISOString(), asOf: new Date().toISOString().slice(0, 10), members,
        upcoming: [{ code: "127120", name: "演示新券", stockCode: "002550", stockName: "演示正股", listingDate: "", expireDate: "2032-10-27" }],
        summary: { count: 5, quoted: 5, rising: 2, falling: 2, flat: 1, medianChangePct: 0, amount: 1.8e9 },
        quoteCoverage: { loaded: 5, total: 5, pending: false, complete: true },
        roster: { discoveredAt: new Date().toISOString(), feedCount: 0, discoveredCount: 5, discovering: null },
        warnings: ["浏览器预览不连接同花顺，以下为虚构数据。"] };
    },
    async getSectorQuotes() {
      return { status: "unavailable" as const, fetchedAt: new Date().toISOString(), quotes: {}, sources: [],
        warnings: ["浏览器预览不连接同花顺板块行情。"] };
    },
    async analyzeSector(sector) {
      if (sector?.code === "THS:BJ" || sector?.name === "北交所") {
        return { name: "北交所", code: "THS:BJ", boardType: "exchange", source: "preview", members: [], constituents: [],
          memberCount: null, memberCoverage: { loaded: 0, total: null, complete: false },
          warning: "浏览器预览不连接真实北交所行情，请在桌面版读取同花顺数据。", returns: { r1: null, r3: null, r5: null } };
      }
      return {
        ...(sector || {}),
        source: "preview",
        score: Number(sector?.score || 72),
        members: previewSecurities,
        history: buildPreviewHistory(previewSecurities[0] || resolveSecurity("600519"), 90)
      };
    },
    async getProfessionalReview() {
      const review: any = buildPreviewProfessionalReview();
      review.fuyao = buildPreviewLimitEcology();
      return review;
    },
    async getNewsFeed(input = {}) {
      return buildPreviewNews(input);
    },
    async refreshNewsFeed(input = {}) {
      return buildPreviewNews(input);
    },
    async getStrategyDefinitions() {
      return previewVerifiedStrategies.map((item) => ({ ...item }));
    },
    async listCustomStrategies() { return structuredClone(previewCustomStrategies); },
    async saveCustomStrategy(strategy: CustomStrategy) { return savePreviewCustom(strategy); },
    async deleteCustomStrategy(id: string) {
      if (!previewCustomStrategies.some(item => item.id === id)) throw new Error("策略不存在或已删除");
      previewCustomStrategies = previewCustomStrategies.filter(item => item.id !== id);
      return { strategies: structuredClone(previewCustomStrategies) };
    },
    async importSettingsStrategy() {
      return savePreviewCustom({ ...structuredClone(previewCustomStrategies[0] || {} as CustomStrategy), id: null, name: `设置导入${previewCustomSequence + 1}`, origin: "legacy-settings" });
    },
    async cancelServiceJob(_requestId) { return false; },
    async runBacktest(security, options = {}) {
      const resolved = resolveSecurity(security);
      const settings = { ...previewSettings, ...(options.settings || {}) };
      const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.startDate || ""))
        ? String(options.startDate).slice(0, 10)
        : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      const signalTo = new Date().toISOString().slice(0, 10);
      const minimumSamples = Math.max(18, Number(options.minSamples) || 18);
      const signalStrategyIds = Array.isArray(options.signalStrategyIds)
        ? [...new Set(options.signalStrategyIds.map(String).filter(Boolean))]
        : [];
      const strategyIds = signalStrategyIds.length
        ? signalStrategyIds
        : [...new Set([...(settings.selectedStrategies || []), "riskVeto"])];
      const strategyContext = signalStrategyIds.length
        ? {
          ...(options.strategyContext || {}),
          strategyEngine: "verified-signal-v2",
          strategyIds: signalStrategyIds,
          componentNames: signalStrategyIds
        }
        : undefined;
      const walkForwardValidation = {
        available: false,
        accepted: false,
        sampleCount: 0,
        minimumSamples,
        folds: [],
        foldPassRate: 0,
        positiveFoldRate: 0,
        oosSampleCount: 0,
        oosWinRate5: 0,
        oosExpectancy5: 0,
        oosProjectedNetEdge: 0,
        oosWorstMdd5: 0,
        degradationPercent: 100,
        overfitRisk: "insufficient",
        reason: "预览模式没有真实逐事件样本，样本外验证不可用"
      };
      const executionReadiness = {
        score: 0,
        level: "block",
        status: "BLOCK",
        summary: "预览回测禁止进入执行",
        recommendation: "请使用桌面版真实历史数据完成滚动样本外验证。",
        reasons: [walkForwardValidation.reason],
        canRunLive: false,
        canExecute: false
      };
      return {
        security: resolved,
        generatedAt: new Date().toISOString(),
        lookbackBars: 120,
        entryPriceMode: Number(options.customEntryPrice) > 0
          ? "custom_limit_price"
          : "next_market_open",
        customEntryPrice: Number(options.customEntryPrice) > 0
          ? Number(options.customEntryPrice)
          : null,
        range: {
          requestedFrom: startDate,
          signalFrom: startDate,
          signalTo,
          historyFrom: startDate,
          historyTo: signalTo,
          historyBars: 120
        },
        ...(strategyContext
          ? {
            backtestMode: "verified_signal_strategy",
            strategyEngine: "verified-signal-v2",
            strategyMode: signalStrategyIds.length > 1
              ? "multi_strategy_vote"
              : "single_verified_strategy",
            minimumVotes: Number(strategyContext.minimumVotes) || 1,
            strategyContext
          }
          : {}),
        strategyIds,
        strategyProfile: {
          riskProfile: settings.riskProfile,
          selectedStrategies: strategyIds,
          minProjectedNetEdgePercent: settings.minProjectedNetEdgePercent,
          minExpectancyPoints: settings.minExpectancyPoints,
          minTurnoverPercent: settings.minTurnoverPercent,
          minQuoteAmount: settings.minQuoteAmount,
          maxQuoteAgeSeconds: settings.maxQuoteAgeSeconds,
          commissionBps: settings.commissionBps,
          slippageBps: settings.slippageBps,
          maxPositionPercent: settings.maxPositionPercent,
          maxRiskPerTradePercent: settings.maxRiskPerTradePercent,
          stopLossATRMultiple: settings.stopLossATRMultiple,
          takeProfitATRMultiple: settings.takeProfitATRMultiple,
          maxHoldingBars: settings.maxHoldingBars,
          maxOpenPositions: settings.maxOpenPositions,
          maxDailyRiskPercent: settings.maxDailyRiskPercent,
          maxPortfolioRiskPercent: settings.maxPortfolioRiskPercent,
          maxSectorExposurePercent: settings.maxSectorExposurePercent,
          minExecutionRatePercent: settings.minExecutionRatePercent,
          trailingStopPercent: settings.trailingStopPercent,
          lossStepPercent: settings.lossStreakStepPercent,
          lossFloorPercent: settings.lossStreakFloorPercent,
          maxConsecutiveLossesForStop: settings.maxConsecutiveLossesForStop,
          timeDecayPerBarPercent: settings.timeDecayPerBarPercent
        },
        metrics: {
          totalSignals: 0,
          replayableSignals: 0,
          untradeableSignals: 0,
          winRate5: 0,
          averageR5: 0,
          medianR5: 0,
          expectancy5: 0,
          projectedNetEdge: 0,
          worstMdd5: 0,
          avgExcess5: 0,
          walkForwardAvailable: false,
          walkForwardAccepted: false,
          walkForwardPassRate: 0,
          oosSampleCount: 0,
          oosWinRate5: 0,
          oosExpectancy5: 0,
          oosProjectedNetEdge: 0,
          oosWorstMdd5: 0,
          overfitRisk: "insufficient",
          degradationPercent: 100,
          tradeCount: 0,
          profitableTrades: 0,
          losingTrades: 0,
          totalNetReturnPercent: 0,
          totalProfitAmount: 0,
          winRatePercent: 0,
          accountMaxDrawdownPercent: 0,
          accepted: false,
          passReason: walkForwardValidation.reason,
          source: "preview"
        },
        nodeStats: [],
        benchmarkReturns: { r1: 0, r3: 0, r5: 0, spanBars: 0 },
        trades: [],
        profitSummary: {
          startingCapital: 200000,
          endingCapital: 200000,
          totalProfitAmount: 0,
          totalNetReturnPercent: 0,
          positionPercent: Number(settings.maxPositionPercent || 100),
          roundTripCostPercent: Number(((Number(settings.commissionBps || 0) + Number(settings.slippageBps || 0)) * 2 / 100).toFixed(4)),
          tradeCount: 0,
          profitableTrades: 0,
          losingTrades: 0,
          flatTrades: 0,
          winRatePercent: 0,
          maxDrawdownPercent: 0,
          skippedOverlaps: 0
        },
        historicalSamplePath: {
          startingCapital: 200000,
          endingCapital: 200000,
          positionPercent: 0,
          roundTripCostPercent: 0,
          skippedOverlaps: 0,
          points: []
        },
        walkForwardValidation,
        tradeExecutionReadiness: executionReadiness,
        executionReadiness,
        rawStats: { source: "preview", strategyIds }
      };
    },
    async runPortfolioBacktest(input) {
      const securities = (Array.isArray(input.securities) ? input.securities : [])
        .map((item) => resolveSecurity(item))
        .filter((item, index, rows) => rows.findIndex((row) => row.code === item.code) === index);
      const requestedStrategyIds = [...new Set(
        (Array.isArray(input.strategyIds) ? input.strategyIds : [])
          .map(String)
          .filter(Boolean)
      )];
      const strategyIds = requestedStrategyIds.length
        ? requestedStrategyIds
        : [previewVerifiedStrategies[0]?.id || "low_first_board"];
      const startingCapital = Math.max(10_000, Number(input.startingCapital) || 200_000);
      const minimumVotes = Math.max(
        1,
        Math.min(strategyIds.length || 1, Math.round(Number(input.minimumVotes) || 1))
      );
      const maxPositions = Math.max(
        1,
        Math.min(10, Math.round(Number(input.maxPositions) || 3))
      );
      const pointCount = 64;
      const equityCurve = Array.from({ length: pointCount }, (_, index) => {
        const date = new Date(2026, 4, 5 + index);
        const progress = index / Math.max(1, pointCount - 1);
        const returnPercent = progress * 8.4 + Math.sin(index / 5) * 1.7;
        const equity = startingCapital * (1 + returnPercent / 100);
        return {
          date: date.toISOString().slice(0, 10),
          equity: Number(equity.toFixed(2)),
          cash: Number((equity * 0.34).toFixed(2)),
          openPositions: Math.min(maxPositions, index % (maxPositions + 1)),
          returnPercent: Number(returnPercent.toFixed(3)),
          drawdownPercent: Number((-Math.max(0, Math.sin(index / 7) * 1.9)).toFixed(3))
        };
      });
      const endingCapital = equityCurve.at(-1)?.equity || startingCapital;
      const totalReturnPercent = (endingCapital / startingCapital - 1) * 100;
      const contributions = securities.map((security, index) => ({
        code: security.code,
        name: security.name,
        tradeCount: 3 + index,
        winCount: 2 + Math.floor(index / 2),
        winRate: Number(((2 + Math.floor(index / 2)) / (3 + index) * 100).toFixed(2)),
        netPnl: Number((startingCapital * (0.018 + index * 0.006)).toFixed(2)),
        contributionPercent: Number((1.8 + index * 0.6).toFixed(2)),
        averageReturn: Number((1.2 + index * 0.25).toFixed(2))
      }));
      const trades = securities.flatMap((security, index) => [0, 1].map((roundIndex) => ({
        id: `${security.code}-${roundIndex}`,
        code: security.code,
        name: security.name,
        signalDate: `2026-0${5 + roundIndex}-0${6 + index}`,
        entryDate: `2026-0${5 + roundIndex}-0${7 + index}`,
        exitDate: `2026-0${5 + roundIndex}-1${2 + index}`,
        entryPrice: Number((28 + index * 17 + roundIndex).toFixed(2)),
        exitPrice: Number((28.8 + index * 17 + roundIndex).toFixed(2)),
        netReturn: Number((2.1 - index * 0.4 + roundIndex * 0.3).toFixed(2)),
        netPnl: Number((1260 - index * 180 + roundIndex * 90).toFixed(2)),
        allocation: Number((startingCapital / maxPositions).toFixed(2)),
        shares: Math.max(100, Math.floor((startingCapital / maxPositions) / (28 + index * 17 + roundIndex) / 100) * 100),
        strategyIds: strategyIds.slice(0, Math.max(1, minimumVotes))
      })));
      const strategyNameById = new Map(previewVerifiedStrategies.map((item) => [item.id, item.name]));
      const filledSignalEvents = trades.map((trade) => ({
        sampleId: `preview-signal-${trade.id}`,
        code: trade.code,
        name: trade.name,
        strategyId: trade.strategyIds[0] || strategyIds[0]!,
        strategyIds: trade.strategyIds,
        strategyNames: trade.strategyIds.map((id) => strategyNameById.get(id) || id),
        signalDate: trade.signalDate,
        entryDate: trade.entryDate,
        exitDate: trade.exitDate,
        status: "filled",
        reason: "filled_next_market_open",
        reasonText: "信号次一交易日开盘按共享账户规则成交",
        allocation: trade.allocation,
        shares: trade.shares,
        pnl: trade.netPnl,
        netReturnPercent: trade.netReturn
      }));
      const rejectedSignalEvents = securities.slice(0, Math.min(2, securities.length)).map((security, index) => {
        const matchedIds = strategyIds.slice(0, Math.max(1, minimumVotes));
        return {
          sampleId: `preview-rejected-${security.code}-${index}`,
          code: security.code,
          name: security.name,
          strategyId: matchedIds[0] || strategyIds[0]!,
          strategyIds: matchedIds,
          strategyNames: matchedIds.map((id) => strategyNameById.get(id) || id),
          signalDate: index === 0 ? "2026-06-18" : "2026-05-22",
          entryDate: index === 0 ? "2026-06-19" : "2026-05-25",
          status: "rejected",
          reason: index === 0 ? "max_positions_reached" : "insufficient_cash_for_board_lot",
          reasonText: index === 0 ? "当日最大持仓数已满" : "可用现金不足以买入一手"
        };
      });
      const pendingSignalEvents = securities.slice(0, 1).map((security) => {
        const matchedIds = strategyIds.slice(0, Math.max(1, minimumVotes));
        return {
          sampleId: `preview-pending-${security.code}`,
          code: security.code,
          name: security.name,
          strategyId: matchedIds[0] || strategyIds[0]!,
          strategyIds: matchedIds,
          strategyNames: matchedIds.map((id) => strategyNameById.get(id) || id),
          signalDate: "2026-07-31",
          entryDate: "2026-08-01",
          exitDate: "",
          status: "pending",
          reason: "pending_exit_horizon",
          reasonText: "信号已命中，但尚未走完5个交易日持有期，暂不计入收益"
        };
      });
      const signalEvents = [...filledSignalEvents, ...rejectedSignalEvents, ...pendingSignalEvents]
        .sort((left, right) => right.signalDate.localeCompare(left.signalDate) || left.code.localeCompare(right.code));
      const signalTimeline = [...new Set(signalEvents.map((event) => event.signalDate))]
        .map((signalDate) => ({
          signalDate,
          events: signalEvents.filter((event) => event.signalDate === signalDate)
        }));
      const benchmarkReturnPercent = 3.1;
      return {
        source: "preview portfolio backtest",
        generatedAt: new Date().toISOString(),
        backtestMode: "verified_strategy_portfolio",
        strategyEngine: "verified-signal-v2",
        lookbackBars: 120,
        universe: {
          selectionMode: input.universeSource === "strategy_current_matches"
            ? "strategy_current_matches"
            : "manual_current_basket",
          selectionLabel: input.universeSource === "strategy_current_matches"
            ? "所选策略本轮命中股票"
            : "用户自定义股票篮子",
          requestedCount: securities.length,
          usedCount: securities.length,
          failedCount: 0,
          requestedCodes: securities.map((item) => item.code),
          usableCodes: securities.map((item) => item.code),
          securities,
          excluded: [],
          pointInTime: false,
          survivorBias: true
        },
        strategyIds,
        minimumVotes,
        strategyContext: {
          strategyId: strategyIds.length > 1 ? "custom_strategy_vote" : strategyIds[0],
          strategyName: strategyIds.length > 1 ? "自选策略共振" : previewVerifiedStrategies.find((item) => item.id === strategyIds[0])?.name,
          strategyIds,
          minimumVotes,
          voteRule: strategyIds.length > 1 ? `至少 ${minimumVotes}/${strategyIds.length} 票同日命中` : "单策略逐日命中"
        },
        metrics: {
          startingCapital,
          endingCapital: Number(endingCapital.toFixed(2)),
          totalReturnPercent: Number(totalReturnPercent.toFixed(3)),
          annualizedReturnPercent: 8.9,
          maxDrawdownPercent: -3.7,
          sharpeRatio: 0.91,
          tradeCount: trades.length,
          winRate: 62.5,
          profitFactor: 1.48,
          averageTradeReturnPercent: 1.34,
          benchmarkReturnPercent,
          excessReturnPercent: Number((totalReturnPercent - benchmarkReturnPercent).toFixed(3)),
          rejectedSignals: 2,
          maxOpenPositions: maxPositions
        },
        equityCurve,
        contributions,
        trades,
        signalEvents,
        signalTimeline,
        validation: {
          accepted: false,
          sampleCount: trades.length,
          independentSignalDays: trades.length,
          reason: "浏览器预览数据只用于界面检查，不能视为真实历史验证。"
        },
        dataQuality: {
          requestedStocks: securities.length,
          loadedStocks: securities.length,
          failedStocks: [],
          providerPolicy: "预览数据",
          partial: false
        },
        warning: "当前为浏览器预览组合回测，所有数值均为界面演示，禁止用于投资判断。"
      };
    },
    async scanStrategySignals(options = {}) {
      const stocks = previewSecurities.map((security, index) => {
        const payload = buildPreviewPayload(security);
        return {
          ...security,
          ...payload.quote,
          industry: payload.quote.industry,
          mrs: payload.analysis.mrs,
          grade: payload.analysis.grade,
          signalScore: Math.max(58, payload.analysis.mrs - index * 3),
          strategyMatchRate: payload.analysis.strategyMatchRate,
          observationNode: payload.analysis.exactNode || payload.analysis.nextNode,
          reasons: ["预览行情结构", "风险否决通过"],
          risks: [],
          matchSource: "ohlcv",
          historyBars: 720,
          riskVetoStatus: "passed"
        };
      });
      // 与桌面一致：不指定策略时只跑在用策略（已下线的只在明确指定 id 时出现）。
      const definitions = previewVerifiedStrategies as Array<(typeof previewVerifiedStrategies)[number] & { retired?: boolean }>;
      const strategies = definitions.filter(definition => options.strategyIds?.length ? options.strategyIds.includes(definition.id) : definition.retired !== true).map((definition, index) => ({
        ...definition,
        stocks: previewExtraIds.has(definition.id) ? [] : stocks.slice(0, index % 3 + 1).map(stock => ({
          code: stock.code, name: stock.name, industry: stock.industry,
          latest: stock.latest, changePct: stock.changePct, amount: stock.amount,
          turnover: stock.turnover, signalDate: new Date().toISOString().slice(0, 10),
          signalStrength: stock.signalScore
        }))
      }));
      const customGroups = previewCustomStrategies.map((strategy, index) => ({
        id: strategy.id, name: strategy.name, type: "custom", custom: true, family: "custom", version: `custom-r${strategy.revision || 1}`,
        detail: strategy.description, conditions: ["浏览器预览：条件按演示数据展示"], universeId: strategy.universe,
        stocks: stocks.slice(0, index % 2 + 1).map(stock => ({
          code: stock.code, name: stock.name, industry: stock.industry, latest: stock.latest, changePct: stock.changePct, amount: stock.amount,
          turnover: stock.turnover, signalDate: new Date().toISOString().slice(0, 10), signalStrength: stock.signalScore,
          matchRate: 83, needsConfirmation: strategy.conditions.some(item => /sector|information|marketEmotion|firstBoardQuality/.test(item.ref)),
          pendingConditions: strategy.conditions.filter(item => /sector|information|marketEmotion|firstBoardQuality/.test(item.ref))
            .map(item => CUSTOM_CATALOG.factors.find(factor => `factor:${factor.id}` === item.ref)?.label || item.ref)
        }))
      }));
      strategies.push(...customGroups as any[]);
      return {
        mode: "selection", generatedAt: new Date().toISOString(), sourceClass: "preview",
        source: "浏览器演示数据", warning: "当前为演示股票列表，真实选股结果请在桌面软件中查看。",
        universeSize: stocks.length, availableUniverseSize: stocks.length, processed: stocks.length, failed: 0,
        universeCoverage: { boards: [], listed: stocks.length, eligible: stocks.length, excludedRisk: 0, failed: 0, requestsComplete: true, complete: true },
        compositeStrategyCount: strategies.filter(item => item.type === "composite").length,
        qualifiedCount: new Set(strategies.flatMap(item => item.stocks.map(stock => stock.code))).size,
        strategies
      };
    },
    // 浏览器预览：AI 助手用演示数据，不调用任何模型。
    ai: (() => {
      const profiles: AiProfileList = { activeId: "demo-a", rankIds: ["demo-a", "demo-b"], max: 8, profiles: [
        { id: "demo-a", name: "演示 DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", hasKey: true },
        { id: "demo-b", name: "演示 通义", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", hasKey: true }] };
      const ratings = ["重点关注", "关注", "观望", "回避"] as const;
      const ratingOf = (score: number) => ratings[score >= 75 ? 0 : score >= 60 ? 1 : score >= 40 ? 2 : 3]!;
      const saved = new Map<string, { rank: AiRanking | null; summary: AiSummary | null; savedAt: string }>();
      const remember = (asOfDate: string, patch: { rank?: AiRanking; summary?: AiSummary }) => {
        const previous = saved.get(asOfDate) || { rank: null, summary: null, savedAt: "" };
        saved.set(asOfDate, { ...previous, ...patch, savedAt: new Date().toISOString() });
      };
      const demoRank = (input: AiSelectionInput): AiRanking => {
        const chosen = profiles.profiles.filter(item => profiles.rankIds?.includes(item.id));
        return { asOfDate: input.asOfDate, model: chosen.map(item => item.name).join(" + "), generatedAt: new Date().toISOString(), evaluated: input.picks.length,
          models: chosen.map(item => ({ id: item.id, name: item.name, model: item.model, ok: true, evaluated: input.picks.length })),
          items: input.picks.map((pick, index) => {
            const scores = chosen.map((item, modelIndex) => { const score = Math.max(20, 88 - index * 9 - modelIndex * (index === 1 ? 24 : 4)); return { id: item.id, name: item.name, score, rating: ratingOf(score) }; });
            const score = Math.round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length);
            const spread = Math.max(...scores.map(item => item.score)) - Math.min(...scores.map(item => item.score));
            return { code: pick.code, name: pick.name, score, rating: ratingOf(score), highlights: "演示：命中多套策略，量价配合", risks: "演示：短线涨幅较大", nextDay: "演示：观察竞价强弱与能否站稳均价", scores, spread, disagreement: spread >= 20 };
          }) };
      };
      // 和桌面版一样按股票累积：只给勾选的几只打分时并进同一张榜。
      const mergeBoard = (base: AiRanking | null, run: AiRanking): AiRanking => {
        const fresh = new Set(run.items.map(item => item.code));
        const items = [...run.items, ...(base?.items || []).filter(item => !fresh.has(item.code))].sort((a, b) => b.score - a.score);
        const profileList = [...(run.profiles || []), ...(base?.profiles || []).filter(item => !fresh.has(item.code))];
        return { ...run, items, evaluated: items.length, ...(profileList.length ? { profiles: profileList } : {}) };
      };
      const onlyCodes = (board: AiRanking, codes: string[]): AiRanking => {
        const wanted = new Set(codes);
        const items = board.items.filter(item => wanted.has(item.code));
        return { ...board, items, evaluated: items.length, ...(board.profiles ? { profiles: board.profiles.filter(item => wanted.has(item.code)) } : {}) };
      };
      const demoDims: Record<string, { label: string; detail: string }> = {
        limit: { label: "涨停强度", detail: "连板高度、近 20 日涨停次数、距最近涨停的天数" }, trend: { label: "均线趋势", detail: "均线排列、站上几条均线" },
        macd: { label: "MACD", detail: "金叉/死叉、红绿柱" }, rsi: { label: "RSI", detail: "RSI(14) 强弱与超买超卖" }, volume: { label: "量能", detail: "量比与涨跌配合" },
        position: { label: "位置乖离", detail: "5日线乖离率、近 20 日涨幅" }, levels: { label: "支撑压力", detail: "离支撑/压力距离、缺口" },
        theme: { label: "题材情绪", detail: "涨停原因、市场情绪" }, news: { label: "消息公告", detail: "近 30 天公司公告：利好/利空、重大风险" }, risk: { label: "风险控制", detail: "炸板、超买、高乖离" } };
      const demoCaps = [{ id: "overbought", label: "RSI14 超过 80 不给关注" }, { id: "chase", label: "高于 5 日线 5% 以上不追高" }, { id: "downtrend", label: "均线空头排列不给关注" }, { id: "broken", label: "近 20 日炸板 2 次以上且未连板不给关注" }, { id: "riskNotice", label: "近 30 天有重大风险公告不给关注" }];
      const builtin: Record<string, { name: string; description: string; weights: Record<string, number>; caps: string[] }> = { auto: { name: "AI 自动编排", description: "软件先识别情境、给各策略算适配度和基础分，AI 按情境自主挑 1–3 套策略组合使用。", weights: {}, caps: ["riskNotice"] },
        shortline: { name: "短线涨停", description: "看涨停强度、量能和题材情绪，适合打板、接力和涨停后低吸。", weights: { limit: 25, volume: 20, theme: 15, risk: 15, news: 10, position: 10, trend: 5 }, caps: ["broken", "riskNotice"] },
        technical: { name: "技术面综合", description: "看均线排列、MACD、RSI、量能、位置乖离和支撑压力，适合趋势和波段。", weights: { trend: 25, macd: 20, rsi: 15, volume: 10, position: 10, levels: 10, news: 10 }, caps: ["overbought", "chase", "riskNotice"] },
        breakout: { name: "突破", description: "逼近或站上近 20/60 日高点的股票，看突破是否放量。", weights: { trend: 30, volume: 30, risk: 20, news: 20 }, caps: ["overbought", "riskNotice"] },
        limit_pullback: { name: "涨停后低吸", description: "近 10 日涨停过、之后回调的股票，看回踩位置和缩量。", weights: { levels: 30, volume: 25, limit: 25, news: 20 }, caps: ["broken", "riskNotice"] } };
      let frameworkState: { active: AiFrameworkInfo["id"]; custom: AiCustomFramework } = { active: "auto", custom: { name: "自定义", weights: { ...builtin.technical!.weights }, caps: ["overbought", "chase"], note: "" } };
      const describe = (id: AiFrameworkInfo["id"], item: { name: string; description: string; weights: Record<string, number>; caps: string[] }, guidance = ""): AiFrameworkInfo => ({ id, name: item.name, description: item.description, guidance,
        dimensions: Object.entries(item.weights).map(([dim, weight]) => ({ id: dim, label: demoDims[dim]!.label, detail: demoDims[dim]!.detail, weight })), caps: demoCaps.filter(cap => item.caps.includes(cap.id)) });
      const catalog = (): AiFrameworkCatalog => ({ active: frameworkState.active, custom: structuredClone(frameworkState.custom),
        frameworks: [...Object.entries(builtin).map(([id, item]) => describe(id, item)), describe("custom", { ...frameworkState.custom, description: "你自己设定的维度权重和硬规则。" }, frameworkState.custom.note)],
        dimensions: Object.entries(demoDims).map(([id, item]) => ({ id, ...item })), caps: demoCaps });
      const currentWeights = () => frameworkState.active === "custom" ? frameworkState.custom.weights : frameworkState.active === "auto" ? builtin.breakout!.weights : builtin[frameworkState.active]?.weights || builtin.technical!.weights;
      const withFramework = (item: AiRankItem, index: number): AiRankItem => {
        const dims = Object.entries(currentWeights()).map(([id, weight], dimIndex) => ({ id, label: demoDims[id]!.label, weight, score: Math.max(15, 88 - index * 8 - dimIndex * 4), note: "演示：按体检数据计算" }));
        const total = dims.reduce((sum, dim) => sum + dim.weight, 0) || 1;
        const base = Math.round(dims.reduce((sum, dim) => sum + dim.score * dim.weight, 0) / total);
        const score = Math.max(0, Math.min(100, base + (index % 2 ? -4 : 6)));
        const auto = frameworkState.active === "auto";
        const plays = auto ? (index % 2 ? [{ id: "limit_pullback", name: "涨停后低吸", weight: 100, base, fit: 80 }] : [{ id: "breakout", name: "突破", weight: 60, base, fit: 85 }, { id: "technical", name: "技术面综合", weight: 40, base, fit: 55 }]) : undefined;
        return { ...item, score, rating: ratingOf(score), base, adjust: score - base, reason: index % 2 ? "演示：上方压力较近，略减分" : "演示：题材与量能配合，略加分",
          framework: auto ? `AI 编排：${plays!.map(play => `${play.name}${plays!.length > 1 ? ` ${play.weight}%` : ""}`).join(" + ")}` : catalog().frameworks.find(entry => entry.id === frameworkState.active)!.name, dims, caps: [],
          ...(auto ? { plays, situation: index % 2 ? ["涨停后回调", "回踩均线"] : ["逼近20日新高", "多头趋势", "有涨停题材"], orchestration: index % 2 ? "演示：涨停后缩量回踩，低吸为主" : "演示：放量突破叠加趋势" } : {}) };
      };
      let customList: AiCustomStock[] = [];
      let customRanking: AiRanking | null = null;
      const reviews = new Map<string, AiRanking>();
      const demoProfile = (code: string, name: string, index: number): AiStockProfile => ({
        code, name, industry: "演示行业", asOfDate: new Date().toISOString().slice(0, 10), latest: 20 + index, changePct: 2.1 - index, return5: 6.5 - index * 2,
        return20: 15 - index * 4, volumeRatio: 1.4, trend: index % 2 ? "站上5/10日线，20/60日线下方" : "站上全部均线", limitUps20: index % 3, consecutiveBoards: 0, daysSinceLimit: 3 + index,
        support: [{ label: "10日线", price: 19 + index }, { label: "20日线", price: 18 + index }], resistance: [{ label: "近20日最高", price: 23 + index }],
        announcements: index % 2 ? [] : [{ date: new Date().toISOString().slice(0, 10), title: "演示：关于签订日常经营重大合同的公告", direction: "利好", risk: 0 }]
      });
      const stampNow = (asOfDate: string) => ({ asOfDate, model: "演示 DeepSeek", generatedAt: new Date().toISOString() });
      const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      let marketSaved: AiMarketReview | null = null;
      let lookbackSaved: AiLookback | null = null;
      const interpretSaved = new Map<string, AiInterpretation>();
      return {
        async marketReview() {
          marketSaved = { ...stampNow(today()), headline: "演示：分歧中主线仍在，情绪未退潮", market: "浏览器预览不调用 AI，这里是演示文字。桌面版会引用复盘页的涨跌家数、涨停、炸板和连板数字。",
            cycle: { phase: "分歧", reason: "演示：涨停家数回落、炸板率升高，但最高连板仍在" }, mainlines: [{ name: "演示板块", comment: "演示：前排仍有涨停，后排分化" }],
            ladder: "演示：高度板分歧，2 板晋级率一般。", indices: "演示：指数站上 20 日线，量能略缩。",
            nextDay: { posture: "演示：低吸前排，不追后排", focus: ["演示：主线前排的分歧转一致"], avoid: ["演示：无板块的孤立涨停"] }, risks: ["演示：高位股补跌"], confidence: "中", softwareRegime: "高位分歧",
            mode: "skills", steps: [
              { thought: "演示：先确认主线和梯队", calls: [{ skill: "limit_reasons", name: "涨停原因", ok: true, summary: "演示：涨停 48 家，前列原因：固态电池6、业绩增长4", args: "{}" },
                { skill: "sector_strength", name: "板块强度", ok: true, summary: "演示：概念按涨停家数前列：固态电池、机器人", args: "{\"kind\":\"concept\",\"sortBy\":\"limitUps\"}" }] },
              { thought: "演示：核对风险", calls: [{ skill: "broken_boards", name: "炸板与跌停", ok: true, summary: "演示：炸板 20 家，跌停 17 家，封板率 59%", args: "{}" }] },
              { thought: "演示：信息足够", calls: [] }] };
          return marketSaved;
        },
        async lookback() {
          lookbackSaved = { ...stampNow(today()), previousDate: "2026-10-30", previousHeadline: "演示：情绪回暖", summary: "演示：方向判断基本兑现，高度判断偏乐观。",
            verdicts: [{ claim: "演示：主线延续", result: "兑现", evidence: "演示：板块涨停 6 家" }, { claim: "演示：高度突破 5 板", result: "未兑现", evidence: "演示：最高 4 板" }, { claim: "演示：回避后排", result: "部分兑现", evidence: "演示：后排跌多涨少" }],
            lessons: ["演示：高度判断要看晋级率"], hitRatePct: 50, judged: 3 };
          return lookbackSaved;
        },
        async cachedMarketReview() { return { review: marketSaved, lookback: lookbackSaved, previousDate: "2026-10-30" }; },
        async interpret(input: { kind: AiInterpretKind }) {
          const value: AiInterpretation = { ...stampNow(today()), kind: input.kind, title: input.kind === "ecology" ? "涨停生态" : input.kind === "sectors" ? "板块强度" : "炸板观察",
            headline: "演示：这里是 AI 解读的结论", points: ["演示：要点一", "演示：要点二"], risks: ["演示：风险一"], watch: ["演示：明天看前排能否回封"] };
          interpretSaved.set(input.kind, value);
          return value;
        },
        async cachedInterpret(input: { kind: AiInterpretKind }) { return interpretSaved.get(input.kind) || null; },
        async frameworks() { return catalog(); },
        async saveFramework(input: { active?: AiFrameworkInfo["id"]; custom?: AiCustomFramework }) {
          frameworkState = { active: input.active || frameworkState.active, custom: input.custom ? structuredClone(input.custom) : frameworkState.custom };
          customRanking = null; reviews.clear();
          return catalog();
        },
        async customList() { return structuredClone(customList); },
        async saveCustomList(items: AiCustomStock[]) { customList = items.slice(0, 40).map(item => ({ code: item.code, name: item.name })); return structuredClone(customList); },
        async cachedCustom() { return customRanking ? { ...onlyCodes(customRanking, customList.map(item => item.code)), cached: true } : null; },
        async rankCustom(input?: { force?: boolean; codes?: string[] | undefined }) {
          const targets = input?.codes ? customList.filter(item => input.codes!.includes(item.code)) : customList;
          const have = new Set((customRanking?.items || []).map(item => item.code));
          const todo = input?.force || input?.codes ? targets : targets.filter(item => !have.has(item.code));
          const profiles = todo.map(item => demoProfile(item.code, item.name, customList.indexOf(item)));
          const ranking = demoRank({ asOfDate: profiles[0]?.asOfDate || "", picks: profiles.map(item => ({ code: item.code, name: item.name, strategies: [] })) as AiPick[], strategyCounts: [] });
          customRanking = mergeBoard(customRanking, { ...ranking, items: ranking.items.map(item => withFramework(item, Math.max(0, customList.findIndex(row => row.code === item.code)))), profiles });
          return { ...onlyCodes(customRanking, customList.map(item => item.code)), failed: [] };
        },
        async cachedReview(code: string) { return reviews.get(code) || null; },
        async review(input: { security: { code: string; name: string } }) {
          const profile = demoProfile(input.security.code, input.security.name, 0);
          const ranking = demoRank({ asOfDate: profile.asOfDate, picks: [{ code: profile.code, name: profile.name, strategies: [] }] as unknown as AiPick[], strategyCounts: [] });
          const item = { ...withFramework(ranking.items[0]!, 0), trend: "演示：站上全部均线，处于近20日区间上部", volume: "演示：量比 1.4，温和放量", keyLevels: "演示：回踩 10日线 19.00 不破可继续观察，上方 23.00 是近20日高点" };
          const value = { ...ranking, items: [item], profile, evaluated: 1 };
          reviews.set(profile.code, value);
          return value;
        },
        async status() { return { configured: true, model: "演示（浏览器预览）", profile: "演示 DeepSeek", rankModels: profiles.profiles.filter(item => profiles.rankIds?.includes(item.id)).map(item => item.name) }; },
        async cached(input: AiSelectionInput) { const hit = saved.get(input.asOfDate); const rank = hit?.rank ? onlyCodes(hit.rank, input.picks.map(pick => pick.code)) : null; return { rank: rank?.items.length ? { ...rank, cached: true } : null, summary: hit?.summary ? { ...hit.summary, cached: true } : null }; },
        async history() { return [...saved.entries()].map(([asOfDate, value]) => ({ asOfDate, rankModels: value.rank ? value.rank.models?.map(item => item.model) || [] : [], hasSummary: Boolean(value.summary), savedAt: value.savedAt })).sort((a, b) => b.asOfDate.localeCompare(a.asOfDate)); },
        async historyDay(asOfDate: string) { const hit = saved.get(asOfDate); return { asOfDate, rank: hit?.rank || null, summary: hit?.summary || null }; },
        async rank(input: AiSelectionInput): Promise<AiRanking> {
          const previous = saved.get(input.asOfDate)?.rank || null;
          const have = new Set((previous?.items || []).map(item => item.code));
          const todo = input.picks.filter(pick => input.only ? input.only.includes(pick.code) : input.force || !have.has(pick.code));
          const ranked = demoRank({ ...input, picks: todo });
          const board = mergeBoard(previous, { ...ranked, items: ranked.items.map(item => withFramework(item, Math.max(0, input.picks.findIndex(pick => pick.code === item.code)))) });
          remember(input.asOfDate, { rank: board });
          return onlyCodes(board, input.picks.map(pick => pick.code));
        },
        async summary(input: AiSelectionInput) {
          const result: AiSummary = { asOfDate: input.asOfDate, model: "演示 DeepSeek", generatedAt: new Date().toISOString(), headline: "演示：情绪回暖，主线集中",
            market: "浏览器预览不调用 AI，这里是演示文字。桌面版会根据当日涨停生态和选股结果生成总结。", themes: [{ name: "演示方向", stocks: input.picks.slice(0, 2).map(pick => pick.name) }],
            focus: input.picks.slice(0, 2).map(pick => ({ code: pick.code, name: pick.name, reason: "演示：命中策略最多" })), risks: ["演示：高位股分歧风险"] };
          remember(input.asOfDate, { summary: result }); return result;
        },
        async draftStrategy(): Promise<never> { throw new Error("浏览器预览不调用 AI，请在桌面版使用"); },
        async test(): Promise<never> { throw new Error("浏览器预览不调用 AI，请在桌面版测试"); },
        async profiles() { return structuredClone(profiles); },
        async saveProfile(): Promise<never> { throw new Error("浏览器预览不保存模型配置，请在桌面版设置"); },
        async deleteProfile(): Promise<never> { throw new Error("浏览器预览不保存模型配置，请在桌面版设置"); },
        async activateProfile(id: string) { profiles.activeId = id; return structuredClone(profiles); },
        async setRankModels(ids: string[]) { if (!ids.length) throw new Error("至少选择一套模型参与打分"); profiles.rankIds = ids; return structuredClone(profiles); }
      };
    })(),
    async getWatchlist() {
      return [...previewWatchlist];
    },
    async startTrendScan(options) { trendState = await createConfiguredTrendPreviewStatus(options); return structuredClone(trendState); },
    async evaluateTrendResearch() { throw new Error("浏览器预览不执行历史研究，请在桌面软件中导入真实或明确标记的合成数据"); },
    async checkTrendExecution({ signalDate }) { return {
      checkedAt: new Date().toISOString(), signalDate, executionDate: null, expectedSignalDate: null,
      state: "unknown", reasons: ["浏览器演示不提供可执行交易状态，请在桌面软件核对真实数据"],
      latest: null, upperLimit: null, lowerLimit: null, suspended: null, priceDate: null,
      source: "preview", minimumBuyQuantity: 100, quantityStep: 100
    }; },
    async getTrendScan() { return structuredClone(trendState); },
    async cancelTrendScan() { return structuredClone(trendState); },
    async saveWatchlist(items) {
      previewWatchlist = Array.isArray(items) ? [...items] : [];
      return [...previewWatchlist];
    },
    async getHoldings() {
      return [...previewHoldings];
    },
    async saveHoldings(items) {
      previewHoldings = Array.isArray(items) ? [...items] : [];
      return [...previewHoldings];
    },
    async getSettings() {
      return { ...previewSettings, selectedStrategies: [...previewSettings.selectedStrategies] };
    },
    async saveSettings(settings) {
      previewSettings = {
        ...defaultPreviewSettings,
        ...settings,
        selectedStrategies: [...new Set([...(settings.selectedStrategies || []), "riskVeto"])]
      };
      return { ...previewSettings, selectedStrategies: [...previewSettings.selectedStrategies] };
    },
    async testProvider(settings) {
      return {
        ok: true,
        provider: settings.provider,
        latency: 0,
        message: "浏览器预览连接正常；该结果不代表真实行情源可用。"
      };
    },
    async setTheme(theme) {
      previewSettings = { ...previewSettings, theme };
    },
    async controlWindow() {
      return { ok: true, maximized: false };
    },
    async openExternal() {
      // External navigation is disabled in browser preview mode.
    },
    getPlatform() {
      return "browser";
    },
    async getVersion() {
      return `${__APP_VERSION__}-preview`;
    }
  };
}

/** 预览用 1 分钟线：前一交易日尾盘 + 当日全天，只用于界面检查。 */
function buildPreviewMinutes(security: { code?: string }) {
  const seed = Number(String(security?.code || "600000").slice(-3)) || 7;
  const base = 20 + (seed % 50);
  const rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number; volumeUnit: string; amount: number }> = [];
  const push = (date: string, minute: number, price: number, volume: number) => {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    rows.push({ date: `${date} ${time}`, open: price, high: price * 1.001, low: price * 0.999, close: Number(price.toFixed(2)), volume, volumeUnit: "lots", amount: Math.round(price * volume * 100) });
  };
  for (let minute = 14 * 60 + 41; minute <= 15 * 60; minute += 1) push("2026-10-27", minute, base, 800);
  let price = base, index = 0;
  for (const [start, end] of [[9 * 60 + 30, 11 * 60 + 30], [13 * 60 + 1, 15 * 60]] as const) {
    for (let minute = start; minute <= end; minute += 1, index += 1) {
      price = base * (1 + 0.02 * Math.sin(index / 30 + seed) + 0.012 * Math.sin(index / 7));
      push("2026-10-28", minute, price, 400 + Math.round(600 * Math.abs(Math.sin(index / 5 + seed))) + (index < 10 ? 3000 : 0));
    }
  }
  return rows;
}
