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
