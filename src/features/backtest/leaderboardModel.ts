import type { StrategyLeaderboardReport, StrategyLeaderboardStrategyRow } from "../../shared/ipc-contract";

export type LeaderboardSortColumn = "rank" | "winRate" | "edge";
export type LeaderboardSort = { column: LeaderboardSortColumn; direction: "asc" | "desc" };

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : null);

/** 主口径：5 日持有期的按信号日等权优势；取不到则退回胜率，再退回平均收益。 */
export function rowEdge(row: StrategyLeaderboardStrategyRow, horizon = "5"): number | null {
  const stats = row.horizons?.[horizon];
  return num(stats?.dayWeightedEdge) ?? num(stats?.edgeVsBaseline) ?? null;
}

export function rowWinRate(row: StrategyLeaderboardStrategyRow, horizon = "5"): number | null {
  return num(row.horizons?.[horizon]?.winRate);
}

export function sortLeaderboardRows(rows: StrategyLeaderboardStrategyRow[], sort: LeaderboardSort, horizon = "5"): StrategyLeaderboardStrategyRow[] {
  const value = (row: StrategyLeaderboardStrategyRow) =>
    sort.column === "winRate" ? rowWinRate(row, horizon) : rowEdge(row, horizon);
  return [...rows].sort((left, right) => {
    const a = value(left), b = value(right);
    if (a === null && b === null) return (left.rank ?? 0) - (right.rank ?? 0);
    if (a === null) return 1;
    if (b === null) return -1;
    return sort.direction === "desc" ? b - a : a - b;
  });
}

export function verdictLabel(level: string): { text: string; tone: "good" | "warn" | "bad" | "muted" } {
  switch (level) {
    case "strong": return { text: "稳定跑赢", tone: "good" };
    case "ahead": return { text: "多数跑赢", tone: "good" };
    case "mixed": return { text: "大致持平", tone: "muted" };
    case "behind": return { text: "多数跑输", tone: "warn" };
    case "weak": return { text: "稳定跑输", tone: "bad" };
    case "insufficient": return { text: "样本不足", tone: "muted" };
    default: return { text: level || "--", tone: "muted" };
  }
}

const signedPct = (value: number | null) => value === null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;

/** 排行旁的一句话：哪几套在近一年里跑赢同期涨停股基线，哪几套稳定跑输。 */
export function leaderboardHeadline(report: StrategyLeaderboardReport | null | undefined): string {
  const rows = report?.strategies;
  if (!rows?.length) return "";
  const primary = String(report?.primaryHorizon ?? 5);
  const best = rows.find(row => row.verdict?.level === "strong") ?? rows[0]!;
  const topEdge = rowEdge(best, primary);
  const aheadCount = rows.filter(row => ["strong", "ahead"].includes(row.verdict?.level || "")).length;
  const weakCount = rows.filter(row => row.verdict?.level === "weak" || row.verdict?.level === "behind").length;
  const period = report?.window?.from && report?.window?.to ? `${report.window.from} 至 ${report.window.to}` : "本机日线库覆盖的区间";
  const parts = [`${period}，${report?.stockCount ?? rows.length} 只股票按同一买卖规则回放`];
  if (best && topEdge !== null) parts.push(`最稳的是「${best.name}」，按信号日等权优势 ${signedPct(topEdge)}`);
  parts.push(`${aheadCount} 套跑赢基线、${weakCount} 套跑输，其余持平或样本不足`);
  return `${parts.join("；")}。`;
}

export function leaderboardScopeText(report: StrategyLeaderboardReport | null | undefined): string {
  if (!report) return "";
  const local = report.universe?.localStocks;
  const replayed = report.universe?.replayed ?? report.stockCount;
  const base = local ? `本机日线库 ${local} 只股票${typeof replayed === "number" && replayed !== local ? `，其中 ${replayed} 只日线够长参与统计` : ""}` : "本机日线库";
  const stale = report.dataThrough && report.signalTo && report.dataThrough < report.signalTo
    ? `数据截至 ${report.dataThrough}（本机日线落后于最近交易日 ${report.signalTo}，重新选股可补齐）`
    : report.dataThrough ? `数据截至 ${report.dataThrough}` : "";
  return [base, stale].filter(Boolean).join(" · ");
}
