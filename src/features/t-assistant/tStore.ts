import { normalizeTConfig, type TAction, type TConfig, type TSide, type TTrade } from "./tEngine";

/** 做T助手的本地数据：跟踪的股票和各自参数、按交易日登记的成交、提醒开关。只存在本机。 */
export type TItem = { code: string; name: string; secid: string; config: TConfig; addedAt: string };
export type TStore = {
  items: TItem[];
  /** 交易日 → 股票代码 → 当天登记的成交。只保留最近几个交易日。 */
  trades: Record<string, Record<string, TTrade[]>>;
  voice: boolean;
  showReplay: boolean;
};
export const T_STORE_KEY = "a-stock-radar:t-assistant:v1";
export const MAX_T_ITEMS = 12;
const KEEP_DAYS = 10;

export const EMPTY_T_STORE: TStore = { items: [], trades: {}, voice: true, showReplay: true };
export const secidForCode = (code: string) => `${code.startsWith("6") || code.startsWith("9") ? "1" : "0"}.${code}`;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizeTrade(value: unknown): TTrade | null {
  if (!isRecord(value)) return null;
  const side: TSide | null = value.side === "buy" || value.side === "sell" ? value.side : null;
  const price = Number(value.price), shares = Math.floor(Number(value.shares));
  const time = String(value.time || "");
  if (!side || !(price > 0) || !(shares > 0) || !TIME.test(time)) return null;
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
    items.push({
      code,
      name: String(raw.name || code).slice(0, 16),
      secid: typeof raw.secid === "string" && /^[01]\.\d{6}$/.test(raw.secid) ? raw.secid : secidForCode(code),
      config: normalizeTConfig(isRecord(raw.config) ? raw.config : null, code),
      addedAt: String(raw.addedAt || "")
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
      .map(([code, list]) => [code, (Array.isArray(list) ? list : []).map(normalizeTrade).filter((trade): trade is TTrade => Boolean(trade)).slice(0, 60)] as const)
      .filter(([, list]) => list.length > 0);
    if (entries.length) trades[day] = Object.fromEntries(entries);
  }
  return { items, trades, voice: value.voice !== false, showReplay: value.showReplay !== false };
}

export function withTrades(store: TStore, day: string, code: string, update: (trades: TTrade[]) => TTrade[]): TStore {
  const current = store.trades[day]?.[code] || [];
  const next = update(current).slice(0, 60);
  const dayTrades = { ...(store.trades[day] || {}) };
  if (next.length) dayTrades[code] = next; else delete dayTrades[code];
  const trades = { ...store.trades };
  if (Object.keys(dayTrades).length) trades[day] = dayTrades; else delete trades[day];
  return normalizeTStore({ ...store, trades });
}

/** 北京时间是否在连续竞价时段（工作日 9:25–11:30、13:00–15:00）；节假日由行情本身不更新来体现。 */
export function inTradingSession(now = new Date()): boolean {
  const cn = new Date(now.getTime() + 8 * 3600_000);
  const day = cn.getUTCDay(), minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  return day >= 1 && day <= 5 && ((minute >= 9 * 60 + 25 && minute <= 11 * 60 + 30) || (minute >= 13 * 60 && minute <= 15 * 60));
}

/** 北京时间 HH:MM。 */
export function shanghaiClock(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(11, 16);
}

export type AlertMemory = Record<string, { action: TAction; at: number }>;
/**
 * 同一只股票同一个动作 5 分钟内只提醒一次；动作变了（比如从「高抛」变成「接回」）马上提醒。
 * 只提醒最新一分钟内出现的信号，打开软件时看到的旧信号不响。
 */
export function shouldAlert(memory: AlertMemory, code: string, action: TAction, signalTime: string, nowMs: number, nowClock: string): boolean {
  if (action === "wait") return false;
  const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  if (!TIME.test(signalTime) || !TIME.test(nowClock) || Math.abs(toMinutes(nowClock) - toMinutes(signalTime)) > 2) return false;
  const last = memory[code];
  return !last || last.action !== action || nowMs - last.at >= 5 * 60_000;
}
