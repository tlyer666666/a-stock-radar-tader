/** ETF 轮动（主进程 electron/etf-rotation.cjs）的类型。 */
export type EtfRotationConfig = { pool: string[]; safeAsset: string; lookback: number; rebalance: "weekly" | "monthly"; topN: number; bufferPct: number; costBps: number; years: number };
export type RotationMetrics = { totalPct: number | null; years: number | null; maxDrawdownPct: number | null; annualPct: number | null; volPct: number | null; sharpe: number | null; calmar: number | null };
export type EtfRotationReport = {
  config: EtfRotationConfig; warnings: string[]; asOf: string; generatedAt?: string;
  signal: {
    asOf: string;
    holdings: Array<{ code: string; name: string; safe: boolean }>;
    targets: Array<{ code: string; name: string; weightPct: number | null }>;
    idleWeightPct: number | null; idleTo: string; needRebalance: boolean; isRebalanceDay: boolean;
    ranking: Array<{ code: string; name: string; momentumPct: number | null; selected: boolean; positive: boolean }>;
  } | null;
  performance: { from: string; to: string; strategy: RotationMetrics | null; benchmark: RotationMetrics | null } | null;
  yearly: Array<{ year: string; strategyPct: number | null; benchmarkPct: number | null; partial: boolean }>;
  sweep: Array<{ lookback: number; annualPct: number | null; maxDrawdownPct: number | null; sharpe: number | null; current: boolean }>;
  rebalances: Array<{ signalDate: string; tradeDate: string; out: string[]; in: string[]; holdings: string[]; costPct: number | null }>;
  rebalanceCount?: number;
  curve?: Array<{ date: string; strategy: number | null; benchmark: number | null }>;
};

export const signedPct = (value: number | null | undefined, digits = 2) => value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;

export const plainPct = (value: number | null | undefined, digits = 2) => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}%` : "--";

export const drawdownPct = (value: number | null | undefined, digits = 2) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  return abs === 0 || Number(abs.toFixed(digits)) === 0 ? `${(0).toFixed(digits)}%` : `-${abs.toFixed(digits)}%`;
};

export const valueTone = (value: number | null | undefined): "" | "rise" | "fall" =>
  typeof value !== "number" || !Number.isFinite(value) || value === 0 ? "" : value > 0 ? "rise" : "fall";

/** 参数平原一句话：相邻窗口年化差得大，说明当前参数的结果靠运气。 */
export function sweepVerdict(sweep: EtfRotationReport["sweep"]): string {
  const values = sweep.map(item => item.annualPct).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length < 3) return "可比较的窗口太少，看不出参数是否稳定。";
  const spread = Math.max(...values) - Math.min(...values);
  const positive = values.filter(value => value > 0).length;
  if (spread <= 6 && positive === values.length) return `不同动量窗口的年化收益相差 ${spread.toFixed(1)} 个百分点、全部为正，参数比较稳。`;
  if (positive < values.length / 2) return "多数窗口年化为负，这套规则在这个池子上历史表现不好。";
  return `不同窗口的年化收益相差 ${spread.toFixed(1)} 个百分点，结果对参数敏感，当前窗口的成绩有运气成分。`;
}

/** 净值曲线的 SVG 折线（策略与等权基准共用纵轴）。 */
export function curvePaths(curve: NonNullable<EtfRotationReport["curve"]>, { width = 640, height = 150 } = {}) {
  const rows = curve.filter(row => typeof row.strategy === "number" && Number.isFinite(row.strategy) && typeof row.benchmark === "number" && Number.isFinite(row.benchmark));
  if (rows.length < 2) return null;
  const all = rows.flatMap(row => [row.strategy as number, row.benchmark as number]);
  const min = Math.min(...all), max = Math.max(...all);
  const y = (value: number) => height - 4 - (value - min) / Math.max(1e-9, max - min) * (height - 8);
  const x = (index: number) => index / (rows.length - 1) * width;
  const path = (key: "strategy" | "benchmark") => rows.map((row, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(row[key] as number).toFixed(1)}`).join(" ");
  return { strategy: path("strategy"), benchmark: path("benchmark"), baseline: y(1) };
}
