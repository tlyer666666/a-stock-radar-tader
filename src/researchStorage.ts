// Storage documents must be usable before choosing the primary over its backup.
// These guards preserve legacy numeric strings without coercing objects or arrays.
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const numeric = (value: unknown): boolean => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
const code = (value: unknown): boolean => typeof value === "string" && /^\d{6}$/.test(value);
const collection = (value: unknown, usable: (row: unknown) => boolean): boolean => Array.isArray(value) && (value.length === 0 || value.some(usable));

export function isExecutionLogRow(value: unknown): boolean {
  return record(value) && ["BACKTEST_CURRENT", "BACKTEST_HISTORY", "PAPER_TRADE"].includes(value.source)
    && ["APPROVED", "BLOCKED", "REJECTED", "CONFIRM_REQUIRED"].includes(value.result);
}
export const isExecutionLogCollection = (value: unknown): boolean => collection(value, isExecutionLogRow);
export function isBacktestHistoryRow(value: unknown): boolean {
  if (!record(value)) return false;
  const result = value.rawResult || value.result || value;
  const draft = value.draft || value.input;
  return code(value.securityCode || result?.security?.code || draft?.securityCode);
}
export const isBacktestHistoryCollection = (value: unknown): boolean => collection(value, isBacktestHistoryRow);

export function isPaperState(value: unknown): boolean {
  if (!record(value) || !numeric(value.initialCapital) || Number(value.initialCapital) < 5000
      || !numeric(value.cash) || Number(value.cash) < 0) return false;
  // A paper account is one ledger. Dropping a broken position while preserving
  // the corresponding cash balance would silently change its total equity.
  const position = (item: unknown): boolean => record(item) && code(item.code)
    && numeric(item.shares) && Number(item.shares) >= 100 && Number(item.shares) <= 1e7
    && Number(item.shares) % 100 === 0 && numeric(item.entryPrice) && Number(item.entryPrice) > 0;
  return [value.openPositions, value.closedPositions].every(rows => Array.isArray(rows) && rows.every(position));
}
