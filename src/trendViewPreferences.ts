import { loadSafeLocalJson, saveSafeLocalJson } from './safeStorage';
import { TREND_DEFAULT_COMPARISON_STRATEGIES, TREND_QUALITY_PRESETS, TREND_STRATEGY_CHOICES } from './trendStrategyConfig';
import type { TrendStrategyId } from './trendScreenerTypes';

export const TREND_VIEW_KEY = 'a-stock-radar:trend-view-preferences:v1';
export type TrendViewPreferences = {
  scanMode: 'single' | 'multi'; strategyId: TrendStrategyId; selectedStrategies: TrendStrategyId[];
  strategyFilter: 'all' | TrendStrategyId; qualityDraft: Record<string, string>; forceRefresh: boolean;
  scanReason: string; researchStart: string; researchEnd: string;
  filter: 'all' | 'signal' | 'A' | 'B' | 'watch'; tab: 'candidates' | 'plans'; query: string;
};

export function readTrendViewPreferences(): TrendViewPreferences {
  const raw = loadSafeLocalJson<Record<string, unknown>>(TREND_VIEW_KEY, {});
  const knownId = (id: unknown): id is TrendStrategyId => TREND_STRATEGY_CHOICES.some(item => item.id === id);
  const selected = Array.isArray(raw.selectedStrategies) ? [...new Set(raw.selectedStrategies.filter(knownId))] : [...TREND_DEFAULT_COMPARISON_STRATEGIES];
  const draft = raw.qualityDraft && typeof raw.qualityDraft === 'object' ? raw.qualityDraft as Record<string, unknown> : {};
  return {
    scanMode: raw.scanMode === 'single' ? 'single' : 'multi',
    strategyId: knownId(raw.strategyId) ? raw.strategyId : 'classic-v1',
    selectedStrategies: selected.length ? selected : [...TREND_DEFAULT_COMPARISON_STRATEGIES],
    strategyFilter: knownId(raw.strategyFilter) ? raw.strategyFilter : 'all',
    qualityDraft: Object.fromEntries(Object.entries(TREND_QUALITY_PRESETS.robust).map(([key, value]) => [key, typeof draft[key] === 'string' && draft[key].length <= 32 ? draft[key] : String(value)])),
    forceRefresh: raw.forceRefresh === true,
    scanReason: typeof raw.scanReason === 'string' ? raw.scanReason.slice(0, 1000) : '',
    researchStart: typeof raw.researchStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.researchStart) ? raw.researchStart : '',
    researchEnd: typeof raw.researchEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.researchEnd) ? raw.researchEnd : '',
    filter: ['all', 'signal', 'A', 'B', 'watch'].includes(String(raw.filter)) ? raw.filter as TrendViewPreferences['filter'] : 'all',
    tab: raw.tab === 'plans' ? 'plans' : 'candidates',
    query: typeof raw.query === 'string' ? raw.query.slice(0, 100) : ''
  };
}

export const saveTrendViewPreferences = (value: TrendViewPreferences) => saveSafeLocalJson(TREND_VIEW_KEY, value);
