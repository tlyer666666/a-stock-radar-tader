export type EtfCategory = "宽基" | "行业主题" | "跨境" | "商品" | "债券" | "货币";

export type EtfItem = {
  code: string;
  name: string;
  secid: string;
  category: EtfCategory;
  /** 交易所允许当日回转交易（跨境、商品、债券、货币 ETF）；旧缓存可能缺失，按类别推断。 */
  t0?: boolean | undefined;
  latest: number | null;
  changePct: number | null;
  /** 振幅 %（日内最高与最低之差 ÷ 昨收），T+0 日内回转参考；缺失为 null。 */
  amplitude?: number | null | undefined;
  volume: number | null;
  amount: number | null;
  turnover: number | null;
  volumeRatio: number | null;
  open: number | null;
  preClose: number | null;
  scale: number | null;
  iopv: number | null;
  premiumPct: number | null;
};

export type EtfMarketSnapshot = {
  fetchedAt: string;
  items: EtfItem[];
  summary: { count: number; rising: number; falling: number; flat: number; totalAmount: number; highPremium: number; byCategory: Record<EtfCategory, number>; t0Count?: number | undefined };
  topThemes: Array<Pick<EtfItem, "code" | "name" | "secid" | "changePct" | "amount">>;
  highPremiumPercent: number;
  complete: boolean;
  warnings: string[];
};
