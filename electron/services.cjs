const THS_BASE = "https://quantapi.51ifind.com/api/v1";
const EAST_QUOTE = "https://push2.eastmoney.com/api/qt";
const EAST_DELAY_QUOTE = "https://push2delay.eastmoney.com/api/qt";
const EAST_HISTORY = "https://push2his.eastmoney.com/api/qt";
const SEARCH_API = "https://searchapi.eastmoney.com/api/suggest/get";
const { execFile } = require("node:child_process");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const {
  decorateLimitPoolItem,
  scoreFirstBoardQuality,
  computePatternStrategies,
  buildHistoricalStrategyStats,
  buildSectorLadder
} = require("./strategy-intelligence.cjs");
const {
  getNewsFeed,
  resetNewsCache,
  classifyEvent
} = require("./news-service.cjs");
const {
  tencentQuote,
  collectAuxiliarySources,
  buildQuoteConsensus
} = require("./data-federation.cjs");
const {
  buildSelectedStrategyReplay,
  STRATEGY_DEFINITIONS
} = require("./strategy-signal-engine.cjs");

let thsTokenCache = { refreshToken: "", accessToken: "", expiresAt: 0 };
const marketEmotionCache = { value: null, expiresAt: 0, promise: null };
const marketSnapshotCache = { value: null, expiresAt: 0, promise: null };
const ladderPoolsCaches = new Map();
const historyCache = new Map();
const chartCache = new Map();
const federationCache = new Map();
const topicPoolCache = new Map();
const conceptChainCache = new Map();
const eastmoneyOriginQueues = new Map();
const sectorLookupCache = new Map();
const sectorStrengthCache = new Map();
const sectorProviderHealth = new Map();
const sinaSectorCatalogCache = { value: null, expiresAt: 0, promise: null };
const sinaOriginQueue = { lastRequestAt: 0, queue: Promise.resolve() };
const securitySearchCache = new Map();
const strategySignalCache = new Map();
const strategyValidationUniverseCache = { value: null, expiresAt: 0, promise: null };
const STRATEGY_SIGNAL_HISTORY_BARS = 720;
const STRATEGY_SIGNAL_MAX_UNIVERSE = 300;
const STRATEGY_SIGNAL_VALIDATION_SAMPLE = 120;
const STRATEGY_SIGNAL_FETCH_CONCURRENCY = 4;
const STRATEGY_SIGNAL_WORKER_TIMEOUT_MS = 2 * 60 * 1000;
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

function fetchJsonWithCurl(url, timeoutMs, referer = "") {
  return new Promise((resolve, reject) => {
    const timeoutSeconds = Math.max(3, Math.ceil(Number(timeoutMs || 12000) / 1000));
    execFile(
      "curl.exe",
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
        timeout: timeoutSeconds * 1000 + 2000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
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
  });
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  let lastError;
  const requestUrl = String(url);
  const isEastmoney = /\.eastmoney\.com\//i.test(requestUrl);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isEastmoney) {
      const hostname = new URL(requestUrl).hostname;
      const state = eastmoneyOriginQueues.get(hostname) || {
        lastRequestAt: 0,
        queue: Promise.resolve()
      };
      eastmoneyOriginQueues.set(hostname, state);
      const minimumGap = hostname.startsWith("push2") ? 120 : 180;
      const scheduled = state.queue.then(async () => {
        const remaining = minimumGap - (Date.now() - state.lastRequestAt);
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
        state.lastRequestAt = Date.now();
      });
      state.queue = scheduled.catch(() => {});
      await scheduled;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": isEastmoney
            ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36"
            : "AStockMonitor/0.8",
          ...(isEastmoney
            ? {
              "Referer": "https://quote.eastmoney.com/"
            }
            : {}),
          ...(options.headers || {})
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data?.rc && data.rc !== 0) throw new Error(data.msg || `数据源错误 ${data.rc}`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    } finally {
      clearTimeout(timer);
    }
  }
  if (isEastmoney) {
    try {
      return await fetchJsonWithCurl(
        requestUrl,
        timeoutMs,
        "https://quote.eastmoney.com/"
      );
    } catch (curlError) {
      if (curlError && typeof curlError === "object" && !curlError.cause) {
        curlError.cause = lastError;
      }
      lastError = curlError;
    }
  }
  throw lastError;
}

async function fetchDecodedText(url, options = {}, timeoutMs = 12000, encoding = "utf-8") {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const scheduled = sinaOriginQueue.queue.then(async () => {
      const remaining = 450 - (Date.now() - sinaOriginQueue.lastRequestAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      sinaOriginQueue.lastRequestAt = Date.now();
    });
    sinaOriginQueue.queue = scheduled.catch(() => {});
    await scheduled;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "Accept": "application/json, text/javascript, text/plain, */*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
          "Referer": "https://vip.stock.finance.sina.com.cn/mkt/",
          ...(options.headers || {})
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new TextDecoder(encoding).decode(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function marketFromCode(code) {
  if (/^(6|68)/.test(code)) return 1;
  return 0;
}

function eastPriceFromRaw(value, precision = 2) {
  const numeric = Number(value);
  const digits = Number(precision);
  if (!Number.isFinite(numeric)) return 0;
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
    if (/^(?:00[0-3]|30[01])\d{3}$/.test(normalizedCode)) return "SZ";
    if (/^[489]\d{5}$/.test(normalizedCode)) return "BJ";
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
  const cacheKey = text.toLowerCase();
  const cached = securitySearchCache.get(cacheKey);
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
  const url = `${SEARCH_API}?input=${encodeURIComponent(text)}&count=40&type=14`;
  let rows = [];
  try {
    const json = await fetchJson(url, {}, 3500);
    rows = json?.QuotationCodeTable?.Data || [];
  } catch {
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
  if (result.length) {
    securitySearchCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
  }
  return result;
}

function isAStockCode(code = "") {
  const value = String(code).trim();
  return /^(?:00[0-3]|30[01]|60[0135]|68[89])\d{3}$/.test(value) ||
    /^[489]\d{5}$/.test(value);
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

async function eastQuote(security, timeoutMs = 12000) {
  const fields =
    "f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f59,f60,f116,f117,f127,f168,f169,f170,f171";
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
    Number.isFinite(Number(value)) ? Number(value) / 100 : 0;
  return {
    code: d.f57,
    name: d.f58,
    secid: security.secid,
    thscode: security.thscode,
    assetType: security.assetType || "stock",
    assetLabel: security.marketName || "A股",
    pricePrecision,
    latest: price(d.f43),
    high: price(d.f44),
    low: price(d.f45),
    open: price(d.f46),
    volume: Number(d.f47 || 0),
    amount: Number(d.f48 || 0),
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
    source: "eastmoney"
  };
}

function normalizeTencentQuote(security, quote = {}) {
  const numeric = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const rawPrecision = Number(quote.pricePrecision);
  const pricePrecision =
    Number.isInteger(rawPrecision) && rawPrecision >= 0 && rawPrecision <= 6
      ? rawPrecision
      : 2;
  return {
    code: String(quote.securityCode || security.code),
    name: String(quote.securityName || security.name || security.code),
    secid: security.secid,
    thscode: security.thscode,
    assetType: security.assetType || "stock",
    assetLabel: security.marketName || "A股",
    pricePrecision,
    latest: numeric(quote.latest),
    high: numeric(quote.high),
    low: numeric(quote.low),
    open: numeric(quote.open),
    volume: numeric(quote.volume),
    amount: numeric(quote.amount),
    volumeRatio: numeric(quote.volumeRatio),
    limitUp: numeric(quote.limitUp),
    limitDown: numeric(quote.limitDown),
    preClose: numeric(quote.preClose),
    totalMarketCap: numeric(quote.totalMarketCap),
    floatMarketCap: numeric(quote.floatMarketCap),
    industry: String(security.industry || "未分类"),
    turnover: numeric(quote.turnover),
    change: numeric(quote.change),
    changePct: numeric(quote.changePct),
    amplitude: numeric(quote.amplitude),
    updatedAt: String(quote.updatedAt || ""),
    source: "tencent"
  };
}

async function publicQuoteWithFallback(security, timeoutMs = 12000) {
  try {
    return {
      quote: await eastQuote(security, timeoutMs),
      actualProvider: "eastmoney",
      warning: ""
    };
  } catch (eastError) {
    try {
      const quote = normalizeTencentQuote(
        security,
        await tencentQuote(security)
      );
      return {
        quote,
        actualProvider: "tencent",
        warning: "东方财富报价暂不可用，已自动切换腾讯公开行情，当前行情数据已恢复。"
      };
    } catch (tencentError) {
      const error = new Error(
        `公开行情暂不可用：东方财富与腾讯通道均失败。腾讯：${
          tencentError instanceof Error
            ? tencentError.message
            : String(tencentError)
        }`
      );
      error.cause = eastError;
      throw error;
    }
  }
}

async function eastMoneyHistory(security, limit = 160, fqt = 1) {
  const url =
    `${EAST_HISTORY}/stock/kline/get?secid=${encodeURIComponent(String(security.secid))}` +
    `&klt=101&fqt=${fqt}&lmt=${limit}&end=20500101` +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
  const json = await fetchJson(url);
  const lines = json?.data?.klines || [];
  const rows = validateHistoryRows(lines.map((line) => {
    const v = line.split(",");
    return {
      date: v[0],
      open: Number(v[1]),
      close: Number(v[2]),
      high: Number(v[3]),
      low: Number(v[4]),
      volume: Number(v[5]),
      amount: Number(v[6]),
      amplitude: Number(v[7]),
      changePct: Number(v[8]),
      change: Number(v[9]),
      turnover: Number(v[10])
    };
  }), {
    source: "eastmoney",
    minimumRows: Math.min(20, Math.max(1, Number(limit) || 1))
  });
  Object.defineProperty(rows, "dataSource", {
    value: "eastmoney",
    enumerable: false
  });
  return rows;
}

async function eastHistory(security, limit = 160, fqt = 1) {
  if (Number(fqt) === 0) {
    try {
      const rows = await sinaKline(security, "101", limit);
      if (!historyEndsRecently(rows, 45)) {
        throw new Error("新浪日线最新日期过旧，切换腾讯备用源");
      }
      return rows;
    } catch {
      return tencentHistory(security, limit, 0);
    }
  }
  try {
    return await eastMoneyHistory(security, limit, fqt);
  } catch {
    try {
      return await tencentHistory(security, limit, fqt);
    } catch {
      return sinaKline(security, "101", limit);
    }
  }
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
    : /^(4|8|9)/.test(code)
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
  } catch {
    json = await fetchJsonWithCurl(url, 15000, "https://gu.qq.com/");
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
    value: adjustment ? `tencent_${adjustment}` : "tencent_unadjusted",
    enumerable: false
  });
  Object.defineProperty(rows, "actualAdjustment", {
    value: Number(fqt),
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
    : /^(4|8|9)/.test(code)
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
  } catch {
    json = await fetchJsonWithCurl(url, 15000, "https://finance.sina.com.cn/");
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
    volume: Number(row?.volume),
    amount: Number.isFinite(Number(row?.amount)) ? Number(row.amount) : null,
    amplitude: null,
    changePct: null,
    change: null,
    turnover: null
  })), {
    source: "sina",
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
      const date = String(row?.date || "").slice(0, 10);
      const open = Number(row?.open);
      const close = Number(row?.close);
      const high = Number(row?.high);
      const low = Number(row?.low);
      const rawVolume = row?.volume;
      const volume = rawVolume === null || rawVolume === undefined || rawVolume === ""
        ? Number.NaN
        : Number(rawVolume);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
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

async function eastHistoryCached(
  security,
  limit = 160,
  fqt = 1,
  ttlMs = 8 * 60 * 1000,
  options = {}
) {
  const key = `${security.secid}:${limit}:${fqt}`;
  const forceRefresh = options?.forceRefresh === true;
  const cached = historyCache.get(key);
  if (!forceRefresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise && (!forceRefresh || cached.forceRefresh === true)) return cached.promise;
  const promise = eastHistory(security, limit, fqt)
    .then((value) => {
      if (historyCache.get(key)?.promise === promise) {
        historyCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    })
    .catch((error) => {
      if (historyCache.get(key)?.promise === promise) historyCache.delete(key);
      throw error;
    });
  historyCache.set(key, { promise, expiresAt: 0, forceRefresh });
  return promise;
}

async function eastChart(security, interval = "101", limit = 160, adjustment = 1) {
  const allowedIntervals = new Set(["1", "5", "15", "30", "60", "120", "101", "102", "103"]);
  const klt = String(interval);
  if (!allowedIntervals.has(klt)) {
    throw new Error(`不支持的K线周期：${interval}`);
  }
  const fqt = [0, 1, 2].includes(Number(adjustment)) ? Number(adjustment) : 1;
  const url =
    `${EAST_HISTORY}/stock/kline/get?secid=${encodeURIComponent(String(security.secid))}` +
    `&klt=${klt}&fqt=${fqt}&lmt=${limit}&end=20500101` +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
  try {
    const json = await fetchJson(url);
    const lines = json?.data?.klines || [];
    if (!lines.length) throw new Error("东方财富K线为空");
    const rows = lines.map((line) => {
      const v = line.split(",");
      return {
        date: v[0],
        open: Number(v[1]),
        close: Number(v[2]),
        high: Number(v[3]),
        low: Number(v[4]),
        volume: Number(v[5]),
        amount: Number(v[6]),
        amplitude: Number(v[7]),
        changePct: Number(v[8]),
        change: Number(v[9]),
        turnover: Number(v[10])
      };
    });
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

async function eastChartCached(
  security,
  interval,
  limit,
  adjustment,
  ttlMs,
  options = {}
) {
  const key = `${security.secid}:${interval}:${limit}:${adjustment}`;
  const forceRefresh = options?.forceRefresh === true;
  const cached = chartCache.get(key);
  if (!forceRefresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise && (!forceRefresh || cached.forceRefresh === true)) return cached.promise;
  const promise = eastChart(security, interval, limit, adjustment)
    .then((value) => {
      if (chartCache.get(key)?.promise === promise) {
        chartCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    })
    .catch((error) => {
      if (chartCache.get(key)?.promise === promise) chartCache.delete(key);
      throw error;
    });
  chartCache.set(key, { promise, expiresAt: 0, forceRefresh });
  return promise;
}

async function thsAccessToken(refreshToken) {
  if (!refreshToken) throw new Error("请先填写同花顺 refresh token");
  if (
    thsTokenCache.refreshToken === refreshToken &&
    thsTokenCache.accessToken &&
    thsTokenCache.expiresAt > Date.now()
  ) {
    return thsTokenCache.accessToken;
  }
  const json = await fetchJson(`${THS_BASE}/get_access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      refresh_token: refreshToken
    }
  });
  const accessToken = json?.data?.access_token;
  if (!accessToken) throw new Error(json?.message || "同花顺 access token 获取失败");
  thsTokenCache = {
    refreshToken,
    accessToken,
    expiresAt: Date.now() + 6.5 * 24 * 60 * 60 * 1000
  };
  return accessToken;
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
      volume: thsHistoryNumber(columns.volume[index]),
      amount: thsHistoryNumber(columns.amount[index]),
      changePct: thsHistoryNumber(columns.changePct[index]),
      turnover: thsHistoryNumber(columns.turnover[index])
    };
  });
}

async function thsQuote(security, settings) {
  const token = await thsAccessToken(settings.refreshToken);
  const indicators =
    "open,high,low,latest,preClose,changeRatio,turnoverRatio,latestAmount,latestVolume";
  const json = await fetchJson(`${THS_BASE}/real_time_quotation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", access_token: token },
    body: JSON.stringify({ codes: security.thscode, indicators })
  });
  const t = extractThsTable(json);
  const latest = Number(firstValue(t, ["latest", "close"]));
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
    changePct: Number(firstValue(t, ["changeRatio", "changePct"])),
    turnover: Number(firstValue(t, ["turnoverRatio", "turnover"])),
    amount: Number(firstValue(t, ["latestAmount", "amount"])),
    volume: Number(firstValue(t, ["latestVolume", "volume"])),
    industry: "",
    source: "ths"
  };
}

async function thsHistory(security, settings, limit = 160) {
  const token = await thsAccessToken(settings.refreshToken);
  const end = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - limit * 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const json = await fetchJson(`${THS_BASE}/cmd_history_quotation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", access_token: token },
    body: JSON.stringify({
      codes: security.thscode,
      indicators: "open,high,low,close,volume,amount,changeRatio,turnoverRatio",
      startdate: startDate,
      enddate: end,
      functionpara: { Fill: "Blank" }
    })
  });
  const t = extractThsTable(json);
  return validateHistoryRows(normalizeThsHistoryTable(t, limit), {
    source: "ths",
    minimumRows: Math.min(20, Math.max(1, Number(limit) || 1))
  });
}

async function thsHistoryCached(security, settings, limit = 160) {
  const key = `ths:${security.thscode}:${limit}`;
  const forceRefresh = settings?.forceRefresh === true;
  const cached = historyCache.get(key);
  if (!forceRefresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise && (!forceRefresh || cached.forceRefresh === true)) return cached.promise;
  const promise = thsHistory(security, settings, limit)
    .then((value) => {
      if (historyCache.get(key)?.promise === promise) {
        historyCache.set(key, { value, expiresAt: Date.now() + 15 * 60 * 1000 });
      }
      return value;
    })
    .catch((error) => {
      if (historyCache.get(key)?.promise === promise) historyCache.delete(key);
      throw error;
    });
  historyCache.set(key, { promise, expiresAt: 0, forceRefresh });
  return promise;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
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

function priceLimitRate(code, name = "") {
  if (/ST|\*ST/i.test(name)) return 0.05;
  if (/^(300|301|688|689)/.test(code)) return 0.2;
  if (/^(8|4|9)/.test(code)) return 0.3;
  return 0.1;
}

function movingAverage(history, days, endOffset = 0) {
  const end = history.length - endOffset;
  return average(history.slice(Math.max(0, end - days), end).map((x) => x.close));
}

function returnFor(history, days) {
  if (history.length <= days) return 0;
  const latest = history.at(-1).close;
  const base = history.at(-(days + 1)).close;
  return base ? ((latest / base) - 1) * 100 : 0;
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

async function recentTradingDates(count = 10) {
  const benchmark = await eastHistoryCached(
    { code: "000300", secid: "1.000300" },
    Math.max(12, count + 8),
    0,
    20 * 60 * 1000
  );
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
  const text = String(item.high_days || "");
  const windowMatch = text.match(/(\d+)\s*天\s*(\d+)\s*板/);
  if (windowMatch && Number(windowMatch[1]) === Number(windowMatch[2])) {
    return Math.max(1, Number(windowMatch[2]));
  }
  if (item.change_tag === "FIRST_LIMIT" || !item.is_again_limit) return 1;
  return null;
}

function normalizeThsLimitUpItem(item = {}, date = "") {
  const code = String(item.code || "");
  if (!isAStockCode(code)) return null;
  const latest = Number(item.latest || 0);
  const orderVolume = Number(item.order_volume || 0);
  const firstSealRaw = poolTimeRawFromEpoch(item.first_limit_up_time);
  const lastSealRaw = poolTimeRawFromEpoch(item.last_limit_up_time);
  const consecutiveBoards = thsLimitUpConsecutiveBoards(item);
  const amount = Number(item.amount);
  const floatMarketCap = Number(item.float_market_cap ?? item.ltsz);
  const totalMarketCap = Number(item.total_market_cap ?? item.tshare);
  const openBoardCount = item.open_board_count === null || item.open_board_count === undefined
    ? null
    : Number(item.open_board_count);
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
      fund: latest && orderVolume ? latest * orderVolume : 0,
      lbc: consecutiveBoards || 1,
      fbt: firstSealRaw,
      lbt: lastSealRaw,
      zbc: Number.isFinite(openBoardCount) ? openBoardCount : 0,
      hybk: String(item.industry || "未分类"),
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
    consecutiveBoards,
    firstSealTime: firstSealRaw ? normalized.firstSealTime : "",
    firstSealRaw: firstSealRaw || null,
    lastSealTime: lastSealRaw ? normalized.lastSealTime : "",
    lastSealRaw: lastSealRaw || null,
    openBoardCount: Number.isFinite(openBoardCount) ? openBoardCount : null,
    sealFloatRatio: Number.isFinite(floatMarketCap) && floatMarketCap > 0
      ? normalized.sealedAmount / floatMarketCap
      : null,
    tradedFloatRatio: Number.isFinite(floatMarketCap) && floatMarketCap > 0 && Number.isFinite(amount)
      ? amount / floatMarketCap
      : null,
    industry: String(item.industry || "未分类"),
    limitReason: String(item.reason_type || ""),
    boardType: String(item.limit_up_type || ""),
    dataProvider: "ths_public_limit_up"
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
    const sealedAmount = hasFiniteValue(thsItem.sealedAmount) && Number(thsItem.sealedAmount) > 0
      ? Number(thsItem.sealedAmount)
      : Number(eastItem.sealedAmount || 0);
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
      sealFloatRatio: hasFiniteValue(floatMarketCap) && Number(floatMarketCap) > 0
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

async function thsTopicPoolForDate(compactDate) {
  const date = displayDate(compactDate);
  const fields = [
    "199112",
    "10",
    "9001",
    "330329",
    "330330",
    "330324",
    "330325",
    "133971",
    "1968584"
  ].join(",");
  const pageSize = 200;
  const rows = [];
  let page = 1;
  let total = 0;
  do {
    const url =
      "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool" +
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
      throw new Error(`同花顺涨停池返回异常：${json?.status_msg || json?.status_code || "empty"}`);
    }
    const items = Array.isArray(json.data.info) ? json.data.info : [];
    total = Number(json?.data?.page?.total || items.length || 0);
    rows.push(...items);
    page += 1;
  } while (rows.length < total && page <= 10);
  return {
    date,
    serverTradingDate: rows.length ? date : "",
    fetchedAt: new Date().toISOString(),
    total,
    provider: "ths_public_limit_up",
    pool: rows
      .map((item) => normalizeThsLimitUpItem(item, date))
      .filter((item) => item && isAStockCode(item.code) && !isRiskStockName(item.name))
  };
}

async function topicPoolForDate(date, type = "limit", options = {}) {
  const compactDate = String(date || "").replaceAll("-", "");
  const preferredProvider = type === "limit" && options?.provider === "ths"
    ? "ths"
    : "eastmoney";
  const fallbackEnabled = options?.fallbackEnabled !== false;
  const key = `${type}:${compactDate}:${preferredProvider}:${fallbackEnabled ? "fallback" : "strict"}`;
  const forceRefresh = options?.forceRefresh === true;
  const cached = topicPoolCache.get(key);
  if (!forceRefresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise && (!forceRefresh || cached.forceRefresh === true)) return cached.promise;
  const endpoint = type === "failed" ? "getTopicZBPool" : "getTopicZTPool";
  const url =
    `https://push2ex.eastmoney.com/${endpoint}` +
    "?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt" +
    `&Pageindex=0&pagesize=1000&sort=fbt:asc&date=${compactDate}`;
  const loadEastmoney = async () => {
    const json = await fetchJson(url, {}, 15000);
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
  const promise = (type !== "limit"
    ? loadEastmoney()
    : preferredProvider === "ths"
      ? loadWithFallback(
          () => thsTopicPoolForDate(compactDate),
          loadEastmoney
        )
      : loadWithFallback(
          loadEastmoney,
          () => thsTopicPoolForDate(compactDate)
        ))
    .then((value) => {
      const isCurrentTradingDate = compactDate === todayInShanghai();
      const ttl = isCurrentTradingDate
        ? type === "failed" ? 15 * 1000 : 12 * 1000
        : 24 * 60 * 60 * 1000;
      if (topicPoolCache.get(key)?.promise === promise) {
        topicPoolCache.set(key, { value, expiresAt: Date.now() + ttl });
      }
      return value;
    })
    .catch((error) => {
      if (topicPoolCache.get(key)?.promise === promise) topicPoolCache.delete(key);
      throw error;
    });
  topicPoolCache.set(key, { promise, expiresAt: 0, forceRefresh });
  return promise;
}

function withSingleFlightCache(cache, ttlMs, loader, options = {}) {
  const forceRefresh = options === true || options?.forceRefresh === true;
  if (!forceRefresh && cache.value && cache.expiresAt > Date.now()) {
    return Promise.resolve(cache.value);
  }
  if (cache.promise && (!forceRefresh || cache.promiseForceRefresh === true)) return cache.promise;
  const promise = Promise.resolve().then(loader);
  cache.promise = promise;
  cache.promiseForceRefresh = forceRefresh;
  promise
    .then(
      (value) => {
        if (cache.promise === promise) {
          cache.value = value;
          cache.expiresAt = Date.now() + ttlMs;
        }
      },
      () => {}
    )
    .finally(() => {
      if (cache.promise === promise) {
        cache.promise = null;
        cache.promiseForceRefresh = false;
      }
    });
  return promise;
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
  if (currentPool && options?.provider === "ths" && !currentPool.serverTradingDate) {
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
  if (!ladderPoolsCaches.has(cacheKey)) {
    ladderPoolsCaches.set(cacheKey, { value: null, expiresAt: 0, promise: null });
  }
  return withSingleFlightCache(ladderPoolsCaches.get(cacheKey), 15 * 1000, async () => {
    const pools = await recentLimitUpPools(2, options);
    const current = pools[0] || { date: "", pool: [] };
    const previous = pools[1] || current;
    let failed = null;
    let failedPoolError = "";
    try {
      failed = await topicPoolForDate(current.date, "failed", options);
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

async function wholeMarketSnapshot(options = {}) {
  return withSingleFlightCache(marketSnapshotCache, 45 * 1000, async () => {
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
      rows: (json?.data?.diff || []).filter((item) => Number.isFinite(Number(item.f3)))
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
      const qualifies = (value) => inclusive ? value >= 0 : value > 0;
      const firstQualifies = qualifies(Number(rows[0].f3));
      const lastQualifies = qualifies(Number(rows.at(-1).f3));
      if (!firstQualifies) {
        high = page - 1;
      } else if (lastQualifies) {
        best = Math.min(total, page * pageSize);
        low = page + 1;
      } else {
        best = (page - 1) * pageSize + rows.filter((item) => qualifies(Number(item.f3))).length;
        break;
      }
    }
    return best;
  };
  const [upCount, nonNegativeCount, allMarketQuote] = await Promise.all([
    countPrefix(false),
    countPrefix(true),
    eastQuote({ code: "000985", secid: "1.000985", thscode: "000985.SH" }).catch(() => null)
  ]);
  const flatCount = Math.max(0, nonNegativeCount - upCount);
  const downCount = Math.max(0, total - nonNegativeCount);
  const value = {
    stockCount: total,
    upCount,
    downCount,
    flatCount,
    breadth: total ? upCount / total : 0.5,
    averageReturn: Number(allMarketQuote?.changePct || 0),
    indexReturn: Number(allMarketQuote?.changePct || 0),
    pagesSampled: pages.size,
    fetchedAt: new Date().toISOString()
  };
  return value;
  }, options);
}

async function marketEmotionSnapshot(options = {}) {
  return withSingleFlightCache(marketEmotionCache, 45 * 1000, async () => {
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
  const limitUpCount = Number(limitUpJson?.data?.tc || limitUpJson?.data?.pool?.length || 0);
  const limitDownCount = Number(limitDownJson?.data?.tc || limitDownJson?.data?.pool?.length || 0);
  const previousLimitUpCount = Number(
    previousLimitUpJson?.data?.tc || previousLimitUpJson?.data?.pool?.length || 0
  );
  const indexReturn = returnFor(benchmark, 1);
  const spreadScore = Math.max(-20, Math.min(25, (limitUpCount - limitDownCount) * 0.24));
  const trendScore = Math.max(-12, Math.min(15, (limitUpCount - previousLimitUpCount) * 0.15));
  const score = Math.round(
    Math.max(0, Math.min(100, 45 + spreadScore + trendScore + indexReturn * 4))
  );
  const value = {
    date: `${currentDate.slice(0, 4)}-${currentDate.slice(4, 6)}-${currentDate.slice(6, 8)}`,
    limitUpCount,
    limitDownCount,
    previousLimitUpCount,
    limitDownRatio: limitUpCount ? limitDownCount / limitUpCount : 1,
    indexReturn,
    score,
    state: score >= 75 ? "情绪强势" : score >= 60 ? "情绪回暖" : score >= 45 ? "情绪中性" : "情绪退潮"
  };
  return value;
  }, options);
}

function analyzeHistory(
  security,
  quote,
  history,
  sector,
  marketEmotion = null,
  benchmarkHistory = []
) {
  if (history.length < 21) throw new Error("历史行情不足，无法计算指标");
  const latest = history.at(-1);
  const events = [];
  const recentWindowStart = Math.max(1, history.length - 60);
  for (let i = recentWindowStart; i < history.length; i += 1) {
    const previous = history[i - 1];
    const day = history[i];
    const rate = priceLimitRate(security.code, quote.name);
    const target = roundPrice(previous.close * (1 + rate));
    if (day.close >= target - 0.011 && day.high >= target - 0.011) {
      events.push({ ...day, index: i, target, rate });
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
  const avwapVolume = since.reduce((sum, x) => sum + (x.volume || 0), 0);
  const avwapAmount = since.reduce((sum, x) => sum + (x.amount || 0), 0);
  const avwap = avwapVolume ? avwapAmount / (avwapVolume * 100) : 0;
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
  const avgVol5 = average(history.slice(-6, -1).map((x) => x.volume));
  const volumeRatio = avgVol5 ? latest.volume / avgVol5 : 0;
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
  const rsSector = stockReturn3 - (sector?.returns?.r3 || 0);
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
    structureScore += rsSector > 2 ? 7 : rsSector > 0 ? 4 : 0;
    structureScore += divergence >= 0 && divergence <= 8 ? 7 : divergence > 8 ? 3 : 0;
  } else {
    structureScore = (maBull ? 35 : 10) + (slopesUp ? 25 : 5) + (latest.close > ma5 ? 20 : 0);
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

function strategyDefinitionsFor(analysis, quote) {
  const aboveAvwap = Boolean(analysis.avwap && quote.latest >= analysis.avwap);
  const emotion = analysis.marketEmotion;
  const marketEmotionMatched = Boolean(
    emotion && emotion.score >= 60 && emotion.limitDownRatio <= 0.35
  );
  const hardRiskReasons = [];
  if (analysis.limitEvent && quote.latest < analysis.limitEvent.low) {
    hardRiskReasons.push("收盘跌破涨停低点");
  }
  if (analysis.volumeRatio > 2) hardRiskReasons.push("成交量超过2倍");
  if (analysis.divergence > 10) hardRiskReasons.push("均线乖离过热");
  if (analysis.avwap && quote.latest < analysis.avwap && analysis.volumeRatio > 1.3) {
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
      matched: analysis.sectorScore >= 65 && analysis.rsSector >= 0,
      detail: `板块 ${analysis.sectorScore} 分 / 相对板块 ${analysis.rsSector.toFixed(2)}%`
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
        ? `板块排名第 ${analysis.sectorRank} / 相对板块 ${analysis.rsSector.toFixed(2)}%`
        : `相对板块 ${analysis.rsSector.toFixed(2)}% / 板块 ${analysis.sectorScore} 分`
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
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;
  const promise = fetchJson(
    `${SEARCH_API}?input=${encodeURIComponent(industry)}&count=20&type=14`
  ).then((json) => {
    const items = json?.QuotationCodeTable?.Data || [];
    const match =
      items.find((x) => x.Classify === "BK" && x.Name === industry) ||
      items.find((x) => x.Classify === "BK" && (x.Name.includes(industry) || industry.includes(x.Name)));
    const value = match
      ? { code: match.Code, name: match.Name, secid: match.QuoteID }
      : null;
    sectorLookupCache.set(key, { value, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    return value;
  }).catch((error) => {
    if (cached?.value) return cached.value;
    sectorLookupCache.delete(key);
    throw error;
  });
  sectorLookupCache.set(key, { ...cached, promise, expiresAt: cached?.expiresAt || 0 });
  return promise;
}

async function searchSectors(query) {
  const text = String(query || "").trim();
  if (!text) return [];
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
        .replace(/[\[\]"']/g, "")
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

async function thsSmartPickingConcepts(searchString, accessToken) {
  const json = await fetchJson(`${THS_BASE}/smart_stock_picking`, {
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
  });
  if (Number(json?.errorcode || 0) !== 0) {
    throw new Error(json?.errmsg || json?.message || "同花顺问财未返回结果");
  }
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
  const cacheKey = `${rootName.toLowerCase()}:${sectorCode}:${hasThsToken ? "ths" : "public"}`;
  const cached = conceptChainCache.get(cacheKey);
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const query = `${rootName}概念股，列出所属同花顺概念、股票简称和股票代码，剔除ST`;
    if (!hasThsToken) {
      return freeConceptChain(input, rootName, query);
    }
    let accessToken;
    try {
      accessToken = await thsAccessToken(settings.refreshToken);
    } catch (error) {
      return freeConceptChain(input, rootName, query, `同花顺增强连接失败：${error.message}`);
    }
    let smart;
    try {
      smart = await thsSmartPickingConcepts(query, accessToken);
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
  })()
    .then((value) => {
      conceptChainCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + 30 * 60 * 1000
      });
      return value;
    })
    .catch((error) => {
      conceptChainCache.delete(cacheKey);
      throw error;
    });
  conceptChainCache.set(cacheKey, { promise, expiresAt: 0 });
  return promise;
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
  const fieldCoverage = {
    return: members.length ? returns.length / members.length : 0,
    amount: members.length ? amounts.filter((value) => value > 0).length / members.length : 0,
    mainInflow: members.length ? usableInflows.length / members.length : 0
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
        isLimitUp: target !== null && latest >= target - 0.011
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
        totalMarketCap: finiteOrNull(item.mktcap ?? item.totalMarketCap),
        floatMarketCap: finiteOrNull(item.nmc ?? item.floatMarketCap),
        isLimitUp: target !== null && latest >= target - 0.011
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
      row.isLimitUp = target !== null && row.latest >= target - 0.011;
      rows.push(row);
    }
  }
  return [...new Map(rows.map((item) => [item.code, item])).values()]
    .sort((left, right) => (right.changePct ?? -Infinity) - (left.changePct ?? -Infinity));
}

async function getSinaSectorCatalog() {
  if (sinaSectorCatalogCache.value && sinaSectorCatalogCache.expiresAt > Date.now()) {
    return sinaSectorCatalogCache.value;
  }
  if (sinaSectorCatalogCache.promise) return sinaSectorCatalogCache.promise;
  const promise = fetchDecodedText(
    "https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php",
    {},
    10000,
    "gb18030"
  ).then(parseSinaSectorCatalog).then((value) => {
    sinaSectorCatalogCache.value = value;
    sinaSectorCatalogCache.expiresAt = Date.now() + 30 * 60 * 1000;
    sinaSectorCatalogCache.promise = null;
    return value;
  }).catch((error) => {
    sinaSectorCatalogCache.promise = null;
    if (sinaSectorCatalogCache.value) return sinaSectorCatalogCache.value;
    throw error;
  });
  sinaSectorCatalogCache.promise = promise;
  return promise;
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

async function loadThsSectorMembers(industry, settings = {}) {
  const accessToken = await thsAccessToken(settings.refreshToken);
  const result = await fetchJson(`${THS_BASE}/smart_stock_picking`, {
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
  });
  if (Number(result?.errorcode || 0) !== 0) {
    throw new Error(result?.errmsg || result?.message || "同花顺板块查询失败");
  }
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
  const breadth = memberReturns.length
    ? memberReturns.filter((value) => value > 0).length / memberReturns.length
    : null;
  const memberAverageReturn = memberReturns.length
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
  const breadthDiagnostics = constituents.length ? buildSectorBreadthDiagnostics(constituents) : null;
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
  return {
    ...sector,
    returns,
    benchmarkReturns,
    excess,
    breadth,
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
    memberCount: constituents.length || finiteOrNull(summary?.memberCount),
    constituents,
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
    scoreMode: history.length >= 6 ? "完整板块指数评分" : constituents.length ? "实时成分评分" : "评分暂停",
    history,
    partial,
    warning: partial
      ? warning || `${source}已接力；缺失的板块指数历史指标显示为 --，实时成分数据仍参与计算。`
      : ""
  };
}

async function loadSectorStrength(industryOrSector, context = {}) {
  const requestedName = String(
    typeof industryOrSector === "object"
      ? industryOrSector?.name || industryOrSector?.code || ""
      : industryOrSector || ""
  ).trim();
  let sector = typeof industryOrSector === "object" && industryOrSector?.code
    ? {
        code: industryOrSector.code,
        name: industryOrSector.name || industryOrSector.code,
        secid: industryOrSector.secid || industryOrSector.QuoteID || `90.${industryOrSector.code}`
      }
    : null;
  const options = context.options && typeof context.options === "object" ? context.options : {};
  const thsConfigured = Boolean(String(options.refreshToken || "").trim());
  let thsMembers = null;
  if (thsConfigured && !providerCircuitOpen("ths-sector")) {
    try {
      thsMembers = await loadThsSectorMembers(sector?.name || requestedName, options);
      recordSectorProviderResult("ths-sector", true);
    } catch {
      recordSectorProviderResult("ths-sector", false);
    }
  }
  if (!sector && !providerCircuitOpen("eastmoney-sector-search")) {
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
  if (sector?.code) {
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
          ? "同花顺主源与东方财富次源均不可用，已由新浪行业实时成分接力；历史缺失项显示为 --。"
          : `同花顺主源与东方财富次源均不可用；新浪已返回行业摘要，但成分接口本次不可用（${sina.memberError || "未知原因"}），未取得的详情显示为 --。`
      });
    } catch (error) {
      if (error?.code !== "SECTOR_NOT_FOUND") recordSectorProviderResult("sina-sector", false);
    }
  }
  return null;
}

async function sectorStrength(industryOrSector, context = {}) {
  const cacheKey = normalizedSectorName(
    typeof industryOrSector === "object"
      ? industryOrSector?.name || industryOrSector?.code
      : industryOrSector
  );
  if (!cacheKey) return null;
  const cached = sectorStrengthCache.get(cacheKey);
  const forceRefresh = context.options?.forceRefresh === true;
  if (!forceRefresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;
  const promise = loadSectorStrength(industryOrSector, context)
    .then((value) => {
      if (value) {
        sectorStrengthCache.set(cacheKey, {
          value,
          staleUntil: Date.now() + 30 * 60 * 1000,
          expiresAt: Date.now() + 90 * 1000
        });
        return value;
      }
      if (cached?.value && cached.staleUntil > Date.now()) {
        return {
          ...cached.value,
          partial: true,
          sourceState: "上次有效数据接力",
          dataSource: `${cached.value.dataSource || "板块源"}缓存`,
          warning: "实时板块源本次均不可用，已保留最近30分钟内的有效详情；请留意数据时间。"
        };
      }
      sectorStrengthCache.delete(cacheKey);
      return null;
    })
    .catch((error) => {
      if (cached?.value && cached.staleUntil > Date.now()) {
        return {
          ...cached.value,
          partial: true,
          sourceState: "上次有效数据接力",
          dataSource: `${cached.value.dataSource || "板块源"}缓存`,
          warning: "实时板块源本次均不可用，已保留最近30分钟内的有效详情；请留意数据时间。"
        };
      }
      sectorStrengthCache.delete(cacheKey);
      throw error;
    });
  sectorStrengthCache.set(cacheKey, { ...cached, promise, expiresAt: cached?.expiresAt || 0 });
  return promise;
}

async function analyzeSector(input, options = {}) {
  let sector =
    typeof input === "object" && input?.code
      ? input
      : null;
  if (!sector) {
    const matches = await searchSectors(input);
    sector =
      matches.find((item) => item.name.toLowerCase() === String(input).toLowerCase()) ||
      matches[0];
  }
  if (!sector) throw new Error(`未找到板块：${input}`);
  const [benchmark, allMarketHistory, marketSnapshot, ladderPools] = await Promise.all([
    eastHistoryCached({ code: "000300", secid: "1.000300" }, 15, 1, 5 * 60 * 1000, options).catch(() => []),
    eastHistoryCached({ code: "000985", secid: "1.000985" }, 15, 1, 5 * 60 * 1000, options).catch(() => []),
    wholeMarketSnapshot(options).catch(() => ({ breadth: 0.5, averageReturn: 0, stockCount: 0 })),
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
  return {
    ...result,
    poolLimitUps: result.limitUps,
    poolShare: ladderPools.currentPool.length ? result.limitUps / ladderPools.currentPool.length : 0,
    totalPool: ladderPools.currentPool.length,
    allMarketReturns,
    marketSnapshot,
    marketProxy: "中证全指",
    leaders: result.constituents.slice(0, 8)
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
  const primaryIsThs = core.actualProvider === "ths";
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
  } else if (requestedThs && core.primaryStatus === "missing_token") {
    secondaryPromise = Promise.resolve({
      id: "ths",
      name: "同花顺 QuantAPI",
      kind: "官方 QuantAPI",
      role: "主数据源",
      enabled: true,
      ok: false,
      realtime: true,
      message: "未配置 Refresh Token，当前由免费行情临时接力"
    });
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
    primaryMeta.id === "eastmoney"
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
      primaryStatus: core.primaryStatus || (primaryIsThs ? "active" : "fallback")
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
    const [publicQuote, history] = await Promise.all([
      publicQuoteWithFallback(security),
      eastHistoryCached(security, 160, 1, 8 * 60 * 1000, serviceSettings)
    ]);
    return {
      quote: publicQuote.quote,
      history,
      actualProvider: publicQuote.actualProvider,
      requestedPrimary: "ths",
      primaryStatus: "missing_token",
      warning: [
        "同花顺已设为主数据源，但尚未配置 Refresh Token；当前由免费行情临时接力。",
        publicQuote.warning
      ].filter(Boolean).join(" "),
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
      publicQuoteWithFallback(security),
      eastHistoryCached(security, 160, 1, 8 * 60 * 1000, serviceSettings)
    ]);
    return {
      quote: publicQuote.quote,
      history,
      actualProvider: publicQuote.actualProvider,
      requestedPrimary: "ths",
      primaryStatus: "unavailable",
      warning: [
        `同花顺连接失败，已切换免费行情：${error.message}`,
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
      ? wholeMarketSnapshot(settings).catch(() => ({ breadth: 0.5, averageReturn: 0 }))
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
    replayBenchmarkHistory
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
      note: `${assetLabel} 仅在主动搜索时展示，不进入涨停策略、观察池和自动交易信号`
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
      warning: `${assetLabel} 已接入实时行情与多周期 K 线；默认列表保持隐藏，仅主动搜索显示`,
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
  analysis.historicalStats = buildHistoricalStrategyStats(
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
  analysis.strategyQualified =
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
    riskVetoPassed: Boolean(riskVeto?.matched),
    historicalEdgePassed: Boolean(analysis.historicalEdge?.passed),
    historicalEdgePenalty: analysis.historicalEdge?.penalty || 0,
    alertScore: Number(settings.alertScore || 75),
    exactNodesOnly: exactNodeIsGate,
    vetoReasons: riskVeto?.matched ? [] : String(riskVeto?.detail || "").split("、").filter(Boolean)
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

async function getQuoteSnapshot(input, settings = {}) {
  const security = toSecurity(input);
  if (!/^\d{6}$/.test(security.code)) throw new Error("请输入正确的6位股票代码");
  const startedAt = Date.now();
  const selectedThs = settings.provider === "ths";
  if (selectedThs && !String(settings.refreshToken || "").trim()) {
    const publicQuote = await publicQuoteWithFallback(security);
    return {
      quote: publicQuote.quote,
      actualProvider: publicQuote.actualProvider,
      requestedPrimary: "ths",
      primaryStatus: "missing_token",
      warning: [
        "同花顺主源待配置 Refresh Token；当前由免费行情临时接力。",
        publicQuote.warning
      ].filter(Boolean).join("；"),
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
  const publicQuote = await publicQuoteWithFallback(security);
  return {
    quote: publicQuote.quote,
    actualProvider: publicQuote.actualProvider,
    requestedPrimary: selectedThs ? "ths" : "eastmoney",
    primaryStatus: selectedThs ? "unavailable" : "active",
    warning: [
      thsFailure
        ? "同花顺主源暂不可用，已自动切换免费行情。"
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
    settings.refreshToken ? "ths" : "",
    settings.tushareToken ? "ts" : ""
  ].join(":");
  const cached = federationCache.get(key);
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;
  const promise = (async () => {
    const snapshot = await getQuoteSnapshot(security, settings);
    const core = {
      quote: snapshot.quote,
      actualProvider: snapshot.actualProvider,
      requestedPrimary: snapshot.requestedPrimary,
      primaryStatus: snapshot.primaryStatus,
      providerLatencyMs: snapshot.latencyMs
    };
    return quoteFederation(security, core, settings);
  })()
    .then((value) => {
      federationCache.set(key, { value, expiresAt: Date.now() + 15_000 });
      return value;
    })
    .catch((error) => {
      federationCache.delete(key);
      throw error;
    });
  federationCache.set(key, { promise, expiresAt: 0 });
  return promise;
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

async function getChart(input, interval = "101", options = {}) {
  const security = toSecurity(input);
  if (!/^\d{6}$/.test(security.code)) throw new Error("请输入正确的6位股票代码");
  const frame = String(interval);
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
    dataSource.startsWith("sina")
      ? "新浪财经公开行情（备用通道）"
      : dataSource.startsWith("tencent")
        ? "腾讯证券公开行情（备用通道）"
        : "东方财富公开行情";
  const actualAdjustment =
    Number(rows?.actualAdjustment) === 0 && adjustment.value !== 0
      ? "不复权（备用通道）"
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
  if (/^(300|301)/.test(value)) return "创业板";
  if (/^(688|689)/.test(value)) return "科创板";
  if (/^(4|8|9)/.test(value)) return "北交所";
  if (/^(6|000|001|002|003)/.test(value)) return "沪深主板";
  return "其他";
}

function strategyValidationBoard(code = "") {
  const value = String(code);
  if (/^(300|301)/.test(value)) return "growth";
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

async function broadAStockValidationUniverse() {
  return withSingleFlightCache(strategyValidationUniverseCache, 30 * 60 * 1000, async () => {
    const pageSize = 100;
    const marketFilters = [
      "m:0+t:6",
      "m:1+t:2",
      "m:0+t:80",
      "m:1+t:23",
      "m:0+t:81+s:2048"
    ];
    const fetchPage = async (marketFilter, page) => {
      const url =
        `${EAST_DELAY_QUOTE}/clist/get?pn=${page}&pz=${pageSize}&po=0&np=1&fltt=2&invt=2` +
        "&ut=bd1d9ddb04089700cf9c27f6f7426281" +
        `&fs=${marketFilter}&fid=f12&fields=f12,f14,f20,f100`;
      const json = await fetchJson(url, {}, 15000);
      return {
        total: Number(json?.data?.total || 0),
        rows: Array.isArray(json?.data?.diff) ? json.data.diff : []
      };
    };
    const all = [];
    const failures = [];
    for (const marketFilter of marketFilters) {
      let loaded = false;
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !loaded; attempt += 1) {
        try {
          const first = await fetchPage(marketFilter, 1);
          if (!first.rows.length) throw new Error("证券列表为空");
          all.push(...first.rows);
          loaded = true;
        } catch (error) {
          lastError = error;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 450 * (attempt + 1)));
          }
        }
      }
      if (!loaded) {
        failures.push({
          marketFilter,
          reason: lastError instanceof Error ? lastError.message : String(lastError || "unknown")
        });
      }
    }
    const rows = all.map((item) => ({
      code: String(item.f12 || ""),
      name: String(item.f14 || item.f12 || ""),
      industry: String(item.f100 || "未分类"),
      totalMarketCap: strategySignalNumber(item.f20)
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
  const strategies = auditedStrategies
    .filter((strategy) => strategy.publicationAccepted === true)
    .map((strategy, index) => ({
      ...strategy,
      strategyRank: index + 1,
      stocks: strategy.stocks.map((stock) => ({
        ...stock,
        validationPassed: true
      }))
    }));
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
    strategies.flatMap((strategy) => strategy.stocks.map((stock) => stock.code))
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
      `${Number(context.failed)} 只股票的历史行情获取失败，已隔离，不影响其余候选复核。`
    );
  }
  if (Number(context.availableUniverseSize) > Number(context.universeSize)) {
    warnings.push(
      `最近11个交易日共有 ${Number(context.availableUniverseSize)} 只非ST涨停候选；为控制行情源压力，本轮按新近度、连板与成交额复核前 ${Number(context.universeSize)} 只。`
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
      `${unvalidatedSignals} 条当前命中因策略未通过发布复核而被拦截，未进入策略信号股票列表。`
    );
  }
  if (!qualifiedCodes.size) {
    warnings.push(
      matchedCodes.size
        ? "当前命中候选所属策略尚未通过历史复核，因此未发布优质策略股票。"
        : "当前真实候选池没有股票满足策略规则，未补造策略信号。"
    );
  }
  const methodologyDetails = report?.methodology || {};
  const methodology = typeof methodologyDetails === "string"
    ? methodologyDetails
    : Object.values(methodologyDetails).filter(Boolean).join("；");
  const strategyAudit = auditedStrategies.map((strategy) => ({
    id: strategy.id,
    name: strategy.name,
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
  const selectionBiasWarning =
    "历史验证证券池来自最近11个交易日的非ST涨停候选，并非同期全A股或历史时点成分股；存在当前候选选择偏差与幸存者偏差，结果只用于候选内复核，不能宣称为全市场无偏回测。";
  const historyProviders = Object.keys(
    context?.dataQuality?.summary?.providers || {}
  );
  const selectionBiasWarningV2 = context.independentValidationUniverse === true
    ? `历史验证已加入 ${Number(context.independentValidationSampleSize || 0)} 只不属于当前涨停候选池的宽基分层样本，降低当前候选选择偏差；但仍使用当前可交易证券回放，不等同于历史时点成分股数据库，仍可能有幸存者偏差。`
    : "本轮未取得足量的宽基独立样本，仍存在当前候选选择偏差与幸存者偏差；结果只作审计，不发布稳健优选组合。";
  const historyProviderLabel = historyProviders.some((item) =>
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
  const benchmarkProviderLabel = benchmarkProvider.startsWith("tencent")
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
    optimizedPortfolio,
    publishedStrategyCount: strategies.length,
    baseStrategyCount: reportStrategies.filter(
      (strategy) => !isCompositeStrategy(strategy)
    ).length,
    compositeStrategyCount: reportStrategies.filter(isCompositeStrategy).length,
    publishedCompositeCount: strategies.filter(isCompositeStrategy).length,
    publishedBaseCount: strategies.filter(
      (strategy) => !isCompositeStrategy(strategy)
    ).length,
    auditedStrategyCount: auditedStrategies.length,
    rejectedStrategyCount: auditedStrategies.length - strategies.length,
    matchedSignalCount: matchedCodes.size,
    publicationPolicy:
      `仅发布引擎 accepted=true、总交易不少于${Number(auditedStrategies[0]?.validation?.thresholds?.minSamples || 30)}、样本外不少于${Number(auditedStrategies[0]?.validation?.thresholds?.minOutOfSampleSamples || 9)}、至少${Number(auditedStrategies[0]?.validation?.walkForward?.folds?.length || 3)}个连续走步窗口且通过率不低于2/3、并具备至少420根中证全指基准的策略；其余策略只保留审计摘要，不发布股票。`,
    compositePublicationPolicy:
      "组合策略与基础策略使用完全相同的发布门槛；type、components 或 voteRule 不构成放宽条件。",
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
        const index = cursor;
        cursor += 1;
        try {
          results[index] = {
            ok: true,
            value: await worker(source[index], index)
          };
        } catch (error) {
          results[index] = {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }
    }
  );
  await Promise.all(runners);
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

function strategyPreparedHistoryRows(history) {
  const rows = strategyUsableHistoryRows(history).map((row) => ({
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
    amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
    turnover: Number.isFinite(Number(row.turnover)) ? Number(row.turnover) : null
  }));
  Object.defineProperty(rows, "dataSource", {
    value: String(history?.dataSource || "unknown"),
    enumerable: false
  });
  Object.defineProperty(rows, "strategyPrepared", {
    value: true,
    enumerable: false
  });
  return rows;
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
  // 策略信号固定只回放最近约三年，避免历史抓取和同步计算拖垮桌面主进程。
  const historyBars = STRATEGY_SIGNAL_HISTORY_BARS;
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
        Math.min(200, strategySignalNumber(raw.roundTripCostBps) ?? 18)
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

function buildStrategySignalReportInWorker(
  candidates,
  historiesByCode,
  benchmarkRows,
  replay
) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.join(__dirname, "strategy-signal-worker.cjs"),
      {
        workerData: {
          candidates,
          historiesByCode,
          benchmarkRows,
          replay
        }
      }
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error("策略回放计算超时，已停止本轮任务以保证软件可用"));
    }, STRATEGY_SIGNAL_WORKER_TIMEOUT_MS);
    timer.unref?.();

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };

    worker.once("message", (message) => {
      if (message?.ok) {
        finish(null, message.value);
        return;
      }
      finish(new Error(String(message?.error || "策略回放工作线程失败")));
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(new Error(`策略回放工作线程异常退出：${code}`));
      }
    });
  });
}

async function loadStrategySignals(options, runtime = {}) {
  const recentPool = await discoverRecentLimitUps(11, {
    provider: options.provider,
    fallbackEnabled: options.fallbackEnabled,
    multiSourceEnabled: options.multiSourceEnabled,
    forceRefresh: runtime.forceRefresh === true
  });
  const candidates = [...recentPool]
    .sort(
      (left, right) =>
        Number(left.tradingDaysSince || 0) - Number(right.tradingDaysSince || 0) ||
        Number(right.consecutiveBoards || 0) - Number(left.consecutiveBoards || 0) ||
        Number(right.amount || 0) - Number(left.amount || 0) ||
        String(left.code).localeCompare(String(right.code))
    )
    .slice(0, options.maxUniverse);
  let broadUniverseError = "";
  const broadUniverse = await broadAStockValidationUniverse().catch((error) => {
    broadUniverseError = error instanceof Error ? error.message : String(error);
    return [];
  });
  if (Array.isArray(broadUniverse?.failures) && broadUniverse.failures.length) {
    broadUniverseError = broadUniverse.failures
      .map((item) => `${item.marketFilter}: ${item.reason}`)
      .join(" | ");
  }
  const independentValidationSample = selectIndependentValidationSample(
    broadUniverse,
    STRATEGY_SIGNAL_VALIDATION_SAMPLE,
    candidates.map((item) => item.code)
  );
  const validationCandidates = [...candidates, ...independentValidationSample];
  const independentBoardCounts = independentValidationSample.reduce(
    (counts, item) => {
      const board = strategyValidationBoard(item.code);
      counts[board] = Number(counts[board] || 0) + 1;
      return counts;
    },
    {}
  );
  const independentSampleCoverageReady =
    independentValidationSample.length >= Math.floor(STRATEGY_SIGNAL_VALIDATION_SAMPLE * 2 / 3) &&
    Number(independentBoardCounts.main || 0) >= 30 &&
    Number(independentBoardCounts.growth || 0) >= 15 &&
    Number(independentBoardCounts.star || 0) >= 9 &&
    Number(independentBoardCounts.beijing || 0) >= 6;
  // 大批量策略历史不进入全局行情缓存，避免数十万根 K 线长期占用内存。
  const benchmarkPromise = eastHistory(
    { code: "000985", secid: "1.000985" },
    options.historyBars,
    0
  )
    .then((value) => {
      const usableRows = strategyPreparedHistoryRows(value);
      if (usableRows.length < 30) {
        throw new Error(`基准有效日线不足：${usableRows.length}/30`);
      }
      return { ok: true, value: usableRows };
    })
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      value: []
    }));
  const historyResults = await strategySignalMapConcurrent(
    validationCandidates,
    STRATEGY_SIGNAL_FETCH_CONCURRENCY,
    async (candidate) => {
      const history = await eastHistory(
        toSecurity(candidate),
        options.historyBars,
        0
      );
      if (!Array.isArray(history) || !history.length) {
        throw new Error("历史行情为空");
      }
      const usableRows = strategyPreparedHistoryRows(history);
      if (usableRows.length < 30) {
        throw new Error(`有效日线不足：${usableRows.length}/30`);
      }
      return usableRows;
    }
  );
  const benchmarkResult = await benchmarkPromise;
  const dataQuality = buildStrategyDataQuality(
    validationCandidates,
    historyResults,
    benchmarkResult,
    options.historyBars
  );
  const historiesByCode = {};
  let failed = 0;
  historyResults.forEach((result, index) => {
    if (result?.ok) {
      historiesByCode[String(validationCandidates[index].code)] = result.value;
    } else {
      failed += 1;
    }
  });
  const usableIndependentValidationSample = independentValidationSample.filter(
    (item) => Array.isArray(historiesByCode[String(item.code)])
  );
  const independentUsableBoardCounts = usableIndependentValidationSample.reduce(
    (counts, item) => {
      const board = strategyValidationBoard(item.code);
      counts[board] = Number(counts[board] || 0) + 1;
      return counts;
    },
    {}
  );
  const independentValidationUniverse =
    independentSampleCoverageReady &&
    usableIndependentValidationSample.length >= Math.floor(STRATEGY_SIGNAL_VALIDATION_SAMPLE * 2 / 3) &&
    Number(independentUsableBoardCounts.main || 0) >= 30 &&
    Number(independentUsableBoardCounts.growth || 0) >= 15 &&
    Number(independentUsableBoardCounts.star || 0) >= 9 &&
    Number(independentUsableBoardCounts.beijing || 0) >= 6;
  const report = await buildStrategySignalReportInWorker(
    validationCandidates,
    historiesByCode,
    benchmarkResult.value,
    {
      ...options.replay,
      currentCandidateCodes: candidates.map((item) => String(item.code))
    }
  );
  return enrichStrategySignalReport(report, candidates, {
    strategyIds: options.strategyIds,
    maxStocksPerStrategy: options.maxStocksPerStrategy,
    universeSize: candidates.length,
    availableUniverseSize: recentPool.length,
    poolProviders: recentPool.poolProviders || [],
    currentCandidateSize: candidates.length,
    validationUniverseSize: dataQuality.summary.usableSecurities,
    validationCandidates,
    independentValidationSampleSize: independentValidationSample.length,
    independentValidationUsableSampleSize:
      usableIndependentValidationSample.length,
    independentBoardCounts,
    independentUsableBoardCounts,
    independentValidationUniverse,
    broadUniverseSize: broadUniverse.length,
    broadUniverseError,
    processed: candidates.filter((item) => historiesByCode[String(item.code)]).length,
    validationProcessed: validationCandidates.length - failed,
    failed: candidates.filter((item) => !historiesByCode[String(item.code)]).length,
    validationFailed: failed,
    benchmarkFailed: !benchmarkResult.ok,
    benchmarkBars: dataQuality.benchmark.usableBars,
    historyBarsRequested: options.historyBars,
    dataQuality,
    failureDetails: dataQuality.failures
  });
}

async function scanStrategySignals(rawOptions = {}) {
  const options = strategySignalOptions(rawOptions);
  const cacheKey = JSON.stringify(options);
  const cached = strategySignalCache.get(cacheKey);
  // 即使用户反复点击刷新，也只允许同一套参数存在一个在途扫描。
  if (cached?.promise) return cached.promise;
  if (rawOptions?.refresh !== true) {
    if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
  }
  const promise = loadStrategySignals(options, {
    forceRefresh: rawOptions?.refresh === true
  })
    .then((value) => {
      strategySignalCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + 5 * 60 * 1000
      });
      return value;
    })
    .catch((error) => {
      strategySignalCache.delete(cacheKey);
      throw error;
    });
  if (strategySignalCache.size >= 12 && !strategySignalCache.has(cacheKey)) {
    strategySignalCache.delete(strategySignalCache.keys().next().value);
  }
  strategySignalCache.set(cacheKey, { promise, expiresAt: 0 });
  return promise;
}

async function getLimitUpSectorBoard(options = {}) {
  const [limitUpSnapshot, benchmark, allMarketHistory, marketSnapshot, ladderPools] = await Promise.all([
    discoverLimitUps(options),
    eastHistoryCached({ code: "000300", secid: "1.000300" }, 15, 1, 5 * 60 * 1000, options).catch(() => []),
    eastHistoryCached({ code: "000985", secid: "1.000985" }, 15, 1, 5 * 60 * 1000, options).catch(() => []),
    wholeMarketSnapshot(options).catch(() => ({ breadth: 0.5, averageReturn: 0, stockCount: 0 })),
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
    if (!item.industry || item.industry === "未分类") continue;
    const list = grouped.get(item.industry) || [];
    list.push(item);
    grouped.set(item.industry, list);
  }
  const leaders = [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);
  const rows = [];
  // Keep requests sequential. Each provider also has spacing, a short circuit breaker,
  // single-flight caching and independent fallbacks, so one throttled host cannot fan out.
  for (const [industry, stocks] of leaders) {
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
        marketProxy: "中证全指"
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
        marketProxy: "中证全指",
        history: [],
        partial: true,
        warning: "同花顺主源、东方财富实时/延迟次源与新浪备用源本次均不可用；仅保留涨停池和梯队，未取得的详情显示为 --。"
      });
    }
  }
  return rows
    .filter(Boolean)
    .sort((a, b) => {
      const left = finiteOrNull(a.score);
      const right = finiteOrNull(b.score);
      if (left === null && right === null) return b.poolLimitUps - a.poolLimitUps;
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    })
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

async function testProvider(settings = {}) {
  settings = settings || {};
  const started = Date.now();
  const security = toSecurity("600000");
  try {
    const result =
      settings.provider === "ths"
        ? await thsQuote(security, settings)
        : (await publicQuoteWithFallback(security)).quote;
    return {
      ok: true,
      provider: settings.provider,
      latency: Date.now() - started,
      message: `连接成功：${result.name || "浦发银行"} ${result.latest}`
    };
  } catch (error) {
    return {
      ok: false,
      provider: settings.provider,
      latency: Date.now() - started,
      message: error.message
    };
  }
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
  return STRATEGY_DEFINITIONS.map((definition) => ({
    id: String(definition.id || ""),
    name: String(definition.name || definition.id || ""),
    type: definition.type === "composite" ? "composite" : "base",
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
  loaders = {}
) {
  const loadThs = loaders.ths || ((target, bars) =>
    thsHistoryCached(target, settings, bars));
  const loadEastmoney = loaders.eastmoney || ((target, bars) =>
    eastMoneyHistory(target, bars, 0));
  const loadPublic = loaders.public || ((target, bars) =>
    eastHistoryCached(target, bars, 0, 20 * 60 * 1000));
  const thsSelected = settings?.provider === "ths";
  const hasThsToken = Boolean(String(settings?.refreshToken || "").trim());
  if (thsSelected && hasThsToken) {
    try {
      const rows = await loadThs(security, limit);
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error("历史行情为空");
      }
      return rows;
    } catch (error) {
      if (settings?.fallbackEnabled === false) {
        throw new Error(
          `同花顺历史行情获取失败，且已关闭备用行情：${error?.message || error}`
        );
      }
    }
  }
  try {
    const rows = await loadEastmoney(security, limit);
    if (!Array.isArray(rows) || !rows.length) {
      throw new Error("东方财富历史行情为空");
    }
    return rows;
  } catch (eastmoneyError) {
    if (settings?.fallbackEnabled === false) {
      throw new Error(
        `东方财富历史行情获取失败，且已关闭后续备用行情：${eastmoneyError?.message || eastmoneyError}`
      );
    }
    return loadPublic(security, limit);
  }
}

function buildPortfolioBacktestInWorker(payload = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.join(__dirname, "portfolio-backtest-worker.cjs"),
      { workerData: payload }
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error("组合回测计算超时，已停止本轮任务以保证软件可正常使用"));
    }, STRATEGY_SIGNAL_WORKER_TIMEOUT_MS);
    timer.unref?.();

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    worker.once("message", (message) => {
      if (message?.ok) {
        finish(null, message.value);
        return;
      }
      finish(new Error(String(message?.error || "组合回测工作线程失败")));
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`组合回测工作线程异常退出：${code}`));
    });
  });
}

function buildPortfolioSignalTimeline(replay = {}, portfolio = {}) {
  const tradesBySampleId = new Map(
    (portfolio.trades || []).map((trade) => [String(trade.sampleId || ""), trade])
  );
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
      executed: status === "filled",
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
    addEvent(pending, "pending", pending);
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
    if (event.status === "filled") row.filledCount += 1;
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

async function runPortfolioBacktest(input = {}, serviceSettings = {}, runtime = {}) {
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
    STRATEGY_DEFINITIONS.map((definition) => definition.id)
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
    historyRequestBars
  ).catch((error) => {
    throw new Error(`基准交易日历获取失败：${error?.message || error}`);
  });
  const benchmarkHistory = Array.isArray(rawBenchmarkHistory)
    ? [...rawBenchmarkHistory]
        .sort((left, right) => String(left?.date || "").localeCompare(String(right?.date || "")))
        .slice(-historyRequestBars)
    : [];
  if (!Array.isArray(benchmarkHistory) || benchmarkHistory.length < 120) {
    throw new Error("中证全指历史交易日历不足，无法进行最近半年回测");
  }

  const rawHistoryResults = await strategySignalMapConcurrent(
    securities,
    4,
    async (security) => {
      try {
        const loadedHistory = await loadHistory(security, settings, historyRequestBars);
        const history = Array.isArray(loadedHistory)
          ? [...loadedHistory]
              .sort((left, right) => String(left?.date || "").localeCompare(String(right?.date || "")))
              .slice(-historyRequestBars)
          : [];
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
          : STRATEGY_DEFINITIONS.find((item) => item.id === strategyIds[0])?.name || strategyIds[0])
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
      roundTripCostBps: (commissionBps + slippageBps) * 2,
      outOfSampleRatio: 0.3
  };
  const portfolioOptions = {
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
      roundTripCostBps: (commissionBps + slippageBps) * 2,
      lotSize,
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
      filled: Number(portfolio.metrics?.tradeCount || 0),
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
  const text = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(parsed) ? text : "";
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

async function runBacktest(input, serviceSettings = {}, options = {}) {
  const security = await resolveBacktestSecurity(input);

  const rawStartDate = String(options?.startDate || "").trim();
  const requestedStartDate = normalizeSingleBacktestDate(rawStartDate);
  if (rawStartDate && !requestedStartDate) {
    throw new Error("回测起始日期格式无效，请重新选择日期");
  }
  const today = new Date().toISOString().slice(0, 10);
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
    STRATEGY_DEFINITIONS.map((item) => item.id)
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
  const expectedCostPercent = ((commissionBps + slippageBps) * 2) / 100;

  const [history, benchmarkHistory] = await Promise.all([
    loadBacktestHistory(
      security,
      serviceBacktestSettings,
      safeLookbackBars
    ).catch(() => []),
    loadBacktestHistory(
      benchmarkSecurity,
      serviceBacktestSettings,
      safeLookbackBars
    ).catch(() => [])
  ]);
  if (!history.length || history.length < 80) {
    throw new Error("历史数据不足，无法进行回测。请扩大历史时间窗口后重试");
  }
  const signalFrom = requestedStartDate || String(
    history[Math.max(0, history.length - PORTFOLIO_BACKTEST_MAX_BARS)]?.date || ""
  ).slice(0, 10);
  const signalTo = String(history.at(-1)?.date || "").slice(0, 10);
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
      roundTripCostBps: (commissionBps + slippageBps) * 2,
      outOfSampleRatio: 0.3,
      signalFrom,
      signalTo,
      customEntryPrice
    };
    const replay = buildSelectedStrategyReplay(
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
      STRATEGY_DEFINITIONS.map((definition) => [definition.id, definition])
    );
    const strategyBreakdown = verifiedStrategyIds.map((id) => {
      const definition = strategyDefinitionById.get(id);
      const singleReplay = verifiedStrategyIds.length === 1
        ? replay
        : buildSelectedStrategyReplay(
          [id],
          security,
          history,
          benchmarkHistory,
          {
            ...replayOptions,
            strategyId: id,
            strategyName: String(definition?.name || id),
            minimumVotes: 1
          }
        );
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

  const historicalStats = buildHistoricalStrategyStats(
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
  searchSecurities,
  analyzeSecurity,
  getQuoteSnapshot,
  getDataFederation,
  getChart,
  discoverLimitUps,
  discoverRecentLimitUps,
  scanStrategySignals,
  getLimitUpSectorBoard,
  searchSectors,
  getConceptChain,
  analyzeSector,
  sectorStrength,
  currentLadderPools,
  getNewsFeed,
  resetNewsCache,
  testProvider,
  analyzeHistory,
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
  extractThsTable,
  normalizeThsHistoryTable,
  thsTopicPoolForDate,
  getStrategyDefinitions,
  buildSequentialSamplePath,
  buildSingleStockTradeLedger,
  singleStockBacktestLookbackBars,
  loadBacktestHistory,
  buildPortfolioBacktestInWorker,
  runPortfolioBacktest,
  runBacktest
};
