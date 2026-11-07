import { nullableNumber } from '../../domain/formatters';
import { clampNumber } from '../../domain/settings';

export type LimitUpStock = Security & Record<string, any>;
export type LimitPoolSort = { key: string; direction: 'asc' | 'desc' };
export type ColumnPreferences = { visible: string[]; widths: Record<string, number> };
export const LIMIT_COLUMNS = [
  { key: 'code', label: '代码', width: 70 },
  { key: 'name', label: '名称', width: 104 },
  { key: 'latest', label: '现价', width: 70, numeric: true },
  { key: 'changePct', label: '涨幅', width: 76, numeric: true },
  { key: 'consecutiveBoards', label: '连板', width: 54, numeric: true },
  { key: 'turnover', label: '换手', width: 68, numeric: true },
  { key: 'amount', label: '成交额', width: 90, numeric: true },
  { key: 'firstSealTime', label: '首封', width: 84, numeric: true },
  { key: 'openBoardCount', label: '开板', width: 54, numeric: true },
  { key: 'sealFloatRatio', label: '封单/流通', width: 86, numeric: true },
  { key: 'quality', label: '质量', width: 142, numeric: true },
  { key: 'industry', label: '板块', width: 110 },
  { key: 'sealedAmount', label: '封单额', width: 92, numeric: true, optional: true },
  { key: 'status', label: '封板状态', width: 100, optional: true },
  { key: 'limitReason', label: '涨停原因', width: 200, optional: true }
] as const;

function firstSealSeconds(value: unknown): number | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? ''));
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]), seconds = Number(match[3] ?? 0);
  return hours < 24 && minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : null;
}

export function normalizeColumnPreferences(input: unknown): ColumnPreferences {
  const raw = input && typeof input === 'object' ? input as Partial<ColumnPreferences> : {};
  const defaults = LIMIT_COLUMNS.filter(column => !('optional' in column)).map(column => column.key);
  const requested = Array.isArray(raw.visible) ? raw.visible : defaults;
  return {
    visible: LIMIT_COLUMNS.filter(column => ['code', 'name'].includes(column.key) || requested.includes(column.key)).map(column => column.key),
    widths: Object.fromEntries(LIMIT_COLUMNS.map(column => {
      const value = raw.widths?.[column.key];
      return [column.key, typeof value === 'number' && Number.isFinite(value) ? Math.min(480, Math.max(48, Math.round(value))) : column.width];
    }))
  };
}

export function selectLimitUpRows(items: LimitUpStock[], options: { query: string; sort: LimitPoolSort; insights?: Map<string, ReturnType<typeof limitUpMarketAnalysis>> }) {
  const query = options.query.trim().toLocaleLowerCase();
  const column = LIMIT_COLUMNS.find(item => item.key === options.sort.key);
  const filtered = items.filter(item => !query || [item.name, item.code, item.industry, item.limitReason].join(' ').toLocaleLowerCase().includes(query));
  const valueFor = (item: LimitUpStock): string | number | null => {
    if (options.sort.key === 'quality') return options.insights?.get(item.code)?.qualityScore ?? null;
    if (options.sort.key === 'status') return options.insights?.get(item.code)?.state ?? null;
    if (options.sort.key === 'firstSealTime') return firstSealSeconds(item.firstSealTime);
    return column && 'numeric' in column ? nullableNumber(item[options.sort.key]) : String(item[options.sort.key] ?? '');
  };
  filtered.sort((left, right) => {
    const a = valueFor(left), b = valueFor(right);
    if (a === null || a === '') return b === null || b === '' ? left.code.localeCompare(right.code) : 1;
    if (b === null || b === '') return -1;
    const compared = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'zh-CN', { numeric: true });
    return (options.sort.direction === 'asc' ? compared : -compared) || left.code.localeCompare(right.code);
  });
  return { filtered, visible: filtered };
}

export function limitUpMarketAnalysis(item: LimitUpStock) {
  const seconds = firstSealSeconds(item.firstSealTime);
  const firstSealMinutes = seconds === null ? null : Math.floor(seconds / 60);
  const sealRatio = nullableNumber(item.sealFloatRatio), turnover = nullableNumber(item.turnover);
  const amount = nullableNumber(item.amount), openBoardCount = nullableNumber(item.openBoardCount), consecutiveBoards = nullableNumber(item.consecutiveBoards);
  const coreFieldCount = [firstSealMinutes, sealRatio, openBoardCount].filter(value => value !== null).length;
  let score = 45;
  if (firstSealMinutes !== null && firstSealMinutes <= 630) score += 14;
  else if (firstSealMinutes !== null && firstSealMinutes <= 810) score += 7;
  if (openBoardCount !== null) score += openBoardCount === 0 ? 15 : -Math.min(20, openBoardCount * 5);
  if (sealRatio !== null) score += sealRatio >= 0.008 ? 12 : sealRatio >= 0.003 ? 7 : 0;
  if (amount !== null && amount >= 3e8) score += 6;
  if (turnover !== null && turnover >= 2 && turnover <= 18) score += 7;
  if (turnover !== null && turnover > 28) score -= 12;
  if (consecutiveBoards !== null && consecutiveBoards >= 2) score += Math.min(8, consecutiveBoards * 2);
  const qualityScore = coreFieldCount >= 2 ? Math.round(clampNumber(score, 0, 100, 50)) : null;
  const state = qualityScore === null ? '封板数据待补' : qualityScore >= 80 ? '强势封板' : qualityScore >= 66 ? '结构稳健' : qualityScore >= 52 ? '换手观察' : '分歧偏大';
  return { qualityScore, state, coreFieldCount };
}

export function limitPoolWindow(count: number, top: number, height: number, rowHeight: number) {
  if (count <= 80) return {start: 0, end: count};
  const visibleCount = Math.max(1, Math.ceil(height / rowHeight));
  const first = Math.min(Math.max(0, Math.floor(top / rowHeight)), Math.max(0, count - visibleCount));
  return {start: Math.max(0, first - 6), end: Math.min(count, first + visibleCount + 6)};
}
