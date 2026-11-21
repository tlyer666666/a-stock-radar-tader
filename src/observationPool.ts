/** 涨停观察池：最近 10 个交易日涨停过的股票自动加入，用户自选的保留。 */
const OBSERVATION_FIELDS = [
  "code", "name", "secid", "thscode", "marketName", "assetType",
  "limitDate", "tradingDaysSince", "consecutiveBoards"
] as const;

export function mergeObservationPool(current: WatchItem[], recentLimitUps: WatchItem[]) {
  // 用户自己加的自选（含 ST/退市股）一律保留；ST/退 只在自动加入的涨停观察里排除。
  const favoriteItems = current.filter((item) => item.favorite || !item.autoAdded);
  const merged = new Map<string, WatchItem>();
  for (const item of recentLimitUps.filter(
    (entry) => Number(entry.tradingDaysSince) >= 1 && Number(entry.tradingDaysSince) <= 10 && !/ST|退/i.test(String(entry.name || ""))
  )) {
    const entry: Record<string, unknown> = {};
    for (const key of OBSERVATION_FIELDS) {
      const value = (item as Record<string, unknown>)[key];
      if (value !== undefined) entry[key] = value;
    }
    merged.set(item.code, {
      ...(entry as WatchItem),
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
}

export function sameWatchlist(a: WatchItem[], b: WatchItem[]): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (String(x?.code ?? "") !== String(y?.code ?? "")) return false;
    if (String(x?.name ?? "") !== String(y?.name ?? "")) return false;
    if ((x?.assetType ?? "stock") !== (y?.assetType ?? "stock")) return false;
    if (String(x?.createdAt ?? "") !== String(y?.createdAt ?? "")) return false;
    if (String(x?.note ?? "").trim() !== String(y?.note ?? "").trim()) return false;
    if (String(x?.limitDate ?? "") !== String(y?.limitDate ?? "")) return false;
    if ((x?.tradingDaysSince ?? null) !== (y?.tradingDaysSince ?? null)) return false;
    if (String(x?.observationNode ?? "") !== String(y?.observationNode ?? "")) return false;
    if ((x?.consecutiveBoards ?? null) !== (y?.consecutiveBoards ?? null)) return false;
    if ((x?.autoAdded === true) !== (y?.autoAdded === true)) return false;
    if ((x?.favorite === true) !== (y?.favorite === true)) return false;
    if (String(x?.favoriteAddedAt ?? "") !== String(y?.favoriteAddedAt ?? "")) return false;
  }
  return true;
}
