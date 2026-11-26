/** 涨停封单实时推送的类型与展示用纯函数（主进程 electron/limit-seal-stream.cjs 供数）。 */

export type LimitSealStatus = "sealed" | "contested" | "broken" | "downSealed" | "open";
export type BookLevel = { price: number; volumeLots: number };
export type SealPoint = { t: number; amount: number | null; status: LimitSealStatus };

export type LimitSealRecord = {
  code: string;
  name: string;
  latest: number | null;
  changePct: number | null;
  high: number | null;
  limitUp: number | null;
  limitDown: number | null;
  floatMarketCap: number | null;
  status: LimitSealStatus;
  statusLabel: string;
  /** 封单手数（1 手 = 100 股）；没有封单时为 null，不是 0。 */
  sealLots: number | null;
  /** 封单额（元）= 手数 × 100 × 涨停价。 */
  sealAmount: number | null;
  sealFloatRatio: number | null;
  peakAmount: number | null;
  fromPeakPct: number | null;
  change1mAmount: number | null;
  change1mPct: number | null;
  bids: BookLevel[];
  asks: BookLevel[];
  /** 数据来源说明，如「同花顺涨停池（封单）+ 腾讯实时五档」。 */
  source?: string;
  quoteAt: string;
  quoteDate: string;
  history?: SealPoint[];
  point?: SealPoint | null;
};

export type LimitSealTick = { atMs: number; at: string; items: LimitSealRecord[] };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 封单额：≥1 亿写「x.xx亿」，否则写「xxxx万」。 */
export function formatSealAmount(value: number | null | undefined): string {
  if (!finite(value) || value <= 0) return "--";
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  return `${Math.round(value / 1e4).toLocaleString("zh-CN")}万`;
}

/** 手数：≥1 万手写「x.x万手」。 */
export function formatLots(value: number | null | undefined): string {
  if (!finite(value) || value <= 0) return "--";
  if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e5 ? 1 : 2)}万手`;
  return `${Math.round(value).toLocaleString("zh-CN")}手`;
}

export function sealTone(status: LimitSealStatus | undefined): "up" | "warn" | "down" | "muted" {
  if (status === "sealed") return "up";
  if (status === "contested" || status === "broken") return "warn";
  if (status === "downSealed") return "down";
  return "muted";
}

/** 一句话提醒：封单在 1 分钟内明显减少、较峰值大幅回落、涨停有抛压或已炸板时给出。 */
export function sealWarning(record: LimitSealRecord | null | undefined): string {
  if (!record) return "";
  if (record.status === "broken") return "已炸板：今天摸过涨停、现在打开，回封前不要追";
  if (record.status === "contested") return "涨停价上有卖单在砸，封单不稳";
  if (record.status !== "sealed") return "";
  if (finite(record.change1mPct) && record.change1mPct <= -20) return `封单 1 分钟内减少 ${Math.abs(record.change1mPct).toFixed(0)}%，留意撤单或炸板`;
  if (finite(record.fromPeakPct) && record.fromPeakPct <= -50) return `封单较今日峰值回落 ${Math.abs(record.fromPeakPct).toFixed(0)}%`;
  return "";
}

/** 合并推送进按代码索引的表（返回新对象，React 依赖引用变化）。新推送不带 history，保留旧的（跨日重置）并初始化/追加点。 */
export function mergeSealTick(
  current: Record<string, LimitSealRecord>,
  items: LimitSealRecord[],
  historyMax = 400,
  trackHistory = true
): Record<string, LimitSealRecord> {
  if (!items?.length) return current;
  const next = { ...current };
  for (const item of items) {
    if (!item || typeof item.code !== "string") continue;
    const previous = current[item.code];
    const sameDay = !previous?.quoteDate || !item.quoteDate || previous.quoteDate === item.quoteDate;
    let history = item.history ?? (sameDay ? previous?.history : undefined);
    if (!item.history && item.point && (history || trackHistory)) {
      if (!history) {
        history = [item.point];
      } else {
        const last = history.at(-1);
        history = last && last.t === item.point.t && last.amount === item.point.amount && last.status === item.point.status
          ? history
          : [...history, item.point].slice(-historyMax);
      }
    }
    next[item.code] = { ...item, ...(history ? { history } : {}) };
  }
  return next;
}

/** 封单额走势的 SVG 折线（0 在底部），点数不足 2 返回 null。 */
export function sealSparkline(history: SealPoint[] | undefined, { width = 220, height = 44 } = {}) {
  const points = (history || []).filter(point => finite(point.t));
  if (points.length < 2) return null;
  const amounts = points.map(point => (finite(point.amount) ? point.amount : 0));
  const max = Math.max(...amounts, 1);
  const t0 = points[0]!.t;
  const span = Math.max(points.at(-1)!.t - t0, 1);
  const xy = points.map((point, index) => [((point.t - t0) / span) * width, height - 2 - (amounts[index]! / max) * (height - 4)] as const);
  const line = xy.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return { line, area: `${line} L${xy.at(-1)![0].toFixed(1)},${height} L0,${height} Z` };
}
