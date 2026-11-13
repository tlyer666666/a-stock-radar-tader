/** AI 选股助手的前端数据整理：从规则选股结果挑出要交给 AI 的股票，以及按 AI 分排序。 */
export type AiSourceRow = {
  code: string; name: string; industry?: string | undefined; latest?: number | null | undefined; changePct?: number | null | undefined;
  turnover?: number | null | undefined; amount?: number | null | undefined; limitDate?: string | undefined; daysSinceLimit?: number | null | undefined;
  consecutiveBoards?: number | null | undefined; signalStrength?: number | null | undefined; overheatCount?: number | null | undefined;
  reasons?: string[] | undefined; executionNotes?: string[] | undefined; strategies: Array<{ name: string }>; familyCount?: number | undefined;
};

export const AI_MAX_PICKS = 40;

/** 已按“命中精选策略数、命中家族数、策略数、排序分”排好的汇总行 → 取前 40 只作为 AI 输入。 */
export function buildAiPicks(rows: AiSourceRow[], limit = AI_MAX_PICKS): AiPick[] {
  return rows.slice(0, limit).map(row => ({
    code: row.code, name: row.name, industry: row.industry, latest: row.latest ?? null, changePct: row.changePct ?? null,
    turnover: row.turnover ?? null, amount: row.amount ?? null, limitDate: row.limitDate, daysSinceLimit: row.daysSinceLimit ?? null,
    consecutiveBoards: row.consecutiveBoards ?? null, signalStrength: row.signalStrength ?? null, overheatCount: row.overheatCount ?? null,
    strategies: row.strategies.map(item => item.name).slice(0, 8), notes: (row.executionNotes || []).slice(0, 4), reasons: (row.reasons || []).slice(0, 3)
  }));
}

export function aiScoreMap(ranking: AiRanking | null | undefined): Map<string, AiRankItem> {
  return new Map((ranking?.items || []).filter(item => !item.fallback).map(item => [item.code, item]));
}

/** AI 分优先排序：有分数的按分数降序，没有分数的保持原顺序排在后面。 */
export function sortByAiScore<T extends { code: string }>(rows: T[], scores: Map<string, AiRankItem>): T[] {
  return rows.map((row, index) => ({ row, index, score: scores.get(row.code)?.score }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.index - b.index)
    .map(item => item.row);
}

export const ratingTone = (rating: string | undefined) => rating === "重点关注" ? "strong" : rating === "关注" ? "good" : rating === "观望" ? "neutral" : rating === "回避" ? "weak" : "";

export function aiErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "");
}

export type AiBoardRow<T extends { code: string; name: string }> = { code: string; name: string; source: T | undefined; ai: AiRankItem | undefined };

/**
 * AI 选股榜的行：已打分的按综合分从高到低（评级筛选只作用于已打分的），
 * 筛选“全部”时把还没打分的候选股按原顺序接在后面。
 */
export function buildAiBoardRows<T extends { code: string; name: string }>(sources: T[], ranking: AiRanking | null | undefined, filter = "全部", onlySources = false): AiBoardRow<T>[] {
  const byCode = new Map(sources.map(row => [row.code, row]));
  // onlySources：只显示当前清单里的股票（被移除/删除的股票即使打过分也不再显示）。
  const ranked = [...(ranking?.items || [])].filter(item => !onlySources || byCode.has(item.code)).sort((a, b) => Number(Boolean(a.fallback)) - Number(Boolean(b.fallback)) || b.score - a.score)
    .filter(item => filter === "全部" || (!item.fallback && item.rating === filter))
    .map(item => ({ code: item.code, name: item.name, source: byCode.get(item.code), ai: item }));
  if (filter !== "全部") return ranked;
  const scored = new Set((ranking?.items || []).map(item => item.code));
  return [...ranked, ...sources.filter(row => !scored.has(row.code)).map(row => ({ code: row.code, name: row.name, source: row, ai: undefined }))];
}

/** 证券代码 → 行情 secid（沪市 1.，深市和北交所 0.）。 */
export const secidFor = (code: string) => `${code.startsWith("6") ? "1" : "0"}.${code}`;
