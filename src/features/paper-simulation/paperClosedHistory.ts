import type { PaperClosedPosition } from "../../domain/paperSimulationTypes";
import { paperDate } from "./paperTradingRules";

export const CLOSED_DETAIL_LIMIT = 500;
const SIGNATURE_LIMIT = 128;

function emptyStats() {
  return { count: 0, wins: 0, grossProfit: 0, grossLoss: 0, bars: 0, fillSum: 0,
    peakGain: 0, minGain: 0, drawdown: 0, streak: 0, recent: [] as number[], latest: "" };
}
export type CloseStats = ReturnType<typeof emptyStats>;
export type ClosedArchive = {
  total: CloseStats;
  strategies: Array<[string, CloseStats]>;
  strategyLimitReached: boolean;
  daily: { date: string; opens: number; closes: number; wins: number; streak: number };
};
export function isClosedArchive(value: unknown): value is ClosedArchive {
  if (!value || typeof value !== "object") return false;
  const archive = value as Partial<ClosedArchive>;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const whole = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const validStats = (stats?: CloseStats) => !!stats && whole(stats.count) && whole(stats.wins)
    && stats.wins <= stats.count && whole(stats.streak) && stats.streak <= stats.count
    && [stats.grossProfit, stats.grossLoss, stats.bars, stats.fillSum, stats.peakGain, stats.drawdown].every(n => finite(n) && n >= 0)
    && finite(stats.minGain) && typeof stats.latest === "string"
    && Array.isArray(stats.recent) && stats.recent.length <= 10 && stats.recent.every(finite);
  const day = archive.daily;
  return validStats(archive.total) && typeof archive.strategyLimitReached === "boolean"
    && Array.isArray(archive.strategies) && archive.strategies.length <= SIGNATURE_LIMIT
    && archive.strategies.every(pair => Array.isArray(pair) && typeof pair[0] === "string" && validStats(pair[1]))
    && !!day && typeof day.date === "string" && [day.opens, day.closes, day.wins, day.streak].every(whole);
}
const numeric = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;

function readStats(value?: CloseStats): CloseStats {
  const result = emptyStats();
  for (const key of ["count","wins","grossProfit","grossLoss","bars","fillSum","peakGain","minGain","drawdown","streak"] as const) {
    result[key] = numeric(value?.[key]);
  }
  result.recent = Array.isArray(value?.recent) ? value.recent.slice(-10).map(numeric) : [];
  result.latest = typeof value?.latest === "string" ? value.latest : "";
  return result;
}

function addClose(stats: CloseStats, position: PaperClosedPosition, capital: number) {
  stats.count++;
  const pnl = position.realizedPnl;
  stats.wins += Number(pnl > 0);
  stats.grossProfit += Math.max(0, pnl);
  stats.grossLoss += Math.max(0, -pnl);
  stats.bars += position.holdingBars;
  stats.fillSum += position.entryExecutionFillRatePercent;
  const gain = stats.grossProfit - stats.grossLoss;
  stats.peakGain = Math.max(stats.peakGain, gain);
  stats.minGain = stats.count === 1 ? gain : Math.min(stats.minGain, gain);
  const peak = capital + stats.peakGain;
  stats.drawdown = Math.max(stats.drawdown, (stats.peakGain - gain) / peak * 100);
  stats.streak = pnl < 0 ? stats.streak + 1 : 0;
  stats.recent.push(pnl);
  if (stats.recent.length > 10) stats.recent.shift();
  stats.latest = position.closeTime;
}

export function closeStats(prefix: CloseStats | undefined, positions: PaperClosedPosition[], capital: number) {
  const stats = readStats(prefix);
  // Preserve the prior evaluator’s stable ordering for equal-time fills.
  const ordered = [...positions].sort((a,b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
  for (const position of ordered) addClose(stats, position, capital);
  return stats;
}

export function compactClosedHistory(positions: PaperClosedPosition[], stored: ClosedArchive | undefined, capital: number, date: string) {
  if (positions.length <= CLOSED_DETAIL_LIMIT && !stored) return { closedPositions: positions };
  const total = readStats(stored?.total);
  const strategies = new Map<string, CloseStats>();
  for (const pair of Array.isArray(stored?.strategies) ? stored.strategies.slice(0, SIGNATURE_LIMIT) : []) {
    if (Array.isArray(pair) && typeof pair[0] === "string") strategies.set(pair[0], readStats(pair[1]));
  }
  const oldDaily = stored?.daily?.date === date ? stored.daily : undefined;
  const daily = { date, opens: numeric(oldDaily?.opens), closes: numeric(oldDaily?.closes),
    wins: numeric(oldDaily?.wins), streak: numeric(oldDaily?.streak) };
  let strategyLimitReached = stored?.strategyLimitReached === true;
  const newest = positions.length > CLOSED_DETAIL_LIMIT
    ? [...positions].sort((a,b) => Date.parse(b.closeTime) - Date.parse(a.closeTime)) : positions;
  for (let i = newest.length - 1; i >= CLOSED_DETAIL_LIMIT; i--) {
    const p = newest[i]!;
    addClose(total, p, capital);
    const signature = p.strategySignature || "legacy";
    let entry = strategies.get(signature);
    if (!entry && strategies.size < SIGNATURE_LIMIT) {
      entry = emptyStats(); strategies.set(signature, entry);
    }
    if (entry) addClose(entry, p, capital);
    else strategyLimitReached = true;
    if (paperDate(p.openedAt) === date) daily.opens++;
    if (paperDate(p.closeTime) === date) {
      daily.closes++; daily.wins += Number(p.realizedPnl > 0);
      daily.streak = p.realizedPnl < 0 ? daily.streak + 1 : 0;
    }
  }
  return { closedPositions: newest.slice(0, CLOSED_DETAIL_LIMIT),
    closedArchive: { total, strategies: [...strategies], strategyLimitReached, daily } };
}

export function paperLifetimeMetrics(state: { closedPositions: PaperClosedPosition[]; closedArchive?: ClosedArchive | undefined }) {
  const old = state.closedArchive?.total;
  let closedCount = old?.count ?? 0, closedWinCount = old?.wins ?? 0;
  let grossProfit = old?.grossProfit ?? 0, grossLoss = old?.grossLoss ?? 0, bars = old?.bars ?? 0;
  for (const p of state.closedPositions) {
    closedCount++; closedWinCount += Number(p.realizedPnl > 0);
    grossProfit += Math.max(0, p.realizedPnl); grossLoss += Math.max(0, -p.realizedPnl); bars += p.holdingBars;
  }
  return { closedCount, closedWinCount, grossProfit, grossLoss, cumulativeRealizedPnl: grossProfit - grossLoss,
    avgHoldingBars: closedCount ? bars / closedCount : 0 };
}
