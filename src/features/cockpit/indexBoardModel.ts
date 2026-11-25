/** 驾驶舱指数条的数据类型与展示用纯函数（主进程 electron/index-board.cjs 供数）。 */

export type IndexBoardQuote = {
  code: string;
  secid: string;
  name: string;
  major: boolean;
  latest: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  preClose: number | null;
  amount: number | null;
  up: number | null;
  down: number | null;
  flat: number | null;
  date: string;
  time: string;
  trend: number[];
};

export type IndexBoardSnapshot = {
  fetchedAt: string;
  tradingDate: string;
  indices: IndexBoardQuote[];
  totals: { amount: number | null; up: number | null; down: number | null; flat: number | null; scope: string } | null;
  missing?: string[];
  source: string;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 成交额：≥1 万亿写「x.xx万亿」，否则写「xxxx亿」。 */
export function formatAmount(value: number | null | undefined): string {
  if (!finite(value) || value <= 0) return "--";
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}万亿`;
  if (value >= 1e8) return `${Math.round(value / 1e8).toLocaleString("zh-CN")}亿`;
  return `${(value / 1e4).toFixed(0)}万`;
}

export function formatSigned(value: number | null | undefined, digits = 2, suffix = ""): string {
  if (!finite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
}

/** 红涨绿跌：A 股口径。 */
export function indexTone(value: number | null | undefined): "up" | "down" | "flat" {
  if (!finite(value) || Math.abs(value) < 0.005) return "flat";
  return value > 0 ? "up" : "down";
}

/**
 * 迷你分时的 SVG 路径：横轴按全天 241 个分钟点留位置（上午收盘时线只画到一半，和同花顺一致），
 * 纵轴以昨收为中线上下对称，保证不同指数的涨跌幅度在同样高度下可比。
 */
export function sparklinePath(points: number[], preClose: number | null, { width = 120, height = 36, slots = 121 } = {}) {
  const values = points.filter(finite);
  if (values.length < 2) return null;
  const base = finite(preClose) && preClose > 0 ? preClose : values[0]!;
  const maxDev = Math.max(...values.map(value => Math.abs(value - base)), base * 0.002);
  const y = (value: number) => height / 2 - ((value - base) / maxDev) * (height / 2 - 1.5);
  const x = (index: number) => (index / Math.max(slots - 1, values.length - 1)) * width;
  const line = values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const lastX = x(values.length - 1).toFixed(1);
  const mid = (height / 2).toFixed(1);
  return { line, area: `${line} L${lastX},${mid} L0,${mid} Z`, baseline: Number(mid) };
}

/** 一句话概括：几个主要指数谁强谁弱，以及两市量能与涨跌家数。 */
export function indexBoardHeadline(snapshot: IndexBoardSnapshot | null): string {
  if (!snapshot) return "";
  const quoted = snapshot.indices.filter(item => finite(item.changePct));
  if (!quoted.length) return "";
  const ups = quoted.filter(item => (item.changePct as number) > 0).length;
  const sorted = [...quoted].sort((a, b) => (b.changePct as number) - (a.changePct as number));
  const best = sorted[0]!;
  const worst = sorted.at(-1)!;
  const mood = ups === quoted.length ? "指数全线上涨" : ups === 0 ? "指数全线下跌" : `${ups} 涨 ${quoted.length - ups} 跌`;
  const spread = best.name !== worst.name ? `，${best.name}最强（${formatSigned(best.changePct, 2, "%")}），${worst.name}最弱（${formatSigned(worst.changePct, 2, "%")}）` : "";
  const totals = snapshot.totals;
  const breadth = totals && finite(totals.up) && finite(totals.down) ? `；个股 ${totals.up} 涨 / ${totals.down} 跌` : "";
  return `${mood}${spread}${breadth}`;
}

/** 数据是不是今天盘中的：行情日期不是今天时显示「上个交易日收盘」。 */
export function indexBoardStale(snapshot: IndexBoardSnapshot | null, today: string): boolean {
  return Boolean(snapshot?.tradingDate && today && snapshot.tradingDate < today);
}

/** 主进程推送的一批变化（只含这次有变化的指数；字段为 null 表示这次没带，不能覆盖旧值）。 */
export type IndexTickQuote = Partial<Omit<IndexBoardQuote, "trend" | "major">> & { code: string };
export type IndexTick = { at: string; atMs: number; quotes: IndexTickQuote[] };
export type IndexStreamStatus = { active: boolean; connected: number; polling?: boolean; total: number; lastTickAt: string; quotes: IndexTickQuote[] };

const MERGE_KEYS = ["latest", "change", "changePct", "open", "high", "low", "preClose", "amount", "up", "down", "flat", "date", "time"] as const;

/**
 * 把推送合并进快照：只用推送里有值的字段；同一交易日时把迷你分时的最后一个点换成最新价，让走势线跟着跳；
 * 两市合计按上证 + 深证重算。返回新对象（React 依赖引用变化重绘）。
 */
export function applyIndexTick(snapshot: IndexBoardSnapshot | null, tick: Pick<IndexTick, "quotes">): IndexBoardSnapshot | null {
  if (!snapshot || !tick?.quotes?.length) return snapshot;
  const byCode = new Map(tick.quotes.filter(item => item && typeof item.code === "string").map(item => [item.code, item]));
  let changed = false;
  const indices = snapshot.indices.map(quote => {
    const update = byCode.get(quote.code);
    if (!update) return quote;
    const next: IndexBoardQuote = { ...quote };
    for (const key of MERGE_KEYS) {
      const value = update[key];
      if (value === null || value === undefined || value === "") continue;
      (next as Record<string, unknown>)[key] = value;
    }
    // 推送的时间到秒（HH:mm:ss），界面统一显示到分钟。
    if (typeof next.time === "string" && next.time.length > 5) next.time = next.time.slice(0, 5);
    if (finite(next.latest) && next.trend.length && (!update.date || update.date === quote.date)) {
      next.trend = [...next.trend.slice(0, -1), next.latest];
    }
    changed = true;
    return next;
  });
  if (!changed) return snapshot;
  const sh = indices.find(item => item.code === "000001");
  const sz = indices.find(item => item.code === "399001");
  const both = (key: "amount" | "up" | "down" | "flat") => sh && sz && finite(sh[key]) && finite(sz[key]) ? (sh[key] as number) + (sz[key] as number) : null;
  const totals = snapshot.totals && sh && sz
    ? { ...snapshot.totals, amount: both("amount") ?? snapshot.totals.amount, up: both("up") ?? snapshot.totals.up, down: both("down") ?? snapshot.totals.down, flat: both("flat") ?? snapshot.totals.flat }
    : snapshot.totals;
  const tradingDate = indices.map(item => item.date).filter(Boolean).sort().at(-1) || snapshot.tradingDate;
  const missing = indices.filter(item => item.latest === null).map(item => item.name);
  const { missing: _oldMissing, ...rest } = snapshot;
  return { ...rest, indices, totals, tradingDate, ...(missing.length ? { missing } : {}) };
}

/** 收到推送的本地时间，精确到毫秒（HH:mm:ss.SSS）。 */
export function tickClock(atMs: number): string {
  if (!finite(atMs) || atMs <= 0) return "";
  const iso = new Date(atMs + 8 * 3600_000).toISOString();
  return iso.slice(11, 23);
}
