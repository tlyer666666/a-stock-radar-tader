export type ConvertibleBond = {
  code: string;
  name: string;
  market: 19 | 35;
  stockCode: string;
  stockName: string;
  listingDate: string;
  expireDate: string;
  source: "feed" | "discovered";
  latest: number | null;
  preClose: number | null;
  changePct: number | null;
  amount: number | null;
  /** 张 */
  volume: number | null;
  turnover: number | null;
  amplitude: number | null;
  high: number | null;
  low: number | null;
  quoteAt: string;
  quoteStatus: "ready" | "unavailable";
  remainingYears: number | null;
  secid: string;
  thscode: string;
};

export type UpcomingBond = Pick<ConvertibleBond, "code" | "name" | "stockCode" | "stockName" | "listingDate" | "expireDate">;

export type ConvertibleBondSnapshot = {
  source: string;
  fetchedAt: string;
  asOf: string;
  members: ConvertibleBond[];
  upcoming: UpcomingBond[];
  summary: { count: number; quoted: number; rising: number; falling: number; flat: number; medianChangePct: number | null; amount: number };
  quoteCoverage: { loaded: number; total: number; pending: boolean; complete: boolean };
  roster: { discoveredAt: string | null; feedCount: number; discoveredCount: number; discovering: { checked: number; total: number; found: number } | null };
  warnings: string[];
};

export type BondSort = "change-desc" | "change-asc" | "amount-desc" | "amount-asc" | "turnover-desc" | "turnover-asc" | "price-asc" | "price-desc" | "years-asc" | "years-desc";
export type BondSortColumn = "price" | "change" | "amount" | "turnover" | "years";

/** 表头点击：第一次从大到小，再点从小到大。 */
export function toggleBondSort(current: BondSort, column: BondSortColumn): BondSort {
  const [key, direction] = current.split("-") as [BondSortColumn, "asc" | "desc"];
  return key === column && direction === "desc" ? `${column}-asc` as BondSort : `${column}-desc` as BondSort;
}

export function bondSortState(sort: BondSort, column: BondSortColumn): "ascending" | "descending" | "none" {
  const [key, direction] = sort.split("-");
  return key !== column ? "none" : direction === "desc" ? "descending" : "ascending";
}
export type BondMarketFilter = "all" | "sh" | "sz";
export type BondPriceFilter = "all" | "low" | "mid" | "high";

const valueOf = (bond: ConvertibleBond, sort: BondSort) => {
  if (sort === "change-desc" || sort === "change-asc") return bond.changePct;
  if (sort === "amount-desc" || sort === "amount-asc") return bond.amount;
  if (sort === "turnover-desc" || sort === "turnover-asc") return bond.turnover;
  if (sort === "years-asc" || sort === "years-desc") return bond.remainingYears;
  return bond.latest;
};

/** 筛选 + 排序；没有行情（或该字段缺失）的转债排在最后，保持代码顺序。 */
export function selectBonds(bonds: ConvertibleBond[], { query, market, price, sort }: { query: string; market: BondMarketFilter; price: BondPriceFilter; sort: BondSort }) {
  const needle = query.trim().toLowerCase();
  const ascending = sort.endsWith("-asc");
  return bonds
    .filter((bond) => !needle || `${bond.code} ${bond.name} ${bond.stockCode} ${bond.stockName}`.toLowerCase().includes(needle))
    .filter((bond) => market === "all" || (market === "sh" ? bond.market === 19 : bond.market === 35))
    .filter((bond) => {
      if (price === "all") return true;
      if (!(Number(bond.latest) > 0)) return false;
      const latest = Number(bond.latest);
      return price === "low" ? latest < 110 : price === "mid" ? latest >= 110 && latest <= 130 : latest > 130;
    })
    .map((bond, index) => ({ bond, index, value: valueOf(bond, sort) }))
    .sort((a, b) => {
      const left = Number.isFinite(a.value) ? (a.value as number) : null;
      const right = Number.isFinite(b.value) ? (b.value as number) : null;
      if (left === null && right === null) return a.bond.code.localeCompare(b.bond.code);
      if (left === null) return 1;
      if (right === null) return -1;
      return (ascending ? left - right : right - left) || a.bond.code.localeCompare(b.bond.code);
    })
    .map((item) => item.bond);
}
