/// <reference types="vite/client" />

type Security = {
  code: string;
  name: string;
  secid: string;
  thscode?: string;
  marketName?: string;
  assetType?: "stock" | "etf" | "convertibleBond";
  defaultVisible?: boolean;
};

type PortfolioBacktestSignalEvent = {
  sampleId?: string;
  code: string;
  name: string;
  strategyId?: string;
  strategyIds?: string[];
  strategyNames?: string[];
  signalDate: string;
  entryDate?: string;
  exitDate?: string;
  status: "filled" | "rejected" | "pending" | string;
  reason?: string;
  reasonText?: string;
  allocation?: number;
  shares?: number;
  pnl?: number;
  netReturnPercent?: number;
};

type PortfolioBacktestSignalDateGroup = {
  signalDate: string;
  date?: string;
  events?: PortfolioBacktestSignalEvent[];
  signals?: PortfolioBacktestSignalEvent[];
  items?: PortfolioBacktestSignalEvent[];
};

type PortfolioBacktestResult = {
  signalEvents?: PortfolioBacktestSignalEvent[];
  signalTimeline?: Array<PortfolioBacktestSignalEvent | PortfolioBacktestSignalDateGroup>;
  signals?: PortfolioBacktestSignalEvent[];
  [key: string]: any;
};

type WatchItem = Security & {
  createdAt: string;
  note?: string;
  limitDate?: string;
  tradingDaysSince?: number;
  observationNode?: string;
  consecutiveBoards?: number;
  autoAdded?: boolean;
  favorite?: boolean;
  favoriteAddedAt?: string;
};

type HoldingItem = Security & {
  shares: number;
  costPrice: number;
  createdAt: string;
  updatedAt: string;
  note?: string;
};

type Settings = {
  riskProfile: "conservative" | "balanced" | "aggressive";
  provider: "eastmoney" | "ths";
  refreshToken: string;
  tushareToken: string;
  multiSourceEnabled: boolean;
  fallbackEnabled: boolean;
  quoteRefreshSeconds: number;
  refreshSeconds: number;
  newsRefreshSeconds: number;
  newsVoiceEnabled: boolean;
  alertScore: number;
  exactNodesOnly: boolean;
  strictGate: boolean;
  maxPositionPercent: number;
  maxRiskPerTradePercent: number;
  stopLossATRMultiple: number;
  takeProfitATRMultiple: number;
  maxHoldingBars: number;
  minMarketCap: number;
  maxDailyRiskPercent?: number;
  maxPortfolioRiskPercent?: number;
  minProjectedNetEdgePercent?: number;
  minExpectancyPoints?: number;
  maxConsecutiveLossesForStop?: number;
  maxDailyTrades?: number;
  lossStreakStepPercent?: number;
  lossStreakFloorPercent?: number;
  minPaperWinRatePercent?: number;
  minExecutionRatePercent?: number;
  minPaperRiskRewardRatio?: number;
  maxSectorExposurePercent?: number;
  minTurnoverPercent?: number;
  minQuoteAmount?: number;
  maxQuoteAgeSeconds?: number;
  trailingStopPercent?: number;
  commissionBps?: number;
  slippageBps?: number;
  timeDecayPerBarPercent?: number;
  maxOpenPositions?: number;
  enabledPaperSim?: boolean;
  selectedStrategies: string[];
  theme: "light" | "dark" | "system";
};

interface Window {
  stockApi: {
    search(query: string): Promise<Security[]>;
    analyze(security: Security | string, options?: { forceRefresh?: boolean }): Promise<any>;
    getQuoteSnapshot(security: Security | string): Promise<any>;
    getDataFederation(security: Security | string): Promise<any>;
    getChart(
      security: Security | string,
      interval: string,
      options?: { range?: string; limit?: number; adjustment?: string }
    ): Promise<{
      rows: any[];
      interval: string;
      range: string;
      visibleLimit: number;
      source: string;
      sourceClass: string;
      dataSource: string;
      adjustment: string;
      updatedAt: string;
      availableFrom: string;
      availableTo: string;
      isPartial: boolean;
      note: string;
    }>;
    discoverLimitUps(options?: { forceRefresh?: boolean }): Promise<{
      rows: any[];
      meta: { dataDate: string; fetchedAt: string; providers: string[] };
    }>;
    getLimitUpPoolSnapshot(options?: { forceRefresh?: boolean }): Promise<{
      rows: any[];
      meta: { dataDate: string; fetchedAt: string; providers: string[] };
    }>;
    discoverRecentLimitUps(days?: number, options?: { forceRefresh?: boolean }): Promise<any[]>;
    getLimitUpSectorBoard(options?: { forceRefresh?: boolean }): Promise<any[]>;
    searchSectors(query: string): Promise<any[]>;
    getConceptChain(query: string | Record<string, any>): Promise<any>;
    analyzeSector(sector: any): Promise<any>;
    getProfessionalReview(options?: { refresh?: boolean }): Promise<any>;
    getNewsFeed(input: Record<string, any>): Promise<any>;
    refreshNewsFeed(input: Record<string, any>): Promise<any>;
    getStrategyDefinitions(): Promise<any[] | { strategies?: any[]; definitions?: any[] }>;
    runPortfolioBacktest(options: {
      securities: Security[];
      universe: string[];
      strategyIds: string[];
      minimumVotes: number;
      strategyContext: {
        source: string;
        strategyEngine: string;
        strategyId: string;
        strategyName: string;
        strategyVersion?: string;
        strategyIds: string[];
        minimumVotes: number;
      };
      universeSource?: "strategy_current_matches" | "manual";
      startingCapital: number;
      maxPositions: number;
      lookbackBars: number;
      commissionBps: number;
      slippageBps: number;
      benchmark: string;
      accountMode: "shared_cash";
      lotSize: number;
    }): Promise<PortfolioBacktestResult>;
    runBacktest(
      security: Security | string,
      options?: {
        startDate?: string;
        customEntryPrice?: number | null;
        lookbackBars?: number;
        benchmarks?: number;
        benchmark?: "all" | "szzs" | "hs300";
        minSamples?: number;
        minProjectedNetEdgePercent?: number;
        minExpectancyPoints?: number;
        commissionBps?: number;
        slippageBps?: number;
        signalStrategyIds?: string[];
        strategyContext?: {
          source?: "single_strategy" | "optimized_portfolio";
          strategyEngine?: "verified-signal-v2";
          strategyId: string;
          strategyName: string;
          strategyVersion?: string;
          strategyIds: string[];
          minimumVotes: number;
        };
        settings?: Partial<Settings>;
      }
    ): Promise<any>;
    scanStrategySignals(options?: {
      strategyIds?: string[];
      lookbackDays?: number;
      historyBars?: number;
      maxUniverse?: number;
      maxStocksPerStrategy?: number;
      minSamples?: number;
      minOutOfSampleSamples?: number;
      minIndependentSignalDays?: number;
      minWalkForwardFoldSamples?: number;
      walkForwardFolds?: number;
      refresh?: boolean;
    }): Promise<any>;
    getWatchlist(): Promise<WatchItem[]>;
    saveWatchlist(items: WatchItem[]): Promise<WatchItem[]>;
    getHoldings(): Promise<HoldingItem[]>;
    saveHoldings(items: HoldingItem[]): Promise<HoldingItem[]>;
    getSettings(): Promise<Settings>;
    saveSettings(settings: Settings): Promise<Settings>;
    testProvider(settings: Settings): Promise<any>;
    setTheme(theme: Settings["theme"]): Promise<void>;
    controlWindow(
      action: "minimize" | "toggle-maximize" | "close"
    ): Promise<{ ok: boolean; maximized: boolean }>;
    openExternal(url: string): Promise<void>;
    getPlatform(): "win32" | "darwin" | "linux" | string;
    getVersion(): Promise<string>;
  };
}
