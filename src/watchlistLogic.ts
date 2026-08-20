export type ObservationExclusion = {
  code: string;
  limitDate: string;
  excludedAt: string;
};

const EXCLUSION_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

const validLimitDate = (value: unknown) => {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
};

export const normalizeObservationExclusions = (
  input: unknown,
  now = Date.now()
): ObservationExclusion[] => {
  if (!Array.isArray(input)) return [];
  const byCode = new Map<string, ObservationExclusion>();
  for (const item of input) {
    const code = String(item?.code || "");
    const excludedAt = String(item?.excludedAt || "");
    const timestamp = Date.parse(excludedAt);
    if (!/^\d{6}$/.test(code) || !Number.isFinite(timestamp)) continue;
    if (now - timestamp > EXCLUSION_MAX_AGE_MS) continue;
    byCode.set(code, {
      code,
      limitDate: validLimitDate(item?.limitDate),
      excludedAt: new Date(timestamp).toISOString()
    });
  }
  return [...byCode.values()];
};

export const upsertObservationExclusion = (
  current: ObservationExclusion[],
  item: Pick<WatchItem, "code" | "limitDate">,
  now = new Date().toISOString()
) => normalizeObservationExclusions([
  ...current.filter((entry) => entry.code !== item.code),
  {
    code: item.code,
    limitDate: validLimitDate(item.limitDate),
    excludedAt: now
  }
], Date.parse(now));

export const isObservationExcluded = (
  item: Pick<WatchItem, "code" | "limitDate">,
  exclusions: ObservationExclusion[]
) => exclusions.some((exclusion) => {
  if (exclusion.code !== item.code) return false;
  const itemLimitDate = validLimitDate(item.limitDate);
  return !exclusion.limitDate || !itemLimitDate || exclusion.limitDate === itemLimitDate;
});

export const removeObservationFromWatchlist = (
  current: WatchItem[],
  code: string
): WatchItem[] => current.flatMap((item) => {
  if (item.code !== code) return [item];
  if (item.favorite !== true) return [];
  const favoriteOnly = { ...item, autoAdded: false };
  delete favoriteOnly.observationNode;
  delete favoriteOnly.tradingDaysSince;
  if (/^涨停后第\s*\d+\s*个交易日/.test(favoriteOnly.note || "")) {
    favoriteOnly.note = "";
  }
  return [favoriteOnly];
});

export const mergeObservationPool = (
  current: WatchItem[],
  recentLimitUps: any[],
  exclusions: ObservationExclusion[] = []
) => {
  const activeExclusions = normalizeObservationExclusions(exclusions);
  const favoriteItems = current.filter(
    (item) => (item.favorite || !item.autoAdded) && !/ST|退/i.test(item.name)
  );
  const merged = new Map<string, WatchItem>();
  for (const item of recentLimitUps.filter(
    (entry) =>
      Number(entry.tradingDaysSince) >= 1 &&
      Number(entry.tradingDaysSince) <= 10 &&
      !isObservationExcluded(entry, activeExclusions)
  )) {
    merged.set(item.code, {
      ...item,
      createdAt: item.limitDate || new Date().toISOString(),
      observationNode: `T+${item.tradingDaysSince}`,
      note: `涨停后第 ${item.tradingDaysSince} 个交易日 · ${item.limitDate || ""}`,
      autoAdded: true
    });
  }
  for (const item of favoriteItems) {
    const observation = merged.get(item.code);
    if (observation) {
      merged.set(item.code, {
        ...observation,
        favorite: true,
        favoriteAddedAt: item.favoriteAddedAt || item.createdAt
      });
    } else {
      merged.set(item.code, {
        ...item,
        favorite: true,
        autoAdded: false
      });
    }
  }
  return [...merged.values()];
};
