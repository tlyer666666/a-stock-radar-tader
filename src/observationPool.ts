/** 涨停观察池：最近 10 个交易日涨停过的股票自动加入，用户自选的保留。 */
export function mergeObservationPool(current: WatchItem[], recentLimitUps: any[]) {
  // 用户自己加的自选（含 ST/退市股）一律保留；ST/退 只在自动加入的涨停观察里排除。
  const favoriteItems = current.filter((item) => item.favorite || !item.autoAdded);
  const merged = new Map<string, WatchItem>();
  for (const item of recentLimitUps.filter(
    (entry) => Number(entry.tradingDaysSince) >= 1 && Number(entry.tradingDaysSince) <= 10 && !/ST|退/i.test(String(entry.name || ""))
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
}
