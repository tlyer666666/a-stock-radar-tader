const TENCENT_QUOTE = "https://qt.gtimg.cn/q=";
const TUSHARE_API = "https://api.tushare.pro";
const {
  fetchArrayBufferWithPolicy,
  fetchJsonWithPolicy
} = require("./http-client.cjs");
const { BoundedCache, credentialFingerprint } = require("./bounded-cache.cjs");
const { createServiceRuntime } = require("./service-runtime.cjs");
const tushareDailyCache = new BoundedCache({ maxEntries: 256, maxBytes: 512 * 1024, now: () => Date.now() });
const federationController = new AbortController();
const federationRuntime = createServiceRuntime({ controller: federationController });
const federationRequests = new Set();

function trackFederationRequest(factory) {
  const promise = federationRuntime.track(factory);
  const physical = Promise.resolve(promise?.drained ?? promise);
  federationRequests.add(physical);
  physical.then(() => federationRequests.delete(physical), () => federationRequests.delete(physical));
  return promise;
}

function shutdownDataFederation() {
  const stopping = federationRuntime.shutdown(new DOMException("应用正在退出，行情请求已取消", "AbortError"));
  tushareDailyCache.clear();
  return Promise.allSettled([stopping, ...federationRequests]).then(() => undefined);
}

function marketPrefix(security) {
  if (String(security.thscode || "").endsWith(".SH")) return "sh";
  if (String(security.thscode || "").endsWith(".BJ")) return "bj";
  return "sz";
}

function tushareCode(security) {
  const suffix = String(security.thscode || "").split(".")[1];
  if (suffix) return `${security.code}.${suffix}`;
  return `${security.code}.${/^(6|68)/.test(security.code) ? "SH" : /^(8|4|9)/.test(security.code) ? "BJ" : "SZ"}`;
}

function formatTencentTime(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 14) return "";
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}+08:00`;
}

function requestPolicy(options = {}, timeoutMs = 5000) {
  const method = String(options?.method || "GET").toUpperCase();
  return {
    timeoutMs,
    retries: method === "GET" || method === "HEAD" ? 1 : 0,
    minimumGapMs: 100,
    headers: { "User-Agent": "AStockRadar/0.9" }
  };
}

async function tencentQuote(security) {
  federationRuntime.checkpoint();
  const startedAt = Date.now();
  const symbol = `${marketPrefix(security)}${security.code}`;
  const options = { signal: federationRuntime.signal(), headers: { Referer: "https://gu.qq.com/" } };
  const buffer = await trackFederationRequest(() => fetchArrayBufferWithPolicy(
    `${TENCENT_QUOTE}${symbol}`,
    options,
    requestPolicy(options)
  ));
  federationRuntime.checkpoint();
  let text;
  try {
    text = new TextDecoder("gb18030").decode(buffer);
  } catch {
    text = new TextDecoder().decode(buffer);
  }
  const quoted = text.match(/="([^"]*)"/)?.[1] || "";
  const fields = quoted.split("~");
  const latestText = String(fields[3] || "");
  const latest = Number(latestText);
  const pricePrecision = latestText.includes(".")
    ? Math.min(6, latestText.split(".")[1].length)
    : 2;
  const tradeSummary = String(fields[35] || "").split("/");
  const rawAmount = Number(tradeSummary[2]);
  const monitorValues = {
    latest: fields[3],
    changePct: fields[32],
    turnover: fields[38],
    amount: Number.isFinite(rawAmount) && rawAmount > 0 ? tradeSummary[2] : fields[37]
  };
  const missingFields = Object.entries(monitorValues)
    .filter(([, value]) => value == null || !String(value).trim() || !Number.isFinite(Number(value)))
    .map(([field]) => field);
  if (!Number.isFinite(latest) || latest <= 0) throw new Error("未返回有效行情");
  return {
    id: "tencent",
    name: "腾讯行情公开页",
    kind: "公开网页辅助",
    role: "交叉校验",
    enabled: true,
    ok: true,
    realtime: true,
    securityName: String(fields[1] || security.name || security.code),
    securityCode: String(fields[2] || security.code),
    pricePrecision,
    latest,
    preClose: Number(fields[4]),
    open: Number(fields[5]),
    high: Number(fields[33]),
    low: Number(fields[34]),
    volume: Number(fields[36]) * 100,
    amount:
      Number.isFinite(rawAmount) && rawAmount > 0
        ? rawAmount
        : Number(fields[37]) * 10000,
    turnover: Number(fields[38]),
    volumeRatio: Number(fields[49]),
    amplitude: Number(fields[43]),
    totalMarketCap: Number(fields[44]) * 1e8,
    floatMarketCap: Number(fields[45]) * 1e8,
    limitUp: Number(fields[47]),
    limitDown: Number(fields[48]),
    change: Number(fields[31]),
    changePct: Number(fields[32]),
    updatedAt: formatTencentTime(fields[30]),
    missingFields,
    latencyMs: Date.now() - startedAt,
    message: "仅作免费交叉校验，接口可用性以平台公开页面为准"
  };
}

function tableRows(json) {
  if (Number(json?.code || 0) !== 0) {
    throw new Error(json?.msg || `Tushare 错误 ${json?.code}`);
  }
  const fields = json?.data?.fields || [];
  return (json?.data?.items || []).map((item) =>
    Object.fromEntries(fields.map((field, index) => [field, item[index]]))
  );
}

async function tushareDailyQuote(security, token) {
  const cacheKey = `${tushareCode(security)}:${credentialFingerprint(token)}`;
  return federationRuntime.cached(tushareDailyCache, cacheKey, 15 * 60 * 1000,
    () => fetchTushareDailyQuote(security, token));
}

async function fetchTushareDailyQuote(security, token) {
  federationRuntime.checkpoint();
  const startedAt = Date.now();
  const end = new Date();
  const start = new Date(end.getTime() - 14 * 86400000);
  const compact = (date) =>
    `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const options = {
    signal: federationRuntime.signal(),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_name: "daily",
      token,
      params: {
        ts_code: tushareCode(security),
        start_date: compact(start),
        end_date: compact(end)
      },
      fields: "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount"
    })
  };
  const payload = await trackFederationRequest(() => fetchJsonWithPolicy(TUSHARE_API, options, requestPolicy(options, 8000)));
  federationRuntime.checkpoint();
  const rows = tableRows(payload);
  const row = rows[0];
  if (!row) throw new Error("暂无最近日线");
  const date = String(row.trade_date || "");
  return {
    id: "tushare",
    name: "Tushare Pro",
    kind: "官方令牌 · 盘后日线",
    role: "历史复核",
    enabled: true,
    ok: true,
    realtime: false,
    latest: Number(row.close),
    preClose: Number(row.pre_close),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    change: Number(row.change),
    changePct: Number(row.pct_chg),
    updatedAt: date.length === 8
      ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T15:00:00+08:00`
      : "",
    latencyMs: Date.now() - startedAt,
    message: "盘后数据，不参与盘中价格合成"
  };
}

async function settledSource(factory, fallback) {
  try {
    return await factory();
  } catch (error) {
    federationRuntime.checkpoint();
    return {
      ...fallback,
      enabled: true,
      ok: false,
      message: error?.name === "AbortError" ? "请求超时" : String(error?.message || error)
    };
  }
}

async function collectAuxiliarySources(security, settings = {}) {
  federationRuntime.checkpoint();
  if (settings.multiSourceEnabled === false) return [];
  const tasks = [
    settledSource(
      () => tencentQuote(security),
      {
        id: "tencent",
        name: "腾讯行情公开页",
        kind: "公开网页辅助",
        role: "交叉校验",
        realtime: true
      }
    )
  ];
  if (settings.tushareToken) {
    tasks.push(
      settledSource(
        () => tushareDailyQuote(security, settings.tushareToken),
        {
          id: "tushare",
          name: "Tushare Pro",
          kind: "官方令牌 · 盘后日线",
          role: "历史复核",
          realtime: false
        }
      )
    );
  } else {
    tasks.push(Promise.resolve({
      id: "tushare",
      name: "Tushare Pro",
      kind: "官方令牌 · 盘后日线",
      role: "历史复核",
      enabled: false,
      ok: null,
      realtime: false,
      message: "未配置 Token"
    }));
  }
  return Promise.all(tasks);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildQuoteConsensus(sources = []) {
  const live = sources.filter(
    (source) => source.ok && source.realtime && Number.isFinite(Number(source.latest))
  );
  const prices = live.map((source) => Number(source.latest));
  const consensusPrice = median(prices);
  const spreadPct =
    prices.length >= 2 && consensusPrice
      ? ((Math.max(...prices) - Math.min(...prices)) / consensusPrice) * 100
      : 0;
  const status =
    live.length < 2 ? "单源运行" :
      spreadPct <= 0.05 ? "多源一致" :
        spreadPct <= 0.2 ? "轻微差异" : "需要复核";
  return {
    sources,
    activeCount: sources.filter((source) => source.ok).length,
    configuredCount: sources.filter((source) => source.enabled !== false).length,
    realtimeCount: live.length,
    consensusPrice,
    spreadPct,
    status,
    updatedAt: new Date().toISOString(),
    note:
      live.length >= 2
        ? "实时价格只做一致性校验，不把不同平台报价平均后替换主行情"
        : "当前仅一个实时源可用，策略仍使用所选主数据源"
  };
}

module.exports = {
  shutdownDataFederation,
  tencentQuote,
  tushareDailyQuote,
  collectAuxiliarySources,
  buildQuoteConsensus
};
