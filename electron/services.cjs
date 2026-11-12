const THS_BASE = "https://quantapi.51ifind.com/api/v1";
const EAST_QUOTE = "https://push2.eastmoney.com/api/qt";
const EAST_DELAY_QUOTE = "https://push2delay.eastmoney.com/api/qt";
const EAST_HISTORY = "https://push2his.eastmoney.com/api/qt";
const SEARCH_API = "https://searchapi.eastmoney.com/api/suggest/get";
const { execFile } = require("node:child_process");
const { createServiceRuntime, semanticKey } = require("./service-runtime.cjs");
const { createTradingCalendar, shanghaiClock } = require("./trend-trading-calendar.cjs");
// 同花顺官方免费行情网关（d.10jqka.com.cn）：实时快照 / 日K线 / 板块成分
const thsOfficial = require("./ths-quote.cjs");
// 同花顺免费网关的个股报价与日K线（不需要 QuantAPI Token），以及三路行情的健康度/熔断。
const thsFreeMarket = require("./ths-free-market.cjs");
const { createFuyaoClient, fuyaoThscode, isIndexSecurity } = require("./fuyao-client.cjs");
let fuyaoApiKeyProvider = () => "";
// 同花顺扶摇官方接口：配置了 API Key 才启用；失败时自动回到同花顺免费网页接口。
const fuyao = createFuyaoClient({ getApiKey: () => fuyaoApiKeyProvider() });
const { createMarketSourceHealth } = require("./market-source-health.cjs");
const marketSourceHealth = createMarketSourceHealth();
const { BEIJING_BOARD, isBeijingSector, createBeijingSectorSource } = require("./ths-beijing.cjs");
const beijingSectorSource = createBeijingSectorSource();
// 可转债：同花顺新券名单 + 逐券快照；在市老券名单由主进程注入的本机存储缓存（每 7 天重新核对）。
const { createConvertibleSource } = require("./ths-convertible.cjs");
let convertibleSource = createConvertibleSource();
function configureConvertibleRosterStore(store) {
  convertibleSource = createConvertibleSource({ store });
}
async function getConvertibleBonds(options = {}) {
  return convertibleSource.load({
    forceRefresh: options?.forceRefresh === true,
    signal: serviceSignal(),
    waitForQuotes: options?.waitForQuotes !== false
  });
}
const { BoundedCache, credentialFingerprint } = require("./bounded-cache.cjs");
const {
  isBseAshareCode,
  isLimitUpBar,
  isLimitUpPrice,
  priceLimitRate,
  upperLimitPrice
} = require("./price-limit-rules.cjs");
const { anchoredVwap } = require("./market-history-rules.cjs");
const { createWorkerRunner, workerScriptPath } = require("./worker-runner.cjs");
const { createFailedBoardHistoryService } = require("./failed-board-history.cjs");
const { fetchWithPolicy, fetchJsonWithPolicy, fetchArrayBufferWithPolicy, runWithTransportSlot } = require("./http-client.cjs");
const { DEFAULT_COSTS, roundTripBps } = require("./backtest-costs.cjs");
const serviceController = new AbortController();
// E-01: worker 内层超时必须与所属 job 的操作预算对齐。
// 之前 4 个派发点都用 runner 默认的 120s，而 strategy:scan 的预算是 600s ——
// 内层先到期，全市场扫描跑到第 2 分钟必然报「计算超时」。
const { DEFAULT_OPERATION_TIMEOUTS } = require("./job-lifecycle.cjs");
const workerRunner = createWorkerRunner();
const serviceRuntime = createServiceRuntime({ controller: serviceController, now: () => Date.now() });
const chartRuntime = createServiceRuntime({ controller: serviceController, jobOptions: { maxActive: 3, maxQueued: 64 }, now: () => Date.now() });
const sectorFundFlows = require("./sector-fund-flow.cjs").createSectorFundFlowSource({
  fetchJson: (...args) => fetchJson(...args), runtime: serviceRuntime, identify: member => toSecurity(member)
});
const serviceRequests = new Set();
const {
  thsProviderError,
  withThsAccessToken
} = require("./ths-token-manager.cjs");
const {
  decorateLimitPoolItem,
  scoreFirstBoardQuality,
  computePatternStrategies,
  buildSectorLadder
} = require("./strategy-intelligence.cjs");
const {
  getNewsFeed,
  resetNewsCache,
  shutdownNewsService,
  classifyEvent
} = require("./news-service.cjs");
const {
  tencentQuote,
  collectAuxiliarySources,
  shutdownDataFederation,
  buildQuoteConsensus
} = require("./data-federation.cjs");
// 策略引擎约 150KB，计算已在 worker 里做；主进程只在用到定义表时才加载（启动更快）。
let strategyDefinitionsCache = null;
// 完整策略库（含已下线、标 retired）：回测中心和策略目录用；策略选股本身只跑在用策略（由引擎决定）。
function strategyDefinitions() {
  strategyDefinitionsCache ||= require("./strategy-signal-engine.cjs").ALL_STRATEGY_DEFINITIONS;
  return strategyDefinitionsCache;
}
/** 「我的策略」可引用的内置策略：在用的加上已下线的（下线前保存的自定义策略继续可用）。 */
function getStrategyPatternIds() {
  return new Set(strategyDefinitions().map(definition => String(definition.id)));
}

const marketEmotionCache = { value: null, expiresAt: 0, promise: null };
const marketSnapshotCache = { value: null, expiresAt: 0, promise: null };
const ladderPoolsCaches = new BoundedCache({ maxBytes: 2 * 1024 * 1024, maxEntries: 16, staleTtlMs: 0, now: () => Date.now() });
const historyCache = new BoundedCache({ maxBytes: 32 * 1024 * 1024, maxEntries: 128, staleTtlMs: 0, now: () => Date.now() });
const chartCache = new BoundedCache({ maxBytes: 16 * 1024 * 1024, maxEntries: 96, staleTtlMs: 0, now: () => Date.now() });
const federationCache = new BoundedCache({ maxBytes: 2 * 1024 * 1024, maxEntries: 256, staleTtlMs: 0, now: () => Date.now() });
const topicPoolCache = new BoundedCache({ maxBytes: 8 * 1024 * 1024, maxEntries: 128, staleTtlMs: 0, now: () => Date.now() });
const conceptChainCache = new BoundedCache({ maxBytes: 4 * 1024 * 1024, maxEntries: 64, staleTtlMs: 0, now: () => Date.now() });
const sectorLookupCache = new BoundedCache({ maxBytes: 512 * 1024, maxEntries: 256, staleTtlMs: 1800000, now: () => Date.now() });
const sectorStrengthCache = new BoundedCache({ maxBytes: 4 * 1024 * 1024, maxEntries: 128, staleTtlMs: 0, now: () => Date.now() });
// 板块榜单缓存：榜单是「板块强度」页的主体视图，必须有保底 ——
// 同花顺/东财同时不可用时，返回最近一次的有效榜单并明确标注，而不是给一张空表。
const sectorBoardCache = new BoundedCache({ maxBytes: 4 * 1024 * 1024, maxEntries: 8, staleTtlMs: 0, now: () => Date.now() });
// 同花顺板块浏览：行业行情取数据中心资金流（含涨幅、净流入、领涨股），指数走势取免费网关日线。
const sectorExplorer = require("./sector-explorer.cjs").createSectorExplorer({
  loadIndustryQuotes: async ({ signal } = {}) => (await thsOfficial.fetchThsFundFlow(fetchWithPolicy, "industry", { maxPages: 3, timeoutMs: 7000, signal }))
    .map((row) => ({ ...row, netInflow: row.netInflow === null ? null : row.netInflow * 1e8 })),
  loadIndexHistory: (code, { signal } = {}) => thsOfficial.fetchThsDailyHistory(fetchWithPolicy, code, { market: "48", limit: 40, signal }),
  // 有扶摇 Key 时补齐未登录 100 只上限之外的成分；行情用扶摇批量快照。
  loadFullMembers: async (thscode, { signal } = {}) => {
    if (!fuyao.configured()) return null;
    const members = await fuyao.constituents(thscode, { signal });
    if (!members.length) return null;
    const quotes = await fuyao.snapshot(members.map((m) => ({ code: m.code, thscode: m.thscode })), { signal });
    return members.map((m) => {
      const quote = quotes.get(m.thscode);
      return { code: m.code, name: m.name, latest: quote?.latest ?? null, changePercent: quote?.changePct ?? null, amount: quote?.amount ?? null };
    });
  }
});
const sectorProviderHealth = new Map();
const sinaSectorCatalogCache = { value: null, expiresAt: 0, promise: null };
const securitySearchCache = new BoundedCache({ maxBytes: 512 * 1024, maxEntries: 256, staleTtlMs: 0, now: () => Date.now() });
const strategySignalCache = new BoundedCache({ maxEntries: 12, maxBytes: 8 * 1024 * 1024, now: () => Date.now() });
// Only active loaders own generations; finally removes them without retaining query keys.
const strategySignalLoads = new Map();
const strategyValidationUniverseCache = { value: null, expiresAt: 0, promise: null };
const STRATEGY_SIGNAL_HISTORY_BARS = 720;
const { createTrendExecutionChecker } = require("./trend-execution-check.cjs");
const { createStrategySelectionService, SELECTION_HISTORY_BARS, MARKET_SESSIONS: SELECTION_MARKET_SESSIONS } = require("./strategy-selection-service.cjs");
const { evaluateAnalysisPresetRequirements } = require("./analysis-selection-policy.cjs");
const STRATEGY_SIGNAL_MAX_UNIVERSE = 300;
const STRATEGY_SIGNAL_VALIDATION_SAMPLE = 120;
const PORTFOLIO_BACKTEST_MIN_BARS = 120;
const PORTFOLIO_BACKTEST_MAX_BARS = 120;
const PORTFOLIO_BACKTEST_WARMUP_BARS = 80;
const SECTOR_PROVIDER_PRIORITY = Object.freeze([
  "同花顺 QuantAPI",
  "东方财富实时",
  "东方财富延迟节点",
  "新浪行业实时"
]);

try {
  require("node:dns").setDefaultResultOrder("ipv4first");
} catch {
  // Some Electron runtimes do not expose this option; requests still have fallback handling.
}

function serviceSignal(signal) {
  return serviceRuntime.signal(signal);
}

function shutdownServiceResources() {
  serviceController.abort(new DOMException("应用正在退出，任务已取消", "AbortError"));
  return Promise.allSettled([
    ...serviceRequests,
    serviceRuntime.shutdown(serviceController.signal.reason),
    chartRuntime.shutdown(serviceController.signal.reason),
    shutdownNewsService(),
    stockIndustryIndex.shutdown(serviceController.signal.reason),
    sectorLimitCounts.shutdown(serviceController.signal.reason),
    shutdownDataFederation(),
    workerRunner.shutdown(serviceController.signal.reason),
    sectorExplorer.dispose(),
    thsOfficial.drainThsQuoteRequests()
  ]).then(() => undefined);
}

function trackServiceRequest(promise) {
  serviceRequests.add(promise);
  promise.then(() => serviceRequests.delete(promise), () => serviceRequests.delete(promise));
  return promise;
}

function cancelServiceJob(request) { const chartCancelled = chartRuntime.cancel(request); return serviceRuntime.cancel(request) || chartCancelled; }
function cancelServiceOwner(owner) { return serviceRuntime.cancelOwner(owner) + chartRuntime.cancelOwner(owner); }
function getServiceDiagnostics() {
  return { ...serviceRuntime.getDiagnostics(), charts: chartRuntime.getDiagnostics(), sectorFundFlows: sectorFundFlows.getDiagnostics(), caches: Object.fromEntries(Object.entries({ historyCache, chartCache, federationCache, topicPoolCache, conceptChainCache, sectorLookupCache, sectorStrengthCache, securitySearchCache, ladderPoolsCaches, strategySignalCache }).map(([name, cache]) => [name, cache.getDiagnostics()])) };
}

function fetchJsonWithCurl(url, timeoutMs, referer = "", signal) {
  return Promise.resolve().then(() => serviceRuntime.track(() => {
    const producerSignal = serviceSignal(signal);
    return trackServiceRequest(runWithTransportSlot(() => executeJsonWithCurl(url, timeoutMs, referer, producerSignal), {
      url, signal: producerSignal, minimumGapMs: 180
    }));
  }));
}

function executeJsonWithCurl(url, timeoutMs, referer, signal) {
  return new Promise((settleResolve, settleReject) => {
    let child, initialized = false, physicallyClosed = false, outcome;
    const finish = () => {
      if (!initialized || !outcome || (child?.once && !physicallyClosed)) return;
      if (Object.prototype.hasOwnProperty.call(outcome, "error")) settleReject(outcome.error);
      else settleResolve(outcome.value);
    };
    const resolve = value => { outcome = { value }; finish(); };
    const reject = error => { outcome = { error }; finish(); };
    signal.throwIfAborted();
    const timeoutSeconds = Math.max(3, Math.ceil(Number(timeoutMs || 12000) / 1000));
    child = execFile(
      curlExecutable(),
      [
        "--http1.1",
        "--silent",
        "--show-error",
        "--fail-with-body",
        "--compressed",
        "--connect-timeout",
        String(timeoutSeconds),
        "--max-time",
        String(timeoutSeconds),
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
        ...(referer
          ? ["--header", `Referer: ${referer}`]
          : []),
        String(url)
      ],
      {
        windowsHide: true,
        signal,
        timeout: timeoutSeconds * 1000 + 2000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (error) {
          const detail = String(stderr || error.message || "").trim();
          reject(new Error(`行情备用通道失败：${detail || "curl error"}`));
          return;
        }
        try {
          const data = JSON.parse(String(stdout || ""));
          if (data?.rc && data.rc !== 0) {
            reject(new Error(data.msg || `数据源错误 ${data.rc}`));
            return;
          }
          resolve(data);
        } catch (parseError) {
          reject(
            new Error(
              `东方财富备用通道返回非JSON：${
                parseError instanceof Error ? parseError.message : String(parseError)
              }`
            )
          );
        }
      }
    );
    // execFile's abort callback can precede physical exit. Keep admission until
    // close confirms the process and its stdio handles have actually drained.
    child?.once?.("close", () => { physicallyClosed = true; finish(); });
    initialized = true;
    finish();
  });
}

function curlExecutable(platform = process.platform) {
  return platform === "win32" ? "curl.exe" : "curl";
}

function fetchJson(url, options = {}, timeoutMs = 12000) {
  return Promise.resolve().then(() => serviceRuntime.track(() => trackServiceRequest(performFetchJson(url, options, timeoutMs))));
}

async function performFetchJson(url, options = {}, timeoutMs = 12000) {
  const requestUrl = String(url);
  const isEastmoney = /\.eastmoney\.com\//i.test(requestUrl);
  const signal = serviceSignal(options.signal);
  signal.throwIfAborted();
  const hostname = isEastmoney ? new URL(requestUrl).hostname : "";
  try {
    const data = await fetchJsonWithPolicy(url, { ...options, signal }, {
      timeoutMs,
      retries: 1,
      minimumGapMs: isEastmoney ? (hostname.startsWith("push2") ? 120 : 180) : 0,
      headers: {
        "User-Agent": isEastmoney
          ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36"
          : "AStockMonitor/0.8",
        ...(isEastmoney ? { Referer: "https://quote.eastmoney.com/" } : {})
      }
    });
    signal.throwIfAborted();
    if (data?.rc && data.rc !== 0) throw new Error(data.msg || `数据源错误 ${data.rc}`);
    return data;
  } catch (error) {
    signal.throwIfAborted();
    // Queue pressure is local capacity, not a provider outage. Falling back
    // would create another request for a workload we have already rejected.
    if (["QUEUE_FULL", "QUEUE_TIMEOUT"].includes(error?.code)) throw error;
    // E-02：curl 逃生通道是 curl 子进程，绕过了 fetch 层的一切策略（响应体上限、
    // 重试、重定向语义、错误分类），也让所有 fetch 替身失效。测试与排障需要一条
    // "只用 fetch" 的确定性路径：置 ASTOCK_DISABLE_CURL=1 时直接暴露原始错误。
    // 默认行为保持不变（未设置该变量时仍启用 curl 兜底）。
    if (String(process.env.ASTOCK_DISABLE_CURL || "") === "1") throw error;
    if (!isEastmoney) throw error;
    try {
      return await fetchJsonWithCurl(requestUrl, timeoutMs, "https://quote.eastmoney.com/", signal);
    } catch (curlError) {
      signal.throwIfAborted();
      if (curlError && typeof curlError === "object" && !curlError.cause) curlError.cause = error;
      throw curlError;
    }
  }
}

function fetchDecodedText(url, options = {}, timeoutMs = 12000, encoding = "utf-8") {
  return Promise.resolve().then(() => serviceRuntime.track(() => trackServiceRequest(performFetchDecodedText(url, options, timeoutMs, encoding))));
}

async function performFetchDecodedText(url, options = {}, timeoutMs = 12000, encoding = "utf-8") {
  const signal = serviceSignal(options.signal);
  signal.throwIfAborted();
  // 调用方传来的 headers 必须能覆盖默认值 —— 之前这里写死了一份新浪默认头，
  // 导致同花顺板块页收到的是新浪的 Referer，被反爬降级（分页只返回首页）。
  const mergedHeaders = {
    Accept: "application/json, text/javascript, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
    Referer: "https://vip.stock.finance.sina.com.cn/mkt/",
    ...(options.headers && typeof options.headers === "object" ? options.headers : {})
  };
  const buffer = await fetchArrayBufferWithPolicy(url, { ...options, signal }, {
    timeoutMs, retries: 1, minimumGapMs: 450,
    headers: mergedHeaders
  });
  signal.throwIfAborted();
  return new TextDecoder(encoding).decode(buffer);
}

function marketFromCode(code) {
  if (/^(6|68)/.test(code)) return 1;
  return 0;
}

function eastPriceFromRaw(value, precision = 2) {
  const numeric = Number(value);
  const digits = Number(precision);
  if (value === null || value === undefined || value === "" || !Number.isFinite(numeric)) return null;
  const safePrecision =
    Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 2;
  return numeric / (10 ** safePrecision);
}

function isConvertibleBondCode(code = "") {
  return /^(110|111|113|118|123|125|126|127|128)\d{3}$/.test(String(code));
}

function securityExchangeFromCode(code = "", assetType = "stock") {
  const normalizedCode = String(code);
  if (assetType === "stock") {
    if (!isAStockCode(normalizedCode)) return "";
    if (/^(?:60[0135]|68[89])\d{3}$/.test(normalizedCode)) return "SH";
    if (/^(?:00[0-3]|30[012])\d{3}$/.test(normalizedCode)) return "SZ";
    if (isBseAshareCode(normalizedCode)) return "BJ";
    return "";
  }
  if (assetType === "etf") {
    if (/^5\d{5}$/.test(normalizedCode)) return "SH";
    if (/^159\d{3}$/.test(normalizedCode)) return "SZ";
    return "";
  }
  if (assetType === "convertibleBond" && isConvertibleBondCode(normalizedCode)) {
    return /^(?:110|111|113|118)/.test(normalizedCode) ? "SH" : "SZ";
  }
  return "";
}

function canonicalSecurityIdentifiers(code, assetType = "stock") {
  const exchange = securityExchangeFromCode(code, assetType);
  if (!exchange) {
    throw new Error(`Unsupported or invalid ${assetType} security code: ${code}`);
  }
  return {
    exchange,
    secid: `${exchange === "SH" ? 1 : 0}.${code}`,
    thscode: `${code}.${exchange}`
  };
}

function hasIdentifierValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function matchesCanonicalIdentifier(value, expected, caseInsensitive = false) {
  if (!hasIdentifierValue(value)) return true;
  const actual = String(value);
  return caseInsensitive
    ? actual.toUpperCase() === expected
    : actual === expected;
}

function searchableAssetType(item = {}) {
  const classify = String(item.Classify || "");
  const code = String(item.Code || "");
  const name = String(item.Name || "");
  if (classify === "AStock") return "stock";
  if (classify === "Fund" && /ETF/i.test(name) && /^\d{6}$/.test(code)) return "etf";
  if (
    classify === "Bond" &&
    /^\d{6}$/.test(code) &&
    (isConvertibleBondCode(code) || /转债|可转债/i.test(name))
  ) {
    return "convertibleBond";
  }
  return null;
}

function normalizeSearchSecurity(item = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const assetType = searchableAssetType(item);
  if (!assetType) return null;
  const code = String(item.Code || "");
  let identifiers;
  try {
    identifiers = canonicalSecurityIdentifiers(code, assetType);
  } catch {
    return null;
  }
  const expectedMktNum = identifiers.exchange === "SH" ? "1" : "0";
  if (
    (hasIdentifierValue(item.MktNum) && String(item.MktNum) !== expectedMktNum) ||
    !matchesCanonicalIdentifier(item.QuoteID, identifiers.secid) ||
    !matchesCanonicalIdentifier(item.secid, identifiers.secid) ||
    !matchesCanonicalIdentifier(
      item.thscode ?? item.ThsCode ?? item.THSCODE,
      identifiers.thscode,
      true
    )
  ) {
    return null;
  }
  const assetLabel =
    assetType === "etf" ? "ETF" :
      assetType === "convertibleBond" ? "可转债" :
        item.SecurityTypeName || "A股";
  return {
    code,
    name: String(item.Name || code),
    secid: identifiers.secid,
    thscode: identifiers.thscode,
    marketName: assetLabel,
    assetType,
    defaultVisible: assetType === "stock"
  };
}

function assetTypeFromExactCode(code = "") {
  const normalized = String(code);
  if (/^(5\d{5}|159\d{3})$/.test(normalized)) return "etf";
  if (isConvertibleBondCode(normalized)) return "convertibleBond";
  return null;
}

async function directSearchAsset(code) {
  const assetType = assetTypeFromExactCode(code);
  if (!assetType) return null;
  const shanghai =
    assetType === "etf" ? String(code).startsWith("5") : /^(110|111|113|118)/.test(code);
  const marketName = assetType === "etf" ? "ETF" : "可转债";
  const security = {
    code,
    name: code,
    secid: `${shanghai ? 1 : 0}.${code}`,
    thscode: `${code}.${shanghai ? "SH" : "SZ"}`,
    marketName,
    assetType,
    defaultVisible: false
  };
  const { quote } = await publicQuoteWithFallback(security, 5000);
  if (!quote?.name || String(quote.name) === code) return null;
  return { ...security, name: quote.name };
}

function toSecurity(input) {
  const objectInput = input && typeof input === "object" && !Array.isArray(input)
    ? input
    : null;
  const rawCode = objectInput ? String(objectInput.code ?? "") : String(input ?? "");
  const codeMatch = objectInput
    ? rawCode.match(/^(\d{6})$/)
    : rawCode.match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/i);
  if (!codeMatch) {
    throw new Error("Security code must be exactly 6 digits with an optional SH, SZ or BJ suffix");
  }
  const code = codeMatch[1];
  const assetType = String(objectInput?.assetType || "stock");
  const identifiers = canonicalSecurityIdentifiers(code, assetType);
  const suppliedSuffix = String(codeMatch[2] || "").toUpperCase();
  if (suppliedSuffix && suppliedSuffix !== identifiers.exchange) {
    throw new Error(`Security code ${code} does not belong to ${suppliedSuffix}`);
  }
  if (objectInput) {
    const suppliedIdentifiers = [
      ["secid", objectInput.secid, identifiers.secid, false],
      ["QuoteID", objectInput.QuoteID, identifiers.secid, false],
      ["thscode", objectInput.thscode, identifiers.thscode, true]
    ];
    for (const [label, value, expected, caseInsensitive] of suppliedIdentifiers) {
      if (!matchesCanonicalIdentifier(value, expected, caseInsensitive)) {
        throw new Error(`Invalid ${label} for security ${code}`);
      }
    }
  }
  return {
    code,
    name: objectInput?.name || code,
    secid: identifiers.secid,
    thscode: identifiers.thscode,
    marketName: objectInput?.marketName || "A股",
    assetType,
    industry: objectInput?.industry || "",
    defaultVisible: objectInput?.defaultVisible !== false
  };
}

function isRiskStockName(name = "") {
  const normalized = String(name).replace(/\s+/g, "").toUpperCase();
  return normalized.includes("ST") || normalized.includes("退");
}

async function searchSecurities(query) {
  const text = String(query || "").trim();
  if (!text) return [];
  return serviceRuntime.cached(securitySearchCache, text.toLowerCase(), 5 * 60 * 1000,
    () => loadSecuritySuggestions(text), { shouldCache: rows => rows.length > 0 });
}

/**
 * 同花顺搜索联想（news.10jqka.com.cn 键盘精灵 JSONP）。
 * 响应形如 jsonp([["1||600519 贵州茅台 股票", …], [基金…], ["24||123288 隆新转债 债券"]])：
 * 第 1 组为股票，第 3 组为债券。2026-10-23 实测 ETF 查不到，ETF 由东方财富搜索应急。
 */
async function thsSearchSuggestions(text) {
  const url = `https://news.10jqka.com.cn/public/index_keyboard_${encodeURIComponent(text)}_stock,fund,bond_20_jsonp.html`;
  const bytes = await Promise.resolve().then(() => serviceRuntime.track(() => trackServiceRequest(fetchArrayBufferWithPolicy(url, {
    signal: serviceSignal(), headers: { ...thsOfficial.thsHeaders("https://www.10jqka.com.cn/"), Accept: "*/*" }
  }, { timeoutMs: 3500, retries: 1, minimumGapMs: 80, maxResponseBytes: 256 * 1024 }))));
  const groups = thsOfficial.unwrapJsonp(new TextDecoder("utf-8").decode(bytes));
  if (!Array.isArray(groups)) throw new Error("同花顺搜索响应格式异常");
  const out = [];
  const seen = new Set();
  for (const entry of groups.flat()) {
    const match = String(entry || "").match(/^\d+\|\|(\d{6})\s+(.+?)\s+(股票|债券)$/);
    if (!match || seen.has(match[1])) continue;
    const [, code, name, kind] = match;
    const assetType = kind === "债券" ? (isConvertibleBondCode(code) ? "convertibleBond" : "") : (isAStockCode(code) ? "stock" : "");
    if (!assetType) continue;
    let identifiers;
    try { identifiers = canonicalSecurityIdentifiers(code, assetType); } catch { continue; }
    seen.add(code);
    out.push({ code, name, secid: identifiers.secid, thscode: identifiers.thscode,
      marketName: assetType === "convertibleBond" ? "可转债" : "A股", assetType, defaultVisible: assetType === "stock", source: "ths" });
  }
  return out;
}

async function loadSecuritySuggestions(text) {
  // 同花顺为主；同花顺无结果（如 ETF）或失败时，才用东方财富搜索应急。
  try {
    const thsRows = (await thsSearchSuggestions(text)).filter((item) => item.assetType !== "stock" || !isRiskStockName(item.name));
    if (thsRows.length) {
      return thsRows.sort((left, right) => (right.code === text ? 1 : 0) - (left.code === text ? 1 : 0)).slice(0, 12);
    }
  } catch {
    serviceRuntime.checkpoint();
  }
  const url = `${SEARCH_API}?input=${encodeURIComponent(text)}&count=40&type=14`;
  let rows = [];
  try {
    const json = await fetchJson(url, {}, 3500);
    const suggestions = json?.QuotationCodeTable?.Data;
    rows = Array.isArray(suggestions) ? suggestions : [];
  } catch {
    serviceRuntime.checkpoint();
    rows = [];
  }
  const result = rows
    .map(normalizeSearchSecurity)
    .filter(Boolean)
    .filter((item) => item.assetType !== "stock" || !isRiskStockName(item.name))
    .sort((left, right) => {
      const exactLeft = left.code === text ? 1 : 0;
      const exactRight = right.code === text ? 1 : 0;
      if (exactLeft !== exactRight) return exactRight - exactLeft;
      const order = { stock: 0, etf: 1, convertibleBond: 2 };
      return (order[left.assetType] ?? 9) - (order[right.assetType] ?? 9);
    })
    .slice(0, 12);
  if (!result.length && /^\d{6}$/.test(text)) {
    const direct = await directSearchAsset(text).catch(() => null);
    if (direct) result.push(direct);
  }
  return result;
}

function isAStockCode(code = "") {
  const value = String(code).trim();
  return /^(?:00[0-3]|30[012]|60[0135]|68[89])\d{3}$/.test(value) ||
    isBseAshareCode(value);
}

function securityLookupKey(value = "") {
  return String(value).replace(/\s+/g, "").toUpperCase();
}

async function resolveBacktestSecurity(input, search = searchSecurities) {
  const explicit = input && typeof input === "object" ? input : null;
  const explicitCode = explicit?.code === undefined
    ? ""
    : String(explicit.code);
  if (explicitCode) {
    if (!/^\d{6}$/.test(explicitCode)) {
      throw new Error("Backtest security code must be exactly 6 digits");
    }
    if (explicit.assetType && explicit.assetType !== "stock") {
      throw new Error("回测仅支持A股股票，不支持ETF、可转债或其他证券");
    }
    if (!isAStockCode(explicitCode)) {
      throw new Error(`“${explicitCode}”不是可回测的A股股票代码`);
    }
    return toSecurity({ ...explicit, code: explicitCode, assetType: "stock" });
  }

  const text = String(explicit?.name ?? input ?? "").trim();
  if (!text) {
    throw new Error("请输入股票名称或6位A股代码");
  }
  const directCode = text.match(/^(\d{6})(?:\.(?:SH|SZ|BJ))?$/i)?.[1] || "";
  if (directCode) {
    if (!isAStockCode(directCode)) {
      throw new Error(`“${directCode}”不是可回测的A股股票代码`);
    }
    return toSecurity(directCode);
  }

  const rows = await search(text);
  const uniqueStocks = [
    ...(Array.isArray(rows) ? rows : []).reduce((byCode, item) => {
      const code = String(item?.code || "");
      if (
        item?.assetType === "stock" &&
        isAStockCode(code) &&
        !isRiskStockName(item?.name) &&
        !byCode.has(code)
      ) {
        byCode.set(code, item);
      }
      return byCode;
    }, new Map()).values()
  ];
  const lookupKey = securityLookupKey(text);
  const exactMatches = uniqueStocks.filter(
    (item) => securityLookupKey(item.name) === lookupKey
  );
  const candidates = exactMatches.length ? exactMatches : uniqueStocks;
  if (candidates.length === 1) {
    return toSecurity({ ...candidates[0], assetType: "stock" });
  }
  if (!candidates.length) {
    throw new Error(`未找到“${text}”对应的A股，请输入完整股票名称或6位代码`);
  }
  const choices = candidates
    .slice(0, 6)
    .map((item) => `${item.name}（${item.code}）`)
    .join("、");
  throw new Error(
    `“${text}”对应多只A股：${choices}；请改用完整名称或6位代码`
  );
}

// Preserve quote completeness before legacy numeric defaults erase the
// distinction between a real zero and an absent provider field.
function missingMonitorQuoteFields(values, upstream = []) {
  const prior = new Set(Array.isArray(upstream) ? upstream : []);
  return ["latest", "changePct", "turnover", "amount"].filter((field) => {
    const value = values[field];
    return prior.has(field) ||
      !["number", "string"].includes(typeof value) ||
      (typeof value === "string" && !value.trim()) ||
      !Number.isFinite(Number(value));
  });
}

async function eastQuote(security, timeoutMs = 12000) {
  const fields =
    "f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f59,f60,f86,f116,f117,f127,f168,f169,f170,f171";
  const json = await fetchJson(
    `${EAST_QUOTE}/stock/get?secid=${encodeURIComponent(String(security.secid))}&fields=${fields}`,
    {},
    timeoutMs
  );
  const d = json.data;
  if (!d) throw new Error("未找到股票行情");
  const rawPrecision = Number(d.f59);
  const pricePrecision =
    Number.isInteger(rawPrecision) && rawPrecision >= 0 && rawPrecision <= 6
      ? rawPrecision
      : 2;
  const price = (value) => eastPriceFromRaw(value, pricePrecision);
  const percent = (value) =>
    finiteOrNull(value) === null ? null : Number(value) / 100;
  // E-01：f43 是"最新价"。东方财富在盘前 / 停牌 / 无成交 / 接口降级时会返回 0 或缺字段，
  // 那不是"真实价格为 0"，而是"没有可用报价"。以前这里照样返回 latest=0 且
  // missingFields=[]，下游会把一次数据缺失当成有效行情（健康度还记成功）。
  // 现在改为抛可分类错误，让报价链正常接力。
  // 注意：f168(换手率) / f170(涨跌幅) / f48(成交额) 的 0 是合法值，不在此处拦截。
  const latestPrice = price(d.f43);
  if (latestPrice === null || !(latestPrice > 0)) {
    throw Object.assign(new Error("东方财富无有效最新价（f43 缺失或非正数，不能当作 0 元行情）"), {
      code: "EAST_NO_PRICE",
      provider: "eastmoney"
    });
  }
  return {
    code: d.f57,
    name: d.f58,
    ...(Number.isFinite(Number(d.f86)) && Number(d.f86) > 0 && Number(d.f86) < 8640000000000 ? { quoteAt: new Date(Number(d.f86) * 1000).toISOString() } : {}),
    secid: security.secid,
    thscode: security.thscode,
    assetType: security.assetType || "stock",
    assetLabel: security.marketName || "A股",
    pricePrecision,
    latest: latestPrice,
    high: price(d.f44),
    low: price(d.f45),
    open: price(d.f46),
    volume: finiteOrNull(d.f47),
    volumeUnit: "lots",
    amount: finiteOrNull(d.f48),
    volumeRatio: percent(d.f50),
    limitUp: price(d.f51),
    limitDown: price(d.f52),
    preClose: price(d.f60),
    totalMarketCap: Number(d.f116 || 0),
    floatMarketCap: Number(d.f117 || 0),
    industry: d.f127 || "未分类",
    turnover: percent(d.f168),
    change: price(d.f169),
    changePct: percent(d.f170),
    amplitude: percent(d.f171),
    source: "eastmoney",
    missingFields: missingMonitorQuoteFields({
      latest: d.f43, changePct: d.f170, turnover: d.f168, amount: d.f48
    })
  };
}

// E-03：缺失的数值字段一律输出 null，绝不输出 0。
// 以前这里把 NaN / undefined / "" 全部折成 0，于是"未知的涨停价"变成"涨停价 0 元"、
// "未知的日内位置"退化成固定值，下游再也分不清"真的 0"与"源上没有这个字段"。
const TENCENT_TRACKED_FIELDS = Object.freeze([
  "latest", "high", "low", "open", "preClose", "limitUp", "limitDown",
  "volume", "amount", "change", "changePct", "turnover", "amplitude"
]);

function optionalQuoteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTencentQuote(security, quote = {}) {
  const rawPrecision = Number(quote.pricePrecision);
  const pricePrecision =
    Number.isInteger(rawPrecision) && rawPrecision >= 0 && rawPrecision <= 6
      ? rawPrecision
      : 2;
  const normalized = {
    code: String(quote.securityCode || security.code),
    name: String(quote.securityName || security.name || security.code),
    secid: security.secid,
    thscode: security.thscode,
    assetType: security.assetType || "stock",
    assetLabel: security.marketName || "A股",
    pricePrecision,
    latest: optionalQuoteNumber(quote.latest),
    high: optionalQuoteNumber(quote.high),
    low: optionalQuoteNumber(quote.low),
    open: optionalQuoteNumber(quote.open),
    volume: optionalQuoteNumber(quote.volume),
    amount: optionalQuoteNumber(quote.amount),
    volumeRatio: optionalQuoteNumber(quote.volumeRatio),
    limitUp: optionalQuoteNumber(quote.limitUp),
    limitDown: optionalQuoteNumber(quote.limitDown),
    preClose: optionalQuoteNumber(quote.preClose),
    totalMarketCap: optionalQuoteNumber(quote.totalMarketCap),
    floatMarketCap: optionalQuoteNumber(quote.floatMarketCap),
    industry: String(security.industry || "未分类"),
    turnover: optionalQuoteNumber(quote.turnover),
    change: optionalQuoteNumber(quote.change),
    changePct: optionalQuoteNumber(quote.changePct),
    amplitude: optionalQuoteNumber(quote.amplitude),
    updatedAt: String(quote.updatedAt || ""),
    source: "tencent"
  };
  // 缺失清单覆盖全部价格/量能字段。上游（data-federation）声明的缺失项只保留本模块
  // 认得的键，避免把任意字符串透传给渲染层。
  const upstream = Array.isArray(quote.missingFields) ? quote.missingFields : [];
  const missing = new Set(upstream.filter((field) => TENCENT_TRACKED_FIELDS.includes(field)));
  // 上游已声明缺失的字段，即使被上游折成 0 也要还原成 null，避免"0 元涨停价"。
  for (const field of missing) normalized[field] = null;
  for (const field of TENCENT_TRACKED_FIELDS) {
    if (normalized[field] === null) missing.add(field);
  }
  return {
    ...normalized,
    missingFields: TENCENT_TRACKED_FIELDS.filter((field) => missing.has(field))
  };
}

// ---------------------------------------------------------------------------
// 个股实时报价：三路接力 + 熔断（见 market-source-health.cjs）
//
//   marketQuoteChain        同花顺免费行情 → 东方财富 → 腾讯   （默认，未配置 QuantAPI 时）
//   publicQuoteWithFallback 东方财富 → 腾讯 → 同花顺免费行情   （显式选择东方财富、或 QuantAPI 失败后）
//
// 每一路失败都记入健康度；连续失败的线路熔断一段时间，避免每轮轮询都在坏线路上等满超时。
// ---------------------------------------------------------------------------
const industryByCode = new BoundedCache({ maxBytes: 256 * 1024, maxEntries: 4000, staleTtlMs: 0, now: () => Date.now() });

function rememberIndustry(quote) {
  const code = String(quote?.code || "");
  const industry = String(quote?.industry || "").trim();
  if (/^\d{6}$/.test(code) && industry && industry !== "未分类") {
    industryByCode.set(code, { value: industry, expiresAt: Date.now() + 12 * 3600 * 1000 });
  }
}

function knownIndustry(security) {
  return String(security?.industry || "").trim() || String(industryByCode.get(security?.code)?.value || "");
}

function chainShouldStop() {
  return serviceSignal().aborted;
}

function trackedThsFreeQuote(security) {
  return Promise.resolve().then(() => serviceRuntime.track(() => trackServiceRequest(
    thsFreeMarket.thsFreeQuote(security, { signal: serviceSignal() })
  ))).then((quote) => ({ ...quote, industry: quote.industry || knownIndustry(security) }));
}

// 扶摇实时报价：合并请求的批量快照；换手率/市值所需股本取自同花顺免费行情（6 小时缓存）。
const { createFuyaoQuoteSource } = require("./fuyao-quote.cjs");
const fuyaoQuoteSource = createFuyaoQuoteSource({ fuyao, loadProfile: (security) => trackedThsFreeQuote(security) });

function quoteSteps(security, order, { timeoutMs = 6000, eastFactory } = {}) {
  const factories = {
    fuyao: fuyao.configured() && fuyaoQuoteSource.supports(security)
      ? { id: "fuyao", run: async () => {
        const quote = await Promise.resolve().then(() => serviceRuntime.track(() => trackServiceRequest(fuyaoQuoteSource.quote(security))));
        return { ...quote, industry: quote.industry || knownIndustry(security) };
      } }
      : null,
    ths_free: thsFreeMarket.thsFreeSupports(security)
      ? { id: "ths_free", run: () => trackedThsFreeQuote(security) }
      : null,
    eastmoney: {
      id: "eastmoney",
      run: async () => {
        const quote = await (eastFactory ? eastFactory() : eastQuote(security, timeoutMs));
        rememberIndustry(quote);
        return quote;
      }
    },
    tencent: {
      id: "tencent",
      run: async () => {
        const quote = normalizeTencentQuote(security, await tencentQuote(security));
        return { ...quote, industry: knownIndustry(security) || quote.industry };
      }
    }
  };
  return order.map((id) => factories[id]).filter(Boolean);
}

const QUOTE_SOURCE_LABELS = Object.freeze({ fuyao: "同花顺扶摇行情", ths_free: "同花顺免费行情", eastmoney: "东方财富", tencent: "腾讯行情" });

function relayWarning(result, preferred) {
  if (result.id === preferred) return "";
  const preferredAttempt = result.attempts.find((item) => item.id === preferred);
  const label = QUOTE_SOURCE_LABELS[preferred] || preferred;
  const relay = QUOTE_SOURCE_LABELS[result.id] || result.id;
  if (!preferredAttempt) return `${label}不适用于该证券，当前由${relay}提供行情。`;
  const reason = preferredAttempt.skipped
    ? "连续失败，正在等待自动重试"
    : String(preferredAttempt.error || "请求失败").slice(0, 60);
  return `${label}暂不可用（${reason}），已由${relay}接力；恢复后自动切回。`;
}

async function runQuoteChain(security, order, options = {}) {
  try {
    const result = await marketSourceHealth.runChain(quoteSteps(security, order, options), { signal: serviceSignal(options.signal), shouldStop: chainShouldStop });
    return {
      quote: result.value,
      actualProvider: result.id,
      warning: relayWarning(result, order[0]),
      attempts: result.attempts
    };
  } catch (error) {
    if (chainShouldStop() || options.signal?.aborted) throw error;
    const relayError = new Error(`公开行情暂不可用：${order.map((id) => QUOTE_SOURCE_LABELS[id]).join("、")}均失败。${error.message}`);
    relayError.cause = error;
    relayError.attempts = error.attempts;
    throw relayError;
  }
}

/** 默认报价链：配置了扶摇 Key 时扶摇为主（沪深A股），同花顺免费行情接力，东方财富、腾讯应急。 */
function marketQuoteChain(security, options = {}) {
  return runQuoteChain(security, fuyao.configured() && fuyaoQuoteSource.supports(security)
    ? ["fuyao", "ths_free", "eastmoney", "tencent"] : ["ths_free", "eastmoney", "tencent"], options);
}

/** 东方财富为主的报价链（显式选择东方财富或作为 QuantAPI 的接力）。 */
function publicQuoteWithFallback(security, timeoutMs = 12000) {
  return runQuoteChain(security, ["eastmoney", "tencent", "ths_free"], { timeoutMs });
}

function configureFuyao({ getApiKey } = {}) {
  fuyaoApiKeyProvider = typeof getApiKey === "function" ? getApiKey : () => "";
  sectorLimitCounts.clear();
}

function getMarketSourceHealth() {
  return {
    checkedAt: new Date().toISOString(),
    quotes: marketSourceHealth.snapshot([...(fuyao.configured() ? ["fuyao"] : []), "ths_free", "eastmoney", "tencent"]),
    history: marketSourceHealth.snapshot([...(fuyao.configured() ? ["fuyao_history"] : []), "ths_free_history", "eastmoney_history", "tencent_history"])
  };
}

/**
 * 扶摇历史日线（个股或指数）；仅有逐股成交时间证据时允许快照补日K。返回行与其他日线同形，dataSource = fuyao_*。
 * 前复权当天：快照价是原价，只有当天无除权时与前复权一致——扶摇当天的前复权因子尚未可知，
 * 所以前复权日线只在快照日期晚于最后一根时追加，不覆盖已有行。
 */
// 同一证券的扶摇快照在几秒内复用：不复权与前复权两次取日线时只请求一次快照。
const fuyaoSnapshotCache = new Map();
function cachedFuyaoSnapshot(security, { signal, index }) {
  const key = `${index ? "i" : "s"}:${fuyaoThscode(security)}`;
  const hit = fuyaoSnapshotCache.get(key);
  if (hit && Date.now() - hit.at < 8000) return hit.promise;
  const promise = fuyao.snapshot([security], { signal, index }).then((quotes) => quotes.get(fuyaoThscode(security)) || null);
  fuyaoSnapshotCache.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (fuyaoSnapshotCache.get(key)?.promise === promise) fuyaoSnapshotCache.delete(key); });
  if (fuyaoSnapshotCache.size > 64) fuyaoSnapshotCache.delete(fuyaoSnapshotCache.keys().next().value);
  return promise;
}

/**
 * 扶摇快照只给“数据就绪时间”，不给逐只行情时间：盘前它可能仍是上一交易日的价格。
 * 新增/刷新日线需要逐只真实成交时间、有效交易日和成交证据，再校验昨收连续。
 * 仅有扶摇出数时间时不合成日K，以历史接口返回的数据为准。
 */
function fuyaoQuoteBelongsAfter(rows, quote, quoteDate) {
  if (!quote || !quoteDate || !(quote.preClose > 0) || !(quote.latest > 0) || !(quote.open > 0)) return false;
  // Provider response timestamps cannot establish a new per-security trading day.
  // Without genuine trade-time evidence the history endpoint remains authoritative.
  if (quote.quoteAtIsTradeTime !== true || dailyBarCalendar.isSession(quoteDate) !== true) return false;
  const tradedAt = Date.parse(quote.quoteAt || "");
  if (!Number.isFinite(tradedAt)) return false;
  const clock = shanghaiClock(new Date(tradedAt));
  if (clock.date !== quoteDate || clock.minute < 9 * 60 + 30 || !(quote.volume > 0) || !(quote.amount > 0)) return false;
  const last = rows.at(-1);
  const reference = !last ? null : quoteDate > last.date ? last : quoteDate === last.date ? rows.at(-2) : null;
  if (!reference) return !last;
  return Math.abs(quote.preClose / Number(reference.close) - 1) <= 0.002;
}

async function fuyaoDailyHistory(security, { limit = 160, fqt = 1, signal } = {}) {
  const bars = await fuyao.dailyHistory(security, { limit, fqt, signal });
  let rows = [...bars];
  if (Number(fqt) !== 2) {
    try {
      const quote = await cachedFuyaoSnapshot(security, { signal, index: bars.index });
      const last = rows.at(-1);
      const quoteDate = quote?.quoteAt ? thsFreeShanghaiDate(quote.quoteAt) : "";
      const sameDayRefresh = Number(fqt) === 0 && last && quoteDate === last.date;
      if ((!last || quoteDate > last.date || sameDayRefresh) && fuyaoQuoteBelongsAfter(rows, quote, quoteDate)) {
        rows = thsFreeMarket.mergeQuoteIntoDailyRows(rows, quote);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  const result = thsFreeMarket.withDerivedFields(rows).slice(-Math.max(1, Number(limit) || 160));
  const adjustment = bars.index ? 0 : Number(fqt) === 0 ? 0 : Number(fqt) === 2 ? 2 : 1;
  Object.defineProperty(result, "dataSource", { value: bars.index ? "fuyao_index" : adjustment === 1 ? "fuyao_qfq" : adjustment === 2 ? "fuyao_hfq" : "fuyao_unadjusted", enumerable: false });
  Object.defineProperty(result, "actualAdjustment", { value: adjustment, enumerable: false });
  return result;
}

function thsFreeShanghaiDate(iso) {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) : "";
}

const fuyaoReviewCache = new BoundedCache({ maxEntries: 4, maxBytes: 2 * 1024 * 1024, staleTtlMs: 0, now: () => Date.now() });

/** 涨停原因归类：同花顺原因写成「A+B+C」，按「+」拆开计数。 */
function limitUpReasonGroups(rows, top = 12) {
  const groups = new Map();
  for (const row of rows) {
    for (const part of String(row.reason || "").split(/[+＋、,，;；]/).map((text) => text.trim()).filter(Boolean)) {
      const group = groups.get(part) || { reason: part, count: 0, stocks: [] };
      group.count += 1;
      if (group.stocks.length < 6) group.stocks.push({ code: row.code, name: row.name, boards: row.boards });
      groups.set(part, group);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "zh-CN")).slice(0, top);
}

/** 北京时间分钟数与日期（交易日判断由调用方负责）。 */
function fuyaoClock(now = Date.now()) {
  const cn = new Date(now + 8 * 3600000);
  return { date: cn.toISOString().slice(0, 10), minute: cn.getUTCHours() * 60 + cn.getUTCMinutes(), hhmm: cn.toISOString().slice(11, 16) };
}
/**
 * 扶摇在每天约 9:00 清空各池、开盘前对空池返回 code=5003「missing required pagination」（2026-11-06 实测：
 * 08:57 正常，09:00 起跌停池报这个错，涨停池同时返回 0 只）。9:25 之前当日池子按定义就是空的，按空池处理、不报警。
 */
const isPreOpenEmptyPool = (reason, now = Date.now()) => /missing required pagination/i.test(String(reason?.message || reason || "")) && fuyaoClock(now).minute < 9 * 60 + 25;
/** 各分块最近一次成功的数据（同一天内）：某块单次刷新失败时沿用，并在提示里写明时间，不让整块消失。 */
const fuyaoLastGood = new Map();

/** 北京时间交易日 9:10–11:35、12:55–15:10（含竞价与收盘后几分钟的补数据）。 */
function fuyaoDataMayChange(now = Date.now()) {
  const cn = new Date(now + 8 * 3600000);
  const date = cn.toISOString().slice(0, 10);
  const { tradingDateStatus } = require("./market-time-rules.cjs");
  if (tradingDateStatus(date) === false) return false;
  const minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  return (minute >= 9 * 60 + 10 && minute <= 11 * 60 + 35) || (minute >= 12 * 60 + 55 && minute <= 15 * 60 + 10);
}

/**
 * 复盘页的同花顺扶摇数据：连板天梯、涨停原因、炸板/跌停、热股榜、飙升榜、龙虎榜、异动解读。
 * 没有 Key 时返回 { available: false }；每一块独立失败，不拖累其他块和复盘主体。
 */
async function getFuyaoReviewData(options = {}) {
  return (await getFuyaoReviewSnapshot(options)).review;
}

async function getFuyaoReviewSnapshot(options = {}) {
  if (!fuyao.configured()) return { review: { available: false, reason: "未配置同花顺扶摇 API Key（数据源设置里填写后即可显示）" }, industryPool: null };
  const signal = serviceSignal();
  // 交易时段 60 秒刷新；收盘后、午休和休市日数据不再变化，改为 20 分钟，避免页面定时刷新反复调用按次计费的扶摇接口。
  // 两种时段各用一个固定键：开盘时不沿用休市缓存或订阅尚未完成的休市请求。
  const cacheKey = fuyaoDataMayChange() ? "review:live" : "review:closed";
  return serviceRuntime.cached(fuyaoReviewCache, cacheKey, () => (fuyaoDataMayChange() ? 60 * 1000 : 20 * 60 * 1000), async () => {
    const parts = {
      limitUp: () => fuyao.limitUpPool({ signal }),
      limitBreak: () => fuyao.limitBreakPool({ signal }),
      limitDown: () => fuyao.limitDownPool({ signal }),
      ladder: () => fuyao.limitUpLadder({ signal }),
      hot: () => fuyao.hotStocks({ period: "day", signal }),
      skyrocket: () => fuyao.skyrocket({ period: "day", signal }),
      hotHour: () => fuyao.hotStocks({ period: "hour", signal }),
      skyrocketHour: () => fuyao.skyrocket({ period: "hour", signal }),
      dragonTiger: () => fuyao.dragonTiger({ signal }),
      anomalies: () => fuyao.anomalies({ tags: ["LIMIT_UP", "SHARP_RISE", "RAPID_RALLY", "LIMIT_DOWN", "SHARP_FALL"], signal })
    };
    const names = Object.keys(parts);
    const settled = await Promise.allSettled(names.map((name) => serviceRuntime.track(() => trackServiceRequest(parts[name]()))));
    const labels = { limitUp: "涨停池", limitBreak: "炸板池", limitDown: "跌停池", ladder: "连板天梯", hot: "24小时热股榜", skyrocket: "24小时飙升榜", hotHour: "1小时热股榜", skyrocketHour: "1小时飙升榜", dragonTiger: "龙虎榜", anomalies: "异动解读" };
    const clock = fuyaoClock(), live = fuyaoDataMayChange();
    // 只在本轮有其他分块成功时才沿用：全部失败仍按失败处理；也只沿用同一天、同一时段（盘中/休市）的数据，开盘时不拿开盘前的数据顶替。
    const anySucceeded = settled.some((result) => result.status === "fulfilled");
    const value = {}, warnings = [];
    names.forEach((name, index) => {
      const result = settled[index];
      if (result.status === "fulfilled") { value[name] = result.value; fuyaoLastGood.set(name, { value: result.value, date: clock.date, hhmm: clock.hhmm, live }); return; }
      if (["limitUp", "limitBreak", "limitDown"].includes(name) && isPreOpenEmptyPool(result.reason)) { value[name] = { rows: [], total: 0, fetchedAt: "" }; return; }
      const reason = String(result.reason?.message || result.reason).slice(0, 80);
      const last = fuyaoLastGood.get(name);
      if (anySucceeded && last && last.date === clock.date && last.live === live) { value[name] = last.value; warnings.push(`${labels[name]}本次刷新失败，沿用 ${last.hhmm} 的数据（${reason}）`); return; }
      value[name] = null; warnings.push(`${labels[name]}暂不可用：${reason}`);
    });
    if (names.every((name) => value[name] === null)) {
      const first = settled[0].reason;
      throw Object.assign(new Error(`同花顺扶摇复盘数据全部不可用：${first?.message || first}`), { code: first?.code });
    }
    const limitUpRows = (value.limitUp?.rows || []).filter((row) => !row.isSt);
    const hotLists = await fuyaoHotLists(value, signal);
    const maxBoards = limitUpRows.reduce((max, row) => Math.max(max, Number(row.boards) || 0), 0);
    const review = {
      available: true,
      source: "同花顺扶摇官方数据接口",
      fetchedAt: new Date().toISOString(),
      limitUp: value.limitUp ? {
        count: limitUpRows.length,
        maxBoards,
        boardCounts: [1, 2, 3, 4, 5].map((level) => ({ level, label: level === 5 ? "5板以上" : level === 1 ? "首板" : `${level}板`,
          count: limitUpRows.filter((row) => level === 5 ? Number(row.boards) >= 5 : Number(row.boards || 1) === level).length })),
        reasons: limitUpReasonGroups(limitUpRows),
        leaders: limitUpRows.filter((row) => Number(row.boards) >= 2).sort((a, b) => (b.boards || 0) - (a.boards || 0) || (b.sealMoney || 0) - (a.sealMoney || 0)).slice(0, 12),
        // 每只涨停股的同花顺涨停原因，复盘梯队按代码合并。
        byCode: Object.fromEntries(limitUpRows.slice(0, 300).map((row) => [row.code, { name: row.name, reason: row.reason, boards: row.boards, boardsText: row.boardsText, sealMoney: row.sealMoney, limitUpTime: row.limitUpTime }]))
      } : null,
      // byCode：AI 问股按代码查一只股票是否在炸板池、跌停池、龙虎榜里（只留几个字段）。
      limitBreak: value.limitBreak ? { count: value.limitBreak.total, top: value.limitBreak.rows.slice(0, 10),
        byCode: Object.fromEntries(value.limitBreak.rows.slice(0, 400).map((row) => [row.code, { name: row.name, changePct: row.changePct, openTimes: row.openTimes, turnoverRate: row.turnoverRate }])) } : null,
      limitDown: value.limitDown ? { count: value.limitDown.total, top: value.limitDown.rows.slice(0, 10),
        byCode: Object.fromEntries(value.limitDown.rows.slice(0, 300).map((row) => [row.code, { name: row.name, changePct: row.changePct, firstLimitTime: row.firstLimitTime, lastLimitTime: row.lastLimitTime }])) } : null,
      sealRate: value.limitUp && value.limitBreak && limitUpRows.length + value.limitBreak.total > 0
        ? limitUpRows.length / (limitUpRows.length + value.limitBreak.total) : null,
      ladder: value.ladder ? { days: value.ladder.days.slice(-5) } : null,
      hot: value.hot ? value.hot.slice(0, 20) : null,
      skyrocket: value.skyrocket ? value.skyrocket.slice(0, 10) : null,
      // 同花顺热榜两个页签：1小时 / 24小时，各含热股榜与飙升榜（各最多30条，带当前涨跌幅）。
      hotLists,
      dragonTiger: value.dragonTiger ? {
        date: value.dragonTiger.date,
        count: value.dragonTiger.count,
        topNet: [...value.dragonTiger.stocks].filter((row) => Number.isFinite(row.net)).sort((a, b) => b.net - a.net).slice(0, 10),
        desks: value.dragonTiger.desks.slice(0, 6),
        byCode: Object.fromEntries(value.dragonTiger.stocks.slice(0, 200).map((row) => [row.code, { name: row.name, changePct: row.changePct, net: row.net, buy: row.buy, sell: row.sell,
          orgNet: row.orgNet, hotMoneyNet: row.hotMoneyNet, reason: row.reason, concepts: row.concepts, days: row.days,
          desks: value.dragonTiger.desks.filter((desk) => desk.stocks.some((item) => item.code === row.code)).map((desk) => desk.name).slice(0, 4) }]))
      } : null,
      anomalies: value.anomalies ? value.anomalies.rows.slice(0, 30) : null,
      warnings
    };
    // 行业成分明细也显示 ST 股；行业榜用完整池，复盘摘要维持原来的筛选和条数。
    return { review, industryPool: value.limitUp ? {
      total: value.limitUp.total,
      stocks: value.limitUp.rows.map(({ code, name, boards, reason, isSt }) => ({ code, name, boards, reason, isSt }))
    } : null };
  }, { forceRefresh: options?.forceRefresh === true });
}

/**
 * 热榜按同花顺的 1小时 / 24小时 两个页签整理；榜单本身不带价格，用扶摇批量快照补现价与涨跌幅
 * （快照失败只是不显示涨跌幅，不影响榜单）。
 */
async function fuyaoHotLists(value, signal) {
  const lists = { hour: { hot: value.hotHour, skyrocket: value.skyrocketHour }, day: { hot: value.hot, skyrocket: value.skyrocket } };
  const codes = new Map();
  for (const period of Object.values(lists)) for (const rows of Object.values(period)) for (const row of rows || []) if (row?.code) codes.set(row.code, row);
  let quotes = new Map();
  if (codes.size) {
    try {
      quotes = await serviceRuntime.track(() => trackServiceRequest(fuyao.snapshot([...codes.values()].map(row => ({ code: row.code, thscode: row.thscode })), { signal })));
    } catch { quotes = new Map(); }
  }
  const withQuote = rows => Array.isArray(rows) ? rows.slice(0, 30).map(row => {
    const quote = quotes.get(String(row.thscode || "").toUpperCase());
    return { ...row, latest: finiteOrNull(quote?.latest), changePct: finiteOrNull(quote?.changePct) };
  }) : null;
  const pack = period => (lists[period].hot || lists[period].skyrocket) ? { hot: withQuote(lists[period].hot), skyrocket: withQuote(lists[period].skyrocket) } : null;
  const hour = pack("hour"), day = pack("day");
  return hour || day ? { hour, day, quotedAt: quotes.size ? new Date().toISOString() : null } : null;
}

function fuyaoUsable() {
  return fuyao.configured() && !marketSourceHealth.isOpen("fuyao_history");
}

async function trackedFuyaoHistory(security, options) {
  const started = Date.now();
  try {
    const rows = await Promise.resolve().then(() => serviceRuntime.track(() => trackServiceRequest(fuyaoDailyHistory(security, { ...options, signal: options?.signal || serviceSignal() }))));
    marketSourceHealth.recordSuccess("fuyao_history", Date.now() - started);
    return rows;
  } catch (error) {
    if (!serviceSignal()?.aborted && !options?.signal?.aborted) marketSourceHealth.recordFailure("fuyao_history", error, Date.now() - started);
    throw error;
  }
}

/**
 * 给趋势/策略扫描用的同花顺日线通道：扶摇（有 Key 时）→ 同花顺免费网页日线。
 * 指数基准（中证全指 000985）只有扶摇能提供；没有 Key 时返回 null，由扫描器走应急源。
 */
const trendThsLane = Object.freeze({
  quote: (security, options) => thsFreeMarket.thsFreeQuote(security, options),
  history: async (security, options = {}) => {
    if (fuyaoUsable()) {
      try { return await trackedFuyaoHistory(security, { limit: options.limit, fqt: options.fqt, signal: options.signal }); }
      catch (error) { if (options.signal?.aborted) throw error; }
    }
    return thsFreeMarket.thsFreeDailyHistory(security, options);
  },
  benchmark: async (security, options = {}) => {
    if (!fuyaoUsable()) return null;
    try { return await trackedFuyaoHistory({ ...security, assetType: "index" }, { limit: options.limit, fqt: 0, signal: options.signal }); }
    catch (error) { if (options.signal?.aborted) throw error; return null; }
  }
});

/** One Eastmoney kline CSV line → OHLCV row. The column order is fixed by the `fields2`
 * request parameter and is shared by the history and chart endpoints. */
function eastmoneyKlineRow(line) {
  const v = line.split(",");
  return {
    date: v[0],
    open: Number(v[1]),
    close: Number(v[2]),
    high: Number(v[3]),
    low: Number(v[4]),
    volume: Number(v[5]),
    volumeUnit: "lots",
    ...(finiteOrNull(v[9]) !== null && Number(v[2]) - Number(v[9]) > 0 ? { preClose: roundPrice(Number(v[2]) - Number(v[9])) } : {}),
    amount: Number(v[6]),
    amplitude: Number(v[7]),
    changePct: Number(v[8]),
    change: Number(v[9]),
    turnover: Number(v[10])
  };
}

async function eastMoneyHistory(security, limit = 160, fqt = 1) {
  const url =
    `${EAST_HISTORY}/stock/kline/get?secid=${encodeURIComponent(String(security.secid))}` +
    `&klt=101&fqt=${fqt}&lmt=${limit}&end=20500101` +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
  const json = await fetchJson(url);
  const lines = json?.data?.klines || [];
  const rows = validateHistoryRows(lines.map(eastmoneyKlineRow), {
    source: "eastmoney",
    minimumRows: Math.min(20, Math.max(1, Number(limit) || 1))
  });
  Object.defineProperty(rows, "actualAdjustment", { value: Number(fqt), enumerable: false });
  Object.defineProperty(rows, "dataSource", {
    value: "eastmoney",
    enumerable: false
  });
  return rows;
}

async function thsFreeHistory(security, limit = 160, fqt = 1) {
  const raw = await Promise.resolve().then(() => serviceRuntime.track(() => trackServiceRequest(
    thsFreeMarket.thsFreeDailyHistory(security, { limit, fqt, signal: serviceSignal() })
  )));
  const rows = validateHistoryRows(raw, {
    source: "ths_free",
    minimumRows: Math.min(20, Math.max(1, Number(limit) || 1))
  });
  Object.defineProperty(rows, "dataSource", { value: raw.dataSource, enumerable: false });
  Object.defineProperty(rows, "actualAdjustment", { value: raw.actualAdjustment, enumerable: false });
  return rows;
}

async function fuyaoHistoryStep(security, limit, fqt) {
  const raw = await trackedFuyaoHistory(security, { limit, fqt });
  const rows = validateHistoryRows(raw, { source: "fuyao", minimumRows: Math.min(20, Math.max(1, Number(limit) || 1)) });
  Object.defineProperty(rows, "dataSource", { value: raw.dataSource, enumerable: false });
  Object.defineProperty(rows, "actualAdjustment", { value: raw.actualAdjustment, enumerable: false });
  return rows;
}

async function eastHistory(security, limit = 160, fqt = 1) {
  // 同花顺扶摇（有 Key 时）为第一路：个股与指数（含中证全指）都覆盖。
  const fuyaoStep = fuyao.configured() && fuyaoThscode(security) && (isIndexSecurity(security) || isAStockCode(security.code))
    ? { id: "fuyao_history", run: () => fuyaoHistoryStep(security, limit, fqt) }
    : null;
  const thsStep = thsFreeMarket.thsFreeSupports(security)
    ? { id: "ths_free_history", run: () => thsFreeHistory(security, limit, fqt) }
    : null;
  // 同花顺免费日线为主源；东方财富、腾讯、新浪只在同花顺失败或不支持该品种时应急。
  const steps = Number(fqt) === 0
    ? [
        fuyaoStep,
        thsStep,
        {
          id: "sina_history",
          run: async () => {
            const rows = await sinaKline(security, "101", limit);
            if (!historyEndsRecently(rows, 45)) throw new Error("新浪日线最新日期过旧，切换备用源");
            return rows;
          }
        },
        { id: "tencent_history", run: () => tencentHistory(security, limit, 0) }
      ]
    : [
        fuyaoStep,
        thsStep,
        { id: "eastmoney_history", run: () => eastMoneyHistory(security, limit, fqt) },
        { id: "tencent_history", run: () => tencentHistory(security, limit, fqt) },
        { id: "sina_history", run: () => sinaKline(security, "101", limit) }
      ];
  return (await marketSourceHealth.runChain(steps, { signal: serviceSignal(), shouldStop: chainShouldStop })).value;
}

async function tencentHistory(security, limit = 160, fqt = 0) {
  const directCode = String(security?.code || "");
  const secid = String(security?.secid || "");
  const secidMatch = secid.match(/^[01]\.(\d{6})$/);
  const code = /^\d{6}$/.test(directCode) ? directCode : secidMatch?.[1] || "";
  if (!/^\d{6}$/.test(code)) throw new Error("腾讯历史行情缺少有效证券代码");
  if ((secid && !secidMatch) || (secidMatch && secidMatch[1] !== code)) {
    throw new Error("腾讯历史行情证券标识不一致");
  }
  const prefix = secid.startsWith("1.")
    ? "sh"
    : isBseAshareCode(code)
      ? "bj"
      : "sz";
  const symbol = `${prefix}${code}`;
  const adjustment =
    Number(fqt) === 1 ? "qfq" : Number(fqt) === 2 ? "hfq" : "";
  const safeLimit = Math.max(20, Math.min(1500, Math.round(Number(limit) || 160)));
  const url =
    "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get" +
    `?param=${encodeURIComponent(`${symbol},day,,,${safeLimit},${adjustment}`)}`;
  let json;
  try {
    json = await fetchJson(url, {}, 15000);
  } catch (error) {
    serviceRuntime.checkpoint();
    if (process.env.ASTOCK_DISABLE_CURL === "1") throw error;
    json = await fetchJsonWithCurl(url, 15000, "https://gu.qq.com/", serviceSignal());
  }
  const payload = json?.data?.[symbol] || {};
  const field = adjustment ? `${adjustment}day` : "day";
  const lines = Array.isArray(payload[field])
    ? payload[field]
    : Array.isArray(payload.day)
      ? payload.day
      : [];
  if (!lines.length) throw new Error(`腾讯历史行情为空：${symbol}`);
  const rows = validateHistoryRows(lines.map((row) => ({
    date: String(row?.[0] || ""),
    open: Number(row?.[1]),
    close: Number(row?.[2]),
    high: Number(row?.[3]),
    low: Number(row?.[4]),
    volume: Number(row?.[5]),
    volumeUnit: "lots",
    amount: null,
    amplitude: null,
    changePct: null,
    change: null,
    turnover: null
  })), {
    source: "tencent",
    minimumRows: Math.min(20, Math.max(1, Number(limit) || 1))
  });
  Object.defineProperty(rows, "dataSource", {
    value: adjustment && Array.isArray(payload[field]) ? `tencent_${adjustment}` : "tencent_unadjusted",
    enumerable: false
  });
  Object.defineProperty(rows, "actualAdjustment", {
    value: adjustment && !Array.isArray(payload[field]) ? 0 : Number(fqt),
    enumerable: false
  });
  return rows;
}

async function sinaKline(security, interval = "101", limit = 160) {
  const directCode = String(security?.code || "");
  const secid = String(security?.secid || "");
  const secidMatch = secid.match(/^[01]\.(\d{6})$/);
  const code = /^\d{6}$/.test(directCode) ? directCode : secidMatch?.[1] || "";
  if (!/^\d{6}$/.test(code)) throw new Error("新浪历史行情缺少有效证券代码");
  if ((secid && !secidMatch) || (secidMatch && secidMatch[1] !== code)) {
    throw new Error("新浪历史行情证券标识不一致");
  }
  const prefix = secid.startsWith("1.")
    ? "sh"
    : isBseAshareCode(code)
      ? "bj"
      : "sz";
  const symbol = `${prefix}${code}`;
  const frame = String(interval);
  const scale = frame === "101" ? "240" : frame;
  const safeLimit = Math.max(20, Math.min(1500, Math.round(Number(limit) || 160)));
  const url =
    "https://quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData" +
    `?symbol=${encodeURIComponent(symbol)}&scale=${encodeURIComponent(scale)}&ma=no&datalen=${safeLimit}`;
  let json;
  try {
    json = await fetchJson(
      url,
      {
        headers: {
          "Referer": "https://finance.sina.com.cn/"
        }
      },
      15000
    );
  } catch (error) {
    serviceRuntime.checkpoint();
    if (process.env.ASTOCK_DISABLE_CURL === "1") throw error;
    json = await fetchJsonWithCurl(url, 15000, "https://finance.sina.com.cn/", serviceSignal());
  }
  const lines = Array.isArray(json?.result?.data)
    ? json.result.data
    : Array.isArray(json)
      ? json
      : [];
  if (!lines.length) throw new Error(`新浪历史行情为空：${symbol}/${scale}`);
  const rows = validateHistoryRows(lines.map((row) => ({
    date: String(row?.day || row?.date || ""),
    open: Number(row?.open),
    close: Number(row?.close),
    high: Number(row?.high),
    low: Number(row?.low),
    volume: finiteOrNull(row?.volume) === null ? null : Number(row.volume) / 100,
    volumeUnit: "lots",
    amount: finiteOrNull(row?.amount),
    amplitude: null,
    changePct: null,
    change: null,
    turnover: null
  })), {
    source: "sina",
    preserveTime: Number(frame) > 0 && Number(frame) < 100,
    minimumRows: Math.min(20, Math.max(1, Number(limit) || 1))
  });
  Object.defineProperty(rows, "dataSource", {
    value: frame === "101" ? "sina_unadjusted" : `sina_${scale}m`,
    enumerable: false
  });
  Object.defineProperty(rows, "actualAdjustment", {
    value: 0,
    enumerable: false
  });
  return rows;
}

function historyEndsRecently(rows, maximumAgeDays = 45) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const latestDate = rows
    .map((row) => String(row?.date || "").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()
    .at(-1);
  if (!latestDate) return false;
  const timestamp = Date.parse(`${latestDate}T23:59:59+08:00`);
  if (!Number.isFinite(timestamp)) return false;
  const ageDays = (Date.now() - timestamp) / 86400000;
  return ageDays <= Math.max(1, Number(maximumAgeDays) || 45) && ageDays >= -7;
}

function validateHistoryRows(rows, options = {}) {
  const source = String(options.source || "history");
  const minimumRows = Math.max(1, Math.round(Number(options.minimumRows) || 1));
  const maximumAgeDays = Math.max(1, Number(options.maximumAgeDays) || 45);
  const seenDates = new Set();
  const usable = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      // Minute candles must retain their timestamp: deduplicating by date alone
      // collapses a full trading day to one bar and rejects valid fallback data.
      const rawDate = String(row?.date || "").replace("T", " ");
      const date = rawDate.slice(0, options.preserveTime ? 16 : 10);
      const open = Number(row?.open);
      const close = Number(row?.close);
      const high = Number(row?.high);
      const low = Number(row?.low);
      const rawVolume = row?.volume;
      const volume = rawVolume === null || rawVolume === undefined || rawVolume === ""
        ? Number.NaN
        : Number(rawVolume);
      if (options.preserveTime) {
        if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(date)) return null;
        const day = date.slice(0, 10), parsed = Date.parse(`${day}T00:00:00Z`);
        if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day) return null;
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      if (![open, close, high, low, volume].every(Number.isFinite)) return null;
      if (open <= 0 || close <= 0 || high <= 0 || low <= 0 || volume < 0) return null;
      if (low > Math.min(open, close) || high < Math.max(open, close) || high < low) return null;
      if (seenDates.has(date)) return null;
      seenDates.add(date);
      return { ...row, date, open, close, high, low, volume };
    })
    .filter(Boolean)
    .sort((left, right) => left.date.localeCompare(right.date));

  if (usable.length < minimumRows) {
    throw new Error(`${source} history has only ${usable.length} usable rows`);
  }
  if (!historyEndsRecently(usable, maximumAgeDays)) {
    throw new Error(`${source} history is stale or has no valid latest date`);
  }
  return usable;
}

function aggregateHistoryRows(rawRows, period = "week") {
  const rows = Array.isArray(rawRows)
    ? rawRows.filter((row) => row?.date && Number(row?.close) > 0)
    : [];
  const keyFor = (dateText) => {
    const dayText = String(dateText).slice(0, 10);
    if (period === "month") return dayText.slice(0, 7);
    const date = new Date(`${dayText}T00:00:00Z`);
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - mondayOffset);
    return date.toISOString().slice(0, 10);
  };
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFor(row.date);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        date: String(row.date).slice(0, 10),
        open: Number(row.open),
        close: Number(row.close),
        high: Number(row.high),
        low: Number(row.low),
        volume: Number(row.volume || 0),
        amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
        amplitude: null,
        changePct: null,
        change: null,
        turnover: null
      });
      continue;
    }
    current.date = String(row.date).slice(0, 10);
    current.close = Number(row.close);
    current.high = Math.max(current.high, Number(row.high));
    current.low = Math.min(current.low, Number(row.low));
    current.volume += Number(row.volume || 0);
    current.amount =
      current.amount !== null && Number.isFinite(Number(row.amount))
        ? current.amount + Number(row.amount)
        : null;
  }
  const result = [...grouped.values()];
  result.forEach((row, index) => {
    const previousClose = Number(result[index - 1]?.close);
    row.change = previousClose ? row.close - previousClose : null;
    row.changePct = previousClose ? ((row.close / previousClose) - 1) * 100 : null;
    row.amplitude = previousClose
      ? ((row.high - row.low) / previousClose) * 100
      : null;
  });
  Object.defineProperty(result, "dataSource", {
    value: `${String(rawRows?.dataSource || "public")}_${period}`,
    enumerable: false
  });
  Object.defineProperty(result, "actualAdjustment", {
    value: Number(rawRows?.actualAdjustment ?? 0),
    enumerable: false
  });
  return result;
}

async function eastHistoryCached(security, limit = 160, fqt = 1, ttlMs = 8 * 60 * 1000, options = {}) {
  return serviceRuntime.cached(historyCache, `${security.secid}:${limit}:${fqt}`, ttlMs,
    () => eastHistory(security, limit, fqt), options);
}

async function eastChart(security, interval = "101", limit = 160, adjustment = 1) {
  const allowedIntervals = new Set(["1", "5", "15", "30", "60", "120", "101", "102", "103"]);
  const klt = String(interval);
  if (!allowedIntervals.has(klt)) {
    throw new Error(`不支持的K线周期：${interval}`);
  }
  const fqt = [0, 1, 2].includes(Number(adjustment)) ? Number(adjustment) : 1;
  // 同花顺免费K线为主源；只有同花顺不支持该品种或本次失败时，才用东方财富/腾讯/新浪应急。
  // 指数在同花顺用自己的代码（上证指数 = hs_1A0001、沪深300 = hs_1B0300）。
  const thsTarget = security?.assetType === "index" && security.thsCode ? { ...security, code: security.thsCode } : security;
  if (thsFreeMarket.thsFreeSupports(thsTarget) && !marketSourceHealth.isOpen("ths_free_history")) {
    const startedAt = Date.now();
    try {
      const rows = await Promise.resolve().then(() => serviceRuntime.track(() => trackServiceRequest(
        thsFreeMarket.thsFreeKline(thsTarget, { interval: klt, limit, fqt, signal: serviceSignal() })
      )));
      marketSourceHealth.recordSuccess("ths_free_history", Date.now() - startedAt);
      if (rows.length) return rows;
    } catch (error) {
      if (chainShouldStop()) throw error;
      marketSourceHealth.recordFailure("ths_free_history", error, Date.now() - startedAt);
    }
  }
  const url =
    `${EAST_HISTORY}/stock/kline/get?secid=${encodeURIComponent(String(security.secid))}` +
    `&klt=${klt}&fqt=${fqt}&lmt=${limit}&end=20500101` +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
  try {
    const json = await fetchJson(url);
    const lines = json?.data?.klines || [];
    if (!lines.length) throw new Error("东方财富K线为空");
    const rows = lines.map(eastmoneyKlineRow);
    Object.defineProperty(rows, "dataSource", {
      value: "eastmoney",
      enumerable: false
    });
    Object.defineProperty(rows, "actualAdjustment", {
      value: fqt,
      enumerable: false
    });
    return rows;
  } catch {
    if (klt === "101") {
      try {
        return await tencentHistory(security, limit, fqt);
      } catch {
        return sinaKline(security, klt, limit);
      }
    }
    if (klt === "102" || klt === "103") {
      const multiplier = klt === "102" ? 6 : 24;
      const dailyLimit = Math.min(3000, Math.max(180, limit * multiplier));
      let dailyRows;
      try {
        dailyRows = await tencentHistory(security, dailyLimit, fqt);
      } catch {
        dailyRows = await sinaKline(security, "101", dailyLimit);
      }
      const aggregated = aggregateHistoryRows(
        dailyRows,
        klt === "102" ? "week" : "month"
      );
      if (aggregated.length <= limit) return aggregated;
      const visible = aggregated.slice(-limit);
      Object.defineProperty(visible, "dataSource", {
        value: aggregated.dataSource,
        enumerable: false
      });
      Object.defineProperty(visible, "actualAdjustment", {
        value: aggregated.actualAdjustment,
        enumerable: false
      });
      return visible;
    }
    return sinaKline(security, klt, limit);
  }
}

async function eastChartCached(security, interval, limit, adjustment, ttlMs, options = {}) {
  return serviceRuntime.cached(chartCache, `${security.secid}:${interval}:${limit}:${adjustment}`, ttlMs,
    () => eastChart(security, interval, limit, adjustment), options);
}

function withThsToken(refreshToken, request) {
  return withThsAccessToken(refreshToken, fetchJson, request, {
    baseUrl: THS_BASE,
    cacheKey: "ths-quant-api",
    missingMessage: "请先填写同花顺 refresh token",
    failureMessage: "同花顺 access token 获取失败"
  });
}

function extractThsTable(json) {
  const envelope = Array.isArray(json?.tables) ? json.tables[0] : json?.tables;
  if (!envelope || typeof envelope !== "object") {
    throw new Error(json?.message || json?.errorcode || "同花顺未返回数据");
  }
  // QuantAPI 的正式 HTTP 契约把指标列放在 tables[0].table 中，
  // time/thscode 等元数据仍位于外层。兼容少数旧响应直接把指标放外层。
  const indicatorTable = envelope.table && typeof envelope.table === "object"
    ? envelope.table
    : {};
  return { ...envelope, ...indicatorTable };
}

function firstValue(table, keys) {
  for (const key of keys) {
    const value = table[key];
    if (Array.isArray(value) && value.length) return value[value.length - 1];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function thsSeries(table, keys) {
  for (const key of keys) {
    let value = table?.[key];
    while (Array.isArray(value) && value.length === 1 && Array.isArray(value[0])) {
      value = value[0];
    }
    if (Array.isArray(value)) return value;
    if (value !== undefined && value !== null) return [value];
  }
  return [];
}

function thsHistoryNumber(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeThsHistoryTable(table, limit = 160) {
  const dates = thsSeries(table, ["time", "date"]);
  const columns = {
    open: thsSeries(table, ["open"]),
    high: thsSeries(table, ["high"]),
    low: thsSeries(table, ["low"]),
    close: thsSeries(table, ["close"]),
    volume: thsSeries(table, ["volume"]),
    amount: thsSeries(table, ["amount"]),
    changePct: thsSeries(table, ["changeRatio", "changePct"]),
    turnover: thsSeries(table, ["turnoverRatio", "turnover"])
  };
  const safeLimit = Math.max(1, Math.round(Number(limit) || 160));
  const start = Math.max(0, dates.length - safeLimit);
  return dates.slice(start).map((date, offset) => {
    const index = start + offset;
    return {
      date: String(date).slice(0, 10),
      open: thsHistoryNumber(columns.open[index]),
      high: thsHistoryNumber(columns.high[index]),
      low: thsHistoryNumber(columns.low[index]),
      close: thsHistoryNumber(columns.close[index]),
      volume: thsHistoryNumber(columns.volume[index]) / 100,
      volumeUnit: "lots",
      amount: thsHistoryNumber(columns.amount[index]),
      changePct: thsHistoryNumber(columns.changePct[index]),
      turnover: thsHistoryNumber(columns.turnover[index])
    };
  });
}

async function thsQuote(security, settings) {
  const indicators =
    "open,high,low,latest,preClose,changeRatio,turnoverRatio,latestAmount,latestVolume";
  const json = await withThsToken(settings.refreshToken, (token) =>
    fetchJson(`${THS_BASE}/real_time_quotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", access_token: token },
      body: JSON.stringify({ codes: security.thscode, indicators })
    }).then((result) => {
      if (Number(result?.errorcode || 0) !== 0) {
        throw thsProviderError(result, `同花顺错误 ${result?.errorcode}`);
      }
      return result;
    })
  );
  const t = extractThsTable(json);
  const monitorValues = {
    latest: firstValue(t, ["latest", "close"]),
    changePct: firstValue(t, ["changeRatio", "changePct"]),
    turnover: firstValue(t, ["turnoverRatio", "turnover"]),
    amount: firstValue(t, ["latestAmount", "amount"])
  };
  const latest = Number(monitorValues.latest);
  if (!Number.isFinite(latest) || latest <= 0) {
    throw new Error("同花顺实时行情缺少有效最新价");
  }
  return {
    ...security,
    latest,
    high: Number(firstValue(t, ["high"])),
    low: Number(firstValue(t, ["low"])),
    open: Number(firstValue(t, ["open"])),
    preClose: Number(firstValue(t, ["preClose", "preclose"])),
    changePct: Number(monitorValues.changePct),
    turnover: Number(monitorValues.turnover),
    amount: Number(monitorValues.amount),
    volume: finiteOrNull(firstValue(t, ["latestVolume", "volume"])) === null ? null : Number(firstValue(t, ["latestVolume", "volume"])) / 100,
    volumeUnit: "lots",
    industry: "",
    source: "ths",
    missingFields: missingMonitorQuoteFields(monitorValues)
  };
}

async function thsHistory(security, settings, limit = 160) {
  // 按北京时间取日期：UTC 日期在每天 0–8 点会比北京时间晚一天。
  const end = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const startDate = new Date(Date.now() + 8 * 3600000 - limit * 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const json = await withThsToken(settings.refreshToken, (token) =>
    fetchJson(`${THS_BASE}/cmd_history_quotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", access_token: token },
      body: JSON.stringify({
        codes: security.thscode,
        indicators: "open,high,low,close,volume,amount,changeRatio,turnoverRatio",
        startdate: startDate,
        enddate: end,
        functionpara: { Fill: "Blank" }
      })
    }).then((result) => {
      if (Number(result?.errorcode || 0) !== 0) {
        throw thsProviderError(result, `同花顺错误 ${result?.errorcode}`);
      }
      return result;
    })
  );
  const t = extractThsTable(json);
  return validateHistoryRows(normalizeThsHistoryTable(t, limit), {
    source: "ths",
    minimumRows: Math.min(20, Math.max(1, Number(limit) || 1))
  });
}

async function thsHistoryCached(security, settings, limit = 160) {
  const key = `ths:${security.thscode}:${limit}:${credentialFingerprint(settings?.refreshToken)}`;
  return serviceRuntime.cached(historyCache, key, 15 * 60 * 1000, () => thsHistory(security, settings, limit), settings);
}

// E-06：空样本 = "没有这个观测值"，不是"均值 0"。
// 旧实现 average([]) 返回 0，于是"没有 5 日均量"被写成"均量 0 手"、"无样本期望"被写成"0%"，
// 与真实的平盘/零成交无法区分。现在空集返回 null，调用点必须显式区分三态。
function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function roundPrice(value) {
  return Math.round(value * 100 + 1e-7) / 100;
}

function clamp(value, min = 0, max = 100, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    const fallbackNumber = Number(fallback);
    return Math.max(min, Math.min(max, Number.isFinite(fallbackNumber) ? fallbackNumber : min));
  }
  return Math.max(min, Math.min(max, number));
}

function buildTradeExecutionReadiness(analysis = {}, tradePlan = {}, settings = {}) {
  const safeSettings = settings || {};
  const blockers = [];
  const warnings = [];
  const signal = String(tradePlan?.signal || "WAIT");
  const minExecutionRatePercent = clamp(
    Number(safeSettings.minExecutionRatePercent ?? 90),
    40,
    100,
    90
  );
  const executionFillRatePercent = clamp(
    Number(tradePlan?.executionFillRatePercent),
    0,
    100,
    100
  );

  if (signal !== "BUY" && signal !== "BUY_AGGRESSIVE") {
    blockers.push(`交易计划未给出可执行买入信号：${signal}`);
  }
  if (executionFillRatePercent < minExecutionRatePercent) {
    blockers.push(
      `预计成交率 ${executionFillRatePercent.toFixed(1)}% 低于阈值 ${minExecutionRatePercent}%`
    );
  }
  if (!Number.isFinite(Number(tradePlan?.positionSizePercent)) || Number(tradePlan?.positionSizePercent) <= 0) {
    blockers.push("仓位建议为0，不执行");
  }
  if (tradePlan?.killSwitchTriggered) {
    blockers.push("交易计划触发风险熔断");
  }
  if (analysis?.qualification?.riskVetoPassed === false) {
    blockers.push("风控否决未通过");
  }
  if (analysis?.historicalEdge && analysis.historicalEdge.passed === false) {
    blockers.push(
      `历史回测门槛未通过：${analysis.historicalEdge.passReason || "样本/收益/回撤不满足"}`
    );
  }

  const riskPenalty = Number(analysis?.riskPenalty);
  if (riskPenalty > 35) {
    blockers.push(`风险惩罚过高：${riskPenalty.toFixed(1)}`);
  } else if (riskPenalty > 15) {
    warnings.push(`风险惩罚偏高：${riskPenalty.toFixed(1)}`);
  }

  const riskReward = Number(tradePlan?.riskReward);
  if (Number.isFinite(riskReward) && riskReward > 0 && riskReward < 1.2) {
    warnings.push(`风险收益比偏低：${riskReward.toFixed(2)}`);
  }

  const mrs = Number(analysis?.mrs);
  if (Number.isFinite(mrs) && mrs < 65) {
    warnings.push(`模型评分偏低：${mrs.toFixed(1)}`);
  }

  const reasons = [...blockers, ...warnings];
  const score = clamp(
    Math.round(100 - blockers.length * 26 - warnings.length * 8),
    0,
    100,
    0
  );

  let level = "pass";
  let status = "PASS";
  let recommendation = "可执行";
  let summary = "当前符合执行条件，可继续开仓。";

  if (blockers.length > 0) {
    level = "block";
    status = "BLOCK";
    recommendation = "请先修复阻断条件后再执行。";
    summary = "执行阻断：需要先解除风控约束。";
  } else if (warnings.length > 2 || score < 68) {
    level = "wait";
    status = "WAIT";
    recommendation = "建议先复核后执行（可进行人工确认）。";
    summary = "建议先确认再执行。";
  }

  return {
    score,
    level,
    status,
    summary,
    recommendation,
    reasons: reasons.length ? reasons : ["执行评估已完成。"],
    canExecute: level !== "block"
  };
}

function buildBacktestExecutionReadinessFromMetrics(metrics = {}, options = {}) {
  const safeOptions = options || {};
  const blockers = [];
  const warnings = [];

  const accepted = Boolean(metrics.accepted);
  const replayableSignals = Number(metrics.replayableSignals);
  const projectedNetEdge = Number(metrics.projectedNetEdge);
  const expectancy5 = Number(metrics.expectancy5);
  const winRate5 = Number(metrics.winRate5);
  const worstMdd5 = Number(metrics.worstMdd5);
  const walkForwardAvailable = metrics.walkForwardAvailable === true;
  const oosProjectedNetEdge = Number(metrics.oosProjectedNetEdge);
  const walkForwardPassRate = Number(metrics.walkForwardPassRate);
  const overfitRisk = String(metrics.overfitRisk || "insufficient");
  const minHistorySamples = Math.max(
    8,
    Math.round(Number(safeOptions.minHistorySamples ?? safeOptions.minSamples ?? 12))
  );
  const minProjectedNetEdgePercent = clamp(
    Number(safeOptions.minProjectedNetEdgePercent ?? 0.2),
    -5,
    10,
    0.2
  );
  const minExpectancyPoints = clamp(
    Number(safeOptions.minExpectancyPoints ?? 0.2),
    -5,
    8,
    0.2
  );

  if (!accepted) {
    blockers.push(metrics.passReason || "回测预检未通过");
  }
  if (!Number.isFinite(replayableSignals) || replayableSignals < minHistorySamples) {
    blockers.push(`样本不足：${Number.isFinite(replayableSignals)
      ? replayableSignals.toFixed(0)
      : "--"}/${minHistorySamples}`);
  }
  if (!Number.isFinite(projectedNetEdge) || projectedNetEdge < minProjectedNetEdgePercent) {
    blockers.push(`净收益低于阈值：${Number.isFinite(projectedNetEdge) ? projectedNetEdge.toFixed(2) : "--"}%`);
  }
  if (!Number.isFinite(expectancy5) || expectancy5 < minExpectancyPoints) {
    blockers.push(`盈亏期望偏低：${Number.isFinite(expectancy5) ? expectancy5.toFixed(2) : "--"}`);
  }
  if (Number.isFinite(worstMdd5) && worstMdd5 <= -16) {
    blockers.push(`回撤过深：${worstMdd5.toFixed(2)}%`);
  } else if (Number.isFinite(worstMdd5) && worstMdd5 <= -9) {
    warnings.push(`回撤偏大：${worstMdd5.toFixed(2)}%`);
  }
  if (Number.isFinite(winRate5) && winRate5 < 45) {
    blockers.push(`5日胜率不足：${winRate5.toFixed(1)}%`);
  } else if (Number.isFinite(winRate5) && winRate5 < 52) {
    warnings.push(`5日胜率偏弱：${winRate5.toFixed(1)}%`);
  }

  if (!walkForwardAvailable) {
    blockers.push("缺少可用的滚动样本外验证");
  } else {
    if (!Number.isFinite(oosProjectedNetEdge) || oosProjectedNetEdge < minProjectedNetEdgePercent) {
      blockers.push(`样本外净边际不足：${Number.isFinite(oosProjectedNetEdge) ? oosProjectedNetEdge.toFixed(2) : "--"}%`);
    }
    if (!Number.isFinite(walkForwardPassRate) || walkForwardPassRate < 2 / 3) {
      blockers.push(`样本外窗口通过率不足：${Number.isFinite(walkForwardPassRate) ? (walkForwardPassRate * 100).toFixed(0) : "--"}%`);
    }
    if (overfitRisk === "high") {
      blockers.push("训练与样本外表现差异过大，过拟合风险高");
    } else if (overfitRisk === "medium") {
      warnings.push("样本外表现有一定退化，过拟合风险中等");
    }
  }

  const reasons = [...blockers, ...warnings];
  const score = clamp(
    Math.round(100 - blockers.length * 30 - warnings.length * 8),
    0,
    100,
    0
  );

  let level = "pass";
  let status = "PASS";
  let recommendation = "可进入执行评估。";
  let summary = "回测执行评估通过。";

  if (blockers.length > 0) {
    level = "block";
    status = "BLOCK";
    recommendation = "当前不建议执行：补齐样本与边界。";
    summary = "回测预检不满足执行条件。";
  } else if (warnings.length > 2 || reasons.length > 4) {
    level = "wait";
    status = "WAIT";
    recommendation = "建议先复核再执行。";
    summary = "执行条件接近阈值，建议观察。";
  }

  return {
    score,
    level,
    status,
    summary,
    recommendation,
    reasons: reasons.length ? reasons : ["执行评估已完成。"],
    canRunLive: level !== "block"
  };
}

function summarizeWalkForwardSamples(samples = [], expectedCostPercent = 0) {
  const usable = samples.filter((item) => Number.isFinite(Number(item?.r5)));
  const returns = usable.map((item) => Number(item.r5));
  const averageReturn = returns.length ? average(returns) : 0;
  const wins = returns.filter((value) => value > 0).length;
  const winRate5 = returns.length ? (wins / returns.length) * 100 : 0;
  const worstMdd5 = usable.some((item) => Number.isFinite(Number(item?.mdd5)))
    ? Math.min(...usable.map((item) => Number(item.mdd5)).filter(Number.isFinite))
    : 0;
  return {
    samples: usable.length,
    winRate5,
    expectancy5: averageReturn,
    projectedNetEdge: averageReturn - expectedCostPercent,
    worstMdd5
  };
}

function buildWalkForwardValidationFromSamples(samples = [], options = {}) {
  const expectedCostPercent = Math.max(0, Number(options.expectedCostPercent) || 0);
  const minProjectedNetEdgePercent = Number(options.minProjectedNetEdgePercent) || 0;
  const minExpectancyPoints = Number(options.minExpectancyPoints) || 0;
  const minimumSamples = Math.max(18, Math.round(Number(options.minSamples) || 18));
  const usable = (Array.isArray(samples) ? samples : [])
    .filter((item) => Number.isFinite(Number(item?.r5)))
    .sort((left, right) =>
      String(left.entryDate || left.date || "").localeCompare(String(right.entryDate || right.date || ""))
    );

  if (usable.length < minimumSamples) {
    return {
      available: false,
      accepted: false,
      sampleCount: usable.length,
      minimumSamples,
      folds: [],
      foldPassRate: 0,
      positiveFoldRate: 0,
      oosSampleCount: 0,
      oosWinRate5: 0,
      oosExpectancy5: 0,
      oosProjectedNetEdge: 0,
      oosWorstMdd5: 0,
      degradationPercent: 100,
      overfitRisk: "insufficient",
      reason: `滚动样本外验证不足：${usable.length}/${minimumSamples}`
    };
  }

  const initialTrainSize = Math.max(9, Math.floor(usable.length * 0.5));
  const folds = [];
  let cursor = initialTrainSize;
  for (let index = 0; index < 3; index += 1) {
    const remaining = usable.length - cursor;
    const remainingFolds = 3 - index;
    const testSize = Math.max(1, Math.floor(remaining / remainingFolds));
    const end = index === 2 ? usable.length : Math.min(usable.length, cursor + testSize);
    const trainSamples = usable.slice(0, cursor);
    const testSamples = usable.slice(cursor, end);
    const train = summarizeWalkForwardSamples(trainSamples, expectedCostPercent);
    const test = summarizeWalkForwardSamples(testSamples, expectedCostPercent);
    const accepted =
      test.samples > 0 &&
      test.projectedNetEdge >= minProjectedNetEdgePercent &&
      test.expectancy5 >= minExpectancyPoints &&
      test.worstMdd5 > -22;
    folds.push({
      fold: index + 1,
      trainStart: trainSamples[0]?.entryDate || trainSamples[0]?.date || "",
      trainEnd: trainSamples.at(-1)?.entryDate || trainSamples.at(-1)?.date || "",
      testStart: testSamples[0]?.entryDate || testSamples[0]?.date || "",
      testEnd: testSamples.at(-1)?.entryDate || testSamples.at(-1)?.date || "",
      trainSamples: train.samples,
      testSamples: test.samples,
      trainProjectedNetEdge: Number(train.projectedNetEdge.toFixed(3)),
      oosProjectedNetEdge: Number(test.projectedNetEdge.toFixed(3)),
      oosWinRate5: Number(test.winRate5.toFixed(3)),
      oosWorstMdd5: Number(test.worstMdd5.toFixed(3)),
      accepted
    });
    cursor = end;
  }

  const training = summarizeWalkForwardSamples(usable.slice(0, initialTrainSize), expectedCostPercent);
  const outOfSample = summarizeWalkForwardSamples(usable.slice(initialTrainSize), expectedCostPercent);
  const passedFolds = folds.filter((item) => item.accepted).length;
  const positiveFolds = folds.filter((item) => item.oosProjectedNetEdge > 0).length;
  const foldPassRate = passedFolds / folds.length;
  const positiveFoldRate = positiveFolds / folds.length;
  const degradationPercent = training.projectedNetEdge > 0
    ? Math.max(
      0,
      ((training.projectedNetEdge - outOfSample.projectedNetEdge) /
        Math.max(Math.abs(training.projectedNetEdge), 0.01)) * 100
    )
    : outOfSample.projectedNetEdge < training.projectedNetEdge
      ? 100
      : 0;
  const overfitRisk =
    outOfSample.projectedNetEdge <= 0 || foldPassRate < 0.5 || degradationPercent > 70
      ? "high"
      : foldPassRate < 2 / 3 || degradationPercent > 40
        ? "medium"
        : "low";
  const accepted =
    outOfSample.samples >= 9 &&
    foldPassRate >= 2 / 3 &&
    positiveFoldRate >= 2 / 3 &&
    outOfSample.projectedNetEdge >= minProjectedNetEdgePercent &&
    outOfSample.expectancy5 >= minExpectancyPoints &&
    outOfSample.worstMdd5 > -22 &&
    overfitRisk !== "high";
  const reason = accepted
    ? `样本外通过：${passedFolds}/${folds.length} 个窗口，净边际 ${outOfSample.projectedNetEdge.toFixed(2)}%`
    : [
      foldPassRate >= 2 / 3 ? "" : `样本外窗口仅通过 ${passedFolds}/${folds.length}`,
      positiveFoldRate >= 2 / 3 ? "" : `正净边际窗口仅 ${positiveFolds}/${folds.length}`,
      outOfSample.projectedNetEdge >= minProjectedNetEdgePercent
        ? ""
        : `样本外净边际 ${outOfSample.projectedNetEdge.toFixed(2)}% 低于阈值`,
      outOfSample.expectancy5 >= minExpectancyPoints
        ? ""
        : `样本外期望 ${outOfSample.expectancy5.toFixed(2)} 低于阈值`,
      degradationPercent <= 70 ? "" : `训练至样本外退化 ${degradationPercent.toFixed(0)}%`,
      overfitRisk !== "high" ? "" : "过拟合风险高"
    ].filter(Boolean).join("；");

  return {
    available: true,
    accepted,
    sampleCount: usable.length,
    minimumSamples,
    trainingSamples: training.samples,
    oosSampleCount: outOfSample.samples,
    foldPassRate: Number(foldPassRate.toFixed(4)),
    positiveFoldRate: Number(positiveFoldRate.toFixed(4)),
    trainingProjectedNetEdge: Number(training.projectedNetEdge.toFixed(3)),
    oosWinRate5: Number(outOfSample.winRate5.toFixed(3)),
    oosExpectancy5: Number(outOfSample.expectancy5.toFixed(3)),
    oosProjectedNetEdge: Number(outOfSample.projectedNetEdge.toFixed(3)),
    oosWorstMdd5: Number(outOfSample.worstMdd5.toFixed(3)),
    degradationPercent: Number(degradationPercent.toFixed(2)),
    overfitRisk,
    reason,
    folds
  };
}

function calculateAtr(history, period = 14) {
  if (!Array.isArray(history) || history.length <= period) return null;
  const ranges = [];
  for (let index = Math.max(period, 1); index < history.length; index += 1) {
    const current = history[index];
    const previous = history[index - 1];
    if (!current || !previous) continue;
    const trueRange = Math.max(
      Number(current.high || 0) - Number(current.low || 0),
      Math.abs(Number(current.high || 0) - Number(previous.close || 0)),
      Math.abs(Number(current.low || 0) - Number(previous.close || 0))
    );
    if (Number.isFinite(trueRange)) ranges.push(trueRange);
  }
  if (!ranges.length) return null;
  const tail = ranges.slice(-period);
  return tail.length ? average(tail) : null;
}

function buildTradePlan(analysis, quote, history, settings) {
  const latest = Number(quote?.latest || quote?.close || 0);
  if (!latest || !analysis) return null;
  const atr = calculateAtr(history, 14);
  const atrMultipleStop = Math.max(1, Math.min(8, Number(settings?.stopLossATRMultiple) || 2));
  const atrMultipleTake = Math.max(1.2, Math.min(12, Number(settings?.takeProfitATRMultiple) || 3.2));
  const atrDistance = Number.isFinite(atr) && atr > 0
    ? atr
    : Math.abs((quote.open || latest) - (quote.preClose || latest)) || latest * 0.012;
  const stopLossDistance = atrDistance * atrMultipleStop;
  const targetDistance = atrDistance * atrMultipleTake;
  const stopLossPrice = roundPrice(latest - stopLossDistance);
  const takeProfitPrice = roundPrice(latest + targetDistance);
  const stopLossPercent = (stopLossDistance / latest) * 100;
  const takeProfitPercent = (targetDistance / latest) * 100;
  const riskDistancePercent = Math.max(0.5, stopLossPercent);
  const accountRiskPercent = Math.max(0.1, Math.min(20, Number(settings?.maxRiskPerTradePercent) || 1));
  const maxPositionPercent = Math.max(5, Math.min(90, Number(settings?.maxPositionPercent) || 28));
  const scoreRate = Math.max(0.2, Math.min(1, (analysis.mrs || 0) / 100));
  const historicalPass = Boolean(analysis.historicalEdge?.passed);
  const nodePenalty = analysis.exactNode ? 1 : 0.88;
  const historicalPenalty = historicalPass ? 1 : 0.7;
  const riskFactor = Math.max(0.1, 1 - ((analysis.riskPenalty || 0) / 120));
  const confidence = clamp(scoreRate * historicalPenalty * nodePenalty * riskFactor, 0.1, 1);
  const stopLossExposureRatio = accountRiskPercent / riskDistancePercent;
  const basePosition = clamp(stopLossExposureRatio * 100, 5, maxPositionPercent);
  const positionSizePercent = clamp(basePosition * confidence, 5, maxPositionPercent);
  const riskReward = Number(targetDistance / stopLossDistance);
  const maxLossBudgetPercent = clamp(
    positionSizePercent * riskDistancePercent / 100,
    0,
    accountRiskPercent
  );
  let signal = "WAIT";
  if (analysis.alertQualified && analysis.strategyQualified && historicalPass) {
    if (analysis.mrs >= 82 && riskReward >= 1.7) signal = "BUY_AGGRESSIVE";
    else if (analysis.mrs >= 70 && riskReward >= 1.2) signal = "BUY";
    else signal = "OBSERVE";
  }
  return {
    signal,
    entryPrice: roundPrice(latest),
    positionSizePercent: Number(positionSizePercent.toFixed(2)),
    maxPositionPercent,
    maxLossBudgetPercent: Number(maxLossBudgetPercent.toFixed(2)),
    stopLossPrice,
    takeProfitPrice,
    stopLossDistancePercent: Number(stopLossPercent.toFixed(2)),
    takeProfitDistancePercent: Number(takeProfitPercent.toFixed(2)),
    riskReward: Number.isFinite(riskReward) ? Number(riskReward.toFixed(2)) : null,
    atrDistance: Number(atrDistance.toFixed(4)),
    stopLossATRMultiple: atrMultipleStop,
    takeProfitATRMultiple: atrMultipleTake,
    maxHoldingBars: Math.max(5, Number(settings?.maxHoldingBars) || 30),
    confidence: Number((confidence * 100).toFixed(1)),
    lastUpdatedAt: new Date().toISOString()
  };
}

function movingAverage(history, days, endOffset = 0) {
  const end = history.length - endOffset;
  return average(history.slice(Math.max(0, end - days), end).map((x) => x.close));
}

// E-06：K 线不足 days+1 根、或基准价缺失/为 0 时是"算不出来"，返回 null。
// 旧实现返回 0，于是"数据不足"被当成"3 日涨幅 0%"，rsSector 也就变成"0% 超额"。
function returnFor(history, days) {
  if (!Array.isArray(history) || history.length <= days) return null;
  const latest = Number(history.at(-1)?.close);
  const base = Number(history.at(-(days + 1))?.close);
  if (!Number.isFinite(latest) || !Number.isFinite(base) || base === 0) return null;
  return ((latest / base) - 1) * 100;
}

function clampScore(value, min = 0, max = 100) {
  const score = Number(value);
  return Number.isFinite(score)
    ? Math.max(min, Math.min(max, Math.round(score)))
    : min;
}

function edgeGateFromStats(historicalStats, options = {}) {
  const combination = Array.isArray(historicalStats?.stats)
    ? historicalStats.stats.find((item) => item.id === "currentCombination")
    : null;
  const sampleCount = Number(combination?.sampleCount || 0);
  const winRate5 = Number.isFinite(Number(combination?.winRate5))
    ? Number(combination.winRate5)
    : null;
  const average5 = Number.isFinite(Number(combination?.average5))
    ? Number(combination.average5)
    : null;
  const worstMdd5 = Number.isFinite(Number(combination?.worstMdd5))
    ? Number(combination.worstMdd5)
    : null;
  const confidence = combination?.confidence || "不足";
  const minimumSamples = Math.max(
    12,
    Math.round(Number(options.minimumSamples) || 30)
  );
  const reasons = [];
  let penalty = 0;
  let passed = true;
  if (sampleCount < minimumSamples) {
    passed = false;
    penalty += 12;
    reasons.push(`历史独立样本不足（${sampleCount}/${minimumSamples} 条）`);
  } else {
    if (winRate5 !== null && winRate5 < 45) {
      passed = false;
      penalty += 14;
      reasons.push(`5日胜率不足（${winRate5.toFixed(1)}%，低于45%）`);
    }
    if (average5 !== null && average5 <= 0.3) {
      passed = false;
      penalty += 12;
      reasons.push(`5日平均收益偏弱（${average5.toFixed(2)}%）`);
    }
    if (worstMdd5 !== null && worstMdd5 < -22) {
      passed = false;
      penalty += 10;
      reasons.push(`历史最差5日回撤过大（${worstMdd5.toFixed(2)}%）`);
    }
    if (winRate5 !== null && average5 !== null && winRate5 >= 58 && average5 >= 0.8) {
      penalty = Math.max(0, penalty - 2);
    }
  }
  if (options.strictGate && sampleCount < Math.max(60, minimumSamples)) {
    passed = false;
    penalty += 4;
    reasons.push(`严格模式样本要求≥${Math.max(60, minimumSamples)}（当前 ${sampleCount}）`);
  }
  return {
    passed,
    sampleCount,
    winRate5,
    average5,
    worstMdd5,
    confidence,
    minimumSamples,
    penalty,
    reasons
  };
}

/** 同花顺指数不复权日线；当日K线由同花顺实时快照补齐。 */
async function thsIndexHistory(index, limit = 20, options = {}) {
  const bars = Math.max(8, Math.min(400, Number(limit) || 20));
  return serviceRuntime.cached(historyCache, `ths-index:${index.thsMarket}_${index.code}:${bars}`, 60 * 1000, async () => {
    const rows = await serviceRuntime.track(() => trackServiceRequest(
      thsFreeMarket.thsFreeDailyHistory(index, { limit: bars, fqt: 0, signal: serviceSignal() })
    ));
    if (rows.length < Math.min(bars, 2)) throw new Error(`同花顺${index.name}日线不足`);
    return rows.map((row) => ({ ...row }));
  }, options);
}

function thsAllAHistory(limit = 20, options = {}) {
  return thsIndexHistory(thsFreeMarket.THS_ALL_A, limit, options);
}

/** 全市场代理基准：同花顺全A为主；同花顺取不到时用东方财富中证全指应急，并如实标注。 */
async function marketProxyHistory(limit = 15, options = {}) {
  try {
    return { rows: await thsAllAHistory(limit, options), label: "同花顺全A" };
  } catch {
    serviceSignal()?.throwIfAborted();
    const rows = await eastHistoryCached({ code: "000985", secid: "1.000985" }, limit, 1, 5 * 60 * 1000, options).catch(() => []);
    return { rows, label: rows.length ? "中证全指" : "全A基准" };
  }
}

/** 沪深300：同花顺 hs_1B0300 为主，东方财富应急。 */
async function hs300History(limit = 15, options = {}) {
  try {
    return await thsIndexHistory(thsFreeMarket.THS_HS300, limit, options);
  } catch {
    serviceSignal()?.throwIfAborted();
    return eastHistoryCached({ code: "000300", secid: "1.000300" }, limit, 1, 5 * 60 * 1000, options);
  }
}

async function recentTradingDates(count = 10) {
  let benchmark;
  try {
    // 交易日历：同花顺全A为主；取不到时用东方财富沪深300应急。
    benchmark = await thsAllAHistory(Math.max(12, count + 8));
  } catch (error) {
    serviceSignal()?.throwIfAborted();
    benchmark = await eastHistoryCached(
      { code: "000300", secid: "1.000300" },
      Math.max(12, count + 8),
      0,
      20 * 60 * 1000
    );
  }
  return benchmark
    .slice(-count)
    .map((item) => item.date.replaceAll("-", ""))
    .reverse();
}

function displayDate(compactDate) {
  const value = String(compactDate || "").replaceAll("-", "");
  return value.length === 8
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : String(compactDate || "");
}

function todayInShanghai() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(new Date())
    .replace(/\D/g, "");
}

function selectLimitUpTradingDates(today, currentPool, benchmarkDates = [], count = 1) {
  const targetCount = Math.max(1, Math.min(20, Number(count) || 1));
  const todayDate = displayDate(today);
  const serverTradingDate = displayDate(currentPool?.serverTradingDate || "");
  const currentPoolDate = displayDate(currentPool?.date || "");
  const currentConfirmed = Boolean(
    currentPool &&
    currentPoolDate === todayDate &&
    (
      serverTradingDate === todayDate ||
      (!serverTradingDate && Array.isArray(currentPool.pool) && currentPool.pool.length > 0)
    )
  );
  const dates = [];
  if (currentConfirmed) dates.push(todayDate);
  for (const rawDate of benchmarkDates) {
    const date = displayDate(rawDate);
    if (!date || dates.includes(date)) continue;
    if (date === todayDate && !currentConfirmed) continue;
    dates.push(date);
    if (dates.length >= targetCount) break;
  }
  return dates.slice(0, targetCount);
}

function poolTimeRawFromEpoch(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date(seconds * 1000));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return Number(`${get("hour")}${get("minute")}${get("second")}`);
}

function thsLimitUpConsecutiveBoards(item = {}) {
  const text = String(item.high_days || "").trim();
  const consecutive = text.match(/^(\d+)\s*连板$/);
  if (consecutive) return Math.max(1, Number(consecutive[1]));
  const windowMatch = text.match(/(\d+)\s*天\s*(\d+)\s*板/);
  if (windowMatch && Number(windowMatch[1]) === Number(windowMatch[2])) {
    return Math.max(1, Number(windowMatch[2]));
  }
  if (windowMatch) return null;
  if (item.change_tag === "FIRST_LIMIT" || item.is_again_limit === false || item.is_again_limit === 0) return 1;
  return null;
}

function normalizeThsLimitUpItem(item = {}, date = "", dataProvider = "ths_public_limit_up") {
  const code = String(item.code || "");
  if (!isAStockCode(code)) return null;
  const latest = Number(item.latest || 0);
  const orderVolume = Number(item.order_volume || 0);
  const firstSealRaw = poolTimeRawFromEpoch(item.first_limit_up_time);
  const lastSealRaw = poolTimeRawFromEpoch(item.last_limit_up_time);
  const consecutiveBoards = thsLimitUpConsecutiveBoards(item);
  // 同花顺字段 19 返回为 turnover（成交额，元）；3541450/3475914 返回为 currency_value/sum_market_value。
  const amount = Number(item.amount ?? item.turnover ?? NaN);
  const floatMarketCap = Number(item.float_market_cap ?? item.currency_value ?? item.ltsz ?? NaN);
  const totalMarketCap = Number(item.total_market_cap ?? item.sum_market_value ?? item.tshare ?? NaN);
  const openBoardCount = item.open_board_count === null || item.open_board_count === undefined
    ? null
    : Number(item.open_board_count);
  // A2-04：封单额 = 最新价 × 封单量。任一缺失/非正 → 未知（null），绝不写 0：
  // 涨停股必然有封单队列，"0 元封单"不是一个可观测的真实值，只是"没拿到"。
  const sealedAmount =
    Number.isFinite(latest) && latest > 0 && Number.isFinite(orderVolume) && orderVolume > 0
      ? latest * orderVolume
      : null;
  const normalized = decorateLimitPoolItem(
    {
      c: code,
      n: String(item.name || code),
      m: /^(6|68)/.test(code) ? 1 : 0,
      p: latest ? Math.round(latest * 1000) : 0,
      zdp: Number(item.change_rate || 0),
      hs: Number(item.turnover_rate || 0),
      amount: Number.isFinite(amount) ? amount : 0,
      ltsz: Number.isFinite(floatMarketCap) ? floatMarketCap : 0,
      tshare: Number.isFinite(totalMarketCap) ? totalMarketCap : 0,
      fund: sealedAmount ?? 0,
      lbc: consecutiveBoards || 1,
      fbt: firstSealRaw,
      lbt: lastSealRaw,
      zbc: Number.isFinite(openBoardCount) ? openBoardCount : 0,
      hybk: String(item.industry || industryFromIndex(code) || "未分类"),
      zttj: {
        days: Number(String(item.high_days || "").match(/(\d+)\s*天/)?.[1] || 0),
        ct: Number(String(item.high_days || "").match(/(\d+)\s*板/)?.[1] || 0)
      },
      sourceItem: item
    },
    date
  );
  return {
    ...normalized,
    amount: Number.isFinite(amount) ? amount : null,
    floatMarketCap: Number.isFinite(floatMarketCap) ? floatMarketCap : null,
    totalMarketCap: Number.isFinite(totalMarketCap) ? totalMarketCap : null,
    // decorateLimitPoolItem 会把缺失的 fund 折成 0；这里按本模块口径覆盖回 null，
    // 并让封单占比同步变成 null（0% 会被读成"封单极弱"而不是"未知"）。
    sealedAmount,
    consecutiveBoards,
    firstSealTime: firstSealRaw ? normalized.firstSealTime : "",
    firstSealRaw: firstSealRaw || null,
    lastSealTime: lastSealRaw ? normalized.lastSealTime : "",
    lastSealRaw: lastSealRaw || null,
    openBoardCount: Number.isFinite(openBoardCount) ? openBoardCount : null,
    sealFloatRatio: Number.isFinite(floatMarketCap) && floatMarketCap > 0 && sealedAmount !== null
      ? sealedAmount / floatMarketCap
      : null,
    tradedFloatRatio: Number.isFinite(floatMarketCap) && floatMarketCap > 0 && Number.isFinite(amount)
      ? amount / floatMarketCap
      : null,
    industry: String(item.industry || industryFromIndex(code) || "未分类"),
    limitReason: String(item.reason_type || ""),
    boardType: String(item.limit_up_type || ""),
    dataProvider
  };
}

function mergeThsAndEastmoneyLimitPool(thsPool, eastmoneyPool) {
  const hasFiniteValue = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
  const thsRows = Array.isArray(thsPool?.pool) ? thsPool.pool : [];
  const eastRows = Array.isArray(eastmoneyPool?.pool) ? eastmoneyPool.pool : [];
  const eastByCode = new Map(eastRows.map((item) => [String(item.code || ""), item]));
  const mergedCodes = new Set();
  let enrichedCount = 0;
  const rows = thsRows.map((thsItem) => {
    const code = String(thsItem.code || "");
    mergedCodes.add(code);
    const eastItem = eastByCode.get(code);
    if (!eastItem) return thsItem;
    enrichedCount += 1;
    // A2-04：封单额只有"正数"才是有效观测。0 在两源里都只是缺失占位
    // （decorateLimitPoolItem / 上游专题池的 fund 兜底），而涨停股不可能没有封单，
    // 所以双源都拿不到时给 null，让下游封单占比显示"未知"而不是 0%。
    const thsSealedAmount = hasFiniteValue(thsItem.sealedAmount) && Number(thsItem.sealedAmount) > 0
      ? Number(thsItem.sealedAmount)
      : null;
    const eastSealedAmount = hasFiniteValue(eastItem.sealedAmount) && Number(eastItem.sealedAmount) > 0
      ? Number(eastItem.sealedAmount)
      : null;
    const sealedAmount = thsSealedAmount !== null ? thsSealedAmount : eastSealedAmount;
    const floatMarketCap = hasFiniteValue(eastItem.floatMarketCap) && Number(eastItem.floatMarketCap) > 0
      ? Number(eastItem.floatMarketCap)
      : thsItem.floatMarketCap;
    const amount = hasFiniteValue(eastItem.amount)
      ? Number(eastItem.amount)
      : thsItem.amount;
    return {
      ...thsItem,
      industry: String(eastItem.industry || thsItem.industry || "未分类"),
      amount,
      floatMarketCap,
      totalMarketCap: hasFiniteValue(eastItem.totalMarketCap)
        ? Number(eastItem.totalMarketCap)
        : thsItem.totalMarketCap,
      consecutiveBoards: hasFiniteValue(eastItem.consecutiveBoards)
        ? Number(eastItem.consecutiveBoards)
        : thsItem.consecutiveBoards,
      firstSealTime: eastItem.firstSealTime || thsItem.firstSealTime || "",
      firstSealRaw: eastItem.firstSealRaw || thsItem.firstSealRaw || null,
      lastSealTime: thsItem.lastSealTime || eastItem.lastSealTime || "",
      lastSealRaw: thsItem.lastSealRaw || eastItem.lastSealRaw || null,
      openBoardCount: hasFiniteValue(eastItem.openBoardCount)
        ? Number(eastItem.openBoardCount)
        : thsItem.openBoardCount,
      sealedAmount,
      sealFloatRatio: hasFiniteValue(floatMarketCap) && Number(floatMarketCap) > 0 && sealedAmount !== null
        ? sealedAmount / Number(floatMarketCap)
        : null,
      tradedFloatRatio:
        hasFiniteValue(floatMarketCap) && Number(floatMarketCap) > 0 && hasFiniteValue(amount)
          ? Number(amount) / Number(floatMarketCap)
          : null,
      dataProvider: "ths_public_limit_up",
      verificationProviders: ["eastmoney_topic_pool"]
    };
  });
  for (const eastItem of eastRows) {
    const code = String(eastItem.code || "");
    if (!code || mergedCodes.has(code)) continue;
    mergedCodes.add(code);
    rows.push({
      ...eastItem,
      dataProvider: "eastmoney_topic_pool",
      primaryProviderMissing: true
    });
  }
  // This function is only called after both requests completed successfully.
  // Keep the verifier visible even when it confirms an empty pool or has no
  // additional rows, so the UI never overstates a single-source result.
  const providers = ["ths_public_limit_up", "eastmoney_topic_pool"];
  return {
    ...thsPool,
    fetchedAt: [thsPool?.fetchedAt, eastmoneyPool?.fetchedAt]
      .filter(Boolean)
      .sort()
      .at(-1) || new Date().toISOString(),
    total: rows.length,
    providers,
    verificationProvider: providers.includes("eastmoney_topic_pool")
      ? "eastmoney_topic_pool"
      : "",
    enrichedCount,
    pool: rows
  };
}

const THS_POOL_ENDPOINT = Object.freeze({
  limit: { path: "limit_up_pool", provider: "ths_public_limit_up", label: "涨停" },
  failed: { path: "open_limit_pool", provider: "ths_public_open_limit", label: "炸板" }
});

async function thsTopicPoolForDate(compactDate, type = "limit") {
  const date = displayDate(compactDate);
  const endpoint = THS_POOL_ENDPOINT[type] || THS_POOL_ENDPOINT.limit;
  const fields = [
    "199112",
    "10",
    "9001",
    "330329",
    "330330",
    "330324",
    "330325",
    "133971",
    "1968584",
    "19",
    "3475914",
    "3541450"
  ].join(",");
  const pageSize = 200;
  const rows = [];
  let page = 1;
  let total = 0;
  do {
    const url =
      `https://data.10jqka.com.cn/dataapi/limit_up/${endpoint.path}` +
      `?page=${page}&limit=${pageSize}&field=${fields}` +
      "&filter=HS,GEM2STAR&order_field=330329&order_type=0" +
      `&date=${compactDate}`;
    const json = await fetchJson(
      url,
      {
        headers: {
          "Referer": "https://data.10jqka.com.cn/limit_up/continuousUp/"
        }
      },
      15000
    );
    if (Number(json?.status_code) !== 0 || !json?.data) {
      throw new Error(`同花顺${endpoint.label}池返回异常：${json?.status_msg || json?.status_code || "empty"}`);
    }
    if (json.data.date && String(json.data.date) !== compactDate) {
      // 盘前/休市时同花顺返回最近交易日的数据：不能当成请求日的池，按“该日尚无数据”处理，
      // 并像东方财富 qdate 一样带回来源最新交易日。
      if (!/^\d{8}$/.test(String(json.data.date)) || String(json.data.date) > compactDate) {
        throw new Error(`同花顺${endpoint.label}池返回日期 ${displayDate(json.data.date)} 与请求日期 ${date} 不一致`);
      }
      return { date, serverTradingDate: displayDate(json.data.date), dateConfirmed: false, ...(type === "failed" ? { dataAbsent: true } : {}),
        fetchedAt: new Date().toISOString(), total: 0, provider: endpoint.provider, pool: [] };
    }
    const items = Array.isArray(json.data.info) ? json.data.info : [];
    total = Number(json?.data?.page?.total || items.length || 0);
    rows.push(...items);
    page += 1;
  } while (rows.length < total && page <= 10);
  return {
    date,
    serverTradingDate: rows.length ? date : "",
    // 空池没有自带的交易日证据：与东方财富空炸板池同口径，交给交易日历确认。
    ...(type === "failed" && !rows.length ? { dateConfirmed: false, dataAbsent: true } : {}),
    fetchedAt: new Date().toISOString(),
    total,
    provider: endpoint.provider,
    pool: rows
      .map((item) => normalizeThsLimitUpItem(item, date, endpoint.provider))
      .filter((item) => item && isAStockCode(item.code) && !isRiskStockName(item.name))
  };
}

async function topicPoolForDate(date, type = "limit", options = {}) {
  const compactDate = String(date || "").replaceAll("-", "");
  // 同花顺为主源；只有调用方显式要东方财富（交叉核验/日期确认）时才直接走东方财富。
  const preferredProvider = options?.provider === "eastmoney" ? "eastmoney" : "ths";
  const fallbackEnabled = options?.fallbackEnabled !== false;
  const key = `${type}:${compactDate}:${preferredProvider}:${fallbackEnabled ? "fallback" : "strict"}`;
  const endpoint = type === "failed" ? "getTopicZBPool" : "getTopicZTPool";
  const url =
    `https://push2ex.eastmoney.com/${endpoint}` +
    "?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt" +
    `&Pageindex=0&pagesize=1000&sort=fbt:asc&date=${compactDate}`;
  const loadEastmoney = async () => {
    const json = await fetchJson(url, {}, 15000);
    if (!json || (json.rc !== undefined && Number(json.rc) !== 0)) throw new Error("东方财富专题池返回异常");
    if (type === "failed" && json.rc !== undefined && Number(json.rc) === 0 && json.data === null) {
      return { date: displayDate(compactDate), serverTradingDate: "", dateConfirmed: false, dataAbsent: true, fetchedAt: new Date().toISOString(), total: 0, provider: "eastmoney_topic_pool", pool: [] };
    }
    if (!json?.data || !Array.isArray(json.data.pool)) {
      throw new Error(`东方财富${type === "failed" ? "炸板" : "涨停"}池返回空数据`);
    }
    // qdate is the source's latest confirmed trading date. Keep the requested
    // date as the event date, but retain qdate for intraday/holiday detection.
    const actualDate = displayDate(compactDate);
    return {
      date: actualDate,
      serverTradingDate: displayDate(json?.data?.qdate || ""),
      fetchedAt: new Date().toISOString(),
      total: Number(json?.data?.tc || json?.data?.pool?.length || 0),
      provider: "eastmoney_topic_pool",
      pool: (json?.data?.pool || [])
        .map((item) => decorateLimitPoolItem(item, actualDate))
        .filter((item) => isAStockCode(item.code) && !isRiskStockName(item.name))
    };
  };
  const loadWithFallback = async (primary, fallback) => {
    try {
      return await primary();
    } catch (primaryError) {
      if (!fallbackEnabled || !fallback) throw primaryError;
      try {
        return await fallback();
      } catch (fallbackError) {
        if (fallbackError && typeof fallbackError === "object" && !fallbackError.cause) {
          fallbackError.cause = primaryError;
        }
        throw fallbackError;
      }
    }
  };
  const ttl = () => {
    return compactDate === todayInShanghai()
      ? type === "failed" ? 15000 : 12000
      : 24 * 60 * 60 * 1000;
  };
  const thsType = type === "failed" ? "failed" : type === "limit" ? "limit" : null;
  return serviceRuntime.cached(topicPoolCache, key, ttl, () => !thsType
    ? loadEastmoney()
    : preferredProvider === "ths"
      ? loadWithFallback(() => thsTopicPoolForDate(compactDate, thsType), loadEastmoney)
      : loadWithFallback(loadEastmoney, () => thsTopicPoolForDate(compactDate, thsType)), options);
}

function withSingleFlightCache(cache, ttlMs, loader, options = {}) {
  return serviceRuntime.cachedObject(cache, ttlMs, loader, { ...options, forceRefresh: options === true || options?.forceRefresh === true, maxBytes: cache === marketSnapshotCache ? 8 * 1024 * 1024 : 2 * 1024 * 1024 });
}

async function recentLimitUpPools(count = 1, options = {}) {
  const targetCount = Math.max(1, Math.min(20, Number(count) || 1));
  const today = todayInShanghai();
  let currentPool = null;
  let currentEastmoneyPool = null;
  let currentError = null;
  try {
    currentPool = await topicPoolForDate(today, "limit", options);
  } catch (error) {
    currentError = error;
  }
  let dateConfirmationPool = currentPool;
  if (currentPool && String(currentPool.provider || "").startsWith("ths") && !currentPool.serverTradingDate) {
    try {
      currentEastmoneyPool = await topicPoolForDate(today, "limit", {
        provider: "eastmoney",
        fallbackEnabled: false,
        forceRefresh: options?.forceRefresh === true
      });
      dateConfirmationPool = {
        ...currentPool,
        serverTradingDate: currentEastmoneyPool.serverTradingDate
      };
    } catch {
      // THS remains the data source; a non-empty THS pool can still confirm today.
    }
  }
  const benchmarkDates = await recentTradingDates(targetCount + 2);
  const dates = selectLimitUpTradingDates(today, dateConfirmationPool, benchmarkDates, targetCount);
  if (!dates.length && currentError) throw currentError;
  const pools = await Promise.all(dates.map((date) => {
    if (currentPool && displayDate(currentPool.date) === date) return currentPool;
    return topicPoolForDate(date, "limit", {
      ...options,
      forceRefresh: false
    });
  }));
  const shouldCrossCheck = options?.multiSourceEnabled !== false || options?.fallbackEnabled !== false;
  if (!shouldCrossCheck) return pools;
  return Promise.all(pools.map(async (pool) => {
    if (pool?.provider !== "ths_public_limit_up") return pool;
    try {
      const eastmoneyPool = currentEastmoneyPool && displayDate(currentEastmoneyPool.date) === displayDate(pool.date)
        ? currentEastmoneyPool
        : await topicPoolForDate(pool.date, "limit", {
            provider: "eastmoney",
            fallbackEnabled: false,
            forceRefresh: options?.forceRefresh === true && displayDate(pool.date) === displayDate(today)
          });
      return mergeThsAndEastmoneyLimitPool(pool, eastmoneyPool);
    } catch {
      return {
        ...pool,
        providers: ["ths_public_limit_up"]
      };
    }
  }));
}

async function currentLadderPools(options = {}) {
  const cacheKey = [
    options?.provider === "ths" ? "ths" : "eastmoney",
    options?.fallbackEnabled === false ? "strict" : "fallback",
    options?.multiSourceEnabled === false ? "single" : "cross"
  ].join(":");
  return serviceRuntime.cached(ladderPoolsCaches, cacheKey, 15 * 1000, async () => {
    const pools = await recentLimitUpPools(2, options);
    const current = pools[0] || { date: "", pool: [] };
    const previous = pools[1] && pools[1].date !== current.date ? pools[1] : { date: "", pool: [] };
    let failed = null;
    let failedPoolError = "";
    try {
      failed = await topicPoolForDate(current.date, "failed", options);
      if (failed.dataAbsent) {
        failed = current.serverTradingDate && current.serverTradingDate >= current.date
          ? { ...failed, serverTradingDate: current.serverTradingDate, dateConfirmed: true, dateConfirmationProvider: current.provider }
          : null;
        if (!failed) failedPoolError = "炸板池为空且来源交易日尚未确认";
      }
    } catch (error) {
      failedPoolError = error instanceof Error ? error.message : String(error);
    }
    return {
      currentPool: current.pool,
      previousPool: previous.pool,
      failedPool: failed ? failed.pool : null,
      failedPoolAvailable: Boolean(failed),
      failedPoolError,
      currentDate: current.date,
      previousDate: previous.date
    };
  }, options);
}

// 个股 → 同花顺行业：同花顺涨停/炸板池不带行业，用同花顺行业板块完整成分反查（扶摇接口），本机保存、每天重建。
const { createStockIndustryIndex } = require("./stock-industry-index.cjs");
let stockIndustryIndex = createStockIndustryIndexWith(null);
function createStockIndustryIndexWith(store) {
  return createStockIndustryIndex({
    store,
    listIndustries: ({ signal, track } = {}) => thsOfficial.fetchThsFundFlow(
      fetchWithPolicy, "industry", { maxPages: 3, timeoutMs: 8000, signal, track }),
    loadMembers: (thscode, { signal, track } = {}) => {
      if (!fuyao.configured()) return Promise.resolve([]);
      const client = createFuyaoClient({ getApiKey: () => fuyaoApiKeyProvider(),
        fetchJson: (...args) => track(() => fetchJsonWithPolicy(...args)) });
      return client.constituents(thscode, { signal });
    }
  });
}
/** 同花顺池行业补齐：只查本机索引（不联网）；索引过期时在后台重建，不阻塞当前请求。 */
function industryFromIndex(code) {
  if (fuyao.configured()) void stockIndustryIndex.ensure().catch(() => null);
  return stockIndustryIndex.lookup(code) || knownIndustry({ code });
}
function configureStockIndustryStore(store) {
  stockIndustryIndex = createStockIndustryIndexWith(store);
}

/**
 * 按代码补行业：先查同花顺行业索引（首次建索引最多等 8 秒，没建好就在后台继续，下次刷新补上），
 * 再查行情里记住的行业，最后用东方财富同日涨停/炸板池的行业字段兜底。
 */
async function resolveStockIndustries(codes, { dates = [], signal } = {}) {
  signal = serviceSignal(signal);
  signal.throwIfAborted();
  const result = new Map();
  const wanted = [...new Set((codes || []).map(String).filter(code => /^\d{6}$/.test(code)))];
  if (!wanted.length) return result;
  if (fuyao.configured()) {
    let timer;
    await Promise.race([
      serviceRuntime.track(() => stockIndustryIndex.ensure({ signal })).catch(() => { signal.throwIfAborted(); return null; }),
      new Promise(resolve => { timer = setTimeout(resolve, 8000); timer.unref?.(); })
    ]);
    clearTimeout(timer);
  }
  signal.throwIfAborted();
  for (const code of wanted) {
    const industry = stockIndustryIndex.lookup(code) || knownIndustry({ code });
    if (industry && industry !== "未分类") result.set(code, industry);
  }
  let missing = wanted.filter(code => !result.has(code));
  for (const date of dates.slice(0, 3)) {
    if (!missing.length || marketSourceHealth.isOpen("eastmoney")) break;
    for (const type of ["failed", "limit"]) {
      try {
        const pool = await topicPoolForDate(date, type, { provider: "eastmoney", fallbackEnabled: false });
        for (const item of Array.isArray(pool?.pool) ? pool.pool : []) {
          const code = String(item?.code || ""), industry = String(item?.industry || "").trim();
          if (missing.includes(code) && industry && industry !== "未分类") { result.set(code, industry); rememberIndustry({ code, industry }); }
        }
      } catch { /* 东方财富不可用时保留未分类 */ }
      missing = wanted.filter(code => !result.has(code));
      if (!missing.length) break;
    }
  }
  return result;
}

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

const THS_UP_DOWN_URL = "https://dq.10jqka.com.cn/fuyao/up_down_distribution/distribution/v2/realtime";

/** 同花顺涨跌分布（沪深京全部A股，实时）+ 同花顺全A涨跌幅。 */
async function thsWholeMarketSnapshot() {
  const [json, allMarketQuote] = await Promise.all([
    fetchJson(THS_UP_DOWN_URL, { headers: { Referer: "https://q.10jqka.com.cn/" } }, 10000),
    thsFreeMarket.thsFreeQuote(thsFreeMarket.THS_ALL_A, { signal: serviceSignal() }).catch(() => null)
  ]);
  const data = json?.data;
  if (Number(json?.status_code) !== 0 || !data) throw new Error(`同花顺涨跌分布返回异常：${json?.status_msg || json?.status_code || "empty"}`);
  const count = (value) => {
    const parsed = finiteOrNull(value);
    if (parsed === null || parsed < 0 || !Number.isInteger(parsed)) throw new Error("同花顺涨跌分布家数缺失或无效");
    return parsed;
  };
  const upCount = count(data.up);
  const downCount = count(data.down);
  const flatCount = count(data.flat);
  const suspended = finiteOrNull(data.suspend);
  const validCount = upCount + downCount + flatCount;
  // 全市场 5000+ 只；明显偏少说明返回的是残缺数据，交给应急源。
  if (validCount < 1000) throw new Error(`同花顺涨跌分布家数异常（${validCount}）`);
  const indexChangePct = finiteOrNull(allMarketQuote?.changePct);
  return {
    stockCount: validCount,
    listedCount: validCount + (suspended && suspended > 0 ? suspended : 0),
    unavailableCount: suspended && suspended > 0 ? suspended : 0,
    available: true,
    upCount,
    downCount,
    flatCount,
    breadth: upCount / validCount,
    averageReturn: indexChangePct,
    indexReturn: indexChangePct,
    pagesSampled: 1,
    source: "ths_up_down_distribution",
    sourceLabel: "同花顺涨跌分布（沪深京）",
    benchmarkLabel: indexChangePct === null ? "" : "同花顺全A(沪深京)",
    sourceUpdatedAt: String(data.last_update_time || ""),
    fetchedAt: new Date().toISOString()
  };
}

async function wholeMarketSnapshot(options = {}) {
  return withSingleFlightCache(marketSnapshotCache, 45 * 1000, async () => {
  try {
    return await thsWholeMarketSnapshot();
  } catch (error) {
    serviceSignal()?.throwIfAborted();
    if (options?.fallbackEnabled === false) throw error;
  }
  // 应急：东方财富全市场列表按涨跌幅二分计数 + 中证全指。
  const pageSize = 100;
  const pages = new Map();
  const fetchPage = async (page) => {
    if (pages.has(page)) return pages.get(page);
    const url =
      `${EAST_QUOTE}/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2` +
      "&ut=bd1d9ddb04089700cf9c27f6f7426281" +
      "&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23" +
      "&fid=f3&fields=f3,f12,f14";
    const json = await fetchJson(url, {}, 15000);
    const value = {
      total: Number(json?.data?.total || 0),
      rows: Array.isArray(json?.data?.diff) ? json.data.diff : []
    };
    pages.set(page, value);
    return value;
  };
  const firstPage = await fetchPage(1);
  const total = firstPage.total;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const countPrefix = async (inclusive) => {
    let low = 1;
    let high = pageCount;
    let best = 0;
    while (low <= high) {
      const page = Math.floor((low + high) / 2);
      const { rows } = await fetchPage(page);
      if (!rows.length) {
        high = page - 1;
        continue;
      }
      const qualifies = (value) => { const n = finiteOrNull(value); return n !== null && (inclusive === "valid" || (inclusive ? n >= 0 : n > 0)); };
      const firstQualifies = qualifies(rows[0].f3);
      const lastQualifies = qualifies(rows.at(-1).f3);
      if (!firstQualifies) {
        high = page - 1;
      } else if (lastQualifies) {
        best = Math.min(total, page * pageSize);
        low = page + 1;
      } else {
        best = (page - 1) * pageSize + rows.filter((item) => qualifies(item.f3)).length;
        break;
      }
    }
    return best;
  };
  const [upCount, nonNegativeCount, validCount, allMarketQuote] = await Promise.all([
    countPrefix(false),
    countPrefix(true),
    countPrefix("valid"),
    eastQuote({ code: "000985", secid: "1.000985", thscode: "000985.SH" }).catch(() => null)
  ]);
  const flatCount = Math.max(0, nonNegativeCount - upCount);
  const downCount = Math.max(0, validCount - nonNegativeCount);
  // A2-03：中证全指取不到（或命中 E-01 的 f43=0）时是"没有这个观测值"，不是"平盘 0%"。
  // 旧实现用 `Number(... || 0)` 把它写成 0，而同一结构里的 breadth 却诚实地用 null；
  // 该值经 sectorStrength({ marketAverageReturn }) 参与 relativeReturn = 个股收益 − 市场收益，
  // 0% 会被当成"市场真的没动"。现在与 breadth 同口径：未知 → null。
  const indexChangePct = finiteOrNull(allMarketQuote?.changePct);
  const value = {
    stockCount: validCount,
    listedCount: total,
    unavailableCount: Math.max(0, total - validCount),
    available: validCount > 0,
    upCount,
    downCount,
    flatCount,
    breadth: validCount ? upCount / validCount : null,
    averageReturn: indexChangePct,
    indexReturn: indexChangePct,
    pagesSampled: pages.size,
    source: "eastmoney_clist",
    sourceLabel: "东方财富全市场列表（同花顺不可用时应急）",
    benchmarkLabel: indexChangePct === null ? "" : "中证全指",
    fetchedAt: new Date().toISOString()
  };
  return value;
  }, options);
}

function emotionFromCounts({ currentDate, limitUpCount, limitDownCount, previousLimitUpCount, indexReturn, source }) {
  // E-06：基准 K 线不足 / 基准价异常时 indexReturn 为 null（"未知"）。
  // 情绪分里这一项按 0 分处理（不假装"涨了"也不惩罚），但对外 indexReturn 保持 null。
  const indexReturnContribution = indexReturn === null ? 0 : indexReturn * 4;
  const spreadScore = Math.max(-20, Math.min(25, (limitUpCount - limitDownCount) * 0.24));
  const trendScore = Math.max(-12, Math.min(15, (limitUpCount - previousLimitUpCount) * 0.15));
  const score = Math.round(Math.max(0, Math.min(100, 45 + spreadScore + trendScore + indexReturnContribution)));
  return {
    date: `${currentDate.slice(0, 4)}-${currentDate.slice(4, 6)}-${currentDate.slice(6, 8)}`,
    limitUpCount,
    limitDownCount,
    previousLimitUpCount,
    limitDownRatio: limitUpCount ? limitDownCount / limitUpCount : 1,
    indexReturn,
    score,
    state: score >= 75 ? "情绪强势" : score >= 60 ? "情绪回暖" : score >= 45 ? "情绪中性" : "情绪退潮",
    source
  };
}

/** 同花顺涨停池统计：当日涨停/跌停家数与上一交易日涨停家数一次取回；指数涨跌用同花顺全A。 */
async function thsMarketEmotion(options = {}) {
  const benchmark = await thsAllAHistory(8, options);
  const currentDate = benchmark.at(-1).date.replaceAll("-", "");
  const url = "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool" +
    `?page=1&limit=1&field=199112&filter=HS,GEM2STAR&order_field=199112&order_type=0&date=${currentDate}`;
  const json = await fetchJson(url, { headers: { Referer: "https://data.10jqka.com.cn/limit_up/continuousUp/" } }, 10000);
  const data = json?.data;
  if (Number(json?.status_code) !== 0 || !data) throw new Error(`同花顺涨停统计返回异常：${json?.status_msg || json?.status_code || "empty"}`);
  if (String(data.date || "") !== currentDate) throw new Error("同花顺涨停统计日期与最近交易日不一致");
  const count = (value, label) => {
    const parsed = finiteOrNull(value);
    if (parsed === null || parsed < 0) throw new Error(`同花顺涨停统计缺少${label}`);
    return parsed;
  };
  return emotionFromCounts({
    currentDate,
    limitUpCount: count(data.limit_up_count?.today?.num, "涨停家数"),
    limitDownCount: count(data.limit_down_count?.today?.num, "跌停家数"),
    previousLimitUpCount: count(data.limit_up_count?.yesterday?.num, "昨日涨停家数"),
    indexReturn: returnFor(benchmark, 1),
    source: "ths_limit_up_statistics"
  });
}

async function marketEmotionSnapshot(options = {}) {
  return withSingleFlightCache(marketEmotionCache, 45 * 1000, async () => {
  try {
    return await thsMarketEmotion(options);
  } catch (error) {
    serviceSignal()?.throwIfAborted();
    if (options?.fallbackEnabled === false) throw error;
  }
  // 应急：东方财富涨停/跌停专题池 + 中证全指。
  const benchmark = await eastHistoryCached(
    { code: "000985", secid: "1.000985" },
    8,
    1,
    2 * 60 * 1000,
    options
  );
  const dates = benchmark.slice(-2).map((item) => item.date.replaceAll("-", "")).reverse();
  const currentDate = dates[0];
  const previousDate = dates[1] || currentDate;
  const poolUrl = (type, date) =>
    `https://push2ex.eastmoney.com/${type}` +
    "?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt" +
    `&Pageindex=0&pagesize=1000&sort=fbt:asc&date=${date}`;
  const [limitUpJson, limitDownJson, previousLimitUpJson] = await Promise.all([
    fetchJson(poolUrl("getTopicZTPool", currentDate), {}, 10000),
    fetchJson(poolUrl("getTopicDTPool", currentDate), {}, 10000),
    fetchJson(poolUrl("getTopicZTPool", previousDate), {}, 10000)
  ]);
  const poolCount = json => {
    if (!Array.isArray(json?.data?.pool)) throw new Error("涨跌停情绪池缺少已确认记录");
    return json.data.pool.filter(item => isAStockCode(String(item.c || item.code || "")) && !isRiskStockName(item.n || item.name || "")).length;
  };
  const limitUpCount = poolCount(limitUpJson);
  const limitDownCount = poolCount(limitDownJson);
  const previousLimitUpCount = poolCount(previousLimitUpJson);
  return emotionFromCounts({ currentDate, limitUpCount, limitDownCount, previousLimitUpCount,
    indexReturn: returnFor(benchmark, 1), source: "eastmoney_topic_pool" });
  }, options);
}

function analyzeHistory(
  security,
  quote,
  history,
  sector,
  marketEmotion = null,
  benchmarkHistory = [],
  eventHistory = history
) {
  if (history.length < 21) throw new Error("历史行情不足，无法计算指标");
  const latest = history.at(-1);
  const events = [];
  const rawByDate = new Map((eventHistory || []).map((row, index) => [row.date, { row, previous: eventHistory[index - 1] }]));
  const recentWindowStart = Math.max(1, history.length - 60);
  for (let i = recentWindowStart; i < history.length; i += 1) {
    const day = history[i];
    const raw = rawByDate.get(day.date);
    if (!raw?.previous) continue;
    const rate = priceLimitRate(security.code, quote.name, day.date, raw.row.isST);
    const rawTarget = upperLimitPrice(raw.previous.close, raw.row, security.code, quote.name);
    if (rawTarget !== null && isLimitUpBar(raw.previous.close, raw.row, security.code, quote.name)) {
      const factor = Number(day.close) / Number(raw.row.close);
      events.push({ ...day, index: i, target: rawTarget * factor, rawClose: raw.row.close, rawTarget, rate });
    }
  }
  const limitEvent = events.at(-1) || null;
  const daysSince = limitEvent ? history.length - 1 - limitEvent.index : null;
  const since = limitEvent ? history.slice(limitEvent.index) : history.slice(-10);
  const supportLow = limitEvent?.low || 0;
  const minLow = Math.min(...since.map((x) => x.low));
  const heldSupport = limitEvent ? minLow >= supportLow - 0.001 : false;
  const supportDistance = limitEvent
    ? ((latest.close - supportLow) / supportLow) * 100
    : 0;
  const avwapRows = since.map(row => {
    const raw = rawByDate.get(row.date)?.row;
    const factor = raw && Number(raw.close) > 0 ? Number(row.close) / Number(raw.close) : null;
    // 复权一致：价格用前复权，成交量换算成复权股数（不复权量 ÷ 复权因子），成交额保持实际金额；
    // 这样跨除权日累计时每天的权重正确（以前用不复权量配复权额，除权前的成交量权重被压缩）。
    const usable = factor !== null && Number.isFinite(factor) && factor > 0 && raw.amount !== null && raw.amount !== undefined && Number(raw.volume) > 0;
    return { ...row, amount: usable ? Number(raw.amount) : null, volume: usable ? Number(raw.volume) / factor : null, volumeUnit: raw?.volumeUnit || "lots" };
  });
  const avwap = anchoredVwap(avwapRows);
  const ma5 = movingAverage(history, 5);
  const ma10 = movingAverage(history, 10);
  const ma20 = movingAverage(history, 20);
  const ma60 = movingAverage(history, 60);
  const priorMa5 = movingAverage(history, 5, 1);
  const priorMa10 = movingAverage(history, 10, 1);
  const priorMa20 = movingAverage(history, 20, 1);
  const maBull = ma5 > ma10 && ma10 > ma20;
  const slopesUp = ma5 > priorMa5 && ma10 > priorMa10 && ma20 > priorMa20;
  const divergence = ma20 ? ((ma5 - ma20) / ma20) * 100 : 0;
  // 量比按复权股数比较：近 5 日内有送转时，除权前的成交量换算到现在的股本，避免股本扩大被当成放量。
  const comparableVolume = (row) => {
    const raw = rawByDate?.get?.(row.date)?.row;
    const factor = raw && Number(raw.close) > 0 ? Number(row.close) / Number(raw.close) : null;
    return factor && Number.isFinite(factor) && factor > 0 && Number(raw.volume) > 0 ? Number(raw.volume) / factor : row.volume;
  };
  const avgVol5 = average(history.slice(-6, -1).map(comparableVolume));
  const volumeRatio = avgVol5 ? comparableVolume(latest) / avgVol5 : 0;
  const avgTurn20 = average(history.slice(-21, -1).map((x) => x.turnover));
  const relativeTurnover = avgTurn20 ? latest.turnover / avgTurn20 : 0;
  const maxDrawdown = limitEvent
    ? ((limitEvent.close - minLow) / limitEvent.close) * 100
    : 0;
  const closePosition =
    latest.high === latest.low
      ? 1
      : (latest.close - latest.low) / (latest.high - latest.low);
  const stockReturn3 = returnFor(history, 3);
  // E-06：3 日收益算不出来时，相对板块强弱同样是未知。
  // 旧实现 null - 0 = 0，会让 sector 条件把"未知"读成"恰好 0% 超额"。
  const rsSector =
    stockReturn3 === null ? null : stockReturn3 - (sector?.returns?.r3 || 0);
  const eventCount60 = events.length;
  const preLimitStart = limitEvent ? Math.max(0, limitEvent.index - 20) : 0;
  const preLimitEnd = limitEvent ? Math.max(0, limitEvent.index - 1) : 0;
  const preLimitReturn20 =
    limitEvent && history[preLimitStart]?.close
      ? ((history[preLimitEnd].close / history[preLimitStart].close) - 1) * 100
      : 0;
  const consolidation = limitEvent ? history.slice(limitEvent.index + 1, -1).slice(-8) : [];
  const platformHigh = consolidation.length
    ? Math.max(...consolidation.map((item) => item.high))
    : 0;
  const platformLow = consolidation.length
    ? Math.min(...consolidation.map((item) => item.low))
    : 0;
  const platformRange = platformLow ? ((platformHigh - platformLow) / platformLow) * 100 : 0;
  const previousDay = history.at(-2);
  const reclaimedSupport = Boolean(
    limitEvent && latest.low < supportLow && latest.close >= supportLow
  );
  const lowOpenRecovery = Boolean(
    previousDay &&
      latest.open < previousDay.close &&
      latest.close > previousDay.close &&
      closePosition >= 0.7
  );
  const isLowFirstBoard = Boolean(
    limitEvent && eventCount60 === 1 && preLimitReturn20 <= 15 && preLimitReturn20 >= -25
  );
  const secondBreakout = Boolean(
    limitEvent &&
      daysSince >= 3 &&
      daysSince <= 9 &&
      consolidation.length >= 2 &&
      platformRange <= 12 &&
      latest.close > platformHigh &&
      volumeRatio >= 1.1 &&
      volumeRatio <= 2.2 &&
      heldSupport
  );
  const weakToStrong = Boolean(
    (reclaimedSupport || lowOpenRecovery) && closePosition >= 0.7 && volumeRatio <= 1.8
  );
  const patternStrategies = limitEvent
    ? computePatternStrategies(history, limitEvent.index, history.length - 1)
    : {
        originBreakout: false,
        vcpCompression: false,
        chipLock: false
      };
  const sectorRankIndex = sector?.constituents?.findIndex(
    (item) => String(item.code) === String(security.code)
  );
  const sectorRank = Number.isInteger(sectorRankIndex) && sectorRankIndex >= 0
    ? sectorRankIndex + 1
    : null;
  const leaderCutoff = Math.max(3, Math.ceil((sector?.memberCount || 20) * 0.15));
  const sectorLeader = Boolean(
    (sector?.score || 0) >= 65 &&
      rsSector !== null &&
      rsSector >= 0 &&
      (sectorRank ? sectorRank <= leaderCutoff : rsSector >= 2)
  );
  const nodes = [3, 5, 7, 9];
  const exactNode = nodes.includes(daysSince) ? `T+${daysSince}` : null;
  const nextNode =
    daysSince === null
      ? null
      : nodes.find((n) => n > daysSince) || (daysSince > 9 ? "已过观察窗" : `T+${nodes.at(-1)}`);

  let structureScore = 0;
  if (limitEvent) {
    structureScore += heldSupport ? 22 : Math.max(0, 10 + supportDistance * 2);
    structureScore += latest.close >= avwap ? 12 : 3;
    structureScore += maBull ? 12 : ma5 > ma10 ? 7 : 2;
    structureScore += slopesUp ? 8 : 2;
    structureScore += volumeRatio < 0.8 ? 10 : volumeRatio < 1.5 ? 7 : volumeRatio < 2 ? 3 : 0;
    structureScore += relativeTurnover < 1.5 ? 8 : relativeTurnover < 2 ? 3 : 0;
    structureScore += maxDrawdown < 5 ? 8 : maxDrawdown < 10 ? 5 : maxDrawdown < 15 ? 2 : 0;
    structureScore += closePosition > 0.75 ? 6 : closePosition > 0.5 ? 4 : 1;
    structureScore += rsSector === null ? 0 : rsSector > 2 ? 7 : rsSector > 0 ? 4 : 0;
    structureScore += divergence >= 0 && divergence <= 8 ? 7 : divergence > 8 ? 3 : 0;
  } else {
    // ma5 为 null（K 线不足 5 根）时不能参与比较：null 会被隐式转成 0，
    // 让"收盘价在 MA5 上方"恒真并白拿 20 分。
    structureScore = (maBull ? 35 : 10) + (slopesUp ? 25 : 5) +
      (ma5 !== null && latest.close > ma5 ? 20 : 0);
  }
  structureScore = Math.round(Math.min(100, structureScore));
  const sectorScore = sector?.score ?? 50;
  const sectorLadderScore = sector?.ladder?.score ?? 0;
  const infoScore = 50;
  const marketScore = marketEmotion?.score ?? 55;
  const nodeScore = exactNode ? 85 : daysSince !== null && daysSince <= 9 ? 65 : 35;
  let riskPenalty = 0;
  const risks = [];
  if (limitEvent && !heldSupport) {
    riskPenalty += 20;
    risks.push("已跌破涨停日最低价");
  }
  if (avwap && latest.close < avwap) {
    riskPenalty += 8;
    risks.push("价格位于涨停锚定均价下方");
  }
  if (volumeRatio > 2) {
    riskPenalty += 8;
    risks.push("成交量显著放大");
  }
  if (divergence > 10) {
    riskPenalty += 6;
    risks.push("均线乖离偏热");
  }
  const mrs = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        structureScore * 0.35 +
          sectorScore * 0.3 +
          infoScore * 0.2 +
          marketScore * 0.1 +
          nodeScore * 0.05 -
          riskPenalty
      )
    )
  );
  const grade = mrs >= 85 ? "S" : mrs >= 75 ? "A" : mrs >= 60 ? "B" : "C";
  return {
    limitEvent,
    daysSince,
    exactNode,
    nextNode: typeof nextNode === "number" ? `T+${nextNode}` : nextNode,
    heldSupport,
    supportDistance,
    avwap,
    ma5,
    ma10,
    ma20,
    ma60,
    maBull,
    slopesUp,
    divergence,
    volumeRatio,
    relativeTurnover,
    maxDrawdown,
    closePosition,
    stockReturn3,
    rsSector,
    eventCount60,
    preLimitReturn20,
    isLowFirstBoard,
    platformHigh,
    platformRange,
    secondBreakout,
    reclaimedSupport,
    lowOpenRecovery,
    weakToStrong,
    ...patternStrategies,
    benchmarkAvailable: Array.isArray(benchmarkHistory) && benchmarkHistory.length > 0,
    sectorRank,
    sectorLeader,
    structureScore,
    sectorScore,
    sectorLadderScore,
    infoScore,
    marketScore,
    marketEmotion,
    nodeScore,
    riskPenalty,
    risks,
    mrs,
    grade,
    trendLabel: maBull && slopesUp ? "多头发散" : maBull ? "多头排列" : ma5 > ma10 ? "趋势形成中" : "震荡/偏弱"
  };
}

// E-06：相对板块收益可以是 null（3 日样本不足）。展示层必须能表示"未知"，
// 旧代码直接 analysis.rsSector.toFixed(2) 在 null 上会抛 TypeError。
function relativeSectorText(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : "未知";
}

function strategyDefinitionsFor(analysis, quote) {
  const priceAvailable = Number.isFinite(quote.latest) && quote.latest > 0 && !quote.missingFields?.includes("latest");
  const aboveAvwap = Boolean(priceAvailable && analysis.avwap && quote.latest >= analysis.avwap);
  const emotion = analysis.marketEmotion;
  const marketEmotionMatched = Boolean(
    emotion && emotion.score >= 60 && emotion.limitDownRatio <= 0.35
  );
  const hardRiskReasons = [];
  if (priceAvailable && analysis.limitEvent && quote.latest < analysis.limitEvent.low) {
    hardRiskReasons.push("收盘跌破涨停低点");
  }
  if (analysis.volumeRatio > 2) hardRiskReasons.push("成交量超过2倍");
  if (analysis.divergence > 10) hardRiskReasons.push("均线乖离过热");
  if (priceAvailable && analysis.avwap && quote.latest < analysis.avwap && analysis.volumeRatio > 1.3) {
    hardRiskReasons.push("放量跌破AVWAP");
  }
  if (analysis.closePosition < 0.25 && analysis.volumeRatio > 1.5) {
    hardRiskReasons.push("放量弱收盘");
  }
  if (analysis.marketEmotion?.score < 45 || analysis.marketEmotion?.limitDownRatio > 0.55) {
    hardRiskReasons.push("市场情绪转弱，不适合新增仓位");
  }
  if (
    Number.isFinite(analysis.relativeTurnover) &&
    analysis.relativeTurnover >= 2.8 &&
    analysis.volumeRatio >= 1.8 &&
    Number.isFinite(analysis.stockReturn3) &&
    analysis.stockReturn3 < -1.5
  ) {
    hardRiskReasons.push("下跌时换手失衡，成交放大且承压");
  }
  if (analysis.infoRiskSeverity >= 3) {
    hardRiskReasons.push("存在高可信重大风险公告");
  }
  return [
    {
      id: "support",
      label: "涨停低点防守",
      matched: analysis.heldSupport,
      detail: analysis.heldSupport ? "未跌破涨停日最低价" : "已跌破涨停日最低价"
    },
    {
      id: "avwap",
      label: "锚定均价承接",
      matched: aboveAvwap,
      detail: aboveAvwap ? "价格位于涨停 AVWAP 上方" : "价格位于涨停 AVWAP 下方"
    },
    {
      id: "trend",
      label: "均线多头发散",
      matched: analysis.maBull && analysis.slopesUp,
      detail: analysis.trendLabel
    },
    {
      id: "contraction",
      label: "缩量抗跌",
      matched: analysis.volumeRatio < 1 && analysis.relativeTurnover < 1.5,
      detail: `量能 ${analysis.volumeRatio.toFixed(2)}x / 相对换手 ${analysis.relativeTurnover.toFixed(2)}x`
    },
    {
      id: "sector",
      label: "强板块共振",
      // rsSector 为 null 时 null >= 0 会隐式成立，必须显式要求是有限数。
      matched: analysis.sectorScore >= 65 && Number.isFinite(analysis.rsSector) && analysis.rsSector >= 0,
      detail: `板块 ${analysis.sectorScore} 分 / 相对板块 ${relativeSectorText(analysis.rsSector)}`
    },
    {
      id: "volatility",
      label: "回撤与收盘质量",
      matched: analysis.maxDrawdown < 10 && analysis.closePosition > 0.55,
      detail: `最大回撤 ${analysis.maxDrawdown.toFixed(2)}% / 收盘位置 ${(analysis.closePosition * 100).toFixed(0)}%`
    },
    {
      id: "originBreakout",
      label: "平台突破首板",
      matched: Boolean(analysis.originBreakout),
      detail: analysis.boxHigh
        ? `箱体宽度 ${Number(analysis.boxWidth || 0).toFixed(1)}% / 突破 ${Number(analysis.breakoutPct || 0).toFixed(1)}% / 涨停量比 ${Number(analysis.limitVolumeRatio || 0).toFixed(2)}x${analysis.originLocalVeto ? " / 已触发局部否决" : ""}`
        : "涨停日前20日箱体数据不足"
    },
    {
      id: "vcpCompression",
      label: "波动压缩平台",
      matched: Boolean(analysis.vcpCompression),
      detail: analysis.limitEvent
        ? `TR压缩 ${Number(analysis.compressionRatio || 0).toFixed(2)}x / 平台宽度 ${Number(analysis.vcpPlatformWidth || 0).toFixed(1)}% / 后段波动 ${Number(analysis.lateEarlyRatio || 0).toFixed(2)}x${analysis.vcpLocalVeto ? " / 已触发局部否决" : ""}`
        : "暂无涨停后整理区间"
    },
    {
      id: "chipLock",
      label: "筹码锁定",
      matched: Boolean(analysis.chipLock),
      detail: analysis.limitEvent
        ? `锁定 ${Number(analysis.chipLockScore || 0)}分 / ${analysis.chipUsesTurnover ? "换手" : "量能代理"}衰减 ${Number(analysis.turnoverDecay || 0).toFixed(2)}x / 下跌量占比 ${(Number(analysis.downVolumeShare || 0) * 100).toFixed(0)}%${analysis.chipLocalVeto ? " / 已触发局部否决" : ""}`
        : "暂无涨停后筹码区间"
    },
    {
      id: "information",
      label: "信息催化确认",
      matched: analysis.infoScore >= 60 && (analysis.infoRiskSeverity || 0) < 2,
      detail: `催化 ${analysis.infoScore} 分 / 风险级别 ${analysis.infoRiskSeverity || 0}`
    },
    {
      id: "exactNode",
      label: "精确观察节点",
      matched: Boolean(analysis.exactNode),
      detail: analysis.exactNode || analysis.nextNode || "不在观察节点"
    },
    {
      id: "lowFirstBoard",
      label: "低位首板",
      matched: analysis.isLowFirstBoard && analysis.heldSupport,
      detail: `近60日 ${analysis.eventCount60} 次涨停 / 板前20日 ${analysis.preLimitReturn20.toFixed(1)}%`
    },
    {
      id: "firstBoardQuality",
      label: "首板质量",
      matched: Boolean(analysis.firstBoardQuality?.matched),
      detail: analysis.firstBoardQuality?.summary || "等待涨停专题字段"
    },
    {
      id: "secondBreakout",
      label: "平台二次突破",
      matched: analysis.secondBreakout,
      detail: analysis.platformHigh
        ? `平台高点 ${analysis.platformHigh.toFixed(2)} / 整理振幅 ${analysis.platformRange.toFixed(1)}%`
        : "涨停后平台尚未形成"
    },
    {
      id: "sectorLeader",
      label: "板块龙头",
      matched: analysis.sectorLeader,
      detail: analysis.sectorRank
        ? `板块排名第 ${analysis.sectorRank} / 相对板块 ${relativeSectorText(analysis.rsSector)}`
        : `相对板块 ${relativeSectorText(analysis.rsSector)} / 板块 ${analysis.sectorScore} 分`
    },
    {
      id: "sectorLadder",
      label: "板块梯队",
      matched: (analysis.sectorLadderScore || 0) >= 65,
      detail: analysis.sectorLadder
        ? `${analysis.sectorLadder.state} ${analysis.sectorLadder.score}分 / 高度${analysis.sectorLadder.maxHeight}板`
        : "板块梯队数据暂不可用"
    },
    {
      id: "weakToStrong",
      label: "弱转强",
      matched: analysis.weakToStrong,
      detail: analysis.reclaimedSupport
        ? "盘中跌破关键位后收回"
        : analysis.lowOpenRecovery
          ? "低开后收盘反包"
          : "尚未出现弱转强结构"
    },
    {
      id: "marketEmotion",
      label: "市场情绪过滤",
      matched: marketEmotionMatched,
      detail: emotion
        ? `${emotion.state} ${emotion.score}分 / 涨停${emotion.limitUpCount} 跌停${emotion.limitDownCount}`
        : "市场情绪数据暂不可用"
    },
    {
      id: "riskVeto",
      label: "风险否决",
      matched: hardRiskReasons.length === 0,
      detail: hardRiskReasons.length ? hardRiskReasons.join("、") : "未触发硬性风险"
    }
  ];
}

async function findSector(industry) {
  if (!industry || industry === "未分类") return null;
  const key = String(industry).trim().toLowerCase();
  const cached = sectorLookupCache.get(key);
  let stale = false;
  return serviceRuntime.cached(sectorLookupCache, key, () => stale ? 0 : 6 * 60 * 60 * 1000, async () => {
    try {
      const json = await fetchJson(`${SEARCH_API}?input=${encodeURIComponent(industry)}&count=20&type=14`);
      const items = json?.QuotationCodeTable?.Data || [];
      const match = items.find(x => x.Classify === "BK" && x.Name === industry)
        || items.find(x => x.Classify === "BK" && (x.Name.includes(industry) || industry.includes(x.Name)));
      return match ? { code: match.Code, name: match.Name, secid: match.QuoteID } : null;
    } catch (error) {
      serviceRuntime.checkpoint();
      if (cached?.value) { stale = true; return cached.value; }
      throw error;
    }
  }, { shouldCache: () => !stale });
}

async function searchSectors(query) {
  const text = String(query || "").trim();
  if (!text) return [];
  if (isBeijingSector(text)) return [{ ...BEIJING_BOARD }];
  const json = await fetchJson(
    `${SEARCH_API}?input=${encodeURIComponent(text)}&count=30&type=14`
  );
  return (json?.QuotationCodeTable?.Data || [])
    .filter((item) => item.Classify === "BK")
    .slice(0, 10)
    .map((item) => ({
      code: item.Code,
      name: item.Name,
      secid: item.QuoteID,
      type: item.SecurityTypeName || "板块"
    }));
}

function conceptRootName(input) {
  const raw = String(input?.name || input || "").trim();
  return raw
    .replace(/[ⅠⅡⅢⅣⅤ]+$/u, "")
    .replace(/(?:同花顺)?(?:概念|行业|指数|板块)$/u, "")
    .trim() || raw;
}

function collectArrays(value, path = [], result = []) {
  if (Array.isArray(value)) {
    result.push({ path, key: String(path.at(-1) || ""), values: value });
    value.forEach((item, index) => {
      if (item && typeof item === "object") collectArrays(item, [...path, String(index)], result);
    });
    return result;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectArrays(item, [...path, key], result);
    }
  }
  return result;
}

function commonPathScore(left, right) {
  let score = 0;
  const length = Math.min(left.length, right.length);
  while (score < length && left[score] === right[score]) score += 1;
  return score;
}

function splitConceptNames(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) =>
      String(item || "")
        .replace(/[[\]"']/g, "")
        .split(/[;,，、|/\n]+/)
    )
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 30);
}

function extractThsConceptRows(json) {
  const arrays = collectArrays(json);
  const conceptArrays = arrays.filter((item) => /所属.*概念|同花顺概念|概念板块|涉及概念/i.test(item.key));
  const codeArrays = arrays.filter((item) => /thscode|股票代码|证券代码|^代码$/i.test(item.key));
  const nameArrays = arrays.filter((item) => /股票简称|证券简称|股票名称|证券名称|^简称$/i.test(item.key));
  const rows = [];
  for (const concepts of conceptArrays) {
    const closest = (candidates) =>
      candidates
        .filter((item) => item.values.length === concepts.values.length)
        .sort((left, right) =>
          commonPathScore(right.path, concepts.path) - commonPathScore(left.path, concepts.path)
        )[0];
    const codes = closest(codeArrays);
    const names = closest(nameArrays);
    for (let index = 0; index < concepts.values.length; index += 1) {
      const codeText = String(codes?.values[index] || "");
      let code = "";
      try {
        code = toSecurity(codeText).code;
      } catch {
        code = "";
      }
      const name = String(names?.values[index] || "");
      const conceptNames = splitConceptNames(concepts.values[index]);
      if (code && conceptNames.length) rows.push({ code, name, concepts: conceptNames });
    }
  }
  const collectRowObjects = (value) => {
    if (Array.isArray(value)) {
      value.forEach(collectRowObjects);
      return;
    }
    if (!value || typeof value !== "object") return;
    const entries = Object.entries(value);
    const conceptEntry = entries.find(
      ([key, item]) =>
        /所属.*概念|同花顺概念|概念板块|涉及概念/i.test(key) &&
        !Array.isArray(item)
    );
    if (conceptEntry) {
      const codeEntry = entries.find(([key]) => /thscode|股票代码|证券代码|^代码$/i.test(key));
      const nameEntry = entries.find(([key]) => /股票简称|证券简称|股票名称|证券名称|^简称$/i.test(key));
      let code = "";
      try {
        code = toSecurity(String(codeEntry?.[1] || "")).code;
      } catch {
        code = "";
      }
      const name = String(nameEntry?.[1] || "");
      const concepts = splitConceptNames(conceptEntry[1]);
      if (code && concepts.length) rows.push({ code, name, concepts });
    }
    Object.values(value).forEach(collectRowObjects);
  };
  collectRowObjects(json);
  const unique = new Map();
  for (const row of rows) {
    const key = row.code || `${row.name}:${row.concepts.join("|")}`;
    const current = unique.get(key);
    if (!current) unique.set(key, row);
    else current.concepts = [...new Set([...current.concepts, ...row.concepts])];
  }
  return [...unique.values()];
}

async function thsSmartPickingConcepts(searchString, refreshToken) {
  const json = await withThsToken(refreshToken, (accessToken) =>
    fetchJson(`${THS_BASE}/smart_stock_picking`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        access_token: accessToken,
        ifindlang: "cn"
      },
      body: JSON.stringify({
        searchstring: searchString,
        searchtype: "stock"
      })
    }).then((result) => {
      if (Number(result?.errorcode || 0) !== 0) {
        throw thsProviderError(result, "同花顺问财未返回结果");
      }
      return result;
    })
  );
  return {
    query: searchString,
    rows: extractThsConceptRows(json)
  };
}

const GENERIC_CONCEPT_NAMES = new Set([
  "融资融券",
  "沪股通",
  "深股通",
  "MSCI概念",
  "证金持股",
  "标普道琼斯A股",
  "机构重仓",
  "基金重仓",
  "昨日涨停",
  "昨日连板"
]);

function conceptNameIsUseful(name, rootName) {
  const normalized = String(name || "").trim();
  if (!normalized || normalized.length < 2 || normalized.length > 30) return false;
  if (GENERIC_CONCEPT_NAMES.has(normalized)) return false;
  const compact = normalized.replace(/(?:概念|行业|板块|Ⅱ|I+)$/u, "").toLowerCase();
  const root = String(rootName || "").replace(/(?:概念|行业|板块|Ⅱ|I+)$/u, "").toLowerCase();
  return Boolean(compact && compact !== root && !compact.includes(root) && !root.includes(compact));
}

function frequencySegments(map, stockCount, role, rootName, limit) {
  return [...map.entries()]
    .map(([name, detail]) => ({
      name,
      role,
      description: detail.stocks.map((stock) => stock.name).filter(Boolean).join("、") || "免费行情成分股样本",
      stockCount: detail.count,
      thsStockCount: detail.count,
      overlapRatio: stockCount ? detail.count / stockCount : 0,
      sampleStocks: detail.stocks,
      thsQuery: `${rootName}板块且属于${name}，剔除ST`
    }))
    .filter((item) => item.stockCount >= 2)
    .sort((left, right) => right.stockCount - left.stockCount)
    .slice(0, limit);
}

function buildFreeConceptGroups(rootName, members = []) {
  const rows = members.filter((item) => item?.code && !isRiskStockName(item.name));
  const industries = new Map();
  const concepts = new Map();
  const add = (map, name, stock) => {
    if (!conceptNameIsUseful(name, rootName)) return;
    const current = map.get(name) || { count: 0, stocks: [] };
    current.count += 1;
    if (current.stocks.length < 8) current.stocks.push(stock);
    map.set(name, current);
  };
  for (const row of rows) {
    const stock = { code: String(row.code || ""), name: String(row.name || "") };
    add(industries, row.subIndustry || row.industry, stock);
    const names = Array.isArray(row.freeConcepts)
      ? row.freeConcepts
      : String(row.freeConcepts || "").split(/[，,;；]/);
    for (const name of names) add(concepts, String(name || "").trim(), stock);
  }
  const stockCount = rows.length;
  const industrySegments = frequencySegments(industries, stockCount, "成分行业", rootName, 18);
  const conceptSegments = frequencySegments(concepts, stockCount, "交叉概念", rootName, 28);
  return {
    stockCount,
    groups: [
      { name: "成分行业细分", segments: industrySegments },
      { name: "交叉概念细分", segments: conceptSegments }
    ].filter((group) => group.segments.length)
  };
}

async function freeConceptChain(input, rootName, query, fallbackNote = "") {
  let members = Array.isArray(input?.constituents) ? input.constituents : [];
  let loadWarning = "";
  if (!members.length) {
    try {
      const detail = await analyzeSector(input);
      members = detail?.constituents || [];
    } catch (error) {
      loadWarning = String(error?.message || error);
    }
  }
  const result = buildFreeConceptGroups(rootName, members);
  return {
    id: rootName,
    name: rootName,
    source: "免费公开行情 · 成分行业与交叉概念",
    thsStatus: result.groups.length ? "免费行情" : "暂无结果",
    dynamic: true,
    query,
    stockCount: result.stockCount,
    groups: result.groups,
    message: result.groups.length
      ? `根据 ${result.stockCount} 只板块成分股的公开行业与概念字段动态生成，不依赖 QuantAPI${fallbackNote ? `；${fallbackNote}` : ""}。`
      : `免费行情暂未返回可用细分字段${loadWarning ? `：${loadWarning}` : ""}${fallbackNote ? `；${fallbackNote}` : ""}。`,
    updatedAt: new Date().toISOString()
  };
}

async function getConceptChain(input, settings = {}) {
  const rootName = conceptRootName(input);
  if (!rootName) return null;
  const hasThsToken = Boolean(settings.refreshToken);
  const sectorCode = typeof input === "object" ? String(input?.code || "") : "";
  const cacheKey = `${rootName.toLowerCase()}:${sectorCode}:${credentialFingerprint(settings.refreshToken)}`;
  return serviceRuntime.cached(conceptChainCache, cacheKey, 30 * 60 * 1000, async () => {
    const query = `${rootName}概念股，列出所属同花顺概念、股票简称和股票代码，剔除ST`;
    if (!hasThsToken) {
      return freeConceptChain(input, rootName, query);
    }
    let smart;
    try {
      smart = await thsSmartPickingConcepts(query, settings.refreshToken);
    } catch (error) {
      return freeConceptChain(input, rootName, query, `同花顺增强查询失败：${error.message}`);
    }
    const rows = smart.rows.filter((row) => !isRiskStockName(row.name));
    const frequency = new Map();
    for (const row of rows) {
      for (const concept of row.concepts) {
        if (!conceptNameIsUseful(concept, rootName)) continue;
        const current = frequency.get(concept) || { count: 0, stocks: [] };
        current.count += 1;
        if (current.stocks.length < 8) {
          current.stocks.push({ code: row.code, name: row.name });
        }
        frequency.set(concept, current);
      }
    }
    const stockCount = rows.length;
    const segments = [...frequency.entries()]
      .map(([name, detail]) => ({
        name,
        role: `${detail.count} 只重合`,
        description: detail.stocks.map((stock) => stock.name).filter(Boolean).join("、") || "同花顺概念交叉样本",
        stockCount: detail.count,
        thsStockCount: detail.count,
        overlapRatio: stockCount ? detail.count / stockCount : 0,
        sampleStocks: detail.stocks,
        thsQuery: `${rootName}概念股且属于${name}，剔除ST`
      }))
      .filter((item) => item.thsStockCount >= 2 || item.overlapRatio >= 0.1)
      .sort((left, right) => right.thsStockCount - left.thsStockCount)
      .slice(0, 40);
    const groupFor = (name, predicate) => ({
      name,
      segments: segments.filter(predicate)
    });
    const groups = [
      groupFor("高重合细分", (item) => item.overlapRatio >= 0.35),
      groupFor("中度关联细分", (item) => item.overlapRatio >= 0.15 && item.overlapRatio < 0.35),
      groupFor("扩展关联概念", (item) => item.overlapRatio < 0.15)
    ].filter((group) => group.segments.length);
    const value = {
      id: rootName,
      name: rootName,
      source: "同花顺问财动态检索",
      thsStatus: groups.length ? "已连接" : "无细分结果",
      dynamic: true,
      query: smart.query,
      stockCount,
      groups,
      message: groups.length
        ? `根据 ${stockCount} 只问财候选股票的“所属同花顺概念”字段，按重合度动态生成。`
        : "同花顺返回的股票中没有可解析的细分概念字段，请在超级命令中确认账号字段权限。",
      updatedAt: new Date().toISOString()
    };
    return groups.length
      ? value
      : freeConceptChain(input, rootName, query, "同花顺增强未返回可解析细分，已自动切换免费行情");
  });
}

function buildSectorBreadthDiagnostics(rawMembers = []) {
  const members = Array.isArray(rawMembers) ? rawMembers : [];
  const finiteFrom = (item, ...keys) => {
    for (const key of keys) {
      const raw = item?.[key];
      if (raw === null || raw === undefined || raw === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };
  const returns = members
    .map((item) => finiteFrom(item, "changePct", "f3"))
    .filter(Number.isFinite);
  const amounts = members
    .map((item) => Math.max(0, finiteFrom(item, "amount", "f6") || 0));
  const inflows = members
    .map((item) => finiteFrom(item, "mainNetInflow", "f62"));
  const totalAmount = amounts.reduce((sum, value) => sum + value, 0);
  const positiveAmount = members.reduce((sum, item, index) => {
    const change = finiteFrom(item, "changePct", "f3");
    return sum + (change !== null && change > 0 ? amounts[index] : 0);
  }, 0);
  const sortedAmounts = [...amounts].sort((left, right) => right - left);
  const top5AmountShare = totalAmount
    ? sortedAmounts.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalAmount
    : null;
  const sortedReturns = [...returns].sort((left, right) => left - right);
  const medianReturn = sortedReturns.length
    ? sortedReturns.length % 2
      ? sortedReturns[Math.floor(sortedReturns.length / 2)]
      : average([
          sortedReturns[sortedReturns.length / 2 - 1],
          sortedReturns[sortedReturns.length / 2]
        ])
    : null;
  const meanReturn = returns.length ? average(returns) : null;
  const returnDispersion = returns.length >= 2 && meanReturn !== null
    ? Math.sqrt(average(returns.map((value) => (value - meanReturn) ** 2)))
    : null;
  const usableInflows = inflows.filter(Number.isFinite);
  const positiveInflowRatio = usableInflows.length
    ? usableInflows.filter((value) => value > 0).length / usableInflows.length
    : null;
  const advancingAmountShare = totalAmount ? positiveAmount / totalAmount : null;
  // 覆盖率口径修正：只统计「本数据源理应提供」的字段。
  //
  // 原实现把 mainInflow（主力净流入）无条件计入分母，但同花顺免费板块页
  // **根本不提供资金流**，导致该项恒为 0 —— 覆盖率最高只能 67%，
  // 界面据此误报「字段不足、评分暂停」，而实际上涨幅/成交额/换手都是 100% 齐全的。
  //
  // 新口径：数据源声明提供了某字段才纳入统计；完全不提供的不参与分母。
  const sourceProvidesInflow = members.some((item) => item.mainNetInflow !== undefined && item.mainNetInflow !== null);
  const fieldCoverage = {
    return: members.length ? returns.length / members.length : 0,
    amount: members.length ? amounts.filter((value) => value > 0).length / members.length : 0,
    ...(sourceProvidesInflow
      ? { mainInflow: members.length ? usableInflows.length / members.length : 0 }
      : {})
  };
  const coveragePercent = Math.round(average(Object.values(fieldCoverage)) * 100);
  const breadthScore = clamp(50 + ((returns.filter((value) => value > 0).length / Math.max(1, returns.length)) - 0.5) * 100);
  const participationScore = advancingAmountShare === null
    ? 50
    : clamp(50 + (advancingAmountShare - 0.5) * 100);
  const capitalScore = positiveInflowRatio === null
    ? 50
    : clamp(50 + (positiveInflowRatio - 0.5) * 100);
  const concentrationScore = top5AmountShare === null
    ? 50
    : clamp(100 - Math.max(0, top5AmountShare - 0.25) * 150);
  const dispersionScore = returnDispersion === null
    ? 50
    : clamp(92 - Math.max(0, returnDispersion - 1.5) * 14);
  const leadershipQualityScore = Math.round(
    breadthScore * 0.3 +
    participationScore * 0.25 +
    capitalScore * 0.2 +
    concentrationScore * 0.15 +
    dispersionScore * 0.1
  );
  const scoreAdjustment = clamp(
    (participationScore - 50) * 0.08 +
    (capitalScore - 50) * 0.05 +
    (concentrationScore - 50) * 0.05 +
    (dispersionScore - 50) * 0.04,
    -10,
    10,
    0
  );
  return {
    medianReturn,
    returnDispersion,
    advancingAmountShare,
    positiveInflowRatio,
    top5AmountShare,
    coveragePercent,
    fieldCoverage,
    leadershipQualityScore,
    scoreAdjustment,
    components: {
      breadth: Math.round(breadthScore),
      participation: Math.round(participationScore),
      capital: Math.round(capitalScore),
      concentration: Math.round(concentrationScore),
      dispersion: Math.round(dispersionScore)
    }
  };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(String(value).replace(/,/g, "").replace(/%$/, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function nullableAverage(values = []) {
  const valid = values.map(finiteOrNull).filter(Number.isFinite);
  return valid.length ? average(valid) : null;
}

function providerCircuitOpen(id) {
  return Number(sectorProviderHealth.get(id)?.openUntil || 0) > Date.now();
}

function recordSectorProviderResult(id, ok) {
  if (ok) {
    sectorProviderHealth.delete(id);
    return;
  }
  const current = sectorProviderHealth.get(id) || { failures: 0, openUntil: 0 };
  const failures = current.failures + 1;
  sectorProviderHealth.set(id, {
    failures,
    openUntil: failures >= 2 ? Date.now() + 45 * 1000 : 0
  });
}

function normalizeEastSectorMembers(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((item) => {
      const code = String(item?.f12 || "").trim();
      if (!isAStockCode(code)) return null;
      const identifiers = canonicalSecurityIdentifiers(code, "stock");
      const previousClose = finiteOrNull(item.f18);
      const latest = finiteOrNull(item.f2);
      const name = String(item.f14 || code);
      const target = previousClose && latest && !isRiskStockName(name)
        ? roundPrice(previousClose * (1 + priceLimitRate(code, name)))
        : null;
      return {
        code,
        name,
        secid: identifiers.secid,
        thscode: identifiers.thscode,
        latest,
        changePct: finiteOrNull(item.f3),
        turnover: finiteOrNull(item.f8),
        amount: finiteOrNull(item.f6),
        high: finiteOrNull(item.f15),
        low: finiteOrNull(item.f16),
        open: finiteOrNull(item.f17),
        preClose: previousClose,
        totalMarketCap: finiteOrNull(item.f20),
        floatMarketCap: finiteOrNull(item.f21),
        mainNetInflow: finiteOrNull(item.f62),
        subIndustry: String(item.f100 || ""),
        region: String(item.f102 || ""),
        freeConcepts: String(item.f103 || "")
          .split(/[，,;；]/)
          .map((name) => name.trim())
          .filter(Boolean),
        isLimitUp: target !== null && isLimitUpPrice(latest, target)
      };
    })
    .filter(Boolean)
    .sort((left, right) => (right.changePct ?? -Infinity) - (left.changePct ?? -Infinity));
}

function parseSinaSectorCatalog(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("新浪行业目录格式异常");
  const payload = JSON.parse(source.slice(start, end + 1).replace(/,\s*}/g, "}"));
  return Object.entries(payload).map(([key, value]) => {
    const fields = String(value || "").split(",");
    return {
      key,
      node: String(fields[0] || key),
      name: String(fields[1] || "").trim(),
      memberCount: finiteOrNull(fields[2]),
      averagePrice: finiteOrNull(fields[3]),
      averageChange: finiteOrNull(fields[4]),
      changePct: finiteOrNull(fields[5]),
      volume: finiteOrNull(fields[6]),
      amount: finiteOrNull(fields[7]),
      leader: {
        symbol: String(fields[8] || ""),
        changePct: finiteOrNull(fields[9]),
        latest: finiteOrNull(fields[10]),
        change: finiteOrNull(fields[11]),
        name: String(fields.slice(12).join(",") || "").trim()
      }
    };
  }).filter((item) => item.node && item.name);
}

function normalizedSectorName(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/(?:同花顺)?(?:行业|概念|指数|板块)$/u, "")
    .toLowerCase();
}

function matchSinaSector(catalog, industry) {
  const target = normalizedSectorName(industry);
  if (!target) return null;
  const rows = Array.isArray(catalog) ? catalog : [];
  return rows.find((item) => normalizedSectorName(item.name) === target) ||
    rows.find((item) => {
      const name = normalizedSectorName(item.name);
      return target.length >= 3 && name.length >= 3 && (name.includes(target) || target.includes(name));
    }) || null;
}

function normalizeSinaSectorMembers(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((item) => {
      const code = String(item?.code || item?.symbol || "").match(/\d{6}/)?.[0] || "";
      if (!isAStockCode(code)) return null;
      const identifiers = canonicalSecurityIdentifiers(code, "stock");
      const name = String(item.name || code).trim();
      const previousClose = finiteOrNull(item.settlement ?? item.preClose);
      const latest = finiteOrNull(item.trade ?? item.latest ?? item.price);
      const target = previousClose && latest && !isRiskStockName(name)
        ? roundPrice(previousClose * (1 + priceLimitRate(code, name)))
        : null;
      return {
        code,
        name,
        secid: identifiers.secid,
        thscode: identifiers.thscode,
        latest,
        changePct: finiteOrNull(item.changepercent ?? item.changePct),
        turnover: finiteOrNull(item.turnoverratio ?? item.turnover),
        amount: finiteOrNull(item.amount),
        high: finiteOrNull(item.high),
        low: finiteOrNull(item.low),
        open: finiteOrNull(item.open),
        preClose: previousClose,
        totalMarketCap: item.mktcap === undefined ? finiteOrNull(item.totalMarketCap) : finiteOrNull(item.mktcap) === null ? null : Number(item.mktcap) * 10000,
        floatMarketCap: item.nmc === undefined ? finiteOrNull(item.floatMarketCap) : finiteOrNull(item.nmc) === null ? null : Number(item.nmc) * 10000,
        isLimitUp: target !== null && isLimitUpPrice(latest, target)
      };
    })
    .filter(Boolean)
    .sort((left, right) => (right.changePct ?? -Infinity) - (left.changePct ?? -Infinity));
}

function extractThsSectorMembers(json) {
  const arrays = collectArrays(json);
  const candidates = (pattern) => arrays.filter((item) => pattern.test(item.key));
  const codeArrays = candidates(/thscode|股票代码|证券代码|^代码$/i);
  const fieldPatterns = {
    name: /股票简称|证券简称|股票名称|证券名称|^简称$/i,
    latest: /最新价|现价|最新收盘价/i,
    changePct: /涨跌幅|涨幅/i,
    turnover: /换手率/i,
    amount: /成交额/i,
    high: /最高价/i,
    low: /最低价/i,
    open: /开盘价/i,
    preClose: /昨收价|前收盘/i,
    totalMarketCap: /总市值/i,
    floatMarketCap: /流通市值/i
  };
  const rows = [];
  for (const codes of codeArrays) {
    const closest = (pattern) => candidates(pattern)
      .filter((item) => item.values.length === codes.values.length)
      .sort((left, right) => commonPathScore(right.path, codes.path) - commonPathScore(left.path, codes.path))[0];
    const fields = Object.fromEntries(Object.entries(fieldPatterns).map(([key, pattern]) => [key, closest(pattern)]));
    for (let index = 0; index < codes.values.length; index += 1) {
      let security;
      try {
        security = toSecurity(String(codes.values[index] || ""));
      } catch {
        continue;
      }
      if (!isAStockCode(security.code)) continue;
      const row = {
        code: security.code,
        name: String(fields.name?.values[index] || security.code),
        secid: security.secid,
        thscode: security.thscode
      };
      for (const key of ["latest", "changePct", "turnover", "amount", "high", "low", "open", "preClose", "totalMarketCap", "floatMarketCap"]) {
        const value = finiteOrNull(fields[key]?.values[index]);
        if (value !== null) row[key] = value;
      }
      const target = row.preClose && row.latest && !isRiskStockName(row.name)
        ? roundPrice(row.preClose * (1 + priceLimitRate(row.code, row.name)))
        : null;
      row.isLimitUp = target !== null && isLimitUpPrice(row.latest, target);
      rows.push(row);
    }
  }
  return [...new Map(rows.map((item) => [item.code, item])).values()]
    .sort((left, right) => (right.changePct ?? -Infinity) - (left.changePct ?? -Infinity));
}

async function getSinaSectorCatalog() {
  return withSingleFlightCache(sinaSectorCatalogCache, 30 * 60 * 1000, async () => {
    try {
      return parseSinaSectorCatalog(await fetchDecodedText("https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php", {}, 10000, "gb18030"));
    } catch (error) {
      serviceRuntime.checkpoint();
      if (sinaSectorCatalogCache.value) return sinaSectorCatalogCache.value;
      throw error;
    }
  });
}

async function loadSinaSector(industry) {
  const catalog = await getSinaSectorCatalog();
  const summary = matchSinaSector(catalog, industry);
  if (!summary) {
    const error = new Error(`新浪未匹配到行业：${industry}`);
    error.code = "SECTOR_NOT_FOUND";
    throw error;
  }
  if (providerCircuitOpen("sina-sector-members")) {
    return { members: [], summary, memberError: "成分节点短时熔断，稍后自动重试" };
  }
  try {
    const url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData" +
      `?page=1&num=500&sort=symbol&asc=1&node=${encodeURIComponent(summary.node)}&symbol=&_s_r_a=page`;
    const text = await fetchDecodedText(url, {}, 12000, "gb18030");
    const members = normalizeSinaSectorMembers(JSON.parse(text));
    if (!members.length) throw new Error("新浪行业成分为空");
    recordSectorProviderResult("sina-sector-members", true);
    return { members, summary };
  } catch (error) {
    recordSectorProviderResult("sina-sector-members", false);
    return { members: [], summary, memberError: String(error?.message || error) };
  }
}

/**
 * 同花顺**免费公开**板块行情源。
 *
 * 背景：原来的同花顺接入走 QuantAPI（quantapi.51ifind.com）的 smart_stock_picking，
 * 那是付费接口，必须配置 refreshToken；用户没配 token 时主源直接不可用，
 * 板块强度只能靠东财/新浪降级，且在提示里显示成「同花顺主源不可用」。
 *
 * 实际上同花顺的行情页 q.10jqka.com.cn/thshy/ 是**免费公开**的，
 * 一页就返回全部行业板块，字段完全够用：
 *   序号 | 板块 | 涨跌幅(%) | 总成交量 | 总成交额 | 净流入 | 上涨家数 | 下跌家数 | 均价
 * 而且天然按涨幅降序，与「板块强度按涨幅排名」的口径一致。
 *
 * 注意：翻页走 /ajax/ 路径需要反爬令牌（实测 401），
 * 但首页已包含全部行业板块（约 46 个），无需翻页。
 */
const THS_PUBLIC_SECTOR = "https://q.10jqka.com.cn/thshy";

function thsPublicHeaders(referer) {
  let token = "";
  try { token = require("./ths-hexin-v.cjs").getHexinToken(); } catch { /* ignore */ }
  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: referer,
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9"
  };
  if (token) headers.Cookie = `v=${token}`;
  return headers;
}

function thsPublicTextCells(html) {
  return html.map((cell) => String(cell)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim());
}

/** 解析行业板块行情表 → [{ code, name, changePct, amount, netInflow, rising, falling, avgPrice, volume }] */
function parseThsPublicSectorTable(html) {
  const table = html.match(/<table[^>]*m-pager-table[^>]*>([\s\S]*?)<\/table>/i);
  if (!table) return [];
  const rows = [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const out = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    if (cells.length < 8) continue;
    const text = thsPublicTextCells(cells);
    // 跳过表头
    if (!/^\d+$/.test(text[0])) continue;
    const codeMatch = row.match(/\/thshy\/detail\/code\/(\d{6})/);
    const name = text[1];
    if (!name || name.length > 20) continue;
    const num = (v) => { const n = Number(String(v).replace(/[^\d.+-]/g, "")); return Number.isFinite(n) ? n : null; };
    const changePct = num(text[2]);
    const volume = num(text[3]);        // 万手
    const amount = num(text[4]);        // 亿元
    const netInflow = num(text[5]);     // 亿元
    const rising = num(text[6]);
    const falling = num(text[7]);
    const avgPrice = num(text[8]);
    if (changePct === null) continue;
    out.push({
      code: codeMatch ? codeMatch[1] : "",
      name,
      changePct,
      // 统一成「元」，与其它 provider 的口径一致
      amount: amount === null ? null : amount * 1e8,
      turnover: null,
      netInflow: netInflow === null ? null : netInflow * 1e8,
      rising,
      falling,
      averagePrice: avgPrice,
      volumeHands: volume === null ? null : volume * 1e4
    });
  }
  return out;
}

/**
 * 抓取同花顺免费行业板块榜（自动翻页）。
 *
 * 实测：第 1 页 50 个板块，第 2 页 40 个，第 3 页为空 —— 共 90 个行业板块。
 * 翻页地址不能带 `/ajax/1/` 后缀（那需要反爬令牌，实测 401），
 * 必须用普通页面路径 `/thshy/index/field/199112/order/desc/page/N/`。
 * 最多取 4 页（防御性上限），遇到空页即停止。
 */
async function loadThsPublicSectorTable(signal) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 4; page += 1) {
    const url = page === 1
      ? `${THS_PUBLIC_SECTOR}/`
      : `${THS_PUBLIC_SECTOR}/index/field/199112/order/desc/page/${page}/`;
    const text = await fetchDecodedText(
      url,
      { headers: thsPublicHeaders(`${THS_PUBLIC_SECTOR}/`), signal },
      12000,
      "gb18030"
    );
    const rows = parseThsPublicSectorTable(text);
    if (!rows.length) break;
    for (const row of rows) {
      const key = row.code || row.name;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(row);
    }
    if (rows.length < 10) break;
  }
  return all;
}

async function loadThsSectorMembers(industry, settings = {}) {
  const result = await withThsToken(settings.refreshToken, (accessToken) =>
    fetchJson(`${THS_BASE}/smart_stock_picking`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        access_token: accessToken,
        ifindlang: "cn"
      },
      body: JSON.stringify({
        searchstring: `${industry}板块的A股，列出股票代码、股票简称、最新价、涨跌幅、成交额、换手率、最高价、最低价、开盘价、昨收价、总市值、流通市值，剔除ST`,
        searchtype: "stock"
      })
    }).then((payload) => {
      if (Number(payload?.errorcode || 0) !== 0) {
        throw thsProviderError(payload, "同花顺板块查询失败");
      }
      return payload;
    })
  );
  const members = extractThsSectorMembers(result);
  if (!members.length) throw new Error("同花顺板块查询未返回可解析成分股");
  return members;
}

async function loadEastSectorMembers(sector) {
  const query = `clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent(`b:${String(sector.code)}`)}` +
    "&fid=f3&fields=f2,f3,f6,f8,f12,f14,f15,f16,f17,f18,f20,f21,f62,f100,f102,f103";
  let lastError;
  for (const origin of [EAST_QUOTE, EAST_DELAY_QUOTE]) {
    const providerId = origin === EAST_QUOTE ? "eastmoney-primary" : "eastmoney-delay";
    if (providerCircuitOpen(providerId)) continue;
    try {
      const json = await fetchJson(`${origin}/${query}`);
      const members = normalizeEastSectorMembers(json?.data?.diff || []);
      if (!members.length) throw new Error("板块成分为空");
      recordSectorProviderResult(providerId, true);
      return { members, source: origin === EAST_QUOTE ? "东方财富实时" : "东方财富延迟节点" };
    } catch (error) {
      lastError = error;
      recordSectorProviderResult(providerId, false);
    }
  }
  throw lastError || new Error("东方财富板块节点处于短时熔断");
}

function sectorStateFromScore(score) {
  if (!Number.isFinite(score)) return "详情待恢复";
  return score >= 80
    ? "核心主线"
    : score >= 65
      ? "持续强势"
      : score >= 50
        ? "轮动活跃"
        : score >= 35
          ? "弱势反弹"
          : "弱势过滤";
}

function buildSectorStrengthFromData({ sector, members = [], history = [], benchmark = [], context = {}, source, summary = null, warning = "" }) {
  const constituents = Array.isArray(members) ? members : [];
  const memberReturns = constituents.map((item) => item.changePct).filter(Number.isFinite);
  const memberTurnovers = constituents.map((item) => item.turnover).filter(Number.isFinite);
  const sampleBreadth = memberReturns.length
    ? memberReturns.filter((value) => value > 0).length / memberReturns.length
    : null;
  const officialRising = finiteOrNull(summary?.rising);
  const officialFalling = finiteOrNull(summary?.falling);
  const officialCount = officialRising !== null && officialFalling !== null && officialRising >= 0 && officialFalling >= 0
    ? officialRising + officialFalling : null;
  const officialBreadth = officialCount > 0 ? officialRising / officialCount : null;
  // Resolve the breadth basis before computing relative breadth and its score.
  const breadth = officialBreadth ?? sampleBreadth;
  const breadthSource = officialBreadth !== null ? "official-summary" : "member-sample";
  const declaredMemberCount = finiteOrNull(summary?.memberCount) ?? officialCount;
  const sampleMetrics = ["同花顺官方行情", "同花顺概念板块"].includes(source)
    || (declaredMemberCount !== null && declaredMemberCount > constituents.length);
  // summary.changePct 是数据源直接给出的官方板块涨幅。
  // 有它时优先采用官方值 —— 当成分列表不是逐只明细（例如同花顺免费榜只给聚合值，
  // 我们用上涨/下跌家数还原分布来算广度）时，成员均值会失真，官方值才是准的。
  const summaryChangePct = finiteOrNull(summary?.changePct);
  const memberAverageReturn = summaryChangePct !== null
    ? summaryChangePct
    : memberReturns.length
    ? average(memberReturns)
    : finiteOrNull(summary?.changePct);
  const memberAverageTurnover = nullableAverage(memberTurnovers);
  const marketBreadth = finiteOrNull(context.marketBreadth);
  const marketAverageReturn = finiteOrNull(context.marketAverageReturn);
  const relativeBreadth = breadth !== null && marketBreadth !== null ? breadth - marketBreadth : null;
  const relativeReturn = memberAverageReturn !== null && marketAverageReturn !== null
    ? memberAverageReturn - marketAverageReturn
    : null;
  const returns = {
    r1: history.length >= 2 ? returnFor(history, 1) : memberAverageReturn,
    r3: history.length >= 4 ? returnFor(history, 3) : null,
    r5: history.length >= 6 ? returnFor(history, 5) : null
  };
  const benchmarkReturns = {
    r1: benchmark.length >= 2 ? returnFor(benchmark, 1) : null,
    r3: benchmark.length >= 4 ? returnFor(benchmark, 3) : null,
    r5: benchmark.length >= 6 ? returnFor(benchmark, 5) : null
  };
  const weightedExcess = [["r1", 0.45], ["r3", 0.35], ["r5", 0.2]]
    .map(([key, weight]) => ({
      weight,
      value: returns[key] !== null && benchmarkReturns[key] !== null
        ? returns[key] - benchmarkReturns[key]
        : null
    }))
    .filter((item) => item.value !== null);
  const totalExcessWeight = weightedExcess.reduce((sum, item) => sum + item.weight, 0);
  const excess = totalExcessWeight
    ? weightedExcess.reduce((sum, item) => sum + item.value * item.weight, 0) / totalExcessWeight
    : null;
  const previousAmounts = history.length >= 6
    ? history.slice(-6, -1).map((item) => finiteOrNull(item.amount)).filter(Number.isFinite)
    : [];
  const averageAmount = nullableAverage(previousAmounts);
  const latestAmount = finiteOrNull(history.at(-1)?.amount);
  const amountHeat = averageAmount && latestAmount !== null ? latestAmount / averageAmount : null;
  const persistence = history.length >= 5
    ? history.slice(-5).filter((item) => finiteOrNull(item.changePct) > 0).length / 5
    : null;
  const breadthDiagnostics = constituents.length ? {
    ...buildSectorBreadthDiagnostics(constituents),
    scope: sampleMetrics ? "member-sample" : "loaded-members",
    sampleSize: constituents.length,
    declaredMemberCount
  } : null;
  const ladder = context.ladderPools
    ? {
        ...buildSectorLadder({
          ...context.ladderPools,
          memberCodes: constituents.map((item) => item.code)
        }),
        asOfDate: context.ladderPools.currentDate || "",
        previousDate: context.ladderPools.previousDate || ""
      }
    : null;
  const snapshotLimitUps = constituents.filter((item) => item.isLimitUp).length;
  const limitUps = ladder && constituents.length ? ladder.currentLimitUps : snapshotLimitUps;
  let score = null;
  if (constituents.length && breadth !== null && memberAverageReturn !== null) {
    let rawScore = 50;
    if (excess !== null) rawScore += excess * 4;
    if (relativeBreadth !== null) rawScore += relativeBreadth * 30;
    rawScore += Math.min(12, limitUps * 1.8);
    if (relativeReturn !== null) rawScore += relativeReturn * 3;
    if (amountHeat !== null) rawScore += (amountHeat - 1) * 12;
    if (persistence !== null) rawScore += (persistence - 0.5) * 20;
    const ladderScore = finiteOrNull(ladder?.score);
    if (ladderScore !== null) rawScore += (ladderScore - 50) * 0.15;
    if (breadthDiagnostics) rawScore += breadthDiagnostics.scoreAdjustment;
    score = Math.round(clamp(rawScore, 0, 100));
  }
  const partial = history.length < 6 || constituents.length === 0 || source !== "同花顺 QuantAPI";
  const sampleNotice = sampleMetrics
    ? `${officialBreadth !== null ? "广度采用源端上涨/下跌家数汇总；" : "广度仅来自本次成分样本；"}集中度、涨跌分布、领涨及梯队指标基于本次取得的${constituents.length}只成分，不代表全量覆盖。`
    : "";
  return {
    ...sector,
    returns,
    benchmarkReturns,
    excess,
    breadth,
    breadthSource,
    sampleBreadth,
    memberMetricsScope: sampleMetrics ? "member-sample" : "loaded-members",
    marketBreadth,
    relativeBreadth,
    memberAverageReturn,
    marketAverageReturn,
    relativeReturn,
    memberAverageTurnover,
    breadthDiagnostics,
    leadershipQualityScore: breadthDiagnostics?.leadershipQualityScore ?? null,
    advancingAmountShare: breadthDiagnostics?.advancingAmountShare ?? null,
    positiveInflowRatio: breadthDiagnostics?.positiveInflowRatio ?? null,
    top5AmountShare: breadthDiagnostics?.top5AmountShare ?? null,
    medianMemberReturn: breadthDiagnostics?.medianReturn ?? null,
    returnDispersion: breadthDiagnostics?.returnDispersion ?? null,
    dataCoveragePercent: breadthDiagnostics?.coveragePercent ?? null,
    limitUps,
    snapshotLimitUps,
    memberCount: declaredMemberCount ?? (constituents.length || null),
    constituents,
    // 领涨股：按涨幅取前 8 只。
    // 之前这里没有 leaders 字段，前端「当前板块」下方的领涨股标签就永远是空，
    // 而 constituents 明明有几十上百只 —— 数据在、只是没往外给。
    leaders: [...constituents]
      .filter((item) => Number.isFinite(item?.changePct))
      .sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity))
      .slice(0, 8)
      .map((item) => ({
        code: item.code,
        name: item.name,
        changePct: item.changePct,
        latest: item.latest ?? null,
        turnover: item.turnover ?? null,
        amount: item.amount ?? null
      })),
    limitUpStocks: constituents.filter((item) => item.isLimitUp),
    ladder,
    amountHeat,
    persistence,
    score,
    state: sectorStateFromScore(score),
    sourceState: source === "同花顺 QuantAPI"
      ? "同花顺主源正常"
      : source.startsWith("东方财富")
        ? `${source}次源接力`
        : `${source}备用接力`,
    dataSource: source,
    providerPriority: [...SECTOR_PROVIDER_PRIORITY],
    scoreMode: history.length >= 6 ? (sampleMetrics ? "板块指数与成分样本评分" : "完整板块指数评分") : constituents.length ? (sampleMetrics ? "成分样本评分" : "实时成分评分") : "评分暂停",
    history,
    partial,
    warning: [partial ? warning || `${source}已接力；缺失的板块指数历史指标显示为 --，实时成分数据仍参与计算。` : "", sampleNotice].filter(Boolean).join(" ")
  };
}

async function loadBeijingSector(options = {}, context = {}) {
  const snapshot = await beijingSectorSource.load({ forceRefresh: Boolean(options.forceRefresh), signal: serviceSignal(options.signal), waitForQuotes: options.waitForQuotes !== false });
  const built = buildSectorStrengthFromData({
    sector: BEIJING_BOARD, members: snapshot.members, context, source: snapshot.source, warning: snapshot.warning
  });
  return {
    ...built, ...BEIJING_BOARD,
    returns: { r1: snapshot.changePct, r3: null, r5: null },
    memberAverageReturn: snapshot.changePct,
    memberCount: snapshot.memberCount,
    memberCoverage: snapshot.memberCoverage,
    quoteCoverage: snapshot.quoteCoverage,
    quoteBasis: snapshot.quoteBasis,
    sourceUrl: snapshot.sourceUrl,
    fetchedAt: snapshot.fetchedAt,
    partial: !snapshot.complete || !snapshot.quoteCoverage.complete,
    warning: snapshot.warning,
    breadth: snapshot.complete && snapshot.quoteCoverage.complete ? built.breadth : null,
    amount: snapshot.complete && snapshot.quoteCoverage.complete ? built.amount : null,
    netInflow: null,
    dataCoveragePercent: snapshot.complete && snapshot.quoteCoverage.complete ? built.dataCoveragePercent : null,
    score: null,
    state: snapshot.complete && snapshot.quoteCoverage.complete ? "成分等权涨幅" : "部分成分 · 涨幅待补",
    scoreMode: snapshot.quoteBasis,
    leaderName: built.leaders[0]?.name || "",
    sourceState: snapshot.complete ? `北交所名录 ${snapshot.members.length} 只 · 同花顺行情 ${snapshot.quoteCoverage.loaded} 只` : "上次核验名录 · 最新总数待核验"
  };
}

async function loadSectorStrength(industryOrSector, context = {}) {
  if (isBeijingSector(industryOrSector)) return loadBeijingSector(context.options || {}, context);
  const requestedName = String(
    typeof industryOrSector === "object"
      ? industryOrSector?.name || industryOrSector?.code || ""
      : industryOrSector || ""
  ).trim();
  let sector = typeof industryOrSector === "object" && industryOrSector?.code
    ? {
        code: industryOrSector.code,
        name: industryOrSector.name || industryOrSector.code,
        secid: industryOrSector.secid || industryOrSector.QuoteID || (/^BK/.test(industryOrSector.code) ? `90.${industryOrSector.code}` : "")
      }
    : null;
  const options = context.options && typeof context.options === "object" ? context.options : {};
  const thsConfigured = Boolean(String(options.refreshToken || "").trim());
  const selectedConcept = industryOrSector?.boardType === "concept";
  const conceptCid = selectedConcept && /^\d+$/.test(String(industryOrSector.conceptCid || "")) ? String(industryOrSector.conceptCid) : "";
  let thsMembers = null;
  if (!selectedConcept && thsConfigured && !providerCircuitOpen("ths-sector")) {
    try {
      thsMembers = await loadThsSectorMembers(sector?.name || requestedName, options);
      recordSectorProviderResult("ths-sector", true);
    } catch {
      recordSectorProviderResult("ths-sector", false);
    }
  }
  if (!selectedConcept && !sector && !providerCircuitOpen("eastmoney-sector-search")) {
    try {
      sector = await findSector(requestedName);
      if (sector) recordSectorProviderResult("eastmoney-sector-search", true);
    } catch {
      recordSectorProviderResult("eastmoney-sector-search", false);
      sector = null;
    }
  }
  const baseSector = sector || { code: "", name: requestedName, secid: "" };
  let history = [];
  let benchmark = Array.isArray(context.benchmark) ? context.benchmark : [];
  if (!benchmark.length) {
    benchmark = await eastHistoryCached(
      { code: "000300", secid: "1.000300" },
      15,
      1,
      5 * 60 * 1000,
      options
    ).catch(() => []);
  }
  if (sector?.code && /^BK/.test(sector.code)) {
    if (!providerCircuitOpen("eastmoney-sector-history")) {
      try {
        history = await eastHistoryCached(
        { code: sector.code, secid: sector.secid },
        15,
        1,
        2 * 60 * 1000,
        options
        );
        recordSectorProviderResult("eastmoney-sector-history", true);
      } catch {
        recordSectorProviderResult("eastmoney-sector-history", false);
        history = [];
      }
    }
  }
  if (thsMembers?.length) {
    return buildSectorStrengthFromData({
      sector: baseSector,
      members: thsMembers,
      history,
      benchmark,
      context,
      source: "同花顺 QuantAPI"
    });
  }
  // 同花顺**官方免费**行情源（d.10jqka.com.cn，无需 token）。
  // 与之前「解析榜单页拿聚合值」不同，这里走同花顺自家的行情网关：
  //   · 板块实时快照  /v6/realhead/48_{code}/defer/last.js
  //   · 板块日K线历史 /v6/line/48_{code}/01/last.js（实测可回溯 4600+ 根）
  //   · 板块成分股    q.10jqka.com.cn/thshy/detail/code/{code}/（逐只明细，非聚合）
  // 因此涨幅、广度、成交额、以及 1/3/5 日超额都能用官方数据算出，不再有「缺失显示 --」。
  if (!providerCircuitOpen("ths-official-sector")) {
    let thsOfficialOk = false;
    try {
      // ── 概念板块优先（必须在行业榜抓取之前判断）──
      // 名称带「概念」后缀，或代码落在概念指数区间（885xxx/886xxx）时，
      // 用户要的是概念板块；行业榜里的近似名（「白酒概念」→ 行业「白酒」）不能抢走。
      // 放在 loadThsPublicSectorTable 之前，避免行业榜抓取失败/超时把概念分支一起带崩。
      const conceptNeedle = String(requestedName || "").replace(/[（(].*?[)）]/g, "").trim();
      const conceptWanted = /概念$/.test(conceptNeedle) || /^(?:885|886)\d{3}$/.test(conceptNeedle) || /^(?:885|886)\d{3}$/.test(String(baseSector.code)) ||
        (typeof industryOrSector === "object" && industryOrSector?.boardType === "concept");
      if (conceptWanted) {
        try {
          const concept = conceptCid ? { cid: conceptCid, name: requestedName,
            platecode: /^(?:885|886)\d{3}$/.test(String(baseSector.code)) ? baseSector.code : "",
            changePct: industryOrSector.changePct, netInflow: industryOrSector.netInflow
          } : await thsOfficial.findThsConcept(fetchWithPolicy, /^(?:885|886)\d{3}$/.test(String(baseSector.code)) ? baseSector.code : conceptNeedle, { signal: serviceSignal() });
          if (concept) {
            const [conceptMembers, conceptHistory] = await Promise.all([
              thsOfficial.fetchThsSectorMembers(fetchWithPolicy, { kind: "concept", cid: concept.cid }, { signal: serviceSignal() }),
              concept.platecode ? thsOfficial.fetchThsDailyHistory(fetchWithPolicy, concept.platecode, { market: "48", limit: 30, signal: serviceSignal() }).catch(() => []) : []
            ]);
            if (conceptMembers.length) {
              recordSectorProviderResult("ths-official-sector", true);
              const built = buildSectorStrengthFromData({
                sector: { name: concept.name, code: concept.platecode, secid: "", boardType: "concept", conceptCid: concept.cid },
                members: conceptMembers,
                history: conceptHistory,
                benchmark,
                context,
                source: "同花顺概念板块",
                summary: { changePct: concept.changePct, netInflow: concept.netInflow },
                // 概念资金流（gnzjl）比 gnSection 的 zjjlr 更细，含流入/流出拆分

                warning: conceptHistory.length ? "" : "概念板块实时成分已取到；历史序列本次未取到，1/3/5 日超额显示为 --。"
              });
              built.boardType = "concept";
              built.conceptCid = concept.cid;
              return built;
            }
          }
        } catch (conceptError) {
          if (selectedConcept) throw conceptError;
        }
      }
      if (selectedConcept) return null;
      // 先定位板块代码（板块名 → 881xxx）。榜单页给出 code，之后全部走行情网关。
      // Known THS codes from the ranking can load stocks directly; a separate
      // ranking-page failure must not block their member endpoint.
      const directCode = /^881\d{3}$/.test(String(baseSector.code)) ? String(baseSector.code) : "";
      const table = directCode ? [] : await loadThsPublicSectorTable(serviceSignal(options.signal)).catch(() => []);
      // 同时支持「按板块名」和「按板块代码（881xxx）」两种入参：
      // 前者来自搜索结果/涨停池，后者来自 URL 参数或列表点击。
      // 之前只按名称匹配，导致 sectorStrength('881270') 直接返回 null，
      // 界面就显示成「详情源尚未取得足够字段，综合评分暂停」。
      const rawNeedle = String(requestedName || baseSector.name || "").trim();
      const needle = rawNeedle.replace(/[（(].*?[)）]/g, "").trim();
      const codeNeedle = /^\d{6}$/.test(needle) ? needle : (/^\d{6}$/.test(String(baseSector.code || "")) ? String(baseSector.code) : "");
      // 资金流接口是更稳的板块目录（90 个、顺序固定），优先用它确认板块是否存在；
      // 榜单页盘前排序不稳定、分页会重叠，靠它匹配容易漏（例如「元件」）。
      let fundHit = directCode ? { ...baseSector, code: directCode } : null;
      try {
        const flows = directCode ? [] : await thsOfficial.fetchThsFundFlow(fetchWithPolicy, "industry", { maxPages: 3, timeoutMs: 7000, signal: serviceSignal() });
        fundHit = fundHit || flows.find((r) => r.name === needle)
          || (codeNeedle ? flows.find((r) => r.code === codeNeedle) : null);
      } catch { /* 资金流不可用则回退榜单页 */ }
      const matched = (codeNeedle ? table.find((r) => r.code === codeNeedle) : null)
        || fundHit
        || table.find((r) => r.name === needle)
        // 双向包含必须「长度接近」，否则查「白酒概念」会被行业「白酒」吃掉
        // （"白酒概念".includes("白酒") === true），进而误判成行业板块。
        || table.find((r) => {
          const a = r.name, b = needle;
          if (!a || !b) return false;
          const shorter = a.length <= b.length ? a : b;
          const longer = a.length <= b.length ? b : a;
          // 短名必须占长名至少 70%，且长度差不超过 4 个字
          return longer.includes(shorter) && (longer.length - shorter.length <= 4);
        });
      // 资金流匹配出的板块没有 code，需要从榜单页表里补一个（成分页要用 881xxx）
      const matchedCode = matched?.code || table.find((r) => r.name === matched?.name)?.code || "";
      if (matched && matchedCode) {
        const signal = serviceSignal(options.signal);
        const [members, history, snapshot] = await Promise.all([
          thsOfficial.fetchThsSectorMembers(fetchWithPolicy, matchedCode, { signal: serviceSignal() }).catch(() => []),
          thsOfficial.fetchThsDailyHistory(fetchWithPolicy, matchedCode, { market: "48", limit: 30, signal: serviceSignal() }).catch(() => []),
          thsOfficial.fetchThsSectorSnapshot(fetchWithPolicy, matchedCode, { signal: serviceSignal() }).catch(() => null)
        ]);
        if (members.length) {
          thsOfficialOk = true;
          recordSectorProviderResult("ths-official-sector", true);
          // 同花顺成分页未登录最多 5 页（100 只）：配置了扶摇 Key 时用扶摇板块成分 + 行情快照补齐其余成分。
          const declaredCount = finiteOrNull(matched.companyCount) ?? finiteOrNull(industryOrSector?.memberCount);
          if (members.length >= 100 && (declaredCount === null || declaredCount > members.length) && fuyao.configured()) {
            try {
              const signal = serviceSignal();
              const full = await fuyao.constituents(`${matchedCode}.TI`, { signal });
              const have = new Set(members.map((item) => item.code));
              const missing = full.filter((item) => /^\d{6}$/.test(item.code) && !have.has(item.code) && isAStockCode(item.code) && !isRiskStockName(item.name));
              if (missing.length) {
                const quotes = await fuyao.snapshot(missing.map((item) => ({ code: item.code, thscode: item.thscode })), { signal });
                for (const item of missing) {
                  const quote = quotes.get(item.thscode) || {};
                  const identifiers = canonicalSecurityIdentifiers(item.code, "stock");
                  // N/C 开头的新股上市前几日不设涨跌幅限制，不能按涨幅标涨停。
                  const target = quote.preClose && quote.latest && !isRiskStockName(item.name) && !/^[NC]/i.test(String(item.name || "").trim()) ? roundPrice(quote.preClose * (1 + priceLimitRate(item.code, item.name))) : null;
                  members.push({ code: item.code, name: item.name, secid: identifiers.secid, thscode: identifiers.thscode,
                    latest: quote.latest ?? null, changePct: quote.changePct ?? null, amount: quote.amount ?? null, turnover: null,
                    high: quote.high ?? null, low: quote.low ?? null, open: quote.open ?? null, preClose: quote.preClose ?? null,
                    isLimitUp: target !== null && isLimitUpPrice(quote.latest, target) });
                }
              }
            } catch { /* 补齐失败时保留同花顺成分页的 100 只 */ }
          }
          const effectiveHistory = history.length ? history : [];
          // 广度口径：优先用榜单页的官方「上涨/下跌家数」（覆盖全量成分），
          // 成分页每页 20 只、最多只能取到 100 只，用它算广度会高估。
          const officialRising = finiteOrNull(matched.rising);
          const officialFalling = finiteOrNull(matched.falling);
          const officialMemberCount = finiteOrNull(matched.companyCount) ?? finiteOrNull(industryOrSector?.memberCount);
          const built = buildSectorStrengthFromData({
            sector: { ...baseSector, name: matched.name, code: matchedCode },
            members,
            history: effectiveHistory,
            benchmark,
            context,
            source: "同花顺官方行情",
            summary: {
              changePct: snapshot?.changePctResolved ?? matched.changePct,
              amount: snapshot?.amount ?? matched.amount,
              rising: officialRising,
              falling: officialFalling,
              memberCount: officialMemberCount
            },
            warning: effectiveHistory.length
              ? ""
              : "同花顺官方行情已返回实时成分；历史序列本次未取到，1/3/5 日超额显示为 --。"
          });
          return built;
        }
        void signal;
      }
      if (!thsOfficialOk) recordSectorProviderResult("ths-official-sector", true);
    } catch (error) {
      if (!thsOfficialOk) recordSectorProviderResult("ths-official-sector", false);
      void error;
    }
  }

  if (selectedConcept) return null;
  if (sector?.code) {
    try {
      const east = await loadEastSectorMembers(sector);
      return buildSectorStrengthFromData({
        sector,
        members: east.members,
        history,
        benchmark,
        context,
        source: east.source,
        warning: east.source === "东方财富延迟节点"
          ? `${thsConfigured ? "同花顺板块主源不可用" : "同花顺主源尚未配置 Refresh Token"}，东方财富实时节点也受限，已切换东方财富延迟节点；缺失项显示为 --。`
          : `${thsConfigured ? "同花顺板块主源不可用" : "同花顺主源尚未配置 Refresh Token"}，已由东方财富实时次源接力。`
      });
    } catch {
      // Continue with independent providers below.
    }
  }
  // 同花顺免费公开板块已可用时，不再降级到新浪，也避免误报「同花顺不可用」。
  if (!providerCircuitOpen("sina-sector")) {
    try {
      const sina = await loadSinaSector(baseSector.name);
      recordSectorProviderResult("sina-sector", true);
      return buildSectorStrengthFromData({
        sector: baseSector,
        members: sina.members,
        history,
        benchmark,
        context,
        source: sina.members.length ? "新浪行业实时" : "新浪行业摘要",
        summary: sina.summary,
        warning: sina.members.length
          ? "已由新浪行业实时成分接力（同花顺实时榜本次未匹配到该板块名）；历史缺失项显示为 --。"
          : `同花顺主源与东方财富次源均不可用；新浪已返回行业摘要，但成分接口本次不可用（${sina.memberError || "未知原因"}），未取得的详情显示为 --。`
      });
    } catch (error) {
      if (error?.code !== "SECTOR_NOT_FOUND") recordSectorProviderResult("sina-sector", false);
    }
  }
  return null;
}

async function sectorStrength(industryOrSector, context = {}) {
  // Fuzzy name matching is for source lookup only. Cache and in-flight identity
  // preserve the requested name, category and codes, including concept suffixes.
  const rawSectorName = String(
    typeof industryOrSector === "object"
      ? industryOrSector?.name || industryOrSector?.code || ""
      : industryOrSector || ""
  ).trim();
  if (!rawSectorName) return null;
  const identity = industryOrSector && typeof industryOrSector === "object" ? industryOrSector : {};
  const code = String(identity.code || (/^(?:BK\d+|\d{6})$/.test(rawSectorName) ? rawSectorName : "")).trim();
  const kind = String(identity.boardType || identity.kind || identity.type ||
    (/^(?:885|886)\d{3}$/.test(code) || /概念$/.test(rawSectorName) ? "concept" : /^881\d{3}$/.test(code) || /行业$/.test(rawSectorName) ? "industry" : "unspecified"));
  const sectorKey = {
    name: rawSectorName,
    code,
    kind,
    secid: String(identity.secid || identity.QuoteID || ""),
    conceptCid: String(identity.conceptCid || identity.cid || ""),
    source: String(identity.source || identity.provider || (/^BK/.test(code) ? "eastmoney" : /^88[156]\d{3}$/.test(code) ? "ths" : "unspecified"))
  };
  const cacheKey = semanticKey({ sector: sectorKey, credential: credentialFingerprint(context.options?.refreshToken), provider: context.options?.provider, marketBreadth: context.marketBreadth, marketAverageReturn: context.marketAverageReturn, ladderPools: context.ladderPools });
  const cached = sectorStrengthCache.get(cacheKey);
  return serviceRuntime.cached(sectorStrengthCache, cacheKey, 90000, async () => {
    let failure;
    try {
      const value = await loadSectorStrength(industryOrSector, context);
      serviceRuntime.checkpoint();
      if (value) return value;
    } catch (error) { serviceRuntime.checkpoint(); failure = error; }
    if (cached?.value && cached.staleUntil > Date.now()) {
      return { ...cached.value, partial: true, sourceState: "上次有效数据接力",
        dataSource: `${cached.value.dataSource || "板块源"}缓存`,
        warning: "实时板块源本次均不可用，已保留最近30分钟内的有效详情；请留意数据时间。" };
    }
    if (failure) throw failure;
    return null;
  }, { forceRefresh: context.options?.forceRefresh === true, staleTtlMs: 30 * 60 * 1000,
    shouldCache: value => Boolean(value) && !value.partial });
}

/**
 * 成分股的涨停状态：同花顺成分页不给昨收价，按价格算不出涨停，表格里涨停股会显示成「正常」。
 * 以当日涨停池为准（与板块「涨停 n」计数同一口径）；涨停池里没有、但涨幅已到涨停幅度的也算涨停。
 */
function markMemberLimitUps(constituents, ladderPools) {
  const pool = new Set((ladderPools?.currentPool || []).map((item) => String(item?.code || "")));
  return (Array.isArray(constituents) ? constituents : []).map((item) => {
    if (!item || typeof item !== "object") return item;
    const code = String(item.code || "");
    const changePct = finiteOrNull(item.changePct);
    const name = String(item.name || "").trim();
    // 新股上市前几日（N/C 开头）不设涨跌幅限制，只认涨停池；ST 按交易所现行限幅（沪深主板自 2026-07-06 起为 10%）。
    const rate = /^[NC]/i.test(name) ? null : priceLimitRate(code, name);
    // 有今天的实时行情（含昨收）时按价格判断：开盘前涨停池可能还是上一交易日的，不能用。
    if (item.quoteStatus === "live" && finiteOrNull(item.preClose) && finiteOrNull(item.latest) && rate !== null) {
      return { ...item, isLimitUp: isLimitUpPrice(item.latest, roundPrice(item.preClose * (1 + rate))), limitStatusKnown: true };
    }
    // 有价格时按涨停价判断（低价股的涨停幅度四舍五入后可能不到 9.88%，如 1.24→1.36 是 +9.68%）；只有涨幅时才用百分比容差。
    const latest = finiteOrNull(item.latest);
    const impliedPreClose = latest !== null && changePct !== null && changePct > -100 ? latest / (1 + changePct / 100) : null;
    const byChange = rate !== null && changePct !== null && (impliedPreClose
      ? isLimitUpPrice(latest, roundPrice(roundPrice(impliedPreClose) * (1 + rate)))
      : changePct >= rate * 100 - 0.12);
    return { ...item, isLimitUp: pool.has(code) || item.isLimitUp === true || byChange, limitStatusKnown: true };
  });
}

async function analyzeSector(input, options = {}) {
  if (isBeijingSector(input)) {
    const beijingOptions = { ...options, forceRefresh: options.forceRefresh === true || input?.forceRefresh === true, waitForQuotes: input?.waitForQuotes !== false };
    const result = await loadBeijingSector(beijingOptions);
    const funds = await sectorFundFlows.load(result.constituents, beijingOptions);
    // 实时行情覆盖后按覆盖后的价格重判涨停（北交所 30%；涨停池不含北交所，只按价格判断）。
    const rows = markMemberLimitUps(funds.rows, null);
    const limitUps = rows.filter((item) => item?.isLimitUp).length;
    return { ...result, constituents: rows, limitUps, fundFlow: funds.fundFlow, leaders: rows.slice(0, 8) };
  }
  // IPC callers pass either a query string or a ranking row. Preserve the row's
  // identity even if a fallback source did not supply a code.
  const objectInput = input && typeof input === "object" ? input : null;
  options = { ...options, forceRefresh: options.forceRefresh === true || objectInput?.forceRefresh === true };
  const query = String(objectInput ? objectInput.name || objectInput.query || objectInput.code || "" : input || "").trim();
  if (!query) throw new Error("请输入板块名称或代码");
  let sector = objectInput
    ? { code: String(objectInput.code || ""), name: query, secid: String(objectInput.secid || ""), memberCount: finiteOrNull(objectInput.memberCount),
        ...(objectInput.boardType === "concept" ? { boardType: "concept", conceptCid: objectInput.conceptCid,
          changePct: finiteOrNull(objectInput.returns?.r1), netInflow: finiteOrNull(objectInput.netInflow) } : {}) }
    : null;
  if (!sector) {
    const matches = await searchSectors(query).catch(() => []);
    sector = matches.find((item) => item.name.toLowerCase() === query.toLowerCase()) || null;
  }
  if (!sector) {
    const fallbackName = query;
    sector = { code: /^\d{6}$/.test(query) ? query : "", name: fallbackName, secid: "" };
  }
  const [benchmark, { rows: allMarketHistory, label: marketProxy }, marketSnapshot, ladderPools] = await Promise.all([
    hs300History(15, options).catch(() => []),
    marketProxyHistory(15, options),
    // A2-03：快照整体失败 = 市场广度/平均收益未知，不能退化成"广度 50% / 涨幅 0%"。
    wholeMarketSnapshot(options).catch(() => ({ breadth: null, averageReturn: null, stockCount: 0 })),
    currentLadderPools(options).catch(() => ({
      currentPool: [],
      previousPool: [],
      failedPool: null,
      failedPoolAvailable: false
    }))
  ]);
  const allMarketReturns = {
    r1: allMarketHistory.length >= 2 ? returnFor(allMarketHistory, 1) : null,
    r3: allMarketHistory.length >= 4 ? returnFor(allMarketHistory, 3) : null,
    r5: allMarketHistory.length >= 6 ? returnFor(allMarketHistory, 5) : null
  };
  const result = await sectorStrength(sector, {
    benchmark,
    marketBreadth: marketSnapshot.breadth,
    marketAverageReturn: marketSnapshot.averageReturn,
    ladderPools,
    options
  });
  if (!result) throw new Error(`板块 ${sector.name} 暂无行情数据`);
  // 资金流请求顺带取实时行情：同花顺成分页开盘前后还是上一交易日的成交额，以实时行情覆盖后再判断涨停、排序。
  const funds = await sectorFundFlows.load(result.constituents, options);
  funds.rows = markMemberLimitUps(funds.rows, ladderPools).sort((left, right) => (finiteOrNull(right.changePct) ?? -Infinity) - (finiteOrNull(left.changePct) ?? -Infinity));
  const isConcept = sector.boardType === "concept" || result.boardType === "concept";
  const identity = { boardType: isConcept ? "concept" : "industry", name: result.name || sector.name,
    code: String(result.code || sector.code || ""), conceptCid: isConcept ? String(result.conceptCid || sector.conceptCid || "") : "",
    memberCount: result.memberCount ?? sector.memberCount ?? null };
  const supportsCount = isConcept ? Boolean(identity.conceptCid) : /^881\d{3}$/.test(identity.code);
  const count = supportsCount ? await getSectorLimitUpCount(identity, options).catch(() => null) : null;
  if (count?.limitUps !== null && count?.limitUps !== undefined) {
    const codes = new Set(count.limitUpStocks.map(stock => stock.code));
    const have = new Set(funds.rows.map(stock => stock.code));
    for (const stock of count.limitUpStocks) {
      if (!have.has(stock.code)) funds.rows.push({ ...stock, ...canonicalSecurityIdentifiers(stock.code, "stock"), quoteStatus: "unavailable" });
    }
    funds.rows = funds.rows.map(stock => ({ ...stock, isLimitUp: codes.has(stock.code), limitStatusKnown: true }));
  }
  const limitUpStocks = funds.rows.filter((item) => item.isLimitUp);
  const limitUps = count ? count.limitUps : funds.rows.length ? limitUpStocks.length : result.limitUps;
  return {
    ...result,
    constituents: funds.rows,
    fundFlow: funds.fundFlow,
    limitCount: count,
    countComplete: count?.countComplete ?? false,
    limitUpStocks,
    limitUps,
    poolLimitUps: limitUps,
    poolShare: limitUps != null && ladderPools.currentPool.length ? limitUps / ladderPools.currentPool.length : null,
    totalPool: ladderPools.currentPool.length,
    allMarketReturns,
    marketSnapshot,
    marketProxy,
    leaders: funds.rows.slice(0, 8)
  };
}

function scoreAnnouncement(item) {
  const title = item.title || "";
  const date = new Date(item.display_time || item.notice_date);
  const ageHours = Math.max(0, (Date.now() - date.getTime()) / 3600000);
  const classification = classifyEvent(title, "", "B");
  const freshness = ageHours < 24 ? 20 : ageHours < 72 ? 15 : ageHours < 168 ? 9 : 3;
  return {
    ...item,
    category: item.columns?.[0]?.column_name || "公司公告",
    score: Math.max(0, Math.min(100, classification.importanceScore + freshness - 10)),
    impactScore: classification.importanceScore,
    confidenceScore: classification.credibilityScore,
    riskSeverity: classification.riskSeverity,
    direction: classification.direction,
    reasons: classification.reasons,
    sourceLevel: "B",
    transportProvider: "东方财富公开网页",
    originAuthority: "待原始披露平台核验"
  };
}

const announcementCache = new BoundedCache({ maxBytes: 2 * 1024 * 1024, maxEntries: 256, staleTtlMs: 0, now: () => Date.now() });
/** 个股公告（东方财富公开公告，最近 8 条，已标方向和风险等级）：AI 打分的「消息公告」维度用，缓存 15 分钟。 */
function stockAnnouncements(code) {
  const value = String(code || "");
  if (!/^\d{6}$/.test(value)) return Promise.resolve([]);
  return serviceRuntime.cached(announcementCache, `ann:${value}`, 15 * 60 * 1000, () => announcements(value));
}

async function announcements(code) {
  const url =
    "https://np-anotice-stock.eastmoney.com/api/security/ann" +
    `?sr=-1&page_size=8&page_index=1&ann_type=A&client_source=web&stock_list=${encodeURIComponent(String(code))}`;
  const json = await fetchJson(url);
  return (json?.data?.list || []).map(scoreAnnouncement);
}

function sourceFromQuote(id, name, quote, options = {}) {
  return {
    id,
    name,
    kind: options.kind || "实时行情",
    role: options.role || "交叉校验",
    enabled: true,
    ok: Boolean(quote && Number.isFinite(Number(quote.latest)) && Number(quote.latest) > 0),
    realtime: options.realtime !== false,
    latest: Number(quote?.latest),
    preClose: Number(quote?.preClose),
    open: Number(quote?.open),
    high: Number(quote?.high),
    low: Number(quote?.low),
    change: Number(quote?.change),
    changePct: Number(quote?.changePct),
    updatedAt: quote?.updatedAt || new Date().toISOString(),
    latencyMs: Number.isFinite(options.latencyMs) ? options.latencyMs : null,
    message: options.message || ""
  };
}

function quoteProviderMeta(provider) {
  if (provider === "fuyao") {
    return { id: "ths", name: "同花顺扶摇行情", kind: "同花顺官方数据接口 · API Key" };
  }
  if (provider === "ths_free") {
    // 与 QuantAPI 共用「同花顺」这一路展示位（界面三线：同花顺 / 东方财富 / 腾讯）。
    return {
      id: "ths",
      name: "同花顺免费行情",
      kind: "同花顺官方网页行情 · 免费"
    };
  }
  if (provider === "ths") {
    return {
      id: "ths",
      name: "同花顺 QuantAPI",
      kind: "官方 QuantAPI"
    };
  }
  if (provider === "tencent") {
    return {
      id: "tencent",
      name: "腾讯公开行情",
      kind: "免费公开行情"
    };
  }
  return {
    id: "eastmoney",
    name: "东方财富行情",
    kind: "免费公开行情"
  };
}

async function timedQuoteSource(factory, fallback) {
  const startedAt = Date.now();
  try {
    const quote = await factory();
    return sourceFromQuote(fallback.id, fallback.name, quote, {
      ...fallback,
      latencyMs: Date.now() - startedAt
    });
  } catch (error) {
    return {
      ...fallback,
      enabled: true,
      ok: false,
      realtime: true,
      latencyMs: Date.now() - startedAt,
      message: error?.name === "AbortError" ? "请求超时" : String(error?.message || error)
    };
  }
}

async function quoteFederation(security, core, settings) {
  const primaryIsThs = core.actualProvider === "ths" || core.actualProvider === "ths_free" || core.actualProvider === "fuyao";
  const requestedThs =
    (core.requestedPrimary || settings.provider || "eastmoney") === "ths";
  const primaryMeta = quoteProviderMeta(core.actualProvider);
  const primary = sourceFromQuote(
    primaryMeta.id,
    primaryMeta.name,
    core.quote,
    {
      kind: primaryMeta.kind,
      role:
        primaryIsThs || !requestedThs ? "主数据源" : "故障接力",
      latencyMs: core.providerLatencyMs
    }
  );
  if (settings.multiSourceEnabled === false) {
    return buildQuoteConsensus([primary]);
  }

  const auxiliaryPromise = collectAuxiliarySources(security, settings);
  let secondaryPromise;
  if (primaryIsThs) {
    const publicQuote = core.verificationQuote;
    const verificationMeta = quoteProviderMeta(
      core.verificationProvider || "eastmoney"
    );
    secondaryPromise = Promise.resolve(
      publicQuote
        ? sourceFromQuote(verificationMeta.id, verificationMeta.name, publicQuote, {
            kind: "免费公开行情",
            role: "交叉校验"
          })
        : timedQuoteSource(
            () => eastQuote(security),
            {
              id: "eastmoney",
              name: "东方财富行情",
              kind: "免费公开行情",
              role: "交叉校验"
            }
          )
    );
  } else if (requestedThs && !String(settings.refreshToken || "").trim()) {
    // 同花顺免费行情本轮没有成功（主源已由东方财富/腾讯接力）：再试一次，把真实状态展示出来。
    secondaryPromise = timedQuoteSource(
      () => trackedThsFreeQuote(security),
      {
        id: "ths",
        name: "同花顺免费行情",
        kind: "同花顺官方网页行情 · 免费",
        role: "主数据源"
      }
    );
  } else if (settings.refreshToken) {
    secondaryPromise = timedQuoteSource(
      () => thsQuote(security, settings),
      {
        id: "ths",
        name: "同花顺 QuantAPI",
        kind: "官方 QuantAPI",
        role: requestedThs ? "主数据源" : "交叉校验"
      }
    );
  } else {
    secondaryPromise = Promise.resolve({
      id: "ths",
      name: "同花顺 QuantAPI",
      kind: "官方 QuantAPI",
      role: "交叉校验",
      enabled: false,
      ok: null,
      realtime: true,
      message: "未配置 Refresh Token"
    });
  }

  const eastVerifierPromise =
    primaryMeta.id === "eastmoney" || primaryIsThs
      ? Promise.resolve(null)
      : timedQuoteSource(() => eastQuote(security), {
          id: "eastmoney",
          name: "东方财富行情",
          kind: "免费公开行情",
          role: "交叉校验"
        });
  const [auxiliary, secondary, eastVerifier] = await Promise.all([
    auxiliaryPromise,
    secondaryPromise,
    eastVerifierPromise
  ]);
  // 三线实时行情只呈现同花顺、东方财富、腾讯；Tushare 保留给历史复核，
  // 不与实时行情源混在同一状态栏里。
  const realtimeAuxiliary = auxiliary.filter((source) => source.id === "tencent");
  const sources = [primary, secondary, eastVerifier, ...realtimeAuxiliary]
    .filter(Boolean)
    .filter((source, index, rows) =>
      rows.findIndex((item) => item.id === source.id) === index
    );
  return {
    ...buildQuoteConsensus(sources),
    topology: {
      primary: requestedThs ? "ths" : primaryMeta.id,
      verification: ["eastmoney", "tencent"],
      primaryStatus: core.primaryStatus || (primaryIsThs ? "active" : "fallback"),
      health: getMarketSourceHealth().quotes
    }
  };
}

async function dataByProvider(security, settings = {}) {
  const serviceSettings = settings || {};
  const startedAt = Date.now();
  if (serviceSettings.provider !== "ths") {
    const [publicQuote, history] = await Promise.all([
      publicQuoteWithFallback(security),
      eastHistoryCached(security, 160, 1, 8 * 60 * 1000, serviceSettings)
    ]);
    return {
      quote: publicQuote.quote,
      history,
      actualProvider: publicQuote.actualProvider,
      requestedPrimary: "eastmoney",
      primaryStatus: "active",
      warning: publicQuote.warning,
      providerLatencyMs: Date.now() - startedAt
    };
  }
  if (!String(serviceSettings.refreshToken || "").trim()) {
    // 未配置 QuantAPI：同花顺免费行情为主源。东方财富报价同时取一次，
    // 既补行业/涨跌停等免费网关没有的字段，也作为交叉校验；同一请求被接力链复用。
    let eastPromise = null;
    const eastOnce = () => (eastPromise ||= eastQuote(security, 6000));
    const eastVerification = marketSourceHealth.isOpen("eastmoney")
      ? Promise.resolve(null)
      : eastOnce().then((quote) => { rememberIndustry(quote); return quote; }, () => null);
    const [freeQuote, history, verification] = await Promise.all([
      marketQuoteChain(security, { eastFactory: eastOnce }),
      eastHistoryCached(security, 160, 1, 8 * 60 * 1000, serviceSettings),
      eastVerification
    ]);
    const quote = { ...freeQuote.quote };
    if (verification && freeQuote.actualProvider !== "eastmoney") {
      if (!quote.industry || quote.industry === "未分类") quote.industry = verification.industry;
      if (!(quote.limitUp > 0)) quote.limitUp = verification.limitUp;
      if (!(quote.limitDown > 0)) quote.limitDown = verification.limitDown;
    }
    if (!quote.industry) quote.industry = "未分类";
    return {
      quote,
      history,
      actualProvider: freeQuote.actualProvider,
      requestedPrimary: "ths",
      primaryStatus: ["fuyao", "ths_free"].includes(freeQuote.actualProvider) ? "free_active" : "fallback",
      warning: freeQuote.warning,
      verificationQuote: freeQuote.actualProvider === "eastmoney" ? null : verification,
      verificationProvider: verification ? "eastmoney" : "",
      providerLatencyMs: Date.now() - startedAt
    };
  }
  try {
    const [[quote, history], publicMeta] = await Promise.all([
      Promise.all([
        thsQuote(security, serviceSettings),
        thsHistoryCached(security, serviceSettings)
      ]),
      publicQuoteWithFallback(security).catch(() => null)
    ]);
    if (publicMeta?.quote) {
      quote.name = publicMeta.quote.name;
      quote.industry = publicMeta.quote.industry;
      quote.secid = publicMeta.quote.secid;
      quote.limitUp = publicMeta.quote.limitUp;
      quote.limitDown = publicMeta.quote.limitDown;
    }
    return {
      quote,
      history,
      actualProvider: "ths",
      requestedPrimary: "ths",
      primaryStatus: "active",
      warning: "",
      verificationQuote: publicMeta?.quote || null,
      verificationProvider: publicMeta?.actualProvider || "",
      providerLatencyMs: Date.now() - startedAt
    };
  } catch (error) {
    if (serviceSettings.fallbackEnabled === false) throw error;
    const [publicQuote, history] = await Promise.all([
      marketQuoteChain(security),
      eastHistoryCached(security, 160, 1, 8 * 60 * 1000, serviceSettings)
    ]);
    if (!publicQuote.quote.industry) publicQuote.quote.industry = "未分类";
    return {
      quote: publicQuote.quote,
      history,
      actualProvider: publicQuote.actualProvider,
      requestedPrimary: "ths",
      primaryStatus: "unavailable",
      warning: [
        `同花顺 QuantAPI 连接失败，已切换${QUOTE_SOURCE_LABELS[publicQuote.actualProvider] || "免费行情"}：${error.message}`,
        publicQuote.warning
      ].filter(Boolean).join(" "),
      providerLatencyMs: Date.now() - startedAt
    };
  }
}

async function analyzeSecurity(input, settings = {}) {
  settings = settings || {};
  const security = toSecurity(input);
  if (!/^\d{6}$/.test(security.code)) throw new Error("请输入正确的6位股票代码");
  const core = await dataByProvider(security, settings);
  const isStockAsset = security.assetType === "stock";
  if (isStockAsset && isRiskStockName(core.quote.name)) {
    throw new Error(`${core.quote.name} 属于 ST 或退市风险股票，已按策略剔除`);
  }
  const [
    news,
    marketEmotion,
    marketSnapshot,
    ladderPools,
    replayHistory,
    replayBenchmarkHistory
  ] = await Promise.all([
    isStockAsset ? announcements(security.code).catch(() => []) : Promise.resolve([]),
    marketEmotionSnapshot(settings).catch(() => null),
    isStockAsset
      ? wholeMarketSnapshot(settings).catch(() => ({ breadth: null, averageReturn: null }))
      // 非股票资产（ETF / 可转债）本就不参与板块强弱，保留中性的 50% 广度占位，语义是"不适用"而非"取不到"。
      : Promise.resolve({ breadth: 0.5, averageReturn: 0 }),
    isStockAsset
      ? currentLadderPools(settings).catch(() => ({
          currentPool: [],
          previousPool: [],
          failedPool: null,
          failedPoolAvailable: false
        }))
      : Promise.resolve({ currentPool: [], previousPool: [], failedPool: null, failedPoolAvailable: false }),
    isStockAsset
      ? eastHistoryCached(security, 420, 0, 30 * 60 * 1000, settings).catch(() => core.history)
      : Promise.resolve(core.history),
    isStockAsset
      ? eastHistoryCached(
          { code: "000985", secid: "1.000985", thscode: "000985.SH" },
          420,
          0,
          30 * 60 * 1000,
          settings
        ).catch(() => [])
      : Promise.resolve([])
  ]);
  const dataFederation = await quoteFederation(security, core, settings).catch(() => {
    const providerMeta = quoteProviderMeta(core.actualProvider);
    return buildQuoteConsensus([
      sourceFromQuote(providerMeta.id, providerMeta.name, core.quote, {
        kind: providerMeta.kind,
        role: core.actualProvider === "ths" ? "主数据源" : "故障接力",
        latencyMs: core.providerLatencyMs
      })
    ]);
  });
  const sector = isStockAsset
    ? await sectorStrength(core.quote.industry, {
        marketBreadth: marketSnapshot.breadth,
        marketAverageReturn: marketSnapshot.averageReturn,
        ladderPools,
        options: settings
      }).catch(() => null)
    : null;
  const analysis = analyzeHistory(
    security,
    core.quote,
    core.history,
    sector,
    marketEmotion,
    replayBenchmarkHistory,
    replayHistory !== core.history && Number(replayHistory.actualAdjustment) === 0 ? replayHistory : []
  );
  const isSearchOnlyAsset =
    security.assetType === "etf" || security.assetType === "convertibleBond";
  analysis.analysisScope = isSearchOnlyAsset
    ? "searchOnlyAsset"
    : analysis.limitEvent
      ? "limitUpEvent"
      : "generalStock";
  analysis.limitUpContextAvailable = Boolean(analysis.limitEvent);
  if (isSearchOnlyAsset) {
    const assetLabel = security.assetType === "etf" ? "ETF" : "可转债";
    const trendPassed = Boolean(analysis.maBull && analysis.slopesUp);
    const volumePassed = Number(analysis.volumeRatio || 0) <= 1.8;
    const volatilityPassed =
      Number(analysis.closePosition || 0) >= 0.35 &&
      Number(analysis.volumeRatio || 0) <= 2.2;
    const assetRiskReasons = [];
    if (Number(analysis.divergence || 0) > 12) assetRiskReasons.push("均线乖离偏热");
    if (Number(analysis.volumeRatio || 0) > 2.2) assetRiskReasons.push("量能异常放大");
    if (Number(analysis.closePosition || 0) < 0.2) assetRiskReasons.push("日内收盘位置偏弱");
    const assetWindow = core.history.slice(-10);
    const assetVolume = assetWindow.reduce(
      (sum, item) => sum + Math.max(0, Number(item.volume || 0)),
      0
    );
    const assetWeightedPrice = assetWindow.reduce((sum, item) => {
      const typicalPrice =
        (Number(item.high || item.close || 0) +
          Number(item.low || item.close || 0) +
          Number(item.close || 0)) / 3;
      return sum + typicalPrice * Math.max(0, Number(item.volume || 0));
    }, 0);
    const assetRangeWindow = core.history.slice(-20);
    const assetWindowHigh = Math.max(...assetRangeWindow.map((item) => Number(item.high || 0)));
    const assetWindowLow = Math.min(...assetRangeWindow.map((item) => Number(item.low || 0)));
    analysis.assetType = security.assetType;
    analysis.assetLabel = assetLabel;
    analysis.isSearchOnlyAsset = true;
    analysis.limitEvent = null;
    analysis.daysSince = null;
    analysis.exactNode = null;
    analysis.nextNode = null;
    analysis.heldSupport = true;
    analysis.supportDistance = 0;
    analysis.eventCount60 = 0;
    analysis.isLowFirstBoard = false;
    analysis.platformHigh = 0;
    analysis.platformRange = 0;
    analysis.avwap = assetVolume ? assetWeightedPrice / assetVolume : 0;
    analysis.maxDrawdown =
      assetWindowHigh > 0 && Number.isFinite(assetWindowLow)
        ? ((assetWindowHigh - assetWindowLow) / assetWindowHigh) * 100
        : 0;
    analysis.structureScore = clampScore(
      (analysis.maBull ? 35 : 10) +
        (analysis.slopesUp ? 25 : 5) +
        (Number(core.history.at(-1)?.close || 0) > Number(analysis.ma5 || 0) ? 20 : 0) +
        (volumePassed ? 10 : 3) +
        (Number(analysis.closePosition || 0) >= 0.5 ? 10 : 3)
    );
    analysis.firstBoardQuality = null;
    analysis.sectorLadder = null;
    analysis.sectorLadderScore = 0;
    analysis.infoScore = 50;
    analysis.infoRiskSeverity = 0;
    analysis.infoRiskPenalty = 0;
    analysis.nodeScore = 50;
    analysis.risks = assetRiskReasons;
    analysis.riskPenalty = assetRiskReasons.length * 6;
    analysis.mrs = clampScore(
      analysis.structureScore * 0.62 +
        analysis.marketScore * 0.18 +
        (volumePassed ? 12 : 4) +
        (volatilityPassed ? 8 : 2) -
        analysis.riskPenalty
    );
    analysis.grade =
      analysis.mrs >= 85 ? "S" : analysis.mrs >= 75 ? "A" : analysis.mrs >= 60 ? "B" : "C";
    analysis.historicalStats = null;
    analysis.historicalEdge = null;
    analysis.strategyResults = [
      {
        id: "trend",
        label: "均线趋势",
        matched: trendPassed,
        detail: analysis.trendLabel
      },
      {
        id: "contraction",
        label: "量能结构",
        matched: volumePassed,
        detail: `量能倍数 ${Number(analysis.volumeRatio || 0).toFixed(2)}x`
      },
      {
        id: "volatility",
        label: "波动与收盘质量",
        matched: volatilityPassed,
        detail: `收盘位置 ${(Number(analysis.closePosition || 0) * 100).toFixed(0)}%`
      },
      {
        id: "riskVeto",
        label: "风险观察",
        matched: assetRiskReasons.length === 0,
        detail: assetRiskReasons.join("；") || "未发现明显量价风险"
      }
    ];
    analysis.strategyMatched = analysis.strategyResults.filter((item) => item.matched).length;
    analysis.strategyTotal = analysis.strategyResults.length;
    analysis.strategyMatchRate = Math.round(
      (analysis.strategyMatched / analysis.strategyTotal) * 100
    );
    analysis.strategyQualified = false;
    analysis.alertQualified = false;
    analysis.qualification = {
      strategyMatched: false,
      scoreMatched: false,
      nodeMatched: false,
      riskVetoPassed: assetRiskReasons.length === 0,
      historicalEdgePassed: false,
      historicalEdgePenalty: 0,
      alertScore: Number(settings.alertScore || 75),
      exactNodesOnly: false,
      vetoReasons: assetRiskReasons,
      note: `${assetLabel} 不进入A股涨停策略、观察池和自动交易信号`
    };
    analysis.tradePlan = buildTradePlan(analysis, core.quote, core.history, settings);
    if (analysis.tradePlan) analysis.tradePlan.signal = "WAIT";
    analysis.actionSignal = "WAIT";
    analysis.tradeExecutionReadiness = buildTradeExecutionReadiness(
      analysis,
      analysis.tradePlan,
      settings
    );
    analysis.executionReadiness = analysis.tradeExecutionReadiness;
    return {
      security: { ...security, name: core.quote.name },
      quote: { ...core.quote, assetType: security.assetType, assetLabel },
      history: core.history.slice(-90),
      analysis,
      sector: null,
      dataFederation,
      announcements: news,
      actualProvider: core.actualProvider,
      warning: `${assetLabel} 支持行情与多周期 K 线；不参与A股涨停策略筛选`,
      updatedAt: new Date().toISOString()
    };
  }
  const limitPool = analysis.limitEvent
    ? await topicPoolForDate(analysis.limitEvent.date, "limit", settings).catch(() => null)
    : null;
  const poolRecord = limitPool?.pool?.find((item) => item.code === security.code) || null;
  analysis.firstBoardQuality = analysis.limitEvent
    ? scoreFirstBoardQuality(poolRecord, analysis)
    : null;
  analysis.sectorLadder = sector?.ladder || null;
  analysis.sectorLadderScore = sector?.ladder?.score || 0;

  const recentNews = news.slice(0, 8);
  const positiveImpact = recentNews
    .filter((item) => item.direction === "positive")
    .reduce((max, item) => Math.max(max, Number(item.impactScore || item.score || 0)), 0);
  const negativeImpact = recentNews
    .filter((item) => item.direction === "negative" || item.direction === "mixed")
    .reduce((max, item) => Math.max(max, Number(item.impactScore || item.score || 0)), 0);
  analysis.infoRiskSeverity = recentNews.reduce(
    (max, item) => Math.max(max, Number(item.riskSeverity || 0)),
    0
  );
  analysis.infoScore = news.length
    ? Math.round(Math.max(0, Math.min(100, 50 + positiveImpact * 0.42 - negativeImpact * 0.48)))
    : 50;
  analysis.infoRiskPenalty =
    analysis.infoRiskSeverity >= 3 ? 25 :
      analysis.infoRiskSeverity === 2 ? 12 :
        analysis.infoRiskSeverity === 1 ? 5 : 0;
  if (analysis.infoRiskPenalty) {
    analysis.riskPenalty += analysis.infoRiskPenalty;
    const riskNews = recentNews.find((item) => Number(item.riskSeverity || 0) === analysis.infoRiskSeverity);
    analysis.risks.push(
      analysis.infoRiskSeverity >= 3
        ? `重大公告风险：${riskNews?.title || "高风险事件"}`
        : `资讯风险级别 ${analysis.infoRiskSeverity}`
    );
  }

  const strategyDefinitions = strategyDefinitionsFor(analysis, core.quote);
  const selectedSet = new Set(
    Array.isArray(settings.selectedStrategies)
      ? settings.selectedStrategies
      : ["support", "avwap", "trend", "contraction", "sector"]
  );
  selectedSet.add("riskVeto");
  const selectedIds = [...selectedSet];
  analysis.risks = Array.isArray(analysis.risks) ? analysis.risks : [];
  analysis.historicalStats = await buildHistoricalStrategyStatsInWorker(
    replayHistory,
    security.code,
    core.quote.name,
    selectedIds,
    replayBenchmarkHistory
  );
  analysis.historicalEdge = edgeGateFromStats(analysis.historicalStats, {
    strictGate: Boolean(settings.strictGate)
  });
  analysis.riskPenalty += Number(analysis.historicalEdge?.penalty || 0);
  if (analysis.historicalEdge?.reasons?.length) {
    analysis.risks.push(...analysis.historicalEdge.reasons);
  }
  analysis.mrs = clampScore(
    analysis.structureScore * 0.35 +
      analysis.sectorScore * 0.3 +
      analysis.infoScore * 0.2 +
      analysis.marketScore * 0.1 +
      analysis.nodeScore * 0.05 -
      analysis.riskPenalty
  );
  analysis.grade =
    analysis.mrs >= 85 ? "S" : analysis.mrs >= 75 ? "A" : analysis.mrs >= 60 ? "B" : "C";
  analysis.strategyResults = strategyDefinitions.filter((item) => selectedIds.includes(item.id));
  const gateIds = new Set(["riskVeto", "exactNode"]);
  const scoringResults = analysis.strategyResults.filter((item) => !gateIds.has(item.id));
  analysis.strategyMatched = scoringResults.filter((item) => item.matched).length;
  analysis.strategyTotal = scoringResults.length;
  analysis.strategyMatchRate = analysis.strategyTotal
    ? Math.round((analysis.strategyMatched / analysis.strategyTotal) * 100)
    : 0;
  const riskVeto = strategyDefinitions.find((item) => item.id === "riskVeto");
  const exactNodeIsGate = Boolean(settings.exactNodesOnly || selectedSet.has("exactNode"));
  const nodeMatched = !exactNodeIsGate || Boolean(analysis.exactNode);
  analysis.presetRequirements = evaluateAnalysisPresetRequirements(selectedIds, analysis.strategyResults);
  analysis.strategyQualified =
    analysis.presetRequirements.passed &&
    analysis.strategyTotal > 0 &&
    analysis.strategyMatchRate >= 70 &&
    Boolean(analysis.historicalEdge?.passed) &&
    Boolean(riskVeto?.matched) &&
    nodeMatched;
  analysis.alertQualified =
    analysis.strategyQualified &&
    analysis.mrs >= Number(settings.alertScore || 75);
  analysis.qualification = {
    strategyMatched: analysis.strategyQualified,
    scoreMatched: analysis.mrs >= Number(settings.alertScore || 75),
    nodeMatched,
    presetRequirements: analysis.presetRequirements,
    riskVetoPassed: Boolean(riskVeto?.matched),
    historicalEdgePassed: Boolean(analysis.historicalEdge?.passed),
    historicalEdgePenalty: analysis.historicalEdge?.penalty || 0,
    alertScore: Number(settings.alertScore || 75),
    exactNodesOnly: exactNodeIsGate,
    vetoReasons: [
      ...(riskVeto?.matched ? [] : String(riskVeto?.detail || "").split("、").filter(Boolean)),
      ...analysis.presetRequirements.missingFactors.map(id => `命名组合必要条件未满足：${id}`)
    ]
  };
  analysis.tradePlan = buildTradePlan(analysis, core.quote, core.history, settings);
  analysis.actionSignal = analysis.tradePlan?.signal || (analysis.alertQualified ? "BUY" : "WAIT");
  const tradeExecutionReadiness = buildTradeExecutionReadiness(
    analysis,
    analysis.tradePlan,
    settings
  );
  analysis.tradeExecutionReadiness = tradeExecutionReadiness;
  analysis.executionReadiness = tradeExecutionReadiness;
  return {
    security: { ...security, name: core.quote.name },
    quote: core.quote,
    history: core.history.slice(-90),
    analysis,
    sector,
    dataFederation,
    announcements: news,
    actualProvider: core.actualProvider,
    warning: core.warning,
    updatedAt: new Date().toISOString()
  };
}

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

async function getQuoteSnapshot(input, settings = {}) {
  const security = toSecurity(input);
  if (!/^\d{6}$/.test(security.code)) throw new Error("请输入正确的6位股票代码");
  const startedAt = Date.now();
  const selectedThs = settings.provider === "ths";
  if (selectedThs && !String(settings.refreshToken || "").trim()) {
    // 未配置 QuantAPI：同花顺免费行情为主源，东方财富/腾讯接力。
    const freeQuote = await marketQuoteChain(security);
    return {
      quote: freeQuote.quote,
      actualProvider: freeQuote.actualProvider,
      requestedPrimary: "ths",
      primaryStatus: ["fuyao", "ths_free"].includes(freeQuote.actualProvider) ? "free_active" : "fallback",
      warning: freeQuote.warning,
      updatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt
    };
  }
  let thsFailure = null;
  if (selectedThs) {
    try {
      const quote = await thsQuote(security, settings);
      return {
        quote,
        actualProvider: "ths",
        requestedPrimary: "ths",
        primaryStatus: "active",
        updatedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt
      };
    } catch (error) {
      if (settings.fallbackEnabled === false) throw error;
      thsFailure = error;
    }
  }
  const publicQuote = selectedThs
    ? await marketQuoteChain(security)
    : await publicQuoteWithFallback(security);
  return {
    quote: publicQuote.quote,
    actualProvider: publicQuote.actualProvider,
    requestedPrimary: selectedThs ? "ths" : "eastmoney",
    primaryStatus: selectedThs ? "unavailable" : "active",
    warning: [
      thsFailure
        ? `同花顺 QuantAPI 暂不可用，已切换${QUOTE_SOURCE_LABELS[publicQuote.actualProvider] || "免费行情"}。`
        : "",
      publicQuote.warning
    ].filter(Boolean).join(" "),
    updatedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt
  };
}

async function getDataFederation(input, settings = {}) {
  const security = toSecurity(input);
  if (!/^\d{6}$/.test(security.code)) throw new Error("请输入正确的6位股票代码");
  const key = [
    security.code,
    settings.provider || "eastmoney",
    settings.multiSourceEnabled === false ? "single" : "multi",
    credentialFingerprint(settings.refreshToken, settings.tushareToken),
    settings.fallbackEnabled === false ? "strict" : "fallback"
  ].join(":");
  return serviceRuntime.cached(federationCache, key, 15000, async () => {
    const snapshot = await getQuoteSnapshot(security, settings);
    const core = {
      quote: snapshot.quote,
      actualProvider: snapshot.actualProvider,
      requestedPrimary: snapshot.requestedPrimary,
      primaryStatus: snapshot.primaryStatus,
      providerLatencyMs: snapshot.latencyMs
    };
    return quoteFederation(security, core, settings);
  });
}

const CHART_RANGE_LIMITS = {
  "1": { "1d": 260, "3d": 800, "5d": 1300, "10d": 2600 },
  "5": { "1d": 60, "3d": 180, "5d": 300, "10d": 600 },
  "15": { "5d": 80, "10d": 160, "20d": 320, "30d": 480 },
  "30": { "10d": 80, "20d": 160, "1m": 240 },
  "60": { "10d": 40, "20d": 80, "1m": 120 },
  "120": { "10d": 20, "20d": 40, "1m": 63 },
  "101": { "3m": 90, "6m": 180, "1y": 300, "3y": 800 },
  "102": { "1y": 60, "3y": 170, "5y": 280, "10y": 550 },
  "103": { "3y": 40, "5y": 65, "10y": 125, all: 400 }
};

const CHART_DEFAULT_RANGE = {
  "1": "1d",
  "5": "3d",
  "15": "10d",
  "30": "20d",
  "60": "20d",
  "120": "1m",
  "101": "3m",
  "102": "3y",
  "103": "10y"
};

function chartAdjustment(value) {
  if (value === "none" || Number(value) === 0) return { label: "不复权", value: 0 };
  if (value === "back" || Number(value) === 2) return { label: "后复权", value: 2 };
  return { label: "前复权", value: 1 };
}

function getChart(input, interval = "101", options = {}, runtime = {}) {
  try {
    const security = toSecurity(input);
    if (!/^\d{6}$/.test(security.code)) throw new Error("请输入正确的6位股票代码");
    // Return the subscription itself so callers retain its physical .drained.
    return chartRuntime.run("single", semanticKey([security.secid, interval, options]), runtime, () => chartForSecurity(security, interval, options));
  } catch (error) { return Promise.reject(error); }
}

// Internal review-only identities. Ordinary chart/quote/analysis entry points
// continue to accept only their existing stock, ETF and convertible-bond inputs.
// 第三项是同花顺免费网关上的指数代码（hs_ 市场）；中证全指在同花顺免费网关上没有，只能走应急源。
const REVIEW_INDEX_SECURITIES = new Map([
  ["1.000985", "中证全指", ""], ["1.000001", "上证指数", "1A0001"],
  ["0.399001", "深证成指", "399001"], ["0.399006", "创业板指", "399006"], ["1.000300", "沪深300", "1B0300"]
].map(([secid, name, thsCode]) => [secid, Object.freeze({
  code: secid.slice(2), secid, thscode: `${secid.slice(2)}.${secid.startsWith("1.") ? "SH" : "SZ"}`,
  name, assetType: "index", ...(thsCode ? { thsCode, thsMarket: "hs" } : {})
})]));

async function getReviewIndexChart(secid, options = {}) {
  const security = REVIEW_INDEX_SECURITIES.get(secid);
  if (!security) throw new Error(`Unsupported review index: ${String(secid)}`);
  return chartForSecurity(security, "101", { ...options, adjustment: 0 });
}

/**
 * 分时：同花顺实时分时接口（与同花顺网页分时图同源，带昨收和均价）；
 * 失败或不支持的品种退回当日 1 分钟线推算。始终是最新交易日，不受调用来源页面的日期影响。
 */
async function timeShareForSecurity(security, options) {
  if (thsFreeMarket.thsFreeSupports(security) && !marketSourceHealth.isOpen("ths_free_time")) {
    const startedAt = Date.now();
    try {
      const fetched = await serviceRuntime.cached(chartCache, `${security.secid}:time`, 5000, () => serviceRuntime.track(() => trackServiceRequest(
        thsFreeMarket.thsFreeTimeShare(security, { signal: serviceSignal() }))), options);
      const clock = shanghaiClock(new Date());
      const share = thsFreeMarket.rebaseStaleTimeShare(fetched, clock, dailyBarCalendar.previousSession(clock.date));
      marketSourceHealth.recordSuccess("ths_free_time", Date.now() - startedAt);
      return { rows: share.rows, interval: "time", range: "1d", visibleLimit: share.rows.length, source: "同花顺实时分时",
        sourceClass: "public_web", dataSource: "ths_free_time", adjustment: "不复权", preClose: share.preClose, tradingDate: share.date,
        updatedAt: new Date().toISOString(), availableFrom: share.rows[0]?.date || "", availableTo: share.rows.at(-1)?.date || "", isPartial: false, note: "" };
    } catch (error) {
      if (chainShouldStop()) throw error;
      marketSourceHealth.recordFailure("ths_free_time", error, Date.now() - startedAt);
    }
  }
  const fallback = await chartForSecurity(security, "1", { ...options, range: "1d", adjustment: "none" });
  return { ...fallback, interval: "time", note: "实时分时暂不可用，按当日 1 分钟线推算" };
}

async function chartForSecurity(security, interval, options) {
  const frame = String(interval);
  if (frame === "time") return timeShareForSecurity(security, options);
  const ranges = CHART_RANGE_LIMITS[frame];
  if (!ranges) throw new Error(`不支持的K线周期：${interval}`);
  const range = ranges[options?.range] ? options.range : CHART_DEFAULT_RANGE[frame];
  const requestedLimit = Number(options?.limit);
  const visibleLimit = Number.isFinite(requestedLimit)
    ? Math.max(20, Math.min(3000, Math.round(requestedLimit)))
    : ranges[range];
  const adjustment = chartAdjustment(options?.adjustment);
  const isMinute = Number(frame) > 0 && Number(frame) < 100;
  const warmup = isMinute ? 80 : 120;
  const requestLimit = Math.min(3200, visibleLimit + warmup);
  const ttlMs =
    ["1", "5", "15"].includes(frame) ? 8000 :
      ["30", "60", "120"].includes(frame) ? 15000 :
        frame === "101" ? 30000 : 3 * 60 * 1000;
  const rows = await eastChartCached(
    security,
    frame,
    requestLimit,
    adjustment.value,
    ttlMs,
    options
  );
  const dataSource = String(rows?.dataSource || "eastmoney");
  const source =
    dataSource.startsWith("fuyao")
      ? "同花顺扶摇官方数据"
      : dataSource.startsWith("ths_free")
      ? "同花顺免费公开行情"
      : dataSource.startsWith("sina")
      ? "新浪财经公开行情（备用通道）"
      : dataSource.startsWith("tencent")
        ? "腾讯证券公开行情（备用通道）"
        : "东方财富公开行情（应急通道）";
  const actualAdjustment =
    Number(rows?.actualAdjustment) === 0 && adjustment.value !== 0
      ? dataSource.startsWith("ths_free") ? "不复权（同花顺分钟线只提供不复权）" : "不复权（备用通道）"
      : adjustment.label;
  return {
    rows,
    interval: frame,
    range,
    visibleLimit,
    source,
    sourceClass: "public_web",
    dataSource,
    adjustment: actualAdjustment,
    updatedAt: new Date().toISOString(),
    availableFrom: rows[0]?.date || "",
    availableTo: rows.at(-1)?.date || "",
    isPartial: rows.length < visibleLimit,
    note:
      frame === "120"
        ? "120分钟为上午、下午各一根半日K线，历史长度受源端限制"
        : ""
  };
}

async function discoverLimitUps(options = {}) {
  const completePool = await discoverRecentLimitUpSnapshot(1, options);
  const rows = completePool.rows.map((item) => ({
    ...item,
    poolSource: "当日完整涨停专题池"
  }));
  return {
    rows,
    meta: {
      ...completePool.meta,
      dataDate: completePool.meta.dataDate || rows[0]?.limitDate || "",
      providers: [...completePool.meta.providers]
    }
  };
}

async function discoverRecentLimitUpSnapshot(days = 10, options = {}) {
  const count = Math.max(1, Math.min(20, Number(days) || 10));
  const pools = await recentLimitUpPools(count, options);
  const poolProviders = [
    ...new Set(pools.flatMap((day) =>
      Array.isArray(day.providers) && day.providers.length
        ? day.providers.map(String)
        : [String(day.provider || "")]
    ).filter(Boolean))
  ];
  const unique = new Map();
  for (const [tradingDaysSince, day] of pools.entries()) {
    for (const item of day.pool) {
      const code = String(item.code || "");
      const name = String(item.name || "");
      if (!isAStockCode(code) || isRiskStockName(name) || unique.has(code)) continue;
      unique.set(code, {
        ...item,
        limitDate: day.date,
        tradingDaysSince,
        observationNode:
          tradingDaysSince >= 1 && tradingDaysSince <= 10
            ? `T+${tradingDaysSince}`
            : tradingDaysSince === 0
              ? "T"
              : "其他",
        autoAdded: true
      });
    }
  }
  const rows = [...unique.values()];
  return {
    rows,
    meta: {
      dataDate: pools[0]?.date || "",
      fetchedAt: pools[0]?.fetchedAt || new Date().toISOString(),
      providers: poolProviders
    }
  };
}

async function discoverRecentLimitUps(days = 10, options = {}) {
  return (await discoverRecentLimitUpSnapshot(days, options)).rows;
}

function strategySignalNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function strategyBoardBucket(code = "") {
  const value = String(code);
  if (/^(300|301|302)/.test(value)) return "创业板";
  if (/^(688|689)/.test(value)) return "科创板";
  if (/^(4|8|9)/.test(value)) return "北交所";
  if (/^(6|000|001|002|003)/.test(value)) return "沪深主板";
  return "其他";
}

function strategyValidationBoard(code = "") {
  const value = String(code);
  if (/^(300|301|302)/.test(value)) return "growth";
  if (/^(688|689)/.test(value)) return "star";
  if (/^(4|8|9)/.test(value)) return "beijing";
  return "main";
}

function stableStrategySampleHash(value = "") {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function selectIndependentValidationSample(
  securities = [],
  limit = STRATEGY_SIGNAL_VALIDATION_SAMPLE,
  excludedCodes = []
) {
  const target = Math.max(1, Math.round(Number(limit) || STRATEGY_SIGNAL_VALIDATION_SAMPLE));
  const excluded = new Set((Array.isArray(excludedCodes) ? excludedCodes : []).map(String));
  const unique = new Map();
  for (const security of Array.isArray(securities) ? securities : []) {
    const code = String(security?.code || security?.f12 || "");
    const name = String(security?.name || security?.f14 || code);
    if (!isAStockCode(code) || excluded.has(code) || isRiskStockName(name)) continue;
    if (!unique.has(code)) {
      unique.set(code, {
        ...security,
        code,
        name,
        secid: String(security?.secid || `${marketFromCode(code)}.${code}`),
        thscode: String(
          security?.thscode ||
          `${code}.${marketFromCode(code) === 1 ? "SH" : /^(4|8|9)/.test(code) ? "BJ" : "SZ"}`
        ),
        industry: String(security?.industry || security?.f100 || "未分类"),
        validationSample: true
      });
    }
  }
  const rows = [...unique.values()];
  const quotaRates = { main: 0.5, growth: 0.25, star: 0.15, beijing: 0.1 };
  const selected = [];
  const selectedCodes = new Set();
  const pickBoard = (board, quota) => {
    const byIndustry = new Map();
    for (const row of rows.filter((item) => strategyValidationBoard(item.code) === board)) {
      const industry = String(row.industry || "未分类");
      const bucket = byIndustry.get(industry) || [];
      bucket.push(row);
      byIndustry.set(industry, bucket);
    }
    const industries = [...byIndustry.keys()].sort();
    for (const industry of industries) {
      byIndustry.get(industry).sort(
        (left, right) =>
          stableStrategySampleHash(left.code) - stableStrategySampleHash(right.code) ||
          left.code.localeCompare(right.code)
      );
    }
    let picked = 0;
    while (selected.length < target && picked < quota && industries.length) {
      let added = false;
      for (const industry of industries) {
        const row = byIndustry.get(industry).shift();
        if (!row || selectedCodes.has(row.code)) continue;
        selected.push(row);
        selectedCodes.add(row.code);
        picked += 1;
        added = true;
        if (picked >= quota || selected.length >= target) break;
      }
      if (!added) break;
    }
  };
  for (const board of ["main", "growth", "star", "beijing"]) {
    pickBoard(board, Math.round(target * quotaRates[board]));
  }
  const remainder = rows
    .filter((row) => !selectedCodes.has(row.code))
    .sort(
      (left, right) =>
        stableStrategySampleHash(`${strategyValidationBoard(left.code)}:${left.industry}:${left.code}`) -
          stableStrategySampleHash(`${strategyValidationBoard(right.code)}:${right.industry}:${right.code}`) ||
        left.code.localeCompare(right.code)
    );
  for (const row of remainder) {
    if (selected.length >= target) break;
    selected.push(row);
    selectedCodes.add(row.code);
  }
  return selected;
}

const SINA_MARKET_CENTER = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.";
const SINA_BROAD_PAGE_SIZE = 100;
const SINA_BROAD_MAX_PAGES = 60;

// 东方财富 push2delay 的 clist 接口当日整体返回空（curl 52），
// 导致宽基独立样本永远 0/0、所有策略卡在发布门槛、页面一只股票都不显示。
// 这里改用已实测可用的新浪 hs_a 节点，并显式核对其声明的股票总数。
async function sinaBroadUniversePage(page) {
  const url = `${SINA_MARKET_CENTER}getHQNodeData?page=${page}&num=${SINA_BROAD_PAGE_SIZE}` +
    "&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page";
  const rows = await fetchJson(url, {}, 15000);
  if (!Array.isArray(rows)) throw new Error("证券列表为空");
  return rows;
}
async function sinaBroadUniverseDeclaredTotal() {
  const value = await fetchJson(`${SINA_MARKET_CENTER}getHQNodeStockCount?node=hs_a`, {}, 12000);
  const total = Number(typeof value === "string" ? value.replace(/["\s]/g, "") : value);
  return Number.isSafeInteger(total) && total > 0 && total <= 20000 ? total : null;
}

async function broadAStockValidationUniverse() {
  return withSingleFlightCache(strategyValidationUniverseCache, 30 * 60 * 1000, async () => {
    const declaredTotal = await sinaBroadUniverseDeclaredTotal().catch(() => null);
    const all = [];
    const failures = [];
    const seen = new Set();
    let page = 1;
    let complete = false;
    try {
      for (; page <= SINA_BROAD_MAX_PAGES; page += 1) {
        const rows = await sinaBroadUniversePage(page);
        if (!rows.length) { complete = true; break; }
        let added = 0;
        for (const item of rows) {
          const code = String(item?.code || "");
          if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
          seen.add(code);
          all.push(item);
          added += 1;
        }
        // 声明总数已达成且本页无新增，说明分页已到末尾。
        if (declaredTotal !== null && all.length >= declaredTotal && added === 0) { complete = true; break; }
      }
      if (!complete && declaredTotal !== null && all.length >= declaredTotal) complete = true;
    } catch (error) {
      failures.push({
        marketFilter: "sina:hs_a",
        reason: error instanceof Error ? error.message : String(error || "unknown")
      });
    }
    if (!all.length) {
      const rows = [];
      Object.defineProperty(rows, "failures", { value: failures.length ? failures : [{ marketFilter: "sina:hs_a", reason: "未取得宽基证券列表" }], enumerable: false });
      return rows;
    }
    const rows = all.map((item) => ({
      code: String(item.code || ""),
      name: String(item.name || item.code || ""),
      industry: "未分类",
      totalMarketCap: null
    }));
    Object.defineProperty(rows, "failures", {
      value: failures,
      enumerable: false
    });
    return rows;
  });
}

function buildStrategySampleDiversity(candidates = []) {
  const rows = (Array.isArray(candidates) ? candidates : []).filter((item) =>
    isAStockCode(String(item?.code || ""))
  );
  const boardBuckets = {};
  const dateCohorts = {};
  const industries = new Set();
  for (const item of rows) {
    const board = strategyBoardBucket(item.code);
    boardBuckets[board] = Number(boardBuckets[board] || 0) + 1;
    const date = String(item.limitDate || item.date || item.tradeDate || "").slice(0, 10);
    if (date) dateCohorts[date] = Number(dateCohorts[date] || 0) + 1;
    const industry = String(item.industry || "").trim();
    if (industry && industry !== "未分类") industries.add(industry);
  }
  const maximumShare = (counts) => {
    const values = Object.values(counts).map(Number).filter(Number.isFinite);
    return rows.length && values.length
      ? Math.max(...values) / rows.length
      : null;
  };
  const boardCount = Object.keys(boardBuckets).length;
  const dateCohortCount = Object.keys(dateCohorts).length;
  const maximumBoardShare = maximumShare(boardBuckets);
  const maximumDateCohortShare = maximumShare(dateCohorts);
  return {
    securities: rows.length,
    boardCount,
    dateCohortCount,
    industryOrThemeCount: industries.size,
    boardBuckets,
    dateCohorts,
    maximumBoardShare,
    maximumDateCohortShare,
    concentrationWarnings: [
      Number(maximumBoardShare) > 0.8
        ? `最大板块样本占比 ${(Number(maximumBoardShare) * 100).toFixed(1)}%，当前样本仍偏向沪深主板。`
        : ""
    ].filter(Boolean),
    diversified:
      rows.length >= 100 &&
      boardCount >= 4 &&
      dateCohortCount >= 5 &&
      industries.size >= 15 &&
      Number(maximumDateCohortShare) <= 0.35
  };
}

function strategySignalGrade(score) {
  const value = strategySignalNumber(score);
  if (value === null) return "--";
  if (value >= 88) return "A";
  if (value >= 78) return "B";
  if (value >= 68) return "C";
  return "D";
}

function strategyValidationAliases(validation = {}) {
  const outOfSample = validation?.outOfSample || {};
  const walkForward = validation?.walkForward || {};
  const inSample = validation?.inSample || {};
  const winRate5 = strategySignalNumber(outOfSample.winRate, validation.winRate);
  const average5 = strategySignalNumber(
    outOfSample.averageReturn,
    validation.averageReturn
  );
  const excess5 = strategySignalNumber(
    outOfSample.averageExcessReturn,
    validation.averageExcessReturn
  );
  const worstMdd5 = strategySignalNumber(
    outOfSample.maxDrawdown,
    validation.maxDrawdown
  );
  const walkForwardPassRate = strategySignalNumber(walkForward.passRate);
  const positiveFoldRate = strategySignalNumber(walkForward.positiveFoldRate);
  const degradationPercent = strategySignalNumber(walkForward.degradationPercent);
  const stabilityScore =
    walkForward.available === true &&
    walkForwardPassRate !== null &&
    positiveFoldRate !== null &&
    degradationPercent !== null
      ? Math.round(
        clamp(walkForwardPassRate, 0, 1) * 60 +
        clamp(positiveFoldRate, 0, 1) * 25 +
        (1 - clamp(degradationPercent / 100, 0, 1)) * 15
      )
      : null;
  const accepted = validation.accepted === true;
  const minimumSamples = strategySignalNumber(
    validation.minimumSamples,
    validation?.thresholds?.minSamples
  );
  const sampleCount = strategySignalNumber(validation.sampleCount) || 0;
  const status = accepted
    ? "PASS"
    : minimumSamples !== null && sampleCount < minimumSamples
      ? "INSUFFICIENT"
      : "REVIEW";
  const grade = accepted
    ? stabilityScore !== null && stabilityScore >= 85
      ? "A"
      : stabilityScore !== null && stabilityScore >= 70
        ? "B"
        : "C"
    : "D";
  const failureReasons = Array.isArray(validation.reasons)
    ? validation.reasons.filter(Boolean).map(String)
    : validation.reason && !accepted
      ? [String(validation.reason)]
      : [];
  const walkForwardWindows = (Array.isArray(walkForward.folds)
    ? walkForward.folds
    : []
  ).map((fold) => ({
    fold: Number(fold?.fold || 0),
    trainingFrom: String(fold?.trainRange?.from || ""),
    trainingTo: String(fold?.trainRange?.to || ""),
    trainingTrades: Number(fold?.trainSampleCount || 0),
    outOfSampleFrom: String(fold?.testRange?.from || ""),
    outOfSampleTo: String(fold?.testRange?.to || ""),
    outOfSampleTrades: Number(fold?.testSampleCount || 0),
    outOfSampleAverageReturn: strategySignalNumber(fold?.testAverageReturn),
    outOfSampleWinRate: strategySignalNumber(fold?.testWinRate),
    outOfSampleMaxDrawdown: strategySignalNumber(fold?.testMaxDrawdown),
    accepted: fold?.accepted === true
  }));
  const validationEvidence = {
    accepted,
    signalFrom: String(validation?.range?.from || ""),
    signalTo: String(validation?.range?.to || ""),
    totalTrades: sampleCount,
    winningTrades: Number(validation.winCount || 0),
    losingTrades: Number(validation.lossCount || 0),
    excludedUntradeableTrades: Number(validation.untradeableCount || 0),
    training: {
      from: String(inSample?.range?.from || ""),
      to: String(inSample?.range?.to || ""),
      trades: Number(inSample?.sampleCount || 0),
      winRate: strategySignalNumber(inSample?.winRate),
      averageReturn: strategySignalNumber(inSample?.averageReturn),
      maxDrawdown: strategySignalNumber(inSample?.maxDrawdown),
      benchmarkMatchedTrades: Number(inSample?.benchmarkSampleCount || 0)
    },
    outOfSample: {
      from: String(outOfSample?.range?.from || ""),
      to: String(outOfSample?.range?.to || ""),
      trades: Number(outOfSample?.sampleCount || 0),
      winRate: strategySignalNumber(outOfSample?.winRate),
      averageReturn: strategySignalNumber(outOfSample?.averageReturn),
      averageExcessReturn: strategySignalNumber(
        outOfSample?.averageExcessReturn
      ),
      maxDrawdown: strategySignalNumber(outOfSample?.maxDrawdown),
      benchmarkMatchedTrades: Number(
        outOfSample?.benchmarkSampleCount || 0
      )
    },
    walkForward: {
      available: walkForward.available === true,
      accepted: walkForward.accepted === true,
      folds: walkForwardWindows.length,
      passedFolds: Number(walkForward.passedFolds || 0),
      passRate: walkForwardPassRate,
      windows: walkForwardWindows
    },
    execution: {
      holdingTradingDays: Number(validation.horizonDays || 0),
      roundTripCostBps: strategySignalNumber(validation.roundTripCostBps),
      roundTripCostPercent:
        strategySignalNumber(validation.roundTripCostBps) === null
          ? null
          : Number(validation.roundTripCostBps) / 100,
      entryRule: String(validation.entryRule || ""),
      returnType: String(validation.returnType || "")
    },
    benchmark: {
      code: "000985",
      name: "中证全指",
      matchedTrades: Number(validation.benchmarkSampleCount || 0),
      totalTrades: sampleCount,
      missingTrades: Math.max(
        0,
        sampleCount - Number(validation.benchmarkSampleCount || 0)
      ),
      complete:
        sampleCount > 0 &&
        Number(validation.benchmarkSampleCount || 0) >= sampleCount,
      averageExcessReturn: strategySignalNumber(
        validation.averageExcessReturn
      )
    },
    failureReasons
  };
  return {
    ...validation,
    outOfSampleCount:
      strategySignalNumber(outOfSample.sampleCount) || 0,
    walkForwardPassRate,
    winRate5,
    average5,
    excess5,
    worstMdd5,
    stabilityScore,
    status,
    grade,
    failureReasons,
    validationEvidence
  };
}

function enrichStrategySignalReport(report = {}, candidates = [], context = {}) {
  const candidateByCode = new Map(
    (Array.isArray(candidates) ? candidates : [])
      .filter((item) => isAStockCode(String(item?.code || "")))
      .map((item) => [String(item.code), item])
  );
  const reportStrategies = Array.isArray(report?.strategies)
    ? report.strategies
    : [];
  const availableIds = new Set(reportStrategies.map((strategy) => String(strategy.id)));
  const isCompositeStrategy = (strategy) => {
    const type = String(strategy?.type || "").toLowerCase();
    if (type) return type === "composite";
    return Array.isArray(strategy?.components) && strategy.components.length > 0;
  };
  const requestedIds = Array.isArray(context.strategyIds)
    ? new Set(
      context.strategyIds
        .map(String)
        .filter((id) => availableIds.has(id))
    )
    : null;
  const maxStocksPerStrategy = Math.max(
    1,
    Math.min(140, Math.round(Number(context.maxStocksPerStrategy) || 140))
  );
  const auditedStrategies = reportStrategies
    .filter((strategy) => !requestedIds?.size || requestedIds.has(String(strategy.id)))
    .map((strategy) => {
      const validation = strategyValidationAliases(strategy.validation);
      const benchmarkReady =
        context.benchmarkFailed !== true &&
        (
          context.benchmarkBars === undefined ||
          Number(context.benchmarkBars) >= 420
        );
      const totalTrades = Number(validation.sampleCount || 0);
      const outOfSampleTrades = Number(
        validation?.outOfSample?.sampleCount || 0
      );
      const walkForwardWindows = Array.isArray(
        validation?.walkForward?.folds
      )
        ? validation.walkForward.folds.length
        : 0;
      const walkForwardPassRate = Number(
        validation?.walkForward?.passRate || 0
      );
      const benchmarkMatchedTrades = Number(
        validation?.outOfSample?.benchmarkSampleCount || 0
      );
      const totalBenchmarkMatchedTrades = Number(
        validation?.benchmarkSampleCount || 0
      );
      const robustValidation = validation?.validationVersion === "robust-v2";
      const outOfSampleExcess = strategySignalNumber(
        validation?.outOfSample?.averageExcessReturn
      );
      const outOfSampleLowerBound = strategySignalNumber(
        validation?.outOfSample?.averageReturnLowerBound95
      );
      const currentRegimeFit = validation?.currentRegimeFit || {};
      const minimumTotalTrades = Math.max(
        30,
        Number(validation?.thresholds?.minSamples || 30)
      );
      const minimumOutOfSampleTrades = Math.max(
        9,
        Number(validation?.thresholds?.minOutOfSampleSamples || 9)
      );
      const publicationFailureReasons = [
        ...validation.failureReasons
      ];
      if (totalTrades < minimumTotalTrades) {
        publicationFailureReasons.push(
          `总交易样本不足：${totalTrades}/${minimumTotalTrades}。`
        );
      }
      if (outOfSampleTrades < minimumOutOfSampleTrades) {
        publicationFailureReasons.push(
          `样本外交易不足：${outOfSampleTrades}/${minimumOutOfSampleTrades}。`
        );
      }
      if (walkForwardWindows < 3) {
        publicationFailureReasons.push(
          `连续走步窗口不足：${walkForwardWindows}/3。`
        );
      }
      if (walkForwardPassRate < 2 / 3) {
        publicationFailureReasons.push(
          `走步窗口通过率不足：${(walkForwardPassRate * 100).toFixed(1)}%/66.7%。`
        );
      }
      if (!benchmarkReady) {
        publicationFailureReasons.push(
          "中证全指（000985）基准历史不足420根或不可用，不能发布策略信号。"
        );
      }
      if (benchmarkMatchedTrades < outOfSampleTrades) {
        publicationFailureReasons.push(
          `基准可比交易不足：${benchmarkMatchedTrades}/${outOfSampleTrades}。`
        );
      }
      if (totalBenchmarkMatchedTrades < totalTrades) {
        publicationFailureReasons.push(
          `全部样本基准可比交易不足：${totalBenchmarkMatchedTrades}/${totalTrades}。`
        );
      }
      if (robustValidation && !(Number(outOfSampleExcess) > 0)) {
        publicationFailureReasons.push(
          "样本外相对中证全指超额收益未转正，不发布当前信号。"
        );
      }
      if (robustValidation && !(Number(outOfSampleLowerBound) >= 0)) {
        publicationFailureReasons.push(
          "样本外平均收益95%单侧置信下限未达到0%，不发布当前信号。"
        );
      }
      if (robustValidation && currentRegimeFit.supported !== true) {
        publicationFailureReasons.push(
          String(currentRegimeFit.reason || "当前市场状态缺少通过复核的历史优势。")
        );
      }
      if (robustValidation && context.independentValidationUniverse !== true) {
        publicationFailureReasons.push(
          "独立于当前涨停候选池的宽基验证样本不足，不发布当前信号。"
        );
      }
      const publicationAccepted =
        validation.accepted === true &&
        validation?.walkForward?.accepted === true &&
        totalTrades >= minimumTotalTrades &&
        outOfSampleTrades >= minimumOutOfSampleTrades &&
        walkForwardWindows >= 3 &&
        walkForwardPassRate >= 2 / 3 &&
        benchmarkReady &&
        totalBenchmarkMatchedTrades >= totalTrades &&
        benchmarkMatchedTrades >= outOfSampleTrades &&
        (!robustValidation ||
          (
            Number(outOfSampleExcess) > 0 &&
            Number(outOfSampleLowerBound) >= 0 &&
            currentRegimeFit.supported === true &&
            context.independentValidationUniverse === true
          ));
      const publicationChecks = {
        strategyType: isCompositeStrategy(strategy) ? "composite" : "base",
        thresholdProfile: "uniform_v1",
        sameThresholdsAsBaseStrategy: true,
        engineAccepted: validation.accepted === true,
        minimumTotalTrades,
        totalTrades,
        minimumOutOfSampleTrades,
        outOfSampleTrades,
        minimumWalkForwardWindows: 3,
        walkForwardWindows,
        minimumWalkForwardPassRate: 2 / 3,
        walkForwardPassRate,
        minimumBenchmarkBars: 420,
        benchmarkBars: Number(context.benchmarkBars || 0),
        totalBenchmarkMatchedTrades,
        benchmarkMatchedTrades,
        outOfSampleExcess,
        minimumOutOfSampleExcess: 0,
        outOfSampleReturnLowerBound95: outOfSampleLowerBound,
        minimumOutOfSampleReturnLowerBound95: 0,
        currentRegimeFit,
        independentValidationUniverse:
          context.independentValidationUniverse === true,
        passed: publicationAccepted
      };
      const validationEvidence = {
        ...validation.validationEvidence,
        benchmark: {
          ...validation.validationEvidence.benchmark,
          bars: Number(context.benchmarkBars || 0),
          from: String(context?.dataQuality?.benchmark?.from || ""),
          to: String(context?.dataQuality?.benchmark?.to || ""),
          provider: String(context?.dataQuality?.benchmark?.provider || ""),
          adjustment: "不复权",
          available: benchmarkReady
        },
        sourceData: {
          from: String(context?.dataQuality?.dataRange?.from || ""),
          to: String(context?.dataQuality?.dataRange?.to || ""),
          requestedBars: Number(context.historyBarsRequested || 0),
          usableSecurities: Number(context.processed || 0),
          failedSecurities: Number(context.failed || 0),
          providers: context?.dataQuality?.summary?.providers || {}
        },
        publicationChecks,
        publicationAccepted,
        failureReasons: publicationFailureReasons
      };
      const validationWithEvidence = {
        ...validation,
        publicationAccepted,
        publicationFailureReasons,
        validationEvidence
      };
      const stocks = (Array.isArray(strategy.stocks) ? strategy.stocks : [])
        .filter(
          (stock) =>
            !robustValidation ||
            (
              stock?.matchSource === "ohlcv" &&
              Number(stock?.historyBars || 0) >= 120
            )
        )
        .map((stock) => {
          const candidate = candidateByCode.get(String(stock?.code || "")) || {};
          const analysis = candidate?.analysis || {};
          const signalScore =
            strategySignalNumber(
              stock?.signalStrength,
              stock?.signalScore,
              stock?.score
            );
          const strategyMatchRate =
            strategySignalNumber(
              candidate?.strategyMatchRate,
              analysis?.strategyMatchRate
            );
          return {
            ...stock,
            code: String(stock?.code || candidate?.code || ""),
            name: String(stock?.name || candidate?.name || stock?.code || ""),
            secid: String(candidate?.secid || stock?.secid || ""),
            thscode: String(candidate?.thscode || stock?.thscode || ""),
            latest: strategySignalNumber(stock?.latest, candidate?.latest),
            changePct: strategySignalNumber(stock?.changePct, candidate?.changePct),
            turnover: strategySignalNumber(candidate?.turnover, stock?.turnover),
            amount: strategySignalNumber(candidate?.amount, stock?.amount),
            industry: String(
              candidate?.industry || stock?.industry || "未分类"
            ),
            observationNode: String(
              candidate?.observationNode || stock?.observationNode || ""
            ),
            limitDate: String(candidate?.limitDate || stock?.signalDate || ""),
            tradingDaysSince: strategySignalNumber(candidate?.tradingDaysSince),
            consecutiveBoards: strategySignalNumber(
              candidate?.consecutiveBoards,
              candidate?.limitStats?.count,
              stock?.metrics?.consecutiveBoards
            ),
            firstSealTime: String(candidate?.firstSealTime || ""),
            openBoardCount: strategySignalNumber(candidate?.openBoardCount),
            sealedAmount: strategySignalNumber(candidate?.sealedAmount),
            sealFloatRatio: strategySignalNumber(candidate?.sealFloatRatio),
            signalScore,
            score: signalScore,
            mrs: strategySignalNumber(candidate?.mrs, analysis?.mrs),
            strategyMatchRate:
              strategyMatchRate === null
                ? null
                : Math.round(clamp(strategyMatchRate, 0, 100)),
            grade: strategySignalGrade(signalScore),
            validationPassed: publicationAccepted
          };
        })
        .sort(
          (left, right) =>
            Number(right.signalScore || 0) - Number(left.signalScore || 0) ||
            String(left.code).localeCompare(String(right.code))
        )
        .slice(0, maxStocksPerStrategy)
        .map((stock, index) => ({ ...stock, rank: index + 1 }));
      return {
        ...strategy,
        validation: validationWithEvidence,
        validationPassed: publicationAccepted,
        publicationAccepted,
        validationWarning: publicationAccepted
          ? ""
          : publicationFailureReasons.join("；"),
        stocks
      };
    })
    .sort(
      (left, right) =>
        Number(right.publicationAccepted) - Number(left.publicationAccepted) ||
        Number(right.validation.accepted) - Number(left.validation.accepted) ||
        Number(right.validation.stabilityScore || 0) -
          Number(left.validation.stabilityScore || 0) ||
        Number(right.validation.average5 || 0) -
          Number(left.validation.average5 || 0) ||
        Number(right.validation.winRate5 || 0) -
          Number(left.validation.winRate5 || 0) ||
        Number(right.validation.sampleCount || 0) -
          Number(left.validation.sampleCount || 0)
    )
    .map((strategy, index) => ({
      ...strategy,
      auditRank: index + 1
    }));
  // 用户要的是"按策略选出票"。规则命中本身就是选股结果，必须返回；
  // 历史复核是否通过只作为质量标注（validationPassed / publicationAccepted），
  // 不再作为"是否显示股票"的开关——否则一次复核失败会让整页一只都不显示。
  const strategies = auditedStrategies.map((strategy, index) => ({
    ...strategy,
    strategyRank: index + 1,
    stocks: strategy.stocks.map((stock) => ({
      ...stock,
      validationPassed: strategy.publicationAccepted === true
    }))
  }));
  const publishedStrategies = strategies.filter((strategy) => strategy.publicationAccepted === true);
  const rawOptimizedPortfolio = report?.optimizedPortfolio;
  let optimizedPortfolio = null;
  if (rawOptimizedPortfolio && typeof rawOptimizedPortfolio === "object") {
    const optimizedFailureReasons = [];
    const optimizedValidation = rawOptimizedPortfolio?.validation || {};
    const optimizedTerminalHoldout =
      rawOptimizedPortfolio?.terminalHoldout || {};
    const optimizedBenchmarkReady =
      context.benchmarkFailed !== true &&
      Number(context.benchmarkBars || 0) >= 420;
    const optimizedDevelopmentTrades = Number(
      optimizedValidation.sampleCount || 0
    );
    const optimizedDevelopmentBenchmarkTrades = Number(
      optimizedValidation.benchmarkSampleCount || 0
    );
    const optimizedDevelopmentBenchmarkComplete =
      optimizedDevelopmentTrades > 0 &&
      optimizedDevelopmentBenchmarkTrades >= optimizedDevelopmentTrades;
    const optimizedTerminalTrades = Number(
      optimizedTerminalHoldout.sampleCount || 0
    );
    const optimizedTerminalBenchmarkTrades = Number(
      optimizedTerminalHoldout.benchmarkSampleCount || 0
    );
    const optimizedTerminalBenchmarkComplete =
      optimizedTerminalTrades > 0 &&
      optimizedTerminalBenchmarkTrades >= optimizedTerminalTrades;
    if (rawOptimizedPortfolio.accepted !== true) {
      optimizedFailureReasons.push(
        String(rawOptimizedPortfolio.reason || "稳健优选组合未通过引擎复核。")
      );
    }
    if (context.independentValidationUniverse !== true) {
      optimizedFailureReasons.push(
        "独立于当前涨停候选池的宽基样本不足，组合不发布。"
      );
    }
    if (!optimizedBenchmarkReady) {
      optimizedFailureReasons.push(
        "中证全指（000985）基准历史不足420根或不可用，组合不发布。"
      );
    }
    if (!optimizedDevelopmentBenchmarkComplete) {
      optimizedFailureReasons.push(
        `组合开发期基准可比交易不足：${optimizedDevelopmentBenchmarkTrades}/${optimizedDevelopmentTrades}。`
      );
    }
    if (!optimizedTerminalBenchmarkComplete) {
      optimizedFailureReasons.push(
        `组合终端留出基准可比交易不足：${optimizedTerminalBenchmarkTrades}/${optimizedTerminalTrades}。`
      );
    }
    if (rawOptimizedPortfolio?.terminalHoldout?.accepted !== true) {
      optimizedFailureReasons.push(
        String(rawOptimizedPortfolio?.terminalHoldout?.reason || "终端留出样本未通过。")
      );
    }
    if (rawOptimizedPortfolio?.currentRegimeFit?.supported !== true) {
      optimizedFailureReasons.push(
        String(rawOptimizedPortfolio?.currentRegimeFit?.reason || "当前市场状态未通过适配复核。")
      );
    }
    const optimizedPublicationAccepted =
      rawOptimizedPortfolio.accepted === true &&
      rawOptimizedPortfolio?.terminalHoldout?.accepted === true &&
      rawOptimizedPortfolio?.currentRegimeFit?.supported === true &&
      optimizedBenchmarkReady &&
      optimizedDevelopmentBenchmarkComplete &&
      optimizedTerminalBenchmarkComplete &&
      context.independentValidationUniverse === true;
    const optimizedCandidateStocks = (Array.isArray(rawOptimizedPortfolio.stocks)
      ? rawOptimizedPortfolio.stocks
      : [])
      .filter(
        (stock) =>
          stock?.matchSource === "ohlcv" &&
          Number(stock?.historyBars || 0) >= 120
      )
      .map((stock) => {
        const candidate = candidateByCode.get(String(stock?.code || "")) || {};
        return {
          ...stock,
          code: String(stock?.code || candidate?.code || ""),
          name: String(stock?.name || candidate?.name || stock?.code || ""),
          secid: String(candidate?.secid || stock?.secid || ""),
          thscode: String(candidate?.thscode || stock?.thscode || ""),
          latest: strategySignalNumber(stock?.latest, candidate?.latest),
          changePct: strategySignalNumber(stock?.changePct, candidate?.changePct),
          turnover: strategySignalNumber(candidate?.turnover, stock?.turnover),
          amount: strategySignalNumber(candidate?.amount, stock?.amount),
          industry: String(candidate?.industry || stock?.industry || "未分类"),
          signalScore: strategySignalNumber(stock?.signalStrength, stock?.signalScore),
          score: strategySignalNumber(stock?.signalStrength, stock?.signalScore),
          grade: strategySignalGrade(stock?.signalStrength),
          validationPassed: optimizedPublicationAccepted
        };
      });
    optimizedPortfolio = {
      ...rawOptimizedPortfolio,
      accepted: optimizedPublicationAccepted,
      engineAccepted: rawOptimizedPortfolio.accepted === true,
      publicationAccepted: optimizedPublicationAccepted,
      publicationFailureReasons: [...new Set(optimizedFailureReasons.filter(Boolean))],
      benchmarkChecks: {
        minimumBars: 420,
        bars: Number(context.benchmarkBars || 0),
        available: optimizedBenchmarkReady,
        development: {
          complete: optimizedDevelopmentBenchmarkComplete,
          matchedTrades: optimizedDevelopmentBenchmarkTrades,
          totalTrades: optimizedDevelopmentTrades
        },
        terminalHoldout: {
          complete: optimizedTerminalBenchmarkComplete,
          matchedTrades: optimizedTerminalBenchmarkTrades,
          totalTrades: optimizedTerminalTrades
        }
      },
      independentValidationUniverse:
        context.independentValidationUniverse === true,
      matchedStockCount: optimizedCandidateStocks.length,
      stocks: optimizedPublicationAccepted ? optimizedCandidateStocks : []
    };
  }
  const matchedCodes = new Set(
    auditedStrategies.flatMap((strategy) =>
      strategy.stocks.map((stock) => stock.code)
    )
  );
  const qualifiedCodes = new Set(
    publishedStrategies.flatMap((strategy) => strategy.stocks.map((stock) => stock.code))
  );
  for (const stock of optimizedPortfolio?.stocks || []) {
    qualifiedCodes.add(String(stock.code));
  }
  const unvalidatedSignals = auditedStrategies.reduce(
    (total, strategy) =>
      total +
      (strategy.publicationAccepted ? 0 : strategy.stocks.length),
    0
  );
  const warnings = [];
  if (Number(context.failed) > 0) {
    warnings.push(
      `${Number(context.failed)} 只股票的历史行情获取失败，已隔离，不影响其余股票选股。`
    );
  }
  if (Number(context.availableUniverseSize) > Number(context.universeSize)) {
    warnings.push(
      `最近11个交易日共有 ${Number(context.availableUniverseSize)} 只非ST涨停候选；为控制行情源压力，本轮按新近度、连板与成交额扫描前 ${Number(context.universeSize)} 只。`
    );
  }
  if (context.benchmarkFailed) {
    warnings.push("中证全指基准历史暂不可用，超额收益保持为空，不进行补造。");
  }
  if (context.independentValidationUniverse !== true) {
    warnings.push(
      `宽基独立验证可用样本 ${Number(context.independentValidationUsableSampleSize || 0)}/${Number(context.independentValidationSampleSize || 0)} 只，或板块覆盖未达到发布要求；${String(context.broadUniverseError || "本轮只保留审计结果").slice(0, 160)}。`
    );
  }
  if (unvalidatedSignals > 0) {
    warnings.push(
      `本轮全部 ${unvalidatedSignals} 条命中已按所属策略列出，可直接查看个股与带入回测。`
    );
  }
  if (!matchedCodes.size) {
    warnings.push("当前真实候选池没有股票满足任何策略规则，未补造策略信号。");
  }
  const methodologyDetails = report?.methodology || {};
  const methodology = typeof methodologyDetails === "string"
    ? methodologyDetails
    : Object.values(methodologyDetails).filter(Boolean).join("；");
  const strategyAudit = auditedStrategies.map((strategy) => ({
    id: strategy.id,
    name: strategy.name,
    ...(strategy.version ? { version: strategy.version, sources: strategy.sources,
      parameters: strategy.parameters, adaptationNote: strategy.adaptationNote,
      componentNames: strategy.componentNames } : {}),
    detail: strategy.detail,
    type: strategy.type,
    components: strategy.components,
    voteRule: strategy.voteRule,
    accepted: strategy.validation.accepted === true,
    publicationAccepted: strategy.publicationAccepted === true,
    currentMatchCount: strategy.stocks.length,
    sampleCount: Number(strategy.validation.sampleCount || 0),
    failureReasons: strategy.validation.publicationFailureReasons,
    evidence: strategy.validation.validationEvidence
  }));
  const historyProviders = Object.keys(
    context?.dataQuality?.summary?.providers || {}
  );
  const selectionBiasWarningV2 = context.independentValidationUniverse === true
    ? `历史验证已加入 ${Number(context.independentValidationSampleSize || 0)} 只不属于当前涨停候选池的宽基分层样本，降低当前候选选择偏差；但仍使用当前可交易证券回放，不等同于历史时点成分股数据库，仍可能有幸存者偏差。`
    : "本轮未取得足量的宽基独立样本，仍存在当前候选选择偏差与幸存者偏差；结果只作审计，不发布稳健优选组合。";
  const historyProviderLabel = historyProviders.length && historyProviders.every((item) => item.startsWith("ths"))
    ? "同花顺"
    : historyProviders.some((item) =>
    item.startsWith("tencent")
  )
    ? "腾讯证券"
    : historyProviders.some((item) => item.startsWith("sina"))
      ? "新浪财经"
    : historyProviders.some((item) => item === "eastmoney")
      ? "东方财富"
      : "公开行情源";
  const poolProviders = Array.isArray(context.poolProviders)
    ? context.poolProviders.map(String)
    : [];
  const poolProviderLabel = poolProviders.some((item) => item.startsWith("ths"))
    ? "同花顺公开涨停池"
    : poolProviders.some((item) => item.startsWith("eastmoney"))
      ? "东方财富涨停专题池"
      : "公开涨停池";
  const benchmarkProvider = String(
    context?.dataQuality?.benchmark?.provider || ""
  );
  const benchmarkProviderLabel = benchmarkProvider.startsWith("fuyao")
    ? "同花顺扶摇"
    : benchmarkProvider.startsWith("tencent")
    ? "腾讯证券"
    : benchmarkProvider.startsWith("sina")
      ? "新浪财经"
      : benchmarkProvider === "eastmoney"
        ? "东方财富"
        : "公开行情源";
  return {
    ...report,
    generatedAt: report?.generatedAt || new Date().toISOString(),
    source: `${poolProviderLabel} + ${historyProviderLabel}个股日线 + ${benchmarkProviderLabel}基准`,
    sourceClass: "public_web",
    universeSize: Number(context.universeSize || candidates.length || 0),
    availableUniverseSize: Number(
      context.availableUniverseSize || candidates.length || 0
    ),
    processed: Number(context.processed || 0),
    failed: Number(context.failed || 0),
    benchmarkBars: Number(context.benchmarkBars || 0),
    historyBarsRequested: Number(context.historyBarsRequested || 0),
    candidateCount: candidates.length,
    currentCandidateSize: Number(
      context.currentCandidateSize ?? candidates.length
    ),
    validationUniverseSize: Number(
      context.validationUniverseSize ?? context.processed ?? 0
    ),
    validationProcessed: Number(
      context.validationProcessed ?? context.validationUniverseSize ?? 0
    ),
    validationFailed: Number(context.validationFailed || 0),
    independentValidationSampleSize: Number(
      context.independentValidationSampleSize || 0
    ),
    independentValidationUsableSampleSize: Number(
      context.independentValidationUsableSampleSize || 0
    ),
    independentValidationBoardCounts:
      context.independentBoardCounts || {},
    independentValidationUsableBoardCounts:
      context.independentUsableBoardCounts || {},
    independentValidationUniverse:
      context.independentValidationUniverse === true,
    qualifiedCount: qualifiedCodes.size,
    matchedSignalCount: matchedCodes.size,
    optimizedPortfolio,
    publishedStrategyCount: publishedStrategies.length,
    baseStrategyCount: reportStrategies.filter(
      (strategy) => !isCompositeStrategy(strategy)
    ).length,
    compositeStrategyCount: reportStrategies.filter(isCompositeStrategy).length,
    publishedCompositeCount: publishedStrategies.filter(isCompositeStrategy).length,
    publishedBaseCount: publishedStrategies.filter(
      (strategy) => !isCompositeStrategy(strategy)
    ).length,
    auditedStrategyCount: auditedStrategies.length,
    rejectedStrategyCount: auditedStrategies.length - publishedStrategies.length,
    publicationPolicy:
      "每套策略按自己的规则在当前涨停候选池里直接选股；页面列出各策略本轮选出的股票、信号强度与命中依据。",
    compositePublicationPolicy:
      "组合策略与基础策略使用完全相同的选股规则；type、components 或 voteRule 不构成放宽条件。",
    universeDefinition: {
      signalUniverse:
        `最近11个交易日${poolProviderLabel}中的非ST股票，按新近度、连板数和成交额排序后截取本轮上限。`,
      validationUniverse:
        `对本轮信号候选证券请求${Number(context.historyBarsRequested || STRATEGY_SIGNAL_HISTORY_BARS)}根${historyProviderLabel}不复权日线，在最近约三年的历史区间内回放策略。`,
      benchmark:
        `中证全指（000985）${benchmarkProviderLabel}不复权日线`,
      independentValidationUniverse:
        context.independentValidationUniverse === true,
      independentValidationSampleSize: Number(
        context.independentValidationSampleSize || 0
      ),
      historicalPointInTimeConstituents: false
    },
    selectionBiasWarning: selectionBiasWarningV2,
    strategiesTested: reportStrategies.length,
    multipleTestingWarning:
      `本轮同时检验 ${reportStrategies.length} 套预定义策略；即使未做参数寻优，择优发布仍存在多重比较与过拟合风险，应以新增样本持续复核。`,
    sampleDiversity: buildStrategySampleDiversity(
      context.validationCandidates || candidates
    ),
    dataRange: context?.dataQuality?.dataRange || {
      from: "",
      to: ""
    },
    dataQuality: context.dataQuality || {},
    dataFailureReasons: Array.isArray(context.failureDetails)
      ? context.failureDetails
      : [],
    strategyAudit,
    auditedStrategies,
    methodology: methodology ||
      "信号日仅使用当日及以前数据；次一交易日开盘入场；固定持有期退出；扣除双边成本；时间切分样本外与走步复核。",
    methodologyDetails,
    warning: warnings.join(" "),
    coverage: {
      ...(report?.coverage || {}),
      universeSize: Number(context.universeSize || candidates.length || 0),
      currentCandidateSize: Number(
        context.currentCandidateSize ?? candidates.length
      ),
      validationUniverseSize: Number(
        context.validationUniverseSize ?? context.processed ?? 0
      ),
      independentValidationSampleSize: Number(
        context.independentValidationSampleSize || 0
      ),
      independentValidationUniverse:
        context.independentValidationUniverse === true,
      processed: Number(context.processed || 0),
      failed: Number(context.failed || 0),
      historyBarsRequested: Number(context.historyBarsRequested || 0),
      benchmarkBars: Number(context.benchmarkBars || 0)
    },
    strategies
  };
}

async function strategySignalMapConcurrent(items, concurrency, worker) {
  const source = Array.isArray(items) ? items : [];
  const results = new Array(source.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), source.length) },
    async () => {
      while (cursor < source.length) {
        serviceRuntime.checkpoint();
        const index = cursor;
        cursor += 1;
        try {
          results[index] = {
            ok: true,
            value: await worker(source[index], index)
          };
        } catch (error) {
          serviceRuntime.checkpoint();
          results[index] = {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }
    }
  );
  await Promise.all(runners);
  serviceRuntime.checkpoint();
  return results;
}

function strategyUsableHistoryRows(history) {
  const byDate = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    const date = String(row?.date || "").slice(0, 10);
    const open = Number(row?.open);
    const high = Number(row?.high);
    const low = Number(row?.low);
    const close = Number(row?.close);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0
    ) {
      continue;
    }
    byDate.set(date, row);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, row]) => ({ ...row, date }));
}


function strategyMedian(values) {
  const numbers = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2
    ? numbers[middle]
    : (numbers[middle - 1] + numbers[middle]) / 2;
}

function buildStrategyDataQuality(
  candidates,
  historyResults,
  benchmarkResult,
  requestedBars
) {
  const securities = (Array.isArray(candidates) ? candidates : []).map(
    (candidate, index) => {
      const result = historyResults[index];
      if (!result?.ok) {
        return {
          code: String(candidate?.code || ""),
          name: String(candidate?.name || candidate?.code || ""),
          status: "failed",
          provider: "",
          requestedBars,
          receivedBars: 0,
          usableBars: 0,
          from: "",
          to: "",
          meets420Bars: false,
          meets720Bars: false,
          failureReason: String(result?.error || "历史行情获取失败").slice(0, 240)
        };
      }
      const rawRows = Array.isArray(result.value) ? result.value : [];
      const usableRows = rawRows.strategyPrepared
        ? rawRows
        : strategyUsableHistoryRows(rawRows);
      return {
        code: String(candidate?.code || ""),
        name: String(candidate?.name || candidate?.code || ""),
        status: "ok",
        provider: String(rawRows.dataSource || "unknown"),
        requestedBars,
        receivedBars: rawRows.length,
        usableBars: usableRows.length,
        invalidOrDuplicateBars: Math.max(0, rawRows.length - usableRows.length),
        from: String(usableRows[0]?.date || ""),
        to: String(usableRows.at(-1)?.date || ""),
        meets420Bars: usableRows.length >= 420,
        meets720Bars: usableRows.length >= 720,
        coverageRatio:
          requestedBars > 0
            ? Number(Math.min(1, usableRows.length / requestedBars).toFixed(4))
            : null,
        failureReason: ""
      };
    }
  );
  const successful = securities.filter(
    (item) => item.status === "ok" && item.usableBars > 0
  );
  const providers = successful.reduce((counts, item) => {
    const provider = String(item.provider || "unknown");
    counts[provider] = Number(counts[provider] || 0) + 1;
    return counts;
  }, {});
  const fromDates = successful.map((item) => item.from).filter(Boolean).sort();
  const toDates = successful.map((item) => item.to).filter(Boolean).sort();
  const commonFromDates = [...fromDates].sort().reverse();
  const commonToDates = [...toDates].sort();
  const benchmarkRows = benchmarkResult?.ok
    ? strategyUsableHistoryRows(benchmarkResult.value)
    : [];
  const eventDates = (Array.isArray(candidates) ? candidates : [])
    .map((item) => String(item?.limitDate || "").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const failures = securities
    .filter((item) => item.status === "failed")
    .map((item) => ({
      code: item.code,
      name: item.name,
      stage: "stock_history",
      reason: item.failureReason
    }));
  if (!benchmarkResult?.ok) {
    failures.push({
      code: "000985",
      name: "中证全指",
      stage: "benchmark_history",
      reason: String(
        benchmarkResult?.error || "中证全指基准历史获取失败"
      ).slice(0, 240)
    });
  }
  return {
    requestedBars,
    minimumRequestedBars: STRATEGY_SIGNAL_HISTORY_BARS,
    minimumReplayEvidenceBars: 420,
    adjustment: "不复权",
    dataRange: {
      from: fromDates[0] || "",
      to: toDates.at(-1) || "",
      commonFrom: commonFromDates[0] || "",
      commonTo: commonToDates[0] || ""
    },
    candidateEventRange: {
      from: eventDates[0] || "",
      to: eventDates.at(-1) || "",
      tradingDays: 11
    },
    summary: {
      selectedSecurities: securities.length,
      usableSecurities: successful.length,
      failedSecurities: securities.length - successful.length,
      securitiesWith420Bars: successful.filter((item) => item.meets420Bars).length,
      securitiesWith720Bars: successful.filter((item) => item.meets720Bars).length,
      securitiesWithFullWindow: successful.filter(
        (item) => item.usableBars >= requestedBars
      ).length,
      minimumUsableBars: successful.length
        ? Math.min(...successful.map((item) => item.usableBars))
        : 0,
      medianUsableBars: strategyMedian(
        successful.map((item) => item.usableBars)
      ),
      maximumUsableBars: successful.length
        ? Math.max(...successful.map((item) => item.usableBars))
        : 0,
      providers
    },
    benchmark: {
      code: "000985",
      name: "中证全指",
      status: benchmarkResult?.ok ? "ok" : "failed",
      provider: String(benchmarkResult?.value?.dataSource || ""),
      requestedBars,
      receivedBars: Array.isArray(benchmarkResult?.value)
        ? benchmarkResult.value.length
        : 0,
      usableBars: benchmarkRows.length,
      from: String(benchmarkRows[0]?.date || ""),
      to: String(benchmarkRows.at(-1)?.date || ""),
      adjustment: "不复权",
      failureReason: benchmarkResult?.ok
        ? ""
        : String(benchmarkResult?.error || "基准历史获取失败").slice(0, 240)
    },
    securities,
    failures
  };
}

function strategySignalOptions(raw = {}) {
  const maxUniverse = Math.max(
    40,
    Math.min(
      STRATEGY_SIGNAL_MAX_UNIVERSE,
      Math.round(Number(raw.maxUniverse) || STRATEGY_SIGNAL_MAX_UNIVERSE)
    )
  );
  // 保留既有指标窗口；只计算当前规则，不运行历史收益回放。
  const historyBars = SELECTION_HISTORY_BARS;
  const maxStocksPerStrategy = Math.max(
    1,
    Math.min(200, Math.round(Number(raw.maxStocksPerStrategy) || 200))
  );
  const strategyIds = Array.isArray(raw.strategyIds)
    ? [...new Set(raw.strategyIds.map(String).filter(Boolean))].sort()
    : [];
  return {
    provider: raw.provider === "eastmoney" ? "eastmoney" : "ths",
    fallbackEnabled: raw.fallbackEnabled !== false,
    multiSourceEnabled: raw.multiSourceEnabled !== false,
    maxUniverse,
    historyBars,
    maxStocksPerStrategy,
    strategyIds,
    // Saved user strategies and their optional watchlist universe come from the
    // main-process stores, never from the renderer; they are part of the cache key.
    customStrategies: Array.isArray(raw.customStrategies) ? raw.customStrategies : [],
    watchlistSecurities: Array.isArray(raw.watchlistSecurities)
      ? raw.watchlistSecurities.slice(0, 300).map(item => ({ code: String(item?.code || ""), name: String(item?.name || ""), secid: String(item?.secid || "") }))
      : [],
    replay: {
      horizonDays: raw.horizonDays,
      cooldownDays: raw.cooldownDays,
      minSamples: Math.max(
        120,
        Math.min(
          500,
          Math.round(strategySignalNumber(raw.minSamples) ?? 120)
        )
      ),
      minOutOfSampleSamples: Math.max(
        36,
        Math.min(
          200,
          Math.round(strategySignalNumber(raw.minOutOfSampleSamples) ?? 36)
        )
      ),
      minIndependentSignalDays: Math.max(
        60,
        Math.min(
          200,
          Math.round(strategySignalNumber(raw.minIndependentSignalDays) ?? 60)
        )
      ),
      minWalkForwardFoldSamples: Math.max(
        10,
        Math.min(
          20,
          Math.round(strategySignalNumber(raw.minWalkForwardFoldSamples) ?? 10)
        )
      ),
      minWinRate: Math.max(
        45,
        Math.min(100, strategySignalNumber(raw.minWinRate) ?? 45)
      ),
      minAverageReturn: Math.max(
        0.2,
        Math.min(20, strategySignalNumber(raw.minAverageReturn) ?? 0.2)
      ),
      maxDrawdown: Math.max(
        -22,
        Math.min(0, strategySignalNumber(raw.maxDrawdown) ?? -22)
      ),
      roundTripCostBps: Math.max(
        18,
        Math.min(200, strategySignalNumber(raw.roundTripCostBps) ?? roundTripBps())
      ),
      outOfSampleRatio: Math.max(
        0.3,
        Math.min(
          0.5,
          strategySignalNumber(raw.outOfSampleRatio) ?? 0.3
        )
      ),
      walkForwardFolds: Math.max(
        4,
        Math.min(
          5,
          Math.round(strategySignalNumber(raw.walkForwardFolds) ?? 4)
        )
      ),
      minCurrentHistoryBars: Math.max(
        120,
        Math.min(
          420,
          Math.round(strategySignalNumber(raw.minCurrentHistoryBars) ?? 120)
        )
      ),
      minReturnLowerBound: Math.max(
        0,
        Math.min(10, strategySignalNumber(raw.minReturnLowerBound) ?? 0)
      ),
      maxStrategyOverlap: Math.max(
        0.35,
        Math.min(0.72, strategySignalNumber(raw.maxStrategyOverlap) ?? 0.68)
      ),
      optimizedMinVotes: Math.max(
        2,
        Math.min(4, Math.round(strategySignalNumber(raw.optimizedMinVotes) ?? 2))
      ),
      terminalHoldoutRatio: Math.max(
        0.2,
        Math.min(0.35, strategySignalNumber(raw.terminalHoldoutRatio) ?? 0.2)
      )
    }
  };
}

function buildHistoricalStrategyStatsInWorker(history, code, name, selectedIds, benchmarkHistory, options = {}, signal) {
  return serviceRuntime.track(() => workerRunner.run(workerScriptPath(__dirname, "legacy-analysis-worker.cjs"), {
    history, code, name, selectedIds, benchmarkHistory, options
  }, {
    signal: serviceSignal(signal),
    timeoutMs: DEFAULT_OPERATION_TIMEOUTS.single,
    timeoutMessage: "历史策略分析计算超时，已停止本轮任务以保证软件可用"
  }));
}

function buildStrategySignalReportInWorker(candidates, historiesByCode, benchmarkRows, replay) {
  return serviceRuntime.track(() => workerRunner.run(workerScriptPath(__dirname, "strategy-signal-worker.cjs"), {
    candidates, historiesByCode, benchmarkRows, replay
  }, {
    signal: serviceSignal(),
    // 全市场回放对应 job 的 scan 预算（600s），不能沿用 runner 的 120s 默认值
    timeoutMs: DEFAULT_OPERATION_TIMEOUTS.scan,
    timeoutMessage: "策略计算超时，请重新选股"
  }));
}

function buildSingleStockReplaysInWorker(strategyIds, security, history, benchmarkHistory, replayOptions) {
  return serviceRuntime.track(() => workerRunner.run(workerScriptPath(__dirname, "portfolio-backtest-worker.cjs"), {
    task: "single-stock-replay", strategyIds, security, history, benchmarkHistory, replayOptions
  }, {
    signal: serviceSignal(),
    timeoutMs: DEFAULT_OPERATION_TIMEOUTS.single,
    timeoutMessage: "个股回测计算超时，已停止本轮任务以保证软件可用"
  }));
}

// 本地日线库（全市场选股、趋势扫描共用）：不复权日线存在 userData/daily-bars，每天只补最新一根。
const { createDailyBarStore } = require("./daily-bar-store.cjs");
const { fuyaoQuoteSupports } = require("./fuyao-quote.cjs");
let dailyBarDirectory = null;
const dailyBarCalendar = createTradingCalendar();
/** 收盘快照：优先用名单自带的东方财富收盘行情；没有的沪深股票再用扶摇批量快照（每批 50 只，限流即停）。 */
async function dailyBarSnapshots(securities) {
  const out = new Map(), missing = [];
  for (const security of Array.isArray(securities) ? securities : []) {
    const code = String(security?.code || "");
    if (security?.closeSnapshot && typeof security.closeSnapshot === "object") out.set(code, security.closeSnapshot);
    else missing.push(security);
  }
  const supported = missing.filter(security => fuyaoQuoteSupports(security));
  if (!supported.length || !fuyao.configured()) return out;
  for (let offset = 0; offset < supported.length; offset += 50) {
    const fetchedAt = Date.now();
    let quotes;
    try { quotes = await fuyao.snapshot(supported.slice(offset, offset + 50)); }
    catch (error) {
      if (/RATE_LIMITED|AUTH|NO_KEY/.test(String(error?.code || ""))) break;
      continue;
    }
    for (const quote of quotes.values()) if (/^\d{6}$/.test(String(quote?.code || ""))) out.set(String(quote.code), { ...quote, fetchedAt });
  }
  return out;
}
const dailyBarStore = createDailyBarStore({
  directory: () => (typeof dailyBarDirectory === "function" ? dailyBarDirectory() : dailyBarDirectory),
  snapshot: dailyBarSnapshots,
  previousSession: date => dailyBarCalendar.previousSession(date),
  nextSession: date => dailyBarCalendar.nextSession(date)
});
/** 本地日线库只在内置交易日历确认的“最近完整交易日”工作；日历过期时直接下载，不入库。 */
function dailyBarAsOf() {
  try {
    const expected = dailyBarCalendar.expectedCloseDate(new Date());
    return expected.state === "known" && expected.inferred !== true && expected.date ? expected.date : null;
  } catch { return null; }
}
function configureDailyBarStore({ directory } = {}) {
  dailyBarDirectory = typeof directory === "function" || (typeof directory === "string" && directory) ? directory : null;
}

const strategySelectionMarketData = require("./trend-screener-adapter.cjs").createTrendMarketData({ historyBars: SELECTION_HISTORY_BARS, ths: trendThsLane, dailyStore: dailyBarStore, asOf: dailyBarAsOf });
const SELECTION_UNIVERSE_BOARDS = Object.freeze([
  { label: "深市主板", filter: "m:0+t:6" }, { label: "沪市主板", filter: "m:1+t:2" }, { label: "创业板", filter: "m:0+t:80" },
  { label: "科创板", filter: "m:1+t:23" }, { label: "北交所", filter: "m:0+t:81+s:2048" }
]);
const SELECTION_UNIVERSE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function selectionUniverseCacheFile() {
  const directory = typeof dailyBarDirectory === "function" ? dailyBarDirectory() : dailyBarDirectory;
  return directory ? require("node:path").join(directory, "selection-universe.json") : null;
}
function readSelectionUniverseCache() {
  try {
    const file = selectionUniverseCacheFile();
    if (!file) return null;
    const value = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    if (value?.v !== 1 || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > SELECTION_UNIVERSE_CACHE_MAX_AGE_MS || !value.boards) return null;
    return value;
  } catch { return null; }
}
function writeSelectionUniverseCache(boards) {
  try {
    const file = selectionUniverseCacheFile();
    if (!file) return;
    const fs = require("node:fs");
    const keep = row => ({ code: row.code, name: row.name, secid: row.secid, industry: row.industry, assetType: row.assetType || "stock",
      ...(row.listingDate ? { listingDate: row.listingDate, listingDateSource: row.listingDateSource } : {}) });
    const payload = { v: 1, savedAt: Date.now(), savedDate: shanghaiDateText(), boards: Object.fromEntries(boards.map(board => [board.label, board.rows.map(keep)])) };
    fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* 名单缓存只是兜底，写失败不影响本次选股 */ }
}
function shanghaiDateText(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** 全市场A股名单（含北交所），每个板块逐页读完并核对总数；名单自带当日行情供本地日线库补最新一根。 */
async function loadSelectionUniverse() {
  const signal = serviceSignal();
  const pageSize = 100;
  // 某一页在东方财富失败后，后续页会改走新浪，两个来源的总数不同会让整板判为缺页；
  // 这时整板从第 1 页重读一次（本轮已认定东财不可用，会整板走同一来源）。
  const boards = await Promise.all(SELECTION_UNIVERSE_BOARDS.map(async board => {
    const first = await loadBoard(board);
    if (first.complete) return first;
    signal?.throwIfAborted();
    const second = await loadBoard(board);
    return second.complete || second.rows.length > first.rows.length ? second : first;
  }));
  async function loadBoard(board) {
    const rows = [];
    const seen = new Set();
    let expected = null;
    try {
      for (let page = 1; page <= 200; page += 1) {
        signal?.throwIfAborted();
        const response = await serviceRuntime.track(() => trackServiceRequest(strategySelectionMarketData.fetchUniversePage({ filter: board.filter, page, pageSize, signal })));
        const total = Number(response?.total);
        if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(response?.rows)) throw new Error(`第 ${page} 页缺少有效总数`);
        if (expected === null) expected = total;
        else if (total !== expected) throw new Error(`第 ${page} 页总数从 ${expected} 变为 ${total}`);
        if (rows.length + response.rows.length > expected) throw new Error(`第 ${page} 页超出名单总数 ${expected}`);
        for (const row of response.rows) {
          const code = String(row?.code || "");
          if (!/^\d{6}$/.test(code)) throw new Error(`第 ${page} 页含无效证券代码`);
          if (seen.has(code)) throw new Error(`第 ${page} 页含重复证券 ${code}`);
          seen.add(code); rows.push({ ...row, code });
        }
        if (rows.length === expected || !response.rows.length || response.rows.length < pageSize) break;
      }
      if (expected === null || seen.size !== expected) throw new Error(`名单缺页：${seen.size}/${expected ?? "?"}`);
      return { label: board.label, expected, loaded: rows.length, complete: true, rows };
    } catch (error) {
      signal?.throwIfAborted();
      return { label: board.label, expected, loaded: rows.length, complete: false, error: error instanceof Error ? error.message : String(error), rows };
    }
  }
  // 1.6.47：名单是慢变数据。东方财富和新浪都没读全的板块，用本机最近一次完整名单（7 天内）补上，
  // 不让一次限流就整页选不出股票；全部读全时更新本机名单。
  const cached = readSelectionUniverseCache();
  for (const board of boards) {
    if (board.complete) continue;
    const saved = cached?.boards?.[board.label];
    if (!Array.isArray(saved) || !saved.length) continue;
    board.error = `${board.error || "名单缺页"}；已改用本机 ${cached.savedDate} 的完整名单（${saved.length} 只）`;
    board.rows = saved.map(row => ({ ...row }));
    board.loaded = saved.length;
    board.expected = saved.length;
    board.complete = true;
    board.fromCache = cached.savedDate;
  }
  if (boards.every(board => board.complete && !board.fromCache)) writeSelectionUniverseCache(boards);
  if (boards.every(board => !board.rows.length)) throw new Error(boards.map(board => `${board.label}：${board.error || "空名单"}`).join("；"));
  const rows = boards.flatMap(board => board.rows).map(row => {
    const industry = String(row?.industry || "").trim();
    return !industry || industry === "未分类" ? { ...row, industry: industryFromIndex(String(row?.code || "")) || "未分类" } : row;
  });
  return { rows, boards: boards.map(({ rows: _rows, ...board }) => board) };
}

const strategySelectionLoader = createStrategySelectionService({
  loadUniverse: () => loadSelectionUniverse(),
  prepareHistories: securities => serviceRuntime.track(() => strategySelectionMarketData.prepareHistories(securities)),
  loadHistory: async security => {
    const signal = serviceSignal();
    if (security.assetType === "index") return serviceRuntime.track(() => trackServiceRequest(strategySelectionMarketData.fetchBenchmark({ signal })));
    const result = await serviceRuntime.track(() => trackServiceRequest(strategySelectionMarketData.fetchHistory(toSecurity(security), "none", { signal })));
    // The dedicated adapter rejects malformed/duplicate rows; it never drops
    // evidence to repair a window or estimates amount from close * volume.
    Object.defineProperty(result.rows, "dataSource", { value: result.source || "unknown", configurable: true });
    return result.rows;
  },
  runEngine: buildStrategySignalReportInWorker,
  assertActive: () => serviceSignal()?.throwIfAborted()
});

function loadStrategySignals(options, runtime = {}) {
  return strategySelectionLoader.load(options, runtime);
}

const STRATEGY_SKIP_REASONS = Object.freeze({ stale: "日线没有更新到最近交易日（可能停牌）", missing: "没读到日线", invalid: "日线数据有异常",
  excluded: "ST 或风险股票，策略选股不覆盖" });
// 引擎给出的具体原因（dataQuality.reasons）→ 给 AI 和用户看的说明；比按类别的笼统说法准确。
const STRATEGY_SKIP_DETAILS = Object.freeze({
  incomplete_sessions: "最近 120 个交易日的日线不全（上市不足 120 个交易日，或期间停牌），策略选股不计算这只股票",
  missing_as_of_session: "日线没有最近交易日这一根（可能停牌或数据未更新）",
  insufficient_listing_sessions: "上市不足 120 个交易日，策略选股不计算这只股票",
  unresolved_price_basis: "区间内有除权除息，未复权日线前后价格不可比，策略选股不计算这只股票",
  missing_history: "没读到日线", risk_security: "ST 或风险股票，策略选股不覆盖"
});
/**
 * AI 问股（1.6.53）：用「策略选股」同一套引擎和本地日线，只算一只股票命中了哪些在用策略。
 * 按最近一个完整交易日的收盘数据（盘中看的是上一交易日收盘后的信号），和策略选股页的结果一致。
 */
async function strategyHitsForStock(input) {
  const security = toSecurity(input);
  const calendar = createTradingCalendar();
  const expected = calendar.expectedCloseDate(new Date());
  const marketDates = expected.state === "known" && expected.date ? calendar.sessionsThrough(expected.date, SELECTION_MARKET_SESSIONS) : null;
  if (!marketDates) throw new Error(expected.reason || "交易日历未覆盖最近交易日，暂时无法计算策略信号");
  const signal = serviceSignal();
  const [history, benchmark] = await Promise.all([
    serviceRuntime.track(() => trackServiceRequest(strategySelectionMarketData.fetchHistory(security, "none", { signal }))),
    serviceRuntime.track(() => trackServiceRequest(strategySelectionMarketData.fetchBenchmark({ signal }))).catch(() => [])
  ]);
  serviceSignal()?.throwIfAborted();
  const engine = require("./strategy-signal-engine.cjs");
  const report = engine.buildStrategySelectionReport([{ code: security.code, name: String(input?.name || security.code) }], { [security.code]: history?.rows || [] },
    Array.isArray(benchmark) ? benchmark : [], { selectionOnly: true, minCurrentHistoryBars: SELECTION_MARKET_SESSIONS, asOfDate: expected.date, marketDates,
      universe: "limit_pool", historicalReview: false });
  const quality = report?.dataQuality || {};
  const skipped = ["stale", "missing", "invalid", "excluded"].find(key => Number(quality[key]) > 0);
  const detail = Object.keys(quality.reasons || {}).map(reason => STRATEGY_SKIP_DETAILS[reason]).find(Boolean);
  const strategies = Array.isArray(report?.strategies) ? report.strategies.filter(item => !item.custom) : [];
  const hits = strategies.filter(item => item.stocks?.length).map(item => {
    const stock = item.stocks[0];
    return { id: item.id, name: item.name, featured: item.featured === true, family: item.family || "", signalDate: stock.signalDate || "",
      reasons: (stock.reasons || []).slice(0, 3), invalidationPrice: Number.isFinite(stock.invalidationPrice) ? stock.invalidationPrice : null,
      notes: (stock.executionNotes || []).slice(0, 3) };
  });
  return { asOfDate: expected.date, evaluated: Number(quality.processed) > 0, skippedReason: skipped ? detail || STRATEGY_SKIP_REASONS[skipped] : "",
    activeCount: strategies.length, featuredCount: strategies.filter(item => item.featured).length, hits };
}

function scanStrategySignals(rawOptions = {}, runtime = {}) {
  const options = strategySignalOptions(rawOptions);
  // Past the bundled calendar the loader infers sessions from the index; key by hour then.
  let selectionContext;
  try { selectionContext = strategySelectionLoader.context(); }
  catch { selectionContext = { asOfDate: `inferred:${new Date().toISOString().slice(0, 13)}` }; }
  const cacheKey = JSON.stringify([options, selectionContext.asOfDate]);
  const forceRefresh = rawOptions?.refresh === true;
  const identity = JSON.stringify([cacheKey, forceRefresh]);
  return serviceRuntime.run("selection", identity, runtime, async () => {
    const cached = strategySignalCache.get(cacheKey);
    if (!forceRefresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
    const generation = {};
    strategySignalLoads.set(cacheKey, generation);
    try {
      const value = await loadStrategySignals(options, { forceRefresh });
      serviceRuntime.checkpoint();
      // A newer load may already have published and removed its generation.
      // Absence is not permission for an older producer to replace that result.
      if (strategySignalLoads.get(cacheKey) === generation) {
        // A clean result for a completed session cannot change until the next
        // session closes; degraded results (failed/stale reads) retry after 5 min.
        const validUntil = Number(value?.cacheValidUntil);
        const expiresAt = Number.isFinite(validUntil) && validUntil > Date.now() ? validUntil : Date.now() + 5 * 60 * 1000;
        strategySignalCache.set(cacheKey, { value, expiresAt });
      }
      return value;
    } finally {
      if (strategySignalLoads.get(cacheKey) === generation) strategySignalLoads.delete(cacheKey);
    }
  });
}

async function getLimitUpSectorBoard(options = {}) {
  const rows = await getIndustrySectorBoard(options);
  serviceRuntime.checkpoint();
  return (Array.isArray(rows) ? rows : []).filter(row => !isBeijingSector(row))
    .sort((left, right) => {
      const a = finiteOrNull(left.returns?.r1) ?? finiteOrNull(left.memberAverageReturn);
      const b = finiteOrNull(right.returns?.r1) ?? finiteOrNull(right.memberAverageReturn);
      return a === null ? b === null ? 0 : 1 : b === null ? -1 : b - a;
    }).map((row, index) => ({ ...row, rank: index + 1 }));
}

/** 板块名归一：去掉「概念」「板块」后缀与空白，用于和同花顺涨停原因比对。 */
function sectorMatchName(value) {
  return String(value || "").replace(/\s+/g, "").replace(/(?:概念股?|板块|指数)$/u, "").toLowerCase();
}

const sectorLimitCounts = require("./sector-limit-counts.cjs").createSectorLimitCounts({
  loadMembers: async (sector, { signal }) => {
    const indexCode = sector.indexCode || (/^88[156]\d{3}$/.test(sector.code) ? sector.code : "");
    if (fuyao.configured() && indexCode) {
      const members = await fuyao.constituents(`${indexCode}.TI`, { signal });
      if (!members.length) throw new Error("板块成分名单为空");
      return { members, complete: sector.memberCount === null || members.length >= sector.memberCount };
    }
    const members = await thsOfficial.fetchThsSectorMembers(fetchWithPolicy,
      sector.boardType === "concept" ? { kind: "concept", cid: sector.conceptCid } : { kind: "industry", code: sector.code },
      { signal, maxPages: 5 });
    return { members, complete: sector.memberCount !== null && members.length >= sector.memberCount };
  },
  loadPool: async ({ signal }) => {
    if (!fuyao.configured()) throw new Error("实时涨停池尚未配置");
    const result = await fuyao.limitUpPool({ signal });
    const stamp = Date.parse(result.fetchedAt);
    const asOfDate = Number.isFinite(stamp) ? new Date(stamp + 8 * 3600000).toISOString().slice(0, 10) : "";
    return { stocks: result.rows, complete: new Set(result.rows.map(row => row.code)).size === result.total,
      asOfDate, fetchedAt: result.fetchedAt };
  }
});

function getSectorLimitUpCount(input, options = {}) {
  return sectorLimitCounts.count(input, { ...options, signal: serviceSignal(options.signal) });
}

/**
 * 板块强度（1.6.43）：行业 + 概念两张榜、今日涨停主线。
 * - 行业：同花顺行业资金流（90 个），家数通过按需成分股计数接口补齐；
 * - 概念：同花顺概念行情（涨幅、净流入），同样按真实成分与实时池求交集；
 * - 主线：同花顺涨停原因按「+」拆开计数（扶摇未配置时为空）。
 * 每一块独立失败，不拖累其他块。
 */
async function getSectorStrengthBoard(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  if (forceRefresh) sectorLimitCounts.clear();
  const [industries, catalog, quotes, review] = await Promise.allSettled([
    getLimitUpSectorBoard({ ...options, forceRefresh }),
    sectorExplorer.getSectorCatalog({}),
    sectorExplorer.getSectorQuotes(forceRefresh ? { forceRefresh: true } : {}),
    getFuyaoReviewSnapshot(options)
  ]);
  const warnings = [];
  const fuyaoData = review.status === "fulfilled" && review.value?.review.available ? review.value.review : null;
  if (!fuyaoData) warnings.push(review.status === "fulfilled" ? String(review.value?.review.reason || "同花顺扶摇未配置，概念的涨停家数与今日主线暂缺") : `今日主线暂不可用：${review.reason?.message || review.reason}`);
  const industryPool = review.status === "fulfilled" ? review.value.industryPool : null;
  const poolStocks = new Map((industryPool?.stocks || []).map(stock => [stock.code, stock]));
  const completePool = !!industryPool && poolStocks.size === industryPool.total;
  if (fuyaoData && !completePool) warnings.push("涨停池数据不完整，概念涨停家数暂缺");
  for (const warning of fuyaoData?.warnings || []) {
    if (warning.startsWith("涨停池本次刷新失败")) warnings.push(warning);
  }
  const concepts = [];
  if (catalog.status === "fulfilled" && quotes.status === "fulfilled") {
    const quoteMap = quotes.value?.quotes || {};
    for (const entry of catalog.value?.entries || []) {
      if (entry?.kind !== "concept") continue;
      const quote = quoteMap[entry.id];
      const changePct = finiteOrNull(quote?.changePct);
      if (changePct === null) continue;
      concepts.push({
        kind: "concept", id: entry.id, code: String(entry.code || ""), conceptCid: String(entry.code || ""), indexCode: String(quote?.indexCode || ""),
        name: String(entry.name || ""), changePct, netInflow: finiteOrNull(quote?.netInflow), memberCount: finiteOrNull(quote?.companyCount),
        leaderName: String(quote?.leaderName || ""), limitUps: null, limitUpStocks: [], countComplete: false
      });
    }
    concepts.sort((a, b) => b.changePct - a.changePct || a.name.localeCompare(b.name, "zh-CN"));
    for (const warning of quotes.value?.warnings || []) if (/概念/.test(warning)) warnings.push(warning);
  } else {
    const failure = catalog.status === "rejected" ? catalog.reason : quotes.reason;
    warnings.push(`概念板块暂不可用：${failure?.message || failure}`);
  }
  if (industries.status === "rejected" && !concepts.length) throw industries.reason;
  if (industries.status === "rejected") warnings.push(`行业板块暂不可用：${industries.reason?.message || industries.reason}`);
  const conceptNames = new Map(concepts.map((item) => [sectorMatchName(item.name), item]));
  const themes = (fuyaoData?.limitUp?.reasons || []).map((group) => {
    const concept = conceptNames.get(sectorMatchName(group.reason));
    return { reason: group.reason, count: group.count, stocks: group.stocks || [], ...(concept ? { concept: { name: concept.name, code: concept.code, conceptCid: concept.conceptCid } } : {}) };
  });
  // Count each visible board from its own constituent list through getSectorLimitUpCount.
  // Industry-name indices and theme text are insufficient evidence for a membership count.
  const industryRows = (industries.status === "fulfilled" ? industries.value : []).map(row => ({
    ...row, boardType: "industry", poolLimitUps: null, limitUps: null, leaders: [], countComplete: false
  }));
  return {
    fetchedAt: new Date().toISOString(),
    industries: industryRows,
    concepts,
    themes,
    limitUpTotal: completePool ? fuyaoData?.limitUp?.count ?? null : null,
    conceptLimitUpSource: "同花顺板块成分与实时涨停池",
    warnings
  };
}

async function getIndustrySectorBoard(options = {}) {
  // 榜单缓存：60 秒新鲜期 + 30 分钟陈旧兜底。
  // 「随时能用」的核心要求：外部源全挂时也要有一张可看的榜，而不是空白页。
  const boardKey = "sector:board";
  const now = Date.now();
  const fresh = sectorBoardCache.get(boardKey);
  if (fresh?.value && fresh.expiresAt > now && !options.forceRefresh) return fresh.value;
  try {
    const rows = await getLimitUpSectorBoardUncached(options);
    if (Array.isArray(rows) && rows.length) {
      const cached = sectorBoardCache.get(boardKey);
      // 新结果明显更少时保留原缓存（避免降级路径把完整榜单覆盖成残缺列表）
      if (preferRicherBoard(rows, cached?.value)) {
        return cached.value.map((row) => ({
          ...row,
          partial: true,
          sourceState: "保留上次完整榜单",
          warning: "本次实时源只返回了少量板块，已保留上次完整榜单以避免倒退。"
        }));
      }
      sectorBoardCache.set(boardKey, {
        value: rows,
        expiresAt: Date.now() + 60 * 1000,
        staleUntil: Date.now() + 30 * 60 * 1000
      });
      return rows;
    }
    return rows;
  } catch (error) {
    const stale = sectorBoardCache.get(boardKey);
    if (stale?.value?.length && stale.staleUntil > Date.now()) {
      return stale.value.map((row) => ({
        ...row,
        partial: true,
        sourceState: "上次有效榜单接力",
        warning: "实时板块源本次不可用，显示最近一次有效榜单；数据可能不是当日最新。"
      }));
    }
    throw error;
  }
}

/**
 * 强制刷新时若新数据明显不如缓存（行数骤减 > 60%），保留缓存。
 * 场景：同花顺挂了、只剩「涨停池分组」的兜底路径（3~15 行），
 * 此时用 15 行覆盖掉 90 行的完整榜单是**倒退**。
 * 判断标准用行数比例，而不是绝对条数 —— 不同时段涨停板块数差异很大。
 */
function preferRicherBoard(candidate, cachedValue) {
  if (!Array.isArray(candidate) || !candidate.length) return false;
  if (!Array.isArray(cachedValue) || !cachedValue.length) return false;
  return candidate.length < cachedValue.length * 0.4;
}

async function getLimitUpSectorBoardUncached(options = {}) {
  const [limitUpSnapshot, benchmark, { rows: allMarketHistory, label: marketProxy }, marketSnapshot, ladderPools] = await Promise.all([
    discoverLimitUps(options),
    hs300History(15, options).catch(() => []),
    marketProxyHistory(15, options),
    // A2-03：快照整体失败 = 市场广度/平均收益未知，不能退化成"广度 50% / 涨幅 0%"。
    wholeMarketSnapshot(options).catch(() => ({ breadth: null, averageReturn: null, stockCount: 0 })),
    currentLadderPools(options).catch(() => ({
      currentPool: [],
      previousPool: [],
      failedPool: null,
      failedPoolAvailable: false
    }))
  ]);
  const limitUps = limitUpSnapshot.rows;
  const allMarketReturns = {
    r1: allMarketHistory.length >= 2 ? returnFor(allMarketHistory, 1) : null,
    r3: allMarketHistory.length >= 4 ? returnFor(allMarketHistory, 3) : null,
    r5: allMarketHistory.length >= 6 ? returnFor(allMarketHistory, 5) : null
  };
  const benchmarkReturns = {
    r1: benchmark.length >= 2 ? returnFor(benchmark, 1) : null,
    r3: benchmark.length >= 4 ? returnFor(benchmark, 3) : null,
    r5: benchmark.length >= 6 ? returnFor(benchmark, 5) : null
  };
  const grouped = new Map();
  for (const item of limitUps) {
    const industry = stockIndustryIndex.lookup(item.code) || item.industry;
    if (!industry || industry === "未分类") continue;
    const list = grouped.get(industry) || [];
    list.push(item);
    grouped.set(industry, list);
  }
  // 榜单口径：优先用同花顺免费公开行业榜（全量 90 个板块，天然按涨幅降序）。
  // 原实现只取「涨停池里出现过的行业」前 15 个 —— 榜单会缺失大量当日未涨停但
  // 涨幅靠前的板块，与「板块强度按涨幅排名」的口径直不符。
  // 免费源不可用时回退到原逻辑（涨停池分组），保证功能不中断。
  // 板块列表的**权威来源**：数据中心资金流接口。
  //
  // 为什么不用 q.10jqka.com.cn/thshy/ 榜单页做列表：
  //   盘前/收盘后所有板块涨幅都是 0.00，同花顺按涨幅排序时**顺序不稳定**，
  //   导致翻页出现大量重复（实测两页 90 行里只有 51 个唯一板块）。
  // 资金流接口按固定顺序返回全部 90 个行业板块，且自带
  // changePct / inflow / outflow / netInflow / companyCount / leaderName，
  // 一本满足，不需要再拼榜单页。
  // 榜单页只作为兜底（资金流不可用时）。
  let publicTable = null;
  let boardSource = "";
  if (!providerCircuitOpen("ths-fund-flow")) {
    try {
      const flows = await thsOfficial.fetchThsFundFlow(fetchWithPolicy, "industry", { maxPages: 3, timeoutMs: 7000, signal: serviceSignal() });
      if (flows.length) {
        recordSectorProviderResult("ths-fund-flow", true);
        publicTable = flows.map((row) => ({
          code: row.code || "",
          name: row.name,
          changePct: row.changePct,
          // 资金流给的是「亿元」，统一成元，与其它字段口径一致
          amount: null,
          netInflow: row.netInflow === null ? null : row.netInflow * 1e8,
          rising: null,
          falling: null,
          companyCount: row.companyCount,
          inflow: row.inflow,
          outflow: row.outflow,
          leaderName: row.leaderName,
          leaderChangePct: row.leaderChangePct,
          leaderPrice: row.leaderPrice
        }));
        boardSource = "同花顺数据中心资金流";
      }
    } catch {
      recordSectorProviderResult("ths-fund-flow", false);
    }
  }
  if (!publicTable?.length && !providerCircuitOpen("ths-public-sector")) {
    try {
      publicTable = await loadThsPublicSectorTable(serviceSignal(options.signal));
      boardSource = "同花顺免费公开板块";
      recordSectorProviderResult("ths-public-sector", true);
    } catch {
      recordSectorProviderResult("ths-public-sector", false);
      publicTable = null;
    }
  }
  // 同时抓板块资金流（data.10jqka.com.cn，需 hexin-v token）。
  // 这是此前完全缺失的「主力净流入」来源：实时榜只给涨跌幅与涨跌家数。
  // 资金流失败不影响榜单主体，只是该列显示为 --。
  // 资金流已在上面作为主数据源抓过一次（publicTable 自带 inflow/outflow/netInflow/leaderName），
  // 这里不再重复请求 —— 重复抓同一接口既慢又容易被限流。
  const fundFlowByName = new Map();
  for (const item of publicTable || []) {
    if (item.inflow !== undefined || item.netInflow !== undefined) {
      fundFlowByName.set(item.name, {
        netInflow: Number.isFinite(item.netInflow) ? item.netInflow / 1e8 : null, // 元 → 亿
        inflow: item.inflow ?? null,
        outflow: item.outflow ?? null,
        leaderName: item.leaderName || "",
        leaderChangePct: item.leaderChangePct ?? null,
        leaderPrice: item.leaderPrice ?? null
      });
    }
  }
  const groupedByIndustry = grouped;
  const leaders = [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);
  const rows = [];

  /**
   * 榜单行的综合强度评分 —— 与 buildSectorStrengthFromData 同一套口径，
   * 只是用榜单页能拿到的聚合字段（涨幅/净流入/涨跌家数/成交额）来算。
   *
   * 之前这里直接写 `score: null` 和 `dataCoveragePercent: 33`，
   * 导致界面上「综合强度」永远是 --、覆盖永远 33%，看起来像数据不全，
   * 实际上涨幅/广度/资金流/成交额都已经拿到了。
   */
  const scoreBoardRow = ({ changePct, breadth, marketBreadth, netInflow, amount, rising, falling }) => {
    if (!Number.isFinite(changePct) || !Number.isFinite(breadth)) return null;
    let raw = 50;
    raw += changePct * 4;                                    // 板块涨幅
    if (Number.isFinite(marketBreadth)) raw += (breadth - marketBreadth) * 30;  // 相对广度
    raw += Math.min(12, Math.max(0, (rising + falling) > 0 ? 0 : 0));            // 预留（涨停数需涨停池，见下）
    // 资金流：净额/成交额 > 0 说明资金真流入；用比例而非绝对值，避免大小板块不可比
    if (Number.isFinite(netInflow) && Number.isFinite(amount) && amount > 0) {
      raw += clamp(netInflow / (amount / 1e8) * 8, -12, 12, 0);
    }
    return Math.round(clamp(raw, 0, 100));
  };

  /** 榜单行的真实字段覆盖率：按「该板块实际拿到的字段」逐项统计 */
  /**
   * 榜单行的真实字段覆盖率。
   *
   * 只看「该数据源本应提供」的字段：
   *   · 资金流源：涨跌幅 / 流入 / 流出 / 净额 / 公司家数 / 领涨股 / 领涨涨幅
   *   · 榜单页源：涨跌幅 / 涨跌家数 / 成交额 / 净流入 / 领涨股
   * 不把两个源都不提供的字段（如 1/3/5 日超额）算进分母 —— 那会让覆盖率永远偏低，
   * 界面误报「只覆盖三分之一」。
   */
  const boardRowCoverage = (item) => {
    const has = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) === (typeof v !== "string");
    const checks = [
      Number.isFinite(item.changePct),
      Number.isFinite(item.inflow),
      Number.isFinite(item.outflow),
      Number.isFinite(item.netInflow),
      Number.isFinite(item.companyCount),
      Boolean(item.leaderName)
    ];
    void has;
    return Math.round(checks.filter(Boolean).length / checks.length * 100);
  };

  // ── 同花顺免费公开行业榜：全量板块 + 官方涨幅/广度/成交额 ──
  // 这是「板块强度」榜单的首选口径：涨幅、上涨/下跌家数、成交额都由官方给出，
  // 且天然按涨幅降序。历史类指标（1/3/5 日超额、延续性）仍需东财历史，缺失时显示 --。
  if (publicTable?.length) {
    const mappedCount = publicTable.reduce((count, item) => count + (groupedByIndustry.get(item.name)?.length || 0), 0);
    const fullyMapped = Boolean(limitUpSnapshot.meta?.dataDate) && mappedCount === limitUps.length;
    for (const item of publicTable) {
      // 资金流源没有涨跌家数，用「公司家数」作为板块规模；
      // 榜单页源有 rising/falling，可算真实广度。两者取各自能给的。
      const rising = Number.isFinite(item.rising) ? Math.max(0, Math.round(item.rising)) : null;
      const falling = Number.isFinite(item.falling) ? Math.max(0, Math.round(item.falling)) : null;
      const total = rising !== null && falling !== null ? rising + falling : null;
      const poolStocks = groupedByIndustry.get(item.name) || [];
      const flow = fundFlowByName.get(item.name) || null;
      const netInflowValue = flow?.netInflow ?? item.netInflow;
      // 广度：有涨跌家数就算真实广度；资金流源没有，用净额方向作弱代理（-1..1 映射到 0..1）
      const breadthValue = total !== null && total > 0
        ? rising / total
        : (Number.isFinite(item.netInflow) && Number.isFinite(item.inflow) && Number.isFinite(item.outflow)
          ? 0.5 + clamp((item.inflow - item.outflow) / Math.max(1, item.inflow + item.outflow), -1, 1, 0) * 0.5
          : null);
      const boardScore = scoreBoardRow({
        changePct: item.changePct,
        breadth: breadthValue,
        marketBreadth: marketSnapshot.breadth,
        netInflow: netInflowValue,
        amount: item.amount,
        rising,
        falling
      });
      const coverage = boardRowCoverage({
        changePct: item.changePct,
        inflow: item.inflow,
        outflow: item.outflow,
        netInflow: netInflowValue,
        companyCount: item.companyCount ?? total,
        leaderName: item.leaderName || flow?.leaderName
      });
      rows.push({
        code: item.code,
        name: item.name,
        secid: "",
        returns: { r1: item.changePct, r3: null, r5: null },
        benchmarkReturns,
        allMarketReturns,
        excess: null,
        breadth: total > 0 ? rising / total : null,
        marketBreadth: marketSnapshot.breadth,
        memberAverageReturn: item.changePct,
        memberAverageTurnover: null,
        relativeReturn: null,
        amount: item.amount,
        // 净流入统一存「元」。资金流源给的是亿元，这里已换算；
        // 榜单页源的 netInflow 也已经在上面的 publicTable 映射里换算过。
        netInflow: Number.isFinite(item.netInflow) ? item.netInflow : (Number.isFinite(flow?.netInflow) ? flow.netInflow * 1e8 : null),
        fundInflow: flow?.inflow ?? null,
        fundOutflow: flow?.outflow ?? null,
        leaderName: flow?.leaderName || "",
        leaderChangePct: flow?.leaderChangePct ?? null,
        leaderPrice: flow?.leaderPrice ?? null,
        rising,
        falling,
        memberCount: finiteOrNull(item.companyCount) ?? total,
        averagePrice: item.averagePrice,
        score: boardScore,
        state: sectorStateFromScore(boardScore),
        dataCoveragePercent: coverage,
        leadershipQualityScore: boardScore,
        poolLimitUps: poolStocks.length || (fullyMapped ? 0 : null),
        poolShare: limitUps.length ? poolStocks.length / limitUps.length : 0,
        leaders: poolStocks.slice(0, 5).map((x) => ({
          code: x.code, name: x.name, changePct: x.changePct, turnover: x.turnover
        })),
        totalPool: limitUps.length,
        marketSnapshot,
        marketProxy,
        dataSource: boardSource || "同花顺免费公开板块",
        sourceState: "官方实时",
        scoreMode: "按涨幅排名（官方口径）",
        warning: "涨幅、上涨/下跌家数、成交额来自同花顺免费公开页；1/3/5 日超额与延续性需要历史序列，本次未取得，显示为 --。",
        providerPriority: [...SECTOR_PROVIDER_PRIORITY]
      });
    }
  }

  // Keep requests sequential. Each provider also has spacing, a short circuit breaker,
  // single-flight caching and independent fallbacks, so one throttled host cannot fan out.
  for (const [industry, stocks] of (rows.length ? [] : leaders)) {
    const strength = await sectorStrength(industry, {
      benchmark,
      marketBreadth: marketSnapshot.breadth,
      marketAverageReturn: marketSnapshot.averageReturn,
      ladderPools,
      options
    }).catch(() => null);
    if (strength) {
      rows.push({
        ...strength,
        poolLimitUps: stocks.length,
        poolShare: limitUps.length ? stocks.length / limitUps.length : 0,
        leaders: stocks.slice(0, 5).map((item) => ({
          code: item.code,
          name: item.name,
          changePct: item.changePct,
          turnover: item.turnover
        })),
        totalPool: limitUps.length,
        allMarketReturns,
        benchmarkReturns,
        marketSnapshot,
        marketProxy
      });
    } else {
      const industryLadder = buildSectorLadder({
        ...ladderPools,
        memberCodes: stocks.map((item) => item.code)
      });
      rows.push({
        code: "",
        name: industry,
        secid: "",
        returns: { r1: null, r3: null, r5: null },
        benchmarkReturns,
        excess: null,
        breadth: null,
        marketBreadth: marketSnapshot.breadth,
        relativeBreadth: null,
        memberAverageReturn: null,
        marketAverageReturn: marketSnapshot.averageReturn,
        relativeReturn: null,
        memberAverageTurnover: null,
        limitUps: stocks.length,
        memberCount: null,
        constituents: [],
        limitUpStocks: stocks,
        ladder: {
          ...industryLadder,
          asOfDate: ladderPools.currentDate,
          previousDate: ladderPools.previousDate
        },
        amountHeat: null,
        persistence: null,
        score: null,
        state: "详情源暂不可用",
        sourceState: "多源均不可用",
        dataSource: "仅涨停池",
        providerPriority: [...SECTOR_PROVIDER_PRIORITY],
        scoreMode: "评分暂停",
        poolLimitUps: stocks.length,
        poolShare: limitUps.length ? stocks.length / limitUps.length : 0,
        leaders: stocks.slice(0, 5),
        totalPool: limitUps.length,
        allMarketReturns,
        marketSnapshot,
        marketProxy,
        history: [],
        partial: true,
        warning: "同花顺主源、东方财富实时/延迟次源与新浪备用源本次均不可用；仅保留涨停池和梯队，未取得的详情显示为 --。"
      });
    }
  }
  // 板块强度排名：按**板块涨幅**降序（同花顺惯例 —— 涨幅是最直观的强度表现）。
  // 原实现按综合强度 score 排序，但 score 是多个因子的加权结果，用户无法一眼
  // 从界面上验证排名是否合理；改为按涨幅排序后，排名与「板块涨幅」这一列直接对应。
  // score 仍保留在数据里作为辅助参考（排序不再使用）。
  // 涨幅缺失（-- ）的板块排在最后，并保持涨停家数降序作为次级排序。
  return rows
    .filter(Boolean)
    .sort((a, b) => {
      const left = finiteOrNull(a.memberAverageReturn);
      const right = finiteOrNull(b.memberAverageReturn);
      if (left === null && right === null) return b.poolLimitUps - a.poolLimitUps;
      if (left === null) return 1;
      if (right === null) return -1;
      if (right !== left) return right - left;
      return b.poolLimitUps - a.poolLimitUps;
    })
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

async function testProvider(settings = {}) {
  settings = settings || {};
  const started = Date.now();
  const security = toSecurity("600000");
  const lane = async (id, label, factory) => {
    const laneStarted = Date.now();
    try {
      const quote = await factory();
      if (id !== "quantapi") marketSourceHealth.recordSuccess(id, Date.now() - laneStarted);
      return { id, label, ok: true, latency: Date.now() - laneStarted, latest: quote.latest, name: quote.name };
    } catch (error) {
      if (chainShouldStop()) throw error;
      if (id !== "quantapi") marketSourceHealth.recordFailure(id, error, Date.now() - laneStarted, serviceSignal(settings.signal));
      return { id, label, ok: false, latency: Date.now() - laneStarted, message: String(error?.message || error).slice(0, 120) };
    }
  };
  const hasToken = Boolean(String(settings.refreshToken || "").trim());
  const fuyaoKey = String(settings.fuyaoApiKey || "").trim();
  const lanes = await Promise.all([
    ...(fuyaoKey ? [lane("fuyao", "同花顺扶摇接口", async () => {
      const client = createFuyaoClient({ getApiKey: () => fuyaoKey });
      const quote = (await client.snapshot([security])).get("600000.SH");
      if (!quote || !(quote.latest > 0)) throw new Error("扶摇快照没有返回有效价格");
      return { latest: quote.latest, name: "浦发银行" };
    })] : []),
    lane("ths_free", "同花顺免费行情", () => trackedThsFreeQuote(security)),
    lane("eastmoney", "东方财富", () => eastQuote(security, 6000)),
    lane("tencent", "腾讯", async () => normalizeTencentQuote(security, await tencentQuote(security))),
    ...(hasToken ? [lane("quantapi", "同花顺 QuantAPI", () => thsQuote(security, settings))] : [])
  ]);
  const working = lanes.filter((item) => item.ok);
  const first = working[0];
  const summary = lanes.map((item) => `${item.label}${item.ok ? ` ✓ ${item.latency}ms` : " ✗"}`).join(" · ");
  const thsFree = lanes.find((item) => item.id === "ths_free");
  return {
    ok: working.length > 0,
    provider: settings.provider,
    latency: Date.now() - started,
    lanes,
    message: working.length
      ? `${thsFree?.ok ? "同花顺免费行情可用" : "同花顺免费行情不可用，已有接力线路"}：${first.name || "浦发银行"} ${first.latest}。${summary}`
      : `三路行情均不可用，请检查网络。${lanes.map((item) => `${item.label}：${item.message}`).join("；")}`
  };
}

function buildSequentialSamplePath(samples = [], options = {}) {
  const startingCapital = Math.max(1000, Number(options.startingCapital) || 200000);
  const positionPercent = clamp(Number(options.positionPercent ?? 100), 1, 100);
  const roundTripCostPercent = Math.max(0, Number(options.roundTripCostPercent) || 0);
  const ordered = (Array.isArray(samples) ? samples : [])
    .filter((sample) =>
      /^\d{4}-\d{2}-\d{2}$/.test(String(sample?.entryDate || "")) &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(sample?.exitDate || "")) &&
      Number.isFinite(Number(sample?.r5))
    )
    .sort((left, right) => {
      const byEntry = String(left.entryDate).localeCompare(String(right.entryDate));
      if (byEntry) return byEntry;
      return Number(left.node || 0) - Number(right.node || 0);
    });
  let capital = startingCapital;
  let lastExitDate = "";
  let skippedOverlaps = 0;
  const points = [];
  for (const sample of ordered) {
    const entryDate = String(sample.entryDate).slice(0, 10);
    const exitDate = String(sample.exitDate).slice(0, 10);
    if (lastExitDate && entryDate <= lastExitDate) {
      skippedOverlaps += 1;
      continue;
    }
    const grossReturnPercent = Number(sample.r5);
    const netReturnPercent = grossReturnPercent - roundTripCostPercent;
    const allocatedCapital = capital * positionPercent / 100;
    capital += allocatedCapital * netReturnPercent / 100;
    points.push({
      entryDate,
      exitDate,
      node: sample.node,
      grossReturnPercent: Number(grossReturnPercent.toFixed(4)),
      netReturnPercent: Number(netReturnPercent.toFixed(4)),
      capital: Number(capital.toFixed(2))
    });
    lastExitDate = exitDate;
  }
  return {
    startingCapital,
    endingCapital: Number(capital.toFixed(2)),
    positionPercent,
    roundTripCostPercent,
    skippedOverlaps,
    points
  };
}

function getStrategyDefinitions() {
  return strategyDefinitions().map((definition) => ({
    id: String(definition.id || ""),
    name: String(definition.name || definition.id || ""),
    type: definition.type === "composite" ? "composite" : "base",
    ...(definition.version ? {
      version: definition.version,
      sources: definition.sources,
      parameters: definition.parameters,
      adaptationNote: definition.adaptationNote,
      componentNames: definition.componentNames
    } : {}),
    family: definition.family, scope: definition.scope, dataRequirements: definition.dataRequirements, evidenceLevel: definition.evidenceLevel,
    featured: definition.featured === true,
    ...(definition.retired === true ? { retired: true } : {}),
    detail: String(definition.detail || ""),
    conditions: Array.isArray(definition.conditions)
      ? definition.conditions.map(String)
      : [],
    risk: String(definition.risk || ""),
    components: Array.isArray(definition.components)
      ? definition.components.map(String)
      : [],
    voteRule: String(definition.voteRule || "单策略逐日命中")
  }));
}

async function loadBacktestHistory(
  security,
  settings = {},
  limit = 260,
  loaders = {},
  requirements = {}
) {
  serviceRuntime.checkpoint();
  const loadThs = loaders.ths || ((target, bars) =>
    thsHistoryCached(target, settings, bars));
  const loadEastmoney = loaders.eastmoney || ((target, bars) =>
    eastMoneyHistory(target, bars, 0));
  const loadPublic = loaders.public || ((target, bars) =>
    eastHistoryCached(target, bars, 0, 20 * 60 * 1000));
  // 回测原价日线：同花顺扶摇（有 Key）→ 同花顺免费日线；都取不到才走东方财富等应急源。
  const loadThsPublic = loaders.thsPublic || (async (target, bars) => {
    if (fuyaoUsable() && fuyaoThscode(target) && isAStockCode(target.code)) {
      try { return await fuyaoHistoryStep(target, bars, 0); }
      catch { serviceRuntime.checkpoint(); }
    }
    if (thsFreeMarket.thsFreeSupports(target) && !marketSourceHealth.isOpen("ths_free_history")) return thsFreeHistory(target, bars, 0);
    throw new Error("同花顺日线不支持该证券");
  });
  const loadStandard = async () => {
    serviceRuntime.checkpoint();
    const thsSelected = settings?.provider === "ths";
    const hasThsToken = Boolean(String(settings?.refreshToken || "").trim());
    if (thsSelected && hasThsToken) {
      try {
        const rows = await serviceRuntime.track(() => loadThs(security, limit));
        serviceRuntime.checkpoint();
        if (!Array.isArray(rows) || !rows.length) {
          throw new Error("历史行情为空");
        }
        return rows;
      } catch (error) {
        serviceRuntime.checkpoint();
        if (settings?.fallbackEnabled === false) {
          throw new Error(
            `同花顺历史行情获取失败，且已关闭备用行情：${error?.message || error}`,
            { cause: error }
          );
        }
      }
    }
    try {
      const rows = await serviceRuntime.track(() => loadThsPublic(security, limit));
      serviceRuntime.checkpoint();
      if (Array.isArray(rows) && rows.length >= Math.min(limit, 20)) return rows;
    } catch {
      serviceRuntime.checkpoint();
    }
    try {
      const rows = await serviceRuntime.track(() => loadEastmoney(security, limit));
      serviceRuntime.checkpoint();
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error("东方财富历史行情为空");
      }
      return rows;
    } catch (eastmoneyError) {
      serviceRuntime.checkpoint();
      if (settings?.fallbackEnabled === false) {
        throw new Error(
          `东方财富历史行情获取失败，且已关闭后续备用行情：${eastmoneyError?.message || eastmoneyError}`,
          { cause: eastmoneyError }
        );
      }
      return serviceRuntime.track(() => loadPublic(security, limit));
    }
  };
  if (requirements.requireAmount !== true) return loadStandard();
  const incomplete = message => Object.assign(new Error(`回测数据不足：${message}`), { code: "BACKTEST_DATA_INCOMPLETE" });
  const requiredWindow = Math.max(1, Math.round(Number(requirements.windowBars) || 80));
  const minimumRows = Number.isSafeInteger(requirements.minimumRows) && requirements.minimumRows > 0 && requirements.minimumRows <= limit
    ? requirements.minimumRows : limit;
  const check = inputRows => {
    const rows = requirements.completedAt
      ? completedBacktestRows(inputRows, completedBacktestDate(requirements.completedAt, inputRows), minimumRows)
      : inputRows;
    if (!Array.isArray(rows) || rows.length < minimumRows) throw incomplete(`请求窗口 ${minimumRows} 根，实际仅 ${rows?.length || 0} 根，不能缩短窗口后当作完整回测`);
    const fields = ["volume", "amount"].map(field => ({ field, missing: rows.filter(row => row[field] === null || row[field] === undefined || row[field] === "" || !Number.isFinite(Number(row[field])) || Number(row[field]) < 0).length })).filter(item => item.missing);
    if (fields.length) throw incomplete(`${security.code} ${fields.map(item => `${item.field} 缺失/无效 ${item.missing}/${rows.length} 根`).join("；")}；所选量价组合不能将缺数解释为0信号`);
    let positiveRun = 0, evaluableWindow = false;
    for (const row of rows) {
      positiveRun = Number(row.volume) > 0 && Number(row.amount) > 0 ? positiveRun + 1 : 0;
      if (positiveRun >= requiredWindow && (!requirements.signalFrom || row.date >= requirements.signalFrom)) evaluableWindow = true;
    }
    if (!evaluableWindow) throw incomplete(`请求信号区间没有连续${requiredWindow}根正量额可评估窗口（包含停牌或零量额区间）；不能将不可评估解释为0信号`);
    return rows;
  };
  let originalError;
  try { return check(await loadStandard()); }
  catch (error) {
    serviceRuntime.checkpoint();
    if (settings?.fallbackEnabled === false) throw error;
    originalError = error;
  }
  try {
    // The scanner's raw path uses documented Sohu volume/amount units and
    // independently cross-checks raw OHLC with Tencent. Never estimate C*V.
    const loadCompleteRaw = loaders.completeRaw || ((target, bars) => {
      if (bars > 1500) throw incomplete(`公开量额备用源最多1500根，请求${bars}根超出来源窗口`);
      return require("./trend-screener-adapter.cjs").createTrendMarketData({ historyBars: bars, ths: trendThsLane })
        .fetchHistory(target, "none", { signal: serviceSignal() });
    });
    const completeRawLimit = minimumRows <= 1500 ? Math.min(limit, 1500) : limit;
    const result = await serviceRuntime.track(() => trackServiceRequest(Promise.resolve(loadCompleteRaw(security, completeRawLimit))));
    serviceRuntime.checkpoint();
    if (result?.adjustment !== "none") throw incomplete("备用日线没有明确不复权口径，不能替换原价回测");
    const completedRows = check(result.rows);
    const rows = validateHistoryRows(completedRows.slice(-limit), {source:result.source || "verified raw",minimumRows});
    check(rows);
    Object.defineProperties(rows, {
      dataSource:{value:result.source || "verified-raw",enumerable:false},
      actualAdjustment:{value:0,enumerable:false},
      provenance:{value:result.provenance || null,enumerable:false}
    });
    return rows;
  } catch (error) {
    serviceRuntime.checkpoint();
    throw incomplete(`${originalError?.message || "原来源未满足量额要求"}；核验量额备用失败：${error?.message || error}`);
  }
}

function buildPortfolioBacktestInWorker(payload = {}) {
  return serviceRuntime.track(() => workerRunner.run(workerScriptPath(__dirname, "portfolio-backtest-worker.cjs"), payload, {
    signal: serviceSignal(),
    timeoutMs: DEFAULT_OPERATION_TIMEOUTS.portfolio,
    timeoutMessage: "组合回测计算超时，已停止本轮任务以保证软件可正常使用"
  }));
}

function buildPortfolioSignalTimeline(replay = {}, portfolio = {}) {
  const tradesBySampleId = new Map(
    (portfolio.trades || []).map((trade) => [String(trade.sampleId || ""), trade])
  );
  const holdingsBySampleId = new Map((portfolio.holdings || []).map(holding => [String(holding.sampleId || ""), holding]));
  const portfolioRejectionsBySampleId = new Map(
    (portfolio.rejections || []).map((rejection) => [
      String(rejection.sampleId || ""),
      rejection
    ])
  );
  const signalEvents = [];
  const normalizeStrategyIds = (row) => [...new Set(
    (Array.isArray(row?.strategyIds) && row.strategyIds.length
      ? row.strategyIds
      : [row?.strategyId])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )];
  const addEvent = (row, status, execution = {}) => {
    const strategyIds = normalizeStrategyIds(row);
    signalEvents.push({
      sampleId: String(row?.sampleId || ""),
      code: String(row?.code || ""),
      name: String(row?.name || row?.code || ""),
      strategyId: String(row?.strategyId || strategyIds[0] || ""),
      strategyIds,
      matchedStrategyIds: strategyIds,
      signalDate: String(row?.signalDate || ""),
      entryDate: String(row?.entryDate || ""),
      exitDate: String(row?.exitDate || ""),
      status,
      executed: status === "filled" || status === "held",
      reason: String(execution?.reason || row?.reason || ""),
      reasonText: String(execution?.reasonText || row?.reasonText || ""),
      allocation: execution?.allocation ?? null,
      shares: execution?.shares ?? null,
      netReturnPercent: execution?.netReturnPercent ?? null,
      pnl: execution?.pnl ?? null
    });
  };

  for (const sample of replay.samples || []) {
    const sampleId = String(sample?.sampleId || "");
    const trade = tradesBySampleId.get(sampleId);
    if (trade) {
      addEvent(sample, "filled", trade);
      continue;
    }
    const holding = holdingsBySampleId.get(sampleId);
    if (holding) { addEvent(sample, "held", { ...holding, reasonText: "已入场，期末仍占用资金与席位，收益未结算" }); continue; }
    const rejection = portfolioRejectionsBySampleId.get(sampleId);
    addEvent(sample, "rejected", rejection || {
      reason: "not_executed",
      reasonText: "策略已命中，但共享资金账户未形成实际成交"
    });
  }
  for (const rejection of replay.rejectedSignals || replay.rejections || []) {
    addEvent(rejection, "rejected", rejection);
  }
  for (const pending of replay.pendingSignals || []) {
    const id = String(pending.sampleId || "");
    const rejection = portfolioRejectionsBySampleId.get(id);
    const holding = holdingsBySampleId.get(id);
    if (rejection) addEvent(pending, "rejected", rejection);
    else if (holding) addEvent(pending, "held", { ...holding, reasonText: "已入场，期末仍占用资金与席位，收益未结算" });
    else addEvent(pending, "pending", pending);
  }

  signalEvents.sort((left, right) =>
    right.signalDate.localeCompare(left.signalDate) ||
    left.code.localeCompare(right.code) ||
    left.strategyId.localeCompare(right.strategyId) ||
    left.sampleId.localeCompare(right.sampleId)
  );
  const timelineByDate = new Map();
  for (const event of signalEvents) {
    const row = timelineByDate.get(event.signalDate) || {
      date: event.signalDate,
      signalDate: event.signalDate,
      matchedStockCount: 0,
      filledCount: 0,
      rejectedCount: 0,
      pendingCount: 0,
      stocks: []
    };
    row.matchedStockCount += 1;
    if (event.status === "filled" || event.status === "held") row.filledCount += 1;
    if (event.status === "rejected") row.rejectedCount += 1;
    if (event.status === "pending") row.pendingCount += 1;
    row.stocks.push(event);
    timelineByDate.set(event.signalDate, row);
  }
  return {
    signalEvents,
    signalTimeline: [...timelineByDate.values()]
  };
}

const BACKTEST_NUMERIC_SETTING_KEYS = Object.freeze([
  "minProjectedNetEdgePercent",
  "minExpectancyPoints",
  "minTurnoverPercent",
  "minQuoteAmount",
  "maxQuoteAgeSeconds",
  "commissionBps",
  "slippageBps",
  "maxPositionPercent",
  "maxRiskPerTradePercent",
  "stopLossATRMultiple",
  "takeProfitATRMultiple",
  "maxHoldingBars",
  "maxOpenPositions",
  "maxDailyRiskPercent",
  "maxPortfolioRiskPercent",
  "maxSectorExposurePercent",
  "minExecutionRatePercent",
  "trailingStopPercent",
  "maxConsecutiveLossesForStop",
  "lossStreakStepPercent",
  "lossStreakFloorPercent",
  "lossStepPercent",
  "lossFloorPercent",
  "timeDecayPerBarPercent",
  "minPaperWinRatePercent",
  "minPaperRiskRewardRatio",
  "minSamples"
]);

function sanitizeBacktestSettingOverrides(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings
    : {};
  const safe = {};
  if (Array.isArray(source.selectedStrategies)) {
    safe.selectedStrategies = [...new Set(
      source.selectedStrategies
        .map((item) => String(item || "").trim())
        .filter((item) => /^[A-Za-z0-9_-]{1,64}$/.test(item))
    )];
  }
  if (["conservative", "balanced", "aggressive"].includes(source.riskProfile)) {
    safe.riskProfile = source.riskProfile;
  }
  for (const key of BACKTEST_NUMERIC_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = Number(source[key]);
    if (Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

function mergeBacktestSettings(serviceSettings = {}, optionSettings = {}) {
  const trusted = serviceSettings && typeof serviceSettings === "object" && !Array.isArray(serviceSettings)
    ? serviceSettings
    : {};
  const untrusted = optionSettings && typeof optionSettings === "object" && !Array.isArray(optionSettings)
    ? optionSettings
    : {};
  const merged = { ...trusted };
  // main.cjs historically pre-merged options.settings into serviceSettings.
  // Remove every renderer-provided key first so a sensitive value cannot survive
  // that earlier merge, then add back only the explicitly safe backtest fields.
  for (const key of Object.keys(untrusted)) delete merged[key];
  return {
    ...merged,
    ...sanitizeBacktestSettingOverrides(untrusted)
  };
}

function safeBacktestStrategyProfile(settings = {}, selectedStrategies = []) {
  const safe = sanitizeBacktestSettingOverrides(settings);
  const profile = {};
  const publicNumericKeys = [
    "minProjectedNetEdgePercent",
    "minExpectancyPoints",
    "minTurnoverPercent",
    "minQuoteAmount",
    "maxQuoteAgeSeconds",
    "commissionBps",
    "slippageBps",
    "maxPositionPercent",
    "maxRiskPerTradePercent",
    "stopLossATRMultiple",
    "takeProfitATRMultiple",
    "maxHoldingBars",
    "maxOpenPositions",
    "maxDailyRiskPercent",
    "maxPortfolioRiskPercent",
    "maxSectorExposurePercent",
    "minExecutionRatePercent",
    "trailingStopPercent",
    "maxConsecutiveLossesForStop",
    "timeDecayPerBarPercent"
  ];
  if (safe.riskProfile) profile.riskProfile = safe.riskProfile;
  for (const key of publicNumericKeys) {
    if (Object.prototype.hasOwnProperty.call(safe, key)) profile[key] = safe[key];
  }
  const lossStepPercent = safe.lossStepPercent ?? safe.lossStreakStepPercent;
  const lossFloorPercent = safe.lossFloorPercent ?? safe.lossStreakFloorPercent;
  if (Number.isFinite(lossStepPercent)) profile.lossStepPercent = lossStepPercent;
  if (Number.isFinite(lossFloorPercent)) profile.lossFloorPercent = lossFloorPercent;
  profile.selectedStrategies = [...new Set(
    (Array.isArray(selectedStrategies) ? selectedStrategies : [])
      .map((item) => String(item || "").trim())
      .filter((item) => /^[A-Za-z0-9_-]{1,64}$/.test(item))
  )];
  return profile;
}

// One job freezes its clock before any I/O. A gateway may append a live daily
// quote; neither that row nor future-dated rows are settled backtest prices.
function incompleteBacktestBarAllowance(now) {
  const clock = shanghaiClock(now);
  return clock.minute < 15 * 60 + 10 && createTradingCalendar().isSession(clock.date) !== false ? 1 : 0;
}

function completedBacktestDate(now, benchmarkRows) {
  const calendar = createTradingCalendar(undefined, {
    observedSessions: (Array.isArray(benchmarkRows) ? benchmarkRows : []).map(row => String(row?.date || "").slice(0, 10))
  });
  const boundary = calendar.expectedCloseDate(now);
  if (!boundary.date) throw new Error(`回测无法确定完整收盘日期：${boundary.reason}`);
  return boundary.date;
}

function completedBacktestRows(rows, cutoffDate, limit) {
  const completed = (Array.isArray(rows) ? rows : [])
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || "")) && row.date <= cutoffDate)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-limit);
  // Data-source and adjustment evidence lives on non-enumerable array fields.
  for (const key of ["dataSource", "actualAdjustment", "provenance"]) {
    const descriptor = Array.isArray(rows) && Object.getOwnPropertyDescriptor(rows, key);
    if (descriptor) Object.defineProperty(completed, key, descriptor);
  }
  return completed;
}

function runPortfolioBacktest(input = {}, serviceSettings = {}, runtime = {}) {
  return serviceRuntime.run("portfolio", semanticKey([input, serviceSettings]), runtime, () => executePortfolioBacktest(input, serviceSettings, runtime));
}

async function executePortfolioBacktest(input = {}, serviceSettings = {}, runtime = {}) {
  const backtestNow = new Date();
  const pendingBarAllowance = incompleteBacktestBarAllowance(backtestNow);
  const request = input && typeof input === "object" ? input : {};
  const rawSecurities = Array.isArray(request.securities)
    ? request.securities
    : Array.isArray(request.universe)
      ? request.universe
      : [];
  if (rawSecurities.length < 1) {
    throw new Error("回测中心至少需要选择1只A股");
  }
  if (rawSecurities.length > 30) {
    throw new Error("为保证半年数据回放不影响软件使用，股票篮子最多30只");
  }

  const resolveSecurity = runtime.resolveSecurity || resolveBacktestSecurity;
  const resolvedResults = await strategySignalMapConcurrent(
    rawSecurities,
    4,
    async (item) => resolveSecurity(item)
  );
  const resolutionFailure = resolvedResults.find((result) => !result?.ok);
  if (resolutionFailure) {
    throw new Error(`股票篮子解析失败：${resolutionFailure.error || "未知股票"}`);
  }
  const resolvedRows = resolvedResults.map((result) => result.value);
  const securityByCode = new Map();
  for (const security of resolvedRows) {
    if (security?.code && !securityByCode.has(security.code)) {
      securityByCode.set(security.code, security);
    }
  }
  const securities = [...securityByCode.values()];
  if (securities.length < 1) {
    throw new Error("股票篮子去重后为空，请至少添加1只A股");
  }

  const strategyIds = [...new Set(
    (Array.isArray(request.strategyIds)
      ? request.strategyIds
      : request.strategyContext?.strategyIds || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )];
  if (!strategyIds.length) throw new Error("请至少选择1套可回放策略");
  const verifiedStrategyLibrary = new Set(
    strategyDefinitions().map((definition) => definition.id)
  );
  const unknownStrategyIds = strategyIds.filter(
    (strategyId) => !verifiedStrategyLibrary.has(strategyId)
  );
  if (unknownStrategyIds.length) {
    throw new Error(`组合回测包含未知策略：${unknownStrategyIds.join("、")}`);
  }

  const settings = mergeBacktestSettings(serviceSettings, request.settings);
  const lookbackBars = Math.round(clamp(
    Number(request.lookbackBars) || PORTFOLIO_BACKTEST_MAX_BARS,
    PORTFOLIO_BACKTEST_MIN_BARS,
    PORTFOLIO_BACKTEST_MAX_BARS
  ));
  const warmupBars = PORTFOLIO_BACKTEST_WARMUP_BARS;
  const historyRequestBars = lookbackBars + warmupBars;
  const startingCapital = clamp(Number(request.startingCapital) || 500000, 10000, 100000000);
  const maxPositions = Math.round(clamp(
    Number(request.maxPositions) || Number(settings.maxOpenPositions) || 5,
    1,
    Math.min(20, securities.length)
  ));
  const maxPositionPercent = clamp(
    Number(request.maxPositionPercent) || Number(settings.maxPositionPercent) || 28,
    1,
    100
  );
  const lotSize = Math.round(clamp(Number(request.lotSize) || 100, 1, 10000));
  const commissionBps = clamp(
    Number(request.commissionBps ?? settings.commissionBps ?? 7),
    0,
    60
  );
  const slippageBps = clamp(
    Number(request.slippageBps ?? settings.slippageBps ?? 2),
    0,
    60
  );
  const minimumVotes = Math.round(clamp(
    Number(request.minimumVotes ?? request.strategyContext?.minimumVotes) ||
      (strategyIds.length > 1 ? 2 : 1),
    1,
    strategyIds.length
  ));
  const benchmarkCode = ["000001", "000300", "000985"].includes(
    String(request.benchmark || "")
  )
    ? String(request.benchmark)
    : "000985";
  const benchmarkByCode = {
    "000001": { code: "000001", name: "上证指数", secid: "1.000001", thscode: "000001.SH" },
    "000300": { code: "000300", name: "沪深300", secid: "1.000300", thscode: "000300.SH" },
    "000985": { code: "000985", name: "中证全指", secid: "1.000985", thscode: "000985.SH" }
  };
  const benchmarkSecurity = benchmarkByCode[benchmarkCode];
  const loadHistory = runtime.loadHistory || ((security, providerSettings, bars) =>
    loadBacktestHistory(security, providerSettings, bars));

  const rawBenchmarkHistory = await loadHistory(
    benchmarkSecurity,
    settings,
    historyRequestBars + pendingBarAllowance
  ).catch((error) => {
    throw new Error(`基准交易日历获取失败：${error?.message || error}`);
  });
  const completedThrough = completedBacktestDate(backtestNow, rawBenchmarkHistory);
  const benchmarkHistory = completedBacktestRows(rawBenchmarkHistory, completedThrough, historyRequestBars);
  if (!Array.isArray(benchmarkHistory) || benchmarkHistory.length < 120) {
    throw new Error("中证全指历史交易日历不足，无法进行最近半年回测");
  }

  const rawHistoryResults = await strategySignalMapConcurrent(
    securities,
    4,
    async (security) => {
      try {
        const loadedHistory = await loadHistory(security, settings, historyRequestBars + pendingBarAllowance);
        const history = completedBacktestRows(loadedHistory, completedThrough, historyRequestBars);
        if (!Array.isArray(history) || history.length < 80) {
          throw new Error(`历史日线仅 ${Array.isArray(history) ? history.length : 0} 根`);
        }
        return { security, history, error: "" };
      } catch (error) {
        return {
          security,
          history: [],
          error: error?.message || String(error)
        };
      }
    }
  );
  const historyResults = rawHistoryResults.map((result, index) =>
    result?.ok
      ? result.value
      : {
          security: securities[index],
          history: [],
          error: result?.error || "历史行情加载失败"
        }
  );
  const usableResults = historyResults.filter((item) => item.history.length >= 80);
  const failedStocks = historyResults
    .filter((item) => !item.history.length)
    .map((item) => ({
      code: item.security.code,
      name: item.security.name,
      reason: item.error || "历史行情不足"
    }));
  if (usableResults.length < 1) {
    const details = failedStocks.slice(0, 5)
      .map((item) => `${item.name}（${item.code}）：${item.reason}`)
      .join("；");
    throw new Error(`没有可用于最近半年回测的股票${details ? `：${details}` : ""}`);
  }

  const usableSecurities = usableResults.map((item) => item.security);
  const historiesByCode = Object.fromEntries(
    usableResults.map((item) => [item.security.code, item.history])
  );
  const minSamples = Math.max(120, Math.round(Number(request.minSamples) || 120));
  const minOutOfSampleSamples = Math.max(
    36,
    Math.round(Number(request.minOutOfSampleSamples) || 36)
  );
  const allBenchmarkDates = benchmarkHistory
    .map((row) => String(row?.date || "").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const benchmarkDates = allBenchmarkDates.slice(-lookbackBars);
  const actualWarmupBars = Math.max(
    0,
    allBenchmarkDates.length - benchmarkDates.length
  );
  const stockWarmupBarsAvailable = usableResults.map((item) =>
    item.history.filter((row) =>
      String(row?.date || "").slice(0, 10) < benchmarkDates[0]
    ).length
  );
  const minimumWarmupBarsAvailable = Math.min(
    actualWarmupBars,
    ...stockWarmupBarsAvailable
  );
  const replayOptions = {
      strategyId: String(
        request.strategyContext?.strategyId ||
        (strategyIds.length > 1 ? "custom_portfolio_vote" : strategyIds[0])
      ),
      strategyName: String(
        request.strategyContext?.strategyName ||
        (strategyIds.length > 1
          ? "自定义多策略投票"
          : strategyDefinitions().find((item) => item.id === strategyIds[0])?.name || strategyIds[0])
      ),
      minimumVotes,
      signalFrom: benchmarkDates[0],
      signalTo: benchmarkDates.at(-1),
      horizonDays: 5,
      cooldownDays: 5,
      minSamples,
      minOutOfSampleSamples,
      minIndependentSignalDays: 60,
      minWalkForwardFoldSamples: 10,
      walkForwardFolds: 4,
      minWinRate: 45,
      minAverageReturn: clamp(Number(settings.minProjectedNetEdgePercent ?? 0.2), -5, 10),
      minReturnLowerBound: 0,
      maxDrawdown: -22,
      roundTripCostBps: roundTripBps({ ...DEFAULT_COSTS, commissionBps, slippageBps }),
      outOfSampleRatio: 0.3
  };
  const portfolioOptions = {
    costModel: { ...DEFAULT_COSTS, commissionBps, slippageBps },
    startingCapital,
    maxPositions,
    maxPositionPercent,
    lotSize,
    rangeFrom: benchmarkDates[0],
    rangeTo: benchmarkDates.at(-1)
  };
  const { replay, portfolio } = await buildPortfolioBacktestInWorker({
    strategyIds,
    securities: usableSecurities,
    historiesByCode,
    benchmarkHistory,
    replayOptions,
    portfolioOptions
  });
  const { signalEvents, signalTimeline } = buildPortfolioSignalTimeline(
    replay,
    portfolio
  );

  const contributionByCode = new Map(
    (portfolio.contributions || []).map((row) => [row.code, row])
  );
  const contributions = usableSecurities.map((security) => {
    const row = contributionByCode.get(security.code) || {};
    const trades = (portfolio.trades || []).filter((trade) => trade.code === security.code);
    const allocated = trades.reduce((sum, trade) => sum + Number(trade.allocation || 0), 0);
    const pnl = Number(row.pnl || 0);
    return {
      code: security.code,
      name: security.name,
      pnl: Number(pnl.toFixed(2)),
      contributionPercent: Number(((pnl / startingCapital) * 100).toFixed(4)),
      returnPercent: allocated > 0
        ? Number(((pnl / allocated) * 100).toFixed(4))
        : null,
      tradeCount: Number(row.tradeCount || 0),
      winningTrades: Number(row.winningTrades || 0),
      losingTrades: Number(row.losingTrades || 0),
      winRatePercent: row.winRatePercent ?? null,
      signalSamples: Number(
        replay.perSecurity?.find((item) => item.code === security.code)?.sampleCount || 0
      )
    };
  }).sort((left, right) => right.pnl - left.pnl || left.code.localeCompare(right.code));

  const warmupPartial = minimumWarmupBarsAvailable < warmupBars;
  const partial = failedStocks.length > 0 || warmupPartial;
  const strategyEvidenceAccepted = replay.validation?.accepted === true;
  const strategySelectedUniverse = request.universeSource === "strategy_current_matches";
  const statusReasons = [
    strategySelectedUniverse
      ? "股票池由所选策略在策略信号页的本轮真实命中生成，并非手工先选股；但仍是当前候选队列，缺少完整历史时点全市场成分，因此保留幸存者偏差提示。"
      : "当前股票篮子由用户按今天可见成分手工选择，存在成分选择与幸存者偏差，因此结果只标记为组合诊断。",
    usableSecurities.length < 30
      ? `实际股票仅 ${usableSecurities.length} 只，少于跨股票验证所需的30只。`
      : strategySelectedUniverse
        ? "达到30只只改善股票覆盖，当前策略命中池仍不能替代历史时点全市场样本外验证。"
        : "即使达到30只，手工篮子仍未提供历史时点成分，不能替代全市场样本外验证。",
    strategyEvidenceAccepted
      ? strategySelectedUniverse
        ? "策略事件样本门槛已通过，但当前命中池仍不具备完整历史时点成分，结果保持诊断属性。"
        : "策略事件样本门槛已通过，但不改变手工篮子的诊断属性。"
      : replay.validation?.reason || "策略事件样本、样本外或走步稳定性未达到强验证门槛。",
    failedStocks.length ? `${failedStocks.length} 只股票因历史行情不足被排除，结果为部分覆盖。` : "",
    ...(portfolio.validation?.reasons || []),
    warmupPartial
      ? `指标预热仅完整覆盖 ${minimumWarmupBarsAvailable}/${warmupBars} 根，窗口前段信号会因指标不足自然缺失。`
      : ""
  ].filter(Boolean);
  const metrics = {
    ...(portfolio.metrics || {}),
    totalSignals: Number(replay.matchedSignalCount || signalEvents.length),
    replayableSignals: Number(replay.sampleCount || 0),
    untradeableSignals: Number(replay.untradeableCount || 0),
    pendingSignals: Number(replay.pendingCount || 0),
    filledSignals: Number(portfolio.metrics?.tradeCount || 0),
    sharpeRatio: portfolio.metrics?.sharpeRatio ?? portfolio.metrics?.sharpe ?? null,
    winRate: portfolio.metrics?.winRate ?? portfolio.metrics?.winRatePercent ?? null
  };
  const providerPolicy =
    settings.provider === "ths" && String(settings.refreshToken || "").trim()
      ? "同花顺历史行情主线；失败时按设置使用公共行情回退"
      : "公共历史行情；同花顺未启用或未配置令牌";

  return {
    source: "verified strategy shared-account portfolio replay",
    generatedAt: new Date().toISOString(),
    backtestMode: "verified_strategy_portfolio",
    strategyEngine: "verified-signal-v2",
    strategyVersion: String(request.strategyContext?.strategyVersion || "robust-v2"),
    status: "DIAGNOSTIC",
    statusReasons,
    lookbackBars,
    strategyIds,
    minimumVotes,
    strategyContext: {
      strategyEngine: "verified-signal-v2",
      strategyId: replay.id,
      strategyName: replay.name.replace(/ · 多股票统一组合$/, ""),
      strategyIds,
      componentNames: replay.componentNames,
      minimumVotes,
      voteRule: replay.voteRule,
      rulesSource: "strategy-signal-engine robust-v2",
      frozenAt: new Date().toISOString()
    },
    universe: {
      selectionMode: strategySelectedUniverse
        ? "strategy_current_matches"
        : "manual_current_basket",
      selectionLabel: strategySelectedUniverse
        ? "所选策略本轮命中股票"
        : "用户自定义股票篮子",
      pointInTime: false,
      survivorBias: true,
      requestedCount: securities.length,
      usedCount: usableSecurities.length,
      failedCount: failedStocks.length,
      requestedCodes: securities.map((item) => item.code),
      usableCodes: usableSecurities.map((item) => item.code),
      securities: usableSecurities,
      excluded: failedStocks,
      coveragePercent: Number((usableSecurities.length / securities.length * 100).toFixed(2))
    },
    settings: {
      startingCapital,
      maxPositions,
      maxPositionPercent,
      commissionBps,
      slippageBps,
      roundTripCostBps: roundTripBps({ ...DEFAULT_COSTS, commissionBps, slippageBps }),
      lotSize,
      costModel: { ...DEFAULT_COSTS, commissionBps, slippageBps },
      capitalModel: "shared_cash_account"
    },
    methodology: {
      version: "shared-account-v1",
      ...portfolio.methodology,
      summary: "信号在T日收盘冻结，T+1市场交易日开盘按共享现金与空闲席位买入；持仓逐日盯市，退出日收盘释放资金。所有股票共用一份现金，结果不是单股收益平均。"
    },
    metrics,
    benchmark: {
      code: benchmarkSecurity.code,
      name: benchmarkSecurity.name,
      returnType: "price_index",
      totalReturnPercent: metrics.benchmarkReturnPercent,
      excessReturnPercent: metrics.excessReturnPercent
    },
    equityCurve: portfolio.equityCurve,
    holdings: portfolio.holdings || [],
    contributions,
    signalEvents,
    signalTimeline,
    trades: (portfolio.trades || []).map((trade) => ({
      ...trade,
      id: trade.sampleId,
      pnlPercent: trade.netReturnPercent,
      exitReason: "固定5日规则退出"
    })),
    rejections: portfolio.rejections,
    strategyRejections: replay.rejectedSignals || replay.rejections || [],
    signalAudit: {
      matched: signalEvents.length,
      generated: signalEvents.length,
      replayable: Number(replay.sampleCount || 0),
      untradeable: Number(replay.untradeableCount || 0),
      pending: Number(replay.pendingCount || 0),
      filled: Number(portfolio.metrics?.enteredCount ?? portfolio.metrics?.tradeCount ?? 0),
      openPositionCount: Number(portfolio.metrics?.openPositionCount || 0),
      rejected: signalEvents.filter((item) => item.status === "rejected").length,
      portfolioRejected: Number(portfolio.metrics?.rejectedSignalCount || 0),
      rejectedCapacity: Number(portfolio.metrics?.capacityRejected || 0),
      rejectedAlreadyHeld: Number(portfolio.metrics?.overlapRejected || 0),
      rejectedMissingNextMarketDay: Number(portfolio.metrics?.missingNextMarketDayRejected || 0),
      rejectedInsufficientLot: Number(portfolio.metrics?.insufficientLotRejected || 0)
    },
    validation: {
      ...replay.validation,
      accepted: false,
      status: "DIAGNOSTIC",
      strategyEvidenceAccepted,
      reason: statusReasons.join("；"),
      reasons: statusReasons,
      portfolio: portfolio.validation
    },
    dataQuality: {
      requestedStocks: securities.length,
      loadedStocks: usableSecurities.length,
      historicalDataQuality: replay.perSecurity.reduce((totals, item) => {
        for (const [key, value] of Object.entries(item.historicalDataQuality || {})) totals[key] = (totals[key] || 0) + value;
        return totals;
      }, {}),
      failedStocks,
      benchmarkBars: benchmarkDates.length,
      benchmarkHistoryBarsLoaded: benchmarkHistory.length,
      historyBarsRequested: historyRequestBars,
      lookbackBars,
      warmupBarsRequested: warmupBars,
      warmupBarsAvailable: minimumWarmupBarsAvailable,
      benchmarkWarmupBarsAvailable: actualWarmupBars,
      minimumStockWarmupBarsAvailable: Math.min(...stockWarmupBarsAvailable),
      signalWindow: {
        from: benchmarkDates[0],
        to: benchmarkDates.at(-1),
        bars: portfolio.equityCurve?.length || 0,
        maximumBars: PORTFOLIO_BACKTEST_MAX_BARS
      },
      minimumStockBars: Math.min(...usableResults.map((item) => item.history.length)),
      maximumStockBars: Math.max(...usableResults.map((item) => item.history.length)),
      providerPolicy,
      partial
    },
    perSecurityReplay: replay.perSecurity.map((item) => ({
      code: item.code,
      name: item.name,
      historicalDataQuality: item.historicalDataQuality,
      historyBars: item.historyBars,
      sampleCount: item.sampleCount,
      matchedSignalCount: item.matchedSignalCount,
      rejectedSampleCount: item.rejectedSampleCount,
      pendingCount: item.pendingCount,
      rejections: item.rejections,
      pendingSignals: item.pendingSignals,
      validation: item.validation
    }))
  };
}

const SINGLE_STOCK_BACKTEST_MAX_BARS = 4000;
const SINGLE_STOCK_BACKTEST_WARMUP_BARS = 120;

function normalizeSingleBacktestDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === text
    ? text
    : "";
}

function singleStockBacktestLookbackBars(rawLookbackBars, startDate = "", now = new Date()) {
  const normalizedStartDate = normalizeSingleBacktestDate(startDate);
  if (normalizedStartDate) {
    const nowDate = now instanceof Date ? now : new Date(now);
    const safeNow = Number.isFinite(nowDate.getTime()) ? nowDate : new Date();
    const startTime = Date.parse(`${normalizedStartDate}T00:00:00Z`);
    const elapsedCalendarDays = Math.max(
      0,
      Math.ceil((safeNow.getTime() - startTime) / 86400000)
    );
    const estimatedTradingBars = Math.ceil(elapsedCalendarDays * 5 / 7);
    return Math.round(clamp(
      estimatedTradingBars + SINGLE_STOCK_BACKTEST_WARMUP_BARS,
      PORTFOLIO_BACKTEST_MAX_BARS,
      SINGLE_STOCK_BACKTEST_MAX_BARS
    ));
  }
  return Math.round(clamp(
    Number(rawLookbackBars) || PORTFOLIO_BACKTEST_MAX_BARS,
    PORTFOLIO_BACKTEST_MAX_BARS,
    SINGLE_STOCK_BACKTEST_MAX_BARS
  ));
}

function buildSingleStockTradeLedger(samples = [], options = {}) {
  const startingCapital = Math.max(1000, Number(options.startingCapital) || 200000);
  const positionPercent = clamp(Number(options.positionPercent ?? 100), 1, 100);
  const roundTripCostPercent = Math.max(0, Number(options.roundTripCostPercent) || 0);
  const ordered = (Array.isArray(samples) ? samples : [])
    .filter((sample) =>
      /^\d{4}-\d{2}-\d{2}$/.test(String(sample?.signalDate || "")) &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(sample?.entryDate || "")) &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(sample?.exitDate || "")) &&
      Number.isFinite(Number(sample?.grossReturn))
    )
    .sort((left, right) => {
      const entryOrder = String(left.entryDate).localeCompare(String(right.entryDate));
      return entryOrder || String(left.signalDate).localeCompare(String(right.signalDate));
    });
  let capital = startingCapital;
  let peakCapital = startingCapital;
  let maxDrawdownPercent = 0;
  let lastExitDate = "";
  let skippedOverlaps = 0;
  const trades = [];
  for (const sample of ordered) {
    const entryDate = String(sample.entryDate).slice(0, 10);
    const exitDate = String(sample.exitDate).slice(0, 10);
    if (lastExitDate && entryDate <= lastExitDate) {
      skippedOverlaps += 1;
      continue;
    }
    const grossReturnPercent = Number(sample.grossReturn);
    const netReturnPercent = Number.isFinite(Number(sample.netReturn))
      ? Number(sample.netReturn)
      : grossReturnPercent - roundTripCostPercent;
    const allocatedCapital = capital * positionPercent / 100;
    const profitAmount = allocatedCapital * netReturnPercent / 100;
    capital += profitAmount;
    peakCapital = Math.max(peakCapital, capital);
    const drawdownPercent = peakCapital > 0
      ? ((capital / peakCapital) - 1) * 100
      : 0;
    maxDrawdownPercent = Math.min(maxDrawdownPercent, drawdownPercent);
    trades.push({
      sequence: trades.length + 1,
      strategyId: String(sample.strategyId || ""),
      strategyIds: [...new Set(
        (Array.isArray(sample.strategyIds) ? sample.strategyIds : [sample.strategyId])
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      )],
      entryPriceSource: sample.entryPriceSource === "custom_limit_price"
        ? "custom_limit_price"
        : "next_market_open",
      signalDate: String(sample.signalDate).slice(0, 10),
      entryDate,
      exitDate,
      entryPrice: Number.isFinite(Number(sample.entryPrice)) ? Number(sample.entryPrice) : null,
      exitPrice: Number.isFinite(Number(sample.exitPrice)) ? Number(sample.exitPrice) : null,
      grossReturnPercent: Number(grossReturnPercent.toFixed(4)),
      netReturnPercent: Number(netReturnPercent.toFixed(4)),
      benchmarkReturnPercent: Number.isFinite(Number(sample.benchmarkReturn))
        ? Number(Number(sample.benchmarkReturn).toFixed(4))
        : null,
      excessReturnPercent: Number.isFinite(Number(sample.excessReturn))
        ? Number(Number(sample.excessReturn).toFixed(4))
        : null,
      maxAdverseExcursionPercent: Number.isFinite(Number(sample.maxAdverseExcursion))
        ? Number(Number(sample.maxAdverseExcursion).toFixed(4))
        : null,
      positionPercent: Number(positionPercent.toFixed(2)),
      profitAmount: Number(profitAmount.toFixed(2)),
      endingCapital: Number(capital.toFixed(2)),
      cumulativeReturnPercent: Number((((capital / startingCapital) - 1) * 100).toFixed(4)),
      drawdownPercent: Number(drawdownPercent.toFixed(4))
    });
    lastExitDate = exitDate;
  }
  const profitableTrades = trades.filter((trade) => trade.netReturnPercent > 0).length;
  const losingTrades = trades.filter((trade) => trade.netReturnPercent < 0).length;
  const flatTrades = trades.length - profitableTrades - losingTrades;
  return {
    trades,
    summary: {
      startingCapital: Number(startingCapital.toFixed(2)),
      endingCapital: Number(capital.toFixed(2)),
      totalProfitAmount: Number((capital - startingCapital).toFixed(2)),
      totalNetReturnPercent: Number((((capital / startingCapital) - 1) * 100).toFixed(4)),
      positionPercent: Number(positionPercent.toFixed(2)),
      roundTripCostPercent: Number(roundTripCostPercent.toFixed(4)),
      tradeCount: trades.length,
      profitableTrades,
      losingTrades,
      flatTrades,
      winRatePercent: trades.length
        ? Number((profitableTrades / trades.length * 100).toFixed(3))
        : 0,
      maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(4)),
      skippedOverlaps
    }
  };
}

function runBacktest(input, serviceSettings = {}, options = {}, runtime = {}) {
  return serviceRuntime.run("single", semanticKey([input, serviceSettings, options]), runtime, () => executeBacktest(input, serviceSettings, options));
}

async function executeBacktest(input, serviceSettings = {}, options = {}) {
  const backtestNow = new Date();
  const pendingBarAllowance = incompleteBacktestBarAllowance(backtestNow);
  const security = await resolveBacktestSecurity(input);

  const rawStartDate = String(options?.startDate || "").trim();
  const requestedStartDate = normalizeSingleBacktestDate(rawStartDate);
  if (rawStartDate && !requestedStartDate) {
    throw new Error("回测起始日期格式无效，请重新选择日期");
  }
  const today = displayDate(todayInShanghai());
  if (requestedStartDate && requestedStartDate > today) {
    throw new Error("回测起始日期不能晚于今天");
  }
  const rawCustomEntryPrice = options?.customEntryPrice;
  const hasCustomEntryPrice = rawCustomEntryPrice !== "" &&
    rawCustomEntryPrice !== null &&
    rawCustomEntryPrice !== undefined;
  const customEntryPrice = hasCustomEntryPrice ? Number(rawCustomEntryPrice) : null;
  if (hasCustomEntryPrice && (!Number.isFinite(customEntryPrice) || customEntryPrice <= 0)) {
    throw new Error("自定义买入价必须是大于0的有效价格");
  }

  const serviceBacktestSettings = mergeBacktestSettings(
    serviceSettings,
    options?.settings
  );

  const verifiedStrategyIds = [...new Set(
    (Array.isArray(options?.signalStrategyIds)
      ? options.signalStrategyIds
      : Array.isArray(options?.strategyContext?.strategyIds)
        ? options.strategyContext.strategyIds
        : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )];
  const verifiedStrategyLibrary = new Set(
    strategyDefinitions().map((item) => item.id)
  );
  const invalidVerifiedStrategyIds = verifiedStrategyIds.filter(
    (id) => !verifiedStrategyLibrary.has(id)
  );
  if (invalidVerifiedStrategyIds.length) {
    throw new Error(
      `回测请求包含未知策略：${invalidVerifiedStrategyIds.join("、")}`
    );
  }
  const usesVerifiedSignalStrategy = verifiedStrategyIds.length > 0;
  const amountDependentStrategies = require("../config/strategy-signal-combinations.json").filter(item => verifiedStrategyIds.includes(item.id));
  const requiresAmount = amountDependentStrategies.length > 0;
  const requiredAmountWindow = requiresAmount ? Math.max(...amountDependentStrategies.map(item => item.parameters.marketCalendarLookback)) : 0;

  const safeLookbackBars = singleStockBacktestLookbackBars(
    options.lookbackBars,
    requestedStartDate
  );
  const requestedBenchmarks = Number(options.benchmarks) || 2;
  const benchmarkSecurity =
    options.benchmark === "szzs"
      ? { code: "000001", secid: "1.000001", thscode: "000001.SH" }
      : options.benchmark === "hs300"
        ? { code: "000300", secid: "1.000300", thscode: "000300.SH" }
        : { code: "000985", secid: "1.000985", thscode: "000985.SH" };
  const selectedIds = Array.isArray(serviceBacktestSettings.selectedStrategies)
    ? serviceBacktestSettings.selectedStrategies
    : [];
  const strategyIds = [...new Set([...selectedIds, "riskVeto"])]
    .filter(Boolean);
  const minProjectedNetEdgePercent = clamp(
    Number(serviceBacktestSettings.minProjectedNetEdgePercent ?? 0.2),
    -5,
    10
  );
  const minExpectancyPoints = clamp(
    Number(serviceBacktestSettings.minExpectancyPoints ?? 0.2),
    -5,
    8
  );
  const minHistorySamples = Number.isFinite(Number(options.minSamples))
    ? Math.max(8, Math.round(Number(options.minSamples)))
    : Math.max(8, Math.round(Number(serviceBacktestSettings.minSamples || 8)));
  const commissionBps = clamp(Number(serviceBacktestSettings.commissionBps ?? 7), 0, 60);
  const slippageBps = clamp(Number(serviceBacktestSettings.slippageBps ?? 2), 0, 60);
  const expectedCostPercent = (roundTripBps({ ...DEFAULT_COSTS, commissionBps, slippageBps })) / 100;

  const [historyResult, benchmarkResult] = await Promise.allSettled([
    loadBacktestHistory(
      security,
      serviceBacktestSettings,
      safeLookbackBars + pendingBarAllowance,
      {},
      { requireAmount: requiresAmount, windowBars: requiredAmountWindow, signalFrom: requestedStartDate, minimumRows: safeLookbackBars, completedAt: backtestNow }
    ),
    loadBacktestHistory(
      benchmarkSecurity,
      serviceBacktestSettings,
      safeLookbackBars + pendingBarAllowance
    )
  ]);
  if (historyResult.status === "rejected") {
    const detail = historyResult.reason instanceof Error
      ? historyResult.reason.message
      : String(historyResult.reason || "未知数据源错误");
    throw new Error(`个股历史数据加载失败：${detail}`);
  }
  if (benchmarkResult.status === "rejected") {
    const detail = benchmarkResult.reason instanceof Error
      ? benchmarkResult.reason.message
      : String(benchmarkResult.reason || "未知数据源错误");
    throw new Error(`基准历史数据加载失败：${detail}`);
  }
  const completedThrough = completedBacktestDate(backtestNow, benchmarkResult.value);
  const history = completedBacktestRows(historyResult.value, completedThrough, safeLookbackBars);
  const benchmarkHistory = completedBacktestRows(benchmarkResult.value, completedThrough, safeLookbackBars);
  if (!history.length || history.length < 80) {
    throw new Error("历史数据不足，无法进行回测。请扩大历史时间窗口后重试");
  }
  const signalFrom = requestedStartDate || String(
    history[Math.max(0, history.length - PORTFOLIO_BACKTEST_MAX_BARS)]?.date || ""
  ).slice(0, 10);
  const signalTo = String(history.at(-1)?.date || "").slice(0, 10);
  let requiredCalendarCoverage = null;
  if (requiresAmount) {
    if (history.length < safeLookbackBars) throw new Error(`回测数据不足：个股完整收盘窗口要求${safeLookbackBars}根，实际仅${history.length}根，不能把窗口不足解释为0信号`);
    if (benchmarkHistory.length < safeLookbackBars) throw new Error(`回测数据不足：基准请求窗口${safeLookbackBars}根，实际仅${benchmarkHistory.length}根，不能把日历不足解释为0信号`);
    const firstSignalIndex = history.findIndex(row => row.date >= signalFrom);
    if (firstSignalIndex < 0) throw new Error("回测数据不足：请求信号区间没有个股日线");
    const requiredStockRows = history.slice(Math.max(0, firstSignalIndex - requiredAmountWindow + 1));
    const from = requiredStockRows[0].date, to = requiredStockRows.at(-1).date;
    const requiredMarketRows = benchmarkHistory.filter(row => row.date >= from && row.date <= to);
    const marketDates = new Set(requiredMarketRows.map(row => row.date));
    const stockDates = new Set(requiredStockRows.map(row => row.date));
    const missingBenchmark = requiredStockRows.filter(row => !marketDates.has(row.date));
    const missingStock = requiredMarketRows.filter(row => !stockDates.has(row.date));
    if (missingBenchmark.length || missingStock.length) throw new Error(`回测数据不足：信号与预热日历不齐，基准缺${missingBenchmark.length}日、个股缺${missingStock.length}日；首个缺口${missingBenchmark[0]?.date || missingStock[0]?.date}，不能把缺页解释为0信号`);
    requiredCalendarCoverage = { from, to, stockDays:requiredStockRows.length, benchmarkDays:requiredMarketRows.length, matched:true };
  }
  const backtestRange = {
    requestedFrom: requestedStartDate,
    signalFrom,
    signalTo,
    historyFrom: String(history[0]?.date || "").slice(0, 10),
    historyTo: signalTo,
    historyBars: history.length
  };

  const toPercentReturn = (rows, bars) => {
    if (!Array.isArray(rows) || rows.length <= bars) return 0;
    const rightIndex = rows.length - 1;
    const leftIndex = Math.max(0, rows.length - bars - 1);
    const right = Number(rows[rightIndex]?.close);
    const left = Number(rows[leftIndex]?.open);
    return right && left ? ((right / left - 1) * 100) : 0;
  };
  const benchmarkReturns = {
    r1: toPercentReturn(benchmarkHistory, 1),
    r3: toPercentReturn(benchmarkHistory, 3),
    r5: toPercentReturn(benchmarkHistory, 5),
    spanBars: Math.min(requestedBenchmarks, benchmarkHistory.length)
  };

  if (usesVerifiedSignalStrategy) {
    const strategyName = String(
      options?.strategyContext?.strategyName ||
      options?.signalStrategyName ||
      "已验证策略"
    ).trim();
    const strategyId = String(
      options?.strategyContext?.strategyId ||
      (verifiedStrategyIds.length > 1 ? "optimized_strategy_vote" : verifiedStrategyIds[0])
    ).trim();
    const minimumVotes = Math.max(
      1,
      Math.min(
        verifiedStrategyIds.length,
        Math.round(Number(options?.strategyContext?.minimumVotes) ||
          (verifiedStrategyIds.length > 1 ? 2 : 1))
      )
    );
    const replayOptions = {
      strategyId,
      strategyName,
      minimumVotes,
      horizonDays: 5,
      cooldownDays: 5,
      minSamples: minHistorySamples,
      minOutOfSampleSamples: Math.max(6, Math.ceil(minHistorySamples * 0.3)),
      minIndependentSignalDays: minHistorySamples,
      minWalkForwardFoldSamples: Math.max(2, Math.min(10, Math.floor(minHistorySamples / 3))),
      walkForwardFolds: 4,
      minWinRate: 45,
      minAverageReturn: minProjectedNetEdgePercent,
      minReturnLowerBound: 0,
      maxDrawdown: -22,
      roundTripCostBps: roundTripBps({ ...DEFAULT_COSTS, commissionBps, slippageBps }),
      outOfSampleRatio: 0.3,
      signalFrom,
      signalTo,
      customEntryPrice
    };
    const { replay, replaysById } = await buildSingleStockReplaysInWorker(
      verifiedStrategyIds,
      security,
      history,
      benchmarkHistory,
      replayOptions
    );
    const validation = replay.validation || {};
    const outOfSample = validation.outOfSample || {};
    const rawWalkForwardValidation = validation.walkForward || {
      available: false,
      accepted: false,
      reason: "走步验证证据未返回",
      folds: []
    };
    const walkForwardValidation = {
      ...rawWalkForwardValidation,
      foldPassRate: Number(rawWalkForwardValidation.passRate || 0),
      oosSampleCount: Number(outOfSample.sampleCount || 0),
      oosWinRate5: outOfSample.winRate,
      oosProjectedNetEdge: outOfSample.averageReturn,
      oosWorstMdd5: outOfSample.maxDrawdown,
      folds: (rawWalkForwardValidation.folds || []).map((fold) => ({
        ...fold,
        testStart: fold.testRange?.from || "",
        testEnd: fold.testRange?.to || "",
        oosProjectedNetEdge: fold.testAverageReturn
      }))
    };
    const tradeSamples = Number(validation.sampleCount || 0);
    const averageGrossReturn = Number.isFinite(Number(validation.averageGrossReturn))
      ? Number(validation.averageGrossReturn)
      : 0;
    const averageNetReturn = Number.isFinite(Number(validation.averageReturn))
      ? Number(validation.averageReturn)
      : 0;
    const medianReturn = Number.isFinite(Number(validation.medianReturn))
      ? Number(validation.medianReturn)
      : 0;
    const winRate = Number.isFinite(Number(validation.winRate))
      ? Number(validation.winRate)
      : 0;
    const maxDrawdown = Number.isFinite(Number(validation.maxDrawdown))
      ? Number(validation.maxDrawdown)
      : 0;
    const accepted = validation.accepted === true;
    const metrics = {
      totalSignals: tradeSamples + Number(validation.untradeableCount || 0),
      replayableSignals: tradeSamples,
      untradeableSignals: Number(validation.untradeableCount || 0),
      winRate5: Number(winRate.toFixed(3)),
      averageR5: Number(averageGrossReturn.toFixed(3)),
      medianR5: Number(medianReturn.toFixed(3)),
      expectancy5: Number(averageNetReturn.toFixed(3)),
      projectedNetEdge: Number(averageNetReturn.toFixed(3)),
      worstMdd5: Number(maxDrawdown.toFixed(3)),
      avgExcess5: Number(Number(validation.averageExcessReturn || 0).toFixed(3)),
      averageReturnLowerBound95: validation.averageReturnLowerBound95,
      walkForwardAvailable: walkForwardValidation.available === true,
      walkForwardAccepted: walkForwardValidation.accepted === true,
      walkForwardPassRate: Number(walkForwardValidation.passRate || 0),
      oosSampleCount: Number(outOfSample.sampleCount || 0),
      oosWinRate5: outOfSample.winRate,
      oosExpectancy5: outOfSample.averageReturn,
      oosProjectedNetEdge: outOfSample.averageReturn,
      oosWorstMdd5: outOfSample.maxDrawdown,
      overfitRisk: walkForwardValidation.overfitRisk || "unknown",
      degradationPercent: Number(walkForwardValidation.degradationPercent || 0),
      accepted,
      passReason: accepted
        ? "所选策略在该股票的历史回放、样本外和走步验证均通过"
        : validation.reason || "所选策略在该股票上的样本或稳定性未达标"
    };
    const historicalSamplePath = buildSequentialSamplePath(
      (replay.samples || []).map((sample) => ({
        entryDate: sample.entryDate,
        exitDate: sample.exitDate,
        node: 0,
        r5: sample.grossReturn
      })),
      {
        startingCapital: 200000,
        positionPercent: clamp(
          Number(serviceBacktestSettings.maxPositionPercent ?? 100),
          1,
          100
        ),
        roundTripCostPercent: expectedCostPercent
      }
    );
    const ledgerOptions = {
      startingCapital: 200000,
      positionPercent: clamp(
        Number(serviceBacktestSettings.maxPositionPercent ?? 100),
        1,
        100
      ),
      roundTripCostPercent: expectedCostPercent
    };
    const tradeLedger = buildSingleStockTradeLedger(replay.samples || [], ledgerOptions);
    const strategyDefinitionById = new Map(
      strategyDefinitions().map((definition) => [definition.id, definition])
    );
    const strategyBreakdown = verifiedStrategyIds.map((id) => {
      const definition = strategyDefinitionById.get(id);
      const singleReplay = verifiedStrategyIds.length === 1 ? replay : replaysById[id];
      const singleLedger = buildSingleStockTradeLedger(
        singleReplay.samples || [],
        ledgerOptions
      );
      const singleValidation = singleReplay.validation || {};
      return {
        strategyId: id,
        strategyName: String(definition?.name || id),
        matchedSignals: Number(singleReplay.matchedSignalCount || 0),
        replayableSignals: Number(singleReplay.samples?.length || 0),
        pendingSignals: Number(singleReplay.pendingCount || 0),
        untradeableSignals: Number(singleReplay.untradeableCount || 0),
        averageNetReturnPercent: Number(Number(singleValidation.averageReturn || 0).toFixed(4)),
        ...singleLedger.summary
      };
    });
    metrics.tradeCount = tradeLedger.summary.tradeCount;
    metrics.profitableTrades = tradeLedger.summary.profitableTrades;
    metrics.losingTrades = tradeLedger.summary.losingTrades;
    metrics.totalNetReturnPercent = tradeLedger.summary.totalNetReturnPercent;
    metrics.totalProfitAmount = tradeLedger.summary.totalProfitAmount;
    metrics.winRatePercent = tradeLedger.summary.winRatePercent;
    metrics.accountMaxDrawdownPercent = tradeLedger.summary.maxDrawdownPercent;
    metrics.sequentialSettledSamples = historicalSamplePath.points.length;
    metrics.overlappingSamplesSkipped = historicalSamplePath.skippedOverlaps;
    const backtestExecutionReadiness = buildBacktestExecutionReadinessFromMetrics(
      metrics,
      {
        minHistorySamples,
        minProjectedNetEdgePercent,
        minExpectancyPoints
      }
    );
    return {
      source: "verified strategy signal replay",
      generatedAt: new Date().toISOString(),
      lookbackBars: safeLookbackBars,
      range: backtestRange,
      universe: { pointInTime: false, survivorBias: true },
      costModel: { ...DEFAULT_COSTS, commissionBps, slippageBps },
      dataCoverage: {
        historicalDataQuality: replay.historicalDataQuality,
        amountRequired: requiresAmount,
        requiredPositiveAmountWindow: requiredAmountWindow,
        requestedCalendarCoverage: requiredCalendarCoverage,
        requestedHistoryBars: safeLookbackBars,
        stock: { source: history.dataSource || "provider-history", bars: history.length, from: history[0]?.date || "", to: history.at(-1)?.date || "", amountPresentBars: history.filter(row => row.amount !== null && row.amount !== undefined && row.amount !== "" && Number.isFinite(Number(row.amount)) && Number(row.amount) >= 0).length, provenance: history.provenance || null },
        benchmark: { source: benchmarkHistory.dataSource || "provider-history", bars: benchmarkHistory.length, from: benchmarkHistory[0]?.date || "", to: benchmarkHistory.at(-1)?.date || "", amountRequired: false },
        note: "根数与所需量额字段覆盖；不等于官方交易日历、证券状态或历史限价完整验证。"
      },
      entryPriceMode: customEntryPrice
        ? "custom_limit_price"
        : "next_market_open",
      customEntryPrice,
      backtestMode: "verified_signal_strategy",
      strategyEngine: "verified-signal-v2",
      strategyMode: verifiedStrategyIds.length > 1
        ? "multi_strategy_vote"
        : "single_verified_strategy",
      strategyVersion: String(options?.strategyContext?.strategyVersion || "robust-v2"),
      minimumVotes,
      security: {
        code: security.code,
        name: security.name,
        secid: security.secid,
        thscode: security.thscode
      },
      strategyIds: verifiedStrategyIds,
      strategyContext: {
        strategyEngine: "verified-signal-v2",
        strategyId: replay.id,
        strategyName: replay.name,
        strategyIds: verifiedStrategyIds,
        componentNames: replay.componentNames,
        minimumVotes,
        voteRule: replay.voteRule,
        rulesSource: "strategy-signal-engine robust-v2"
      },
      strategyProfile: safeBacktestStrategyProfile(
        serviceBacktestSettings,
        verifiedStrategyIds
      ),
      metrics,
      nodeStats: [],
      rawStats: replay,
      benchmarkReturns,
      trades: tradeLedger.trades,
      profitSummary: tradeLedger.summary,
      strategyBreakdown,
      historicalSamplePath,
      walkForwardValidation,
      tradeExecutionReadiness: backtestExecutionReadiness,
      executionReadiness: backtestExecutionReadiness
    };
  }

  const historicalStats = await buildHistoricalStrategyStatsInWorker(
    history,
    security.code,
    security.name,
    strategyIds,
    benchmarkHistory,
    { includeSamples: true }
  );
  const combination = Array.isArray(historicalStats?.stats)
    ? historicalStats.stats.find((item) => item?.id === "currentCombination")
    : null;
  const walkForwardValidation = buildWalkForwardValidationFromSamples(
    historicalStats?.combinationSamples,
    {
      expectedCostPercent,
      minProjectedNetEdgePercent,
      minExpectancyPoints,
      minSamples: minHistorySamples
    }
  );
  const {
    combinationSamples: _combinationSamples,
    ...publicHistoricalStats
  } = historicalStats;

  const tradeSamples = Number(combination?.sampleCount || 0);
  const avgR5 = Number.isFinite(Number(combination?.average5))
    ? Number(combination.average5)
    : 0;
  const medianR5 = Number.isFinite(Number(combination?.median5))
    ? Number(combination.median5)
    : 0;
  const winRate5 = Number.isFinite(Number(combination?.winRate5))
    ? Number(combination.winRate5)
    : 0;
  const worstMdd5 = Number.isFinite(Number(combination?.worstMdd5))
    ? Number(combination.worstMdd5)
    : -Math.abs(avgR5);
  const n5 = Number(combination?.n5 || 0);
  const expectancy5 = n5 ? avgR5 : 0;
  const projectedNetEdge = expectancy5 - expectedCostPercent;
  const edgePass = Number.isFinite(projectedNetEdge) && projectedNetEdge >= minProjectedNetEdgePercent;
  const expectancyPass = Number.isFinite(expectancy5) && expectancy5 >= minExpectancyPoints;
  const samplePass = tradeSamples >= minHistorySamples;
  const maxDdOk = !Number.isFinite(worstMdd5) || worstMdd5 > -22;
  const accepted =
    samplePass &&
    edgePass &&
    expectancyPass &&
    maxDdOk &&
    walkForwardValidation.accepted;

  const nodeSummary = (historicalStats.nodeStats || []).map((node) => ({
    node: node.node,
    sampleCount: Number(node.sampleCount || 0),
    winRate5: Number(node.winRate5 || 0),
    average5: Number(node.average5 || 0),
    averageExcess5: Number(node.averageExcess5 || 0)
  }));
  const stats = {
    source: "historical backtest",
    generatedAt: new Date().toISOString(),
    lookbackBars: safeLookbackBars,
    strategyIds,
    security: {
      code: security.code,
      name: security.name,
      secid: security.secid,
      thscode: security.thscode
    },
    metrics: {
      totalSignals: Number(historicalStats.totalEvents || 0),
      replayableSignals: tradeSamples,
      untradeableSignals: Number(historicalStats.untradeableCount || 0),
      winRate5: Number(winRate5.toFixed(3)),
      averageR5: Number(avgR5.toFixed(3)),
      medianR5: Number(medianR5.toFixed(3)),
      expectancy5: Number(expectancy5.toFixed(3)),
      projectedNetEdge: Number(projectedNetEdge.toFixed(3)),
      worstMdd5: Number(worstMdd5.toFixed(3)),
      avgExcess5: Number(Number(combination?.averageExcess5 || 0).toFixed(3)),
      walkForwardAvailable: walkForwardValidation.available,
      walkForwardAccepted: walkForwardValidation.accepted,
      walkForwardPassRate: walkForwardValidation.foldPassRate,
      oosSampleCount: walkForwardValidation.oosSampleCount,
      oosWinRate5: walkForwardValidation.oosWinRate5,
      oosExpectancy5: walkForwardValidation.oosExpectancy5,
      oosProjectedNetEdge: walkForwardValidation.oosProjectedNetEdge,
      oosWorstMdd5: walkForwardValidation.oosWorstMdd5,
      overfitRisk: walkForwardValidation.overfitRisk,
      degradationPercent: walkForwardValidation.degradationPercent,
      accepted,
      passReason: accepted
        ? "满足回测门槛"
        : [
            tradeSamples >= minHistorySamples ? "" : `样本不足：${tradeSamples}/${minHistorySamples}`,
            edgePass ? "" : `期望净值不足：${projectedNetEdge.toFixed(2)}%`,
            expectancyPass ? "" : `期望值不足：${expectancy5.toFixed(2)}`,
            maxDdOk ? "" : `最差回撤过深：${worstMdd5.toFixed(2)}%`,
            walkForwardValidation.accepted ? "" : walkForwardValidation.reason
          ].filter(Boolean).join("；") || "不满足回测条件"
    },
    nodeStats: nodeSummary,
    rawStats: publicHistoricalStats
  };

  const historicalSamplePath = buildSequentialSamplePath(
    historicalStats?.combinationSamples,
    {
      startingCapital: 200000,
      positionPercent: clamp(Number(serviceBacktestSettings.maxPositionPercent ?? 100), 1, 100),
      roundTripCostPercent: expectedCostPercent
    }
  );
  stats.metrics.sequentialSettledSamples = historicalSamplePath.points.length;
  stats.metrics.overlappingSamplesSkipped = historicalSamplePath.skippedOverlaps;

  const backtestExecutionReadiness = buildBacktestExecutionReadinessFromMetrics(
    stats.metrics,
    {
      minHistorySamples,
      minProjectedNetEdgePercent,
      minExpectancyPoints
    }
  );

  return {
    ...stats,
    benchmarkReturns,
    historicalSamplePath,
    walkForwardValidation,
    tradeExecutionReadiness: backtestExecutionReadiness,
    executionReadiness: backtestExecutionReadiness
  };
}

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
