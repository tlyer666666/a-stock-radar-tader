import { timeShareSlot, type TimeShare, type TimeSharePoint } from "../market/timeShareModel";
import { calcAshareBuyFee, calcAshareSellFee, paperLotRule, paperPriceLimitRate, paperRoundShares } from "../paper-simulation/paperTradingRules";
import { isExchangeFundCode, priceDecimalsOf, priceTickOf, resolveT0, type TradingRuleSetting } from "../../domain/etfTradingRule";

/**
 * 做T助手的信号引擎（纯函数，不依赖界面）。
 *
 * 思路：以分时均价线（VWAP）为当日价格中枢，用「价格偏离均价」的波动率算出上下轨，
 * 再结合均价线斜率判断当日是单边上涨、单边下跌还是震荡；
 * - 倒T（先卖后买）：冲高到上轨且拐头时卖出一部分底仓，回落到均价线/目标价企稳后接回；
 * - 正T（先买后卖）：下探到下轨且企稳时买入，反弹到均价线/目标价拐头后卖出等量底仓。
 * A 股 T+1：做T只能用昨天及以前买入的「可卖底仓」，当天买入的股票当天不能卖。
 * T+0 品种（跨境、商品、债券、货币 ETF）当天买入当天可卖：买回的份额可再卖，没有底仓也能先买后卖。
 * 场内基金免印花税和过户费，最小价位 0.001 元。
 * 引擎只给出提示，不下单；用户自己成交后在界面登记，引擎据此跟踪未完成的T。
 */

export type TStyle = "steady" | "balanced" | "active";
export type TSide = "buy" | "sell";
export type TimeShareSeries = TimeShare;
export type TSuitability = "适宜正T" | "适宜反T" | "振幅过窄宜观望" | "单边趋势慎做T" | "等待数据";
export type TSmartCalibration = {
  suitability: TSuitability;
  recommendedStyle: TStyle;
  recommendedMinSpreadPct: number;
  reason: string;
  historicalWinRatePct: number | null;
  totalRounds?: number;
  dailyVolatilityPct?: number | null;
};
export type TCalibrationOptions = {
  priorRounds?: number;
  priorWins?: number;
  dailyVolatilityPct?: number | null;
};
export type TConfig = {
  /** 底仓股数（持有的总股数）。 */
  baseShares: number;
  /** 今天可卖的股数（T+1：昨天及以前买入的部分）。 */
  sellableShares: number;
  /** 持仓成本价，0 表示未填。 */
  costPrice: number;
  /** 每次做T的股数。 */
  tShares: number;
  style: TStyle;
  /** 扣除双边手续费后，一买一卖期望的最低净价差（%）。 */
  minSpreadPct: number;
  /** 券商佣金（%），按最低 5 元计。 */
  commissionPercent: number;
  /** 交易规则：auto 按代码和名称识别 T+0 / T+1，t0、t1 为用户手动指定。 */
  tradingRule: TradingRuleSetting;
};
export type TTrade = { id: string; side: TSide; price: number; shares: number; time: string };
export type TStockItem = Partial<TConfig> & {
  code?: string | undefined;
  name?: string | undefined;
  secid?: string | undefined;
  config?: Partial<TConfig> | undefined;
  trades?: TTrade[] | undefined;
  addedAt?: string | undefined;
};
export type TRegime = "up" | "down" | "range";
export type TAction = "sell" | "buy" | "buyBack" | "sellBack" | "stopBuyBack" | "stopSellBack" | "closeBuyBack" | "closeSellBack" | "wait";
export type TStrength = "strong" | "normal" | "watch";
export type TSignal = { action: TAction; strength: TStrength; title: string; price: number; shares: number; reasons: string[] };
export type TOpen = { kind: "reverse" | "forward"; shares: number; price: number; time: string; fees?: number; closedNet?: number } | null;
export type TLevels = {
  vwap: number; upper: number; lower: number; high: number; low: number;
  sellTarget: number | null; buyTarget: number | null; stop: number | null;
  limitUp: number | null; limitDown: number | null;
};
export type TStats = {
  rounds: number; realized: number; fees: number; costReduction: number; newCost: number | null; tradedShares: number;
  /** 最近一次完成的T：用于冷却期和止损后不再同方向开T。 */
  lastClosed: { kind: "reverse" | "forward"; time: string; profit: number } | null;
  /** 今天已经卖出的股数：T+1 下每卖一股就少一股可卖底仓，买回来的当天不能再卖。 */
  soldShares: number;
  /** 今天已经买入的股数：T+0 品种买入后当天可卖，计入剩余可卖。 */
  boughtShares?: number | undefined;
  /** 今天亏损了结（止损）过的方向，当天不再提示。 */
  lost: { reverse: boolean; forward: boolean };
  wins?: number | undefined;
  winRatePct?: number | null | undefined;
};
export type TAnalysis = {
  time: string; slot: number; price: number; changePct: number; preClose: number;
  regime: TRegime; regimeText: string; deviationPct: number; bandPct: number; momentumPct: number; volumeRatio: number;
  sigmaPct: number; vwap: number;
  levels: TLevels; open: TOpen; signal: TSignal; stats: TStats;
  calibration: TSmartCalibration;
  /** 本次评估采用的交易规则：true 为 T+0（当天买入当天可卖）。 */
  t0?: boolean | undefined;
  /** 价格显示位数：股票 2 位，场内基金 3 位。 */
  priceDigits?: number | undefined;
};
export type TSignalSummary = TAnalysis;
export type TMarker = { slot: number; time: string; side: TSide; price: number; label: string; virtual: boolean };
export type TReplay = { markers: TMarker[]; rounds: number; realized: number; open: TOpen };

export const STYLE_LABELS: Record<TStyle, string> = { steady: "稳健", balanced: "均衡", active: "积极" };
const BAND_K: Record<TStyle, number> = { steady: 1.8, balanced: 1.4, active: 1.1 };
const STOP_PCT: Record<TStyle, number> = { steady: 1.5, balanced: 2, active: 2.5 };
/** 每天最多完成几次T；做完一次后至少隔多少分钟再开下一次。 */
export const MAX_ROUNDS: Record<TStyle, number> = { steady: 2, balanced: 3, active: 4 };
const COOLDOWN_MINUTES = 10;
export const DEFAULT_T_CONFIG: TConfig = { baseShares: 0, sellableShares: 0, costPrice: 0, tShares: 0, style: "balanced", minSpreadPct: 1, commissionPercent: 0.025, tradingRule: "auto" };
/** 14:45 起提醒收尾；14:57 后是收盘集合竞价，不再给操作信号。 */
export const CLOSE_SLOT = 225;
export const AUCTION_SLOT = 237;
const OPEN_NOISE_SLOT = 15;

const round2 = (value: number) => Math.round(value * 100 + 1e-7) / 100;
const pct = (value: number, base: number) => base > 0 ? (value / base - 1) * 100 : 0;

export function normalizeTConfig(input: Partial<TConfig> | null | undefined, code = ""): TConfig {
  const num = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const baseShares = Math.floor(num(input?.baseShares, 0, 0, 1e8));
  const sellableShares = Math.min(baseShares, Math.floor(num(input?.sellableShares, baseShares, 0, 1e8)));
  const style: TStyle = input?.style === "steady" || input?.style === "active" ? input.style : "balanced";
  const fallbackT = code ? paperRoundShares(code, baseShares / 3) : Math.floor(baseShares / 3 / 100) * 100;
  const rawT = Math.floor(num(input?.tShares, 0, 0, 1e8));
  const tShares = rawT > 0 ? rawT : fallbackT;
  return {
    baseShares, sellableShares,
    costPrice: num(input?.costPrice, 0, 0, 1e6),
    tShares: paperRoundShares(code, Math.min(tShares, sellableShares || tShares)),
    style,
    minSpreadPct: num(input?.minSpreadPct, DEFAULT_T_CONFIG.minSpreadPct, 0.3, 10),
    commissionPercent: num(input?.commissionPercent, DEFAULT_T_CONFIG.commissionPercent, 0, 1),
    tradingRule: input?.tradingRule === "t0" || input?.tradingRule === "t1" ? input.tradingRule : "auto"
  };
}

/** 场内基金免印花税和过户费，只收佣金（最低 5 元）；股票按 A 股费率。 */
const buyFeeOf = (value: number, commissionPercent: number, code: string) =>
  isExchangeFundCode(code) ? Math.max(5, value * commissionPercent / 100) : calcAshareBuyFee(value, commissionPercent);
const sellFeeOf = (value: number, commissionPercent: number, code: string) =>
  isExchangeFundCode(code) ? Math.max(5, value * commissionPercent / 100) : calcAshareSellFee(value, commissionPercent);

export function priceLimits(code: string, name: string, preClose: number, date?: string) {
  const rate = paperPriceLimitRate(code, name, date);
  if (rate === null || !(preClose > 0)) return { limitUp: null, limitDown: null };
  return { limitUp: round2(preClose * (1 + rate)), limitDown: round2(preClose * (1 - rate)) };
}

/** 按时间顺序配对用户登记的成交：先卖后买是倒T，先买后卖是正T；返回已完成的盈亏和未完成的T。 */
export function settleTrades(trades: TTrade[], config: Pick<TConfig, "baseShares" | "costPrice" | "commissionPercent">, code = ""): { open: TOpen; stats: TStats } {
  const sorted = [...trades].filter(trade => trade.price > 0 && trade.shares > 0).sort((a, b) => a.time.localeCompare(b.time));
  let open = null as TOpen, realized = 0, fees = 0, rounds = 0, wins = 0, tradedShares = 0;
  let lastClosed: TStats["lastClosed"] = null;
  let soldShares = 0, boughtShares = 0;
  const lost = { reverse: false, forward: false };
  for (const trade of sorted) {
    const value = trade.price * trade.shares;
    const fee = trade.side === "sell" ? sellFeeOf(value, config.commissionPercent, code) : buyFeeOf(value, config.commissionPercent, code);
    fees += fee; realized -= fee; tradedShares += trade.shares;
    if (trade.side === "sell") soldShares += trade.shares;
    else boughtShares += trade.shares;
    const kind = trade.side === "sell" ? "reverse" : "forward";
    if (!open || open.kind === kind) {
      const shares: number = (open?.shares ?? 0) + trade.shares;
      open = { kind, shares, price: ((open?.price ?? 0) * (open?.shares ?? 0) + value) / shares, time: open?.time ?? trade.time, fees: (open?.fees ?? 0) + fee };
      continue;
    }
    const closed = Math.min(open.shares, trade.shares);
    const profit = open.kind === "reverse" ? (open.price - trade.price) * closed : (trade.price - open.price) * closed;
    realized += profit;
    const openingFee = (open.fees ?? 0) * closed / open.shares;
    const closingFee = fee * closed / trade.shares;
    const legNet = profit - openingFee - closingFee;
    const rest: number = open.shares - closed;
    const extra = trade.shares - closed;
    const cumulativeNet = (open.closedNet ?? 0) + legNet;
    if (rest === 0) {
      rounds += 1;
      if (cumulativeNet > 0) wins += 1;
      lastClosed = { kind: open.kind, time: trade.time, profit: cumulativeNet };
      if (cumulativeNet < 0) lost[open.kind] = true;
    }
    open = rest > 0
      ? { ...open, shares: rest, fees: (open.fees ?? 0) - openingFee, closedNet: cumulativeNet }
      : extra > 0
        ? { kind, shares: extra, price: trade.price, time: trade.time, fees: fee * extra / trade.shares }
        : null;
  }
  const costReduction = config.baseShares > 0 ? realized / config.baseShares : 0;
  const winRatePct = rounds > 0 ? Math.round((wins / rounds) * 100) : null;
  return {
    open,
    stats: { rounds, wins, winRatePct, realized, fees, costReduction, newCost: config.costPrice > 0 ? config.costPrice - costReduction : null, tradedShares, lastClosed, soldShares, boughtShares, lost }
  };
}

/** 净收益按实际交易量计入最低佣金；部分平仓只分摊对应的开仓费用。 */
function netProfit(kind: "reverse" | "forward", entry: number, exit: number, shares: number, config: TConfig, openingFees: number | undefined, code: string) {
  const entryFee = openingFees ?? (kind === "reverse" ? sellFeeOf : buyFeeOf)(entry * shares, config.commissionPercent, code);
  const exitFee = (kind === "reverse" ? buyFeeOf : sellFeeOf)(exit * shares, config.commissionPercent, code);
  return (kind === "reverse" ? entry - exit : exit - entry) * shares - entryFee - exitFee;
}

function profitTarget(kind: "reverse" | "forward", entry: number, shares: number, config: TConfig, openingFees: number | undefined, code: string) {
  const required = entry * shares * config.minSpreadPct / 100;
  let low = kind === "reverse" ? 0 : entry, high = kind === "reverse" ? entry : entry * 3 + 20;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    const enough = netProfit(kind, entry, mid, shares, config, openingFees, code) >= required;
    if (kind === "reverse" ? enough : !enough) low = mid; else high = mid;
  }
  // 按最小价位取整：股票 0.01 元，场内基金 0.001 元（低价 ETF 按 0.01 取整会多出 1% 以上的价差）。
  const ticks = 1 / priceTickOf(code);
  return kind === "reverse" ? Math.floor(low * ticks + 1e-7) / ticks : Math.ceil(high * ticks - 1e-7) / ticks;
}

function std(values: number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function buildSmartCalibration(params: {
  sampleCount: number;
  sigmaPct: number;
  amplitudePct: number;
  regime: TRegime;
  deviationPct: number;
  stats: Pick<TStats, "rounds" | "wins" | "winRatePct">;
  config: Pick<TConfig, "style" | "minSpreadPct">;
  calibrationOptions?: TCalibrationOptions;
}): TSmartCalibration {
  const { sampleCount, sigmaPct, amplitudePct, regime, deviationPct, stats, config, calibrationOptions } = params;
  const totalRounds = (calibrationOptions?.priorRounds ?? 0) + stats.rounds;
  const totalWins = (calibrationOptions?.priorWins ?? 0) + (stats.wins ?? 0);
  const historicalWinRatePct = totalRounds > 0
    ? Math.round((totalWins / totalRounds) * 100)
    : (stats.winRatePct ?? null);
  const dailyVol = typeof calibrationOptions?.dailyVolatilityPct === "number" && Number.isFinite(calibrationOptions.dailyVolatilityPct)
    ? Number(calibrationOptions.dailyVolatilityPct.toFixed(2))
    : null;

  if (sampleCount < 15) {
    return {
      suitability: "等待数据",
      recommendedStyle: config.style,
      recommendedMinSpreadPct: config.minSpreadPct,
      reason: "开盘样本尚少，等 15 分钟分时结构成形后再评估做T参数",
      historicalWinRatePct,
      totalRounds,
      dailyVolatilityPct: dailyVol
    };
  }
  const winPenaltySpread = historicalWinRatePct !== null && totalRounds >= 2 && historicalWinRatePct < 50 ? 0.2 : 0;
  const volFloor = dailyVol !== null ? dailyVol * 0.25 : 0;
  const recommendedMinSpreadPct = Number(Math.min(3.5, Math.max(0.8, round2(Math.max(sigmaPct * 2.8, volFloor, 0.8) + winPenaltySpread))).toFixed(1));
  let recommendedStyle: TStyle = sigmaPct >= 0.75 || (dailyVol !== null && dailyVol >= 4.2) ? "active" : sigmaPct <= 0.3 && (dailyVol === null || dailyVol <= 2.2) ? "steady" : "balanced";
  if (regime !== "range") recommendedStyle = "steady";
  if (historicalWinRatePct !== null && totalRounds >= 2 && historicalWinRatePct < 50) recommendedStyle = "steady";
  const winNote = historicalWinRatePct !== null ? `（累计 ${totalRounds} 轮胜率 ${historicalWinRatePct}%）` : "";
  const volNote = dailyVol !== null ? ` · 近10日振幅 ${dailyVol.toFixed(1)}%` : "";

  if (amplitudePct > 0 && amplitudePct < 1.0 && sigmaPct < 0.25 && (dailyVol === null || dailyVol < 2.2)) {
    return {
      suitability: "振幅过窄宜观望",
      recommendedStyle: "steady",
      recommendedMinSpreadPct,
      reason: `当前日内振幅仅 ${amplitudePct.toFixed(2)}%${volNote}，扣除手续费后净价差空间极薄，建议少动观望${winNote}`,
      historicalWinRatePct,
      totalRounds,
      dailyVolatilityPct: dailyVol
    };
  }
  if (regime === "up") {
    return {
      suitability: "单边趋势慎做T",
      recommendedStyle,
      recommendedMinSpreadPct,
      reason: `分时单边上涨偏强${volNote}，倒T易卖飞；推荐「${STYLE_LABELS[recommendedStyle]}」档、目标价差 ${recommendedMinSpreadPct.toFixed(1)}%${winNote}`,
      historicalWinRatePct,
      totalRounds,
      dailyVolatilityPct: dailyVol
    };
  }
  if (regime === "down") {
    return {
      suitability: "适宜反T",
      recommendedStyle,
      recommendedMinSpreadPct,
      reason: `分时重心低于均价线${volNote}，正T易接飞刀；推荐「${STYLE_LABELS[recommendedStyle]}」档、目标价差 ${recommendedMinSpreadPct.toFixed(1)}%，仅趁反抽均价线附近做倒T降本${winNote}`,
      historicalWinRatePct,
      totalRounds,
      dailyVolatilityPct: dailyVol
    };
  }
  const suitability: TSuitability = deviationPct <= 0 ? "适宜正T" : "适宜反T";
  return {
    suitability,
    recommendedStyle,
    recommendedMinSpreadPct,
    reason: `分时围绕均价震荡（波动率 ${sigmaPct.toFixed(2)}%${volNote}），推荐「${STYLE_LABELS[recommendedStyle]}」档、目标价差 ${recommendedMinSpreadPct.toFixed(1)}%${winNote}`,
    historicalWinRatePct,
    totalRounds,
    dailyVolatilityPct: dailyVol
  };
}

/** 根据分时波动结构、格局及用户已结算T战绩，生成动态参数校准与做T适宜度建议。 */
export function calibrateTAdvice(share: TimeShareSeries | null, item: TStockItem | TConfig, summary: TSignalSummary | null): TSmartCalibration {
  const code = "code" in item ? String(item.code || "") : "";
  const merged = "config" in item && item.config ? { ...item, ...item.config } : item;
  const config = normalizeTConfig(merged, code);
  const trades = "trades" in item && Array.isArray(item.trades) ? item.trades : [];
  if (!share?.points.length) {
    const { stats } = settleTrades(trades, config, code);
    return {
      suitability: "等待数据",
      recommendedStyle: config.style,
      recommendedMinSpreadPct: config.minSpreadPct,
      reason: "等待分时数据加载后评估波动率与日内格局",
      historicalWinRatePct: stats.winRatePct ?? null
    };
  }
  if (summary) return summary.calibration;
  const { stats } = settleTrades(trades, config, code);
  const evaluated = analyzeT(share, { code, name: ("name" in item ? item.name : "") || code }, config, trades);
  if (evaluated) return evaluated.calibration;
  return {
    suitability: "等待数据",
    recommendedStyle: config.style,
    recommendedMinSpreadPct: config.minSpreadPct,
    reason: "分时数据不足",
    historicalWinRatePct: stats.winRatePct ?? null
  };
}

type Context = { code: string; name: string; preClose: number; date?: string };

/** 用截至第 index 个分时点的数据评估一次（复盘回放时逐点调用）。 */
export function evaluateAt(points: TimeSharePoint[], index: number, context: Context, config: TConfig, open: TOpen, stats: TStats, calibrationOptions?: TCalibrationOptions): TAnalysis {
  const now = points[index]!;
  const t0 = resolveT0(context.code, context.name, config.tradingRule);
  const decimals = priceDecimalsOf(context.code);
  const fmt = (value: number) => value.toFixed(decimals);
  const price = now.price, vwap = now.average > 0 ? now.average : price;
  const preClose = context.preClose;
  const history = points.slice(0, index + 1);
  const window = history.slice(-90);
  const deviations = window.map(point => (point.price - point.average) / (point.average || point.price));
  const sigmaPct = std(deviations) * 100;
  const halfBandPct = Math.max(BAND_K[config.style] * sigmaPct, config.minSpreadPct / 2, 0.3);
  const upper = vwap * (1 + halfBandPct / 100), lower = vwap * (1 - halfBandPct / 100);
  const high = Math.max(...history.map(point => point.price)), low = Math.min(...history.map(point => point.price));
  const { limitUp, limitDown } = priceLimits(context.code, context.name, preClose, context.date);

  // 当日格局：近 30 分钟均价线和价格的涨跌 + 近 60 分钟价格在均价线上方的时间占比。
  const back = history[Math.max(0, history.length - 31)]!;
  const vwapSlope = pct(vwap, back.average || back.price);
  // 看近 60 分钟：一波急拉急跌只占半小时，不算单边；持续一小时站在均价线一侧才算。
  const recent60 = history.slice(-60);
  const aboveShare = recent60.filter(point => point.price > point.average).length / Math.max(1, recent60.length);
  // 均价线是累计平均，趋势里会滞后，所以同时看近 30 分钟价格本身的涨跌。
  const priceSlope = pct(price, back.price);
  // 开盘头 20 分钟样本太少，不下「单边」的结论。
  const settled = history.length >= 20;
  const regime: TRegime = !settled ? "range" : aboveShare >= 0.8 && (vwapSlope > 0.25 || priceSlope > 0.6) ? "up"
    : aboveShare <= 0.2 && (vwapSlope < -0.25 || priceSlope < -0.6) ? "down" : "range";
  const regimeText = !settled ? "开盘不久，方向还没走出来" : regime === "up" ? "单边上涨：价格持续在均价线上方，倒T容易卖飞" : regime === "down" ? "单边下跌：价格持续在均价线下方，正T容易接飞刀"
    : aboveShare >= 0.8 ? "偏强震荡：近一小时一直在均价线上方，但没有继续走高；回到下轨附近才考虑低吸"
    : aboveShare <= 0.2 ? "偏弱震荡：近一小时一直在均价线下方，但没有继续走低；反弹到上轨附近才考虑高抛"
    : "震荡：价格围绕均价线来回，适合高抛低吸";

  const last5 = history.slice(-5), prev = history[history.length - 2] ?? now;
  const recentHigh = Math.max(...last5.map(point => point.price)), recentLow = Math.min(...last5.map(point => point.price));
  const prev2 = history[history.length - 3] ?? prev;
  const turningDown = price < prev.price && prev.price < prev2.price;
  const turningUp = price > prev.price && prev.price > prev2.price;
  const ref3 = history[Math.max(0, history.length - 4)]!;
  const momentumPct = pct(price, ref3.price);
  const sessionVolumes = history.slice(1).map(point => point.volume);
  const averageVolume = sessionVolumes.length ? sessionVolumes.reduce((sum, value) => sum + value, 0) / sessionVolumes.length : 0;
  const recentVolume = last5.reduce((sum, point) => sum + point.volume, 0) / last5.length;
  const volumeRatio = averageVolume > 0 ? recentVolume / averageVolume : 1;
  const deviationPct = pct(price, vwap);
  // 急拉（急跌）远离均价线两倍带宽以上、并已从 5 分钟高点（低点）回落（反弹）0.3%：单边里也允许小仓位做一次。
  const spikeDown = deviationPct >= halfBandPct * 2 && pct(recentHigh, price) >= 0.3;
  const spikeUp = -deviationPct >= halfBandPct * 2 && pct(price, recentLow) >= 0.3;
  const nearLimitUp = limitUp !== null && price >= limitUp * 0.985;
  const sealedUp = limitUp !== null && price >= limitUp - 0.005;
  const nearLimitDown = limitDown !== null && price <= limitDown * 1.015;

  const stopPct = Math.max(STOP_PCT[config.style], config.minSpreadPct * 1.5);
  let sellTarget: number | null = null, buyTarget: number | null = null, stop: number | null = null;
  const amplitudePct = preClose > 0 ? ((high - low) / preClose) * 100 : 0;
  const calibration = buildSmartCalibration({
    sampleCount: history.length,
    sigmaPct,
    amplitudePct,
    regime,
    deviationPct,
    stats,
    config,
    ...(calibrationOptions ? { calibrationOptions } : {})
  });
  const base = {
    time: now.time, slot: now.slot, price, changePct: pct(price, preClose), preClose,
    regime, regimeText, deviationPct, bandPct: halfBandPct, sigmaPct: round2(sigmaPct), vwap: Number(vwap.toFixed(decimals)),
    momentumPct, volumeRatio, open, stats, calibration, t0, priceDigits: decimals
  };
  const reasonsBase = [`现价 ${fmt(price)}，均价 ${fmt(vwap)}（偏离 ${deviationPct >= 0 ? "+" : ""}${deviationPct.toFixed(2)}%）`];
  const done = (signal: TSignal): TAnalysis => ({ ...base, levels: { vwap, upper, lower, high, low, sellTarget, buyTarget, stop, limitUp, limitDown }, signal });
  const wait = (title: string, reasons: string[], strength: TStrength = "watch"): TAnalysis => done({ action: "wait", strength, title, price, shares: 0, reasons: [...reasonsBase, ...reasons] });

  if (!open && t0 && config.tShares <= 0 && config.sellableShares <= 0) return wait("先填做T股数", ["T+0 品种当天买入当天可卖，没有底仓也能先买后卖；请在「持仓与参数」里填写每次做T的股数（有底仓的同时填写底仓和可卖）"]);
  if (!open && !t0 && (config.sellableShares <= 0 || config.tShares <= 0)) return wait("先填底仓", ["做T需要已有可卖底仓（T+1），请先在「持仓与参数」里填写底仓和今日可卖股数"]);
  if (history.length < 5) return wait("数据不足", ["开盘不足 5 分钟，等分时走出来再看"]);
  if (now.slot >= 240) {
    return wait("今日已收盘", open ? [`还有${open.kind === "reverse" ? "倒T未接回" : "正T未卖出"} ${open.shares} 股，持仓股数和计划不一致，明天开盘留意处理`] : ["收盘后不再给提示；可以看下方的信号回放检验参数，下个交易日开盘自动跟踪"]);
  }
  if (now.slot >= AUCTION_SLOT) {
    return wait("收盘集合竞价", open ? [`还有${open.kind === "reverse" ? "倒T未接回" : "正T未卖出"} ${open.shares} 股，竞价阶段只能挂单，按计划处理`] : ["14:57 以后是收盘集合竞价，不再做T"]);
  }
  // T+1：今天卖过的底仓不会回来（买回的要明天才能卖），剩余可卖 = 今日可卖 − 今天已卖出。
  // T+0：今天买入的当天就能卖，剩余可卖 = 今日可卖 − 今天已卖出 + 今天已买入。
  const remaining = Math.max(0, config.sellableShares - stats.soldShares + (t0 ? stats.boughtShares ?? 0 : 0));
  // 倒T（先卖）要用剩余可卖；T+0 的正T（先买）卖的是当天买入的份额，不受底仓限制。
  const tShares = paperRoundShares(context.code, Math.min(config.tShares || config.sellableShares, remaining));
  const buyShares = t0 ? paperRoundShares(context.code, config.tShares || config.sellableShares) : tShares;

  if (open?.kind === "reverse") {
    // 已卖出一部分底仓，等回落接回。
    const lot = paperLotRule(context.code);
    const buyShares = Math.max(lot.min, paperRoundShares(context.code, open.shares) || lot.min);
    const profitable = profitTarget("reverse", open.price, buyShares, config, open.fees, context.code);
    buyTarget = Math.min(vwap, profitable);
    stop = open.price * (1 + stopPct / 100);
    const gain = pct(open.price, price);
    const status = [`已于 ${open.time} 卖出 ${open.shares} 股，均价 ${fmt(open.price)}，现在接回毛价差${gain >= 0 ? "盈利" : "亏损"} ${Math.abs(gain).toFixed(2)}%`];
    const lotNote = buyShares > open.shares ? [`科创板/本板块单笔买入不少于 ${lot.min} 股，接回按最低申报数 ${buyShares} 股测算`] : [];
    if (sealedUp) return wait("涨停封板中，倒T未完成", [...status, "接回可能无法成交，保持少仓风险仍在；尾盘也不能视为已经接回"], "normal");
    if (now.slot >= CLOSE_SLOT) return done({ action: "closeBuyBack", strength: "strong", title: "尾盘接回", price, shares: buyShares, reasons: [...reasonsBase, ...status, ...lotNote, "14:45 后尽量接回，保持底仓股数不变，避免隔夜少了筹码"] });
    if (price >= stop) return done({ action: "stopBuyBack", strength: "strong", title: "止损接回", price, shares: buyShares, reasons: [...reasonsBase, ...status, ...lotNote, `已涨过止损位 ${fmt(stop)}，走势转强，先把筹码接回来`] });
    // 均价线离得远时：已经有最小价差、并从 5 分钟低点反弹 0.3% 以上，先落袋，不死等均价线。
    if (price > buyTarget && price <= profitable && turningUp && pct(price, recentLow) >= 0.3) return done({ action: "buyBack", strength: "normal", title: "接回", price, shares: buyShares, reasons: [...reasonsBase, ...status, ...lotNote, `还没回到均价线，但扣费后达到净价差目标并开始反弹，先接回落袋`] });
    if (price <= buyTarget && turningUp) return done({ action: "buyBack", strength: price <= lower ? "strong" : "normal", title: "接回", price, shares: buyShares, reasons: [...reasonsBase, ...status, ...lotNote, `回落到接回价 ${fmt(buyTarget)} 以下且开始企稳`] });
    if (price <= buyTarget) return wait("到接回区，等企稳", [...status, `已到接回价 ${fmt(buyTarget)}，但还在往下走，等止跌拐头再接`], "normal");
    return wait("等回落接回", [...status, `接回价 ${fmt(buyTarget)}，止损价 ${fmt(stop)}`]);
  }

  if (open?.kind === "forward") {
    // 已买入，等反弹卖出等量底仓。
    const rawSellable = Math.min(open.shares, remaining);
    // A股卖出零股规则：一次性清掉全部剩余可卖股数时允许零股；否则必须满足板块最低申报单位与步长。
    const sellable = rawSellable === remaining ? rawSellable : paperRoundShares(context.code, rawSellable);
    const profitable = profitTarget("forward", open.price, sellable || open.shares, config, open.fees === undefined ? undefined : open.fees * (sellable || open.shares) / open.shares, context.code);
    sellTarget = Math.max(vwap, profitable);
    stop = open.price * (1 - stopPct / 100);
    const gain = pct(price, open.price);
    const status = [`已于 ${open.time} 买入 ${open.shares} 股，均价 ${fmt(open.price)}，现在卖出毛价差${gain >= 0 ? "盈利" : "亏损"} ${Math.abs(gain).toFixed(2)}%`];
    if (sellable <= 0) return wait("没有可卖底仓", [...status, t0 ? "今日可卖已用完或不足申报单位，暂时不能卖出" : "T+1：今天买入的股票当天不能卖，今日可卖的底仓不足申报单位或已用完，这笔只能留到明天"]);
    const short = sellable < open.shares ? [`今日可卖只剩 ${sellable} 股，少于买入的 ${open.shares} 股，其余要留到明天`] : [];
    const sellTitle = t0 ? "卖出" : "卖出底仓";
    const holdNote = t0 ? "14:45 后卖出当天买入的份额，避免隔夜多出仓位" : "14:45 后卖出等量底仓，保持持仓股数不变";
    if (limitDown !== null && price <= limitDown + 0.005) return wait("跌停封板中，正T未完成", [...status, ...short, "卖出可能无法成交，新增仓位风险仍在；尾盘也不能视为已经卖出"], "normal");
    if (now.slot >= CLOSE_SLOT) return done({ action: "closeSellBack", strength: "strong", title: `尾盘${sellTitle}`, price, shares: sellable, reasons: [...reasonsBase, ...status, ...short, holdNote] });
    if (price <= stop) return done({ action: "stopSellBack", strength: "strong", title: "止损卖出", price, shares: sellable, reasons: [...reasonsBase, ...status, ...short, `已跌破止损位 ${fmt(stop)}，走势转弱，${t0 ? "卖出买入的份额" : "卖出等量底仓"}控制仓位`] });
    if (price < sellTarget && price >= profitable && turningDown && pct(recentHigh, price) >= 0.3) return done({ action: "sellBack", strength: "normal", title: sellTitle, price, shares: sellable, reasons: [...reasonsBase, ...status, ...short, `还没回到均价线，但扣费后达到净价差目标并开始回落，先卖出落袋`] });
    if (price >= sellTarget && turningDown) return done({ action: "sellBack", strength: price >= upper ? "strong" : "normal", title: sellTitle, price, shares: sellable, reasons: [...reasonsBase, ...status, ...short, `反弹到卖出价 ${fmt(sellTarget)} 以上且开始拐头`] });
    if (price >= sellTarget) return wait("到卖出区，等拐头", [...status, `已到卖出价 ${fmt(sellTarget)}，还在往上冲，拐头再卖`], "normal");
    return wait("等反弹卖出", [...status, `卖出价 ${fmt(sellTarget)}，止损价 ${fmt(stop)}`]);
  }

  // 没有未完成的T：找开仓机会。
  sellTarget = upper; buyTarget = lower;
  if (now.slot >= CLOSE_SLOT) return wait("尾盘不再开新T", ["14:45 以后时间不够完成一买一卖，今天不再开新的T"]);
  if (stats.rounds >= MAX_ROUNDS[config.style]) return wait("今天做够了", [`已完成 ${stats.rounds} 次T（${STYLE_LABELS[config.style]}风格每天最多 ${MAX_ROUNDS[config.style]} 次），频繁做T容易被来回打脸`]);
  if (tShares <= 0 && buyShares <= 0) return wait("可卖底仓已用完", [`今日可卖 ${config.sellableShares} 股，今天已卖出 ${stats.soldShares} 股；T+1 下买回的股票明天才能卖，剩余不足申报单位时也不能再开T`]);
  const last = stats.lastClosed;
  const lastSlot = last ? timeShareSlot(last.time) : null;
  const sinceLast = lastSlot === null ? Infinity : now.slot - lastSlot;
  if (sinceLast < COOLDOWN_MINUTES) return wait("刚做完一次，先冷静", [`上一次T在 ${last!.time} 完成，隔 ${COOLDOWN_MINUTES} 分钟再看下一次`]);
  // 止损过的方向当天不再做：说明今天的走势和这个方向相反。
  const blockedReverse = stats.lost.reverse;
  const blockedForward = stats.lost.forward;
  if (now.slot < OPEN_NOISE_SLOT) return wait("开盘波动，先观察", ["开盘前 15 分钟不新开T，已有未完成T仍按止损和收尾规则跟踪"]);
  const strongBand = halfBandPct * 1.6;
  const volumeNote = volumeRatio >= 1.5 ? `近 5 分钟放量（${volumeRatio.toFixed(1)} 倍）` : volumeRatio <= 0.6 ? `近 5 分钟缩量（${volumeRatio.toFixed(1)} 倍）` : "";

  if (price >= upper) {
    if (tShares <= 0) return wait("没有可卖份额，不能先卖", ["倒T要先卖出已有的可卖份额；T+0 品种可以等回落到下轨时先买后卖"]);
    if (sealedUp) return wait("涨停封板中", ["封板时不做倒T，避免卖在板上；炸板回落再考虑"], "normal");
    if (!turningDown) return wait("冲高中，等拐头再卖", [`已到上轨 ${fmt(upper)}，还在往上走`, volumeNote].filter(Boolean), "normal");
    if (netProfit("reverse", price, vwap, tShares, config, undefined, context.code) < price * tShares * config.minSpreadPct / 100) return wait("价差不足以覆盖成本", ["回到均价线的预计空间不足以覆盖双边费用和最低净价差，不新开倒T"]);
    if (blockedReverse) return wait("今天不再倒T", ["今天的倒T亏损接回过，说明走势偏强，先不做先卖后买"], "normal");
    if (regime === "up" && !(volumeRatio >= 1.5 && momentumPct <= 0.1) && !spikeDown) return wait("单边上涨，谨慎倒T", [regimeText, "强势单边时卖出容易接不回，除非放量滞涨"], "normal");
    const strong = regime !== "up" && (deviationPct >= strongBand || (volumeRatio >= 1.5 && momentumPct <= 0.1) || price >= high * 0.997);
    return done({ action: "sell", strength: strong ? "strong" : "normal", title: "高抛（倒T）", price, shares: tShares, reasons: [
      ...reasonsBase, `冲到上轨 ${fmt(upper)} 以上后拐头`, regime === "up" ? "今天整体偏强，只是急拉后回落，接回要果断" : "", volumeNote, nearLimitUp ? "接近涨停，留意是否回封" : "",
      `接回参考 ${fmt(Math.min(vwap, profitTarget("reverse", price, tShares, config, undefined, context.code)))}，若涨过 ${fmt(price * (1 + stopPct / 100))} 止损接回`
    ].filter(Boolean) });
  }
  if (price <= lower) {
    if (nearLimitDown) return wait("接近跌停，不接", ["接近跌停时不做正T，等跌停打开、企稳后再说"], "normal");
    if (!turningUp) return wait("下探中，等企稳再买", [`已到下轨 ${fmt(lower)}，还在往下走`, volumeNote].filter(Boolean), "normal");
    if (netProfit("forward", price, vwap, buyShares, config, undefined, context.code) < price * tShares * config.minSpreadPct / 100) return wait("价差不足以覆盖成本", ["回到均价线的预计空间不足以覆盖双边费用和最低净价差，不新开正T"]);
    if (blockedForward) return wait("今天不再正T", ["今天的正T亏损卖出过，说明走势偏弱，先不做先买后卖"], "normal");
    if (regime === "down" && !spikeUp) return wait("单边下跌，谨慎正T", [regimeText, "弱势单边时低吸容易越买越跌"], "normal");
    const strong = regime !== "down" && (-deviationPct >= strongBand || price <= low * 1.003);
    return done({ action: "buy", strength: strong ? "strong" : "normal", title: "低吸（正T）", price, shares: buyShares, reasons: [
      ...reasonsBase, `回落到下轨 ${fmt(lower)} 以下后企稳`, regime === "down" ? "今天整体偏弱，只是急跌后反弹，卖出要果断" : "", volumeNote,
      `卖出参考 ${fmt(Math.max(vwap, profitTarget("forward", price, buyShares, config, undefined, context.code)))}，若跌破 ${fmt(price * (1 - stopPct / 100))} 止损卖出${t0 ? "" : "底仓"}`, t0 ? "T+0：今天买入的份额今天就能卖" : ""
    ].filter(Boolean) });
  }
  return wait("观望", [`在上下轨（${fmt(lower)}–${fmt(upper)}）之间，没有足够的做T空间`, regimeText]);
}

const ACTIONABLE: TAction[] = ["sell", "buy", "buyBack", "sellBack", "stopBuyBack", "stopSellBack", "closeBuyBack", "closeSellBack"];
/** 场内基金免印花税和过户费的费用口径（界面估算现金流时与引擎保持一致）。 */
export const tBuyFee = buyFeeOf;
export const tSellFee = sellFeeOf;
export const isActionable = (signal: TSignal) => ACTIONABLE.includes(signal.action) && signal.shares > 0;
export const actionSide = (action: TAction): TSide | null =>
  ["sell", "sellBack", "stopSellBack", "closeSellBack"].includes(action) ? "sell" : ["buy", "buyBack", "stopBuyBack", "closeBuyBack"].includes(action) ? "buy" : null;

/** 当前状态：按用户登记的成交算未完成的T和盈亏，再用最新分时点评估。 */
export function analyzeT(share: TimeShare | null, context: Omit<Context, "preClose">, config: TConfig, trades: TTrade[], calibrationOptions?: TCalibrationOptions): TAnalysis | null {
  if (!share?.points.length) return null;
  const { open, stats } = settleTrades(trades, config, context.code);
  return evaluateAt(share.points, share.points.length - 1, { ...context, preClose: share.preClose, date: share.date }, config, open, stats, calibrationOptions);
}

/**
 * 今日信号回放：假设从开盘起完全按信号操作（每次 config.tShares 股），逐分钟模拟一遍。
 * 用于在分时图上标出信号位置、检验当前参数今天是否有效；不代表真实成交。
 */
export function replayT(share: TimeShare | null, context: Omit<Context, "preClose">, config: TConfig): TReplay {
  const empty: TReplay = { markers: [], rounds: 0, realized: 0, open: null };
  const t0 = resolveT0(context.code, context.name, config.tradingRule);
  if (!share?.points.length || (t0 ? config.tShares <= 0 && config.sellableShares <= 0 : config.sellableShares <= 0)) return empty;
  const trades: TTrade[] = [];
  const markers: TMarker[] = [];
  const ctx = { ...context, preClose: share.preClose, date: share.date };
  for (let index = 4; index < share.points.length; index += 1) {
    const { open, stats } = settleTrades(trades, config, context.code);
    const result = evaluateAt(share.points, index, ctx, config, open, stats);
    const side = actionSide(result.signal.action);
    if (!side || !isActionable(result.signal) || result.signal.strength === "watch") continue;
    const point = share.points[index]!;
    trades.push({ id: `r${index}`, side, price: point.price, shares: result.signal.shares, time: point.time });
    markers.push({ slot: point.slot, time: point.time, side, price: point.price, label: result.signal.title, virtual: true });
  }
  const { open, stats } = settleTrades(trades, config, context.code);
  return { markers, rounds: stats.rounds, realized: stats.realized, open };
}
