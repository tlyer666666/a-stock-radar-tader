import type { StockApi } from "../shared/ipc-contract";
import type { EtfItem } from "../features/etf/etfTypes";
import type { BatchQuote, BatchQuoteRequest } from "../domain/batchQuoteTypes";
import {
  previewShanghaiDate,
  previewTradingDates,
  previewSecurities,
  resolveSecurity,
  previewState
} from "./shared";

export type PreviewMarketApi = Pick<
  StockApi,
  | "search"
  | "analyze"
  | "getQuoteSnapshot"
  | "getDataFederation"
  | "getMarketSourceHealth"
  | "getChart"
  | "discoverLimitUps"
  | "getLimitUpPoolSnapshot"
  | "getPreviousLimitUpFailedBoardSnapshot"
  | "discoverRecentLimitUps"
  | "getLimitUpSectorBoard"
  | "getSectorStrengthBoard"
  | "searchSectors"
  | "getConceptChain"
  | "getSectorCatalog"
  | "getSectorClassifications"
  | "getSectorDetail"
  | "cancelSectorRequest"
  | "getLimitEcology"
  | "getConvertibleBonds"
  | "getEtfMarket"
  | "getBatchQuotes"
  | "getSectorQuotes"
  | "analyzeSector"
  | "getProfessionalReview"
>;

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

export const buildPreviewPayload = (input: Security | string) => {
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
        alertScore: previewState.settings.alertScore,
        exactNodesOnly: previewState.settings.exactNodesOnly,
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
        maxPositionPercent: previewState.settings.maxPositionPercent,
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
      { name: "中证全指", code: "000985", date, close: 6120, returns: { r1: 0.2, r3: 0.6, r5: 1.1 }, trend: "震荡", ma5: 6120, ma20: 6088, volumeRatio: 0.96, score: 58 },
      { name: "上证指数", code: "000001", date, close: 3560, returns: { r1: 0.1, r3: 0.4, r5: 0.7 }, trend: "震荡", ma5: 3560, ma20: 3542, volumeRatio: 0.92, score: 55 },
      { name: "深证成指", code: "399001", date, close: 11120, returns: { r1: 0.3, r3: 0.8, r5: 1.4 }, trend: "偏强", ma5: 11120, ma20: 10980, volumeRatio: 1.03, score: 62 }
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
function buildPreviewLimitEcology() {
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

export function createPreviewMarketMethods(): PreviewMarketApi {
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
      const createdAt = new Date().toISOString();
      return rows.map((item, index) => ({
        ...(item as unknown as Security),
        createdAt,
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
    async getEtfMarket() {
      const rows: Array<[string, string, EtfItem["category"], number, number, number, number | null]> = [
        ["510300", "沪深300ETF演示", "宽基", 4.012, 0.62, 3.1e9, 4.01],
        ["588000", "科创50ETF演示", "宽基", 1.304, -1.21, 4.4e9, 1.3047],
        ["512880", "证券ETF演示", "行业主题", 1.105, 3.42, 1.2e9, 1.104],
        ["588170", "科创半导体ETF演示", "行业主题", 0.695, 2.66, 4.5e9, 0.6974],
        ["513310", "中韩半导体ETF演示", "跨境", 3.513, -2.69, 4.6e9, 3.2108],
        ["513180", "恒生科技ETF演示", "跨境", 0.721, 1.85, 2.8e9, 0.7196],
        ["518880", "黄金ETF演示", "商品", 6.88, -0.41, 2.1e9, 6.879],
        ["511260", "十年国债ETF演示", "债券", 136.08, 0.01, 4.2e8, 136.07],
        ["511880", "货币ETF演示", "货币", 100.992, 0, 5.6e9, null]
      ];
      const items: EtfItem[] = rows.map(([code, name, category, latest, changePct, amount, iopv]) => ({
        code, name, category, secid: `${code.startsWith("1") ? 0 : 1}.${code}`, latest, changePct, amount, iopv,
        t0: ["跨境", "商品", "债券", "货币"].includes(category), amplitude: category === "货币" ? 0.01 : Math.round((Math.abs(changePct) + 1.2) * 100) / 100,
        volume: Math.round(amount / latest / 100), turnover: 2.4, volumeRatio: 1.1, open: latest, preClose: latest / (1 + changePct / 100), scale: amount * 30,
        premiumPct: iopv ? Math.round((latest / iopv - 1) * 10000) / 100 : null
      }));
      const priced = items.filter(item => item.category !== "货币" && item.changePct !== null);
      return {
        fetchedAt: new Date().toISOString(), items, highPremiumPercent: 3, complete: true, warnings: ["演示数据（浏览器预览不连接东方财富）"],
        summary: { count: items.length, rising: priced.filter(item => (item.changePct ?? 0) > 0).length, falling: priced.filter(item => (item.changePct ?? 0) < 0).length, flat: priced.filter(item => item.changePct === 0).length,
          totalAmount: items.reduce((sum, item) => sum + (item.amount ?? 0), 0), highPremium: items.filter(item => (item.premiumPct ?? 0) > 3).length,
          byCategory: { 宽基: 2, 行业主题: 2, 跨境: 2, 商品: 1, 债券: 1, 货币: 1 }, t0Count: items.filter(item => item.t0).length },
        topThemes: items.filter(item => item.category === "行业主题").sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0)).map(({ code, name, secid, changePct, amount }) => ({ code, name, secid, changePct, amount }))
      };
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
    async getBatchQuotes(securities: BatchQuoteRequest[]) {
      const quotes: Record<string, BatchQuote> = {};
      const missing: string[] = [];
      for (const item of Array.isArray(securities) ? securities : []) {
        const code = String(item?.code || "");
        if (!/^\d{6}$/.test(code)) continue;
        const quote = buildPreviewPayload(code).quote;
        quotes[code] = {
          code, name: quote.name, latest: quote.latest, preClose: quote.preClose, open: quote.open,
          high: quote.high, low: quote.low, change: quote.change, changePct: quote.changePct,
          volumeLots: quote.volume, amount: quote.amount, turnover: quote.turnover, amplitude: quote.amplitude,
          floatMarketCap: null, totalMarketCap: null, limitUp: null, limitDown: null,
          quoteAt: quote.updatedAt, quoteDate: quote.updatedAt.slice(0, 10), tradeStatus: "trading", source: "预览数据"
        };
      }
      return { quotes, missing, source: "预览数据", fetchedAt: new Date().toISOString() };
    },
    async getSectorQuotes() {
      return { status: "unavailable" as const, fetchedAt: new Date().toISOString(), quotes: {}, sources: [],
        warnings: ["浏览器预览不连接同花顺板块行情。"] };
    },
    async analyzeSector(sector) {
      const sectorObj = typeof sector === "string" ? { name: sector } : (sector || {});
      if (sectorObj.code === "THS:BJ" || sectorObj.name === "北交所") {
        return { name: "北交所", code: "THS:BJ", boardType: "exchange", source: "preview", members: [], constituents: [],
          memberCount: null, memberCoverage: { loaded: 0, total: null, complete: false },
          warning: "浏览器预览不连接真实北交所行情，请在桌面版读取同花顺数据。", returns: { r1: null, r3: null, r5: null } };
      }
      return {
        ...sectorObj,
        source: "preview",
        score: Number(sectorObj.score || 72),
        members: previewSecurities,
        history: buildPreviewHistory(previewSecurities[0] || resolveSecurity("600519"), 90)
      };
    },
    async getProfessionalReview() {
      return {
        ...buildPreviewProfessionalReview(),
        fuyao: buildPreviewLimitEcology()
      };
    },
  };
}
