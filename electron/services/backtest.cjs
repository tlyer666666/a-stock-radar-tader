"use strict";
// 从 electron/services.cjs 提取（2026-11-15 审核 P0-2b 拆分）。
// services.cjs 通过顶部解构回本模块并继续按原契约 re-export，勿在这里引入
// 对 services.cjs 的反向依赖。
const { sharedMarketSourceHealth } = require("../market-source-health.cjs");
const { fetchArrayBufferWithPolicy } = require("../http-client.cjs");
// 同花顺官方免费行情网关（d.10jqka.com.cn）：实时快照 / 日K线 / 板块成分
const thsOfficial = require("../ths-quote.cjs");;
const { BoundedCache, credentialFingerprint } = require("../bounded-cache.cjs");
// 同花顺免费网关的个股报价与日K线（不需要 QuantAPI Token），以及三路行情的健康度/熔断。
const thsFreeMarket = require("../ths-free-market.cjs");;
const { createFuyaoQuoteSource } = require("../fuyao-quote.cjs");
const { tencentQuote } = require("../data-federation.cjs");
const { fuyaoThscode, isIndexSecurity } = require("../fuyao-client.cjs");
const { shanghaiClock, validDate, createTradingCalendar } = require("../trend-trading-calendar.cjs");
const { isBseAshareCode } = require("../price-limit-rules.cjs");
const { withThsAccessToken, thsProviderError } = require("../ths-token-manager.cjs");
const { workerScriptPath } = require("../worker-runner.cjs");
const { DEFAULT_OPERATION_TIMEOUTS } = require("../job-lifecycle.cjs");
const { semanticKey } = require("../service-runtime.cjs");
const { roundTripBps, DEFAULT_COSTS } = require("../backtest-costs.cjs");
const { loadNamedConfig } = require("../config-loader.cjs");
const _runtime = require("./runtime.cjs");
const { serviceController, serviceRuntime, securitySearchCache, fuyao, historyCache, workerRunner } = _runtime;
function isConvertibleBondCode(...args) { return _runtime.isConvertibleBondCode(...args); }
function canonicalSecurityIdentifiers(...args) { return _runtime.canonicalSecurityIdentifiers(...args); }
function hasIdentifierValue(...args) { return _runtime.hasIdentifierValue(...args); }
function matchesCanonicalIdentifier(...args) { return _runtime.matchesCanonicalIdentifier(...args); }
function trackServiceRequest(...args) { return _runtime.trackServiceRequest(...args); }
function serviceSignal(...args) { return _runtime.serviceSignal(...args); }
function isAStockCode(...args) { return _runtime.isAStockCode(...args); }
function fetchJson(...args) { return _runtime.fetchJson(...args); }
function toSecurity(...args) { return _runtime.toSecurity(...args); }
function fetchJsonWithCurl(...args) { return _runtime.fetchJsonWithCurl(...args); }
function curlFallbackEnabled(...args) { return _runtime.curlFallbackEnabled(...args); }

const THS_BASE = "https://quantapi.51ifind.com/api/v1";

const EAST_QUOTE = "https://push2.eastmoney.com/api/qt";

const EAST_HISTORY = "https://push2his.eastmoney.com/api/qt";

const SEARCH_API = "https://searchapi.eastmoney.com/api/suggest/get";

const marketSourceHealth = sharedMarketSourceHealth;

// 策略引擎约 150KB，计算已在 worker 里做；主进程只在用到定义表时才加载（启动更快）。
let strategyDefinitionsCache = null;

// 完整策略库（含已下线、标 retired）：回测中心和策略目录用；策略选股本身只跑在用策略（由引擎决定）。
function strategyDefinitions() {
  strategyDefinitionsCache ||= require("../strategy-signal-engine.cjs").ALL_STRATEGY_DEFINITIONS;
  return strategyDefinitionsCache;
}

const PORTFOLIO_BACKTEST_MIN_BARS = 120;

const PORTFOLIO_BACKTEST_MAX_BARS = 120;

const PORTFOLIO_BACKTEST_WARMUP_BARS = 80;

function eastPriceFromRaw(value, precision = 2) {
  const numeric = Number(value);
  const digits = Number(precision);
  if (value === null || value === undefined || value === "" || !Number.isFinite(numeric)) return null;
  const safePrecision =
    Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 2;
  return numeric / (10 ** safePrecision);
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
    totalMarketCap: optionalQuoteNumber(d.f116),
    floatMarketCap: optionalQuoteNumber(d.f117),
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

const fuyaoQuoteSource = createFuyaoQuoteSource({ fuyao, loadProfile: (security) => trackedThsFreeQuote(security) });
_runtime.bindShutdownResources?.({ fuyaoQuoteSource });

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

/**
 * 扶摇历史日线（个股或指数）；仅有逐股成交时间证据时允许快照补日K。返回行与其他日线同形，dataSource = fuyao_*。
 * 前复权当天：快照价是原价，只有当天无除权时与前复权一致——扶摇当天的前复权因子尚未可知，
 * 所以前复权日线只在快照日期晚于最后一根时追加，不覆盖已有行。
 */
// 同一证券的扶摇快照在几秒内复用：不复权与前复权两次取日线时只请求一次快照。
const fuyaoSnapshotCache = new Map();

function raceSnapshotWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("任务已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("任务已取消", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function cachedFuyaoSnapshot(security, { signal, index } = {}) {
  signal?.throwIfAborted();
  serviceController.signal.throwIfAborted();
  const key = `${index ? "i" : "s"}:${fuyaoThscode(security)}`;
  const hit = fuyaoSnapshotCache.get(key);
  if (hit && Date.now() - hit.at < 8000) return raceSnapshotWithSignal(hit.promise, signal);
  const promise = fuyao.snapshot([security], { signal: serviceController.signal, index }).then((quotes) => quotes.get(fuyaoThscode(security)) || null);
  fuyaoSnapshotCache.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (fuyaoSnapshotCache.get(key)?.promise === promise) fuyaoSnapshotCache.delete(key); });
  if (fuyaoSnapshotCache.size > 64) fuyaoSnapshotCache.delete(fuyaoSnapshotCache.keys().next().value);
  return raceSnapshotWithSignal(promise, signal);
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
  preferFuyao: () => fuyaoUsable(),
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
    volume: finiteOrNull(v[5]),
    volumeUnit: "lots",
    ...(finiteOrNull(v[9]) !== null && Number(v[2]) - Number(v[9]) > 0 ? { preClose: roundPrice(Number(v[2]) - Number(v[9])) } : {}),
    amount: finiteOrNull(v[6]),
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
        ...(isIndexSecurity(security) ? [{ id: "eastmoney_history", run: () => eastMoneyHistory(security, limit, 0) }] : []),
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
    if (!curlFallbackEnabled()) throw error;
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
    if (!curlFallbackEnabled()) throw error;
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
      if (!validDate(date.slice(0, 10))) return null;
      if (options.preserveTime && !/ (?:[01]\d|2[0-3]):[0-5]\d$/.test(date)) return null;
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
  if (options.requireRecent !== false && !historyEndsRecently(usable, maximumAgeDays)) {
    throw new Error(`${source} history is stale or has no valid latest date`);
  }
  return usable;
}

async function eastHistoryCached(security, limit = 160, fqt = 1, ttlMs = 8 * 60 * 1000, options = {}) {
  return serviceRuntime.cached(historyCache, `${security.secid}:${limit}:${fqt}`, ttlMs,
    () => eastHistory(security, limit, fqt), options);
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
  const rows = validateHistoryRows(normalizeThsHistoryTable(t, limit), {
    source: "ths",
    minimumRows: Math.min(20, Math.max(1, Number(limit) || 1))
  });
  Object.defineProperty(rows, "dataSource", { value: "ths", enumerable: false });
  Object.defineProperty(rows, "actualAdjustment", { value: 0, enumerable: false });
  return rows;
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

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(String(value).replace(/,/g, "").replace(/%$/, ""));
  return Number.isFinite(numeric) ? numeric : null;
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

function buildHistoricalStrategyStatsInWorker(history, code, name, selectedIds, benchmarkHistory, options = {}, signal) {
  return serviceRuntime.track(() => workerRunner.run(workerScriptPath(__dirname, "../legacy-analysis-worker.cjs"), {
    history, code, name, selectedIds, benchmarkHistory, options
  }, {
    signal: serviceSignal(signal),
    timeoutMs: DEFAULT_OPERATION_TIMEOUTS.single,
    timeoutMessage: "历史策略分析计算超时，已停止本轮任务以保证软件可用"
  }));
}

function buildSingleStockReplaysInWorker(strategyIds, security, history, benchmarkHistory, replayOptions) {
  return serviceRuntime.track(() => workerRunner.run(workerScriptPath(__dirname, "../portfolio-backtest-worker.cjs"), {
    task: "single-stock-replay", strategyIds, security, history, benchmarkHistory, replayOptions
  }, {
    signal: serviceSignal(),
    timeoutMs: DEFAULT_OPERATION_TIMEOUTS.single,
    timeoutMessage: "个股回测计算超时，已停止本轮任务以保证软件可用"
  }));
}

const dailyBarCalendar = createTradingCalendar();

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

function backtestAmountWindow(strategyIds) {
  return Math.max(0, ...loadNamedConfig("strategy-signal-combinations")
    .filter(item => strategyIds.includes(item.id))
    .map(item => item.parameters.marketCalendarLookback));
}

function incompleteBacktestHistory(message) {
  return Object.assign(new Error(`回测数据不足：${message}`), { code: "BACKTEST_DATA_INCOMPLETE" });
}

function requireBacktestAmountRows(rows, security, requirements, minimumRows) {
  if (!Array.isArray(rows) || rows.length < minimumRows) {
    throw incompleteBacktestHistory(`请求窗口 ${minimumRows} 根，实际仅 ${rows?.length || 0} 根，不能缩短窗口后当作完整回测`);
  }
  const requiredWindow = Math.max(1, Math.round(Number(requirements.windowBars) || 80));
  const marketDates = requirements.marketDates;
  const signalFrom = requirements.signalFrom;
  const firstSignal = marketDates?.indexOf(signalFrom) ?? -1;
  const warmupFrom = firstSignal >= 0 ? marketDates[Math.max(0, firstSignal - requiredWindow + 1)] : "";
  const eligibleRows = warmupFrom ? rows.filter(row => row.date >= warmupFrom && row.date <= marketDates.at(-1)) : rows;
  const missing = ["volume", "amount"].map(field => ({
    field,
    count: eligibleRows.filter(row => row?.[field] === null || row?.[field] === undefined ||
      row[field] === "" || !Number.isFinite(Number(row[field])) || Number(row[field]) < 0).length
  })).filter(item => item.count);
  if (missing.length) {
    throw incompleteBacktestHistory(`${security.code} ${missing.map(item => `${item.field} 缺失/无效 ${item.count}/${eligibleRows.length} 根`).join("；")}；所选量价组合不能将缺数解释为0信号`);
  }
  const marketPositions = marketDates && new Map(marketDates.map((date, index) => [date, index]));
  let positiveRun = 0;
  let previousPosition = -2;
  for (const row of eligibleRows) {
    const position = marketPositions?.get(row.date);
    const positive = Number(row.volume) > 0 && Number(row.amount) > 0;
    if (!positive || (marketPositions && position === undefined)) positiveRun = 0;
    else positiveRun = !marketPositions || position === previousPosition + 1 ? positiveRun + 1 : 1;
    if (positiveRun >= requiredWindow && (!signalFrom || row.date >= signalFrom)) return rows;
    previousPosition = position;
  }
  throw incompleteBacktestHistory(`请求信号区间没有连续${requiredWindow}根正量额可评估窗口（包含停牌、日线缺页或零量额区间）；不能将不可评估解释为0信号`);
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
    if (fuyaoUsable() && fuyaoThscode(target) && (isIndexSecurity(target) || isAStockCode(target.code))) {
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
  const minimumRows = Number.isSafeInteger(requirements.minimumRows) && requirements.minimumRows > 0 && requirements.minimumRows <= limit
    ? requirements.minimumRows : limit;
  const check = inputRows => {
    const rows = requirements.completedThrough
      ? completedBacktestRows(inputRows, requirements.completedThrough, limit)
      : requirements.completedAt
        ? completedBacktestRows(inputRows, completedBacktestDate(requirements.completedAt, inputRows), minimumRows)
        : inputRows;
    return requireBacktestAmountRows(rows, security, requirements, minimumRows);
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
      if (bars > 1500) throw incompleteBacktestHistory(`公开量额备用源最多1500根，请求${bars}根超出来源窗口`);
      return require("../trend-screener-adapter.cjs").createTrendMarketData({ historyBars: bars, ths: trendThsLane, marketSourceHealth })
        .fetchHistory(target, "none", { signal: serviceSignal() });
    });
    const completeRawLimit = minimumRows <= 1500 ? Math.min(limit, 1500) : limit;
    const result = await serviceRuntime.track(() => trackServiceRequest(Promise.resolve(loadCompleteRaw(security, completeRawLimit))));
    serviceRuntime.checkpoint();
    if (result?.adjustment !== "none") throw incompleteBacktestHistory("备用日线没有明确不复权口径，不能替换原价回测");
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
    throw incompleteBacktestHistory(`${originalError?.message || "原来源未满足量额要求"}；核验量额备用失败：${error?.message || error}`);
  }
}

function buildPortfolioBacktestInWorker(payload = {}) {
  return serviceRuntime.track(() => workerRunner.run(workerScriptPath(__dirname, "../portfolio-backtest-worker.cjs"), payload, {
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
    "000001": { code: "000001", name: "上证指数", secid: "1.000001", thscode: "000001.SH", assetType: "index" },
    "000300": { code: "000300", name: "沪深300", secid: "1.000300", thscode: "000300.SH", assetType: "index" },
    "000985": { code: "000985", name: "中证全指", secid: "1.000985", thscode: "000985.SH", assetType: "index" }
  };
  const benchmarkSecurity = benchmarkByCode[benchmarkCode];
  const historyLimit = historyRequestBars + pendingBarAllowance;
  const loadHistory = (security, requirements) => runtime.loadHistory
    ? serviceRuntime.track(() => runtime.loadHistory(security, settings, historyLimit))
    : loadBacktestHistory(security, settings, historyLimit, {}, requirements);

  const rawBenchmarkHistory = await loadHistory(benchmarkSecurity).catch((error) => {
    serviceRuntime.checkpoint();
    throw new Error(`基准交易日历获取失败：${error?.message || error}`);
  });
  const completedThrough = completedBacktestDate(backtestNow, rawBenchmarkHistory);
  const benchmarkHistory = completedBacktestRows(rawBenchmarkHistory, completedThrough, historyRequestBars);
  if (!Array.isArray(benchmarkHistory) || benchmarkHistory.length < 120) {
    throw new Error("中证全指历史交易日历不足，无法进行最近半年回测");
  }
  const allBenchmarkDates = benchmarkHistory.map(row => row.date);
  const benchmarkDates = allBenchmarkDates.slice(-lookbackBars);
  const requiredAmountWindow = backtestAmountWindow(strategyIds);
  const amountRequirements = requiredAmountWindow > 0 ? {
    requireAmount: true,
    windowBars: requiredAmountWindow,
    minimumRows: requiredAmountWindow,
    marketDates: [...new Set(allBenchmarkDates)],
    signalFrom: benchmarkDates[0],
    completedThrough
  } : undefined;

  const rawHistoryResults = await strategySignalMapConcurrent(
    securities,
    4,
    async (security) => {
      try {
        const loadedHistory = await loadHistory(security, amountRequirements);
        serviceRuntime.checkpoint();
        const history = completedBacktestRows(loadedHistory, completedThrough, historyRequestBars);
        if (amountRequirements && runtime.loadHistory) {
          requireBacktestAmountRows(history, security, amountRequirements, requiredAmountWindow);
        }
        if (!Array.isArray(history) || history.length < 80) {
          throw new Error(`历史日线仅 ${Array.isArray(history) ? history.length : 0} 根`);
        }
        return { security, history, error: "" };
      } catch (error) {
        serviceRuntime.checkpoint();
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
  const requiredAmountWindow = backtestAmountWindow(verifiedStrategyIds);
  const requiresAmount = requiredAmountWindow > 0;

  const safeLookbackBars = singleStockBacktestLookbackBars(
    options.lookbackBars,
    requestedStartDate
  );
  const requestedBenchmarks = Number(options.benchmarks) || 2;
  const benchmarkSecurity =
    options.benchmark === "szzs"
      ? { code: "000001", secid: "1.000001", thscode: "000001.SH", assetType: "index" }
      : options.benchmark === "hs300"
        ? { code: "000300", secid: "1.000300", thscode: "000300.SH", assetType: "index" }
        : { code: "000985", secid: "1.000985", thscode: "000985.SH", assetType: "index" };
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
    if (!Array.isArray(rows) || rows.length <= bars) return null;
    const rightIndex = rows.length - 1;
    const leftIndex = rows.length - 1 - bars;
    const right = Number(rows[rightIndex]?.close);
    const left = Number(rows[leftIndex]?.close);
    return Number.isFinite(right) && Number.isFinite(left) && right > 0 && left > 0
      ? Number((((right / left) - 1) * 100).toFixed(2))
      : null;
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

  const externalSnapshots = options?.externalFactorSnapshots && typeof options.externalFactorSnapshots === "object"
    ? options.externalFactorSnapshots
    : null;
  const historicalStats = await buildHistoricalStrategyStatsInWorker(
    history,
    security.code,
    security.name,
    strategyIds,
    benchmarkHistory,
    { includeSamples: true, ...(externalSnapshots ? { externalSnapshots } : {}) }
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
  THS_BASE,
  EAST_QUOTE,
  EAST_HISTORY,
  SEARCH_API,
  marketSourceHealth,
  strategyDefinitionsCache,
  strategyDefinitions,
  PORTFOLIO_BACKTEST_MIN_BARS,
  PORTFOLIO_BACKTEST_MAX_BARS,
  PORTFOLIO_BACKTEST_WARMUP_BARS,
  eastPriceFromRaw,
  searchableAssetType,
  normalizeSearchSecurity,
  assetTypeFromExactCode,
  directSearchAsset,
  isRiskStockName,
  searchSecurities,
  thsSearchSuggestions,
  loadSecuritySuggestions,
  securityLookupKey,
  resolveBacktestSecurity,
  missingMonitorQuoteFields,
  eastQuote,
  TENCENT_TRACKED_FIELDS,
  optionalQuoteNumber,
  normalizeTencentQuote,
  industryByCode,
  rememberIndustry,
  knownIndustry,
  chainShouldStop,
  trackedThsFreeQuote,
  fuyaoQuoteSource,
  quoteSteps,
  QUOTE_SOURCE_LABELS,
  relayWarning,
  runQuoteChain,
  marketQuoteChain,
  publicQuoteWithFallback,
  fuyaoSnapshotCache,
  cachedFuyaoSnapshot,
  fuyaoQuoteBelongsAfter,
  fuyaoDailyHistory,
  thsFreeShanghaiDate,
  fuyaoUsable,
  trackedFuyaoHistory,
  trendThsLane,
  eastmoneyKlineRow,
  eastMoneyHistory,
  thsFreeHistory,
  fuyaoHistoryStep,
  eastHistory,
  tencentHistory,
  sinaKline,
  historyEndsRecently,
  validateHistoryRows,
  eastHistoryCached,
  withThsToken,
  extractThsTable,
  thsSeries,
  thsHistoryNumber,
  normalizeThsHistoryTable,
  thsHistory,
  thsHistoryCached,
  average,
  roundPrice,
  clamp,
  buildBacktestExecutionReadinessFromMetrics,
  summarizeWalkForwardSamples,
  buildWalkForwardValidationFromSamples,
  displayDate,
  todayInShanghai,
  finiteOrNull,
  strategySignalMapConcurrent,
  buildHistoricalStrategyStatsInWorker,
  buildSingleStockReplaysInWorker,
  dailyBarCalendar,
  buildSequentialSamplePath,
  backtestAmountWindow,
  incompleteBacktestHistory,
  requireBacktestAmountRows,
  loadBacktestHistory,
  buildPortfolioBacktestInWorker,
  buildPortfolioSignalTimeline,
  BACKTEST_NUMERIC_SETTING_KEYS,
  sanitizeBacktestSettingOverrides,
  mergeBacktestSettings,
  safeBacktestStrategyProfile,
  incompleteBacktestBarAllowance,
  completedBacktestDate,
  completedBacktestRows,
  runPortfolioBacktest,
  executePortfolioBacktest,
  SINGLE_STOCK_BACKTEST_MAX_BARS,
  SINGLE_STOCK_BACKTEST_WARMUP_BARS,
  normalizeSingleBacktestDate,
  singleStockBacktestLookbackBars,
  buildSingleStockTradeLedger,
  runBacktest,
  executeBacktest
};
