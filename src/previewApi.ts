const previewShanghaiDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(date);

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

const previewVerifiedStrategies = [
  ["low_first_board", "低位首板", "近60日无重复涨停，板前位置不过热。", "base"],
  ["platform_breakout", "平台突破首板", "窄幅平台上沿被首板突破。", "base"],
  ["vcp_compression", "涨停后VCP压缩", "涨停后量价同步收缩并守住支撑。", "base"],
  ["second_breakout", "涨停后二次突破", "整理后放量突破前高。", "base"],
  ["weak_to_strong", "弱转强修复", "低开回收或重新站回涨停收盘价。", "base"],
  ["trend_first_board", "多头趋势首板", "均线多头排列中的首板。", "base"],
  ["low_volume_first_board", "缩量控盘首板", "量能受控且位于MA20上方的首板。", "base"],
  ["limit_gap_hold", "涨停后缺口守卫", "涨停缺口未回补且支撑有效。", "base"],
  ["limit_ma10_pullback", "涨停后MA10回踩", "缩量回踩MA10后收回。", "base"],
  ["volume_dryup_rebound", "涨停后地量反包", "地量整理后阳线修复。", "base"],
  ["double_limit_relay", "双涨停N形接力", "两次非连续涨停构成N形结构。", "base"],
  ["high_tight_flag", "涨停后高位窄旗", "涨停后高位窄幅缩量整理。", "base"],
  ["ma_reclaim_after_limit", "涨停后均线反转", "涨停回落后重新站回MA10。", "base"],
  ["long_lower_shadow_limit", "长下影涨停封板", "分歧下探后收于涨停。", "base"],
  ["first_board_quality_resonance", "首板质量共振", "低位首板与至少一项质量因子共振。", "composite"],
  ["post_limit_contraction_resonance", "涨停后缩量共振", "VCP与窄旗或地量修复共振。", "composite"],
  ["breakout_repair_resonance", "突破修复共振", "二次突破与修复信号共振。", "composite"],
  ["n_relay_resonance", "N形接力共振", "双涨停N形与封板质量共振。", "composite"]
].map(([id, name, detail, type]) => ({
  id,
  name,
  detail,
  type,
  conditions: [],
  risk: "历史信号仅用于研究复核，不代表未来收益。",
  components: [],
  voteRule: "单策略逐日命中"
}));

const defaultPreviewSettings: Settings = {
  riskProfile: "balanced",
  provider: "ths",
  refreshToken: "",
  tushareToken: "",
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

export function createPreviewApi(): Window["stockApi"] {
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
    async getChart(security, interval, options = {}) {
      const requestedLimit = Number(options.limit);
      const visibleLimit = Number.isFinite(requestedLimit)
        ? Math.max(20, Math.min(3000, Math.round(requestedLimit)))
        : 260;
      const resolved = resolveSecurity(security);
      const rows = buildPreviewHistory(resolved, visibleLimit);
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
        root: name,
        source: "preview",
        nodes: [
          { id: "root", name, level: 0 },
          { id: "upstream", name: `${name}上游`, level: 1 },
          { id: "downstream", name: `${name}下游`, level: 1 }
        ],
        edges: [
          { source: "upstream", target: "root" },
          { source: "root", target: "downstream" }
        ]
      };
    },
    async analyzeSector(sector) {
      return {
        ...(sector || {}),
        source: "preview",
        score: Number(sector?.score || 72),
        members: previewSecurities,
        history: buildPreviewHistory(previewSecurities[0] || resolveSecurity("600519"), 90)
      };
    },
    async getProfessionalReview() {
      return buildPreviewProfessionalReview();
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
    async runBacktest(security, options = {}) {
      const resolved = resolveSecurity(security);
      const settings = { ...previewSettings, ...(options.settings || {}) };
      const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.startDate || ""))
        ? String(options.startDate).slice(0, 10)
        : previewShanghaiDate(new Date(Date.now() - 365 * 86400000));
      const signalTo = previewShanghaiDate();
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
          componentNames: signalStrategyIds.map((id) =>
            previewVerifiedStrategies.find((item) => item.id === id)?.name || id
          )
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
      const selected = Array.isArray(options.strategyIds)
        ? options.strategyIds
        : previewSettings.selectedStrategies;
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
      const baseDefinitions = [
        { id: "low_first_board", name: "低位首板", detail: "近期无重复涨停且板前位置不过热" },
        { id: "platform_breakout", name: "平台突破首板", detail: "窄幅平台上沿由涨停突破" },
        { id: "vcp_compression", name: "涨停后VCP压缩", detail: "涨停后量价波动同步收缩" },
        { id: "second_breakout", name: "涨停后二次突破", detail: "整理后放量突破前高" },
        { id: "weak_to_strong", name: "弱转强修复", detail: "低开回收或重回涨停收盘价" },
        { id: "trend_first_board", name: "多头趋势首板", detail: "多头均线上的温和放量首板" },
        { id: "low_volume_first_board", name: "缩量控盘首板", detail: "量能受控且站在MA20上方" },
        { id: "limit_gap_hold", name: "涨停后缺口守卫", detail: "涨停缺口保持完整" },
        { id: "limit_ma10_pullback", name: "涨停后MA10回踩", detail: "缩量回踩并收回MA10" },
        { id: "volume_dryup_rebound", name: "涨停后地量反包", detail: "地量整理后的阳线修复" },
        { id: "double_limit_relay", name: "双涨停N形接力", detail: "两次非连续涨停构成N形" },
        { id: "high_tight_flag", name: "涨停后高位窄旗", detail: "高位窄幅缩量整理" },
        { id: "ma_reclaim_after_limit", name: "涨停后均线反转", detail: "回落后重新站回MA10" },
        { id: "long_lower_shadow_limit", name: "长下影涨停封板", detail: "分歧下探后收于涨停" }
      ].map((definition) => ({
        ...definition,
        type: "base" as const,
        conditions: [definition.detail],
        risk: "基础策略仍须通过次日可交易性、量价过热与统一风险否决。"
      }));
      const compositeDefinitions = [
        {
          id: "first_board_quality_resonance",
          type: "composite" as const,
          name: "首板质量共振",
          detail: "低位首板为必要条件，并由平台突破、趋势多头或缩量控盘中的至少一项再次确认。",
          components: [
            "low_first_board",
            "platform_breakout",
            "trend_first_board",
            "low_volume_first_board"
          ],
          voteRule: "低位首板必须成立，另3个质量组件至少1票，总计至少2个组件同时成立",
          conditions: ["低位首板为必要票", "平台/趋势/缩量控盘至少一票", "所有条件使用同一信号日快照"],
          risk: "多条件共振仍无法消除次日情绪退潮风险，竞价明显转弱时不应机械追入。"
        },
        {
          id: "post_limit_contraction_resonance",
          type: "composite" as const,
          name: "涨停后缩量共振",
          detail: "涨停后VCP压缩为必要条件，并由高位窄旗或地量阳线修复再次确认。",
          components: [
            "vcp_compression",
            "high_tight_flag",
            "volume_dryup_rebound"
          ],
          voteRule: "VCP压缩必须成立，窄旗/地量反包至少1票，总计至少2个组件同时成立",
          conditions: ["VCP量价压缩为必要票", "窄旗或地量修复至少一票", "涨停日支撑必须有效"],
          risk: "缩量共振可能来自参与资金减少；若整理末端未出现增量承接，突破容易失败。"
        },
        {
          id: "breakout_repair_resonance",
          type: "composite" as const,
          name: "突破修复共振",
          detail: "涨停后二次突破为必要条件，同时出现弱转强或MA10反转修复。",
          components: [
            "second_breakout",
            "weak_to_strong",
            "ma_reclaim_after_limit"
          ],
          voteRule: "二次突破必须成立，弱转强/MA10反转至少1票，总计至少2个组件同时成立",
          conditions: ["二次突破为必要票", "弱转强或MA10反转至少一票", "量能不得触发风险否决"],
          risk: "突破和修复发生在同日时波动通常较高，尾盘回落会显著增加假突破概率。"
        },
        {
          id: "n_relay_resonance",
          type: "composite" as const,
          name: "N形接力共振",
          detail: "双涨停N形接力为必要条件，并由平台、趋势或长下影封板质量中的至少一项确认。",
          components: [
            "double_limit_relay",
            "platform_breakout",
            "trend_first_board",
            "long_lower_shadow_limit"
          ],
          voteRule: "双涨停N形必须成立，另3个封板质量组件至少1票，总计至少2个组件同时成立",
          conditions: ["双涨停N形为必要票", "平台/趋势/长下影至少一票", "第二板必须站上第一板"],
          risk: "二次接力处于更高价格区间，筹码松动或板块降温会放大高位回撤。"
        }
      ];
      const definitions = [...baseDefinitions, ...compositeDefinitions];
      const previewComponentNames = new Map(
        baseDefinitions.map((definition) => [definition.id, definition.name])
      );
      const acceptedCompositeIds = new Set([
        "first_board_quality_resonance",
        "breakout_repair_resonance"
      ]);
      const auditedStrategies = definitions.map((definition, index) => {
        const composite = definition.type === "composite";
        const accepted =
          composite && acceptedCompositeIds.has(definition.id);
        const insufficient =
          !accepted &&
          (definition.id === "n_relay_resonance" ||
            (!composite && index % 3 === 1));
        const sampleCount = accepted ? 108 + index : insufficient ? 18 : 60 + index * 3;
        const outOfSampleCount = accepted ? 31 : insufficient ? 5 : 18 + index;
        const passRate = accepted ? 1 : insufficient ? 0 : 1 / 3;
        const currentStocks = stocks
          .filter((_, stockIndex) => stockIndex % 3 === index % 3)
          .map((stock, stockIndex) => {
            if (!composite) return stock;
            const components = "components" in definition
              ? definition.components
              : [];
            const secondaryIndex =
              components.length > 1
                ? 1 + stockIndex % (components.length - 1)
                : 0;
            const matchedComponents = [
              components[0],
              components[secondaryIndex]
            ].filter((componentId): componentId is string => Boolean(componentId));
            const matchedNames = matchedComponents.map(
              (componentId) =>
                previewComponentNames.get(componentId) || componentId
            );
            return {
              ...stock,
              matchedComponents,
              componentMatches: Object.fromEntries(
                components.map((componentId) => [
                  componentId,
                  matchedComponents.includes(componentId)
                ])
              ),
              reasons: [
                `组合共振：${matchedNames.join(" + ")}`,
                "全部命中发生在同一信号日快照"
              ]
            };
          });
        return {
          ...definition,
          publicationAccepted: accepted,
          validation: {
            accepted,
            publicationAccepted: accepted,
            status: accepted ? "PASS" : insufficient ? "INSUFFICIENT" : "REVIEW",
            grade: accepted ? "A-" : insufficient ? "D" : "C",
            sampleCount,
            minimumSamples: 30,
            outOfSampleCount,
            walkForwardPassRate: passRate,
            winRate5: insufficient ? null : accepted ? 61.8 : 46.5,
            average5: insufficient ? null : accepted ? 2.34 : 0.62,
            excess5: insufficient ? null : accepted ? 1.52 : 0.31,
            worstMdd5: insufficient ? null : accepted ? -14.8 : -26.4,
            stabilityScore: insufficient ? null : accepted ? 82 : 48,
            range: { from: "2023-09-01", to: "2026-07-23" },
            inSample: {
              sampleCount: Math.max(0, sampleCount - outOfSampleCount),
              winRate: insufficient ? null : accepted ? 64.1 : 49.2,
              averageReturn: insufficient ? null : accepted ? 2.68 : 0.84,
              averageExcessReturn: insufficient ? null : accepted ? 1.71 : 0.42,
              maxDrawdown: insufficient ? null : accepted ? -12.6 : -18.6,
              range: { from: "2023-09-01", to: "2025-09-30" }
            },
            outOfSample: {
              sampleCount: outOfSampleCount,
              winRate: insufficient ? null : accepted ? 61.8 : 46.5,
              averageReturn: insufficient ? null : accepted ? 2.34 : 0.62,
              averageExcessReturn: insufficient ? null : accepted ? 1.52 : 0.31,
              maxDrawdown: insufficient ? null : accepted ? -14.8 : -26.4,
              benchmarkSampleCount: outOfSampleCount,
              range: { from: "2025-10-01", to: "2026-07-23" }
            },
            walkForward: {
              available: !insufficient,
              accepted,
              passedFolds: accepted ? 3 : insufficient ? 0 : 1,
              passRate,
              overfitRisk: insufficient ? "insufficient" : accepted ? "low" : "high",
              reason: accepted
                ? "预览连续3个走步窗口均通过"
                : insufficient
                  ? "预览样本不足，不能发布"
                  : "预览走步窗口未达到发布门槛",
              folds: insufficient
                ? []
                : accepted
                  ? [
                      { fold: 1, accepted: true },
                      { fold: 2, accepted: true },
                      { fold: 3, accepted: true }
                    ]
                  : [
                      { fold: 1, accepted: true },
                      { fold: 2, accepted: false },
                      { fold: 3, accepted: false }
                    ]
            },
            roundTripCostBps: 18,
            untradeableCount: index % 4,
            entryRule: "信号次一交易日开盘买入，持有5个交易日",
            returnType: "扣除双边18 bps成本后的5日收益",
            publicationFailureReasons: accepted
              ? []
              : [
                  insufficient
                    ? `预览样本不足：${sampleCount}/30`
                    : "预览走步窗口通过率不足：33.3%/66.7%"
                ]
          },
          stocks: currentStocks
        };
      });
      const publishedStrategies = auditedStrategies.filter(
        (strategy) => strategy.publicationAccepted
      );
      const optimizedPortfolio = {
        id: "optimized_robust_consensus",
        name: "稳健优选组合",
        version: "robust-v2-preview",
        accepted: true,
        publicationAccepted: true,
        minimumVotes: 2,
        maxAllowedContainment: 0.68,
        splitDate: "2026-01-05",
        selectedStrategies: [
          { id: "low_first_board", name: "低位首板", robustScore: 84.6, developmentAccepted: true },
          { id: "second_breakout", name: "涨停后二次突破", robustScore: 80.2, developmentAccepted: true },
          { id: "volume_dryup_rebound", name: "涨停后地量反包", robustScore: 77.8, developmentAccepted: true }
        ],
        dependence: [
          { leftId: "low_first_board", rightId: "second_breakout", commonSignals: 18, containment: 0.31, jaccard: 0.18, returnCorrelation: 0.26 },
          { leftId: "low_first_board", rightId: "volume_dryup_rebound", commonSignals: 14, containment: 0.24, jaccard: 0.13, returnCorrelation: 0.21 }
        ],
        validation: {
          accepted: true,
          sampleCount: 168,
          outOfSampleCount: 51,
          outOfSample: {
            sampleCount: 51,
            independentSignalDays: 44,
            winRate: 62.7,
            averageReturn: 2.08,
            averageReturnLowerBound95: 0.73,
            averageExcessReturn: 1.26,
            maxDrawdown: -8.4
          },
          walkForward: { available: true, accepted: true, passRate: 0.75, passedFolds: 3, folds: [{}, {}, {}, {}] }
        },
        terminalHoldout: {
          accepted: true,
          sampleCount: 39,
          minimumSamples: 36,
          independentSignalDays: 37,
          winRate: 61.5,
          averageReturn: 1.74,
          averageReturnLowerBound95: 0.42,
          averageExcessReturn: 0.93,
          maxDrawdown: -7.1,
          splitDate: "2026-01-05",
          reason: "终端留出样本通过"
        },
        currentRegime: { id: "balanced", label: "震荡均衡", return20: 1.2, volatility20: 1.36 },
        currentRegimeFit: { regimeId: "balanced", regimeLabel: "震荡均衡", supported: true, reason: "当前状态历史优势达标" },
        stocks: stocks.slice(0, 3).map((stock, index) => ({
          ...stock,
          signalStrength: 92 - index * 3,
          matchedStrategyIds: index === 0
            ? ["low_first_board", "second_breakout", "volume_dryup_rebound"]
            : ["low_first_board", "volume_dryup_rebound"]
        }))
      };
      return {
        generatedAt: new Date().toISOString(),
        source: "浏览器预览数据",
        universeSize: stocks.length,
        availableUniverseSize: stocks.length,
        processed: stocks.length,
        failed: 0,
        candidateCount: stocks.length,
        independentValidationUniverse: true,
        independentValidationSampleSize: 120,
        optimizedPortfolio,
        currentRegime: optimizedPortfolio.currentRegime,
        qualifiedCount: new Set(
          publishedStrategies.flatMap((strategy) =>
            strategy.stocks.map((stock) => stock.code)
          )
        ).size,
        historyBarsRequested: 720,
        benchmarkBars: 720,
        publishedStrategyCount: publishedStrategies.length,
        baseStrategyCount: baseDefinitions.length,
        compositeStrategyCount: compositeDefinitions.length,
        publishedBaseCount: 0,
        publishedCompositeCount: publishedStrategies.length,
        auditedStrategyCount: auditedStrategies.length,
        strategiesTested: auditedStrategies.length,
        sampleDiversity: {
          securities: stocks.length,
          boardCount: 3,
          dateCohortCount: 11,
          industryOrThemeCount: 6,
          boardBuckets: {},
          dateCohorts: {},
          maximumBoardShare: 0.6,
          maximumDateCohortShare: 0.18,
          concentrationWarnings: ["浏览器预览不代表真实样本分布"],
          diversified: false
        },
        warning: "当前为浏览器预览数据；桌面版会使用真实历史事件执行推演复核。",
        selectionBiasWarning:
          "预览只用于检查界面；桌面版会明确披露当前候选选择偏差与幸存者偏差。",
        multipleTestingWarning:
          "同时比较18套策略（14套基础、4套组合共振）会增加偶然拟合风险，桌面版会提高收益与胜率发布门槛。",
        publicationPolicy:
          "只有总样本、样本外、走步窗口、交易成本和基准证据全部达标的策略才发布股票。",
        dataRange: { from: "2023-09-01", to: "2026-07-23" },
        coverage: {
          universeSize: stocks.length,
          processed: stocks.length,
          historiesUsed: stocks.length,
          failed: 0,
          historyBarsRequested: 720,
          benchmarkBars: 720
        },
        methodology: `预览模式仅验证界面；当前策略参数 ${selected.length} 项，真实结果以桌面版为准。`,
        auditedStrategies,
        strategies: publishedStrategies
      };
    },
    async getWatchlist() {
      return [...previewWatchlist];
    },
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
