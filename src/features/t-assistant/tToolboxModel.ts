import { calculateBollingerBands, calculatePriceMovingAverages } from '../../priceChartSeries';

export type TCandle = { date: string; open: number; high: number; low: number; close: number; volume: number | null; volumeUnit: string };
export type TChartData = { rows: TCandle[]; source: string; adjustment: string; updatedAt: string; note: string };
export type TFrame = '1' | '5' | '15' | '30' | '60' | '101' | '102';
export const T_FRAMES: { id: TFrame; label: string; range: string }[] = [
  { id: '1', label: '1分', range: '5d' }, { id: '5', label: '5分', range: '10d' }, { id: '15', label: '15分', range: '20d' },
  { id: '30', label: '30分', range: '1m' }, { id: '60', label: '60分', range: '1m' }, { id: '101', label: '日K', range: '1y' }, { id: '102', label: '周K', range: '5y' }
];
const number = (v: unknown): number | null => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const validTime = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}(?: [0-2]\d:[0-5]\d)?$/.test(value)) return false;
  const day = value.slice(0, 10);
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day && (value.length === 10 || Number(value.slice(11, 13)) < 24);
};
export function normalizeToolboxChart(response: unknown): TChartData {
  const raw = response as { rows?: unknown[]; source?: string; adjustment?: string; updatedAt?: string; note?: string };
  if (!raw || !Array.isArray(raw.rows) || !raw.rows.length) throw new Error('行情源未返回K线');
  const dates = new Set<string>();
  const rows = raw.rows.slice(-1000).map(item => {
    const row = item as Record<string, unknown>;
    const date = String(row?.date ?? '').replace('T', ' ').slice(0, 16);
    const open = number(row?.open), high = number(row?.high), low = number(row?.low), close = number(row?.close);
    if (!validTime(date) || dates.has(date) || open === null || high === null || low === null || close === null || Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) throw new Error('K线日期或价格异常，请刷新重试');
    dates.add(date);
    const v = number(row.volume);
    return { date, open, high, low, close, volume: v !== null && v >= 0 ? v : null,
      volumeUnit: row.volumeUnit === 'lots' ? '手' : row.volumeUnit === 'shares' ? '股' : '源单位' };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { rows, source: String(raw.source || '来源未提供'), adjustment: String(raw.adjustment || '复权口径未提供'), updatedAt: String(raw.updatedAt || ''), note: String(raw.note || '') };
}

type Series = (number | null)[];
function sma(values: Series, period: number): Series {
  return values.map((_, i) => {
    const sample = values.slice(i - period + 1, i + 1);
    return i + 1 >= period && sample.every((v): v is number => v !== null) ? sample.reduce((a, b) => a + b, 0) / period : null;
  });
}
function ema(values: Series, period: number): Series {
  let previous: number | null = null;
  return values.map((value, i) => {
    if (value === null) { previous = null; return null; }
    if (previous === null) {
      const seed = values.slice(i - period + 1, i + 1);
      if (i + 1 < period || seed.some(v => v === null)) return null;
      previous = (seed as number[]).reduce((a, b) => a + b, 0) / period;
    } else previous += (value - previous) * 2 / (period + 1);
    return previous;
  });
}
export function toolboxIndicators(rows: TCandle[]) {
  const clean = (values: number[]) => values.map(v => Number.isFinite(v) ? v : null);
  const ma = calculatePriceMovingAverages(rows);
  const boll = calculateBollingerBands(rows, ma.ma20);
  const closes = rows.map(r => r.close), e12 = ema(closes, 12), e26 = ema(closes, 26);
  const dif = e12.map((v, i) => v !== null && e26[i] != null ? v - e26[i]! : null);
  const dea = ema(dif, 9);
  const macd = dif.map((v, i) => v !== null && dea[i] != null ? 2 * (v - dea[i]!) : null);
  let gain = 0, loss = 0, atrValue = 0, prevK = 50, prevD = 50;
  const rsi: Series = [], atr: Series = [], k: Series = [], d: Series = [], j: Series = [];
  rows.forEach((row, i) => {
    const change = i ? row.close - rows[i - 1]!.close : 0;
    if (i > 0 && i <= 14) { gain += Math.max(0, change) / 14; loss += Math.max(0, -change) / 14; }
    else if (i > 14) { gain = (gain * 13 + Math.max(0, change)) / 14; loss = (loss * 13 + Math.max(0, -change)) / 14; }
    rsi.push(i < 14 ? null : gain + loss === 0 ? 50 : 100 * gain / (gain + loss));
    const tr = i ? Math.max(row.high - row.low, Math.abs(row.high - rows[i - 1]!.close), Math.abs(row.low - rows[i - 1]!.close)) : row.high - row.low;
    atrValue = i < 14 ? atrValue + tr / 14 : (atrValue * 13 + tr) / 14;
    atr.push(i < 13 ? null : atrValue);
    if (i < 8) { k.push(null); d.push(null); j.push(null); }
    else {
      const sample = rows.slice(i - 8, i + 1), low = Math.min(...sample.map(r => r.low)), high = Math.max(...sample.map(r => r.high));
      const rsv = high === low ? 50 : (row.close - low) / (high - low) * 100;
      prevK = prevK * 2 / 3 + rsv / 3; prevD = prevD * 2 / 3 + prevK / 3;
      k.push(prevK); d.push(prevD); j.push(3 * prevK - 2 * prevD);
    }
  });
  return { ma5: clean(ma.ma5), ma10: clean(ma.ma10), ma20: clean(ma.ma20), ma60: clean(ma.ma60), upper: clean(boll.upper), lower: clean(boll.lower),
    volumeMa5: sma(rows.map(r => r.volume), 5), dif, dea, macd, rsi, atr, k, d, j };
}
export type TIndicators = ReturnType<typeof toolboxIndicators>;
export function summarizeToolbox(rows: TCandle[], indicators = toolboxIndicators(rows)) {
  const last = rows.at(-1);
  const past = rows.slice(-21, -1), complete = past.length === 20;
  const volumes = past.map(r => r.volume);
  const volumeMean = complete && volumes.every((v): v is number => v !== null) && past.every(r => r.volumeUnit === last?.volumeUnit) ? volumes.reduce((a, b) => a + b, 0) / 20 : null;
  const ma20 = indicators.ma20.at(-1) ?? null, ma60 = indicators.ma60.at(-1) ?? null;
  const trend = !last || ma20 === null || ma60 === null ? '历史不足' : last.close > ma20 && ma20 > ma60 ? '多头排列' : last.close < ma20 && ma20 < ma60 ? '空头排列'
    // 均线方向和价格位置不一致时说清楚是哪一种，不笼统叫「整理」：MA20 在 MA60 下方、价格在 MA60 下方的上穿 MA20 只是弱势反弹。
    : ma20 < ma60 && last.close < ma60 ? '弱势反弹（仍在 MA60 下方）'
    : ma20 > ma60 && last.close > ma60 ? '强势回调（仍在 MA60 上方）' : '整理 / 分歧';
  return { trend, support: complete ? Math.min(...past.map(r => r.low)) : null, resistance: complete ? Math.max(...past.map(r => r.high)) : null,
    volumeRatio: volumeMean !== null && volumeMean > 0 && last?.volume != null ? last.volume / volumeMean : null,
    atr: indicators.atr.at(-1) ?? null, rsi: indicators.rsi.at(-1) ?? null, macd: indicators.macd.at(-1) ?? null, ma20, ma60 };
}

export type TAnchor = { date: string; price: number };
export type TDrawing = { id: string; kind: 'horizontal' | 'trend' | 'measure'; a: TAnchor; b?: TAnchor };
export const DRAWINGS_KEY = 'a-stock-radar:t-toolbox-drawings:v1';
export const drawingKey = (code: string, frame: string, adjustment: string) => `${code}|${frame}|${adjustment}`;
export function normalizeDrawings(value: unknown): TDrawing[] {
  if (!Array.isArray(value)) return [];
  const anchor = (v: unknown): TAnchor | null => {
    const a = v as TAnchor;
    return a && validTime(a.date) && typeof a.price === 'number' && Number.isFinite(a.price) && a.price > 0 && a.price <= 1e7 ? { date: a.date, price: a.price } : null;
  };
  const seen = new Set<string>();
  return value.slice(-50).flatMap(raw => {
    if (!raw || !['horizontal', 'trend', 'measure'].includes(raw.kind)) return [];
    const a = anchor(raw.a), b = anchor(raw.b), id = typeof raw.id === 'string' ? raw.id.slice(0, 80) : '';
    if (!a || !id || seen.has(id) || (raw.kind !== 'horizontal' && !b)) return [];
    seen.add(id);
    return [{ id, kind: raw.kind, a, ...(b ? { b } : {}) } as TDrawing];
  });
}

/** Do not confuse a successful HTTP request with fresh bars. Minute providers
 * sometimes return only the previous session even while daily quotes advance. */
export function toolboxHistoryNote(data: Pick<TChartData, 'rows'> | null, frame: TFrame, now = new Date()): string {
  const last = data?.rows.at(-1)?.date;
  if (!last) return '';
  const cn = new Date(now.getTime() + 8 * 3600_000), today = cn.toISOString().slice(0, 10);
  if (last.slice(0, 10) > today) return 'K线时间在当前日期之后，时间异常，暂停当前判断';
  if (Number(frame) >= 100) return '';
  if (last.slice(0, 10) < today) return `历史分钟K线截至 ${last}，不是今日盘中行情，仅供历史参考`;
  if (last.length < 16) return '分钟K线未提供分钟时间，暂不能核对时效';
  const minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  const lastMinute = Number(last.slice(11, 13)) * 60 + Number(last.slice(14, 16));
  const tolerance = Number(frame) + 3;
  if (lastMinute - minute > tolerance) return '分钟K线时间超前异常，请核对行情';
  const weekday = cn.getUTCDay() >= 1 && cn.getUTCDay() <= 5;
  const session = (minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900);
  return weekday && session && minute - lastMinute > tolerance ? `分钟K线滞后（截至 ${last}），当前动能仅供旧行情参考` : '';
}

export type TDrawingReference = { date: string; close: number };
export const drawingReferences = (rows: TCandle[]): TDrawingReference[] => rows.slice(-4, -1).map(row => ({ date: row.date, close: row.close }));
export function drawingReferenceStatus(refs: TDrawingReference[], rows: TCandle[]): 'valid' | 'missing' | 'changed' {
  const byDate = new Map(rows.map(row => [row.date, row.close]));
  const shared = refs.filter(ref => byDate.has(ref.date));
  if (!shared.length) return 'missing';
  return shared.some(ref => Math.abs(byDate.get(ref.date)! - ref.close) > Math.max(.0001, ref.close * .00001)) ? 'changed' : 'valid';
}
