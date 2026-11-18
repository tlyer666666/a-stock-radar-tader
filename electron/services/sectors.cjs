"use strict";
// 从 electron/services.cjs 提取（2026-11-15 审核 P0-2b 拆分）。
// services.cjs 通过顶部解构回本模块并继续按原契约 re-export，勿在这里引入
// 对 services.cjs 的反向依赖。
const { createBeijingSectorSource, isBeijingSector, BEIJING_BOARD } = require("../ths-beijing.cjs");
const { BoundedCache, credentialFingerprint } = require("../bounded-cache.cjs");
const { fetchArrayBufferWithPolicy, fetchWithPolicy } = require("../http-client.cjs");
// 同花顺免费网关的个股报价与日K线（不需要 QuantAPI Token），以及三路行情的健康度/熔断。
const thsFreeMarket = require("../ths-free-market.cjs");
const { thsProviderError } = require("../ths-token-manager.cjs");
const { priceLimitRate, isLimitUpPrice } = require("../price-limit-rules.cjs");
const { buildSectorLadder } = require("../strategy-intelligence.cjs");
// 同花顺官方免费行情网关（d.10jqka.com.cn）：实时快照 / 日K线 / 板块成分
const thsOfficial = require("../ths-quote.cjs");
const { semanticKey } = require("../service-runtime.cjs");
const _runtime = require("./runtime.cjs");
const { serviceRuntime, fuyao, sectorLookupCache, conceptChainCache, sectorStrengthCache, sectorFundFlows, sectorLimitCounts, sectorExplorer, stockIndustryIndex } = _runtime;
function trackServiceRequest(...args) { return _runtime.trackServiceRequest(...args); }
function serviceSignal(...args) { return _runtime.serviceSignal(...args); }
function fetchJson(...args) { return _runtime.fetchJson(...args); }
function toSecurity(...args) { return _runtime.toSecurity(...args); }
function isAStockCode(...args) { return _runtime.isAStockCode(...args); }
function canonicalSecurityIdentifiers(...args) { return _runtime.canonicalSecurityIdentifiers(...args); }
const _limit_pool = require("./limit-pool.cjs");
function thsAllAHistory(...args) { return _limit_pool.thsAllAHistory(...args); }
function thsIndexHistory(...args) { return _limit_pool.thsIndexHistory(...args); }
function conceptRootName(...args) { return _limit_pool.conceptRootName(...args); }
function currentLadderPools(...args) { return _limit_pool.currentLadderPools(...args); }
function discoverLimitUps(...args) { return _limit_pool.discoverLimitUps(...args); }
const _backtest = require("./backtest.cjs");
const { EAST_QUOTE, SEARCH_API, THS_BASE } = _backtest;
function eastHistoryCached(...args) { return _backtest.eastHistoryCached(...args); }
function finiteOrNull(...args) { return _backtest.finiteOrNull(...args); }
function eastQuote(...args) { return _backtest.eastQuote(...args); }
function withThsToken(...args) { return _backtest.withThsToken(...args); }
function isRiskStockName(...args) { return _backtest.isRiskStockName(...args); }
function average(...args) { return _backtest.average(...args); }
function clamp(...args) { return _backtest.clamp(...args); }
function roundPrice(...args) { return _backtest.roundPrice(...args); }
const _fuyao_review = require("./fuyao-review.cjs");
function getFuyaoReviewSnapshot(...args) { return _fuyao_review.getFuyaoReviewSnapshot(...args); }

const EAST_DELAY_QUOTE = "https://push2delay.eastmoney.com/api/qt";

const beijingSectorSource = createBeijingSectorSource();

const marketSnapshotCache = { value: null, expiresAt: 0, promise: null };

// 板块榜单缓存：榜单是「板块强度」页的主体视图，必须有保底 ——
// 同花顺/东财同时不可用时，返回最近一次的有效榜单并明确标注，而不是给一张空表。
const sectorBoardCache = new BoundedCache({ maxBytes: 4 * 1024 * 1024, maxEntries: 8, staleTtlMs: 0, now: () => Date.now() });

const sectorProviderHealth = new Map();

const sinaSectorCatalogCache = { value: null, expiresAt: 0, promise: null };

const SECTOR_PROVIDER_PRIORITY = Object.freeze([
  "同花顺 QuantAPI",
  "东方财富实时",
  "东方财富延迟节点",
  "新浪行业实时"
]);

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

// E-06：K 线不足 days+1 根、或基准价缺失/为 0 时是"算不出来"，返回 null。
// 旧实现返回 0，于是"数据不足"被当成"3 日涨幅 0%"，rsSector 也就变成"0% 超额"。
function returnWindow(history, days) {
  if (!Array.isArray(history) || history.length <= days) return null;
  const endRow = history.at(-1);
  const startRow = history.at(-(days + 1));
  const latest = Number(endRow?.close);
  const base = Number(startRow?.close);
  if (!Number.isFinite(latest) || !Number.isFinite(base) || base === 0) return null;
  return {
    value: ((latest / base) - 1) * 100,
    startDate: String(startRow?.date || "").slice(0, 10),
    endDate: String(endRow?.date || "").slice(0, 10)
  };
}

function returnFor(history, days) {
  return returnWindow(history, days)?.value ?? null;
}

/** 全市场代理基准：同花顺全A为主；同花顺取不到时用东方财富中证全指应急，并如实标注。 */
async function marketProxyHistory(limit = 15, options = {}) {
  try {
    return { rows: await thsAllAHistory(limit, options), label: "同花顺全A" };
  } catch {
    serviceSignal()?.throwIfAborted();
    const rows = await eastHistoryCached({ code: "000985", secid: "1.000985", assetType: "index" }, limit, 1, 5 * 60 * 1000, options).catch(() => []);
    return { rows, label: rows.length ? "中证全指" : "全A基准" };
  }
}

/** 沪深300：同花顺 hs_1B0300 为主，东方财富应急。 */
async function hs300History(limit = 15, options = {}) {
  try {
    return await thsIndexHistory(thsFreeMarket.THS_HS300, limit, options);
  } catch {
    serviceSignal()?.throwIfAborted();
    return eastHistoryCached({ code: "000300", secid: "1.000300", assetType: "index" }, limit, 1, 5 * 60 * 1000, options);
  }
}

function withSingleFlightCache(cache, ttlMs, loader, options = {}) {
  return serviceRuntime.cachedObject(cache, ttlMs, loader, { ...options, forceRefresh: options === true || options?.forceRefresh === true, maxBytes: cache === marketSnapshotCache ? 8 * 1024 * 1024 : 2 * 1024 * 1024 });
}

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
  try { token = require("../ths-hexin-v.cjs").getHexinToken(); } catch { /* ignore */ }
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
  const sectorWindows = {
    r1: history.length >= 2 ? returnWindow(history, 1) : null,
    r3: history.length >= 4 ? returnWindow(history, 3) : null,
    r5: history.length >= 6 ? returnWindow(history, 5) : null
  };
  const benchmarkWindows = {
    r1: benchmark.length >= 2 ? returnWindow(benchmark, 1) : null,
    r3: benchmark.length >= 4 ? returnWindow(benchmark, 3) : null,
    r5: benchmark.length >= 6 ? returnWindow(benchmark, 5) : null
  };
  const returns = {
    r1: history.length >= 2 ? (sectorWindows.r1?.value ?? null) : memberAverageReturn,
    r3: sectorWindows.r3?.value ?? null,
    r5: sectorWindows.r5?.value ?? null
  };
  const benchmarkReturns = {
    r1: benchmarkWindows.r1?.value ?? null,
    r3: benchmarkWindows.r3?.value ?? null,
    r5: benchmarkWindows.r5?.value ?? null
  };
  const sameReturnWindow = (left, right) => Boolean(
    left &&
    right &&
    left.startDate &&
    left.endDate &&
    left.startDate === right.startDate &&
    left.endDate === right.endDate
  );
  const weightedExcess = [["r1", 0.45], ["r3", 0.35], ["r5", 0.2]]
    .map(([key, weight]) => ({
      weight,
      value: sameReturnWindow(sectorWindows[key], benchmarkWindows[key])
        ? returns[key] - benchmarkReturns[key]
        : null
    }))
    .filter((item) => item.value !== null);
  const totalExcessWeight = weightedExcess.reduce((sum, item) => sum + item.weight, 0);
  const excess = totalExcessWeight
    ? weightedExcess.reduce((sum, item) => sum + item.value * item.weight, 0) / totalExcessWeight
    : null;
  const returnWindows = {
    r1: sectorWindows.r1 ? { startDate: sectorWindows.r1.startDate, endDate: sectorWindows.r1.endDate } : null,
    r3: sectorWindows.r3 ? { startDate: sectorWindows.r3.startDate, endDate: sectorWindows.r3.endDate } : null,
    r5: sectorWindows.r5 ? { startDate: sectorWindows.r5.startDate, endDate: sectorWindows.r5.endDate } : null
  };
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
    returnWindows,
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
      { code: "000300", secid: "1.000300", assetType: "index" },
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
      const rawPlateCode = String((typeof industryOrSector === "object" && industryOrSector?.indexCode) || baseSector.code || "");
      const conceptWanted = /概念$/.test(conceptNeedle) || /^(?:885|886)\d{3}$/.test(conceptNeedle) || /^(?:885|886)\d{3}$/.test(rawPlateCode) ||
        (typeof industryOrSector === "object" && (industryOrSector?.boardType === "concept" || industryOrSector?.kind === "concept"));
      if (conceptWanted) {
        try {
          const concept = conceptCid ? { cid: conceptCid, name: requestedName,
            platecode: /^(?:885|886)\d{3}$/.test(rawPlateCode) ? rawPlateCode : "",
            changePct: industryOrSector.changePct, netInflow: industryOrSector.netInflow
          } : await thsOfficial.findThsConcept(fetchWithPolicy, /^(?:885|886)\d{3}$/.test(rawPlateCode) ? rawPlateCode : conceptNeedle, { signal: serviceSignal() });
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
  const isConceptInput = Boolean(objectInput && (objectInput.boardType === "concept" || objectInput.kind === "concept"));
  const resolvedCode = isConceptInput && /^(?:885|886)\d{3}$/.test(String(objectInput.indexCode || ""))
    ? String(objectInput.indexCode)
    : String(objectInput?.code || "");
  let sector = objectInput
    ? { code: resolvedCode, name: query, secid: String(objectInput.secid || ""), memberCount: finiteOrNull(objectInput.memberCount),
        ...(isConceptInput ? { boardType: "concept",
          conceptCid: String(objectInput.conceptCid || (resolvedCode !== String(objectInput.code || "") ? objectInput.code || "" : "")),
          indexCode: String(objectInput.indexCode || ""),
          changePct: finiteOrNull(objectInput.returns?.r1 ?? objectInput.changePct), netInflow: finiteOrNull(objectInput.netInflow) } : {}) }
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

module.exports = {
  EAST_DELAY_QUOTE,
  beijingSectorSource,
  marketSnapshotCache,
  sectorBoardCache,
  sectorProviderHealth,
  sinaSectorCatalogCache,
  SECTOR_PROVIDER_PRIORITY,
  fetchDecodedText,
  performFetchDecodedText,
  returnWindow,
  returnFor,
  marketProxyHistory,
  hs300History,
  withSingleFlightCache,
  THS_UP_DOWN_URL,
  thsWholeMarketSnapshot,
  wholeMarketSnapshot,
  findSector,
  searchSectors,
  collectArrays,
  commonPathScore,
  splitConceptNames,
  extractThsConceptRows,
  thsSmartPickingConcepts,
  GENERIC_CONCEPT_NAMES,
  conceptNameIsUseful,
  frequencySegments,
  buildFreeConceptGroups,
  freeConceptChain,
  getConceptChain,
  buildSectorBreadthDiagnostics,
  nullableAverage,
  providerCircuitOpen,
  recordSectorProviderResult,
  normalizeEastSectorMembers,
  parseSinaSectorCatalog,
  normalizedSectorName,
  matchSinaSector,
  normalizeSinaSectorMembers,
  extractThsSectorMembers,
  getSinaSectorCatalog,
  loadSinaSector,
  THS_PUBLIC_SECTOR,
  thsPublicHeaders,
  thsPublicTextCells,
  parseThsPublicSectorTable,
  loadThsPublicSectorTable,
  loadThsSectorMembers,
  loadEastSectorMembers,
  sectorStateFromScore,
  buildSectorStrengthFromData,
  loadBeijingSector,
  loadSectorStrength,
  sectorStrength,
  markMemberLimitUps,
  analyzeSector,
  getLimitUpSectorBoard,
  sectorMatchName,
  getSectorLimitUpCount,
  getSectorStrengthBoard,
  getIndustrySectorBoard,
  preferRicherBoard,
  getLimitUpSectorBoardUncached
};
