import type { ChartCandleRow } from "../../shared/ipc-contract";

export type AnalysisQuote = {
  code?: string | undefined;
  name?: string | undefined;
  secid?: string | undefined;
  industry?: string | undefined;
  latest?: number | null | undefined;
  price?: number | null | undefined;
  preClose?: number | null | undefined;
  changePct?: number | null | undefined;
  changePercent?: number | null | undefined;
  turnover?: number | null | undefined;
  amount?: number | null | undefined;
  volume?: number | null | undefined;
  marketStatus?: string | undefined;
  source?: string | undefined;
  quoteAt?: string | undefined;
  updatedAt?: string | undefined;
  quoteAtIsTradeTime?: boolean | undefined;
  missingFields?: string[] | undefined;
  assetLabel?: string | undefined;
  open?: number | null | undefined;
  high?: number | null | undefined;
  low?: number | null | undefined;
  limitUp?: number | null | undefined;
  limitDown?: number | null | undefined;
  change?: number | null | undefined;
  [key: string]: unknown;
};

export type AnalysisLimitEvent = {
  date?: string | undefined;
  low?: number | undefined;
  high?: number | undefined;
  close?: number | undefined;
  [key: string]: unknown;
};

export type AnalysisStrategyResult = {
  id: string;
  label?: string | undefined;
  detail?: string | undefined;
  matched?: boolean | undefined;
};

export type AnalysisTradePlan = {
  signal?: string | undefined;
  entryPrice?: number | undefined;
  stopLossPrice?: number | undefined;
  takeProfitPrice?: number | undefined;
  stopLossDistancePercent?: number | undefined;
  takeProfitDistancePercent?: number | undefined;
  positionSizePercent?: number | undefined;
  maxPositionPercent?: number | undefined;
  maxLossBudgetPercent?: number | undefined;
  executionFillRatePercent?: number | undefined;
  riskReward?: number | undefined;
  halfKellyFraction?: number | undefined;
  kellyPositionPercent?: number | undefined;
  projectedCommissionPercent?: number | undefined;
  killSwitchTriggered?: boolean | undefined;
  killSwitchReasons?: string[] | undefined;
  [key: string]: unknown;
};

export type AnalysisTradeProjection = {
  projection?: {
    strategyLabel?: string | undefined;
    expectedReturnPercent?: number | undefined;
    projectedNetEdge?: number | undefined;
    expectancyPoints?: number | undefined;
    executionFillRatePercent?: number | undefined;
    rrSafety?: number | undefined;
    probabilityTakeProfit?: number | undefined;
    probabilityStopLoss?: number | undefined;
    probabilityTimeExit?: number | undefined;
    kellyPositionPercent?: number | undefined;
    kellyHalfFraction?: number | undefined;
    estimatedHoldingBars?: number | undefined;
    riskReward?: number | undefined;
    [key: string]: unknown;
  } | undefined;
  [key: string]: unknown;
};

export type AnalysisExecutionPolicy = {
  riskProfile?: string | undefined;
  minExecutionRatePercent?: number | undefined;
  minProjectedNetEdgePercent?: number | undefined;
  minExpectancyPoints?: number | undefined;
  maxDailyRiskPercent?: number | undefined;
  maxHoldingBars?: number | undefined;
  maxOpenPositions?: number | undefined;
  trailingStopPercent?: number | undefined;
  timeDecayPerBarPercent?: number | undefined;
  maxConsecutiveLossesForStop?: number | undefined;
  lossStreakStepPercent?: number | undefined;
  maxPortfolioRiskPercent?: number | undefined;
  maxSectorExposurePercent?: number | undefined;
  [key: string]: unknown;
};

export type AnalysisFirstBoardFactor = {
  id: string;
  label?: string | undefined;
  value?: string | number | undefined;
  passed?: boolean | undefined;
  points?: number | undefined;
  maxPoints?: number | undefined;
  threshold?: string | number | undefined;
};

export type AnalysisFirstBoardQuality = {
  available?: boolean | undefined;
  dataComplete?: boolean | undefined;
  matched?: boolean | undefined;
  score?: number | undefined;
  grade?: string | undefined;
  summary?: string | undefined;
  firstSealTime?: string | undefined;
  lastSealTime?: string | undefined;
  openBoardCount?: number | undefined;
  turnover?: number | undefined;
  sealFloatRatio?: number | null | undefined;
  sealedAmount?: number | undefined;
  factors?: AnalysisFirstBoardFactor[] | undefined;
  risks?: string[] | undefined;
};

export type AnalysisHistoricalStatRow = {
  id: string;
  label?: string | undefined;
  available?: boolean | undefined;
  unavailableReason?: string | undefined;
  confidenceNote?: string | undefined;
  sampleCount?: number | undefined;
  n1?: number | undefined;
  n3?: number | undefined;
  n5?: number | undefined;
  winRate1?: number | undefined;
  winRate3?: number | undefined;
  winRate5?: number | undefined;
  winRate5Interval?: [number, number] | number[] | undefined;
  average5?: number | undefined;
  averageExcess5?: number | undefined;
  worstMdd5?: number | undefined;
  confidence?: string | undefined;
};

export type AnalysisHistoricalNodeStatRow = {
  node: string;
  sampleCount?: number | undefined;
  n5?: number | undefined;
  winRate5?: number | undefined;
  average5?: number | undefined;
  averageExcess5?: number | undefined;
  confidence?: string | undefined;
};

export type AnalysisHistoricalStats = {
  source?: string | undefined;
  range?: string | undefined;
  entryRule?: string | undefined;
  totalEvents?: number | undefined;
  benchmarkAvailable?: boolean | undefined;
  rawEventCount?: number | undefined;
  untradeableCount?: number | undefined;
  stats?: AnalysisHistoricalStatRow[] | undefined;
  nodeStats?: AnalysisHistoricalNodeStatRow[] | undefined;
  [key: string]: unknown;
};

export type AnalysisHistoricalEdge = {
  passed?: boolean | undefined;
  average5?: number | undefined;
  winRate5?: number | undefined;
  sampleCount?: number | undefined;
  worstMdd5?: number | undefined;
  confidence?: string | undefined;
  passReason?: string | undefined;
  [key: string]: unknown;
};

export type AnalysisQualification = {
  alertScore?: number | undefined;
  exactNodesOnly?: boolean | undefined;
  riskVetoPassed?: boolean | undefined;
  historicalEdgePassed?: boolean | undefined;
  [key: string]: unknown;
};

export type AnalysisReadinessSummary = {
  level?: string | undefined;
  status?: string | undefined;
  score?: number | undefined;
  summary?: string | undefined;
  recommendation?: string | undefined;
  reasons?: string[] | undefined;
  canExecute?: boolean | undefined;
  canRunLive?: boolean | undefined;
  [key: string]: unknown;
};

export type AnalysisSummaryData = {
  mrs?: number | undefined;
  score?: number | undefined;
  grade?: string | undefined;
  trendLabel?: string | undefined;
  structureScore?: number | undefined;
  sectorScore?: number | undefined;
  infoScore?: number | undefined;
  isSearchOnlyAsset?: boolean | undefined;
  assetLabel?: string | undefined;
  limitEvent?: AnalysisLimitEvent | null | undefined;
  exactNode?: string | null | undefined;
  nextNode?: string | null | undefined;
  daysSince?: number | null | undefined;
  supportDistance?: number | null | undefined;
  supportLow?: number | undefined;
  platformHigh?: number | undefined;
  heldSupport?: boolean | undefined;
  avwap?: number | undefined;
  ma5?: number | undefined;
  ma10?: number | undefined;
  volumeRatio?: number | null | undefined;
  relativeTurnover?: number | null | undefined;
  closePosition?: number | undefined;
  maxDrawdown?: number | undefined;
  divergence?: number | undefined;
  maBull?: boolean | undefined;
  slopesUp?: boolean | undefined;
  originBreakout?: boolean | undefined;
  rsSector?: number | undefined;
  stockReturn3?: number | undefined;
  marketCap?: number | null | undefined;
  qualityIndex?: number | undefined;
  alertQualified?: boolean | undefined;
  strategyQualified?: boolean | undefined;
  strategyMatched?: number | undefined;
  strategyTotal?: number | undefined;
  strategyMatchRate?: number | undefined;
  strategyResults?: AnalysisStrategyResult[] | undefined;
  firstBoardQuality?: AnalysisFirstBoardQuality | null | undefined;
  sectorLadder?: {
    state?: string | undefined;
    currentLimitUps?: number | undefined;
    maxHeight?: number | undefined;
    promotionRate?: number | undefined;
    breakRate?: number | undefined;
    [key: string]: unknown;
  } | null | undefined;
  sectorLadderScore?: number | undefined;
  marketEmotion?: {
    state?: string | undefined;
    limitUpCount?: number | undefined;
    limitDownCount?: number | undefined;
    limitDownRatio?: number | undefined;
    [key: string]: unknown;
  } | null | undefined;
  marketScore?: number | undefined;
  actionSignal?: string | undefined;
  quote?: { latest?: number | null | undefined; [key: string]: unknown } | undefined;
  historicalStats?: AnalysisHistoricalStats | null | undefined;
  historicalEdge?: AnalysisHistoricalEdge | number | null | undefined;
  regimeProfile?: RegimeWeightProfile | null | undefined;
  externalArchiveDays?: number | undefined;
  qualification?: AnalysisQualification | undefined;
  tradePlan?: AnalysisTradePlan | undefined;
  tradeProjection?: AnalysisTradeProjection | undefined;
  executionPolicy?: AnalysisExecutionPolicy | undefined;
  tradeExecutionReadiness?: AnalysisReadinessSummary | null | undefined;
  executionReadiness?: AnalysisReadinessSummary | null | undefined;
  highlights?: string[] | undefined;
  risks?: string[] | undefined;
  [key: string]: unknown;
};

export type AnalysisSectorSnapshot = {
  name?: string | undefined;
  code?: string | undefined;
  state?: string | undefined;
  score?: number | null | undefined;
  returns?: { r1?: number | null | undefined; r3?: number | null | undefined; r5?: number | null | undefined; [key: string]: unknown } | undefined;
  benchmarkReturns?: { r1?: number | null | undefined; r3?: number | null | undefined; r5?: number | null | undefined; [key: string]: unknown } | undefined;
  breadth?: number | null | undefined;
  limitUps?: number | null | undefined;
  amountHeat?: number | null | undefined;
  persistence?: number | null | undefined;
  [key: string]: unknown;
};

export type AnalysisFederationSource = {
  id: string;
  name?: string | undefined;
  enabled?: boolean | undefined;
  ok?: boolean | null | undefined;
  latest?: number | null | undefined;
  role?: string | undefined;
  latencyMs?: number | null | undefined;
};

export type AnalysisDataFederation = {
  sources?: AnalysisFederationSource[] | undefined;
  spreadPct?: number | null | undefined;
  realtimeCount?: number | null | undefined;
  status?: string | undefined;
  consensusPrice?: number | null | undefined;
  note?: string | undefined;
  [key: string]: unknown;
};

export type AnalysisAnnouncement = {
  art_code?: string | undefined;
  direction?: string | undefined;
  score?: number | string | undefined;
  title?: string | undefined;
  category?: string | undefined;
  display_time?: string | undefined;
  [key: string]: unknown;
};

export type AnalysisPayload = {
  security: Security;
  quote: AnalysisQuote;
  history: ChartCandleRow[];
  analysis: AnalysisSummaryData;
  sector: AnalysisSectorSnapshot | null;
  dataFederation?: AnalysisDataFederation;
  announcements: AnalysisAnnouncement[];
  actualProvider: string;
  warning?: string;
  updatedAt: string;
};
