import { inferSecid } from "../../domain/securityIdentifiers";
import { isTradingDay } from "../notes/notesModel";
import { normalizeTConfig, settleTrades, type TAction, type TAnalysis, type TConfig, type TSide, type TTrade } from "./tEngine";

/** 做T助手的本地数据：跟踪的股票和各自参数、按交易日登记的成交、提醒开关。只存在本机。 */
export type TItem = {
  code: string;
  name: string;
  secid: string;
  config: TConfig;
  addedAt: string;
  rolledTradeIds?: string[] | undefined;
};
export type TStore = {
  items: TItem[];
  /** 交易日 → 股票代码 → 当天登记的成交。只保留最近几个交易日。 */
  trades: Record<string, Record<string, TTrade[]>>;
  voice: boolean;
  showReplay: boolean;
  /** 最近一次完成跨日 T+1 底仓滚动的交易日（YYYY-MM-DD）。 */
  lastRolloverDay?: string | undefined;
};
export const T_STORE_KEY = "a-stock-radar:t-assistant:v1";
export const MAX_T_ITEMS = 12;
const KEEP_DAYS = 10;
export const MAX_T_TRADES = 1000;

export const EMPTY_T_STORE: TStore = { items: [], trades: {}, voice: true, showReplay: true };
export const secidForCode = inferSecid;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizeTrade(value: unknown): TTrade | null {
  if (!isRecord(value)) return null;
  const side: TSide | null = value.side === "buy" || value.side === "sell" ? value.side : null;
  const price = Number(value.price), shares = Math.floor(Number(value.shares));
  const time = String(value.time || "");
  if (!side || !Number.isFinite(price) || !Number.isFinite(shares) || !(price > 0) || !(shares > 0) || !TIME.test(time)) return null;
  return { id: String(value.id || `${time}-${side}-${price}-${shares}`).slice(0, 40), side, price: Math.round(price * 1000) / 1000, shares, time };
}

export function normalizeTStore(value: unknown): TStore {
  if (!isRecord(value)) return { ...EMPTY_T_STORE };
  const seen = new Set<string>();
  const items: TItem[] = [];
  for (const raw of Array.isArray(value.items) ? value.items : []) {
    if (!isRecord(raw)) continue;
    const code = String(raw.code || "");
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    const rolledTradeIds = Array.isArray(raw.rolledTradeIds)
      ? [...new Set(raw.rolledTradeIds.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(-2000)
      : undefined;
    items.push({
      code,
      name: String(raw.name || code).slice(0, 16),
      secid: typeof raw.secid === "string" && /^[01]\.\d{6}$/.test(raw.secid) ? raw.secid : secidForCode(code),
      config: normalizeTConfig(isRecord(raw.config) ? raw.config : null, code),
      addedAt: String(raw.addedAt || ""),
      ...(rolledTradeIds ? { rolledTradeIds } : {})
    });
    if (items.length >= MAX_T_ITEMS) break;
  }
  const trades: TStore["trades"] = {};
  const days = isRecord(value.trades) ? Object.keys(value.trades).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().slice(-KEEP_DAYS) : [];
  for (const day of days) {
    const byCode = (value.trades as Record<string, unknown>)[day];
    if (!isRecord(byCode)) continue;
    const entries = Object.entries(byCode)
      .filter(([code]) => /^\d{6}$/.test(code))
      .map(([code, list]) => [code, (Array.isArray(list) ? list : []).map(normalizeTrade).filter((trade): trade is TTrade => Boolean(trade))] as const)
      .filter(([, list]) => list.length > 0);
    if (entries.length) trades[day] = Object.fromEntries(entries);
  }
  const lastRolloverDay = typeof value.lastRolloverDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.lastRolloverDay) ? value.lastRolloverDay : undefined;
  return {
    items, trades, voice: value.voice !== false, showReplay: value.showReplay !== false,
    ...(lastRolloverDay ? { lastRolloverDay } : {})
  };
}

export function withTrades(store: TStore, day: string, code: string, update: (trades: TTrade[]) => TTrade[]): TStore {
  const current = store.trades[day]?.[code] || [];
  const next = update(current);
  if (next.length > MAX_T_TRADES && next.length > current.length) throw new Error(`当日单股成交登记已达 ${MAX_T_TRADES} 条上限，请先核对已有记录`);
  const dayTrades = { ...(store.trades[day] || {}) };
  if (next.length) dayTrades[code] = next; else delete dayTrades[code];
  const trades = { ...store.trades };
  if (Object.keys(dayTrades).length) trades[day] = dayTrades; else delete trades[day];
  return normalizeTStore({ ...store, trades });
}

/** 北京时间是否在连续竞价时段（交易日 9:25–11:30、13:00–15:00，跳过法定节假日与周末）。 */
export function inTradingSession(now = new Date()): boolean {
  const cn = new Date(now.getTime() + 8 * 3600_000);
  const date = cn.toISOString().slice(0, 10);
  const minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  return isTradingDay(date) && ((minute >= 9 * 60 + 25 && minute <= 11 * 60 + 30) || (minute >= 13 * 60 && minute <= 15 * 60));
}

/** 北京时间 HH:MM。 */
export function shanghaiClock(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(11, 16);
}

export function shanghaiDay(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 以行情所属日和交易时段有效分钟为准，兼容 09:25–09:30 集合竞价归一及 11:30–13:00 午间休市跨度。 */
export function isFreshTQuote(date: string | undefined, time: string | undefined, now = new Date()): boolean {
  if (date !== shanghaiDay(now) || !time || !TIME.test(time)) return false;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const nowMin = minutes(shanghaiClock(now));
  const quoteMin = minutes(time);
  if (nowMin >= 565 && nowMin <= 570 && quoteMin === 570) return true;
  if (quoteMin > nowMin) return false;
  const toSessionMinutes = (m: number) => m <= 570 ? m : m <= 690 ? m : m < 780 ? 690 : m - 90;
  const lag = toSessionMinutes(nowMin) - toSessionMinutes(quoteMin);
  return lag >= 0 && lag <= 2;
}

export type AlertMemory = Record<string, { action: TAction; at: number; date?: string; signalTime?: string }>;
/**
 * 同一只股票同一个动作 5 分钟内只提醒一次；动作变了（比如从「高抛」变成「接回」）马上提醒。
 * 只提醒最新一分钟内出现的信号，打开软件时看到的旧信号不响。
 */
export function shouldAlert(memory: AlertMemory, code: string, action: TAction, signalTime: string, nowMs: number, nowClock: string, signalDate = shanghaiDay(new Date(nowMs))): boolean {
  if (action === "wait" || !isFreshTQuote(signalDate, signalTime, new Date(nowMs))) return false;
  const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  if (!TIME.test(signalTime) || !TIME.test(nowClock) || Math.abs(toMinutes(nowClock) - toMinutes(signalTime)) > 2) return false;
  const last = memory[code];
  if (last?.date && last.date !== signalDate) return true;
  if (last?.action === action && last.signalTime === signalTime) return false;
  return !last || last.action !== action || nowMs - last.at >= 5 * 60_000;
}

/** 仅核对最近一个已登记交易日；不把昨日买卖混入今日 T+1 可卖计算。 */
export function previousOpenT(store: TStore, code: string, day: string) {
  const item = store.items.find(entry => entry.code === code);
  const date = Object.keys(store.trades).filter(date => date < day && store.trades[date]?.[code]?.length).sort().at(-1);
  if (!item || !date) return null;
  const { open } = settleTrades(store.trades[date]?.[code] || [], item.config);
  return open ? { date, open } : null;
}

export function collectRolledTradeIdsThrough(store: Pick<TStore, "trades">, code: string, throughDate: string): string[] {
  const ids: string[] = [];
  for (const date of Object.keys(store.trades).sort()) {
    if (date > throughDate) continue;
    for (const trade of store.trades[date]?.[code] || []) {
      ids.push(`${date}:${trade.id}`);
    }
  }
  return ids.slice(-2000);
}

/**
 * 新交易日 T+1 底仓自动滚动：
 * - 对上次滚动日之后、今天之前已登记的昨日买卖计算净股数变化，滚入今日底仓与可卖股数（买回的今日解锁可卖）；
 * - 若未填写持仓成本且本机持仓已有成本价，顺手补齐成本价（不覆盖用户手工修改）。
 */
export function rolloverTStoreForDay(
  store: TStore,
  today = shanghaiDay(),
  holdings?: Array<{ code: string; shares?: number; costPrice?: number }>
): { store: TStore; changed: boolean; rolled: Array<{ code: string; name: string; sellableShares: number; baseShares: number }> } {
  const holdingByCode = new Map((holdings || []).map(h => [String(h.code || ""), h]));
  if (store.lastRolloverDay === today) {
    let filledCost = false;
    const items = store.items.map(item => {
      const h = holdingByCode.get(item.code);
      if (h && item.config.costPrice <= 0 && Number(h.costPrice) > 0) {
        filledCost = true;
        return { ...item, config: normalizeTConfig({ ...item.config, costPrice: Number(h.costPrice) }, item.code) };
      }
      return item;
    });
    if (!filledCost) return { store, changed: false, rolled: [] };
    return { store: normalizeTStore({ ...store, items }), changed: true, rolled: [] };
  }

  const prevDay = store.lastRolloverDay || "";
  const rolled: Array<{ code: string; name: string; sellableShares: number; baseShares: number }> = [];
  const activeKeys = new Set<string>();
  for (const [date, byCode] of Object.entries(store.trades)) {
    for (const [code, list] of Object.entries(byCode || {})) {
      for (const trade of list) activeKeys.add(`${code}|${date}:${trade.id}`);
    }
  }
  const nextItems = store.items.map(item => {
    const initialRolled = item.rolledTradeIds !== undefined
      ? item.rolledTradeIds
      : prevDay
        ? collectRolledTradeIdsThrough(store, item.code, prevDay).filter(key => key.slice(0, 10) < prevDay)
        : [];
    const rolledSet = new Set(initialRolled.filter(key => activeKeys.has(`${item.code}|${key}`)));
    const candidateDates = Object.keys(store.trades)
      .filter(date => date < today && (store.trades[date]?.[item.code]?.length || 0) > 0)
      .sort();
    let netDelta = 0;
    let newlyRolled = 0;
    for (const date of candidateDates) {
      for (const trade of store.trades[date]?.[item.code] || []) {
        const key = `${date}:${trade.id}`;
        if (rolledSet.has(key)) continue;
        rolledSet.add(key);
        newlyRolled += 1;
        netDelta += trade.side === "buy" ? trade.shares : -trade.shares;
      }
    }
    const nextBase = newlyRolled > 0 ? Math.max(0, item.config.baseShares + netDelta) : item.config.baseShares;
    const shouldPromoteSellable = Boolean((prevDay && prevDay < today) || newlyRolled > 0);
    const nextSellable = shouldPromoteSellable ? nextBase : item.config.sellableShares;
    const h = holdingByCode.get(item.code);
    const nextCost = item.config.costPrice <= 0 && h && Number(h.costPrice) > 0 ? Number(h.costPrice) : item.config.costPrice;
    const nextRolledList = [...rolledSet];
    const rolledListChanged = item.rolledTradeIds === undefined
      ? nextRolledList.length > 0
      : nextRolledList.length !== item.rolledTradeIds.length || nextRolledList.some((k, idx) => k !== item.rolledTradeIds![idx]);
    const configChanged = nextBase !== item.config.baseShares || nextSellable !== item.config.sellableShares || nextCost !== item.config.costPrice;
    if (!configChanged && !rolledListChanged) return item;
    const normalizedConfig = normalizeTConfig({
      ...item.config,
      baseShares: nextBase,
      sellableShares: nextSellable,
      costPrice: nextCost
    }, item.code);
    if (normalizedConfig.sellableShares !== item.config.sellableShares || normalizedConfig.baseShares !== item.config.baseShares) {
      rolled.push({ code: item.code, name: item.name, sellableShares: normalizedConfig.sellableShares, baseShares: normalizedConfig.baseShares });
    }
    return {
      ...item,
      config: normalizedConfig,
      ...(nextRolledList.length > 0 || item.rolledTradeIds !== undefined ? { rolledTradeIds: nextRolledList } : {})
    };
  });

  const nextStore = normalizeTStore({ ...store, items: nextItems, lastRolloverDay: today });
  return { store: nextStore, changed: true, rolled };
}

export function summarizeTStoreForAgent(
  store: TStore,
  runtimes?: Record<string, { analysis?: TAnalysis | null } | undefined>
) {
  return store.items.map(item => {
    const analysis = runtimes?.[item.code]?.analysis || null;
    const base = item.config.baseShares;
    const sellableRatioPct = base > 0 ? Math.round((item.config.sellableShares / base) * 100) : null;
    return {
      code: item.code,
      name: item.name,
      style: item.config.style === "steady" ? "稳健" : item.config.style === "active" ? "积极" : "均衡",
      costPrice: item.config.costPrice > 0 ? item.config.costPrice : null,
      sellableRatioPct,
      minSpreadPct: item.config.minSpreadPct,
      roundsToday: analysis?.stats.rounds ?? 0,
      realizedToday: analysis?.stats.realized ?? null,
      openT: analysis?.open ? { kind: analysis.open.kind, time: analysis.open.time, price: analysis.open.price } : null,
      suitability: analysis?.calibration.suitability || ""
    };
  });
}
