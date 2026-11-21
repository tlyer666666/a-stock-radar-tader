import type { EtfCategory, EtfItem } from "./etfTypes";

export type EtfCategoryFilter = "all" | "T+0" | EtfCategory;
export type EtfSortColumn = "change" | "amount" | "turnover" | "volumeRatio" | "scale" | "premium" | "amplitude";
export type EtfSort = { column: EtfSortColumn; direction: "desc" | "asc" };

export const ETF_CATEGORY_FILTERS: EtfCategoryFilter[] = ["all", "T+0", "宽基", "行业主题", "跨境", "商品", "债券", "货币"];

/** 交易所规定可 T+0 回转交易的 ETF 类别；A 股股票型（宽基、行业主题）为 T+1。 */
const T0_CATEGORIES: ReadonlySet<EtfCategory> = new Set<EtfCategory>(["跨境", "商品", "债券", "货币"]);

export function isT0Etf(item: Pick<EtfItem, "category" | "t0">): boolean {
  return typeof item.t0 === "boolean" ? item.t0 : T0_CATEGORIES.has(item.category);
}

export function countByFilter(items: EtfItem[], filter: EtfCategoryFilter): number {
  return filter === "all" ? items.length : filter === "T+0" ? items.filter(isT0Etf).length : items.filter(item => item.category === filter).length;
}

/**
 * T+0 板块的活跃榜：去掉货币 ETF（几乎不波动，不适合日内回转），
 * 只看成交额达到门槛的，按成交额排序，振幅作为日内空间参考。
 */
export function t0ActiveEtfs(items: EtfItem[], { limit = 8, minAmount = 5e7 }: { limit?: number; minAmount?: number } = {}): EtfItem[] {
  return items
    .filter(item => isT0Etf(item) && item.category !== "货币" && item.latest !== null && (item.amount ?? 0) >= minAmount)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, limit);
}

const sortValue = (item: EtfItem, column: EtfSortColumn): number | null => ({
  change: item.changePct, amount: item.amount, turnover: item.turnover, volumeRatio: item.volumeRatio, scale: item.scale, premium: item.premiumPct, amplitude: item.amplitude ?? null
})[column];

export function selectEtfs(items: EtfItem[], { category = "all", query = "", sort = { column: "amount", direction: "desc" } }: { category?: EtfCategoryFilter; query?: string; sort?: EtfSort } = {}): EtfItem[] {
  const q = query.trim().toLowerCase();
  const filtered = items.filter(item => (category === "all" || (category === "T+0" ? isT0Etf(item) : item.category === category)) && (!q || item.code.includes(q) || item.name.toLowerCase().includes(q)));
  const sign = sort.direction === "desc" ? -1 : 1;
  return filtered
    .map((item, index) => ({ item, index, value: sortValue(item, sort.column) }))
    .sort((a, b) => (a.value === null) === (b.value === null) ? (a.value === null || b.value === null ? a.index - b.index : sign * (a.value - b.value) || a.index - b.index) : a.value === null ? 1 : -1)
    .map(entry => entry.item);
}

export function toggleEtfSort(current: EtfSort, column: EtfSortColumn): EtfSort {
  return current.column === column ? { column, direction: current.direction === "desc" ? "asc" : "desc" } : { column, direction: "desc" };
}

export function premiumWarning(item: EtfItem, threshold: number): string {
  if (item.premiumPct === null) return "";
  if (item.premiumPct > threshold) return `价格比实时净值高 ${item.premiumPct.toFixed(2)}%，追高买入要承担溢价回落的风险`;
  if (item.premiumPct < -threshold) return `价格比实时净值低 ${Math.abs(item.premiumPct).toFixed(2)}%，折价较大，留意流动性`;
  return "";
}

export function etfSecurity(item: Pick<EtfItem, "code" | "name" | "secid">): Security {
  return { code: item.code, name: item.name, secid: item.secid, assetType: "etf", marketName: "ETF" };
}
