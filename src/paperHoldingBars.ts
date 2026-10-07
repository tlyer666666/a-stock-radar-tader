import { shanghaiDateTag } from "./dateUtils";

const validDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** A quote refresh is not a bar. Persist a cursor because the feed is a rolling daily window. */
export function advancePaperHoldingBars(
  position: { openedAt: string; holdingBars: number; lastHoldingBarDate?: string },
  history: unknown,
  today = shanghaiDateTag()
): { holdingBars: number; lastHoldingBarDate?: string } {
  const opened = new Date(position.openedAt);
  const openedDay = Number.isFinite(opened.getTime()) ? shanghaiDateTag(opened) : today;
  const cursor = validDay(position.lastHoldingBarDate) && position.lastHoldingBarDate >= openedDay && position.lastHoldingBarDate <= today
    ? position.lastHoldingBarDate : undefined;
  const dates = [...new Set((Array.isArray(history) ? history : [])
    .map(row => row?.date).filter((day): day is string => validDay(day) && day > openedDay && day <= today))].sort();
  // A legacy counter cannot be reconciled until actual history is available.
  if (!cursor && !dates.length) return { holdingBars: position.holdingBars };
  const newBars = dates.filter(day => day > (cursor || openedDay)).length;
  const newestDay = dates[dates.length - 1] || openedDay;
  return {
    holdingBars: cursor ? position.holdingBars + newBars : Math.max(position.holdingBars, newBars),
    lastHoldingBarDate: newestDay > (cursor || openedDay) ? newestDay : cursor || openedDay
  };
}
