/**
 * 分时（同花顺式）：由 1 分钟K线推出当日的分时价格、均价与成交量。
 * - 交易日取数据里最新的一天；盘前或休市时就是上一交易日（与同花顺一致）。
 * - 昨收取前一交易日最后一根 1 分钟线的收盘；没有前一日数据时用当日第一笔开盘。
 * - 均价 = 累计成交额 ÷ 累计成交股数；源端没给成交额时按每分钟收盘价估算。
 * - 横轴固定 241 个点：09:30–11:30（0–120）、13:01–15:00（121–240）；分钟线按结束时刻标注。
 */
export type TimeSharePoint = {
  slot: number; time: string; price: number; average: number; volume: number; amount: number | null;
  changePercent: number; rising: boolean;
};
export type TimeShare = {
  date: string; preClose: number; preCloseSource: "source" | "previous_day" | "first_open";
  points: TimeSharePoint[]; high: number; low: number; scale: { min: number; max: number; maxPercent: number };
  totalVolume: number; totalAmount: number | null;
};

export const TIME_SHARE_SLOTS = 241;
export type TimeShareOptions = {
  preClose?: number | null;
  assetType?: Security["assetType"];
  unitsPerLot?: number | null | undefined;
  volumeUnit?: "lots" | "shares" | undefined;
};

export function timeShareSlot(time: string): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(time);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  if (minute >= 9 * 60 + 15 && minute <= 9 * 60 + 30) return 0; // 集合竞价并入开盘点
  if (minute > 9 * 60 + 30 && minute <= 11 * 60 + 30) return minute - (9 * 60 + 30);
  if (minute > 13 * 60 && minute <= 15 * 60) return 120 + minute - 13 * 60;
  return null;
}

const finitePositive = (value: unknown) => typeof value === "number" ? Number.isFinite(value) && value > 0 : Number.isFinite(Number(value)) && Number(value) > 0;

/** options.preClose：源端给出的昨收（同花顺实时分时自带），优先于从前一日 1 分钟线推算。 */
export function buildTimeShare(rows: any[], options: TimeShareOptions = {}): TimeShare | null {
  const valid = (Array.isArray(rows) ? rows : []).filter(row => typeof row?.date === "string" && row.date.length >= 16 && finitePositive(row.close));
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const date = sorted.at(-1)!.date.slice(0, 10);
  const today = sorted.filter(row => row.date.slice(0, 10) === date);
  const previous = sorted.filter(row => row.date.slice(0, 10) < date).at(-1);
  const firstOpen = Number(today[0]?.open);
  const sourcePreClose = finitePositive(options.preClose) ? Number(options.preClose) : null;
  const preClose = sourcePreClose ?? (previous ? Number(previous.close) : finitePositive(firstOpen) ? firstOpen : Number(today[0]!.close));
  const unitsPerLot = finitePositive(options.unitsPerLot) ? Number(options.unitsPerLot) : options.assetType === "convertibleBond" ? 10 : 100;
  // Only legacy rows without a declared unit need inference. Explicit source
  // units take precedence, including convertible bonds at ten units per lot.
  const sample = today.filter(row => finitePositive(row.amount) && finitePositive(row.volume));
  let inferredUnitsPerVolume = unitsPerLot;
  if (sample.length) {
    const amount = sample.reduce((sum, row) => sum + Number(row.amount), 0);
    const volume = sample.reduce((sum, row) => sum + Number(row.volume), 0);
    const close = sample.reduce((sum, row) => sum + Number(row.close), 0) / sample.length;
    const implied = amount / volume / close;
    inferredUnitsPerVolume = Math.abs(Math.log(implied / unitsPerLot)) < Math.abs(Math.log(implied)) ? unitsPerLot : 1;
  }
  const bySlot = new Map<number, TimeSharePoint>();
  let cumulativeAmount = 0, cumulativeShares = 0, lastPrice = preClose, amountComplete = true;
  for (const row of today) {
    const time = row.date.slice(11, 16);
    const slot = timeShareSlot(time);
    if (slot === null) continue;
    const price = Number(row.close);
    const rawVolume = finitePositive(row.volume) ? Number(row.volume) : 0;
    const volumeUnit = row.volumeUnit || options.volumeUnit;
    const shares = rawVolume * (volumeUnit === "shares" ? 1 : volumeUnit === "lots" ? unitsPerLot : inferredUnitsPerVolume);
    const volume = shares / unitsPerLot; // The chart labels volume in lots.
    const amount = finitePositive(row.amount) ? Number(row.amount) : null;
    if (amount === null && shares > 0) amountComplete = false;
    cumulativeAmount += amount ?? price * shares;
    cumulativeShares += shares;
    // 源端带均价（同花顺实时分时）时直接用，否则按累计成交额÷累计成交量计算。
    const average = finitePositive(row.average) ? Number(row.average) : cumulativeShares > 0 ? cumulativeAmount / cumulativeShares : price;
    const merged = bySlot.get(slot);
    bySlot.set(slot, {
      slot, time: slot === 0 ? "09:30" : time, price, average,
      volume: (merged?.volume ?? 0) + volume,
      amount: amount === null && !merged ? null : (merged?.amount ?? 0) + (amount ?? 0),
      changePercent: (price / preClose - 1) * 100,
      rising: price >= lastPrice
    });
    lastPrice = price;
  }
  const points = [...bySlot.values()].sort((a, b) => a.slot - b.slot);
  if (!points.length) return null;
  const high = Math.max(...points.map(point => point.price));
  const low = Math.min(...points.map(point => point.price));
  // 同花顺式坐标：以昨收为中轴上下对称；至少留 ±1% 的空间。
  const deviation = Math.max(...points.flatMap(point => [Math.abs(point.price - preClose), Math.abs(point.average - preClose)]), preClose * 0.01) * 1.08;
  return {
    date, preClose, preCloseSource: sourcePreClose !== null ? "source" : previous ? "previous_day" : "first_open", points, high, low,
    scale: { min: preClose - deviation, max: preClose + deviation, maxPercent: deviation / preClose * 100 },
    totalVolume: points.reduce((sum, point) => sum + point.volume, 0),
    totalAmount: amountComplete ? cumulativeAmount : null
  };
}
