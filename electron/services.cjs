// ── 提取到 electron/services/runtime.cjs（P0-2b 拆分）；此处回接保持原契约 ──
const _runtime = require("./services/runtime.cjs");
// ── 提取到 electron/services/sectors.cjs（P0-2b 拆分）；此处回接保持原契约 ──
const _sectors = require("./services/sectors.cjs");
const {
  SECTOR_PROVIDER_PRIORITY
} = _sectors;
function returnFor(...args) { return _sectors.returnFor(...args); }
function withSingleFlightCache(...args) { return _sectors.withSingleFlightCache(...args); }
function wholeMarketSnapshot(...args) { return _sectors.wholeMarketSnapshot(...args); }
function searchSectors(...args) { return _sectors.searchSectors(...args); }
function extractThsConceptRows(...args) { return _sectors.extractThsConceptRows(...args); }
function buildFreeConceptGroups(...args) { return _sectors.buildFreeConceptGroups(...args); }
function getConceptChain(...args) { return _sectors.getConceptChain(...args); }
function buildSectorBreadthDiagnostics(...args) { return _sectors.buildSectorBreadthDiagnostics(...args); }
function parseSinaSectorCatalog(...args) { return _sectors.parseSinaSectorCatalog(...args); }
function matchSinaSector(...args) { return _sectors.matchSinaSector(...args); }
function normalizeSinaSectorMembers(...args) { return _sectors.normalizeSinaSectorMembers(...args); }
function extractThsSectorMembers(...args) { return _sectors.extractThsSectorMembers(...args); }
function buildSectorStrengthFromData(...args) { return _sectors.buildSectorStrengthFromData(...args); }
function sectorStrength(...args) { return _sectors.sectorStrength(...args); }
function markMemberLimitUps(...args) { return _sectors.markMemberLimitUps(...args); }
function analyzeSector(...args) { return _sectors.analyzeSector(...args); }
function getLimitUpSectorBoard(...args) { return _sectors.getLimitUpSectorBoard(...args); }
function getSectorLimitUpCount(...args) { return _sectors.getSectorLimitUpCount(...args); }
function getSectorStrengthBoard(...args) { return _sectors.getSectorStrengthBoard(...args); }

const {
  workerRunner,
  serviceRuntime,
  chartRuntime,
  sectorExplorer
} = _runtime;
function serviceSignal(...args) { return _runtime.serviceSignal(...args); }
function shutdownServiceResources(...args) { return _runtime.shutdownServiceResources(...args); }
function cancelServiceJob(...args) { return _runtime.cancelServiceJob(...args); }
function getServiceDiagnostics(...args) { return _runtime.getServiceDiagnostics(...args); }
function curlExecutable(...args) { return _runtime.curlExecutable(...args); }
function isConvertibleBondCode(...args) { return _runtime.isConvertibleBondCode(...args); }
function securityExchangeFromCode(...args) { return _runtime.securityExchangeFromCode(...args); }
function toSecurity(...args) { return _runtime.toSecurity(...args); }
function isAStockCode(...args) { return _runtime.isAStockCode(...args); }
function configureFuyao(...args) { return _runtime.configureFuyao(...args); }
function configureStockIndustryStore(...args) { return _runtime.configureStockIndustryStore(...args); }

// 可转债：名单来自同花顺发行名单；行情先走腾讯批量快照，取不到的逐只读同花顺。
// 在市老券名单由主进程注入的本机存储缓存（每 7 天重新核对）。
const { readTencentBatchQuotes } = require("./tencent-batch-quote.cjs");
async function getBatchQuotes(securities) {
  const result = await readTencentBatchQuotes(securities, { signal: serviceSignal() });
  return { quotes: Object.fromEntries(result.quotes), missing: result.missing, source: result.source, fetchedAt: result.fetchedAt };
}
const { createConvertibleSource } = require("./ths-convertible.cjs");
const convertibleBatchQuotes = (bonds, signal) =>
  readTencentBatchQuotes(bonds.map((bond) => ({ code: bond.code, thscode: `${bond.code}.${bond.market === 19 ? "SH" : "SZ"}` })), { signal })
    .then((result) => result.quotes);
let convertibleSource = createConvertibleSource({ readBatch: convertibleBatchQuotes });
function configureConvertibleRosterStore(store) {
  convertibleSource = createConvertibleSource({ store, readBatch: convertibleBatchQuotes });
}
async function getConvertibleBonds(options = {}) {
  return convertibleSource.load({
    forceRefresh: options?.forceRefresh === true,
    signal: serviceSignal(),
    waitForQuotes: options?.waitForQuotes !== false
  });
}
const { createEtfMarket } = require("./etf-market.cjs");
const etfMarket = createEtfMarket({ fetchJson: (url, options, timeoutMs) => _runtime.fetchJson(url, options, timeoutMs) });
async function getEtfMarket(options = {}) {
  return etfMarket.load({ forceRefresh: options?.forceRefresh === true, signal: serviceSignal() });
}
const { priceLimitRate } = require("./price-limit-rules.cjs");
const { workerScriptPath } = require("./worker-runner.cjs");
const { createFailedBoardHistoryService } = require("./failed-board-history.cjs");
// E-01: worker 内层超时必须与所属 job 的操作预算对齐。
// 之前 4 个派发点都用 runner 默认的 120s，而 strategy:scan 的预算是 600s ——
// 内层先到期，全市场扫描跑到第 2 分钟必然报「计算超时」。
const { DEFAULT_OPERATION_TIMEOUTS } = require("./job-lifecycle.cjs");
const {
  getNewsFeed,
  resetNewsCache
} = require("./news-service.cjs");
// ── 提取到 electron/services/backtest.cjs（P0-2b 拆分）；此处回接保持原契约 ──
const _backtest = require("./services/backtest.cjs");
const {
  marketSourceHealth,
  trendThsLane
} = _backtest;
function strategyDefinitions(...args) { return _backtest.strategyDefinitions(...args); }
function eastPriceFromRaw(...args) { return _backtest.eastPriceFromRaw(...args); }
function searchableAssetType(...args) { return _backtest.searchableAssetType(...args); }
function normalizeSearchSecurity(...args) { return _backtest.normalizeSearchSecurity(...args); }
function assetTypeFromExactCode(...args) { return _backtest.assetTypeFromExactCode(...args); }
function isRiskStockName(...args) { return _backtest.isRiskStockName(...args); }
function searchSecurities(...args) { return _backtest.searchSecurities(...args); }
function resolveBacktestSecurity(...args) { return _backtest.resolveBacktestSecurity(...args); }
function normalizeTencentQuote(...args) { return _backtest.normalizeTencentQuote(...args); }
function fuyaoQuoteBelongsAfter(...args) { return _backtest.fuyaoQuoteBelongsAfter(...args); }
function sinaKline(...args) { return _backtest.sinaKline(...args); }
function historyEndsRecently(...args) { return _backtest.historyEndsRecently(...args); }
function validateHistoryRows(...args) { return _backtest.validateHistoryRows(...args); }
function extractThsTable(...args) { return _backtest.extractThsTable(...args); }
function normalizeThsHistoryTable(...args) { return _backtest.normalizeThsHistoryTable(...args); }
function average(...args) { return _backtest.average(...args); }
function buildBacktestExecutionReadinessFromMetrics(...args) { return _backtest.buildBacktestExecutionReadinessFromMetrics(...args); }
function displayDate(...args) { return _backtest.displayDate(...args); }
function todayInShanghai(...args) { return _backtest.todayInShanghai(...args); }
function buildHistoricalStrategyStatsInWorker(...args) { return _backtest.buildHistoricalStrategyStatsInWorker(...args); }
function buildSingleStockReplaysInWorker(...args) { return _backtest.buildSingleStockReplaysInWorker(...args); }
function buildSequentialSamplePath(...args) { return _backtest.buildSequentialSamplePath(...args); }
function loadBacktestHistory(...args) { return _backtest.loadBacktestHistory(...args); }
function buildPortfolioBacktestInWorker(...args) { return _backtest.buildPortfolioBacktestInWorker(...args); }
function sanitizeBacktestSettingOverrides(...args) { return _backtest.sanitizeBacktestSettingOverrides(...args); }
function mergeBacktestSettings(...args) { return _backtest.mergeBacktestSettings(...args); }
function safeBacktestStrategyProfile(...args) { return _backtest.safeBacktestStrategyProfile(...args); }
function incompleteBacktestBarAllowance(...args) { return _backtest.incompleteBacktestBarAllowance(...args); }
function runPortfolioBacktest(...args) { return _backtest.runPortfolioBacktest(...args); }
function normalizeSingleBacktestDate(...args) { return _backtest.normalizeSingleBacktestDate(...args); }
function singleStockBacktestLookbackBars(...args) { return _backtest.singleStockBacktestLookbackBars(...args); }
function buildSingleStockTradeLedger(...args) { return _backtest.buildSingleStockTradeLedger(...args); }
function runBacktest(...args) { return _backtest.runBacktest(...args); }

/** 「我的策略」可引用的内置策略：在用的加上已下线的（下线前保存的自定义策略继续可用）。 */
function getStrategyPatternIds() {
  return new Set(strategyDefinitions().map(definition => String(definition.id)));
}
const { createTrendExecutionChecker } = require("./trend-execution-check.cjs");

try {
  require("node:dns").setDefaultResultOrder("ipv4first");
} catch {
  // Some Electron runtimes do not expose this option; requests still have fallback handling.
}
function cancelServiceOwner(owner) { return serviceRuntime.cancelOwner(owner) + chartRuntime.cancelOwner(owner); }
// ── 提取到 electron/services/limit-pool.cjs（P0-2b 拆分）；此处回接保持原契约 ──
const _limit_pool = require("./services/limit-pool.cjs");
function recentTradingDates(...args) { return _limit_pool.recentTradingDates(...args); }
function selectLimitUpTradingDates(...args) { return _limit_pool.selectLimitUpTradingDates(...args); }
function normalizeThsLimitUpItem(...args) { return _limit_pool.normalizeThsLimitUpItem(...args); }
function mergeThsAndEastmoneyLimitPool(...args) { return _limit_pool.mergeThsAndEastmoneyLimitPool(...args); }
function thsTopicPoolForDate(...args) { return _limit_pool.thsTopicPoolForDate(...args); }
function topicPoolForDate(...args) { return _limit_pool.topicPoolForDate(...args); }
function recentLimitUpPools(...args) { return _limit_pool.recentLimitUpPools(...args); }
function currentLadderPools(...args) { return _limit_pool.currentLadderPools(...args); }
function conceptRootName(...args) { return _limit_pool.conceptRootName(...args); }
function discoverLimitUps(...args) { return _limit_pool.discoverLimitUps(...args); }
function discoverRecentLimitUps(...args) { return _limit_pool.discoverRecentLimitUps(...args); }
// ── 提取到 electron/services/strategy-scan.cjs（P0-2b 拆分）；此处回接保持原契约 ──
const _strategy_scan = require("./services/strategy-scan.cjs");
const {
  dailyBarStore
} = _strategy_scan;
function strategySignalOptions(...args) { return _strategy_scan.strategySignalOptions(...args); }
function buildStrategySignalReportInWorker(...args) { return _strategy_scan.buildStrategySignalReportInWorker(...args); }
function dailyBarAsOf(...args) { return _strategy_scan.dailyBarAsOf(...args); }
function configureDailyBarStore(...args) { return _strategy_scan.configureDailyBarStore(...args); }
function scanStrategySignals(...args) { return _strategy_scan.scanStrategySignals(...args); }
function strategyLeaderboard(...args) { return _strategy_scan.strategyLeaderboard(...args); }
function getStrategyLeaderboardProgress(...args) { return _strategy_scan.getStrategyLeaderboardProgress(...args); }
// ── 提取到 electron/services/fuyao-review.cjs（P0-2b 拆分）；此处回接保持原契约 ──
const _fuyao_review = require("./services/fuyao-review.cjs");
const {
  isPreOpenEmptyPool,
  fuyaoLastGood
} = _fuyao_review;
function getFuyaoReviewData(...args) { return _fuyao_review.getFuyaoReviewData(...args); }
// ── 提取到 electron/services/quotes-and-charts.cjs（P0-2b 拆分）；此处回接保持原契约 ──
const _quotes_and_charts = require("./services/quotes-and-charts.cjs");
function getMarketSourceHealth(...args) { return _quotes_and_charts.getMarketSourceHealth(...args); }
function aggregateHistoryRows(...args) { return _quotes_and_charts.aggregateHistoryRows(...args); }
function resolveStockIndustries(...args) { return _quotes_and_charts.resolveStockIndustries(...args); }
function marketEmotionSnapshot(...args) { return _quotes_and_charts.marketEmotionSnapshot(...args); }
function stockAnnouncements(...args) { return _quotes_and_charts.stockAnnouncements(...args); }
function getQuoteSnapshot(...args) { return _quotes_and_charts.getQuoteSnapshot(...args); }
function getDataFederation(...args) { return _quotes_and_charts.getDataFederation(...args); }
function getChart(...args) { return _quotes_and_charts.getChart(...args); }
function getReviewIndexChart(...args) { return _quotes_and_charts.getReviewIndexChart(...args); }
function testProvider(...args) { return _quotes_and_charts.testProvider(...args); }


const { getPreviousLimitUpFailedBoardSnapshot } = createFailedBoardHistoryService({
  displayDate,
  todayInShanghai,
  isAStockCode,
  isRiskStockName,
  recentLimitUpPools,
  recentTradingDates,
  selectLimitUpTradingDates,
  topicPoolForDate,
  resolveIndustries: resolveStockIndustries
});

function evaluateTrendResearch(input = {}, runtime = {}) {
  const { validateTrendResearchRequest } = require("./trend-research-request.cjs");
  const request = validateTrendResearchRequest(input);
  const identity = require("node:crypto").createHash("sha256").update(JSON.stringify(request)).digest("hex");
  return serviceRuntime.run("scan", `trend-research:${identity}`, runtime, () => serviceRuntime.track(() => workerRunner.run(workerScriptPath(__dirname, "trend-research-worker.cjs"), request, {
    signal: serviceSignal(), timeoutMs: DEFAULT_OPERATION_TIMEOUTS.scan, timeoutMessage: "研究计算达到扫描任务时限，已停止；请缩小证券或日期范围"
  })));
}

function checkTrendExecution(input = {}, settings = {}, runtime = {}) {
  const identity = JSON.stringify([input?.security?.code, input?.signalDate]);
  return serviceRuntime.run("single", `trend-execution:${identity}`, runtime, async () => {
    const check = createTrendExecutionChecker({ fetchQuote: security => getQuoteSnapshot(security, settings) });
    const result = await check(input);
    serviceRuntime.checkpoint();
    return result;
  });
}
// ── 提取到 electron/services/strategy-validation.cjs（P0-2b 拆分）；此处回接保持原契约 ──
const _strategy_validation = require("./services/strategy-validation.cjs");
function selectIndependentValidationSample(...args) { return _strategy_validation.selectIndependentValidationSample(...args); }
function broadAStockValidationUniverse(...args) { return _strategy_validation.broadAStockValidationUniverse(...args); }
function buildStrategySampleDiversity(...args) { return _strategy_validation.buildStrategySampleDiversity(...args); }
function strategyValidationAliases(...args) { return _strategy_validation.strategyValidationAliases(...args); }
function enrichStrategySignalReport(...args) { return _strategy_validation.enrichStrategySignalReport(...args); }
function buildStrategyDataQuality(...args) { return _strategy_validation.buildStrategyDataQuality(...args); }
function strategyHitsForStock(...args) { return _strategy_validation.strategyHitsForStock(...args); }
function getStrategyDefinitions(...args) { return _strategy_validation.getStrategyDefinitions(...args); }
// ── 提取到 electron/services/security-analysis.cjs（P0-2b 拆分）；此处回接保持原契约 ──
const _security_analysis = require("./services/security-analysis.cjs");
function buildTradeExecutionReadiness(...args) { return _security_analysis.buildTradeExecutionReadiness(...args); }
function edgeGateFromStats(...args) { return _security_analysis.edgeGateFromStats(...args); }
function analyzeHistory(...args) { return _security_analysis.analyzeHistory(...args); }
function strategyDefinitionsFor(...args) { return _security_analysis.strategyDefinitionsFor(...args); }
function analyzeSecurity(...args) { return _security_analysis.analyzeSecurity(...args); }



module.exports = {
  fuyaoQuoteBelongsAfter,
  configureFuyao,
  getFuyaoReviewData,
  __fuyaoReviewTest: { isPreOpenEmptyPool, fuyaoLastGood },
  trendThsLane,
  cancelServiceJob, cancelServiceOwner, getServiceDiagnostics, buildHistoricalStrategyStatsInWorker,
  searchSecurities,
  analyzeSecurity,
  strategyHitsForStock,
  getQuoteSnapshot,
  getMarketSourceHealth,
  getConvertibleBonds,
  getEtfMarket,
  getBatchQuotes,
  configureConvertibleRosterStore,
  configureStockIndustryStore,
  configureDailyBarStore,
  dailyBarStore,
  dailyBarAsOf,
  resetMarketSourceHealth: () => marketSourceHealth.reset(),
  checkTrendExecution,
  evaluateTrendResearch,
  getDataFederation,
  getChart,
  resolveStockIndustries,
  stockAnnouncements,
  getReviewIndexChart,
  discoverLimitUps,
  discoverRecentLimitUps,
  scanStrategySignals,
  strategyLeaderboard,
  getStrategyLeaderboardProgress,
  getLimitUpSectorBoard,
  getSectorStrengthBoard,
  getSectorLimitUpCount,
  searchSectors,
  getConceptChain,
  analyzeSector,
  sectorStrength,
  getSectorCatalog: sectorExplorer.getSectorCatalog,
  getSectorQuotes: sectorExplorer.getSectorQuotes,
  getSectorDetail: sectorExplorer.getSectorDetail,
  getSectorClassifications: sectorExplorer.getSectorClassifications,
  cancelSectorRequest: sectorExplorer.cancelSectorRequest,
  currentLadderPools,
  getPreviousLimitUpFailedBoardSnapshot,
  getNewsFeed,
  resetNewsCache,
  testProvider,
  analyzeHistory,
  // E-06：两个指标原语（空样本 / 样本不足的三态口径）直接暴露给测试锁定语义。
  average,
  returnFor,
  buildTradeExecutionReadiness,
  buildBacktestExecutionReadinessFromMetrics,
  strategyDefinitionsFor,
  marketEmotionSnapshot,
  wholeMarketSnapshot,
  withSingleFlightCache,
  selectLimitUpTradingDates,
  topicPoolForDate,
  conceptRootName,
  extractThsConceptRows,
  extractThsSectorMembers,
  parseSinaSectorCatalog,
  matchSinaSector,
  normalizeSinaSectorMembers,
  buildSectorStrengthFromData,
  SECTOR_PROVIDER_PRIORITY,
  buildFreeConceptGroups,
  buildSectorBreadthDiagnostics,
  priceLimitRate,
  incompleteBacktestBarAllowance,
  isRiskStockName,
  eastPriceFromRaw,
  normalizeTencentQuote,
  isConvertibleBondCode,
  assetTypeFromExactCode,
  searchableAssetType,
  normalizeSearchSecurity,
  resolveBacktestSecurity,
  toSecurity,
  securityExchangeFromCode,
  sanitizeBacktestSettingOverrides,
  mergeBacktestSettings,
  safeBacktestStrategyProfile,
  strategyValidationAliases,
  enrichStrategySignalReport,
  strategySignalOptions,
  buildStrategySignalReportInWorker,
  buildSingleStockReplaysInWorker,
  shutdownServiceResources,
  buildStrategyDataQuality,
  buildStrategySampleDiversity,
  selectIndependentValidationSample,
  broadAStockValidationUniverse,
  edgeGateFromStats,
  sinaKline,
  historyEndsRecently,
  validateHistoryRows,
  aggregateHistoryRows,
  normalizeThsLimitUpItem,
  mergeThsAndEastmoneyLimitPool,
  extractThsTable,
  normalizeThsHistoryTable,
  thsTopicPoolForDate,
  getStrategyDefinitions,
  getStrategyPatternIds,
  buildSequentialSamplePath,
  buildSingleStockTradeLedger,
  singleStockBacktestLookbackBars,
  normalizeSingleBacktestDate,
  loadBacktestHistory,
  buildPortfolioBacktestInWorker,
  curlExecutable,
  runPortfolioBacktest,
  runBacktest,
  markMemberLimitUps
};
