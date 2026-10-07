import type { StrategyBacktestRequest } from './StrategySignalsView';

export type SignalTestStrategy = { id: string; name: string; version?: string };

export function isEligibleSignalTestStock(value: unknown): value is Security {
  if (!value || typeof value !== 'object') return false;
  const s = value as Security & { isST?: boolean };
  if (s.assetType && s.assetType !== 'stock') return false;
  if (s.isST === true || /ST|退/i.test(String(s.name || ''))) return false;
  const code = String(s.code || '');
  const sh = /^(600|601|603|605|688|689)\d{3}$/.test(code);
  const sz = /^(000|001|002|003|300|301|302)\d{3}$/.test(code);
  const bj = /^(43|83|87|88)\d{4}$/.test(code) || /^920\d{3}$/.test(code);
  return Boolean((sh || sz || bj) && s.name && s.secid === `${sh ? 1 : 0}.${code}`);
}

export function eligibleSignalTestStocks(input: unknown): Security[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.filter(isEligibleSignalTestStock).filter(s => {
    if (seen.has(s.secid)) return false;
    seen.add(s.secid); return true;
  }).slice(0, 10);
}

export function buildManualSignalTestRequest(security: Security | null, strategy: SignalTestStrategy): StrategyBacktestRequest | null {
  if (!isEligibleSignalTestStock(security) || !strategy.id || !strategy.name) return null;
  return {
    security: { ...security }, securities: [{ ...security }], universeSource: 'manual', universeTotalCount: 1,
    source: 'single_strategy', strategyEngine: 'verified-signal-v2', strategyId: strategy.id,
    strategyName: strategy.name, ...(strategy.version ? { strategyVersion: strategy.version } : {}),
    strategyIds: [strategy.id], minimumVotes: 1
  };
}
