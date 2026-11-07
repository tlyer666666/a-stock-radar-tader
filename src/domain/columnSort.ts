/**
 * 表头点击排序的统一规则（板块榜、成分股、可转债等表格共用）：
 *   · 第一次点某一列 → 从大到小；再点同一列 → 从小到大，来回切换。
 *   · 没有数值（null / 非数字）的行无论升降序都排在最后，保持原有相对顺序。
 */
export type SortDirection = "desc" | "asc";
export type ColumnSort<K extends string = string> = { key: K; direction: SortDirection };

export function toggleColumnSort<K extends string>(current: ColumnSort<K>, key: K): ColumnSort<K> {
  return current.key === key
    ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
    : { key, direction: "desc" };
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function sortRowsBy<T>(rows: readonly T[], value: (row: T) => unknown, direction: SortDirection): T[] {
  return rows
    .map((row, index) => ({ row, index, value: finite(value(row)) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return (direction === "desc" ? b.value - a.value : a.value - b.value) || a.index - b.index;
    })
    .map((item) => item.row);
}

export function ariaSortOf<K extends string>(sort: ColumnSort<K>, key: K): "ascending" | "descending" | "none" {
  return sort.key !== key ? "none" : sort.direction === "desc" ? "descending" : "ascending";
}

export function sortGlyph<K extends string>(sort: ColumnSort<K>, key: K) {
  return sort.key !== key ? "" : sort.direction === "desc" ? " ▾" : " ▴";
}

export function sortButtonLabel<K extends string>(sort: ColumnSort<K>, key: K, label: string) {
  if (sort.key !== key) return `按${label}从大到小排序`;
  return sort.direction === "desc" ? `按${label}排序，当前从大到小，点击改为从小到大` : `按${label}排序，当前从小到大，点击改为从大到小`;
}
