import { shanghaiDateTag } from "./dateUtils";
import { isTradingDay } from "./features/notes/notesModel";

const validDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const tradingDaysAfter = (afterDay: string, throughDay: string): string[] => {
  if (!validDay(afterDay) || !validDay(throughDay) || throughDay <= afterDay) return [];
  const start = Date.parse(`${afterDay}T00:00:00Z`) + 86_400_000;
  const end = Date.parse(`${throughDay}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: string[] = [];
  for (let ms = start, steps = 0; ms <= end && steps < 3660; ms += 86_400_000, steps += 1) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (isTradingDay(day)) out.push(day);
  }
  return out;
};

/** A quote refresh is not a bar. Persist a cursor because the feed is a rolling daily window. */
export function advancePaperHoldingBars(
  position: { openedAt: string; holdingBars: number; lastHoldingBarDate?: string },
  history: unknown,
  today = shanghaiDateTag(),
  observedTradingDate?: string
): { holdingBars: number; lastHoldingBarDate?: string } {
  const opened = new Date(position.openedAt);
  const openedDay = Number.isFinite(opened.getTime()) ? shanghaiDateTag(opened) : today;
  const cursor = validDay(position.lastHoldingBarDate) && position.lastHoldingBarDate >= openedDay && position.lastHoldingBarDate <= today
    ? position.lastHoldingBarDate : undefined;
  const historyDates = (Array.isArray(history) ? history : [])
    .map(row => row?.date).filter((day): day is string => validDay(day) && day > openedDay && day <= today);
  // Background quote snapshots omit daily history; advance by observed calendar trading days
  // when a baseline cursor exists (or for fresh 0-bar positions), without disturbing legacy counters.
  const baseline = cursor || (position.holdingBars === 0 ? openedDay : undefined);
  const calendarDates = !Array.isArray(history) && baseline && validDay(observedTradingDate) && observedTradingDate > baseline && observedTradingDate <= today
    ? tradingDaysAfter(baseline, observedTradingDate)
    : [];
  const dates = [...new Set([...historyDates, ...calendarDates])].sort();
  // A legacy counter cannot be reconciled until actual history is available.
  if (!cursor && !dates.length) return { holdingBars: position.holdingBars };
  const newBars = dates.filter(day => day > (cursor || openedDay)).length;
  const newestDay = dates[dates.length - 1] || openedDay;
  return {
    holdingBars: cursor ? position.holdingBars + newBars : Math.max(position.holdingBars, newBars),
    lastHoldingBarDate: newestDay > (cursor || openedDay) ? newestDay : cursor || openedDay
  };
}
