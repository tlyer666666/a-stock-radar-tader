export type BatchQuoteTradeStatus = "trading" | "suspended" | "delisted" | "unlisted";

export type BatchQuote = {
  code: string;
  name: string;
  latest: number;
  preClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  changePct: number | null;
  /** 手（可转债 1 手 = 10 张，股票 1 手 = 100 股） */
  volumeLots: number | null;
  /** 元 */
  amount: number | null;
  turnover: number | null;
  amplitude: number | null;
  floatMarketCap: number | null;
  totalMarketCap: number | null;
  limitUp: number | null;
  limitDown: number | null;
  /** 滚动市盈率（亏损为负或 null）与市净率。 */
  pe?: number | null;
  pb?: number | null;
  /** 五档买盘（价、手），买一在前；缺失档位不列出。 */
  bids?: Array<{ price: number; volumeLots: number }>;
  /** 五档卖盘（价、手），卖一在前；涨停封死时为空。 */
  asks?: Array<{ price: number; volumeLots: number }>;
  quoteAt: string;
  quoteDate: string;
  tradeStatus: BatchQuoteTradeStatus;
  source: string;
};

export type BatchQuoteRequest = {
  code: string;
  secid?: string | undefined;
  thscode?: string | undefined;
  assetType?: string | undefined;
};

export type BatchQuoteResult = {
  quotes: Record<string, BatchQuote>;
  missing: string[];
  source: string;
  fetchedAt: string;
};
