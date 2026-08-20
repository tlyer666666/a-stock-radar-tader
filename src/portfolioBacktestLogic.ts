export type StrategyUniverseSelection = {
  candidates: any[];
  source: string;
};

const uniqueStrategyIds = (value: unknown) => [
  ...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )
];

const hasSameStrategySet = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id) => right.includes(id));

const isPublishedStrategyGroup = (group: any) => {
  if (typeof group?.publicationAccepted === "boolean") {
    return group.publicationAccepted;
  }
  if (typeof group?.validation?.publicationAccepted === "boolean") {
    return group.validation.publicationAccepted;
  }
  return group?.validation?.accepted === true;
};

export const matchesInitialStrategySignature = (
  context: { strategyIds?: string[]; minimumVotes?: number } | null | undefined,
  selectedStrategyIds: string[],
  minimumVotes: number
) => {
  if (!context) return false;
  const initialIds = uniqueStrategyIds(context.strategyIds);
  const selectedIds = uniqueStrategyIds(selectedStrategyIds);
  return (
    hasSameStrategySet(initialIds, selectedIds) &&
    Number(context.minimumVotes) === Number(minimumVotes)
  );
};

export const resolvePublishedStrategyUniverse = (
  report: any,
  requestedStrategyIds: string[],
  requestedMinimumVotes: number
): StrategyUniverseSelection => {
  const requestedIds = uniqueStrategyIds(requestedStrategyIds);
  if (!requestedIds.length) {
    throw new Error("请至少选择 1 套策略");
  }
  const minimumVotes = Math.max(1, Math.round(Number(requestedMinimumVotes) || 1));
  const groups = Array.isArray(report?.strategies) ? report.strategies : [];
  const groupsById = new Map<string, any>();
  for (const group of groups) {
    const id = String(group?.id || "").trim();
    if (id && !groupsById.has(id)) groupsById.set(id, group);
  }
  const missing = requestedIds.filter((id) => !groupsById.has(id));
  if (missing.length) {
    throw new Error(`所选策略尚未通过发布复核或策略服务未返回：${missing.join("、")}`);
  }
  const selectedGroups = requestedIds.map((id) => groupsById.get(id));
  const rejected = selectedGroups
    .filter((group) => !isPublishedStrategyGroup(group))
    .map((group) => String(group?.name || group?.id || "未知策略"));
  if (rejected.length) {
    throw new Error(`所选策略未通过发布复核，不能生成回测股票池：${rejected.join("、")}`);
  }

  const optimized = report?.optimizedPortfolio;
  const optimizedIds = uniqueStrategyIds(
    Array.isArray(optimized?.selectedStrategies)
      ? optimized.selectedStrategies.map((item: any) => item?.id)
      : []
  );
  const rawOptimizedMinimumVotes = Number(optimized?.minimumVotes);
  const optimizedMinimumVotes = Number.isFinite(rawOptimizedMinimumVotes)
    ? Math.max(1, Math.round(rawOptimizedMinimumVotes))
    : null;
  if (
    requestedIds.length > 1 &&
    optimized?.publicationAccepted === true &&
    hasSameStrategySet(requestedIds, optimizedIds) &&
    optimizedMinimumVotes === minimumVotes
  ) {
    return {
      candidates: Array.isArray(optimized.stocks) ? optimized.stocks : [],
      source: "稳健优选组合本轮命中"
    };
  }

  const votes = new Map<string, { stock: any; count: number; score: number }>();
  for (const group of selectedGroups) {
    const countedCodes = new Set<string>();
    for (const stock of Array.isArray(group?.stocks) ? group.stocks : []) {
      const code = String(stock?.code || "");
      if (!/^\d{6}$/.test(code) || countedCodes.has(code)) continue;
      countedCodes.add(code);
      const current = votes.get(code) || { stock, count: 0, score: 0 };
      current.count += 1;
      current.score = Math.max(
        current.score,
        Number(stock?.signalScore || stock?.score || 0)
      );
      votes.set(code, current);
    }
  }
  return {
    candidates: [...votes.values()]
      .filter((item) => item.count >= minimumVotes)
      .sort((left, right) => right.count - left.count || right.score - left.score)
      .map((item) => ({ ...item.stock, strategyVotes: item.count })),
    source: "已发布策略的本轮命中"
  };
};
