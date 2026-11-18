"use strict";
// 从 electron/services.cjs 提取（2026-11-15 审核 P0-2b 拆分）。
// services.cjs 通过顶部解构回本模块并继续按原契约 re-export，勿在这里引入
// 对 services.cjs 的反向依赖。
const { createFuyaoClient } = require("../fuyao-client.cjs");
const { createWorkerRunner } = require("../worker-runner.cjs");
const { createServiceRuntime } = require("../service-runtime.cjs");
const { BoundedCache } = require("../bounded-cache.cjs");
// 同花顺官方免费行情网关（d.10jqka.com.cn）：实时快照 / 日K线 / 板块成分
const thsOfficial = require("../ths-quote.cjs");;
const { fetchWithPolicy, runWithTransportSlot, fetchJsonWithPolicy } = require("../http-client.cjs");
const { shutdownNewsService } = require("../news-service.cjs");
const { shutdownDataFederation } = require("../data-federation.cjs");
const { execFile } = require("node:child_process");
const { isBseAshareCode } = require("../price-limit-rules.cjs");
const { createStockIndustryIndex } = require("../stock-industry-index.cjs");

let fuyaoApiKeyProvider = () => "";

// 同花顺扶摇官方接口：配置了 API Key 才启用；失败时自动回到同花顺免费网页接口。
const fuyao = createFuyaoClient({ getApiKey: () => fuyaoApiKeyProvider() });

const serviceController = new AbortController();

const workerRunner = createWorkerRunner();

const serviceRuntime = createServiceRuntime({ controller: serviceController, now: () => Date.now() });

const chartRuntime = createServiceRuntime({ controller: serviceController, jobOptions: { maxActive: 3, maxQueued: 64 }, now: () => Date.now() });

const sectorFundFlows = require("../sector-fund-flow.cjs").createSectorFundFlowSource({
  fetchJson: (...args) => fetchJson(...args), runtime: serviceRuntime, identify: member => toSecurity(member)
});

const serviceRequests = new Set();

const ladderPoolsCaches = new BoundedCache({ maxBytes: 2 * 1024 * 1024, maxEntries: 16, staleTtlMs: 0, now: () => Date.now() });

const historyCache = new BoundedCache({ maxBytes: 32 * 1024 * 1024, maxEntries: 128, staleTtlMs: 0, now: () => Date.now() });

const chartCache = new BoundedCache({ maxBytes: 16 * 1024 * 1024, maxEntries: 96, staleTtlMs: 0, now: () => Date.now() });

const federationCache = new BoundedCache({ maxBytes: 2 * 1024 * 1024, maxEntries: 256, staleTtlMs: 0, now: () => Date.now() });

const topicPoolCache = new BoundedCache({ maxBytes: 8 * 1024 * 1024, maxEntries: 128, staleTtlMs: 0, now: () => Date.now() });

const conceptChainCache = new BoundedCache({ maxBytes: 4 * 1024 * 1024, maxEntries: 64, staleTtlMs: 0, now: () => Date.now() });

const sectorLookupCache = new BoundedCache({ maxBytes: 512 * 1024, maxEntries: 256, staleTtlMs: 1800000, now: () => Date.now() });

const sectorStrengthCache = new BoundedCache({ maxBytes: 4 * 1024 * 1024, maxEntries: 128, staleTtlMs: 0, now: () => Date.now() });

// 同花顺板块浏览：行业行情取数据中心资金流（含涨幅、净流入、领涨股），指数走势取免费网关日线。
const sectorExplorer = require("../sector-explorer.cjs").createSectorExplorer({
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

const securitySearchCache = new BoundedCache({ maxBytes: 512 * 1024, maxEntries: 256, staleTtlMs: 0, now: () => Date.now() });

const strategySignalCache = new BoundedCache({ maxEntries: 12, maxBytes: 8 * 1024 * 1024, now: () => Date.now() });

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

function getServiceDiagnostics() {
  return { ...serviceRuntime.getDiagnostics(), charts: chartRuntime.getDiagnostics(), sectorFundFlows: sectorFundFlows.getDiagnostics(), caches: Object.fromEntries(Object.entries({ historyCache, chartCache, federationCache, topicPoolCache, conceptChainCache, sectorLookupCache, sectorStrengthCache, securitySearchCache, ladderPoolsCaches, strategySignalCache }).map(([name, cache]) => [name, cache.getDiagnostics()])) };
}

const MAX_ACTIVE_CURL = 2;
let activeCurlCount = 0;

function fetchJsonWithCurl(url, timeoutMs, referer = "", signal) {
  return Promise.resolve().then(() => serviceRuntime.track(() => {
    const producerSignal = serviceSignal(signal);
    producerSignal.throwIfAborted();
    if (activeCurlCount >= MAX_ACTIVE_CURL) {
      return Promise.reject(Object.assign(new Error("行情备用通道并发已满，跳过重试"), { code: "CURL_CONCURRENCY_LIMIT" }));
    }
    activeCurlCount += 1;
    let tracked;
    try {
      tracked = trackServiceRequest(runWithTransportSlot(() => executeJsonWithCurl(url, timeoutMs, referer, producerSignal), {
        url, signal: producerSignal, minimumGapMs: 180
      }));
    } catch (syncError) {
      activeCurlCount = Math.max(0, activeCurlCount - 1);
      throw syncError;
    }
    return tracked.finally(() => {
      activeCurlCount = Math.max(0, activeCurlCount - 1);
    });
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
    const upstreamStatus = Number(error?.status || error?.cause?.status || 0);
    if (upstreamStatus === 429 || upstreamStatus === 403 || /\bHTTP\s+(?:429|403)\b/i.test(String(error?.message || ""))) {
      throw error;
    }
    if (activeCurlCount >= MAX_ACTIVE_CURL) throw error;
    try {
      return await fetchJsonWithCurl(requestUrl, timeoutMs, "https://quote.eastmoney.com/", signal);
    } catch (curlError) {
      signal.throwIfAborted();
      if (curlError?.code === "CURL_CONCURRENCY_LIMIT") throw error;
      if (curlError && typeof curlError === "object" && !curlError.cause) curlError.cause = error;
      throw curlError;
    }
  }
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

function isAStockCode(code = "") {
  const value = String(code).trim();
  return /^(?:00[0-3]|30[012]|60[0135]|68[89])\d{3}$/.test(value) ||
    isBseAshareCode(value);
}

function configureFuyao({ getApiKey } = {}) {
  fuyaoApiKeyProvider = typeof getApiKey === "function" ? getApiKey : () => "";
  sectorLimitCounts.clear();
}

let stockIndustryIndexInstance = createStockIndustryIndexWith(null);

const stockIndustryIndex = Object.freeze({
  ensure: (...args) => stockIndustryIndexInstance.ensure(...args),
  lookup: (...args) => stockIndustryIndexInstance.lookup(...args),
  shutdown: (...args) => stockIndustryIndexInstance.shutdown(...args),
  status: (...args) => stockIndustryIndexInstance.status(...args)
});

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

function configureStockIndustryStore(store) {
  const previous = stockIndustryIndexInstance;
  stockIndustryIndexInstance = createStockIndustryIndexWith(store);
  void Promise.resolve(previous?.shutdown?.("reconfigured")).catch(() => undefined);
}

const sectorLimitCounts = require("../sector-limit-counts.cjs").createSectorLimitCounts({
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

module.exports = {
  fuyaoApiKeyProvider,
  fuyao,
  serviceController,
  workerRunner,
  serviceRuntime,
  chartRuntime,
  sectorFundFlows,
  serviceRequests,
  ladderPoolsCaches,
  historyCache,
  chartCache,
  federationCache,
  topicPoolCache,
  conceptChainCache,
  sectorLookupCache,
  sectorStrengthCache,
  sectorExplorer,
  securitySearchCache,
  strategySignalCache,
  serviceSignal,
  shutdownServiceResources,
  trackServiceRequest,
  cancelServiceJob,
  getServiceDiagnostics,
  fetchJsonWithCurl,
  executeJsonWithCurl,
  curlExecutable,
  fetchJson,
  performFetchJson,
  isConvertibleBondCode,
  securityExchangeFromCode,
  canonicalSecurityIdentifiers,
  hasIdentifierValue,
  matchesCanonicalIdentifier,
  toSecurity,
  isAStockCode,
  configureFuyao,
  stockIndustryIndex,
  createStockIndustryIndexWith,
  configureStockIndustryStore,
  sectorLimitCounts
};
