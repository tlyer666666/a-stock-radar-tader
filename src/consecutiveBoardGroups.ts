export type BoardStock = {
  code: string; name: string; consecutiveBoards: number; industry?: string;
  firstSealRaw?: number | string | null; firstSealTime?: string;
  openBoardCount?: number | string | null; turnover?: number | string | null;
  limitDate?: string; date?: string; tradeDate?: string; [key: string]: unknown;
};
export type BoardSort = { key: 'firstSeal' | 'openBoard' | 'turnover'; direction: 'asc' | 'desc' };
export function boardMetric(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null;
}
function dateOf(row: BoardStock): string | null {
  let date = String(row.limitDate || row.tradeDate || row.date || '').slice(0, 10);
  if (/^\d{8}$/.test(date)) date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) return null;
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : null;
}
function seal(row: BoardStock): number | null {
  const raw = row.firstSealRaw ?? (row.firstSealTime || '').replaceAll(':', '');
  const value = boardMetric(raw);
  if (value === null || !Number.isInteger(value)) return null;
  const hour = Math.floor(value / 10000), minute = Math.floor(value / 100) % 100, second = value % 100;
  return hour < 24 && minute < 60 && second < 60 ? value : null;
}
export function buildConsecutiveBoardGroups(rows: BoardStock[], sort: BoardSort = { key: 'firstSeal', direction: 'asc' }) {
  const source = Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : [];
  const dates = source.map(dateOf).filter((date): date is string => Boolean(date)).sort();
  const asOf = dates.at(-1) || null;
  const eligible = source.filter(row => (!asOf || dateOf(row) === asOf) && typeof row.code === 'string' && row.code &&
    typeof row.name === 'string' && row.name && !/ST|退/i.test(row.name) && Number.isSafeInteger(Number(row.consecutiveBoards)) && Number(row.consecutiveBoards) >= 1);
  const unique = new Map<string, BoardStock>(), conflicts = new Set<string>();
  for (const row of eligible) {
    if (unique.has(row.code) && Number(unique.get(row.code)!.consecutiveBoards) !== Number(row.consecutiveBoards)) conflicts.add(row.code);
    else if (!unique.has(row.code)) unique.set(row.code, row);
  }
  const groups = new Map<number, BoardStock[]>();
  for (const [code, row] of unique) {
    if (conflicts.has(code) || Number(row.consecutiveBoards) < 2) continue;
    const height = Number(row.consecutiveBoards);
    groups.set(height, [...(groups.get(height) || []), row]);
  }
  const valueFor = (row: BoardStock) => sort.key === 'firstSeal' ? seal(row) : boardMetric(sort.key === 'openBoard' ? row.openBoardCount : row.turnover);
  const compare = (a: BoardStock, b: BoardStock) => {
    const left = valueFor(a), right = valueFor(b);
    if (left === null || right === null) return left === right ? a.code.localeCompare(b.code) : left === null ? 1 : -1;
    return (left - right) * (sort.direction === 'asc' ? 1 : -1) || a.code.localeCompare(b.code);
  };
  const result = [...groups].sort(([a], [b]) => b - a).map(([height, stocks]) => ({ height, stocks: stocks.sort(compare) }));
  return { asOf, groups: result, total: result.reduce((sum, group) => sum + group.stocks.length, 0), conflicts: conflicts.size };
}
